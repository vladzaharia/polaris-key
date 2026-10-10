// Product backends — WIRE-CONTRACT-V4 §14 (SP-53). The reference implementation of the three
// behaviours `conformance/corpus/v2/backend-matrix.json` pins:
//
//   backendVerdict       §14.2, a server core's six-step verdict on `X-PKey-License`
//   backendProblem       §14.3, the refusal's problem body, challenge and locale
//   clientBackendAction  §14.5, the client half's refresh-and-retry rule
//
// `@polaris-key/server` (SP-55) and the JavaScript client halves (SP-58) build on these. Every
// other language replays the same matrix in its own package. Nothing here does I/O: the trust
// sets (the pins plus the last verified manifest, §14.4) and the copy tables come in from the
// caller, and nothing here logs, so the header, the document and the holder never reach a log.

import { verifyJws, type TrustSet } from "@polaris-key/jws";
import {
  BACKEND_AUTH_SCHEME,
  BACKEND_LICENSE_MAX_BYTES,
  HEADER_DEVICE,
  HEADER_LICENSE,
} from "@polaris-key/protocol/core";
import { PAIRWISE_SUBJECT_PATTERN } from "@polaris-key/protocol/identity";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { CLOCK_SKEW_SECONDS, REFRESH_MARGIN_SECONDS } from "./claims.js";
import { isUsable, licenseState } from "./gate.js";
import { LICENSE_DOC, validateDocClaims } from "./verify.js";

/** The codes a backend answers with (§14.2). `not_entitled` is the existing wire code. */
export type BackendRefusalCode =
  | "license_required"
  | "license_invalid"
  | "license_stale"
  | "not_entitled"
  | "sign_in_required";

/** Each refusal's HTTP status (§14.2). */
export const BACKEND_REFUSAL_STATUS: Readonly<
  Record<BackendRefusalCode, 401 | 403>
> = {
  license_required: 401,
  license_invalid: 401,
  license_stale: 401,
  not_entitled: 403,
  sign_in_required: 403,
};

/** One requirement of a route, checked at step 6 in the order the route lists them. */
export type BackendRequirement =
  | { kind: "entitlement"; name: string }
  | { kind: "signIn" };

export interface BackendOptions {
  /** The product slugs this backend serves, in order. The first is the challenge's realm. */
  products: readonly string[];
  /** Accept a document up to this many seconds after its `issuedAt` (plus the 300 s skew),
   *  never past its `graceUntil`, instead of its own `expiresAt`. Absent or null: the document's
   *  window. A non-negative integer. */
  maxAgeSeconds?: number | null;
  /** The route's requirements, in order. */
  require?: readonly BackendRequirement[];
}

export interface BackendVerdictInput {
  /** Every header field of the request as `[name, value]`, in order. A Fetch `Headers` (which
   *  joins repeated fields with `, `) gives the same verdict as the fields one by one. */
  headers: Iterable<readonly [string, string]>;
  /** The server's clock, epoch seconds. */
  now: number;
  options: BackendOptions;
  /** Per configured product: its pinned keys plus the last verified trust manifest's keys. */
  trust: Readonly<Record<string, TrustSet>>;
}

/** What a passing document attaches to the request (§14.2). */
export interface BackendContext {
  license: {
    /** The document's `aud`: which configured product it is for. */
    product: string;
    id: string;
    deviceId: string;
    /** The `license.tier` entitlement's value when it is a string, else null. */
    tier: string | null;
    issuedAt: number;
    /** `now - issuedAt`, never below 0. */
    ageSeconds: number;
    /** The signed profile's name and email, when both are strings. */
    holder: { name: string; email: string } | null;
  };
  /** The signed-in account's pairwise subject (`profile.user.subject`, SP-54), when valid. */
  user: { subject: string } | null;
}

export interface BackendVerdict {
  /** 200 when every step passes. */
  status: 200 | 401 | 403;
  code: BackendRefusalCode | null;
  /** Set whenever steps 1 to 5 pass, so on step 6's refusals too. */
  context: BackendContext | null;
  /** The verified licence document, whenever `context` is set. Not part of the matrix: a server
   *  core reads entitlement values from it. */
  document: LicenseDoc | null;
}

const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** ASCII-only case folding (A–Z): never a locale's lowercase. */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const trimOws = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * §14.1: a header's elements. Every field named `name` (in any case), each value split at `,`,
 * each element trimmed of spaces and tabs, empty elements dropped. A JWS and a device id never
 * hold a comma, so a proxy that joins repeated fields changes nothing.
 */
export function backendHeaderElements(
  headers: Iterable<readonly [string, string]>,
  name: string,
): string[] {
  const want = asciiLower(name);
  const out: string[] = [];
  for (const [n, v] of headers) {
    if (asciiLower(n) !== want) continue;
    for (const element of v.split(",")) {
      const e = trimOws(element);
      if (e !== "") out.push(e);
    }
  }
  return out;
}

const SEGMENTS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SUBJECT = new RegExp(PAIRWISE_SUBJECT_PATTERN);
const utf8 = new TextEncoder();

/** The private total decoder of `profile.user.subject` (SP-54 replaces it with its reader). */
function userOf(doc: LicenseDoc): { subject: string } | null {
  const profile: unknown = doc.profile;
  if (!isPlainObject(profile) || !hasOwn(profile, "user")) return null;
  const user = profile.user;
  if (!isPlainObject(user) || !hasOwn(user, "subject")) return null;
  const subject = user.subject;
  return typeof subject === "string" && SUBJECT.test(subject)
    ? { subject }
    : null;
}

function contextOf(
  product: string,
  doc: LicenseDoc,
  now: number,
): BackendContext {
  const entitlements = doc.entitlements as Record<string, unknown>;
  const tierEntry = hasOwn(entitlements, "license.tier")
    ? entitlements["license.tier"]
    : null;
  const profile: unknown = doc.profile;
  return {
    license: {
      product,
      id: doc.licenseId,
      deviceId: doc.deviceId,
      tier:
        isPlainObject(tierEntry) && typeof tierEntry.value === "string"
          ? tierEntry.value
          : null,
      issuedAt: doc.issuedAt,
      ageSeconds: Math.max(0, now - doc.issuedAt),
      holder:
        isPlainObject(profile) &&
        typeof profile.name === "string" &&
        typeof profile.email === "string"
          ? { name: profile.name, email: profile.email }
          : null,
    },
    user: userOf(doc),
  };
}

function checkOptions(options: BackendOptions): void {
  if (
    !Array.isArray(options.products) ||
    options.products.length === 0 ||
    !options.products.every((p) => typeof p === "string" && p !== "")
  )
    throw new TypeError("backendVerdict: options.products names no product");
  const max = options.maxAgeSeconds;
  if (
    max !== undefined &&
    max !== null &&
    !(Number.isSafeInteger(max) && max >= 0)
  )
    throw new TypeError(
      "backendVerdict: options.maxAgeSeconds is not a non-negative integer",
    );
  for (const r of options.require ?? [])
    if (
      !(
        r.kind === "signIn" ||
        (r.kind === "entitlement" && typeof r.name === "string")
      )
    )
      throw new TypeError("backendVerdict: an unknown requirement");
}

const refused = (
  code: BackendRefusalCode,
  context: BackendContext | null = null,
  document: LicenseDoc | null = null,
): BackendVerdict => ({
  status: BACKEND_REFUSAL_STATUS[code],
  code,
  context,
  document,
});

/**
 * §14.2: decide a request to a product backend. The steps run in order and the first that fails
 * decides. Never throws on request input; throws a `TypeError` only on invalid `options`.
 */
export async function backendVerdict(
  input: BackendVerdictInput,
): Promise<BackendVerdict> {
  const { now, options, trust } = input;
  checkOptions(options);
  const headers = [...input.headers];
  // 1. No `X-PKey-License` element.
  const license = backendHeaderElements(headers, HEADER_LICENSE);
  if (license.length === 0) return refused("license_required");
  // 2. More than one element, longer than 16 384 bytes, or not three base64url segments.
  if (license.length !== 1) return refused("license_invalid");
  const jws = license[0]!;
  if (
    jws.length > BACKEND_LICENSE_MAX_BYTES ||
    utf8.encode(jws).length > BACKEND_LICENSE_MAX_BYTES ||
    !SEGMENTS.test(jws)
  )
    return refused("license_invalid");
  // 3. The strict verifier against the trust set of the configured product its `aud` names,
  //    then the licence claims (no freshness, no floor) with the device the header names or,
  //    without one, the document's own; then `issuedAt` no later than now + 300.
  const device = backendHeaderElements(headers, HEADER_DEVICE);
  if (device.length > 1) return refused("license_invalid");
  let matched: { product: string; doc: LicenseDoc } | null = null;
  for (const product of options.products) {
    if (!hasOwn(trust, product)) continue;
    const v = await verifyJws<unknown>(jws, trust[product]!, {
      typ: LICENSE_DOC.typ,
    });
    if (!v || !isPlainObject(v.payload) || v.payload.aud !== product) continue;
    const deviceId = v.payload.deviceId;
    if (typeof deviceId !== "string" || deviceId === "") continue;
    if (
      !validateDocClaims(
        v.payload,
        LICENSE_DOC,
        {
          expectedAud: product,
          deviceId: device.length === 1 ? device[0]! : deviceId,
          lastAcceptedIssuedAt: null,
          now,
          checkFreshness: false,
        },
        v.nonWireIntegers,
      )
    )
      continue;
    if (v.payload.issuedAt > now + CLOCK_SKEW_SECONDS) continue;
    matched = { product, doc: v.payload };
    break;
  }
  if (!matched) return refused("license_invalid");
  const { product, doc } = matched;
  // 4. Freshness: the document's own window, or the backend's maximum age within graceUntil.
  const max = options.maxAgeSeconds;
  if (max === undefined || max === null) {
    if (now > doc.expiresAt + CLOCK_SKEW_SECONDS)
      return refused("license_stale");
  } else if (
    now - doc.issuedAt > max + CLOCK_SKEW_SECONDS ||
    now > doc.graceUntil
  ) {
    return refused("license_stale");
  }
  // 5. The shared gate must find the document usable.
  const state = licenseState({
    licenseServiceEnabled: true,
    activation: "token",
    doc,
    now,
  });
  if (!isUsable(state)) return refused("license_stale");
  const context = contextOf(product, doc, now);
  // 6. The route's requirements, in order.
  for (const requirement of options.require ?? []) {
    if (requirement.kind === "entitlement") {
      const entitlements = doc.entitlements as Record<string, unknown>;
      const entry = hasOwn(entitlements, requirement.name)
        ? entitlements[requirement.name]
        : undefined;
      if (!isPlainObject(entry) || entry.value !== true)
        return refused("not_entitled", context, doc);
    } else if (context.user === null) {
      return refused("sign_in_required", context, doc);
    }
  }
  return { status: 200, code: null, context, document: doc };
}

/** §14.3: the copy locales, English first (`conformance/parity/copy.<locale>.json`). */
export const BACKEND_LOCALES = [
  "en",
  "de",
  "es",
  "it",
  "ja",
  "ko",
  "pt-BR",
  "zh-Hans",
] as const;
export type BackendLocale = (typeof BACKEND_LOCALES)[number];

const QVALUE = /^(0(\.[0-9]{0,3})?|1(\.0{0,3})?)$/;

/** One language range onto a copy locale, or null to try the next range. */
function rangeLocale(range: string): BackendLocale | null {
  if (range === "*") return "en";
  const tag = asciiLower(range);
  const exact = BACKEND_LOCALES.find((l) => asciiLower(l) === tag);
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
  return BACKEND_LOCALES.find((l) => l === lang) ?? null;
}

/**
 * §14.3: the copy locale for an `Accept-Language` value. Ranges are tried by weight (the first
 * `q` parameter; ties keep their order; a weight of 0, or one outside the qvalue grammar, drops
 * the range). `*` is English. With no match, English.
 */
export function backendLocale(
  acceptLanguage: string | null | undefined,
): BackendLocale {
  if (acceptLanguage === null || acceptLanguage === undefined) return "en";
  const ranges: { range: string; q: number; at: number }[] = [];
  acceptLanguage.split(",").forEach((element, at) => {
    const [head, ...params] = element.split(";");
    const range = trimOws(head!);
    let q = 1;
    for (const param of params) {
      const p = trimOws(param);
      const eq = p.indexOf("=");
      const name = eq < 0 ? p : p.slice(0, eq).replace(/[ \t]+$/, "");
      if (asciiLower(name) !== "q") continue;
      const value = eq < 0 ? "" : p.slice(eq + 1).replace(/^[ \t]+/, "");
      if (!QVALUE.test(value)) return;
      q = Number(value);
      break;
    }
    if (range !== "" && q > 0) ranges.push({ range, q, at });
  });
  ranges.sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { range } of ranges) {
    const locale = rangeLocale(range);
    if (locale) return locale;
  }
  return "en";
}

/** One locale's `codes` table from `copy.<locale>.json`. */
export type BackendCopyTable = Readonly<
  Record<string, { readonly title: string; readonly message: string }>
>;

/** §14.3: a problem `type` is the error-codes page with the code as its fragment. */
export const BACKEND_PROBLEM_TYPE_BASE =
  "https://key.plrs.im/docs/reference/error-codes/#";
export const BACKEND_PROBLEM_CONTENT_TYPE = "application/problem+json";

export interface BackendProblem {
  status: 401 | 403;
  locale: BackendLocale;
  /** The `WWW-Authenticate` value on a 401, else null. */
  challenge: string | null;
  type: string;
  title: string;
  detail: string;
  /** The response headers: `Content-Type`, `Cache-Control` and, on a 401, `WWW-Authenticate`. */
  headers: Record<string, string>;
  /** The JSON body. It never names the step that refused, the header or a claim. */
  body: {
    type: string;
    title: string;
    status: 401 | 403;
    detail: string;
    code: BackendRefusalCode;
  };
}

/**
 * §14.3: the refusal's problem. `realm` is the first configured product's slug; `copy` holds the
 * copy tables by locale. A locale whose table lacks the code falls back to English.
 */
export function backendProblem(
  code: BackendRefusalCode,
  options: {
    acceptLanguage?: string | null;
    realm: string;
    copy: Readonly<Partial<Record<BackendLocale, BackendCopyTable>>>;
  },
): BackendProblem {
  const status = BACKEND_REFUSAL_STATUS[code];
  let locale = backendLocale(options.acceptLanguage);
  let entry = options.copy[locale]?.[code];
  if (!entry) {
    locale = "en";
    entry = options.copy.en?.[code];
  }
  if (!entry)
    throw new TypeError(`backendProblem: no English copy for ${code}`);
  const type = `${BACKEND_PROBLEM_TYPE_BASE}${code}`;
  const challenge =
    status === 401
      ? `${BACKEND_AUTH_SCHEME} realm="${options.realm}", error="${code}"`
      : null;
  return {
    status,
    locale,
    challenge,
    type,
    title: entry.title,
    detail: entry.message,
    headers: {
      "Content-Type": BACKEND_PROBLEM_CONTENT_TYPE,
      "Cache-Control": "no-store",
      ...(challenge ? { "WWW-Authenticate": challenge } : {}),
    },
    body: { type, title: entry.title, status, detail: entry.message, code },
  };
}

/** §14.5: what the client half does next. */
export type ClientBackendAction =
  | "send"
  | "refresh-then-send"
  | "refresh-and-retry"
  | "surface";

export interface ClientBackendInput {
  /** The licence document the client holds, or null. */
  document: { issuedAt: number; expiresAt: number } | null;
  /** The client's effective time (the clock floor applied), epoch seconds. */
  now: number;
  /** The backend's answer, or null before sending. `code` is the problem body's `code`. */
  response: { status: number; code: string | null } | null;
  /** Whether this request was already retried once. */
  retried?: boolean;
}

/**
 * §14.5: before sending, refresh a document within `REFRESH_MARGIN_SECONDS` of its `expiresAt`;
 * after a 401 `license_stale` or `license_invalid`, force a sync and retry once. Everything else
 * (`not_entitled` and `sign_in_required` included) is surfaced, never retried.
 */
export function clientBackendAction(
  input: ClientBackendInput,
): ClientBackendAction {
  if (input.response === null) {
    if (input.document === null) return "send";
    return input.now > input.document.expiresAt - REFRESH_MARGIN_SECONDS
      ? "refresh-then-send"
      : "send";
  }
  const { status, code } = input.response;
  if (
    status === 401 &&
    (code === "license_stale" || code === "license_invalid") &&
    input.retried !== true
  )
    return "refresh-and-retry";
  return "surface";
}
