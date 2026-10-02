// `client.update.packs` — the Node pack facet (plans/P4-01.md §2.6–§2.9, §5 order 1; CONTENT §10,
// §13; P4-06). It is client-core's `PackEngine` with Node's ports:
//
//   transport  the pinned pack record from discovery's `release.endpoints.record`, objects from
//              `distribution.endpoints.blobs` (`{sha256}`) with `Range`/`If-Range`, the device
//              bearer sent only to the control plane's own origin;
//   storage    `DirPackStorage` under the platform data directory (P1b-09), excluded from
//              backups: a versioned directory per tree payload and an atomic pointer swap in
//              `state.json`;
//   zstd       `node:zlib` after a start-up probe, else `@polaris-key/zstd-wasm` (`selectNodeZstd`);
//   SHA-256    `node:crypto`, streaming.
//
// The running build's pins come from its content stamp (`packs.contentStamp`, a file among the
// app's own read-only resources, never a user-writable path): a host without a stamp has no packs.
// Embedded baselines (`packs.embedded`) are verified once — marker, bytes, stamp pin — and then
// count as installed. The active set's `packSetId` rides on `devices/report` as `content`.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TrustSet } from "@polaris-key/jws";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type { AppContent } from "@polaris-key/protocol/packs";
import type { PackTarget, ReleasePin } from "@polaris-key/protocol/update";
import {
  PackEngine,
  PackError,
  bootPackOptions,
  parseContentStamp,
  runBootFetch,
  stampHolds,
  type RevocationsSnapshot,
  type UpdateCheckContent,
  type VerifiedRevocation,
  type BootFetchResult,
  type BootOptions,
  type RunBootFetchOptions,
  type EmbeddedBaseline,
  type ObjectResponse,
  type PackHandler,
  type PackInstall,
  type PackProgress,
  type PacksSnapshot,
  type Sha256Port,
} from "@polaris-key/client-core";
import type { CacheManager } from "../core/cache.js";
import type { CoreContext } from "../core/context.js";
import { excludeFromBackup } from "../core/dirs.js";
import type { TokenManager } from "../core/token.js";
import type { TrustManager } from "../core/trust.js";
import {
  serviceEndpoint,
  type ProductDiscoveryDocument,
} from "../discovery.js";
import { ErrorCode, Feature } from "../constants.generated.js";
import { DirPackStorage, directoryTreeDigest, measureFile } from "./storage.js";
import { selectNodeZstd, type NodeZstdInfo } from "./zstd.js";

/** One embedded baseline the host ships: a single payload file (its marker beside it as
 *  `<file>.pkey.json`) or a tree directory (its marker inside as `.pkey/pack.json`). */
export interface NodeEmbeddedPack {
  path: string;
  /** The marker file, when it is not at the conventional place. */
  marker?: string;
}

/** `update.packs` options. */
export interface NodePacksOptions {
  /** The content stamp (`pkey-content.json`): a path among the app's own read-only resources,
   *  or its bytes. Without one the client has no packs (`ensure` raises `not-configured`). */
  contentStamp?: string | Uint8Array;
  /** Embedded baselines, verified once at load and then used as installed state. */
  embedded?: NodeEmbeddedPack[];
  /** Variant preferences, per axis, in preference order (`{locale: ["fr", "en"]}`). */
  axes?: Record<string, string[]>;
  /** `godot-<major>.<minor>` for a host that runs Godot packs; null otherwise. */
  engine?: string | null;
  /** The most memory one delta frame may take (`memBytes`). Default 256 MiB. */
  memBudget?: number;
  /** Where staging, the store and `state.json` live. Default `<data dir>/packs`. */
  dir?: string;
  /** Extra handlers (P4-16 types, game-registered `custom.*`). `files.tree` is built in. */
  handlers?: PackHandler[];
  /** The zstd backend: `auto` (the default) probes `node:zlib`; `wasm` forces the WASM decoder. */
  zstd?: "auto" | "wasm";
  /** Exclude the store from backups when it is first created (P1b-09: `CACHEDIR.TAG`, and on
   *  macOS a Time Machine exclusion run in the background). Default true. */
  excludeFromBackup?: boolean;
}

const DEFAULT_MEM_BUDGET = 256 * 1024 * 1024;

/** At most `limit` bytes of a body, decoded as UTF-8 (a non-ASCII byte stays non-ASCII, which
 *  step 12 refuses); the rest is never read. */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (total >= limit) await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, bytes.length - at);
    bytes.set(c.subarray(0, take), at);
    at += take;
    if (at >= bytes.length) break;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Mark the store excluded from backups the first time it exists (its `CACHEDIR.TAG` is the
 *  record). `tmutil` can take seconds, so it runs detached and never blocks a boot. */
async function excludeOnce(root: string): Promise<void> {
  try {
    await access(join(root, "CACHEDIR.TAG"));
    return;
  } catch {
    // First use: exclude below.
  }
  excludeFromBackup(root, {
    run: (cmd, args) => {
      execFile(cmd, args, () => undefined).unref();
    },
  });
}

const nodeSha256: Sha256Port = () => {
  const h = createHash("sha256");
  return {
    update: (b) => void h.update(b),
    digest: () => h.digest("hex"),
  };
};

/** What the pack facet needs from the update client and the facade. */
export interface PacksWiring {
  ctx: CoreContext;
  tokens: TokenManager;
  discovery: () => ProductDiscoveryDocument | null;
  discover?: () => Promise<unknown>;
  cache?: CacheManager;
  trust?: TrustManager;
  /** `update.pinnedReleaseKeys`: the only keys a pack record verifies against. */
  releaseKeys: () => TrustSet;
}

export class PacksClient {
  private readonly w: PacksWiring;
  private readonly opts: NodePacksOptions;
  private engine: PackEngine | null = null;
  private starting: Promise<PackEngine> | null = null;
  private readonly pendingHandlers: PackHandler[] = [];
  private readonly listeners = new Set<(e: PackProgress) => void>();
  private zstdInfo: NodeZstdInfo | null = null;
  private building: PackEngine | null = null;
  private refused: { location: string; step: string }[] = [];

  constructor(wiring: PacksWiring, opts: NodePacksOptions = {}) {
    this.w = wiring;
    this.opts = opts;
  }

  /** Whether the host configured a content stamp (and so may have packs). */
  get configured(): boolean {
    return this.opts.contentStamp !== undefined;
  }

  /**
   * Install the pinned release of each pack (CONTENT §10): already-current packs resolve at once;
   * others are fetched, verified, committed and (for `hot` types) activated. Raises a
   * `PackError` (`not-configured`, `pack-not-pinned`, `record-rejected`, `record-mismatch`,
   * `pack-type-unsupported`, `pack-not-entitled`, `pack-no-variant`, a `plan-*` or applier code,
   * or `network-error`, after which the next `ensure` resumes the download).
   */
  async ensure(packIds: readonly string[]): Promise<PackInstall[]> {
    this.w.ctx.requireService("release", Feature.packsState);
    return (await this.start()).ensure(packIds);
  }

  /** The install state and this process's running set. */
  async state(): Promise<PacksSnapshot> {
    return (await this.start()).state();
  }

  /** The directory of a pack's running tree payload, or null when it is not running. */
  async path(packId: string): Promise<string | null> {
    const s = await this.state();
    const i = s.running[packId];
    return i && i.layout === "tree" ? i.location : null;
  }

  /** Add a handler for a pack type (CONTENT §4.1). */
  registerHandler(handler: PackHandler): void {
    const engine = this.engine ?? this.building;
    if (engine) engine.registerHandler(handler);
    else this.pendingHandlers.push(handler);
  }

  /** Progress events (`download`, `apply`, `done`); returns the unsubscribe function. */
  on(listener: (e: PackProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The running set's `packSetId` (plans/P4-01.md §2.9); null before packs start. */
  async packSetId(): Promise<string | null> {
    if (!this.configured) return null;
    try {
      return await (await this.start()).packSetId();
    } catch {
      return null;
    }
  }

  /** Mark this boot healthy (CONTENT §10 step 7). */
  async confirm(): Promise<void> {
    await (await this.start()).confirm();
  }

  /**
   * Operator recovery after a torn `state.json` (held aside as `state.json.torn`; garbage
   * collection waits until this is called). See `state().stateIssue`.
   */
  async recoverState(): Promise<void> {
    await (await this.start()).recoverState();
  }

  /** Re-point a pack at the install it replaced. */
  async rollback(packId: string): Promise<boolean> {
    return (await this.start()).rollback(packId);
  }

  /**
   * The boot stage machine's pack options from the content stamp (plans/P4-01.md §2.10):
   * `requiredPacks` and `essentialPacks`, for `initialBootState`.
   */
  async bootOptions(): Promise<
    Required<Pick<BootOptions, "requiredPacks" | "essentialPacks">>
  > {
    return bootPackOptions(await this.readStamp());
  }

  /**
   * The boot's FETCH stage (the stage machine's host side): estimate the required and essential
   * packs, send `fetch.consent` when the policy asks, download with `fetch.progress`, and send
   * `fetch.done {result, installed}` through `send`.
   */
  async bootFetch(
    opts: Omit<RunBootFetchOptions, "stamp">,
  ): Promise<{ result: BootFetchResult; installed: string[] }> {
    const engine = await this.start();
    return runBootFetch(engine, { ...opts, stamp: await this.readStamp() });
  }

  /**
   * Install exact releases: a `packs` decision's `install` list (plans/P4-13.md §2.6). Raises
   * `pack-revoked` for a release a verified revocation names.
   */
  async ensureReleases(targets: readonly PackTarget[]): Promise<PackInstall[]> {
    this.w.ctx.requireService("release", Feature.packsState);
    return (await this.start()).ensureReleases(targets);
  }

  /** The stored and this process's verified revocations, and `relearn` (plans/P4-13.md §2.5). */
  async revocations(): Promise<RevocationsSnapshot> {
    return (await this.start()).revocations();
  }

  /**
   * The update check's content input (plans/P4-13.md §2.5, §2.6): the stamp and its holds, the
   * running releases (embedded baselines included), the variant preferences and the stored
   * revocations. Null when the host configured no content stamp.
   */
  async contentInput(): Promise<UpdateCheckContent | null> {
    if (!this.configured) return null;
    const engine = await this.start();
    const stamp = await this.readStamp();
    if (stamp === null) return null;
    const active: Record<string, ReleasePin> = {};
    for (const [id, i] of Object.entries(engine.state().running))
      active[id] = { sha256: i.recordSha256, seq: i.seq, version: i.version };
    const revs = engine.revocations();
    return {
      stamp,
      holds: stampHolds(await this.stampBytes()),
      active,
      engine: this.opts.engine ?? null,
      axes: this.opts.axes ?? {},
      revoked: revs.verified,
      relearn: revs.relearn,
      // plans/P4-19.md §2.7: the delegated releases the engine knows.
      delegated: engine.delegatedReleases(),
    };
  }

  /** Keep the revocations an update check verified (the engine's `recordRevocations`). */
  async recordRevocations(r: {
    learned: { revocation: VerifiedRevocation; jws: string }[];
    relearnCleared: string[];
  }): Promise<void> {
    await (
      await this.start()
    ).recordRevocations(r.learned, { relearnCleared: r.relearnCleared });
  }

  /** Which decoder serves plain and `--patch-from` frames (after the start-up probe). */
  async zstd(): Promise<NodeZstdInfo> {
    await this.start();
    return this.zstdInfo!;
  }

  /** The embedded baselines `start` refused, by marker step. */
  async refusedEmbedded(): Promise<{ location: string; step: string }[]> {
    await this.start();
    return [...this.refused];
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────

  private start(): Promise<PackEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    this.starting ??= this.boot().catch((e: unknown) => {
      this.starting = null;
      this.building = null;
      throw e;
    });
    return this.starting;
  }

  private async boot(): Promise<PackEngine> {
    const { ctx } = this.w;
    const stamp = await this.readStamp();
    const z = await selectNodeZstd({ mode: this.opts.zstd ?? "auto" });
    this.zstdInfo = z.info;
    const root = this.opts.dir ?? join(ctx.dirs.data, "packs");
    const storage = new DirPackStorage({ root });
    await storage.freeDisk(); // creates the root
    if (this.opts.excludeFromBackup !== false) await excludeOnce(storage.root);
    const engine = new PackEngine({
      product: ctx.product,
      releaseKeys: this.w.releaseKeys(),
      productTrust: () => this.w.trust?.effective ?? ctx.pinnedTrust,
      stamp,
      prefs: { engine: this.opts.engine ?? null, axes: this.opts.axes ?? {} },
      zstd: z.zstd,
      sha256: nodeSha256,
      patchMethods: z.info.patchMethods,
      memBudget: this.opts.memBudget ?? DEFAULT_MEM_BUDGET,
      storage,
      state: storage.stateStore(),
      revocations: storage.revocationStore(),
      fetchRecord: (sha256) => this.fetchRecord(sha256),
      fetchObject: (req) => this.fetchObject(req),
      entitlements: () => this.entitlements(),
      now: () => ctx.now(),
      newPlanId: () => randomBytes(12).toString("hex"),
      handlers: [...(this.opts.handlers ?? []), ...this.pendingHandlers],
    });
    engine.on((e) => {
      for (const l of this.listeners) {
        try {
          l(e);
        } catch {
          // A listener never fails an install.
        }
      }
    });
    // A handler registered while the engine loads goes straight to it.
    this.building = engine;
    const embedded = await this.embeddedBaselines();
    this.refused.push(...(await engine.load(embedded)).refused);
    this.engine = engine;
    return engine;
  }

  private async stampBytes(): Promise<Uint8Array> {
    const src = this.opts.contentStamp!;
    try {
      return typeof src === "string" ? await readFile(src) : src;
    } catch {
      throw new PackError(
        ErrorCode.contentStampInvalid,
        "The content stamp cannot be read.",
      );
    }
  }

  private async readStamp(): Promise<AppContent | null> {
    const src = this.opts.contentStamp;
    if (src === undefined) return null;
    const bytes = await this.stampBytes();
    const r = parseContentStamp(bytes);
    if (!r.ok)
      throw new PackError(
        ErrorCode.contentStampInvalid,
        "The content stamp is not a valid pkey-content/1 document.",
      );
    return r.content;
  }

  private async embeddedBaselines(): Promise<EmbeddedBaseline[]> {
    const out: EmbeddedBaseline[] = [];
    for (const e of this.opts.embedded ?? []) {
      try {
        const st = await stat(e.path);
        const dir = st.isDirectory();
        const markerPath =
          e.marker ??
          (dir ? join(e.path, ".pkey", "pack.json") : `${e.path}.pkey.json`);
        const marker = await readFile(markerPath);
        out.push({
          marker,
          payload: dir
            ? { kind: "tree", treeDigest: await directoryTreeDigest(e.path) }
            : { kind: "file", ...(await measureFile(e.path)) },
          location: e.path,
        });
      } catch {
        this.refused.push({ location: e.path, step: "format" });
      }
    }
    return out;
  }

  /** The licence's granted boolean flags, or null when the product runs no License service. */
  private entitlements(): ReadonlySet<string> | null {
    if (!this.w.ctx.enabled("license")) return null;
    const granted = new Set<string>();
    for (const [k, v] of Object.entries(
      this.w.cache?.state.license?.doc.entitlements ?? {},
    ))
      if (v.value === true) granted.add(k);
    return granted;
  }

  private async template(
    service: "release" | "distribution",
    name: string,
  ): Promise<string | null> {
    let doc = this.w.discovery();
    if (!doc && this.w.discover) {
      try {
        await this.w.discover();
      } catch {
        // Discovery unreachable: the fetch fails as a transport failure.
      }
      doc = this.w.discovery();
    }
    return serviceEndpoint(doc, service, name);
  }

  private expand(template: string, sha256: string): URL {
    return new URL(
      template.split("{sha256}").join(encodeURIComponent(sha256)),
      `${this.w.ctx.baseUrl}/`,
    );
  }

  private authHeaders(url: URL): Record<string, string> {
    const token = this.w.tokens.current;
    const sameOrigin = url.origin === new URL(this.w.ctx.baseUrl).origin;
    return token && sameOrigin ? { authorization: `Bearer ${token}` } : {};
  }

  private async fetchRecord(
    sha256: string,
  ): Promise<{ ok: true; body: string } | { ok: false; code: string }> {
    const t = await this.template("release", "record");
    if (t === null) return { ok: false, code: ErrorCode.serviceUnavailable };
    try {
      const url = this.expand(t, sha256);
      const res = await this.w.ctx.fetcher()(url.toString(), {
        headers: this.w.ctx.headers({
          accept: "application/jose",
          ...this.authHeaders(url),
        }),
        signal: this.w.ctx.deadline(),
      });
      if (!res.ok) return { ok: false, code: ErrorCode.networkError };
      // A record over the bound is refused at step `hash` without hashing; never buffer more.
      return {
        ok: true,
        body: await readCapped(res, MAX_RECORD_JWS_BYTES + 1),
      };
    } catch {
      return { ok: false, code: ErrorCode.networkError };
    }
  }

  /** One object by hash. The deadline is an idle timeout, reset by every chunk, so a large
   *  payload is never cut off for taking longer than one request may. */
  private async fetchObject(req: {
    sha256: string;
    offset: number;
    ifRange: string | null;
  }): Promise<ObjectResponse> {
    const t = await this.template("distribution", "blobs");
    if (t === null)
      throw new PackError(
        ErrorCode.serviceUnavailable,
        "Discovery names no blob endpoint.",
      );
    const url = this.expand(t, req.sha256);
    const idleMs = this.w.ctx.requestTimeoutMs;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (idleMs <= 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), idleMs);
    };
    arm();
    const headers: Record<string, string> = { ...this.authHeaders(url) };
    if (req.offset > 0) headers.range = `bytes=${req.offset}-`;
    if (req.ifRange !== null) headers["if-range"] = req.ifRange;
    let res: Response;
    try {
      res = await this.w.ctx.fetcher()(url.toString(), {
        headers: this.w.ctx.headers(headers),
        signal: abort.signal,
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
    const body = res.body;
    return {
      status: res.status,
      contentRange: res.headers.get("content-range"),
      chunks: (async function* () {
        try {
          if (!body) return;
          const reader = body.getReader();
          for (;;) {
            arm();
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      })(),
    };
  }
}
