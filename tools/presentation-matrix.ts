// `conformance/corpus/v2/presentation-matrix.json`: product presentation, the client half
// (WIRE-CONTRACT-V4 §5.5, plans/HA-11.md §2.1 and §4, plans/HA-12.md §4).
//
// Discovery's `core.presentation` is unsigned display data. Every SDK parses it field by field,
// picks one icon size for the hero it draws, and shows the bytes only when their SHA-256 matches.
// This file pins the three for all six languages:
//
//   parseCases   `{name, core, doc, expect}`: `parsePresentation(core, doc)` is `expect` (the
//                normalised member, or `null`).
//   pickCases    `{name, icon, px, scale, decodable, expect}`: `pickIconSize(icon, px, scale,
//                decodable)` is `expect` (`{source: "size", w, sha256, url}`, `{source:
//                "original", sha256, url}` or `{source: "none"}`). `icon` is a normalised icon.
//   verifyCases  `{name, bytes, sha256, expect}`: `iconMatches(base64-decoded bytes, sha256)`.
//
// A GENERATOR-LOCAL REFERENCE (plans/HA-12.md Q2). `refParse`, `refPick` and `refMatches` below
// recompute every row, and the build refuses a row they disagree with. They import nothing from
// `@polaris-key/client-core` or `@polaris-key/protocol` and restate the limits locally
// (`presentation-matrix.test.ts` holds them equal to the protocol's): a golden file that shares
// code with the implementation it checks cannot catch a bug in it. client-core is checked against
// this file by its own test (`packages/client-core/test/presentation.test.ts`), like every SDK.
//
// The file is ASCII only (non-ASCII is written escaped) and append-only: a new row keeps
// `presentationMatrixVersion`; a changed row or rule bumps it.

import { createHash } from "node:crypto";

export const PRESENTATION_MATRIX_VERSION = 1;

/** The limits, restated (WIRE-CONTRACT-V4 §5.5). The tools test pins them to the protocol's. */
export const REF_LIMITS = {
  PRESENTATION_TEXT_MAX_BYTES: 1024,
  PRESENTATION_URL_MAX_BYTES: 2048,
  PRESENTATION_MAX_ICON_SIZES: 8,
  PRESENTATION_MAX_ICON_WIDTH: 4096,
  PRESENTATION_ICON_MAX_DIMENSION: 16384,
  PRESENTATION_ICON_TYPES: [
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ],
} as const;

type J = null | boolean | number | string | J[] | { [k: string]: J };
type Obj = { [k: string]: J };

// ── The reference ───────────────────────────────────────────────────────────────────────────

const L = REF_LIMITS;

/** Rule 2. A lone surrogate is `\p{Cs}` under the `u` flag; a well-formed pair is one code point. */
function refText(v: J | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  if (/\p{Cs}/u.test(v)) return undefined;
  const n = Buffer.byteLength(v, "utf8");
  if (n === 0 || n > L.PRESENTATION_TEXT_MAX_BYTES) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return undefined;
  return v;
}

function refColour(v: J | undefined): string | undefined {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)
    ? v.toLowerCase()
    : undefined;
}

const URL_RE = /^(https?):\/\/([^/?]*)(?:[/?][\x21-\x7e]*)?$/i;
/** An authority, lower-cased: the one bracketed host, or DNS characters; then an optional port. */
const AUTHORITY_RE = /^(\[::1\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/;

/** Rule 5: `scheme://authority`, lower-cased, of a usable URL, else `undefined`. */
export function refOrigin(v: J | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  if (!/^[\x21-\x7e]+$/.test(v) || /[#\\]/.test(v)) return undefined;
  if (v.length > L.PRESENTATION_URL_MAX_BYTES) return undefined;
  const m = URL_RE.exec(v);
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!.toLowerCase();
  const a = AUTHORITY_RE.exec(authority);
  if (!a) return undefined;
  const host = a[1]!;
  if (a[2] !== undefined && Number(a[2]) > 65535) return undefined;
  if (host !== "[::1]" && host !== "127.0.0.1") {
    const labels = host.split(".");
    if (!labels.every((l) => /^[a-z0-9-]{1,63}$/.test(l))) return undefined;
    // WHATWG's ends-in-a-number test: no decimal or `0x` hex last label (an IPv4 number).
    if (/^([0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1]!))
      return undefined;
  }
  if (scheme === "http" && !["localhost", "127.0.0.1", "[::1]"].includes(host))
    return undefined;
  return `${scheme}://${authority}`;
}

const isHash = (v: J | undefined): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isObj = (v: J | undefined): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: J | undefined, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function refIcon(v: J | undefined): Obj | undefined {
  if (!isObj(v)) return undefined;
  if (!isHash(v.sha256)) return undefined;
  if (
    typeof v.contentType !== "string" ||
    !(L.PRESENTATION_ICON_TYPES as readonly string[]).includes(v.contentType)
  )
    return undefined;
  const origin = refOrigin(v.original);
  if (origin === undefined) return undefined;
  const out: Obj = { sha256: v.sha256, contentType: v.contentType };
  if (intIn(v.width, 1, L.PRESENTATION_ICON_MAX_DIMENSION)) out.width = v.width;
  if (intIn(v.height, 1, L.PRESENTATION_ICON_MAX_DIMENSION))
    out.height = v.height;
  out.original = v.original as string;
  const raw = v.sizes === undefined ? [] : v.sizes;
  const sizesOk =
    Array.isArray(raw) &&
    raw.length <= L.PRESENTATION_MAX_ICON_SIZES &&
    raw.every(
      (e, i) =>
        isObj(e) &&
        intIn(e.w, 1, L.PRESENTATION_MAX_ICON_WIDTH) &&
        isHash(e.sha256) &&
        (i === 0 || (e.w as number) > ((raw[i - 1] as Obj).w as number)),
    );
  const tpl = v.url;
  // `{w}` sits after the authority: the template begins with the original's own origin, so no
  // width can change the host or the port.
  const tplOk =
    typeof tpl === "string" &&
    tpl.length <= L.PRESENTATION_URL_MAX_BYTES &&
    (tpl.match(/\{w\}/g) ?? []).length === 1 &&
    [`${origin}/`, `${origin}?`].some((p) => tpl.toLowerCase().startsWith(p)) &&
    refOrigin(tpl.replace("{w}", "1")) === origin;
  if (sizesOk && (raw as J[]).length > 0 && tplOk) {
    out.url = tpl;
    out.sizes = (raw as Obj[]).map((e) => ({ w: e.w!, sha256: e.sha256! }));
  } else out.sizes = [];
  return out;
}

export function refParse(core: J, doc: Obj): Obj | null {
  if (!isObj(core) || !isObj(core.presentation)) return null;
  const p = core.presentation;
  const out: Obj = {
    name: refText(p.name) ?? refText(doc.name) ?? (doc.product as string),
  };
  const dev = refText(p.developerName);
  if (dev !== undefined) out.developerName = dev;
  const accent = refColour(p.accent);
  if (accent !== undefined) out.accent = accent;
  const accentDark = refColour(p.accentDark);
  if (accentDark !== undefined) out.accentDark = accentDark;
  const icon = refIcon(p.icon);
  if (icon !== undefined) out.icon = icon;
  return out;
}

export function refPick(
  icon: Obj,
  px: number,
  scale: number,
  decodable: readonly string[],
): Obj {
  const need = Math.max(1, Math.ceil(px * scale));
  const sizes = icon.sizes as { w: number; sha256: string }[];
  const canOriginal = decodable.includes(icon.contentType as string);
  const original = {
    source: "original",
    sha256: icon.sha256!,
    url: icon.original!,
  };
  if (sizes.length === 0 || !decodable.includes("image/webp"))
    return canOriginal ? original : { source: "none" };
  const top = sizes[sizes.length - 1]!;
  if (
    canOriginal &&
    need > top.w &&
    typeof icon.width === "number" &&
    icon.width > top.w
  )
    return original;
  const chosen = sizes.find((s) => s.w >= need) ?? top;
  return {
    source: "size",
    w: chosen.w,
    sha256: chosen.sha256,
    url: (icon.url as string).split("{w}").join(String(chosen.w)),
  };
}

export function refMatches(bytesB64: string, sha256: string): boolean {
  return (
    createHash("sha256")
      .update(Buffer.from(bytesB64, "base64"))
      .digest("hex") === sha256
  );
}

// ── The rows ────────────────────────────────────────────────────────────────────────────────

/** A fixed lower-case hex hash, labelled for a reader. */
const h = (label: string): string =>
  createHash("sha256").update(`presentation-matrix:${label}`).digest("hex");

const ORIGIN = "https://img.plrs.im";
const SHA = h("icon");
const ORIGINAL = `${ORIGIN}/djdl/a/${SHA}`;
const TEMPLATE = `${ORIGINAL}/{w}.webp`;
const LADDER = [64, 128, 256, 512, 1024].map((w) => ({
  w,
  sha256: h(`icon/${w}`),
}));
const DOC = { name: "DJDL Downloader", product: "djdl" };

/** A full, valid icon (`ICON`), as served and as normalised. */
const ICON: Obj = {
  sha256: SHA,
  contentType: "image/png",
  width: 1024,
  height: 1024,
  original: ORIGINAL,
  url: TEMPLATE,
  sizes: LADDER,
};
/** The icon with no ladder: the original alone. */
const BARE: Obj = {
  sha256: SHA,
  contentType: "image/png",
  width: 1024,
  height: 1024,
  original: ORIGINAL,
  sizes: [],
};

const with_ = (o: Obj, patch: Obj): Obj => ({ ...o, ...patch });
const without = (o: Obj, ...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const member = (presentation: J): Obj => ({ presentation });
/** A row whose member is only `{name: "DJDL"}` plus `p`. */
const named = (p: Obj): Obj => member({ name: "DJDL", ...p });

interface ParseCase {
  name: string;
  core: J;
  doc: Obj;
  expect: Obj | null;
}

const P = (
  name: string,
  core: J,
  expect: Obj | null,
  doc: Obj = DOC,
): ParseCase => ({ name, core, doc, expect });

/** An icon row: the member is `{name, icon}`; `expect` is the icon kept, or `undefined`. */
const I = (name: string, icon: J, expect: Obj | undefined): ParseCase =>
  P(
    name,
    named({ icon }),
    expect === undefined ? { name: "DJDL" } : { name: "DJDL", icon: expect },
  );

const PARSE_CASES: ParseCase[] = [
  // ── the member ──
  P(
    "full",
    member({
      name: "DJDL",
      developerName: "Vlad Zaharia",
      accent: "#2ED6E6",
      accentDark: "#5ee6f0",
      icon: ICON,
    }),
    {
      name: "DJDL",
      developerName: "Vlad Zaharia",
      accent: "#2ed6e6",
      accentDark: "#5ee6f0",
      icon: ICON,
    },
  ),
  P("absent", { registration: "open" }, null),
  P("core-null", null, null),
  P("core-string", "core", null),
  P("core-array", [member({ name: "DJDL" })], null),
  P("presentation-null", member(null), null),
  P("presentation-string", member("DJDL"), null),
  P("presentation-array", member([{ name: "DJDL" }]), null),
  P("presentation-empty-object", member({}), { name: "DJDL Downloader" }),
  P(
    "future-member-extra-keys-ignored",
    member({
      name: "DJDL",
      accent: "#2ed6e6",
      tagline: "from the future",
      icon: {
        ...ICON,
        blurhash: "LEHV6nWB2yk8",
        sizes: LADDER.map((s) => ({ ...s, format: "image/webp" })),
      },
    }),
    { name: "DJDL", accent: "#2ed6e6", icon: ICON },
  ),

  // ── rule 2: name and developerName ──
  P("name-absent-falls-back-to-doc-name", member({ accent: "#000000" }), {
    name: "DJDL Downloader",
    accent: "#000000",
  }),
  P(
    "name-absent-doc-name-absent-falls-back-to-slug",
    member({ accent: "#000000" }),
    { name: "djdl", accent: "#000000" },
    { product: "djdl" },
  ),
  P(
    "name-invalid-doc-name-invalid-falls-back-to-slug",
    member({ name: "", accent: "#000000" }),
    { name: "djdl", accent: "#000000" },
    { name: "DJDL\u0001", product: "djdl" },
  ),
  P("name-not-a-string", member({ name: 42 }), { name: "DJDL Downloader" }),
  P("name-empty", member({ name: "" }), { name: "DJDL Downloader" }),
  P("name-c0-control", member({ name: "DJ\u0007DL" }), {
    name: "DJDL Downloader",
  }),
  P("name-tab-is-a-control", member({ name: "DJ\tDL" }), {
    name: "DJDL Downloader",
  }),
  P("name-del", member({ name: "DJDL\u007f" }), { name: "DJDL Downloader" }),
  P("name-c1-control", member({ name: "DJDL\u0085" }), {
    name: "DJDL Downloader",
  }),
  P("name-u00a0-is-not-a-control", member({ name: "DJ\u00a0DL" }), {
    name: "DJ\u00a0DL",
  }),
  P("name-1024-bytes-ascii", member({ name: "a".repeat(1024) }), {
    name: "a".repeat(1024),
  }),
  P("name-1025-bytes-ascii", member({ name: "a".repeat(1025) }), {
    name: "DJDL Downloader",
  }),
  P("name-1024-bytes-two-byte-chars", member({ name: "\u00e9".repeat(512) }), {
    name: "\u00e9".repeat(512),
  }),
  P("name-1026-bytes-two-byte-chars", member({ name: "\u00e9".repeat(513) }), {
    name: "DJDL Downloader",
  }),
  P("name-1024-bytes-astral-chars", member({ name: "\u{1f3ae}".repeat(256) }), {
    name: "\u{1f3ae}".repeat(256),
  }),
  P("name-1028-bytes-astral-chars", member({ name: "\u{1f3ae}".repeat(257) }), {
    name: "DJDL Downloader",
  }),
  P(
    "developer-rtl-with-bidi-marks-kept",
    named({ developerName: "\u200f\u05d3\u05d5\u05d3 \u200eDJDL" }),
    { name: "DJDL", developerName: "\u200f\u05d3\u05d5\u05d3 \u200eDJDL" },
  ),
  P(
    "developer-bidi-override-kept",
    named({ developerName: "Vlad\u202e Zaharia\u202c" }),
    { name: "DJDL", developerName: "Vlad\u202e Zaharia\u202c" },
  ),
  P(
    "developer-zero-width-kept",
    named({ developerName: "Vlad\u200bZaharia" }),
    { name: "DJDL", developerName: "Vlad\u200bZaharia" },
  ),
  P("developer-newline-dropped", named({ developerName: "Vlad\nZaharia" }), {
    name: "DJDL",
  }),
  P("developer-not-a-string", named({ developerName: ["Vlad"] }), {
    name: "DJDL",
  }),
  P("developer-empty", named({ developerName: "" }), { name: "DJDL" }),
  P("developer-1025-bytes", named({ developerName: "d".repeat(1025) }), {
    name: "DJDL",
  }),

  // ── rule 3: colours ──
  P("accent-upper-case-lowered", named({ accent: "#ABCDEF" }), {
    name: "DJDL",
    accent: "#abcdef",
  }),
  P("accent-dark-alone", named({ accentDark: "#5EE6F0" }), {
    name: "DJDL",
    accentDark: "#5ee6f0",
  }),
  P("accent-three-digit-dropped", named({ accent: "#abc" }), { name: "DJDL" }),
  P("accent-no-hash-dropped", named({ accent: "2ed6e6" }), { name: "DJDL" }),
  P("accent-eight-digit-dropped", named({ accent: "#2ed6e6ff" }), {
    name: "DJDL",
  }),
  P("accent-not-hex-dropped", named({ accent: "#2ed6eg" }), { name: "DJDL" }),
  P("accent-trailing-space-dropped", named({ accent: "#2ed6e6 " }), {
    name: "DJDL",
  }),
  P("accent-named-colour-dropped", named({ accent: "teal" }), {
    name: "DJDL",
  }),
  P("accent-not-a-string", named({ accent: 0x2ed6e6 }), { name: "DJDL" }),
  P(
    "accent-bad-accent-dark-good",
    named({ accent: "rgb(0,0,0)", accentDark: "#000000" }),
    { name: "DJDL", accentDark: "#000000" },
  ),

  // ── rule 4: the icon ──
  I("icon-not-an-object", ORIGINAL, undefined),
  I("icon-null", null, undefined),
  I(
    "icon-sha256-upper-case",
    with_(ICON, { sha256: SHA.toUpperCase() }),
    undefined,
  ),
  I("icon-sha256-short", with_(ICON, { sha256: SHA.slice(1) }), undefined),
  I("icon-sha256-absent", without(ICON, "sha256"), undefined),
  I("icon-type-svg", with_(ICON, { contentType: "image/svg+xml" }), undefined),
  I(
    "icon-type-upper-case",
    with_(ICON, { contentType: "image/PNG" }),
    undefined,
  ),
  I("icon-type-absent", without(ICON, "contentType"), undefined),
  I("icon-original-absent", without(ICON, "original"), undefined),
  ...L.PRESENTATION_ICON_TYPES.map((t) =>
    I(
      `icon-type-${t.slice(6)}`,
      with_(ICON, { contentType: t }),
      with_(ICON, { contentType: t }),
    ),
  ),
  I(
    "icon-width-height-absent",
    without(ICON, "width", "height"),
    without(ICON, "width", "height"),
  ),
  I("icon-width-zero", with_(ICON, { width: 0 }), without(ICON, "width")),
  I(
    "icon-width-max",
    with_(ICON, { width: 16384 }),
    with_(ICON, { width: 16384 }),
  ),
  I(
    "icon-width-over-max",
    with_(ICON, { width: 16385 }),
    without(ICON, "width"),
  ),
  I(
    "icon-height-fractional",
    with_(ICON, { height: 1023.5 }),
    without(ICON, "height"),
  ),
  I(
    "icon-height-a-string",
    with_(ICON, { height: "1024" }),
    without(ICON, "height"),
  ),
  I("icon-sizes-absent", without(ICON, "sizes"), BARE),
  I("icon-sizes-empty", with_(ICON, { sizes: [] }), BARE),
  I("icon-bare", BARE, BARE),
  I(
    "icon-sizes-eight",
    with_(ICON, {
      sizes: [1, 2, 3, 4, 5, 6, 7, 8].map((w) => ({
        w: w * 64,
        sha256: h(`eight/${w}`),
      })),
    }),
    with_(ICON, {
      sizes: [1, 2, 3, 4, 5, 6, 7, 8].map((w) => ({
        w: w * 64,
        sha256: h(`eight/${w}`),
      })),
    }),
  ),
  I(
    "icon-sizes-nine",
    with_(ICON, {
      sizes: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((w) => ({
        w: w * 64,
        sha256: h(`nine/${w}`),
      })),
    }),
    BARE,
  ),
  I(
    "icon-sizes-descending",
    with_(ICON, { sizes: [...LADDER].reverse() }),
    BARE,
  ),
  I(
    "icon-sizes-duplicate-width",
    with_(ICON, { sizes: [LADDER[0]!, { w: 64, sha256: h("dup") }] }),
    BARE,
  ),
  I(
    "icon-sizes-width-zero",
    with_(ICON, { sizes: [{ w: 0, sha256: h("z") }] }),
    BARE,
  ),
  I(
    "icon-sizes-width-max",
    with_(ICON, { sizes: [{ w: 4096, sha256: h("max") }] }),
    with_(ICON, { sizes: [{ w: 4096, sha256: h("max") }] }),
  ),
  I(
    "icon-sizes-width-over-max",
    with_(ICON, { sizes: [{ w: 4097, sha256: h("over") }] }),
    BARE,
  ),
  I(
    "icon-sizes-width-fractional",
    with_(ICON, { sizes: [{ w: 64.5, sha256: h("f") }] }),
    BARE,
  ),
  I(
    "icon-sizes-one-bad-hash-drops-all",
    with_(ICON, {
      sizes: [LADDER[0]!, { w: 128, sha256: h("u").toUpperCase() }],
    }),
    BARE,
  ),
  I("icon-sizes-entry-not-an-object", with_(ICON, { sizes: [64] }), BARE),
  I(
    "icon-sizes-not-an-array",
    with_(ICON, { sizes: { w: 64, sha256: h("o") } }),
    BARE,
  ),
  I("icon-url-absent", without(ICON, "url"), BARE),
  I("icon-url-without-w", with_(ICON, { url: `${ORIGINAL}/64.webp` }), BARE),
  I("icon-url-two-w", with_(ICON, { url: `${ORIGINAL}/{w}/{w}.webp` }), BARE),
  I(
    "icon-url-other-origin",
    with_(ICON, { url: `https://cdn.example.com/djdl/a/${SHA}/{w}.webp` }),
    BARE,
  ),
  I(
    "icon-url-other-scheme",
    with_(ICON, { url: `http://img.plrs.im/djdl/a/${SHA}/{w}.webp` }),
    BARE,
  ),
  I("icon-url-fragment", with_(ICON, { url: `${TEMPLATE}#x` }), BARE),
  I(
    "icon-url-w-glued-to-host",
    with_(ICON, { url: `https://img.plrs.im{w}/djdl/a/${SHA}.webp` }),
    BARE,
  ),
  // `{w}` filled with a width could match the original's origin here, so the template must begin
  // with that origin before any `{w}`.
  I(
    "icon-url-w-in-port",
    with_(ICON, {
      original: `https://img.plrs.im:1/djdl/a/${SHA}`,
      url: `https://img.plrs.im:{w}/djdl/a/${SHA}.webp`,
    }),
    with_(BARE, { original: `https://img.plrs.im:1/djdl/a/${SHA}` }),
  ),
  I(
    "icon-url-w-in-host",
    with_(ICON, {
      original: `https://1.plrs.im/djdl/a/${SHA}`,
      url: `https://{w}.plrs.im/djdl/a/${SHA}.webp`,
    }),
    with_(BARE, { original: `https://1.plrs.im/djdl/a/${SHA}` }),
  ),

  // ── rule 5: usable URLs ──
  I(
    "original-http-not-loopback",
    with_(BARE, { original: `http://img.plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-http-localhost-with-port",
    with_(ICON, {
      original: `http://localhost:8787/djdl/a/${SHA}`,
      url: `http://localhost:8787/djdl/a/${SHA}/{w}.webp`,
    }),
    with_(ICON, {
      original: `http://localhost:8787/djdl/a/${SHA}`,
      url: `http://localhost:8787/djdl/a/${SHA}/{w}.webp`,
    }),
  ),
  I(
    "original-http-127-0-0-1",
    with_(BARE, { original: `http://127.0.0.1/djdl/a/${SHA}` }),
    with_(BARE, { original: `http://127.0.0.1/djdl/a/${SHA}` }),
  ),
  I(
    "original-http-ipv6-loopback",
    with_(BARE, { original: `http://[::1]:8787/djdl/a/${SHA}` }),
    with_(BARE, { original: `http://[::1]:8787/djdl/a/${SHA}` }),
  ),
  I(
    "original-http-localhost-lookalike",
    with_(BARE, { original: `http://localhost.example.com/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-staging-host",
    with_(ICON, {
      original: `https://img-staging.plrs.im/djdl/a/${SHA}`,
      url: `https://img-staging.plrs.im/djdl/a/${SHA}/{w}.webp`,
    }),
    with_(ICON, {
      original: `https://img-staging.plrs.im/djdl/a/${SHA}`,
      url: `https://img-staging.plrs.im/djdl/a/${SHA}/{w}.webp`,
    }),
  ),
  I(
    "original-scheme-and-host-case-insensitive",
    with_(ICON, { original: `HTTPS://IMG.PLRS.IM/djdl/a/${SHA}` }),
    with_(ICON, { original: `HTTPS://IMG.PLRS.IM/djdl/a/${SHA}` }),
  ),
  I(
    "original-userinfo",
    with_(BARE, { original: `https://u@img.plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-empty-userinfo",
    with_(BARE, { original: `https://@img.plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-fragment",
    with_(BARE, { original: `${ORIGINAL}#icon` }),
    undefined,
  ),
  I(
    "original-empty-fragment",
    with_(BARE, { original: `${ORIGINAL}#` }),
    undefined,
  ),
  I(
    "original-relative",
    with_(BARE, { original: `/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-scheme-relative",
    with_(BARE, { original: `//img.plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-ftp",
    with_(BARE, { original: `ftp://img.plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-space",
    with_(BARE, { original: `https://img.plrs.im/djdl/a/ ${SHA}` }),
    undefined,
  ),
  I(
    "original-leading-space",
    with_(BARE, { original: ` ${ORIGINAL}` }),
    undefined,
  ),
  I(
    "original-non-ascii",
    with_(BARE, { original: `https://img.plrs.im/d\u00e9/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-backslash",
    with_(BARE, { original: `https://img.plrs.im\\djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-no-authority",
    with_(BARE, { original: `https:///djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-query-only",
    with_(BARE, { original: `https://img.plrs.im?a=${SHA}` }),
    with_(BARE, { original: `https://img.plrs.im?a=${SHA}` }),
  ),
  I(
    "original-2048-bytes",
    with_(BARE, {
      original: `${ORIGINAL}?${"q".repeat(2048 - ORIGINAL.length - 1)}`,
    }),
    with_(BARE, {
      original: `${ORIGINAL}?${"q".repeat(2048 - ORIGINAL.length - 1)}`,
    }),
  ),
  I(
    "original-2049-bytes",
    with_(BARE, {
      original: `${ORIGINAL}?${"q".repeat(2048 - ORIGINAL.length)}`,
    }),
    undefined,
  ),
  I("original-not-a-string", with_(BARE, { original: 7 }), undefined),
  // The authority: a port of 1-5 digits up to 65535, the one bracketed host `[::1]` with nothing
  // but a port after it, and otherwise DNS labels of [a-z0-9-] whose last is neither all digits
  // nor `0x` and hex digits.
  I(
    "original-port-65535",
    with_(BARE, { original: `https://img.plrs.im:65535/djdl/a/${SHA}` }),
    with_(BARE, { original: `https://img.plrs.im:65535/djdl/a/${SHA}` }),
  ),
  I(
    "original-port-over-65535",
    with_(BARE, { original: `https://img.plrs.im:99999/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-port-six-digits",
    with_(BARE, { original: `https://img.plrs.im:000443/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-port-not-digits",
    with_(BARE, { original: `https://img.plrs.im:abc/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-port-empty",
    with_(BARE, { original: `https://img.plrs.im:/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-two-ports",
    with_(BARE, { original: `https://img.plrs.im:1:2/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-ipv6-not-loopback",
    with_(BARE, { original: `https://[evil]/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-ipv6-other-address",
    with_(BARE, { original: `https://[::2]/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-ipv6-host-after-bracket",
    with_(BARE, { original: `http://[::1]evil.com/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-ipv6-unclosed",
    with_(BARE, { original: `http://[::1/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-https-ipv6-loopback-with-port",
    with_(BARE, { original: `https://[::1]:8443/djdl/a/${SHA}` }),
    with_(BARE, { original: `https://[::1]:8443/djdl/a/${SHA}` }),
  ),
  I(
    "original-percent-in-host",
    with_(BARE, { original: `https://img%40plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-underscore-in-host",
    with_(BARE, { original: `https://img_plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-empty-label",
    with_(BARE, { original: `https://img..plrs.im/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-trailing-dot",
    with_(BARE, { original: `https://img.plrs.im./djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-label-64-chars",
    with_(BARE, {
      original: `https://${"a".repeat(64)}.plrs.im/djdl/a/${SHA}`,
    }),
    undefined,
  ),
  I(
    "original-label-63-chars",
    with_(BARE, {
      original: `https://${"a".repeat(63)}.plrs.im/djdl/a/${SHA}`,
    }),
    with_(BARE, {
      original: `https://${"a".repeat(63)}.plrs.im/djdl/a/${SHA}`,
    }),
  ),
  I(
    "original-numeric-host",
    with_(BARE, { original: `https://999.1.1.1/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-hex-ipv4",
    with_(BARE, { original: `https://0x7f000001/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-hex-last-label",
    with_(BARE, { original: `https://a.0x7f/djdl/a/${SHA}` }),
    undefined,
  ),
  I(
    "original-https-127-0-0-1",
    with_(BARE, { original: `https://127.0.0.1/djdl/a/${SHA}` }),
    with_(BARE, { original: `https://127.0.0.1/djdl/a/${SHA}` }),
  ),

  // ── the fallbacks together ──
  P(
    "only-name-survives",
    member({
      name: "DJDL",
      developerName: "\u0001",
      accent: "#12345",
      accentDark: "blue",
      icon: with_(ICON, { contentType: "text/html" }),
    }),
    { name: "DJDL" },
  ),
];

interface PickCase {
  name: string;
  icon: Obj;
  px: number;
  scale: number;
  decodable: string[];
  expect: Obj;
}

const ALL = [...L.PRESENTATION_ICON_TYPES];
/** HA-14's Godot set: no AVIF, no GIF. */
const GODOT = ["image/jpeg", "image/png", "image/webp"];

const sizePick = (icon: Obj, w: number): Obj => {
  const s = (icon.sizes as { w: number; sha256: string }[]).find(
    (e) => e.w === w,
  )!;
  return {
    source: "size",
    w,
    sha256: s.sha256,
    url: (icon.url as string).replace("{w}", String(w)),
  };
};
const ORIGINAL_PICK = { source: "original", sha256: SHA, url: ORIGINAL };
const NONE = { source: "none" };
const SMALL = with_(ICON, { sizes: LADDER.slice(0, 3) });

const PICK_CASES: PickCase[] = [
  // Hero sizes from 32 to 120 px at scales 1, 2 and 3, on the full ladder.
  ...[32, 48, 64, 96, 120].flatMap((px) =>
    [1, 2, 3].map((scale) => {
      const need = px * scale;
      const w = LADDER.find((s) => s.w >= need)!.w;
      return {
        name: `ladder-${px}px-at-${scale}x`,
        icon: ICON,
        px,
        scale,
        decodable: ALL,
        expect: sizePick(ICON, w),
      };
    }),
  ),
  {
    name: "fractional-scale-exact",
    icon: ICON,
    px: 40,
    scale: 1.5,
    decodable: ALL,
    expect: sizePick(ICON, 64),
  },
  {
    name: "fractional-scale-rounds-up",
    icon: ICON,
    px: 43,
    scale: 1.5,
    decodable: ALL,
    expect: sizePick(ICON, 128),
  },
  {
    name: "android-xxhdpi-scale",
    icon: ICON,
    px: 48,
    scale: 2.625,
    decodable: ALL,
    expect: sizePick(ICON, 128),
  },
  {
    name: "need-equals-a-width",
    icon: ICON,
    px: 128,
    scale: 1,
    decodable: ALL,
    expect: sizePick(ICON, 128),
  },
  {
    name: "need-one-over-a-width",
    icon: ICON,
    px: 129,
    scale: 1,
    decodable: ALL,
    expect: sizePick(ICON, 256),
  },
  {
    name: "original-wins-above-the-ladder",
    icon: SMALL,
    px: 120,
    scale: 3,
    decodable: ALL,
    expect: ORIGINAL_PICK,
  },
  {
    name: "largest-size-when-original-width-unknown",
    icon: without(SMALL, "width", "height"),
    px: 120,
    scale: 3,
    decodable: ALL,
    expect: sizePick(SMALL, 256),
  },
  {
    name: "largest-size-when-original-no-wider",
    icon: with_(SMALL, { width: 256, height: 256 }),
    px: 120,
    scale: 3,
    decodable: ALL,
    expect: sizePick(SMALL, 256),
  },
  {
    name: "largest-size-when-original-not-decodable",
    icon: with_(SMALL, { contentType: "image/avif" }),
    px: 120,
    scale: 3,
    decodable: GODOT,
    expect: sizePick(SMALL, 256),
  },
  {
    name: "largest-size-above-the-full-ladder",
    icon: ICON,
    px: 512,
    scale: 3,
    decodable: ALL,
    expect: sizePick(ICON, 1024),
  },
  {
    name: "no-sizes-takes-the-original",
    icon: BARE,
    px: 64,
    scale: 2,
    decodable: ALL,
    expect: ORIGINAL_PICK,
  },
  {
    name: "no-sizes-avif-original-on-godot",
    icon: with_(BARE, { contentType: "image/avif" }),
    px: 64,
    scale: 2,
    decodable: GODOT,
    expect: NONE,
  },
  {
    name: "no-sizes-gif-original-on-godot",
    icon: with_(BARE, { contentType: "image/gif" }),
    px: 64,
    scale: 2,
    decodable: GODOT,
    expect: NONE,
  },
  {
    name: "gif-original-sizes-on-godot",
    icon: with_(ICON, { contentType: "image/gif" }),
    px: 64,
    scale: 2,
    decodable: GODOT,
    expect: sizePick(ICON, 128),
  },
  {
    name: "webp-not-decodable-takes-png-original",
    icon: ICON,
    px: 32,
    scale: 1,
    decodable: ["image/png"],
    expect: ORIGINAL_PICK,
  },
  {
    name: "webp-not-decodable-gif-original-none",
    icon: with_(ICON, { contentType: "image/gif" }),
    px: 32,
    scale: 1,
    decodable: ["image/png"],
    expect: NONE,
  },
  {
    name: "nothing-decodable",
    icon: ICON,
    px: 32,
    scale: 1,
    decodable: [],
    expect: NONE,
  },
];

interface VerifyCase {
  name: string;
  bytes: string;
  sha256: string;
  expect: boolean;
}

const b64 = (bytes: Uint8Array | string): string =>
  Buffer.from(bytes).toString("base64");
const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const VERIFY_CASES: VerifyCase[] = [
  { name: "empty-matches", bytes: "", sha256: sha(""), expect: true },
  {
    name: "ascii-matches",
    bytes: b64("polaris"),
    sha256: sha("polaris"),
    expect: true,
  },
  {
    name: "binary-matches",
    bytes: b64(PNG_HEAD),
    sha256: sha(PNG_HEAD),
    expect: true,
  },
  {
    name: "upper-case-hash-never-matches",
    bytes: b64("polaris"),
    sha256: sha("polaris").toUpperCase(),
    expect: false,
  },
  {
    name: "other-bytes-do-not-match",
    bytes: b64("polaris!"),
    sha256: sha("polaris"),
    expect: false,
  },
  {
    name: "truncated-bytes-do-not-match",
    bytes: b64(PNG_HEAD.slice(0, 8)),
    sha256: sha(PNG_HEAD),
    expect: false,
  },
];

// ── The build and its self-check ─────────────────────────────────────────────────────────────

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );

function unique(kind: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n))
      throw new Error(`presentation-matrix ${kind}: duplicate ${n}`);
    seen.add(n);
  }
}

/** The file's object, after every row has been recomputed by the reference. */
export function buildPresentationMatrix(): Obj {
  // No row holds U+0000 anywhere: a Godot String cannot (it reads U+FFFD, WIRE-CONTRACT-V4 §10),
  // so a row with one could never pass there. `JSON.stringify` writes it as `\u0000`.
  for (const [kind, rows] of [
    ["parseCases", PARSE_CASES],
    ["pickCases", PICK_CASES],
    ["verifyCases", VERIFY_CASES],
  ] as const)
    for (const row of rows as readonly { name: string }[])
      if (JSON.stringify(row).includes("\\u0000"))
        throw new Error(
          `presentation-matrix ${kind} ${row.name}: holds U+0000`,
        );
  unique(
    "parseCases",
    PARSE_CASES.map((c) => c.name),
  );
  unique(
    "pickCases",
    PICK_CASES.map((c) => c.name),
  );
  unique(
    "verifyCases",
    VERIFY_CASES.map((c) => c.name),
  );
  for (const c of PARSE_CASES) {
    const got = refParse(c.core, c.doc);
    if (canon(got) !== canon(c.expect))
      throw new Error(
        `presentation-matrix parse ${c.name}: reference gives ${canon(got)}, row says ${canon(c.expect)}`,
      );
    // The normalised member is its own fixed point: the Worker emits it, every SDK re-parses it.
    if (
      c.expect !== null &&
      canon(refParse(member(c.expect), c.doc)) !== canon(c.expect)
    )
      throw new Error(
        `presentation-matrix parse ${c.name}: expect is not a fixed point`,
      );
  }
  for (const c of PICK_CASES) {
    if (
      canon(refParse(named({ icon: c.icon }), DOC)) !==
      canon({ name: "DJDL", icon: c.icon })
    )
      throw new Error(
        `presentation-matrix pick ${c.name}: icon is not normalised`,
      );
    const got = refPick(c.icon, c.px, c.scale, c.decodable);
    if (canon(got) !== canon(c.expect))
      throw new Error(
        `presentation-matrix pick ${c.name}: reference gives ${canon(got)}, row says ${canon(c.expect)}`,
      );
  }
  for (const c of VERIFY_CASES)
    if (refMatches(c.bytes, c.sha256) !== c.expect)
      throw new Error(
        `presentation-matrix verify ${c.name}: reference disagrees`,
      );
  return {
    presentationMatrixVersion: PRESENTATION_MATRIX_VERSION,
    description:
      "Product presentation, the client half (WIRE-CONTRACT-V4 section 5.5, plans/HA-11.md section 2.1, plans/HA-12.md). Discovery's unsigned `core.presentation` member, parsed field by field: a malformed field is dropped and never refuses discovery. parseCases: `parsePresentation(core, doc)` must equal `expect` (the normalised member, or null). (1) `core` or its `presentation` not an object: null. (2) `name`, `developerName`: a string of 1 to 1024 UTF-8 bytes (PRESENTATION_TEXT_MAX_BYTES) with no U+0000-001F, U+007F-009F or lone surrogate; bidi and zero-width characters are kept. A bad `developerName` is dropped; a bad `name` falls back to `doc.name` (same rule), then `doc.product`. (3) `accent`, `accentDark`: ^#[0-9A-Fa-f]{6}$, lower-cased, else dropped. (4) `icon`: dropped unless `sha256` is ^[0-9a-f]{64}$, `contentType` is one of PRESENTATION_ICON_TYPES and `original` is usable; `width`, `height`: integers 1-16384, else dropped; `sizes` (absent reads []): at most 8 {w, sha256}, each w an integer 1-4096 strictly ascending, sha256 as above, else sizes [] and no url; `url`: at most 2048 bytes with exactly one `{w}`, beginning (ASCII case-insensitively) with the original's origin followed by `/` or `?`, so `{w}` sits after the authority, and usable with `{w}` filled by 1, else no url and sizes []; no sizes means no url. (5) A usable URL: 1-2048 characters in U+0021-007E with no `#` or backslash, beginning https:// or http:// (ASCII case-insensitive); its authority (to the first `/`, `?` or the end), lower-cased, is a host then an optional `:port` of 1-5 digits at most 65535; the host is `[::1]`, `127.0.0.1`, or dot-separated labels of 1-63 characters in [a-z0-9-] whose last label is neither all digits nor ^0x[0-9a-f]*$ (WHATWG's ends-in-a-number test; so no `@`, `%`, `_`, empty label or other IP literal); http only for the hosts localhost, 127.0.0.1 and [::1]. An origin is scheme://authority, lower-cased. No row holds U+0000 (a Godot String cannot); lone surrogates are not carried either (JSON decoders differ on them), and each SDK pins that rule in its own tests. Unknown members are ignored at every level. pickCases: `pickIconSize(icon, px, scale, decodable)` with need = max(1, ceil(px * scale)): with sizes and image/webp decodable, the smallest w >= need, else the largest w, unless the original is decodable, its width is known and wider than the largest w, and need exceeds the largest w (then the original); with no usable size, the original if decodable; else none. A size's url is `url` with `{w}` replaced. verifyCases: `iconMatches(bytes, sha256)` is true iff the lower-case hex SHA-256 of the base64-decoded bytes equals `sha256` exactly. Every runner compares with deep equality (member order is not significant). Non-ASCII is written escaped. Append-only: a new row keeps presentationMatrixVersion; a changed row or rule bumps it.",
    parseCases: PARSE_CASES as unknown as J,
    pickCases: PICK_CASES as unknown as J,
    verifyCases: VERIFY_CASES as unknown as J,
  };
}
