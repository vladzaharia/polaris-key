// Product presentation (WIRE-CONTRACT-V4 §5.5, plans/HA-11.md §2.1, plans/HA-12.md §2.6), pinned
// by `presentation-matrix.json`.
//
// Discovery's `core.presentation` is UNSIGNED display data: the product's name, its developer, an
// accent for light and dark grounds, and an icon given as content-addressed image-host URLs with
// the original's hash and each WebP width's hash. No gate, entitlement or trust decision reads it.
// This module is the reference every SDK ports:
//
//   parsePresentation   the member, field by field. A malformed field is dropped; the member never
//                       refuses discovery. `parseCases`.
//   pickIconSize        which bytes to fetch for a hero drawn at `px` points on a `scale` screen,
//                       given the image types the platform can decode. `pickCases`.
//   iconMatches         bytes are shown (and cached) only when their SHA-256 equals the hash the
//                       pick names. `verifyCases`.
//   PresentationSource  the seam the UI kits read (plans/HA-11.md Q7).
//
// ── THE PARSE RULES (§5.5) ──────────────────────────────────────────────────────────────────────
//
//   1. `core` not an object, or its `presentation` not an object: no member (`null`).
//   2. `name` and `developerName`: a string of 1 to PRESENTATION_TEXT_MAX_BYTES UTF-8 bytes with no
//      control character (C0 U+0000–U+001F, DEL U+007F, C1 U+0080–U+009F) and no lone surrogate.
//      Bidi and zero-width characters are kept (plans/HA-12.md Q5: the kits isolate the text). An
//      invalid `developerName` is dropped; an invalid `name` falls back to the document's
//      top-level `name` (by the same rule), then to the product slug.
//   3. `accent`, `accentDark`: `^#[0-9A-Fa-f]{6}$`, lower-cased; anything else is dropped.
//   4. `icon` is kept only with a lower-case hex `sha256`, a `contentType` on
//      PRESENTATION_ICON_TYPES and a usable `original` (rule 5). Within it, `width` and `height`
//      are integers 1…PRESENTATION_ICON_MAX_DIMENSION or dropped; `sizes` is at most
//      PRESENTATION_MAX_ICON_SIZES `{w, sha256}` entries, each `w` an integer
//      1…PRESENTATION_MAX_ICON_WIDTH strictly ascending: any bad entry drops `sizes` and `url`
//      (the original stays). `url` holds exactly one `{w}`, begins with the original's origin and
//      then `/` or `?` (so the width can never change the host or the port), and is a usable URL
//      once that `{w}` is filled; otherwise, or with no sizes, `url` and `sizes` are both dropped.
//      An absent `sizes` reads as `[]`.
//   5. A usable URL: 1 to PRESENTATION_URL_MAX_BYTES printable ASCII characters (U+0021–U+007E: no
//      space, no control, nothing non-ASCII) with no `#` (no fragment) and no `\`; it begins
//      `https://` or `http://` (ASCII-case-insensitively). Its authority, up to the first `/`, `?`
//      or the end and lower-cased, is a host and an optional `:port` of 1 to 5 digits, at most
//      65535. The host is `[::1]` (the one bracketed address, with nothing but a port after
//      it), `127.0.0.1`, or dot-separated labels of 1 to 63 characters in `[a-z0-9-]` whose last
//      label is not all digits: so no userinfo `@`, no `%`, no empty label. `http` only for the
//      hosts `localhost`, `127.0.0.1` and `[::1]`. There is no pinned host: production, staging and
//      dev use `img`, `img-staging` and `img-dev`. The origin two URLs share is their scheme and
//      authority, lower-cased, compared exactly. On ports, bracketed addresses and host characters
//      the rule is stricter than a WHATWG URL parser, never looser.
//
// The rules are deliberately portable: no URL parser, no Unicode normalisation, nothing Godot's
// GDScript cannot do. The corpus generator (`tools/presentation-matrix.ts`) holds its own
// reference implementation, so a bug this module shares with it cannot hide.

import {
  PRESENTATION_ICON_MAX_DIMENSION,
  PRESENTATION_ICON_TYPES,
  PRESENTATION_MAX_ICON_SIZES,
  PRESENTATION_MAX_ICON_WIDTH,
  PRESENTATION_TEXT_MAX_BYTES,
  PRESENTATION_URL_MAX_BYTES,
  type PresentationIcon,
  type PresentationIconSize,
  type PresentationIconType,
  type ProductPresentation,
} from "@polaris-key/protocol/core";

export type {
  PresentationIcon,
  PresentationIconSize,
  PresentationIconType,
  ProductPresentation,
};

/** The document fields the name falls back to: the top-level `name`, then the slug. */
export interface PresentationDoc {
  name?: unknown;
  product: string;
}

/** What `pickIconSize` chose. `url` is the URL to fetch; `sha256` is what its bytes must hash to. */
export type IconPick =
  | { source: "size"; w: number; sha256: string; url: string }
  | { source: "original"; sha256: string; url: string }
  | { source: "none" };

/**
 * The seam every UI kit reads (plans/HA-11.md Q7). An SDK implements it over its discovery client
 * and its icon cache; a kit never fetches discovery or the icon itself.
 */
export interface PresentationSource {
  /** The last parsed member, or `null` (none served, or none known yet). */
  current(): ProductPresentation | null;
  /** Verified icon bytes for a hero drawn at `px` points on a `scale` screen, or `null`. */
  icon(px: number, scale: number): Promise<Uint8Array | null>;
  /** Called with the new member whenever it changes; returns the unsubscribe. */
  subscribe(fn: (presentation: ProductPresentation | null) => void): () => void;
}

const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ICON_TYPES: ReadonlySet<string> = new Set(PRESENTATION_ICON_TYPES);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);
const DNS_LABEL = /^[a-z0-9-]{1,63}$/;
const ALL_DIGITS = /^[0-9]+$/;

/** A lower-cased authority's host when it has a usable host and port, else `null`. */
function authorityHost(authority: string): string | null {
  let host: string;
  let port: string | null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    host = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) return null;
    port = after === "" ? null : after.slice(1);
  } else {
    const colon = authority.indexOf(":");
    host = colon === -1 ? authority : authority.slice(0, colon);
    port = colon === -1 ? null : authority.slice(colon + 1);
  }
  if (
    port !== null &&
    (port.length < 1 ||
      port.length > 5 ||
      !ALL_DIGITS.test(port) ||
      Number(port) > 65535)
  )
    return null;
  if (host === "[::1]" || host === "127.0.0.1") return host;
  const labels = host.split(".");
  if (!labels.every((l) => DNS_LABEL.test(l))) return null;
  if (ALL_DIGITS.test(labels[labels.length - 1]!)) return null;
  return host;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** UTF-8 byte length of `s`, or `-1` when `s` holds a lone surrogate (not encodable). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return -1;
      n += 4;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return -1;
    else n += 3;
  }
  return n;
}

/** Rule 2: a display text, or `undefined`. */
function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const bytes = utf8Length(v);
  if (bytes < 1 || bytes > PRESENTATION_TEXT_MAX_BYTES) return undefined;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return undefined;
  }
  return v;
}

/** Rule 3: a colour, lower-cased, or `undefined`. */
function colour(v: unknown): string | undefined {
  return typeof v === "string" && HEX_COLOUR.test(v)
    ? v.toLowerCase()
    : undefined;
}

/** Rule 5: the URL's origin (scheme and authority, lower-cased) when it is usable, else `null`. */
export function usableUrlOrigin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length < 1 || v.length > PRESENTATION_URL_MAX_BYTES) return null;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x23 /* # */ || c === 0x5c /* \ */)
      return null;
  }
  const lower = v.toLowerCase();
  const scheme = lower.startsWith("https://")
    ? "https"
    : lower.startsWith("http://")
      ? "http"
      : null;
  if (scheme === null) return null;
  const rest = lower.slice(scheme.length + 3);
  const end = rest.search(/[/?]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const host = authorityHost(authority);
  if (host === null) return null;
  // Only the loopback hosts may be plain http.
  if (scheme === "http" && !LOOPBACK_HOSTS.has(host)) return null;
  return `${scheme}://${authority}`;
}

/** Rule 4's `sizes`: the entries, `[]` when absent, or `null` when any entry is bad. */
function sizes(v: unknown): PresentationIconSize[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > PRESENTATION_MAX_ICON_SIZES) return null;
  const out: PresentationIconSize[] = [];
  let last = 0;
  for (const e of v) {
    if (!isRecord(e)) return null;
    const { w, sha256 } = e;
    if (
      typeof w !== "number" ||
      !Number.isInteger(w) ||
      w < 1 ||
      w > PRESENTATION_MAX_ICON_WIDTH ||
      w <= last
    )
      return null;
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
    out.push({ w, sha256 });
    last = w;
  }
  return out;
}

function dimension(v: unknown): number | undefined {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= PRESENTATION_ICON_MAX_DIMENSION
    ? v
    : undefined;
}

/** Rule 4: the icon, or `undefined`. */
function icon(v: unknown): PresentationIcon | undefined {
  if (!isRecord(v)) return undefined;
  const { sha256, contentType, original } = v;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return undefined;
  if (typeof contentType !== "string" || !ICON_TYPES.has(contentType))
    return undefined;
  const origin = usableUrlOrigin(original);
  if (origin === null) return undefined;
  const width = dimension(v.width);
  const height = dimension(v.height);
  const ladder = sizes(v.sizes);
  const url = v.url;
  const templated =
    ladder !== null &&
    ladder.length > 0 &&
    typeof url === "string" &&
    url.length <= PRESENTATION_URL_MAX_BYTES &&
    url.split("{w}").length === 2 &&
    // `{w}` after the authority: the template begins with the original's own origin.
    (url.toLowerCase().startsWith(`${origin}/`) ||
      url.toLowerCase().startsWith(`${origin}?`)) &&
    usableUrlOrigin(url.replace("{w}", "1")) === origin;
  // Members in the contract's order (§5.5), so an emitted member reads as the contract shows it.
  const out: PresentationIcon = {
    sha256,
    contentType: contentType as PresentationIconType,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    original: original as string,
    ...(templated ? { url: url as string } : {}),
    sizes: templated ? ladder : [],
  };
  return out;
}

/**
 * `core.presentation` from a discovery document's `core` block, normalised (see the file comment),
 * or `null` when the member is absent or not an object.
 */
export function parsePresentation(
  core: unknown,
  doc: PresentationDoc,
): ProductPresentation | null {
  if (!isRecord(core)) return null;
  const raw = core.presentation;
  if (!isRecord(raw)) return null;
  const out: ProductPresentation = {
    name: text(raw.name) ?? text(doc.name) ?? doc.product,
  };
  const developerName = text(raw.developerName);
  if (developerName !== undefined) out.developerName = developerName;
  const accent = colour(raw.accent);
  if (accent !== undefined) out.accent = accent;
  const accentDark = colour(raw.accentDark);
  if (accentDark !== undefined) out.accentDark = accentDark;
  const parsedIcon = icon(raw.icon);
  if (parsedIcon !== undefined) out.icon = parsedIcon;
  return out;
}

/**
 * Which bytes to fetch for a hero drawn at `px` points on a `scale` screen, given the content
 * types the platform decodes. `need = ceil(px × scale)` (at least 1):
 *
 *   1. With sizes and WebP decodable: the smallest `w ≥ need`, else the largest `w`.
 *   2. The original instead when it is decodable, its `width` is known and exceeds the largest
 *      `w`, and `need` exceeds the largest `w`.
 *   3. With no usable size: the original, when it is decodable.
 *   4. Otherwise none.
 */
export function pickIconSize(
  icon: PresentationIcon,
  px: number,
  scale: number,
  decodable: Iterable<string>,
): IconPick {
  const types = new Set(decodable);
  const product = Math.ceil(px * scale);
  const need = Number.isFinite(product) && product >= 1 ? product : 1;
  const originalOk = types.has(icon.contentType);
  const original: IconPick = {
    source: "original",
    sha256: icon.sha256,
    url: icon.original,
  };
  if (
    icon.sizes.length > 0 &&
    icon.url !== undefined &&
    types.has("image/webp")
  ) {
    const largest = icon.sizes[icon.sizes.length - 1]!;
    const fit = icon.sizes.find((s) => s.w >= need) ?? largest;
    if (
      originalOk &&
      need > largest.w &&
      icon.width !== undefined &&
      icon.width > largest.w
    )
      return original;
    return {
      source: "size",
      w: fit.w,
      sha256: fit.sha256,
      url: icon.url.replace("{w}", String(fit.w)),
    };
  }
  return originalOk ? original : { source: "none" };
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Whether `bytes` hash to `sha256`: their lower-case hex SHA-256 equals it exactly (an upper-case
 * expectation never matches). Bytes that do not match are neither shown nor cached.
 */
export async function iconMatches(
  bytes: Uint8Array,
  sha256: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return hex(new Uint8Array(digest)) === sha256;
}
