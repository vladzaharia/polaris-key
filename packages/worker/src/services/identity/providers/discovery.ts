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
 *
 * I-30: every check above is the one relying-party client's (`core/oidc/client.ts`); this module
 * only names the two providers' issuers, hosts and algorithms.
 */

import type { JWTPayload } from "jose";
import {
  checkAuthorizationIss as coreCheckAuthorizationIss,
  discover,
  OidcVerifyError,
  resetOidcClientCaches,
  verifyIdToken,
  type DiscoveredIssuer,
  type RelyingParty,
} from "../../../core/oidc/client.js";
import { PROVIDER_HOSTS, type ProviderFetch } from "./net.js";

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

/** A discovery, authorization-response or token check failed: the core client's class. */
export const ProviderVerifyError = OidcVerifyError;
export type ProviderVerifyError = OidcVerifyError;

export interface DiscoveredProvider extends DiscoveredIssuer {
  kind: OidcProviderKind;
}

/** How old an Apple notification may be (Apple retries a failed delivery). */
export const NOTIFICATION_MAX_AGE = "7d";

/** The built-in provider as a relying party of the one client (its client id is per call). */
function providerRelyingParty(kind: OidcProviderKind): RelyingParty {
  return {
    label: kind,
    issuer: PROVIDER_ISSUERS[kind],
    tokenIssuers: PROVIDER_TOKEN_ISSUERS[kind],
    clientId: "",
    allowedHosts: PROVIDER_HOSTS[kind],
    algorithms: PROVIDER_ID_TOKEN_ALGS,
  };
}

/** Drop every cached discovery document and key set (tests; a rotation drill). */
export function resetProviderCaches(): void {
  resetOidcClientCaches();
}

/** The provider's discovery document, validated. Cached for an hour. */
export async function discoverProvider(
  kind: OidcProviderKind,
  opts: { fetch?: ProviderFetch; nowMs?: number } = {},
): Promise<DiscoveredProvider> {
  return { ...(await discover(providerRelyingParty(kind), opts)), kind };
}

/**
 * RFC 9207 §2.4: refuse an authorization response whose `iss` is absent where the provider
 * promised one, or present and not the issuer the flow was started against (mix-up defence).
 */
export function checkAuthorizationIss(
  discovered: DiscoveredProvider,
  iss: string | null,
): void {
  coreCheckAuthorizationIss(discovered, iss);
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
 * Verify an ID token (or an Apple notification JWT) from `discovered`'s provider, through the
 * one client: signature against the provider's JWKS, `iss`, the exact audience, `azp`, freshness
 * and `nonce`.
 */
export async function verifyProviderIdToken(
  discovered: DiscoveredProvider,
  token: string,
  expect: IdTokenExpectations,
): Promise<JWTPayload> {
  const notification = expect.shape === "notification";
  return verifyIdToken(discovered, providerRelyingParty(discovered.kind), token, {
    audience: expect.audience,
    nonce: expect.nonce,
    subjectless: notification,
    maxTokenAge: notification ? NOTIFICATION_MAX_AGE : undefined,
    fetch: expect.fetch,
    nowMs: expect.nowMs,
  });
}

/** A provider's "email verified" assertion: the boolean `true`, or Apple's string `"true"`. */
export function providerAssertsVerified(v: unknown): boolean {
  return v === true || v === "true";
}
