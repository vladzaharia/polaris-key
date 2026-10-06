/**
 * Sign in with Google on the login card (I-06): Polaris's one platform OAuth client, the
 * authorization-code flow with PKCE and a nonce, RFC 9207 `iss` on the response (Google
 * advertises `authorization_response_iss_parameter_supported`), and the ID token checked
 * against exactly the platform client id. The access token Google also returns is dropped
 * unread; nothing upstream is stored.
 */

import type { GoogleClientConfig } from "./config.js";
import {
  checkAuthorizationIss,
  providerAssertsVerified,
  ProviderVerifyError,
  verifyProviderIdToken,
  type DiscoveredProvider,
} from "./discovery.js";
import { gatedJson, type ProviderFetch } from "./net.js";
import { providerVouchesForEmail } from "./vouch.js";
import {
  cleanAvatarUrl,
  cleanDisplay,
  type ProviderSignInResult,
} from "./types.js";

/** The account link's issuer key for Google: its issuer URL (the OIDC rule of `account_links`). */
export const GOOGLE_ISSUER_KEY = "https://accounts.google.com";

export function googleAuthorizeUrl(
  client: GoogleClientConfig,
  discovered: DiscoveredProvider,
  flow: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  },
): string {
  const u = new URL(discovered.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", flow.redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", flow.state);
  u.searchParams.set("nonce", flow.nonce);
  u.searchParams.set("code_challenge", flow.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export async function completeGoogleSignIn(
  client: GoogleClientConfig,
  discovered: DiscoveredProvider,
  response: {
    code: string;
    iss: string | null;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  },
  opts: { fetch?: ProviderFetch } = {},
): Promise<ProviderSignInResult> {
  checkAuthorizationIss(discovered, response.iss);
  const tokens = await gatedJson(
    "google",
    discovered.tokenEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: response.code,
        redirect_uri: response.redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: response.codeVerifier,
      }).toString(),
    },
    opts.fetch,
  );
  if (typeof tokens.id_token !== "string") {
    throw new ProviderVerifyError("google token response has no id_token");
  }
  const claims = await verifyProviderIdToken(discovered, tokens.id_token, {
    audience: client.clientId,
    nonce: response.nonce,
    fetch: opts.fetch,
  });
  const email =
    typeof claims.email === "string" && claims.email.includes("@")
      ? claims.email.trim().toLowerCase()
      : null;
  // The Workspace domain, signed in the token.
  const hostedDomain =
    typeof claims.hd === "string" && claims.hd.trim()
      ? claims.hd.trim().toLowerCase()
      : null;
  // Google's `email_verified` counts only for a Gmail address or one whose domain `hd` names
  // (PX-W15; SIGN-IN.md §3.5): every caller gets the narrowed value, never the raw claim.
  const emailVerified = providerVouchesForEmail(
    {
      kind: "google",
      email,
      emailVerified: Boolean(
        email && providerAssertsVerified(claims.email_verified),
      ),
    },
    hostedDomain,
  );
  return {
    provider: "google",
    hostedDomain,
    identity: {
      issuerKey: GOOGLE_ISSUER_KEY,
      subject: claims.sub as string,
      kind: "google",
      email,
      emailVerified,
      displayName: cleanDisplay(claims.name),
      amr: ["google"],
    },
    profile: {
      displayName: cleanDisplay(claims.name),
      avatarUrl: cleanAvatarUrl(claims.picture, ["googleusercontent.com"]),
    },
  };
}
