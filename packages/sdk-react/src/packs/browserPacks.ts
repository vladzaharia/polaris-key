// `update.packs` for the web transport (plans/P4-01.md §2.6–§2.9, §5 order 1; CONTENT §10 "Web",
// §13; P4-06). It is client-core's `PackEngine`, exactly as `@polaris-key/node` runs it, with the
// browser's ports:
//
//   transport  the pinned pack record from discovery's `release.endpoints.record`, objects from
//              `distribution.endpoints.blobs` with `Range`/`If-Range`, credentialed `fetch`;
//   storage    OPFS by default (`opfsPackStore`), or the in-memory store a host passes explicitly
//              (tests, a page that must not persist); never a silent fallback;
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
import type { AppContent } from "@polaris-key/protocol/packs";
import {
  PackEngine,
  PackError,
  bootPackOptions,
  memoryPackStateStore,
  memoryPackStorage,
  parseContentStamp,
  readAll,
  runBootFetch,
  type BootFetchResult,
  type BootOptions,
  type ObjectResponse,
  type PackEstimate,
  type PackHandler,
  type PackInstall,
  type PackProgress,
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
import { opfsPackStore, type DirHandle } from "./opfs.js";

/** wasm32's ceiling for one delta frame (plans/P4-01.md §2.7 rule 3). */
export const WASM_MEM_BUDGET = 2 ** 30;

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
  /** At most `WASM_MEM_BUDGET` (2^30); larger values are clamped. Default 256 MiB. */
  memBudget?: number;
  /** `opfs` (the default) or `memory`, or a store of the host's own. */
  storage?: "opfs" | "memory" | { storage: PackStorage; state: PackStateStore };
  /** An OPFS root other than `navigator.storage.getDirectory()` (tests). */
  opfsRoot?: DirHandle;
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
  bootOptions(): Required<
    Pick<BootOptions, "requiredPacks" | "essentialPacks">
  >;
  bootFetch(
    opts: Omit<RunBootFetchOptions, "stamp">,
  ): Promise<{ result: BootFetchResult; installed: string[] }>;
  /** Ask the browser to keep the store through storage pressure (after engagement). */
  requestPersistence(): Promise<boolean>;
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
    return r.content;
  }
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
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sha256 = opts.sha256 ?? hashWasmSha256;
  const listeners = new Set<(e: PackProgress) => void>();
  const pendingHandlers: PackHandler[] = [...(opts.handlers ?? [])];
  let engine: PackEngine | null = null;
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
      const store =
        opts.storage === "memory"
          ? { storage: memoryPackStorage(), state: memoryPackStateStore() }
          : typeof opts.storage === "object"
            ? opts.storage
            : await opfsPackStore({
                product: opts.product,
                sha256,
                ...(opts.opfsRoot ? { root: opts.opfsRoot } : {}),
              }).catch((e: unknown) => {
                throw new PackError(
                  ErrorCode.notConfigured,
                  `Packs need OPFS here, or storage: "memory" chosen explicitly (${(e as Error).message}).`,
                );
              });
      const e = new PackEngine({
        product: opts.product,
        releaseKeys: opts.releaseKeys,
        productTrust: () => opts.productTrust,
        stamp,
        prefs: { engine: null, axes: opts.axes ?? {} },
        zstd: opts.zstd ?? (await browserZstd()),
        sha256,
        patchMethods: ["zstd-patch-from"],
        memBudget: Math.min(
          opts.memBudget ?? 256 * 1024 * 1024,
          WASM_MEM_BUDGET,
        ),
        storage: store.storage,
        state: store.state,
        fetchRecord: async (sha) => {
          const t = template("release", "record");
          if (t === null)
            return { ok: false, code: ErrorCode.serviceUnavailable };
          try {
            const res = await fetchImpl(expand(t, sha), {
              credentials: "include",
              headers: { accept: "application/jose", ...(opts.headers ?? {}) },
            });
            if (!res.ok) return { ok: false, code: ErrorCode.networkError };
            return { ok: true, body: await res.text() };
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
          if (req.offset > 0) headers.range = `bytes=${req.offset}-`;
          if (req.ifRange !== null) headers["if-range"] = req.ifRange;
          const res = await fetchImpl(expand(t, req.sha256), {
            credentials: "include",
            headers,
          });
          const body = res.body;
          return {
            status: res.status,
            contentRange: res.headers.get("content-range"),
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
        ...(opts.entitlements ? { entitlements: opts.entitlements } : {}),
        now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
        newPlanId: randomId,
        handlers: pendingHandlers,
      });
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
      if (engine) engine.registerHandler(handler);
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
    bootOptions: () => bootPackOptions(stamp),
    bootFetch: async (o) => runBootFetch(await start(), { ...o, stamp }),
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
