// I-30: the fake IdP metadata every OIDC test serves through `fetch`. The one relying-party
// client (`src/core/oidc/client.ts`) discovers the issuer and fetches its JWKS through its gated
// fetch, so a test that used to mock jose's remote key set now answers these two documents.
//
// `issuerMetadataResponse(url, key)` answers `<issuer>/.well-known/openid-configuration` and
// `<issuer>/.well-known/jwks.json` for ANY issuer (the issuer is the URL before the suffix), and
// `null` for every other URL, so a test's own fetch stub keeps answering the token endpoint.
// Pocket ID's real paths are used (`/authorize`, `/api/oidc/token`, `/.well-known/jwks.json`).

import { exportJWK } from "jose";

const DISCOVERY = "/.well-known/openid-configuration";
const JWKS = "/.well-known/jwks.json";

/** The discovery document of `issuer`, shaped like Pocket ID's. */
export function issuerDiscovery(
  issuer: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = issuer.replace(/\/+$/, "");
  return {
    issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/api/oidc/token`,
    jwks_uri: `${base}${JWKS}`,
    response_types_supported: ["code"],
    ...over,
  };
}

function urlOf(input: RequestInfo | URL | string): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A public key (CryptoKey, or a JWK already) as a JWKS. */
export async function jwksOf(
  key: unknown,
  kid?: string,
): Promise<{ keys: Record<string, unknown>[] }> {
  const jwk =
    key && typeof key === "object" && "kty" in (key as object)
      ? { ...(key as Record<string, unknown>) }
      : ((await exportJWK(key as CryptoKey)) as unknown as Record<string, unknown>);
  if (kid && !jwk.kid) jwk.kid = kid;
  return { keys: [jwk] };
}

/** The `kid` the tests' ID tokens carry unless they say otherwise. */
export const TEST_IDP_KID = "test-idp";

/**
 * Answer discovery or the JWKS for `input`, or `null` when it is neither. `key` is the IdP's
 * public key (or a getter for it); `null` answers an empty key set. A key without a `kid` gets
 * `opts.kid`, by default `TEST_IDP_KID`.
 */
export async function issuerMetadataResponse(
  input: RequestInfo | URL | string,
  key: unknown | (() => Promise<unknown>) | null,
  opts: { kid?: string; discovery?: Record<string, unknown> } = {},
): Promise<Response | null> {
  const url = urlOf(input);
  if (url.endsWith(DISCOVERY)) {
    const issuer = url.slice(0, -DISCOVERY.length);
    return json(issuerDiscovery(issuer, opts.discovery));
  }
  if (url.endsWith(JWKS)) {
    const k = typeof key === "function" ? await (key as () => Promise<unknown>)() : key;
    return json(k ? await jwksOf(k, opts.kid ?? TEST_IDP_KID) : { keys: [] });
  }
  return null;
}
