// Reference: product backends (WIRE-CONTRACT-V4 §14, plans/SP-53.md §2): the six-step verdict
// on `X-PKey-License`, the problem body and its locale, and the client's refresh-and-retry rule.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: it imports nothing it checks. Step 3 reuses the reference
// JWS verifier and claim checks (`jws.ts`, `claims.ts`) and step 6 the reference reader of the
// signed-in subject (`license-user.ts`, SP-54), which are themselves restated from the spec.
// Every constant below is a literal.

import { CLOCK_SKEW, ISSUER_V3, type TypV3 } from "../common.js";
import { ctxOf, hasOwn, isObj, refDocClaims } from "./claims.js";
import { refVerifyJws } from "./jws.js";
import { refLicenseUserOf } from "./license-user.js";

/** §14.1, restated. */
export const REF_HEADER_LICENSE = "X-PKey-License";
export const REF_HEADER_DEVICE = "X-PKey-Device";
export const REF_LICENSE_MAX_BYTES = 16384;
export const REF_AUTH_SCHEME = "PKey-License";
/** §5 `REFRESH_MARGIN_SECONDS`, half the one-hour document. */
export const REF_REFRESH_MARGIN = 1800;
/** §8: the pairwise subject (declared beside its reader, `license-user.ts`). */
export { REF_SUBJECT_RE } from "./license-user.js";
/** §14.3: the problem `type` is the error-codes page with the code as its fragment. */
export const REF_TYPE_BASE = "https://key.plrs.im/docs/reference/error-codes/#";
/** §14.3: the copy locales, English first (`conformance/parity/copy.<locale>.json`). */
export const REF_LOCALES = [
  "en",
  "de",
  "es",
  "it",
  "ja",
  "ko",
  "pt-BR",
  "zh-Hans",
] as const;
export type RefLocale = (typeof REF_LOCALES)[number];

/** §14.2: each refusal and its status; `not_entitled` is the existing wire code. */
export const REF_BACKEND_STATUS = {
  license_required: 401,
  license_invalid: 401,
  license_stale: 401,
  not_entitled: 403,
  sign_in_required: 403,
} as const;
export type RefBackendCode = keyof typeof REF_BACKEND_STATUS;

export type RefRequirement =
  | { kind: "entitlement"; name: string }
  | { kind: "signIn" };

export interface RefVerdictInput {
  /** Every header field of the request, in order, as `[name, value]`. */
  headers: [string, string][];
  /** The server's clock, epoch seconds. */
  now: number;
  options: {
    products: string[];
    maxAgeSeconds?: number;
    require?: RefRequirement[];
  };
  /** Per configured product: the pinned keys plus the last verified manifest's keys. */
  trust: Record<string, Record<string, string>>;
}

export interface RefContext {
  license: {
    product: string;
    id: string;
    deviceId: string;
    tier: string | null;
    issuedAt: number;
    ageSeconds: number;
    holder: { name: string; email: string } | null;
  };
  user: { subject: string } | null;
}

export interface RefVerdict {
  status: 200 | 401 | 403;
  code: RefBackendCode | null;
  context: RefContext | null;
}

/** ASCII-only case folding (A–Z), never a locale's lowercase. */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** §14.1: a header's elements. Every field with the name (any case), each value split at `,`,
 *  each element trimmed of spaces and tabs, empty elements dropped. */
export function refHeaderElements(
  headers: [string, string][],
  name: string,
): string[] {
  const want = asciiLower(name);
  return headers
    .filter(([n]) => asciiLower(n) === want)
    .flatMap(([, v]) => v.split(","))
    .map((e) => e.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((e) => e !== "");
}

const SEGMENTS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function refContextOf(
  product: string,
  doc: Record<string, unknown>,
  now: number,
): RefContext {
  const issuedAt = doc.issuedAt as number;
  const ent = doc.entitlements as Record<string, unknown>;
  const tierEntry = hasOwn(ent, "license.tier") ? ent["license.tier"] : null;
  const tier =
    isObj(tierEntry) && typeof tierEntry.value === "string"
      ? tierEntry.value
      : null;
  const profile = hasOwn(doc, "profile") ? doc.profile : null;
  const holder =
    isObj(profile) &&
    typeof profile.name === "string" &&
    typeof profile.email === "string"
      ? { name: profile.name, email: profile.email }
      : null;
  return {
    license: {
      product,
      id: doc.licenseId as string,
      deviceId: doc.deviceId as string,
      tier,
      issuedAt,
      ageSeconds: Math.max(0, now - issuedAt),
      holder,
    },
    // §14.2 step 6: SP-54's reader of the signed-in subject (V4 §2.1, §3.2).
    user: refLicenseUserOf(doc),
  };
}

const refuse = (code: RefBackendCode, context: RefContext | null = null) => ({
  status: REF_BACKEND_STATUS[code],
  code,
  context,
});

/** §14.2's six steps, in order; the first that fails decides. */
export function refBackendVerdict(input: RefVerdictInput): RefVerdict {
  const { headers, now, options, trust } = input;
  // 1. No `X-PKey-License` element.
  const license = refHeaderElements(headers, REF_HEADER_LICENSE);
  if (license.length === 0) return refuse("license_required");
  // 2. One element, at most 16 384 bytes, three base64url segments.
  if (license.length !== 1) return refuse("license_invalid");
  const jws = license[0]!;
  if (Buffer.byteLength(jws, "utf8") > REF_LICENSE_MAX_BYTES)
    return refuse("license_invalid");
  if (!SEGMENTS_RE.test(jws)) return refuse("license_invalid");
  // 3. The strict verifier against a configured product's trust set whose slug is the `aud`;
  //    `iss`, the device (the header when sent, else the document's own string id), the licence
  //    claims without freshness or a floor; then `issuedAt` no later than now + skew.
  const device = refHeaderElements(headers, REF_HEADER_DEVICE);
  if (device.length > 1) return refuse("license_invalid");
  let matched: { product: string; doc: Record<string, unknown> } | null = null;
  for (const product of options.products) {
    const keys = hasOwn(trust, product) ? trust[product]! : {};
    const typ: TypV3 = "pkey-license+jws";
    const v = refVerifyJws(jws, keys, typ);
    if (!v || !isObj(v.payload) || v.payload.aud !== product) continue;
    const doc = v.payload;
    if (typeof doc.deviceId !== "string" || doc.deviceId === "") continue;
    const deviceId = device.length === 1 ? device[0]! : doc.deviceId;
    if (doc.iss !== ISSUER_V3) continue;
    const ok = refDocClaims(typ, doc, ctxOf(v.text), {
      expectedAud: product,
      deviceId,
      now,
      checkFreshness: false,
    });
    if (!ok) continue;
    if ((doc.issuedAt as number) > now + CLOCK_SKEW) continue;
    matched = { product, doc };
    break;
  }
  if (!matched) return refuse("license_invalid");
  const { product, doc } = matched;
  const issuedAt = doc.issuedAt as number;
  const expiresAt = doc.expiresAt as number;
  const graceUntil = doc.graceUntil as number;
  // 4. Freshness: the document's window, or the backend's maximum age capped at graceUntil.
  if (options.maxAgeSeconds === undefined) {
    if (now > expiresAt + CLOCK_SKEW) return refuse("license_stale");
  } else {
    if (now - issuedAt > options.maxAgeSeconds + CLOCK_SKEW)
      return refuse("license_stale");
    if (now > graceUntil) return refuse("license_stale");
  }
  // 5. The shared gate, restated: a held licence document is unusable once now passes
  //    `graceUntil` (`expired`); `ok` and `grace` are usable.
  if (now > graceUntil) return refuse("license_stale");
  const context = refContextOf(product, doc, now);
  // 6. The route's requirements, in order.
  for (const req of options.require ?? []) {
    if (req.kind === "entitlement") {
      const ent = doc.entitlements as Record<string, unknown>;
      const entry = hasOwn(ent, req.name) ? ent[req.name] : undefined;
      if (!isObj(entry) || entry.value !== true)
        return refuse("not_entitled", context);
    } else if (context.user === null) {
      return refuse("sign_in_required", context);
    }
  }
  return { status: 200, code: null, context };
}

const QVALUE_RE = /^(0(\.[0-9]{0,3})?|1(\.0{0,3})?)$/;

/** §14.3: one language range onto a copy locale, or null to try the next range. */
function refRangeLocale(range: string): RefLocale | null {
  if (range === "*") return "en";
  const tag = asciiLower(range);
  const exact = REF_LOCALES.find((l) => asciiLower(l) === tag);
  if (exact) return exact;
  const [lang, second] = tag.split("-");
  if (lang === "zh")
    return second === "tw" ||
      second === "hk" ||
      second === "mo" ||
      second === "hant"
      ? null
      : "zh-Hans";
  if (lang === "pt") return "pt-BR";
  return (REF_LOCALES as readonly string[]).includes(lang!)
    ? (lang as RefLocale)
    : null;
}

/** §14.3: the copy locale for an `Accept-Language` value; English when none matches. */
export function refBackendLocale(acceptLanguage: string | null): RefLocale {
  if (acceptLanguage === null) return "en";
  const ranges: { range: string; q: number; at: number }[] = [];
  acceptLanguage.split(",").forEach((element, at) => {
    const [head, ...params] = element.split(";");
    const range = head!.replace(/^[ \t]+|[ \t]+$/g, "");
    // The first `q` parameter is the weight (1 without one); a weight outside the qvalue
    // grammar drops the element. Any other parameter is ignored.
    let q = 1;
    for (const param of params) {
      const p = param.replace(/^[ \t]+|[ \t]+$/g, "");
      const eq = p.indexOf("=");
      const name = eq < 0 ? p : p.slice(0, eq).replace(/[ \t]+$/, "");
      if (asciiLower(name) !== "q") continue;
      const value = eq < 0 ? "" : p.slice(eq + 1).replace(/^[ \t]+/, "");
      if (!QVALUE_RE.test(value)) return;
      q = Number(value);
      break;
    }
    if (range === "" || q === 0) return;
    ranges.push({ range, q, at });
  });
  ranges.sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { range } of ranges) {
    const locale = refRangeLocale(range);
    if (locale) return locale;
  }
  return "en";
}

export interface RefProblem {
  status: 401 | 403;
  locale: RefLocale;
  challenge: string | null;
  type: string;
  title: string;
  detail: string;
}

/** §14.3: the problem for a refusal. `copy` is each locale's `codes` table. */
export function refBackendProblem(
  input: { code: RefBackendCode; acceptLanguage: string | null; realm: string },
  copy: Record<string, Record<string, { title: string; message: string }>>,
): RefProblem {
  const status = REF_BACKEND_STATUS[input.code];
  const locale = refBackendLocale(input.acceptLanguage);
  const entry = copy[locale]![input.code]!;
  return {
    status,
    locale,
    challenge:
      status === 401
        ? `${REF_AUTH_SCHEME} realm="${input.realm}", error="${input.code}"`
        : null,
    type: `${REF_TYPE_BASE}${input.code}`,
    title: entry.title,
    detail: entry.message,
  };
}

export type RefClientAction =
  | "send"
  | "refresh-then-send"
  | "refresh-and-retry"
  | "surface";

export interface RefClientInput {
  /** The licence document the client holds, or null. */
  document: { issuedAt: number; expiresAt: number } | null;
  /** The client's effective time (the clock floor applied), epoch seconds. */
  now: number;
  /** The backend's answer, or null before the request is sent. `code` is the problem body's. */
  response: { status: number; code: string | null } | null;
  /** Whether this request has already been retried once. */
  retried: boolean;
}

/** §14.5: what the client half does next. */
export function refClientBackendAction(input: RefClientInput): RefClientAction {
  if (input.response === null) {
    if (input.document === null) return "send";
    return input.now > input.document.expiresAt - REF_REFRESH_MARGIN
      ? "refresh-then-send"
      : "send";
  }
  const { status, code } = input.response;
  if (
    status === 401 &&
    (code === "license_stale" || code === "license_invalid") &&
    !input.retried
  )
    return "refresh-and-retry";
  return "surface";
}
