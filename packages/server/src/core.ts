// The Fetch core of @polaris-key/server (framework drop-ins plan §5.1, WIRE-CONTRACT-V4 §14):
// `authenticate(request)` decides a request offline from the app's signed licence document in
// `X-PKey-License`. It runs on Node, Bun, Deno and Workers, and every framework adapter is a thin
// shell around it.
//
// Nothing here logs the header, the document or the holder. A debug line, when the host passes a
// `debug` function, carries the `kid`, the `aud`, an 8-character hash of the device id and the
// step that refused.

import {
  backendHeaderElements,
  backendProblem,
  backendVerdict,
  type BackendContext,
  type BackendRefusalCode,
  type BackendVerdict,
} from "@polaris-key/client-core/backend";
import { jwsHeaderKid } from "@polaris-key/client-core/trust";
import { sha256Base64Url } from "@polaris-key/jws";
import {
  BACKEND_LICENSE_MAX_BYTES,
  HEADER_DEVICE,
  HEADER_LICENSE,
} from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { CLOCK_SKEW_SECONDS } from "@polaris-key/client-core/claims";
import { PolarisLicense, type PolarisAuth, type Problem } from "./context.js";
import { BACKEND_COPY } from "./copy.generated.js";
import { ProductTrust } from "./trust.js";

const DEFAULT_BASE_URL = "https://key.plrs.im";
const DEFAULT_CACHE_SIZE = 1000;

/** The configuration `pkey sdk --lang node --write` writes (the parts a backend reads). */
export interface PolarisServerConfig {
  productSlug: string;
  /** The Polaris Key origin; default `https://key.plrs.im`. */
  baseUrl?: string;
  trust: { pinnedKeys: Readonly<Record<string, string>> };
  /** When present it must list `license`: a product with no licence service issues no document. */
  expectedServices?: readonly string[];
}

/** What a route needs of the document, checked at step 6 in the order listed. */
export type Requirement =
  | { kind: "entitlement"; name: string; test?: (value: unknown) => boolean }
  | { kind: "tier"; tiers: readonly string[] }
  | { kind: "signIn" };

/**
 * Builders for the requirements a route lists, for `requireAll(...)`, a route's `require` and the
 * Next.js middleware's rules:
 *
 *   requirement.entitlement("export.pdf")
 *   requirement.entitlement("seats", (n) => typeof n === "number" && n >= 5)
 *   requirement.tier("pro", "team")
 *   requirement.signIn()
 */
export const requirement = {
  /** Boolean entitlement `name` is granted, or `test` accepts a valued entitlement. */
  entitlement(name: string, test?: (value: any) => boolean): Requirement {
    return { kind: "entitlement", name, ...(test ? { test } : {}) };
  },
  /** The `license.tier` entitlement is one of `tiers`. */
  tier(...tiers: string[]): Requirement {
    return { kind: "tier", tiers };
  },
  /** A person is signed in on the device (`profile.user.subject`). */
  signIn(): Requirement {
    return { kind: "signIn" };
  },
} as const;

/** The JSON body of a refusal, with the catalog's localised title and detail (§14.3). */
export type ProblemBody = Problem["body"];

/**
 * Whether a request is a CORS preflight: an `OPTIONS` carrying `Access-Control-Request-Method`.
 * A browser sends no custom header on it, so a gate that refused it would break every
 * cross-origin call before the real request ran. The drop-ins let it through (`preflight:
 * "pass"`, the default).
 */
export function isCorsPreflight(method: string, input: HeadersInput): boolean {
  if (method.toUpperCase() !== "OPTIONS") return false;
  return headerFields(input).some(
    ([n]) => n.toLowerCase() === "access-control-request-method",
  );
}

/** The step group a verdict was decided in, for `onVerdict` (§14.2). */
export type VerdictStep =
  | "credential"
  | "verify"
  | "fresh"
  | "require"
  | "pass";

export interface PolarisKeyOptions {
  /** One product, or several: the document's `aud` selects the trust set. The first is the
   *  challenge's realm. */
  config: PolarisServerConfig | readonly PolarisServerConfig[];
  /** Accept a document up to this many seconds after its `issuedAt` (plus 300 s of skew), never
   *  past its `graceUntil`, instead of its own `expiresAt`. */
  maxAgeSeconds?: number | null;
  /** False runs on the pins alone, for an air-gapped server. Default true. */
  trustRefresh?: boolean;
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
  /** The server's clock in epoch seconds; default the system clock. Tests inject theirs. */
  now?: () => number;
  /** Keeps a background trust refresh alive after the response (Workers' `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Reports every verdict, for metrics. It carries no header and no document. */
  onVerdict?: (code: BackendRefusalCode | null, step: VerdictStep) => void;
  /** Debug lines: `kid`, `aud`, a short device hash and the step. Never the header. */
  debug?: (line: string) => void;
  /** Verified documents kept; default 1000. */
  cacheSize?: number;
}

/** What every drop-in accepts on top of the core's options. */
export interface PolarisAdapterOptions extends PolarisKeyOptions {
  /** `"throw"` passes a `PolarisKeyError` to the framework's error pipeline instead of
   *  answering. Default `"respond"`. */
  errors?: "respond" | "throw";
  /** `"pass"` (default) lets a CORS preflight through every gate; `"gate"` refuses it like any
   *  other request. */
  preflight?: "pass" | "gate";
}

export interface RouteOptions {
  require?: readonly Requirement[];
}

/** Anything that carries request headers. */
export type HeadersInput =
  | Request
  | Headers
  | Iterable<readonly [string, string]>
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PolarisKey {
  /** Decide a request. Never throws on request input. */
  authenticate(input: HeadersInput, route?: RouteOptions): Promise<PolarisAuth>;
  /** Step 6 on an already authenticated request: the first unmet requirement becomes the
   *  `problem`. A request refused at steps 1 to 5 is returned unchanged. Reports a refusal to
   *  `onVerdict`; `authenticate` has already reported the pass. */
  require(
    auth: PolarisAuth,
    requirements: readonly Requirement[],
    input?: HeadersInput,
  ): PolarisAuth;
  /** The refusal as a Response (problem+json, `no-store`, the challenge on a 401). */
  refuse(problem: Problem | BackendRefusalCode, input?: HeadersInput): Response;
  /** The refusal's problem for `code`, localised from the request's `Accept-Language`. */
  problem(code: BackendRefusalCode, input?: HeadersInput): Problem;
}

/** Raised into a framework's error pipeline by `errors: "throw"`. */
export class PolarisKeyError extends Error {
  readonly status: 401 | 403;
  readonly headers: Record<string, string>;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.code);
    this.name = "PolarisKeyError";
    this.status = problem.status;
    this.headers = problem.headers;
    this.problem = problem;
  }
}

const SEGMENTS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const utf8 = new TextEncoder();

/**
 * A raw value of the two credential headers longer than this is bounded before anything splits
 * it at commas (§14.1 reads elements, and a value this long can only be a probe): it becomes one
 * element over the cap, which the verdict refuses as `license_invalid`. Four times the cap leaves
 * room for every legitimate proxy-joined form.
 */
const MAX_RAW_FIELD = 4 * BACKEND_LICENSE_MAX_BYTES;
/** The longest `Accept-Language` read; a longer one is cut (the language falls back to English). */
const MAX_LANGUAGE_FIELD = 2048;

function bounded(fields: [string, string][]): [string, string][] {
  for (const field of fields) {
    if (field[1].length <= MAX_RAW_FIELD) continue;
    const name = field[0].toLowerCase();
    if (
      name === HEADER_LICENSE.toLowerCase() ||
      name === HEADER_DEVICE.toLowerCase()
    )
      field[1] = "x".repeat(BACKEND_LICENSE_MAX_BYTES + 1);
  }
  return fields;
}

/** Every header field of `input` as `[name, value]`. */
export function headerFields(input: HeadersInput): [string, string][] {
  if (typeof Request !== "undefined" && input instanceof Request)
    return bounded([...input.headers]);
  if (typeof (input as Iterable<unknown>)[Symbol.iterator] === "function")
    return bounded(
      [...(input as Iterable<readonly [string, string]>)].map(([n, v]) => [
        n,
        v,
      ]),
    );
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(
    input as Record<string, string | readonly string[] | undefined>,
  )) {
    if (value === undefined) continue;
    if (typeof value === "string") out.push([name, value]);
    else for (const v of value) out.push([name, v]);
  }
  return bounded(out);
}

const CONFIG_HINT =
  "pass the object `pkey sdk --lang node --write` generates: createPolarisKey({ config: polarisConfig })";
/** A raw Ed25519 public key, base64url: what a pin is. */
const PIN = /^[A-Za-z0-9_-]{43}$/;

function checkConfig(configs: readonly PolarisServerConfig[]): void {
  if (configs.length === 0)
    throw new TypeError(
      `createPolarisKey: config names no product; ${CONFIG_HINT}`,
    );
  const seen = new Set<string>();
  for (const c of configs) {
    if (typeof c !== "object" || c === null)
      throw new TypeError(
        `createPolarisKey: config is missing; ${CONFIG_HINT}`,
      );
    if (typeof c.productSlug !== "string" || c.productSlug === "")
      throw new TypeError(
        `createPolarisKey: config.productSlug is missing; ${CONFIG_HINT}`,
      );
    if (seen.has(c.productSlug))
      throw new TypeError(
        `createPolarisKey: product "${c.productSlug}" is configured twice`,
      );
    seen.add(c.productSlug);
    const pins = c.trust?.pinnedKeys;
    if (typeof pins !== "object" || pins === null)
      throw new TypeError(
        `createPolarisKey: config for "${c.productSlug}" has no trust.pinnedKeys; run \`pkey sdk --lang node --write\` to write them`,
      );
    const entries = Object.entries(pins);
    // With no pin nothing can verify: every request would be refused license_invalid.
    if (entries.length === 0)
      throw new TypeError(
        `createPolarisKey: trust.pinnedKeys for "${c.productSlug}" is empty, so no license could verify; run \`pkey sdk --lang node --write\` to write the product's keys`,
      );
    for (const [kid, key] of entries)
      if (typeof key !== "string" || !PIN.test(key))
        throw new TypeError(
          `createPolarisKey: the pinned key "${kid}" for "${c.productSlug}" is not a raw Ed25519 public key (43 base64url characters); copy it from Core > Keys & secrets or rerun \`pkey sdk\``,
        );
    if (c.baseUrl !== undefined && !/^https?:\/\/[^/\s]+/i.test(c.baseUrl))
      throw new TypeError(
        `createPolarisKey: baseUrl "${c.baseUrl}" for "${c.productSlug}" is not an http(s) origin such as https://key.plrs.im`,
      );
    // A product with no Licence service issues no licence document: refuse to start rather than
    // refuse every request later.
    if (c.expectedServices && !c.expectedServices.includes("license"))
      throw new TypeError(
        `createPolarisKey: "${c.productSlug}" does not use the license service, so it issues no license document to check`,
      );
  }
}

interface CacheEntry {
  verdict: BackendVerdict;
  /** Epoch seconds: the last second the entry is still fresh. */
  deadline: number;
  generation: number;
}

/** Build a product backend core. Throws only on invalid options. */
export function createPolarisKey(options: PolarisKeyOptions): PolarisKey {
  if (typeof options !== "object" || options === null || !options.config)
    throw new TypeError(
      `createPolarisKey: the options need a config; ${CONFIG_HINT}`,
    );
  const configs = Array.isArray(options.config)
    ? (options.config as readonly PolarisServerConfig[])
    : [options.config as PolarisServerConfig];
  checkConfig(configs);
  const products = configs.map((c) => c.productSlug);
  const maxAge = options.maxAgeSeconds ?? null;
  if (maxAge !== null && !(Number.isSafeInteger(maxAge) && maxAge >= 0))
    throw new TypeError(
      "createPolarisKey: maxAgeSeconds is not a non-negative integer",
    );
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  if (
    options.trustRefresh !== false &&
    !options.fetch &&
    typeof globalThis.fetch !== "function"
  )
    throw new TypeError(
      "createPolarisKey: this runtime has no global fetch for the trust refresh; pass `fetch` or set `trustRefresh: false` to run on the pinned keys alone",
    );
  const doFetch = options.fetch ?? ((...a) => globalThis.fetch(...a));
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
  const cache = new Map<string, CacheEntry>();
  /** Bumped whenever a trust set changes: a cached document is dropped with it (§14.4). */
  let generation = 0;

  const trusts = new Map<string, ProductTrust>(
    configs.map((c) => [
      c.productSlug,
      new ProductTrust({
        product: c.productSlug,
        baseUrl: (c.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        pinned: { ...c.trust.pinnedKeys },
        refresh: options.trustRefresh !== false,
        fetch: doFetch,
        now,
        waitUntil: options.waitUntil,
        onChange: () => {
          generation++;
          cache.clear();
        },
        debug: options.debug,
      }),
    ]),
  );
  const trustSets = () =>
    Object.fromEntries([...trusts].map(([p, t]) => [p, t.set]));

  const problemOf = (
    code: BackendRefusalCode,
    input: HeadersInput | undefined,
  ): Problem => {
    const fields = input ? headerFields(input) : [];
    const languages = backendHeaderElements(
      fields.filter(
        ([n, v]) =>
          v.length <= MAX_RAW_FIELD || n.toLowerCase() !== "accept-language",
      ),
      "Accept-Language",
    );
    const problem = backendProblem(code, {
      acceptLanguage:
        languages.length > 0
          ? languages.join(", ").slice(0, MAX_LANGUAGE_FIELD)
          : null,
      realm: products[0]!,
      copy: BACKEND_COPY,
    });
    return { ...problem, code };
  };

  const report = (
    code: BackendRefusalCode | null,
    step: VerdictStep,
    jws: string | null,
    context: BackendContext | null,
  ): void => {
    options.onVerdict?.(code, step);
    if (!options.debug) return;
    const kid =
      jws && jws.length <= BACKEND_LICENSE_MAX_BYTES ? jwsHeaderKid(jws) : null;
    options.debug(
      `polaris-key: ${step} ${code ?? "ok"} kid=${kid ?? "-"} aud=${context?.license.product ?? "-"} device=${context ? shortHash(context.license.deviceId) : "-"}`,
    );
  };

  const stepOf = (code: BackendRefusalCode | null): VerdictStep =>
    code === null
      ? "pass"
      : code === "license_required"
        ? "credential"
        : code === "license_invalid"
          ? "verify"
          : code === "license_stale"
            ? "fresh"
            : "require";

  /** Steps 1 to 5 for the request's headers: the cache, then the verdict. */
  const decide = async (
    fields: [string, string][],
  ): Promise<BackendVerdict> => {
    const licenseElements = backendHeaderElements(fields, HEADER_LICENSE);
    const deviceElements = backendHeaderElements(fields, HEADER_DEVICE);
    const at = now();
    // The 900 s refresh runs in the background, whether or not the request is cached.
    for (const t of trusts.values()) t.refreshIfDue();
    let key: string | null = null;
    if (
      licenseElements.length === 1 &&
      deviceElements.length <= 1 &&
      utf8.encode(licenseElements[0]!).length <= BACKEND_LICENSE_MAX_BYTES
    ) {
      key = await sha256Base64Url(
        utf8.encode(`${licenseElements[0]}\n${deviceElements[0] ?? ""}`),
      );
      const hit = cache.get(key);
      if (hit && hit.generation === generation && at <= hit.deadline) {
        // Refresh the LRU position; the age is the document's now, not the cached one.
        cache.delete(key);
        cache.set(key, hit);
        return withAge(hit.verdict, at);
      }
      if (hit) cache.delete(key);
      // An unknown kid waits for one fetch at most.
      const jws = licenseElements[0]!;
      if (SEGMENTS.test(jws)) {
        const kid = jwsHeaderKid(jws);
        if (kid !== null && ![...trusts.values()].some((t) => t.has(kid)))
          await Promise.all(
            [...trusts.values()].map((t) => t.refreshForUnknownKid()),
          );
      }
    }
    // The trust set this verification runs under. A cache insert from a verification that began
    // under an older set is refused below: the key that verified the document may be gone.
    const startedUnder = generation;
    const verdict = await backendVerdict({
      headers: fields,
      now: at,
      options: { products, maxAgeSeconds: maxAge },
      trust: trustSets(),
    });
    if (
      verdict.status === 200 &&
      verdict.document &&
      key !== null &&
      // The trust set did not change while this document verified.
      startedUnder === generation
    ) {
      const doc = verdict.document;
      const deadline =
        maxAge === null
          ? Math.min(doc.expiresAt + CLOCK_SKEW_SECONDS, doc.graceUntil)
          : Math.min(
              doc.issuedAt + maxAge + CLOCK_SKEW_SECONDS,
              doc.graceUntil,
            );
      cache.set(key, { verdict, deadline, generation: startedUnder });
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    }
    return verdict;
  };

  return {
    problem: (code, input) => problemOf(code, input),
    refuse(problem, input) {
      const p =
        typeof problem === "string" ? problemOf(problem, input) : problem;
      return new Response(JSON.stringify(p.body), {
        status: p.status,
        headers: p.headers,
      });
    },
    require(auth, requirements, input) {
      return applyRequirements(auth, requirements, input, true);
    },
    async authenticate(input, route) {
      const fields = headerFields(input);
      const verdict = await decide(fields);
      const jws = backendHeaderElements(fields, HEADER_LICENSE)[0] ?? null;
      const context = verdict.context;
      const base: PolarisAuth = {
        license:
          context && verdict.document
            ? new PolarisLicense(context.license, verdict.document)
            : null,
        user: context?.user ?? null,
        problem: verdict.code === null ? null : problemOf(verdict.code, input),
      };
      // Step 6, in the order the route lists its requirements.
      const auth = applyRequirements(base, route?.require ?? [], input, false);
      const code = auth.problem?.code ?? null;
      report(code, stepOf(code), jws, context);
      return auth;
    },
  };

  /** Step 6 on an authenticated request. A request already refused at steps 1 to 5 stays so. */
  function applyRequirements(
    auth: PolarisAuth,
    requirements: readonly Requirement[],
    input: HeadersInput | undefined,
    reportRefusal: boolean,
  ): PolarisAuth {
    if (auth.problem !== null || auth.license === null) return auth;
    for (const r of requirements) {
      let code: BackendRefusalCode | null = null;
      if (r.kind === "signIn") {
        if (auth.user === null) code = "sign_in_required";
      } else if (r.kind === "tier") {
        const tier = auth.license.tier;
        if (tier === null || !r.tiers.includes(tier)) code = "not_entitled";
      } else {
        const value = auth.license.value(r.name);
        const granted = r.test
          ? value !== null && safeTest(r.test, value)
          : auth.license.isEntitled(r.name);
        if (!granted) code = "not_entitled";
      }
      if (code !== null) {
        if (reportRefusal) options.onVerdict?.(code, "require");
        return { ...auth, problem: problemOf(code, input) };
      }
    }
    return auth;
  }
}

function safeTest(test: (value: unknown) => boolean, value: unknown): boolean {
  try {
    return test(value) === true;
  } catch {
    return false;
  }
}

/** A cached 200 for a later `now`: the age moves, nothing else does. */
function withAge(verdict: BackendVerdict, at: number): BackendVerdict {
  if (!verdict.context) return verdict;
  const license = verdict.context.license;
  return {
    ...verdict,
    context: {
      ...verdict.context,
      license: { ...license, ageSeconds: Math.max(0, at - license.issuedAt) },
    },
  };
}

/** Eight hex characters of a SHA-256-like fold of `s`, for a debug line. Not a secret
 *  comparison and not collision-resistant: it only lets a log line tell devices apart. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
