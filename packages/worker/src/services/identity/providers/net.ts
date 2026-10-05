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
 */

import { isSafeIssuerUrl } from "@polaris-key/manifest";
import { isRedirect, readCappedText } from "../../../core/readCapped.js";
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
export const PROVIDER_MAX_BYTES = 64 * 1024;

/** How long one outbound provider call may take. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export class ProviderNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

/** Why `raw` may not be dialled for `kind`, or `null` when it may. */
export function providerUrlProblem(
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
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    return "host not on the provider allowlist";
  }
  return null;
}

/** The fetch a provider module uses; tests pass a fake. */
export type ProviderFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const defaultProviderFetch: ProviderFetch = (input, init) =>
  fetch(input, init);

/**
 * Dial a gated URL and return the status with the body as text (capped). Throws
 * `ProviderNetworkError` for a refused URL, a redirect, a timeout or an oversized body; a non-2xx
 * status is returned for the caller to judge.
 */
export async function gatedFetch(
  kind: SignInProviderKind,
  url: string,
  init: RequestInit,
  fetchImpl: ProviderFetch = defaultProviderFetch,
): Promise<{ status: number; body: string }> {
  const problem = providerUrlProblem(url, PROVIDER_HOSTS[kind]);
  if (problem) {
    throw new ProviderNetworkError(`refused ${kind} URL: ${problem}`);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderNetworkError(`${kind} request failed`);
  }
  if (isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderNetworkError(`${kind} answered a redirect`);
  }
  const body = await readCappedText(
    res,
    PROVIDER_MAX_BYTES,
    (detail) =>
      new ProviderNetworkError(`${kind} response too large (${detail})`),
  );
  return { status: res.status, body };
}

/** `gatedFetch` for a JSON answer: a 2xx with an object body, or a `ProviderNetworkError`. */
export async function gatedJson(
  kind: SignInProviderKind,
  url: string,
  init: RequestInit,
  fetchImpl?: ProviderFetch,
): Promise<Record<string, unknown>> {
  const { status, body } = await gatedFetch(kind, url, init, fetchImpl);
  if (status < 200 || status >= 300) {
    throw new ProviderNetworkError(`${kind} answered ${status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProviderNetworkError(`${kind} answered invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderNetworkError(`${kind} answered a non-object`);
  }
  return parsed as Record<string, unknown>;
}
