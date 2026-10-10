// The product's presentation (discovery `core.presentation`, WIRE-CONTRACT-V4 §5.5) for the React
// SDK: client-core's `PresentationSource` seam (plans/HA-11.md Q7, plans/HA-13.md §3), which the
// UI kits read and never re-implement. Both adapters hand one out (`adapter.presentationSource()`):
//
//   browser   `BrowserPresentationSource`: discovery's member re-parsed after every successful
//             discovery, `presentation.json` (here an IndexedDB record) for a cold start, and the
//             icon fetched in-page under the fetch rules below, verified, cached by hash.
//   desktop   `BridgePresentationSource`: the host's Node client holds the member (it rides every
//             state push) and the cache (`invoke("core", "presentationIcon")`), so the renderer
//             fetches nothing itself; the bytes are verified again here.
//
// **Fetch (browser).** A plain GET with no headers, `credentials: "omit"`, `redirect: "error"`
// (any redirect fails the fetch), `referrerPolicy: "no-referrer"`, 200 only, the
// PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS deadline and the PRESENTATION_ICON_MAX_BYTES cap. The
// URL must be https (or loopback http) and on the original's origin. Nothing is retried and no
// error is surfaced: a miss is `null`, and the kit shows its monogram.
//
// **Delivery (D2).** `iconUrl()` hands out a `blob:` URL of the verified bytes, so an integrator's
// CSP needs `img-src blob:` (and `connect-src` for the image origin). A URL is revoked once the
// member no longer names its bytes. A blocked image fires `onerror` and the kit falls back.

import {
  iconMatches,
  parsePresentation,
  pickIconSize,
  usableUrlOrigin,
  type IconPick,
  type PresentationSource,
  type ProductPresentation,
} from "@polaris-key/client-core/presentation";
import {
  PRESENTATION_CACHE_MAX_FILES,
  PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS,
  PRESENTATION_ICON_MAX_BYTES,
  PRESENTATION_ICON_TYPES,
} from "../constants.generated.js";

export type {
  PresentationSource,
  ProductPresentation,
} from "@polaris-key/client-core/presentation";

/** client-core's seam plus the browser's delivery: a `blob:` URL of the verified icon. */
export interface ReactPresentationSource extends PresentationSource {
  /** A `blob:` URL of the verified icon for a hero drawn at `px` points on a `scale` screen, or
   *  null. The same bytes share one URL. */
  iconUrl(px: number, scale: number): Promise<string | null>;
}

/** `presentation.json`'s own format version. */
const MEMBER_FILE_VERSION = 1;

/** Where the browser keeps the last member and the icon bytes. IndexedDB in a page. */
export interface PresentationCache {
  readMember(product: string): Promise<unknown>;
  /** `null` deletes it. */
  writeMember(product: string, record: unknown): Promise<void>;
  readIcon(sha256: string): Promise<Uint8Array | null>;
  writeIcon(sha256: string, bytes: Uint8Array): Promise<void>;
  /** The cached icons, each with when it was written (epoch ms). */
  icons(): Promise<{ sha256: string; at: number }[]>;
  deleteIcon(sha256: string): Promise<void>;
}

/** A cache that lives as long as the page (tests; no IndexedDB). */
export function memoryPresentationCache(
  now: () => number = Date.now,
): PresentationCache {
  const members = new Map<string, unknown>();
  const icons = new Map<string, { bytes: Uint8Array; at: number }>();
  return {
    readMember: async (p) => members.get(p) ?? null,
    writeMember: async (p, r) => {
      if (r === null) members.delete(p);
      else members.set(p, structuredClone(r));
    },
    readIcon: async (s) => icons.get(s)?.bytes.slice() ?? null,
    writeIcon: async (s, b) => {
      icons.set(s, { bytes: b.slice(), at: now() });
    },
    icons: async () => [...icons].map(([sha256, v]) => ({ sha256, at: v.at })),
    deleteIcon: async (s) => {
      icons.delete(s);
    },
  };
}

const DB_NAME = "polaris-key-presentation";
const DB_VERSION = 1;
const MEMBERS = "members";
const ICONS = "icons";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * The IndexedDB cache: its own database (`polaris-key-presentation`), so it never moves the
 * version of the one that holds the device token and offline documents. Null where IndexedDB
 * does not exist; the source then keeps what it fetched in memory only.
 */
export function indexedDbPresentationCache(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
): PresentationCache | null {
  if (!factory) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!db) {
      const r = factory.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        for (const name of [MEMBERS, ICONS])
          if (!r.result.objectStoreNames.contains(name))
            r.result.createObjectStore(name);
      };
      db = req(r);
      db.catch(() => {
        db = null;
      });
    }
    return db;
  };
  const store = async (name: string, mode: IDBTransactionMode) =>
    (await open()).transaction(name, mode).objectStore(name);
  return {
    readMember: async (p) =>
      (await req((await store(MEMBERS, "readonly")).get(p))) ?? null,
    writeMember: async (p, r) => {
      const s = await store(MEMBERS, "readwrite");
      if (r === null) await req(s.delete(p));
      else await req(s.put(r, p));
    },
    readIcon: async (sha) => {
      const v = (await req((await store(ICONS, "readonly")).get(sha))) as
        | { bytes?: unknown }
        | undefined;
      return v?.bytes instanceof Uint8Array ? v.bytes : null;
    },
    writeIcon: async (sha, bytes) => {
      await req(
        (await store(ICONS, "readwrite")).put({ bytes, at: Date.now() }, sha),
      );
    },
    icons: async () => {
      const s = await store(ICONS, "readonly");
      const [keys, values] = await Promise.all([
        req(s.getAllKeys()),
        req(s.getAll()),
      ]);
      return keys.map((k, i) => ({
        sha256: String(k),
        at: Number((values[i] as { at?: unknown })?.at) || 0,
      }));
    },
    deleteIcon: async (sha) => {
      await req((await store(ICONS, "readwrite")).delete(sha));
    },
  };
}

/** The fetcher's safe-link rule: `url` is usable (https, or loopback http) and on `original`'s
 *  origin. */
export function safeIconUrl(url: string, original: string): boolean {
  const origin = usableUrlOrigin(url);
  return origin !== null && origin === usableUrlOrigin(original);
}

/** The icon hashes `member` names: the original's and each size's. */
export function namedIcons(member: ProductPresentation | null): Set<string> {
  const out = new Set<string>();
  if (member?.icon) {
    out.add(member.icon.sha256);
    for (const s of member.icon.sizes) out.add(s.sha256);
  }
  return out;
}

/** One pick's bytes under the browser fetch rules, or `null`. */
export async function fetchIconBytes(
  f: typeof fetch,
  pick: { url: string; sha256: string },
  original: string,
): Promise<Uint8Array | null> {
  if (!safeIconUrl(pick.url, original)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(),
    PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS * 1000,
  );
  try {
    const res = await f(pick.url, {
      method: "GET",
      headers: {},
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: ctl.signal,
    });
    if (res.status !== 200 || res.redirected) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(res, PRESENTATION_ICON_MAX_BYTES);
    if (bytes === null) return null;
    return (await iconMatches(bytes, pick.sha256)) ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(
  res: Response,
  cap: number,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Deep equality over JSON-shaped values (members are parser output: no cycles, no classes). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      same(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
  );
}

type Pick = Exclude<IconPick, { source: "none" }>;

/** What both adapters share: the member, its listeners, the icon pick and the blob URLs. */
abstract class BasePresentationSource implements ReactPresentationSource {
  /** The content types `icon()` asks for (a browser decodes every PRESENTATION_ICON_TYPES one). */
  decodable: readonly string[] = PRESENTATION_ICON_TYPES;
  protected member: ProductPresentation | null = null;
  private readonly listeners = new Set<
    (presentation: ProductPresentation | null) => void
  >();
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();
  private readonly urls = new Map<string, string>();

  current(): ProductPresentation | null {
    return this.member === null ? null : structuredClone(this.member);
  }

  subscribe(
    fn: (presentation: ProductPresentation | null) => void,
  ): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Install a member; notify when it changed; revoke the URLs it no longer names. */
  protected set(m: ProductPresentation | null): void {
    if (same(m, this.member)) return;
    this.member = m;
    const keep = namedIcons(m);
    for (const [sha, url] of this.urls)
      if (!keep.has(sha)) {
        this.urls.delete(sha);
        revoke(url);
      }
    for (const fn of [...this.listeners]) {
      try {
        fn(this.current());
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private pickFor(px: number, scale: number): Pick | null {
    const icon = this.member?.icon;
    if (!icon) return null;
    const pick = pickIconSize(icon, px, scale, this.decodable);
    return pick.source === "none" ? null : pick;
  }

  async icon(px: number, scale: number): Promise<Uint8Array | null> {
    const pick = this.pickFor(px, scale);
    const icon = this.member?.icon;
    if (!pick || !icon) return null;
    let p = this.pending.get(pick.sha256);
    if (!p) {
      p = this.bytes(pick, icon.original, px, scale)
        .catch(() => null)
        .finally(() => this.pending.delete(pick.sha256));
      this.pending.set(pick.sha256, p);
    }
    const bytes = await p;
    return bytes === null ? null : bytes.slice();
  }

  async iconUrl(px: number, scale: number): Promise<string | null> {
    const pick = this.pickFor(px, scale);
    const icon = this.member?.icon;
    if (!pick || !icon) return null;
    const held = this.urls.get(pick.sha256);
    if (held) return held;
    const bytes = await this.icon(px, scale);
    if (bytes === null || typeof URL.createObjectURL !== "function")
      return null;
    // The member may have moved on while the bytes were on the way.
    if (!namedIcons(this.member).has(pick.sha256)) return null;
    const again = this.urls.get(pick.sha256);
    if (again) return again;
    const type = pick.source === "size" ? "image/webp" : icon.contentType;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    this.urls.set(pick.sha256, url);
    return url;
  }

  /** Verified bytes for `pick`, or null. */
  protected abstract bytes(
    pick: Pick,
    original: string,
    px: number,
    scale: number,
  ): Promise<Uint8Array | null>;
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Nothing to release.
  }
}

export interface BrowserPresentationOptions {
  product: string;
  /** The page's fetch, called per request. */
  fetchImpl: () => typeof fetch;
  /** Default: IndexedDB, else memory. */
  cache?: PresentationCache | null;
}

/** The browser adapter's source: in-page discovery, IndexedDB cache, in-page verified fetch. */
export class BrowserPresentationSource extends BasePresentationSource {
  private discovered = false;
  private readonly cache: PresentationCache;

  constructor(private readonly opts: BrowserPresentationOptions) {
    super();
    this.cache =
      opts.cache === undefined
        ? (indexedDbPresentationCache() ?? memoryPresentationCache())
        : (opts.cache ?? memoryPresentationCache());
  }

  /** Cold start: the last member, unless this page already discovered one. Never throws. */
  async load(): Promise<void> {
    let m: ProductPresentation | null = null;
    try {
      const v = (await this.cache.readMember(this.opts.product)) as {
        v?: unknown;
        product?: unknown;
        presentation?: unknown;
      } | null;
      if (
        v &&
        typeof v === "object" &&
        v.v === MEMBER_FILE_VERSION &&
        v.product === this.opts.product
      ) {
        m = parsePresentation(
          { presentation: v.presentation },
          { product: this.opts.product },
        );
        // Only a member this SDK wrote reads back: the parser's normal form, exactly.
        if (m !== null && !same(m, v.presentation)) m = null;
      }
      if (m === null && v !== null)
        await this.cache.writeMember(this.opts.product, null);
    } catch {
      m = null;
    }
    if (!this.discovered && m !== null) this.set(m);
  }

  /** A successful discovery's document. No member (or an invalid one) clears it. Never throws. */
  async accept(doc: {
    core?: unknown;
    name?: unknown;
    product?: unknown;
  }): Promise<void> {
    this.discovered = true;
    const m = parsePresentation(doc.core, {
      name: doc.name,
      product:
        typeof doc.product === "string" ? doc.product : this.opts.product,
    });
    this.set(m);
    try {
      await this.cache.writeMember(
        this.opts.product,
        m === null
          ? null
          : {
              v: MEMBER_FILE_VERSION,
              product: this.opts.product,
              presentation: m,
            },
      );
      const keep = namedIcons(m);
      for (const { sha256 } of await this.cache.icons())
        if (!keep.has(sha256)) await this.cache.deleteIcon(sha256);
      await this.capIcons(null);
    } catch {
      // A cache that cannot be written leaves the page's own copy.
    }
  }

  protected async bytes(
    pick: Pick,
    original: string,
  ): Promise<Uint8Array | null> {
    try {
      const held = await this.cache.readIcon(pick.sha256);
      if (held && (await iconMatches(held, pick.sha256))) return held;
      if (held) await this.cache.deleteIcon(pick.sha256);
    } catch {
      // Not cached.
    }
    const bytes = await fetchIconBytes(this.opts.fetchImpl(), pick, original);
    if (bytes === null) return null;
    try {
      await this.cache.writeIcon(pick.sha256, bytes);
      await this.capIcons(pick.sha256);
    } catch {
      // Served, just not cached.
    }
    return bytes;
  }

  /** At most PRESENTATION_CACHE_MAX_FILES icons: the oldest go first; `fresh` never does. */
  private async capIcons(fresh: string | null): Promise<void> {
    const all = (await this.cache.icons()).filter((i) => i.sha256 !== fresh);
    const room = PRESENTATION_CACHE_MAX_FILES - (fresh !== null ? 1 : 0);
    if (all.length <= room) return;
    all.sort((a, b) => a.at - b.at || (a.sha256 < b.sha256 ? -1 : 1));
    for (const i of all.slice(0, all.length - room))
      await this.cache.deleteIcon(i.sha256);
  }
}

/** What the desktop source needs of the bridge. */
export type BridgeInvoke = (
  service: string,
  method: string,
  args?: unknown,
) => Promise<unknown>;

/**
 * The desktop adapter's source: the host's Node client holds the member and the cache. A host
 * that does not answer the verbs (an older bridge) reads as no presentation.
 */
export class BridgePresentationSource extends BasePresentationSource {
  constructor(private readonly invoke: BridgeInvoke | null) {
    super();
  }

  /** The host's member from a state push (`BridgeState.presentation`). */
  adopt(raw: unknown): void {
    // Re-normalised here: the renderer trusts the host's process, not the shape of its answer.
    // The host's member is already normal, so its name always reads back.
    this.set(
      raw && typeof raw === "object"
        ? parsePresentation({ presentation: raw }, { product: "app" })
        : null,
    );
  }

  protected async bytes(
    pick: Pick,
    _original: string,
    px: number,
    scale: number,
  ): Promise<Uint8Array | null> {
    if (!this.invoke) return null;
    const got = await this.invoke("core", "presentationIcon", {
      px,
      scale,
      decodable: [...this.decodable],
    });
    const bytes =
      got instanceof Uint8Array
        ? got
        : ArrayBuffer.isView(got)
          ? new Uint8Array(got.buffer, got.byteOffset, got.byteLength)
          : got instanceof ArrayBuffer
            ? new Uint8Array(got)
            : null;
    if (bytes === null || bytes.byteLength > PRESENTATION_ICON_MAX_BYTES)
      return null;
    return (await iconMatches(bytes, pick.sha256)) ? bytes : null;
  }
}
