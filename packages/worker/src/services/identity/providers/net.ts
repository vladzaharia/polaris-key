/**
 * The one outbound door of the login card's providers (I-06; S-16 §5.4 item 2).
 *
 * Every URL a provider module dials — a discovery document, a JWKS, a token endpoint, Steam's
 * OpenID endpoint and Web API — passes two gates before a socket opens:
 *
 *   1. **SSRF.** `https:` only (no localhost exception: these are production providers), no
 *      credentials in the URL, the default port only, and never a private, loopback, link-local
 *      or otherwise reserved address literal (the manifest package's `isSafeIssuerUrl`, the same
 *      rule the product OIDC sink applies).
 *   2. **The allowlist.** The host must be one the provider is known to use
 *      (`PROVIDER_HOSTS`). A discovery document is data from the network; a URL inside it that
 *      names any other host (or an internal one) is refused, not followed.
 *
 * Redirects are never followed (`redirect: "manual"`, a 3xx is a failure), so a gated URL cannot
 * hand the request on to an ungated `Location`. Bodies are read under a byte cap.
 *
 * I-30: the door itself is the one relying-party client's (`core/oidc/client.ts`); this module
 * keeps only the built-in providers' host lists and their names for its errors.
 */

import {
  gatedFetch as coreGatedFetch,
  gatedJson as coreGatedJson,
  OIDC_MAX_BYTES,
  OIDC_TIMEOUT_MS,
  OidcGrantRefusedError,
  OidcNetworkError,
  oidcUrlProblem,
  type OidcFetch,
} from "../../../core/oidc/client.js";
import type { SignInProviderKind } from "./config.js";

/** The hosts each provider's endpoints may live on. Exact host names, lower case. */
export const PROVIDER_HOSTS: Readonly<
  Record<SignInProviderKind, readonly string[]>
> = {
  google: [
    "accounts.google.com",
    "oauth2.googleapis.com",
    "www.googleapis.com",
    "openidconnect.googleapis.com",
  ],
  apple: ["appleid.apple.com"],
  steam: ["steamcommunity.com", "api.steampowered.com"],
};

/** The largest provider response this module reads (a discovery document or a JWKS is ~2 KB). */
export const PROVIDER_MAX_BYTES = OIDC_MAX_BYTES;

/** How long one outbound provider call may take. */
export const PROVIDER_TIMEOUT_MS = OIDC_TIMEOUT_MS;

/**
 * The provider refused the grant itself (RFC 6749 §5.2 `invalid_grant`). The core client's class
 * under the name the provider modules have always used.
 */
export const ProviderGrantRefusedError = OidcGrantRefusedError;
export type ProviderGrantRefusedError = OidcGrantRefusedError;

/** A refused URL, a redirect, a timeout or a malformed answer: the core client's class. */
export const ProviderNetworkError = OidcNetworkError;
export type ProviderNetworkError = OidcNetworkError;

/** Why `raw` may not be dialled with `allowedHosts`, or `null` when it may. */
export const providerUrlProblem = oidcUrlProblem;

/** The fetch a provider module uses; tests pass a fake. */
export type ProviderFetch = OidcFetch;

/**
 * Dial a gated URL for `kind` (its `PROVIDER_HOSTS`) through the core client's gated fetch, and
 * return the status with the body as text (capped).
 */
export async function gatedFetch(
  kind: SignInProviderKind,
  url: string,
  init: RequestInit,
  fetchImpl?: ProviderFetch,
): Promise<{ status: number; body: string }> {
  return coreGatedFetch(kind, url, init, PROVIDER_HOSTS[kind], fetchImpl);
}

/** `gatedFetch` for a JSON answer: a 2xx with an object body, or an error. */
export async function gatedJson(
  kind: SignInProviderKind,
  url: string,
  init: RequestInit,
  fetchImpl?: ProviderFetch,
): Promise<Record<string, unknown>> {
  return coreGatedJson(kind, url, init, PROVIDER_HOSTS[kind], fetchImpl);
}
