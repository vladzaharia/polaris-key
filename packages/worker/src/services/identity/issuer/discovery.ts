/**
 * The issuer's two public documents (I-21.5; V5 §12.13.1): the provider metadata at
 * `<issuer>/.well-known/openid-configuration` and the key set at `<issuer>/jwks`.
 *
 * Both answer only while the issuer is served (Identity on, which the registry has already
 * established by routing here, AND `identity.issuer.enabled`); otherwise `null`, the registry's
 * `404`, as for any route the product does not have. Neither reads anything per person. Neither
 * ever creates a key: `/jwks` lists the ring as it is, and a product that never served a token has
 * an empty set until its first one. The headers are fixed: public, a short cache, and
 * `Access-Control-Allow-Origin: *` with no credentials (the response is the same for every
 * origin, so it is safe to cache whole).
 */

import type {
  IssuerPrompt,
  IssuerScope,
  OpenIdConfiguration,
} from "@polaris-key/protocol/identity";
import { ISSUER_SCOPES } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import { json, methodNotAllowed } from "../../../core/errors.js";
import { issuerJwks } from "./keys.js";
import { issuerServed } from "./served.js";

/** Provider metadata is cached 5 minutes (§12.13.1). */
export const DISCOVERY_MAX_AGE_SECONDS = 300;
/**
 * The key set is cached less than metadata: a key that leaves the set (emergency rotation) must
 * stop verifying quickly, and a `next` key must reach a relying party before it signs. Seven days'
 * lead and 30 days' overlap make 60 s ample.
 */
export const JWKS_MAX_AGE_SECONDS = 60;

/**
 * The endpoints each slice serves. Discovery names a member only from the release that serves it
 * (§12.13), so a later slice flips its flag here when it adds the route.
 */
const SERVED_ENDPOINTS = {
  userinfo_endpoint: false,
  revocation_endpoint: false,
  end_session_endpoint: false,
} as const;

/** The client authentication methods of `token` and `revoke` (§12.13.2). */
const CLIENT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "none",
] as const;

/** The provider metadata for `issuer` (`<origin>/<p>/identity`), per §12.13.1. */
export function openIdConfiguration(
  issuer: string,
  docsOrigin: string,
): Partial<OpenIdConfiguration> {
  const endpoints: Partial<OpenIdConfiguration> = {
    ...(SERVED_ENDPOINTS.userinfo_endpoint
      ? { userinfo_endpoint: `${issuer}/userinfo` }
      : {}),
    ...(SERVED_ENDPOINTS.revocation_endpoint
      ? { revocation_endpoint: `${issuer}/revoke` }
      : {}),
    ...(SERVED_ENDPOINTS.end_session_endpoint
      ? { end_session_endpoint: `${issuer}/end-session` }
      : {}),
  };
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    ...endpoints,
    service_documentation: `${docsOrigin}/docs/features/sign-in/sign-in-with-product/`,
    scopes_supported: [...ISSUER_SCOPES] as IssuerScope[],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "azp",
      "at_hash",
      "name",
      "picture",
      "email",
      "email_verified",
      "pkey:entitlements",
    ],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    code_challenge_methods_supported: ["S256"],
    prompt_values_supported: ["none", "login", "consent"] as IssuerPrompt[],
    authorization_response_iss_parameter_supported: true,
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    frontchannel_logout_supported: false,
    backchannel_logout_supported: false,
  };
}

/** Headers of a public, origin-independent document. */
function publicHeaders(maxAge: number): Record<string, string> {
  return {
    "cache-control": `public, max-age=${maxAge}`,
    "access-control-allow-origin": "*",
  };
}

/** A `GET` that answers only while the issuer is served: 405 for another method, `null` (404) off. */
async function servedDocument(
  req: Request,
  db: Db,
  slug: string,
  maxAge: number,
  body: () => unknown | Promise<unknown>,
): Promise<Response | null> {
  if (req.method !== "GET") return methodNotAllowed();
  if (!(await issuerServed(db, slug))) return null;
  return json(await body(), { headers: publicHeaders(maxAge) });
}

/** `GET <issuer>/.well-known/openid-configuration`. `null` while the issuer is not served. */
export function handleOpenIdConfiguration(
  req: Request,
  db: Db,
  slug: string,
): Promise<Response | null> {
  const origin = new URL(req.url).origin;
  return servedDocument(req, db, slug, DISCOVERY_MAX_AGE_SECONDS, () =>
    openIdConfiguration(`${origin}/${slug}/identity`, origin),
  );
}

/** `GET <issuer>/jwks`. `null` while the issuer is not served. Reads the ring; never writes. */
export function handleIssuerJwks(
  req: Request,
  db: Db,
  slug: string,
): Promise<Response | null> {
  return servedDocument(req, db, slug, JWKS_MAX_AGE_SECONDS, () =>
    issuerJwks(db, slug),
  );
}
