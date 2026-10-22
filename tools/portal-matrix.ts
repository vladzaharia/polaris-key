// `conformance/corpus/v2/portal-matrix.json`: the product page link, the client half
// (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md §4).
//
// Discovery's `core.portal` is unsigned display data. A terminal kit parses it as a whole, and
// resolves the one link it draws from: the response's own link, then the member, then (against
// an older Worker that sends none) the legacy guess. This file pins both for the two SDKs that
// build a customer link:
//
//   parseCases  `{name, core, expect}`: `parsePortal(core)` is `expect` (`null` for unknown,
//               `{enabled:false}`, or `{enabled:true, activate: <link> | null}`).
//   linkCases   `{name, served, portal, baseUrl, product, expect}`: `portalLink(...)` is `expect`
//               (a link, or `null`: no link, the kit draws "Contact {developer}"). `portal` is a
//               normalised `parsePortal` result.
//
// A GENERATOR-LOCAL REFERENCE. `refParse` and `refLink` below recompute every row, and the build
// refuses a row they disagree with. They import nothing from `@polaris-key/client-core` or
// `@polaris-key/protocol` and restate the limits locally (`portal-matrix.test.ts` holds them equal
// to the protocol's): a golden file that shares code with the implementation it checks cannot
// catch a bug in it. client-core is checked against this file by its own test, like every SDK.
//
// The file is ASCII only and append-only: a new row keeps `portalMatrixVersion`; a changed row or
// rule bumps it.

export const PORTAL_MATRIX_VERSION = 1;

/** The limits, restated (WIRE-CONTRACT-V4 §5.3, §5.7). The tools test pins them to the protocol's. */
export const REF_LIMITS = {
  MANAGE_URL_MAX_LENGTH: 2048,
  ISSUER: "key.plrs.im",
  CUSTOMER_ORIGIN_DEFAULT: "https://polaris.locker",
} as const;

type J = null | boolean | number | string | J[] | { [k: string]: J };
type Obj = { [k: string]: J };
type Parsed =
  | null
  | { enabled: false }
  | { enabled: true; activate: string | null };

const L = REF_LIMITS;

// ── The reference ───────────────────────────────────────────────────────────────────────────

/** §5.3 rule 4: is `v` a link a client may show? */
export function refLinkOk(v: J | undefined): v is string {
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    v.length > L.MANAGE_URL_MAX_LENGTH
  )
    return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return false;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(v);
  if (!m) return false;
  const authority = v.slice(m[0].length).split(/[/?#]/, 1)[0]!;
  if (authority.includes("@") || authority.includes("\\")) return false;
  const hm = /^(\[::1\]|[A-Za-z0-9._~-]+)(?::[0-9]*)?$/.exec(authority);
  if (!hm) return false;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "https") return true;
  return (
    scheme === "http" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(hm[1]!.toLowerCase())
  );
}

/** §5.7 rule 3. */
export function refParse(core: J | undefined): Parsed {
  if (core === null || typeof core !== "object" || Array.isArray(core))
    return null;
  const p = (core as Obj).portal;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
  const enabled = (p as Obj).enabled;
  if (typeof enabled !== "boolean") return null;
  if (!enabled) return { enabled: false };
  const a = (p as Obj).activate;
  return { enabled: true, activate: refLinkOk(a) ? a : null };
}

/** §5.7 rule 4. */
export function refLink(
  served: J | undefined,
  portal: Parsed,
  baseUrl: string,
  product: string,
): string | null {
  if (refLinkOk(served)) return served;
  if (portal !== null) return portal.enabled ? portal.activate : null;
  if (product === "") return null;
  const base = baseUrl.replace(/\/+$/, "");
  const origin =
    base === `https://${L.ISSUER}` ? L.CUSTOMER_ORIGIN_DEFAULT : base;
  // RFC 3986 unreserved characters stay; every other UTF-8 byte is %XX.
  let enc = "";
  for (const byte of new TextEncoder().encode(product)) {
    const c = String.fromCharCode(byte);
    enc += /[A-Za-z0-9\-._~]/.test(c)
      ? c
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  const link = `${origin}/activate?product=${enc}`;
  return refLinkOk(link) ? link : null;
}

// ── The rows ────────────────────────────────────────────────────────────────────────────────

const ACTIVATE = "https://polaris.locker/activate?product=djdl";
const ON: Obj = { enabled: true, activate: ACTIVATE };
const pad = (n: number): string =>
  "https://polaris.locker/activate?product=".padEnd(n, "a");

const OFF_P: Obj = { enabled: false };
const ON_P: Obj = { enabled: true, activate: ACTIVATE };
const ON_NONE: Obj = { enabled: true, activate: null };

interface ParseCase {
  name: string;
  core: J;
  expect: J;
}

const PARSE_CASES: ParseCase[] = [
  { name: "core is null", core: null, expect: null },
  { name: "core is a string", core: "portal", expect: null },
  { name: "core is an array", core: [{ portal: ON }], expect: null },
  { name: "core has no portal member", core: { services: {} }, expect: null },
  { name: "portal is a string", core: { portal: "on" }, expect: null },
  { name: "portal is an array", core: { portal: [ON] }, expect: null },
  { name: "portal is null", core: { portal: null }, expect: null },
  { name: "portal is a number", core: { portal: 1 }, expect: null },
  {
    name: "enabled is missing",
    core: { portal: { activate: ACTIVATE } },
    expect: null,
  },
  {
    name: "enabled is the string true",
    core: { portal: { enabled: "true", activate: ACTIVATE } },
    expect: null,
  },
  {
    name: "enabled is the number 1",
    core: { portal: { enabled: 1, activate: ACTIVATE } },
    expect: null,
  },
  {
    name: "enabled is null",
    core: { portal: { enabled: null } },
    expect: null,
  },
  {
    name: "off",
    core: { portal: { enabled: false } },
    expect: { enabled: false },
  },
  {
    name: "off with an activate (ignored)",
    core: { portal: { enabled: false, activate: ACTIVATE } },
    expect: { enabled: false },
  },
  { name: "on with a valid link", core: { portal: ON }, expect: ON_P },
  {
    name: "on with no link",
    core: { portal: { enabled: true } },
    expect: ON_NONE,
  },
  {
    name: "on with an empty activate",
    core: { portal: { enabled: true, activate: "" } },
    expect: ON_NONE,
  },
  {
    name: "on, activate is http to a public host",
    core: {
      portal: {
        enabled: true,
        activate: "http://polaris.locker/activate?product=djdl",
      },
    },
    expect: ON_NONE,
  },
  {
    name: "on, activate is http to loopback (kept)",
    core: {
      portal: {
        enabled: true,
        activate: "http://localhost:8787/activate?product=djdl",
      },
    },
    expect: {
      enabled: true,
      activate: "http://localhost:8787/activate?product=djdl",
    },
  },
  {
    name: "on, activate has userinfo",
    core: {
      portal: {
        enabled: true,
        activate: "https://user@polaris.locker/activate?product=djdl",
      },
    },
    expect: ON_NONE,
  },
  {
    name: "on, activate has a backslash in the authority",
    core: {
      portal: {
        enabled: true,
        activate: "https://polaris.locker\\@evil.example/activate?product=djdl",
      },
    },
    expect: ON_NONE,
  },
  {
    name: "on, activate has whitespace",
    core: {
      portal: {
        enabled: true,
        activate: "https://polaris.locker/activate?product=dj dl",
      },
    },
    expect: ON_NONE,
  },
  {
    name: "on, activate is 2048 characters (kept)",
    core: { portal: { enabled: true, activate: pad(2048) } },
    expect: { enabled: true, activate: pad(2048) },
  },
  {
    name: "on, activate is 2049 characters",
    core: { portal: { enabled: true, activate: pad(2049) } },
    expect: ON_NONE,
  },
  {
    name: "on, activate is javascript:",
    core: { portal: { enabled: true, activate: "javascript:alert(1)" } },
    expect: ON_NONE,
  },
  {
    name: "on, activate is a number",
    core: { portal: { enabled: true, activate: 5 } },
    expect: ON_NONE,
  },
  {
    name: "unknown members are ignored",
    core: {
      presentation: { name: "DJDL" },
      portal: { enabled: true, activate: ACTIVATE, extra: 1 },
      other: true,
    },
    expect: ON_P,
  },
];

interface LinkCase {
  name: string;
  served: J;
  portal: J;
  baseUrl: string;
  product: string;
  expect: string | null;
}

const SERVED = "https://polaris.locker/#/p/djdl/free-device?license=lic_1";
const BASE = "https://key.plrs.im";

const link = (
  name: string,
  served: string | null,
  portal: J,
  baseUrl: string,
  product: string,
  expect: string | null,
): LinkCase => ({ name, served, portal, baseUrl, product, expect });

const LINK_CASES: LinkCase[] = [
  link(
    "a valid served link beats an off member",
    SERVED,
    OFF_P,
    BASE,
    "djdl",
    SERVED,
  ),
  link(
    "a valid served link beats an on member",
    SERVED,
    ON_P,
    BASE,
    "djdl",
    SERVED,
  ),
  link(
    "a valid served link beats the legacy guess",
    SERVED,
    null,
    BASE,
    "djdl",
    SERVED,
  ),
  link(
    "an invalid served link falls through to the member",
    "http://example.com/x",
    ON_P,
    BASE,
    "djdl",
    ACTIVATE,
  ),
  link(
    "an invalid served link with the portal off is no link",
    "javascript:alert(1)",
    OFF_P,
    BASE,
    "djdl",
    null,
  ),
  link(
    "an invalid served link falls through to the legacy guess",
    "https://u@example.com/x",
    null,
    BASE,
    "djdl",
    "https://polaris.locker/activate?product=djdl",
  ),
  link("off is no link", null, OFF_P, BASE, "djdl", null),
  link(
    "on with no usable link is no link, never the guess",
    null,
    ON_NONE,
    BASE,
    "djdl",
    null,
  ),
  link("on gives the member's link", null, ON_P, BASE, "djdl", ACTIVATE),
  link(
    "on gives the member's link on a custom base",
    null,
    ON_P,
    "https://api.example.com",
    "djdl",
    ACTIVATE,
  ),
  link(
    "on gives the member's link with no product",
    null,
    ON_P,
    BASE,
    "",
    ACTIVATE,
  ),
  link(
    "legacy: the default base maps to the customer origin",
    null,
    null,
    BASE,
    "djdl",
    "https://polaris.locker/activate?product=djdl",
  ),
  link(
    "legacy: the default base with a trailing slash",
    null,
    null,
    `${BASE}/`,
    "djdl",
    "https://polaris.locker/activate?product=djdl",
  ),
  link(
    "legacy: a custom https base keeps its host",
    null,
    null,
    "https://licensing.example.com",
    "djdl",
    "https://licensing.example.com/activate?product=djdl",
  ),
  link(
    "legacy: a base with a path keeps it",
    null,
    null,
    "https://api.example.com/pkey/",
    "djdl",
    "https://api.example.com/pkey/activate?product=djdl",
  ),
  link(
    "legacy: a loopback base keeps http",
    null,
    null,
    "http://localhost:8787",
    "djdl",
    "http://localhost:8787/activate?product=djdl",
  ),
  link(
    "legacy: a public http base is no link",
    null,
    null,
    "http://api.example.com",
    "djdl",
    null,
  ),
  link("legacy: no product is no link", null, null, BASE, "", null),
  link(
    "legacy: the slug is percent-encoded",
    null,
    null,
    BASE,
    "a b",
    "https://polaris.locker/activate?product=a%20b",
  ),
];

// ── The file ────────────────────────────────────────────────────────────────────────────────

const canon = (v: unknown): string => JSON.stringify(v);

function unique(kind: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new Error(`portal-matrix ${kind}: duplicate ${n}`);
    seen.add(n);
  }
}

/** The file's object, after every row has been recomputed by the reference. */
export function buildPortalMatrix(): Obj {
  unique(
    "parseCases",
    PARSE_CASES.map((c) => c.name),
  );
  unique(
    "linkCases",
    LINK_CASES.map((c) => c.name),
  );
  for (const c of PARSE_CASES) {
    const got = refParse(c.core);
    if (canon(got) !== canon(c.expect))
      throw new Error(
        `portal-matrix parse ${c.name}: reference gives ${canon(got)}, row says ${canon(c.expect)}`,
      );
    // The normalised member is its own fixed point: re-emitting it parses to itself.
    if (got !== null) {
      const again = refParse({
        portal:
          got.enabled && got.activate !== null
            ? got
            : got.enabled
              ? { enabled: true }
              : got,
      });
      if (canon(again) !== canon(got))
        throw new Error(
          `portal-matrix parse ${c.name}: expect is not a fixed point`,
        );
    }
  }
  for (const c of LINK_CASES) {
    const got = refLink(c.served, c.portal as Parsed, c.baseUrl, c.product);
    if (canon(got) !== canon(c.expect))
      throw new Error(
        `portal-matrix link ${c.name}: reference gives ${canon(got)}, row says ${canon(c.expect)}`,
      );
    if (
      c.portal !== null &&
      canon(refParse({ portal: c.portal })) !== canon(c.portal)
    )
      throw new Error(`portal-matrix link ${c.name}: portal is not normalised`);
  }
  return {
    portalMatrixVersion: PORTAL_MATRIX_VERSION,
    description:
      "The product page link, the client half (WIRE-CONTRACT-V4 section 5.7, plans/DISC-01.md). Discovery's unsigned `core.portal`, parsed as a whole, and the one link a terminal kit draws. parseCases: `parsePortal(core)` must equal `expect`. (1) `core` not an object, `portal` not an object, or `enabled` not a boolean: null (unknown). (2) `enabled: false`: {enabled:false}; other members are ignored. (3) `enabled: true`: {enabled:true, activate} where `activate` is the member if it passes WIRE-CONTRACT-V4 section 5.3 rule 4 (an absolute https URL, or http to localhost, 127.0.0.1 or [::1]; no userinfo, backslash, whitespace or control character in a link of at most 2048 characters), else null. Unknown members are ignored and the member never refuses discovery. linkCases: `portalLink({served, portal, baseUrl, product})` must equal `expect` (a link, or null: no link, the kit draws Contact {developer}); `portal` is a normalised parsePortal result. First match: (1) `served` (a response's own link) if it passes rule 4; (2) `portal` is {enabled:false} or {enabled:true, activate:null}: null, never the legacy guess; (3) `portal.activate`; (4) `portal` is null: the legacy link, `<origin>/activate?product=<slug>` with <origin> the customer origin https://polaris.locker when the base with trailing slashes removed is https://key.plrs.im, else that base, the slug percent-encoded (RFC 3986 unreserved characters stay), kept only if it passes rule 4; with no product, null. A client never appends #key= to these links. Every runner compares with deep equality (member order is not significant). Non-ASCII is written escaped. Append-only: a new row keeps portalMatrixVersion; a changed row or rule bumps it.",
    parseCases: PARSE_CASES as unknown as J,
    linkCases: LINK_CASES as unknown as J,
  };
}
