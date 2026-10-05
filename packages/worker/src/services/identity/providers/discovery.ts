/**
 * OIDC discovery, JWKS and ID-token verification for the login card's OIDC providers (Google and
 * Apple; I-06, S-16 §5.4 item 2 "broker confusion").
 *
 * - **Discovery is data, not trust.** The document is fetched through the gated door
 *   (`net.ts`), its `issuer` must equal the provider's issuer exactly (OIDC Discovery §4.3), and
 *   every URL it names (authorize, token, JWKS) must pass the SSRF rule and the provider's host
 *   allowlist before it is used, so a poisoned or spoofed document cannot aim the token POST
 *   (which carries the client secret) or the key fetch anywhere else.
 * - **RFC 9207.** `authorization_response_iss_parameter_supported` is recorded; a provider that
 *   advertises it must send `iss` on the authorization response, and an `iss` that is present
 *   must equal the issuer, whatever the document says (`checkAuthorizationIss`).
 * - **Audience, exactly.** `verifyProviderIdToken` takes the audience as a required argument
 *   with no default and refuses an empty one, so a token is checked against the ONE client it
 *   was minted for: the login card passes its platform client id, I-13 will pass a developer's
 *   bundle id, and neither token passes the other's check. A multi-audience token must name the
 *   expected client as `azp`, and an `azp` that is present must equal it.
 * - **Freshness and replay.** `iat` no older than `ID_TOKEN_MAX_AGE`, the flow's `nonce` when
 *   one was sent. Upstream tokens are verified once and never stored (S-16 §5.5).
 */

import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { ID_TOKEN_CLOCK_TOLERANCE, ID_TOKEN_MAX_AGE } from "../idToken.js";
import {
  gatedJson,
  PROVIDER_HOSTS,
  providerUrlProblem,
  type ProviderFetch,
} from "./net.js";

/** The OIDC providers of the login card. */
export type OidcProviderKind = "google" | "apple";

/** Each provider's issuer: the discovery base and the `iss` its ID tokens carry. */
export const PROVIDER_ISSUERS: Readonly<Record<OidcProviderKind, string>> = {
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
};

/** Every `iss` value a provider's ID tokens may carry. Google documents a scheme-less form too. */
export const PROVIDER_TOKEN_ISSUERS: Readonly<
  Record<OidcProviderKind, readonly string[]>
> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};

/** The signature algorithms the login card accepts from Google and Apple (both sign RS256). */
export const PROVIDER_ID_TOKEN_ALGS = ["RS256", "ES256"];

export class ProviderVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderVerifyError";
  }
}

export interface DiscoveredProvider {
  kind: OidcProviderKind;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** RFC 9207: the provider sends `iss` on every authorization response. */
  issParameterSupported: boolean;
  responseModes: readonly string[];
}

/** How old an Apple notification may be (Apple retries a failed delivery). */
export const NOTIFICATION_MAX_AGE = "7d";

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
/** A token whose `kid` the cached set lacks triggers at most one refetch per this interval. */
const JWKS_REFRESH_FLOOR_MS = 60 * 1000;

const discoveryCache = new Map<
  OidcProviderKind,
  { value: DiscoveredProvider; expires: number }
>();
const jwksCache = new Map<
  string,
  { value: JSONWebKeySet; expires: number; fetchedAt: number }
>();

/** Drop every cached discovery document and key set (tests; a rotation drill). */
export function resetProviderCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function endpoint(
  kind: OidcProviderKind,
  doc: Record<string, unknown>,
  field: string,
): string {
  const raw = doc[field];
  const problem = providerUrlProblem(raw, PROVIDER_HOSTS[kind]);
  if (problem) {
    throw new ProviderVerifyError(
      `${kind} discovery ${field} refused: ${problem}`,
    );
  }
  return raw as string;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** The provider's discovery document, validated. Cached for an hour. */
export async function discoverProvider(
  kind: OidcProviderKind,
  opts: { fetch?: ProviderFetch; nowMs?: number } = {},
): Promise<DiscoveredProvider> {
  const nowMs = opts.nowMs ?? Date.now();
  const hit = discoveryCache.get(kind);
  if (hit && hit.expires > nowMs) return hit.value;

  const issuer = PROVIDER_ISSUERS[kind];
  const doc = await gatedJson(
    kind,
    `${issuer}/.well-known/openid-configuration`,
    { headers: { accept: "application/json" } },
    opts.fetch,
  );
  if (doc.issuer !== issuer) {
    throw new ProviderVerifyError(`${kind} discovery issuer mismatch`);
  }
  const value: DiscoveredProvider = {
    kind,
    issuer,
    authorizationEndpoint: endpoint(kind, doc, "authorization_endpoint"),
    tokenEndpoint: endpoint(kind, doc, "token_endpoint"),
    jwksUri: endpoint(kind, doc, "jwks_uri"),
    issParameterSupported:
      doc.authorization_response_iss_parameter_supported === true,
    responseModes: stringList(doc.response_modes_supported),
  };
  if (!stringList(doc.response_types_supported).includes("code")) {
    throw new ProviderVerifyError(`${kind} does not support the code flow`);
  }
  discoveryCache.set(kind, { value, expires: nowMs + DISCOVERY_TTL_MS });
  return value;
}

/**
 * RFC 9207 §2.4: refuse an authorization response whose `iss` is absent where the provider
 * promised one, or present and not the issuer the flow was started against (mix-up defence).
 */
export function checkAuthorizationIss(
  discovered: DiscoveredProvider,
  iss: string | null,
): void {
  if (iss === null) {
    if (discovered.issParameterSupported) {
      throw new ProviderVerifyError("authorization response lacks iss");
    }
    return;
  }
  if (iss !== discovered.issuer) {
    throw new ProviderVerifyError("authorization response iss mismatch");
  }
}

async function loadJwks(
  kind: OidcProviderKind,
  jwksUri: string,
  opts: { fetch?: ProviderFetch; nowMs: number; refresh: boolean },
): Promise<JSONWebKeySet> {
  const hit = jwksCache.get(jwksUri);
  if (hit && hit.expires > opts.nowMs) {
    const mayRefresh = opts.nowMs - hit.fetchedAt >= JWKS_REFRESH_FLOOR_MS;
    if (!opts.refresh || !mayRefresh) return hit.value;
  }
  const doc = await gatedJson(
    kind,
    jwksUri,
    { headers: { accept: "application/json" } },
    opts.fetch,
  );
  if (!Array.isArray(doc.keys)) {
    throw new ProviderVerifyError(`${kind} JWKS has no keys`);
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
  /** The flow's nonce, when the flow sent one. */
  nonce?: string;
  /**
   * `notification`: an Apple server-to-server event JWT. It carries no `sub` or `exp` of its own
   * (the subject is inside `events`) and Apple retries delivery, so `iat` may be up to
   * `NOTIFICATION_MAX_AGE` old instead of `ID_TOKEN_MAX_AGE`.
   */
  shape?: "id_token" | "notification";
  fetch?: ProviderFetch;
  nowMs?: number;
}

/**
 * Verify an ID token (or an Apple notification JWT) from `discovered`'s provider: signature
 * against the provider's JWKS, `iss`, the exact audience, `azp`, freshness and `nonce`.
 */
export async function verifyProviderIdToken(
  discovered: DiscoveredProvider,
  token: string,
  expect: IdTokenExpectations,
): Promise<JWTPayload> {
  if (typeof expect.audience !== "string" || expect.audience.trim() === "") {
    // Fail closed: there is no "any audience" mode.
    throw new ProviderVerifyError("no audience configured");
  }
  const nowMs = expect.nowMs ?? Date.now();
  const notification = expect.shape === "notification";
  const verifyWith = async (refresh: boolean): Promise<JWTPayload> => {
    const jwks = await loadJwks(discovered.kind, discovered.jwksUri, {
      fetch: expect.fetch,
      nowMs,
      refresh,
    });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: [...PROVIDER_TOKEN_ISSUERS[discovered.kind]],
      audience: expect.audience,
      algorithms: PROVIDER_ID_TOKEN_ALGS,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: notification ? NOTIFICATION_MAX_AGE : ID_TOKEN_MAX_AGE,
      requiredClaims: notification ? ["iat"] : ["sub", "exp", "iat"],
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
    if (err instanceof ProviderVerifyError) throw err;
    throw new ProviderVerifyError(
      `${discovered.kind} token refused: ${err instanceof Error ? err.message : "invalid"}`,
    );
  }

  const aud = payload.aud;
  if (Array.isArray(aud) && aud.length > 1 && payload.azp !== expect.audience) {
    throw new ProviderVerifyError("multi-audience token without matching azp");
  }
  if (payload.azp !== undefined && payload.azp !== expect.audience) {
    throw new ProviderVerifyError("azp mismatch");
  }
  if (
    !notification &&
    (typeof payload.sub !== "string" || payload.sub.trim() === "")
  ) {
    throw new ProviderVerifyError("token has no subject");
  }
  if (expect.nonce !== undefined && payload.nonce !== expect.nonce) {
    throw new ProviderVerifyError("nonce mismatch");
  }
  return payload;
}

/** A provider's "email verified" assertion: the boolean `true`, or Apple's string `"true"`. */
export function providerAssertsVerified(v: unknown): boolean {
  return v === true || v === "true";
}
