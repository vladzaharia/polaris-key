// The product's presentation (discovery `core.presentation`, WIRE-CONTRACT-V4 §5.5): its name,
// developer, accents and verified icon. The Node half of client-core's `PresentationSource` seam
// (plans/HA-11.md Q7, plans/HA-13.md §3): the UI kits read it, and never fetch discovery or the
// icon themselves.
//
//   current()          the last parsed member (client-core `parsePresentation`), or null
//   icon(px, scale)    verified icon bytes for a hero drawn at `px` points on a `scale` screen, or
//                      null; the kit then shows its monogram tile
//   subscribe(fn)      called with the new member whenever it changes
//
// After every successful discovery the member is parsed again: a document without one (or with an
// invalid one) clears it, and a failed discovery keeps the last. `load()` reads the last member
// from `presentation.json` through the same parser, so an offline start still shows the product
// and a tampered file is dropped.
//
// **Fetch.** A plain GET with no headers (no `Authorization`, no cookies, no `X-PKey-*`: the image
// host is public), `redirect: "manual"` so any 3xx is a miss, 200 only, the
// PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS deadline and the PRESENTATION_ICON_MAX_BYTES cap.
// The URL must be https (or loopback http) and on the original's origin, so a `{w}` expansion
// can never reach another host. Nothing is retried and no error is surfaced; a local-only client
// never dials.
//
// **Verify.** Bytes are returned and cached only when their SHA-256 is the pick's `sha256`.
//
// **Cache.** `<cacheDir>/<product>/presentation/<sha256>`, and the last member as
// `presentation.json` beside it, both written to a temporary name and renamed. A cached file is
// re-hashed on every read and deleted on a mismatch. After each discovery the files the member no
// longer names are removed, keeping at most PRESENTATION_CACHE_MAX_FILES icon files. Nothing
// enters the Core cache record.

import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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

/** The last member's file, beside the icons. */
export const PRESENTATION_MEMBER_FILE = "presentation.json";
/** `presentation.json`'s own format version. */
const MEMBER_FILE_VERSION = 1;
const SHA256_NAME = /^[0-9a-f]{64}$/;

/** What `client.presentationIcon()` takes. */
export interface PresentationIconOptions {
  /** The hero's size in points (CSS px, terminal cells × the cell's px). */
  px: number;
  /** The screen's scale (device pixel ratio). Default 1. */
  scale?: number;
  /** The content types the caller can decode. Default: every PRESENTATION_ICON_TYPES entry. */
  decodable?: Iterable<string>;
}

export interface PresentationStoreOptions {
  product: string;
  /** Where the icons and `presentation.json` live. */
  dir: string;
  /** The transport, called per fetch. Throws in local-only mode, which is a miss. */
  fetcher: () => typeof fetch;
  /** The content types `icon()` asks for by default. */
  decodable?: readonly string[];
}

/**
 * The fetcher's safe-link rule (plans/HA-13.md §3): `url` is usable (https, or http on a loopback
 * host) and on `original`'s origin.
 */
export function safeIconUrl(url: string, original: string): boolean {
  const origin = usableUrlOrigin(url);
  return origin !== null && origin === usableUrlOrigin(original);
}

/** The icon hashes `member` names: the original's and each size's. */
export function namedIconFiles(
  member: ProductPresentation | null,
): Set<string> {
  const out = new Set<string>();
  if (member?.icon) {
    out.add(member.icon.sha256);
    for (const s of member.icon.sizes) out.add(s.sha256);
  }
  return out;
}

/**
 * Fetch one icon pick's bytes under the fetch rules, or `null`. Exported for the React desktop
 * adapter's tests and for anything else that must not reimplement them.
 */
export async function fetchIconBytes(
  f: typeof fetch,
  pick: { url: string; sha256: string },
  original: string,
): Promise<Uint8Array | null> {
  if (!safeIconUrl(pick.url, original)) return null;
  try {
    const res = await f(pick.url, {
      method: "GET",
      headers: {},
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(
        PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS * 1000,
      ),
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
  }
}

/** The body, or `null` past `cap` bytes (declared or counted). */
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

/** client-core's `PresentationSource` over Node's discovery and a file cache. */
export class PresentationStore implements PresentationSource {
  /** The content types `icon()` asks for when the caller names none. */
  decodable: readonly string[];
  private member: ProductPresentation | null = null;
  private discovered = false;
  private readonly listeners = new Set<
    (presentation: ProductPresentation | null) => void
  >();
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();

  constructor(private readonly opts: PresentationStoreOptions) {
    this.decodable = opts.decodable ?? PRESENTATION_ICON_TYPES;
  }

  /** The cache directory. */
  get dir(): string {
    return this.opts.dir;
  }

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

  /** Cold boot: the last member from `presentation.json`, unless this session discovered one. */
  async load(): Promise<void> {
    const m = await this.readMember();
    if (!this.discovered && m !== null) this.set(m);
  }

  /**
   * A successful discovery's document: parse, store, prune, and notify when the member changed.
   * No member (or an invalid one) clears it. Never throws.
   */
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
    await this.writeMember(m).catch(() => undefined);
    await this.prune(m).catch(() => undefined);
  }

  icon(px: number, scale: number): Promise<Uint8Array | null> {
    return this.iconFor({ px, scale });
  }

  /** `icon()` with the caller's decodable types. */
  async iconFor(o: PresentationIconOptions): Promise<Uint8Array | null> {
    const m = this.member;
    if (!m?.icon) return null;
    const pick = pickIconSize(
      m.icon,
      o.px,
      o.scale ?? 1,
      o.decodable ?? this.decodable,
    );
    if (pick.source === "none") return null;
    let p = this.pending.get(pick.sha256);
    if (!p) {
      p = this.loadIcon(pick, m.icon.original).finally(() =>
        this.pending.delete(pick.sha256),
      );
      this.pending.set(pick.sha256, p);
    }
    const bytes = await p;
    return bytes === null ? null : bytes.slice();
  }

  /** The icon files in the cache, by name. */
  async cachedFiles(): Promise<string[]> {
    try {
      return (await readdir(this.opts.dir)).filter((f) => SHA256_NAME.test(f));
    } catch {
      return [];
    }
  }

  private set(m: ProductPresentation | null): void {
    if (isDeepStrictEqual(m, this.member)) return;
    this.member = m;
    for (const fn of [...this.listeners]) {
      try {
        fn(this.current());
      } catch {
        // A listener's failure is its own; the others still hear.
      }
    }
  }

  /** The disk cache (re-hashed), else the network; verified, then cached. */
  private async loadIcon(
    pick: Exclude<IconPick, { source: "none" }>,
    original: string,
  ): Promise<Uint8Array | null> {
    const path = join(this.opts.dir, pick.sha256);
    try {
      const held = new Uint8Array(await readFile(path));
      if (await iconMatches(held, pick.sha256)) return held;
      // Tampered or truncated: gone, and fetched again below.
      await rm(path, { force: true });
    } catch {
      // Not cached.
    }
    let f: typeof fetch;
    try {
      f = this.opts.fetcher();
    } catch {
      return null; // local-only
    }
    const bytes = await fetchIconBytes(f, pick, original);
    if (bytes === null) return null;
    if (await this.write(pick.sha256, bytes).catch(() => false))
      await this.capFiles(pick.sha256).catch(() => undefined);
    return bytes;
  }

  /** Remove every file `member` does not name (and any interrupted write), then cap the rest. */
  async prune(member: ProductPresentation | null): Promise<void> {
    const keep = namedIconFiles(member);
    let files: string[];
    try {
      files = await readdir(this.opts.dir);
    } catch {
      return;
    }
    for (const f of files)
      if (f !== PRESENTATION_MEMBER_FILE && !keep.has(f))
        await rm(join(this.opts.dir, f), { force: true }).catch(
          () => undefined,
        );
    await this.capFiles(null);
  }

  /** At most PRESENTATION_CACHE_MAX_FILES icon files: the oldest go first; `fresh` never does. */
  private async capFiles(fresh: string | null): Promise<void> {
    const files: { name: string; mtime: number }[] = [];
    for (const name of await this.cachedFiles()) {
      if (name === fresh) continue;
      try {
        files.push({
          name,
          mtime: (await stat(join(this.opts.dir, name))).mtimeMs,
        });
      } catch {
        // Gone meanwhile.
      }
    }
    const room = PRESENTATION_CACHE_MAX_FILES - (fresh !== null ? 1 : 0);
    if (files.length <= room) return;
    files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
    for (const f of files.slice(0, files.length - room))
      await rm(join(this.opts.dir, f.name), { force: true }).catch(
        () => undefined,
      );
  }

  /** Write `bytes` to `name`: a temporary file, renamed over the target. */
  private async write(name: string, bytes: Uint8Array): Promise<boolean> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    const target = join(this.opts.dir, name);
    const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, target);
      return true;
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      return false;
    }
  }

  private async writeMember(m: ProductPresentation | null): Promise<void> {
    const path = join(this.opts.dir, PRESENTATION_MEMBER_FILE);
    if (m === null) {
      await rm(path, { force: true });
      return;
    }
    await this.write(
      PRESENTATION_MEMBER_FILE,
      new TextEncoder().encode(
        JSON.stringify({
          v: MEMBER_FILE_VERSION,
          product: this.opts.product,
          presentation: m,
        }),
      ),
    );
  }

  /**
   * The member `presentation.json` holds, or null. A file that does not parse, names another
   * product, or does not read back exactly as the parser normalises it is deleted.
   */
  private async readMember(): Promise<ProductPresentation | null> {
    const path = join(this.opts.dir, PRESENTATION_MEMBER_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let m: ProductPresentation | null = null;
    try {
      const v = JSON.parse(raw) as {
        v?: unknown;
        product?: unknown;
        presentation?: unknown;
      };
      if (
        v !== null &&
        typeof v === "object" &&
        v.v === MEMBER_FILE_VERSION &&
        v.product === this.opts.product
      ) {
        m = parsePresentation(
          { presentation: v.presentation },
          { product: this.opts.product },
        );
        // Only a member this SDK wrote reads back: the parser's normal form, exactly.
        if (m !== null && !isDeepStrictEqual(m, v.presentation)) m = null;
      }
    } catch {
      m = null;
    }
    if (m === null) await rm(path, { force: true }).catch(() => undefined);
    return m;
  }
}
