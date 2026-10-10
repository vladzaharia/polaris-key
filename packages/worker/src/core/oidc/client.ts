/**
 * The Worker's one OpenID Connect relying-party client (I-30; plans/I-27.md §2.3).
 *
 * Every OIDC sign-in the Worker completes goes through this module: the console's IdP
 * (`console/auth.ts`), the platform and product connections (`/login/sso/<id>` and `/callback`),
 * the legacy product engine (`services/identity/oidc.ts`, until I-32b) and the login card's
 * built-in Google and Apple providers (`services/identity/providers/`). Steam stays OpenID 2.0 and
 * uses only the gated fetch below. Before I-30 three of those sites each hard-coded Pocket ID's
 * paths and verified keys through jose's remote key-set helper, which dials outside any guard.
 *
 * ── THE GATED FETCH ─────────────────────────────────────────────────────────────────────────
 *
 * Every URL this client dials (a discovery document, a JWKS, a token endpoint, and the
 * DNS-over-HTTPS host of domain verification) passes two gates before a socket opens:
 *
 *   1. **SSRF.** `https:` only, no credentials in the URL, the default port only, and never a
 *      private, loopback, link-local or otherwise reserved address literal (the manifest
 *      package's `isSafeIssuerUrl`, applied to the origin).
 *   2. **The allowlist.** The host must be one the caller allowed for this relying party: its
 *      issuer host and its configured `jwks_uri` host for a connection (`connectionHosts`), the
 *      provider's known hosts for a built-in. A discovery document is data from the network; a
 *      URL inside it that names any other host is refused, not followed.
 *
 * Redirects are never followed (`redirect: "manual"`; a 3xx is a failure), so a gated URL cannot
 * hand the request, or the client secret it carries, on to an ungated `Location`. Bodies are read
 * under a byte cap and every call has a timeout.
 *
 * ── THE CHECKS ──────────────────────────────────────────────────────────────────────────────
 *
 *   - **Discovery is data, not trust.** Its `issuer` must equal the configured issuer exactly
 *     (OIDC Discovery §4.3), and it must offer the code flow.
 *   - **RFC 9207.** An issuer that advertises `authorization_response_iss_parameter_supported`
 *     must send `iss` on the authorization response; an `iss` that is present must equal the
 *     issuer whatever the document says (mix-up defence).
 *   - **PKCE S256, state and nonce.** `newFlowSecrets` mints all four values; the flow's own
 *     store keeps them single-use. A nonce that was sent must come back.
 *   - **Keys.** The JWKS is fetched through the gate, cached, and verified with jose's
 *     `createLocalJWKSet`. A token whose `kid` the cached set lacks refetches at most once a
 *     minute (a key rotation).
 *   - **Audience, exactly.** The audience is required with no default. A multi-audience token
 *     must name the client as `azp`, and an `azp` that is present must equal it.
 *   - **Freshness.** `iat` no older than `ID_TOKEN_MAX_AGE`: `exp` is entirely the IdP's choice,
 *     so a token minted long before this exchange is not replayable into a sign-in (R8-05d).
 */

import { isSafeIssuerUrl } from "@polaris-key/manifest";
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { pkcePair } from "../../platform/pkce.js";
import { randomToken } from "../../platform/random.js";
import { isRedirect, readCappedText } from "../readCapped.js";

// ── constants ────────────────────────────────────────────────────────────────────────────────

/** The signature algorithms an IdP may use on an ID token, by default. */
export const ALLOWED_ID_TOKEN_ALGS: readonly string[] = [
  "RS256",
  "ES256",
  "EdDSA",
];

/** Freshness ceiling on an ID token's `iat` (R8-05d). */
export const ID_TOKEN_MAX_AGE = "5m";
/** Seconds of clock skew allowed on `iat`, `exp` and `nbf`. */
export const ID_TOKEN_CLOCK_TOLERANCE = 300;

/** The largest answer the client reads: a discovery document or a JWKS is a few KB. */
export const OIDC_MAX_BYTES = 64 * 1024;
/** How long one outbound call may take. */
export const OIDC_TIMEOUT_MS = 10_000;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
/** A token whose `kid` the cached set lacks triggers at most one refetch per this interval. */
const JWKS_REFRESH_FLOOR_MS = 60 * 1000;

// ── errors ───────────────────────────────────────────────────────────────────────────────────

/** A refused URL, a redirect, a timeout, an oversized or malformed answer, or a non-2xx. */
export class OidcNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcNetworkError";
  }
}

/**
 * The IdP refused the grant itself (RFC 6749 §5.2 `invalid_grant`: a replayed, expired or
 * foreign authorization code). The sign-in could not be verified; the IdP is up.
 */
export class OidcGrantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcGrantRefusedError";
  }
}

/** Discovery, the authorization response or the ID token failed a check. */
export class OidcVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcVerifyError";
  }
}

// ── the gated fetch ──────────────────────────────────────────────────────────────────────────

/** The fetch the client uses; tests pass a fake. */
export type OidcFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const defaultFetch: OidcFetch = (input, init) => fetch(input, init);

/** A host as the allowlist compares it: lower case, trailing dots removed. */
export function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

/** Why `raw` may not be dialled with `allowedHosts`, or `null` when it may. */
export function oidcUrlProblem(
  raw: unknown,
  allowedHosts: readonly string[],
): string | null {
  if (typeof raw !== "string" || !raw) return "not a URL";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "not https";
  if (url.username || url.password) return "embeds credentials";
  if (url.port !== "") return "names a port";
  // The reserved-address rule, on the origin alone (an endpoint may carry a query string, which
  // the issuer rule refuses for its own reasons).
  if (!isSafeIssuerUrl(url.origin)) return "reserved or private address";
  const host = canonicalHost(url.hostname);
  if (!allowedHosts.some((h) => canonicalHost(h) === host)) {
    return "host not on the allowlist";
  }
  return null;
}

/**
 * Dial a gated URL and return the status with the body as text (capped). Throws
 * `OidcNetworkError` for a refused URL, a redirect, a timeout or an oversized body; a non-2xx
 * status is returned for the caller to judge. `label` names the relying party in errors only.
 */
export async function gatedFetch(
  label: string,
  url: string,
  init: RequestInit,
  allowedHosts: readonly string[],
  fetchImpl: OidcFetch = defaultFetch,
): Promise<{ status: number; body: string }> {
  const problem = oidcUrlProblem(url, allowedHosts);
  if (problem) {
    throw new OidcNetworkError(`refused ${label} URL: ${problem}`);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
  } catch {
    throw new OidcNetworkError(`${label} request failed`);
  }
  if (isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    throw new OidcNetworkError(`${label} answered a redirect`);
  }
  const body = await readCappedText(
    res,
    OIDC_MAX_BYTES,
    (detail) => new OidcNetworkError(`${label} response too large (${detail})`),
  );
  return { status: res.status, body };
}

/** `gatedFetch` for a JSON answer: a 2xx with an object body, or an error. */
export async function gatedJson(
  label: string,
  url: string,
  init: RequestInit,
  allowedHosts: readonly string[],
  fetchImpl?: OidcFetch,
): Promise<Record<string, unknown>> {
  const { status, body } = await gatedFetch(
    label,
    url,
    init,
    allowedHosts,
    fetchImpl,
  );
  if (status < 200 || status >= 300) {
    if (status === 400 && oauthError(body) === "invalid_grant") {
      throw new OidcGrantRefusedError(`${label} refused the grant`);
    }
    throw new OidcNetworkError(`${label} answered ${status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new OidcNetworkError(`${label} answered invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OidcNetworkError(`${label} answered a non-object`);
  }
  return parsed as Record<string, unknown>;
}

/** The OAuth `error` code of an error body, or `null`. */
function oauthError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

// ── the relying party ────────────────────────────────────────────────────────────────────────

/** One relying-party registration at one issuer. */
export interface RelyingParty {
  /** Names the relying party in errors and cache keys: `google`, `connection:<id>`, … */
  label: string;
  /** The discovery base, compared exactly with the document's `issuer`. */
  issuer: string;
  /** Every `iss` an ID token may carry. Defaults to `[issuer]`. */
  tokenIssuers?: readonly string[];
  clientId: string;
  /** Sent on the token request when set (`client_secret_post`). */
  clientSecret?: string | null;
  /** The hosts every dialled URL must be on. */
  allowedHosts: readonly string[];
  /** A configured JWKS URL, used in place of the discovered one (token-only issuers, I-32). */
  jwksUri?: string | null;
  /** Accepted signature algorithms. Defaults to `ALLOWED_ID_TOKEN_ALGS`. */
  algorithms?: readonly string[];
}

/**
 * A connection's allowlist: its issuer's host and its configured `jwks_uri`'s host, nothing else
 * (plans/I-27.md §2.3 "Gated hosts"). An unparseable value adds nothing, so it fails closed.
 */
export function connectionHosts(
  issuer: string,
  jwksUri?: string | null,
): string[] {
  const hosts = new Set<string>();
  for (const raw of [issuer, jwksUri]) {
    if (!raw) continue;
    try {
      hosts.add(canonicalHost(new URL(raw).hostname));
    } catch {
      // Not a URL: no host is allowed for it.
    }
  }
  return [...hosts];
}

/**
 * The relying party of a Worker-configured client (the console's `ADMIN_OIDC_*`, the legacy
 * engine's `PLATFORM_OIDC_*`): its allowlist is the issuer's host alone.
 */
export function issuerRelyingParty(
  label: string,
  cfg: { issuer: string; clientId: string; clientSecret?: string | null },
): RelyingParty {
  return {
    label,
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret ?? null,
    allowedHosts: connectionHosts(cfg.issuer),
  };
}

export interface DiscoveredIssuer {
  label: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** RFC 9207: the issuer sends `iss` on every authorization response. */
  issParameterSupported: boolean;
  responseModes: readonly string[];
  /** The allowlist the document was checked against; later calls use the same one. */
  allowedHosts: readonly string[];
}

const discoveryCache = new Map<
  string,
  { value: DiscoveredIssuer; expires: number }
>();
const jwksCache = new Map<
  string,
  { value: JSONWebKeySet; expires: number; fetchedAt: number }
>();

/** Drop every cached discovery document and key set (tests; a rotation drill). */
export function resetOidcClientCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function cacheKey(rp: RelyingParty): string {
  // A document checked against one allowlist is never reused under another.
  return [
    rp.issuer,
    rp.jwksUri ?? "",
    [...rp.allowedHosts].map(canonicalHost).sort().join(","),
  ].join("\n");
}

function documentUrl(
  rp: RelyingParty,
  doc: Record<string, unknown>,
  field: string,
): string {
  const raw = doc[field];
  const problem = oidcUrlProblem(raw, rp.allowedHosts);
  if (problem) {
    throw new OidcVerifyError(
      `${rp.label} discovery ${field} refused: ${problem}`,
    );
  }
  return raw as string;
}

/** The issuer's discovery document, validated. Cached for an hour per relying party. */
export async function discover(
  rp: RelyingParty,
  opts: { fetch?: OidcFetch; nowMs?: number } = {},
): Promise<DiscoveredIssuer> {
  const nowMs = opts.nowMs ?? Date.now();
  const key = cacheKey(rp);
  const hit = discoveryCache.get(key);
  if (hit && hit.expires > nowMs) return hit.value;

  const doc = await gatedJson(
    rp.label,
    `${rp.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    { headers: { accept: "application/json" } },
    rp.allowedHosts,
    opts.fetch,
  );
  if (doc.issuer !== rp.issuer) {
    throw new OidcVerifyError(`${rp.label} discovery issuer mismatch`);
  }
  if (!stringList(doc.response_types_supported).includes("code")) {
    throw new OidcVerifyError(`${rp.label} does not support the code flow`);
  }
  const jwksUri = rp.jwksUri ?? documentUrl(rp, doc, "jwks_uri");
  if (rp.jwksUri) {
    const problem = oidcUrlProblem(rp.jwksUri, rp.allowedHosts);
    if (problem) {
      throw new OidcVerifyError(`${rp.label} jwks_uri refused: ${problem}`);
    }
  }
  const value: DiscoveredIssuer = {
    label: rp.label,
    issuer: rp.issuer,
    authorizationEndpoint: documentUrl(rp, doc, "authorization_endpoint"),
    tokenEndpoint: documentUrl(rp, doc, "token_endpoint"),
    jwksUri,
    issParameterSupported:
      doc.authorization_response_iss_parameter_supported === true,
    responseModes: stringList(doc.response_modes_supported),
    allowedHosts: [...rp.allowedHosts],
  };
  discoveryCache.set(key, { value, expires: nowMs + DISCOVERY_TTL_MS });
  return value;
}

/**
 * RFC 9207 §2.4: refuse an authorization response whose `iss` is absent where the issuer
 * promised one, or present and not the issuer the flow was started against.
 */
export function checkAuthorizationIss(
  discovered: Pick<DiscoveredIssuer, "issuer" | "issParameterSupported">,
  iss: string | null,
): void {
  if (iss === null) {
    if (discovered.issParameterSupported) {
      throw new OidcVerifyError("authorization response lacks iss");
    }
    return;
  }
  if (iss !== discovered.issuer) {
    throw new OidcVerifyError("authorization response iss mismatch");
  }
}

/** Fresh `state`, `nonce` and a PKCE S256 pair for one authorization request. */
export async function newFlowSecrets(): Promise<{
  state: string;
  nonce: string;
  verifier: string;
  challenge: string;
}> {
  const { verifier, challenge } = await pkcePair();
  return {
    state: randomToken(16),
    nonce: randomToken(16),
    verifier,
    challenge,
  };
}

/** The authorization request URL: the code flow with PKCE S256, `state` and `nonce`. */
export function authorizationUrl(
  discovered: Pick<DiscoveredIssuer, "authorizationEndpoint">,
  rp: Pick<RelyingParty, "clientId">,
  flow: {
    redirectUri: string;
    scope: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    /** Extra parameters (`prompt`, `response_mode`, `login_hint`). */
    extra?: Readonly<Record<string, string>>;
  },
): string {
  const u = new URL(discovered.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", rp.clientId);
  u.searchParams.set("redirect_uri", flow.redirectUri);
  u.searchParams.set("scope", flow.scope);
  u.searchParams.set("state", flow.state);
  u.searchParams.set("nonce", flow.nonce);
  u.searchParams.set("code_challenge", flow.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(flow.extra ?? {})) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

/**
 * Redeem an authorization code at the discovered token endpoint (through the gate). Answers the
 * token response; `id_token` is checked to be a string. `clientSecret` overrides the relying
 * party's (Apple mints a fresh client assertion per request).
 */
export async function exchangeCode(
  discovered: DiscoveredIssuer,
  rp: Pick<RelyingParty, "label" | "clientId" | "clientSecret">,
  grant: { code: string; redirectUri: string; codeVerifier: string },
  opts: { fetch?: OidcFetch; clientSecret?: string | null } = {},
): Promise<Record<string, unknown> & { id_token: string }> {
  const secret = opts.clientSecret ?? rp.clientSecret ?? null;
  const tokens = await gatedJson(
    rp.label,
    discovered.tokenEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: grant.code,
        redirect_uri: grant.redirectUri,
        client_id: rp.clientId,
        code_verifier: grant.codeVerifier,
        ...(secret ? { client_secret: secret } : {}),
      }).toString(),
    },
    discovered.allowedHosts,
    opts.fetch,
  );
  if (typeof tokens.id_token !== "string") {
    throw new OidcVerifyError(`${rp.label} token response has no id_token`);
  }
  return tokens as Record<string, unknown> & { id_token: string };
}

async function loadJwks(
  label: string,
  jwksUri: string,
  allowedHosts: readonly string[],
  opts: { fetch?: OidcFetch; nowMs: number; refresh: boolean },
): Promise<JSONWebKeySet> {
  const hit = jwksCache.get(jwksUri);
  if (hit && hit.expires > opts.nowMs) {
    const mayRefresh = opts.nowMs - hit.fetchedAt >= JWKS_REFRESH_FLOOR_MS;
    if (!opts.refresh || !mayRefresh) return hit.value;
  }
  const doc = await gatedJson(
    label,
    jwksUri,
    { headers: { accept: "application/json" } },
    allowedHosts,
    opts.fetch,
  );
  if (!Array.isArray(doc.keys)) {
    throw new OidcVerifyError(`${label} JWKS has no keys`);
  }
  const value = { keys: doc.keys } as JSONWebKeySet;
  jwksCache.set(jwksUri, {
    value,
    expires: opts.nowMs + JWKS_TTL_MS,
    fetchedAt: opts.nowMs,
  });
  return value;
}

export interface IdTokenExpectations {
  /** The ONE client this token must have been minted for. Required; never defaulted. */
  audience: string;
  /** The flow's nonce. When set, the token must carry exactly this value. */
  nonce?: string;
  /** Required claims beyond the defaults (`sub`, `exp`, `iat`). */
  requiredClaims?: readonly string[];
  /** `iat` ceiling; defaults to `ID_TOKEN_MAX_AGE`. */
  maxTokenAge?: string;
  /** The token has no subject of its own (an Apple notification): `sub` and `exp` not required. */
  subjectless?: boolean;
  fetch?: OidcFetch;
  nowMs?: number;
}

/**
 * Verify an ID token from `discovered`'s issuer: signature against its JWKS (gated, cached,
 * `createLocalJWKSet`), `iss`, the exact audience, `azp`, algorithm, freshness and `nonce`.
 */
export async function verifyIdToken(
  discovered: DiscoveredIssuer,
  rp: Pick<RelyingParty, "label" | "issuer" | "tokenIssuers" | "algorithms">,
  token: string,
  expect: IdTokenExpectations,
): Promise<JWTPayload> {
  if (typeof expect.audience !== "string" || expect.audience.trim() === "") {
    // Fail closed: there is no "any audience" mode.
    throw new OidcVerifyError("no audience configured");
  }
  const nowMs = expect.nowMs ?? Date.now();
  const issuers = [...(rp.tokenIssuers ?? [rp.issuer])];
  const verifyWith = async (refresh: boolean): Promise<JWTPayload> => {
    const jwks = await loadJwks(
      discovered.label,
      discovered.jwksUri,
      discovered.allowedHosts,
      { fetch: expect.fetch, nowMs, refresh },
    );
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: issuers,
      audience: expect.audience,
      algorithms: [...(rp.algorithms ?? ALLOWED_ID_TOKEN_ALGS)],
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: expect.maxTokenAge ?? ID_TOKEN_MAX_AGE,
      requiredClaims: [
        ...(expect.subjectless ? ["iat"] : ["sub", "exp", "iat"]),
        ...(expect.requiredClaims ?? []),
      ],
    });
    return payload;
  };
  let payload: JWTPayload;
  try {
    try {
      payload = await verifyWith(false);
    } catch (err) {
      // A key rotation: the cached set lacks the token's kid. Refetch once and retry.
      if (err instanceof joseErrors.JWKSNoMatchingKey) {
        payload = await verifyWith(true);
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof OidcVerifyError || err instanceof OidcNetworkError) {
      throw err;
    }
    throw new OidcVerifyError(
      `${rp.label} token refused: ${err instanceof Error ? err.message : "invalid"}`,
    );
  }

  const aud = payload.aud;
  if (Array.isArray(aud) && aud.length > 1 && payload.azp !== expect.audience) {
    throw new OidcVerifyError("multi-audience token without matching azp");
  }
  if (payload.azp !== undefined && payload.azp !== expect.audience) {
    throw new OidcVerifyError("azp mismatch");
  }
  if (
    !expect.subjectless &&
    (typeof payload.sub !== "string" || payload.sub.trim() === "")
  ) {
    throw new OidcVerifyError("token has no subject");
  }
  if (expect.nonce !== undefined && payload.nonce !== expect.nonce) {
    throw new OidcVerifyError("nonce mismatch");
  }
  return payload;
}

/**
 * One whole code redemption: RFC 9207 `iss`, the token request, and the ID token's verification
 * with the flow's nonce. What `/callback`, the console and the legacy engine call.
 */
export async function redeemAuthorizationCode(
  rp: RelyingParty,
  response: {
    code: string;
    iss: string | null;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  },
  opts: { fetch?: OidcFetch; nowMs?: number } = {},
): Promise<{ claims: JWTPayload; discovered: DiscoveredIssuer }> {
  const discovered = await discover(rp, opts);
  checkAuthorizationIss(discovered, response.iss);
  const tokens = await exchangeCode(
    discovered,
    rp,
    {
      code: response.code,
      redirectUri: response.redirectUri,
      codeVerifier: response.codeVerifier,
    },
    opts,
  );
  const claims = await verifyIdToken(discovered, rp, tokens.id_token, {
    audience: rp.clientId,
    nonce: response.nonce,
    fetch: opts.fetch,
    nowMs: opts.nowMs,
  });
  return { claims, discovered };
}
