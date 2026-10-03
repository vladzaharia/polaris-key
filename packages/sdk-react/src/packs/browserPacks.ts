// `update.packs` for the web transport (plans/P4-01.md §2.6–§2.9, §5 order 1; CONTENT §10 "Web",
// §13; P4-06). It is client-core's `PackEngine`, exactly as `@polaris-key/node` runs it, with the
// browser's ports:
//
//   transport  the pinned pack record from discovery's `release.endpoints.record`, objects from
//              `distribution.endpoints.blobs` with `Range`/`If-Range`, `fetch` with no ambient
//              credential (`credentials: "omit"`: the Worker never sends
//              `Access-Control-Allow-Credentials`, so a credentialed cross-origin fetch fails);
//              P4-18: a container's `full` and payload delta first through the payload URL
//              (`nativePayload.ts`: the browser's own zstd, and Compression Dictionary Transport
//              in Chromium), then the same candidate through the blob route and WASM;
//   storage    OPFS by default (`opfsPackStore`; its staging bytes through a dedicated worker's
//              sync access handles when one starts, P4-18), or the in-memory store a host passes
//              explicitly (tests, a page that must not persist); never a silent fallback;
//   zstd       `@polaris-key/zstd-wasm`'s browser entry, wasm32, so P = 30 and `memBudget` is at
//              most 2^30 (plans/P4-01.md §2.7 rule 3);
//   SHA-256    `hash-wasm` (MIT), streaming: WebCrypto's digest does not stream.
//
// The page's content stamp names the pins; a page without one has no packs. A browser session
// holds no device bearer, so `devices/report` is the registered web N/A: `packSetId()` gives the
// host the active set's id for whatever it reports itself. On desktop the renderer runs this same
// facet, and the host's Node client reports `content`.

import { createSHA256, type IHasher } from "hash-wasm";
/** `kid` → raw Ed25519 public key, base64url. */
type TrustSet = Record<string, string>;
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type { AppContent, ContentHold } from "@polaris-key/protocol/packs";
import type { PackTarget, ReleasePin } from "@polaris-key/protocol/update";
import {
  PackEngine,
  PackError,
  bootPackOptions,
  memoryPackStateStore,
  memoryPackStorage,
  parseContentStamp,
  readAll,
  runBootFetch,
  holdsOf,
  stampHolds,
  type RevocationsSnapshot,
  type UpdateCheckContent,
  type VerifiedRevocation,
  type BootFetchResult,
  type BootOptions,
  type ObjectResponse,
  type PackEstimate,
  type PackHandler,
  type PackInstall,
  type PackProgress,
  type PackProvider,
  type PacksSnapshot,
  type PackStateStore,
  type PackStorage,
  type RunBootFetchOptions,
  type Sha256Port,
  type ZstdPort,
} from "@polaris-key/client-core";
import { loadZstdWasm } from "@polaris-key/zstd-wasm/browser";
import { ErrorCode } from "../constants.generated.js";
import type { DiscoveryDocument } from "../browser/discovery.js";
import { opfsPackStore, type DirHandle, type OpfsPackStore } from "./opfs.js";
import { startOpfsWorker, type WorkerLike } from "./opfsIo.js";
import {
  browserNativePayload,
  payloadUrlTemplate,
  type NativePayloadEvent,
} from "./nativePayload.js";

/** At most `limit` bytes of a body as UTF-8; the rest is never read. */
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

/** wasm32's ceiling for one delta frame (plans/P4-01.md §2.7 rule 3). */
export const WASM_MEM_BUDGET = 2 ** 30;

/** The budget when the browser reports no `navigator.deviceMemory` (Safari, Firefox). */
const UNKNOWN_DEVICE_BUDGET = 256 * 1024 * 1024;
/** The least budget this facet runs with, on the smallest device. */
const MIN_WEB_BUDGET = 64 * 1024 * 1024;

/**
 * The default memory budget on the web: a quarter of `navigator.deviceMemory` (GiB, which the
 * browser rounds and caps at 8), clamped to 64 MiB–2^30; 256 MiB when the browser does not
 * report it. A delta applied through the WASM decoder holds its base and its output at once,
 * about 2 × `memBytes` at the peak with the frame, and a one-shot `full` holds the stored frame
 * and the payload; S-04 measured about 3× a 37 MB payload resident on a 2 GB device, so the
 * quarter leaves room for the page itself.
 */
export function defaultWebMemBudget(deviceMemoryGiB?: number): number {
  const gib =
    deviceMemoryGiB ??
    (globalThis as { navigator?: { deviceMemory?: number } }).navigator
      ?.deviceMemory;
  if (typeof gib !== "number" || !Number.isFinite(gib) || gib <= 0)
    return UNKNOWN_DEVICE_BUDGET;
  return Math.min(
    WASM_MEM_BUDGET,
    Math.max(MIN_WEB_BUDGET, Math.floor((gib * 2 ** 30) / 4)),
  );
}

/** `hash-wasm`'s SHA-256 as a `Sha256Port`: streaming, its instance created in the background
 *  and fed what arrived before it was ready, in order. */
export const hashWasmSha256: Sha256Port = () => {
  const pending: Uint8Array[] = [];
  let hasher: IHasher | null = null;
  const ready = createSHA256().then((h) => {
    h.init();
    for (const p of pending) h.update(p);
    pending.length = 0;
    hasher = h;
    return h;
  });
  return {
    update(bytes) {
      if (hasher) hasher.update(bytes);
      else pending.push(bytes.slice());
    },
    async digest() {
      const h = await ready;
      return h.digest("hex");
    },
  };
};

/** `@polaris-key/zstd-wasm`'s browser decoder as a `ZstdPort` (wasm32: P = 30). */
export async function browserZstd(): Promise<ZstdPort> {
  const z = await loadZstdWasm();
  return {
    pointerBits: 30,
    decode: z.decode,
    decodeWithPrefix: z.decodeWithPrefix,
  };
}

export interface BrowserPacksOptions {
  /** The control plane (`https://key.plrs.im`). */
  baseUrl: string;
  product: string;
  /** The verified discovery document (or a getter for it): its `release.endpoints.record` and
   *  `distribution.endpoints.blobs` name where records and objects come from. */
  discovery: DiscoveryDocument | null | (() => DiscoveryDocument | null);
  /** `pinnedReleaseKeys`: the only keys a pack record verifies against. */
  releaseKeys: TrustSet;
  /** The page's pinned product keys (a release key also among them is refused). */
  productTrust: TrustSet;
  /** The page's content stamp (`pkey-content.json`, bundled with the build): its bytes, its
   *  text, or the parsed `content`. Null: no packs. */
  contentStamp: Uint8Array | string | AppContent | null;
  /** Variant preferences, per axis, in preference order. */
  axes?: Record<string, string[]>;
  /** At most `WASM_MEM_BUDGET` (2^30); larger values are clamped. Default
   *  `defaultWebMemBudget()` (from `navigator.deviceMemory`). It bounds a delta's `memBytes` and
   *  a one-shot `full` decode (stored frame plus payload). */
  memBudget?: number;
  /** `opfs` (the default) or `memory`, or a store of the host's own (with an optional sibling
   *  `revocations` store, plans/P4-13.md §2.5; without one, revocations last for the page's
   *  life only). */
  storage?:
    | "opfs"
    | "memory"
    | {
        storage: PackStorage;
        state: PackStateStore;
        revocations?: PackStateStore;
      };
  /** An OPFS root other than `navigator.storage.getDirectory()` (tests). It keeps staging on the
   *  main thread: the worker opens the real root itself. */
  opfsRoot?: DirHandle;
  /**
   * P4-18: the OPFS store's staging worker. Default: start `opfsWorker.js` (a module worker
   * beside this file, which bundlers emit from `new Worker(new URL(…, import.meta.url))`) when the
   * browser has workers and sync access handles, else the main thread. `false` keeps the main
   * thread; a function spawns the host's own copy of the worker.
   */
  opfsWorker?: false | (() => WorkerLike);
  /**
   * P4-18: run a container's `full` and its `zstd-patch-from` payload deltas through the payload
   * URL first (the browser's zstd; dcz in Chromium). Default true; `false` always uses the blob
   * route and the WASM decoder.
   */
  nativePayload?: boolean;
  /** P4-18: each payload-URL attempt (`used`, `declined` with the status, `failed`), for a host's
   *  diagnostics; the engine's own `fallback` progress reports what it then does. */
  onNativePayload?: (e: NativePayloadEvent) => void;
  /** The licence's granted flags, or null when the page cannot know them (the server gates). */
  entitlements?: () => ReadonlySet<string> | null;
  handlers?: PackHandler[];
  fetchImpl?: typeof fetch;
  /** The `X-PKey-*` metadata a public read carries. */
  headers?: Record<string, string>;
  zstd?: ZstdPort;
  sha256?: Sha256Port;
  /** Epoch seconds. */
  now?: () => number;
}

/** The facet a page holds. Errors are client-core's `PackError` (a registered code, `detail`,
 *  `path`). */
export interface BrowserPacks {
  ensure(packIds: readonly string[]): Promise<PackInstall[]>;
  estimate(packIds: readonly string[]): Promise<PackEstimate>;
  state(): Promise<PacksSnapshot>;
  /** One file of a running tree pack, or null. */
  readFile(packId: string, path: string): Promise<Uint8Array | null>;
  registerHandler(handler: PackHandler): void;
  on(listener: (e: PackProgress) => void): () => void;
  packSetId(): Promise<string | null>;
  confirm(): Promise<void>;
  rollback(packId: string): Promise<boolean>;
  /** Operator recovery after a torn state document (see `state().stateIssue`). */
  recoverState(): Promise<void>;
  bootOptions(): Required<
    Pick<BootOptions, "requiredPacks" | "essentialPacks">
  >;
  bootFetch(opts: Omit<RunBootFetchOptions, "stamp">): Promise<{
    result: BootFetchResult;
    installed: string[];
    background?: PackTarget[];
  }>;
  /** Install exact releases: a `packs` decision's `install` (plans/P4-13.md §2.6). */
  ensureReleases(targets: readonly PackTarget[]): Promise<PackInstall[]>;
  /** The stored and verified revocations and `relearn` (plans/P4-13.md §2.5). */
  revocations(): Promise<RevocationsSnapshot>;
  /** P4-20: whether a pack in the active set provides `contentId` (its record's `provides`);
   *  false without a content stamp. */
  isAvailable(contentId: string): Promise<boolean>;
  /** P4-20: the pack whose target release (the stamp's pins, or `targets`) provides
   *  `contentId`, or null. Reads records only. */
  packFor(
    contentId: string,
    targets?: readonly PackTarget[],
  ): Promise<PackProvider | null>;
  /** The update check's content input, or null without a content stamp. */
  contentInput(): Promise<UpdateCheckContent | null>;
  /** Keep the revocations an update check verified. */
  recordRevocations(r: {
    learned: { revocation: VerifiedRevocation; jws: string }[];
    relearnCleared: string[];
  }): Promise<void>;
  /** Ask the browser to keep the store through storage pressure (after engagement). */
  requestPersistence(): Promise<boolean>;
}

/** The stamp's holds (`holdsOf`, plans/P4-13.md §2.4): from the original bytes or text, with
 *  their own non-wire pointers (never re-serialised JSON, which would hide a `2.0` token); a
 *  host that passed the parsed object has no tokens left, so its `holds` are read as given. */
function holdsOfStamp(
  input: BrowserPacksOptions["contentStamp"],
): ContentHold[] | null {
  if (input === null) return [];
  if (typeof input === "string" || input instanceof Uint8Array)
    return stampHolds(input);
  return holdsOf(input, undefined, "");
}

function stampOf(
  input: BrowserPacksOptions["contentStamp"],
): AppContent | null {
  if (input === null) return null;
  if (typeof input === "string" || input instanceof Uint8Array) {
    const r = parseContentStamp(input);
    if (!r.ok)
      throw new PackError(
        ErrorCode.contentStampInvalid,
        "The content stamp is not a valid pkey-content/1 document.",
      );
    // plans/P4-19.md §2.4: the engine refuses the delegated path for a release the stamp holds,
    // and `parseContentStamp` carries no holds, so they ride along from the original input.
    return { ...r.content, holds: stampHolds(input) ?? [] };
  }
  // A parsed object keeps the holds the host gave it.
  return input;
}

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Build the browser pack facet. Nothing is fetched or opened until the first call. */
export function createBrowserPacks(opts: BrowserPacksOptions): BrowserPacks {
  const stamp = stampOf(opts.contentStamp);
  const budget = Math.min(
    opts.memBudget ?? defaultWebMemBudget(),
    WASM_MEM_BUDGET,
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sha256 = opts.sha256 ?? hashWasmSha256;
  const listeners = new Set<(e: PackProgress) => void>();
  const pendingHandlers: PackHandler[] = [...(opts.handlers ?? [])];
  let engine: PackEngine | null = null;
  let building: PackEngine | null = null;
  let starting: Promise<PackEngine> | null = null;

  const discovery = (): DiscoveryDocument | null =>
    typeof opts.discovery === "function" ? opts.discovery() : opts.discovery;
  const template = (
    service: "release" | "distribution",
    name: string,
  ): string | null => {
    const f = discovery()?.services?.[service as never] as
      | { enabled?: boolean; endpoints?: Record<string, unknown> }
      | undefined;
    if (!f || f.enabled !== true) return null;
    const t = f.endpoints?.[name];
    return typeof t === "string" && t !== "" ? t : null;
  };
  const expand = (t: string, sha: string): string =>
    new URL(
      t.split("{sha256}").join(encodeURIComponent(sha)),
      `${opts.baseUrl}/`,
    ).toString();

  const start = (): Promise<PackEngine> => {
    if (engine) return Promise.resolve(engine);
    starting ??= (async () => {
      let opfs: OpfsPackStore | null = null;
      const store: {
        storage: PackStorage;
        state: PackStateStore;
        revocations?: PackStateStore;
      } =
        opts.storage === "memory"
          ? {
              storage: memoryPackStorage(),
              state: memoryPackStateStore(),
              revocations: memoryPackStateStore(),
            }
          : typeof opts.storage === "object"
            ? opts.storage
            : (opfs = await (async () => {
                // The worker opens the real root itself, so a host-supplied root stays on the
                // main thread; a worker that cannot start leaves the main thread too.
                const io =
                  opts.opfsRoot || opts.opfsWorker === false
                    ? null
                    : await startOpfsWorker(
                        ["polaris-key", opts.product, "packs"],
                        typeof opts.opfsWorker === "function"
                          ? opts.opfsWorker
                          : undefined,
                      );
                return opfsPackStore({
                  product: opts.product,
                  sha256,
                  ...(opts.opfsRoot ? { root: opts.opfsRoot } : {}),
                  ...(io ? { io } : {}),
                });
              })().catch((e: unknown) => {
                throw new PackError(
                  ErrorCode.notConfigured,
                  `Packs need OPFS here, or storage: "memory" chosen explicitly (${(e as Error).message}).`,
                );
              }));
      const worker = opfs !== null && opfs.io === "worker" ? opfs : null;
      const e = new PackEngine({
        product: opts.product,
        releaseKeys: opts.releaseKeys,
        productTrust: () => opts.productTrust,
        stamp,
        prefs: { engine: null, axes: opts.axes ?? {} },
        zstd: opts.zstd ?? (await browserZstd()),
        sha256,
        patchMethods: ["zstd-patch-from"],
        memBudget: budget,
        // The WASM decoder cannot stream: a `full` frame plus its payload must fit the same
        // budget, or the candidate is dropped and the plan refuses cleanly.
        oneShotBudget: budget,
        storage: store.storage,
        state: store.state,
        ...(store.revocations ? { revocations: store.revocations } : {}),
        fetchRecord: async (sha) => {
          const t = template("release", "record");
          if (t === null)
            return { ok: false, code: ErrorCode.serviceUnavailable };
          try {
            const res = await fetchImpl(expand(t, sha), {
              credentials: "omit",
              headers: { accept: "application/jose", ...(opts.headers ?? {}) },
            });
            if (!res.ok) return { ok: false, code: ErrorCode.networkError };
            // A record over the bound is refused at step `hash`; never buffer more of it.
            return {
              ok: true,
              body: await readCapped(res, MAX_RECORD_JWS_BYTES + 1),
            };
          } catch {
            return { ok: false, code: ErrorCode.networkError };
          }
        },
        fetchObject: async (req): Promise<ObjectResponse> => {
          const t = template("distribution", "blobs");
          if (t === null)
            throw new PackError(
              ErrorCode.serviceUnavailable,
              "Discovery names no blob endpoint.",
            );
          const headers: Record<string, string> = { ...(opts.headers ?? {}) };
          // A chunk run (P4-11) is one bounded single range (Accept-Encoding is the browser's:
          // a forbidden header). `If-Range` costs one CORS preflight per bundle URL per
          // Access-Control-Max-Age (notes/S-02 §4.4).
          if (req.length !== undefined)
            headers.range = `bytes=${req.offset}-${req.offset + req.length - 1}`;
          else if (req.offset > 0) headers.range = `bytes=${req.offset}-`;
          if (req.ifRange !== null) headers["if-range"] = req.ifRange;
          const res = await fetchImpl(expand(t, req.sha256), {
            credentials: "omit",
            headers,
          });
          const body = res.body;
          return {
            status: res.status,
            contentRange: res.headers.get("content-range"),
            etag: res.headers.get("etag"),
            chunks: (async function* () {
              if (!body) return;
              const reader = body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                yield value;
              }
            })(),
          };
        },
        ...(opts.nativePayload === false
          ? {}
          : {
              nativePayload: browserNativePayload({
                template: () =>
                  payloadUrlTemplate(template("distribution", "blobs")),
                baseUrl: opts.baseUrl,
                fetchImpl,
                ...(opts.headers ? { headers: opts.headers } : {}),
                sha256,
                // The worker fetches with the page's own `fetch`; a host `fetchImpl` (which may
                // add its own behaviour) keeps the transfer on the main thread.
                ...(worker && !opts.fetchImpl
                  ? {
                      fetchIntoOutput: (planId, url, init, limit, onBytes) =>
                        worker.fetchIntoOutput(
                          planId,
                          url,
                          init,
                          limit,
                          onBytes,
                        ),
                    }
                  : {}),
                ...(opts.onNativePayload
                  ? { onEvent: opts.onNativePayload }
                  : {}),
              }),
            }),
        ...(opts.entitlements ? { entitlements: opts.entitlements } : {}),
        now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
        newPlanId: randomId,
        handlers: pendingHandlers,
      });
      building = e;
      e.on((p) => {
        for (const l of listeners) {
          try {
            l(p);
          } catch {
            // A listener never fails an install.
          }
        }
      });
      await e.load();
      engine = e;
      return e;
    })().catch((err: unknown) => {
      starting = null;
      building = null;
      throw err;
    });
    return starting;
  };

  return {
    ensure: async (ids) => (await start()).ensure(ids),
    estimate: async (ids) => (await start()).estimate(ids),
    state: async () => (await start()).state(),
    async readFile(packId, path) {
      const installed = await (await start()).open(packId);
      const f = installed?.files?.find((x) => x.path === path);
      return f ? readAll(f.source) : null;
    },
    registerHandler(handler) {
      const e = engine ?? building;
      if (e) e.registerHandler(handler);
      else pendingHandlers.push(handler);
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async packSetId() {
      if (stamp === null) return null;
      try {
        return await (await start()).packSetId();
      } catch {
        return null;
      }
    },
    confirm: async () => (await start()).confirm(),
    rollback: async (id) => (await start()).rollback(id),
    recoverState: async () => (await start()).recoverState(),
    bootOptions: () => bootPackOptions(stamp),
    bootFetch: async (o) => runBootFetch(await start(), { ...o, stamp }),
    ensureReleases: async (targets) => (await start()).ensureReleases(targets),
    revocations: async () => (await start()).revocations(),
    async isAvailable(contentId) {
      if (stamp === null) return false;
      return (await start()).isAvailable(contentId);
    },
    async packFor(contentId, targets) {
      if (stamp === null) return null;
      return (await start()).packFor(contentId, targets);
    },
    async contentInput() {
      if (stamp === null) return null;
      const e = await start();
      const active: Record<string, ReleasePin> = {};
      for (const [id, i] of Object.entries(e.state().running))
        active[id] = { sha256: i.recordSha256, seq: i.seq, version: i.version };
      const revs = e.revocations();
      return {
        stamp,
        holds: holdsOfStamp(opts.contentStamp),
        active,
        engine: null,
        axes: opts.axes ?? {},
        revoked: revs.verified,
        relearn: revs.relearn,
        // plans/P4-19.md §2.7: the delegated releases the engine knows.
        delegated: e.delegatedReleases(),
      };
    },
    recordRevocations: async (r) =>
      (await start()).recordRevocations(r.learned, {
        relearnCleared: r.relearnCleared,
      }),
    async requestPersistence() {
      const nav = (
        globalThis as {
          navigator?: { storage?: { persist?: () => Promise<boolean> } };
        }
      ).navigator;
      return typeof nav?.storage?.persist === "function"
        ? nav.storage.persist()
        : false;
    },
  };
}
