/**
 * The verifiers for a native platform token (CC-01 auto sign-in, I-13.3; WIRE-CONTRACT-V5
 * §12.11.3): a Google ID token from Credential Manager or Sign in with Google, or an Apple
 * identity token for the app's bundle id. They check the token against the product's own audiences
 * (`platformSignIn.ts`), never the login card's: the card's two platform clients are refused here
 * even if a product names one, and a native token is refused by the card, which pins its own
 * client id.
 *
 * Google: `aud` is the product's server (web) client id; `azp`, when present, is that id or one
 * of the product's client ids (an Android Credential Manager token has `aud` = server client and
 * `azp` = the Android client). Apple: `aud` is one of the product's bundle ids, and the token
 * carries no `azp`. Both need a fresh token (`iat` within five minutes) whose `nonce` equals the
 * one presented, and neither is ever looked up by email.
 *
 * Every refusal is an `OidcVerifyError`; the caller answers them all with the same `invalid_grant`.
 */

import { decodeJwt, type JWTPayload } from "jose";
import type { PlatformSignInAudiences } from "../platformSignIn.js";
import { PLATFORM_CLIENT_VARS } from "../settings.js";
import { reservedValueIn } from "../../../core/settings/rules.js";
import { OidcVerifyError } from "../../../core/oidc/client.js";
import {
  discoverProvider,
  PROVIDER_ISSUERS,
  PROVIDER_TOKEN_ISSUERS,
  providerAssertsVerified,
  verifyProviderIdToken,
  type OidcProviderKind,
} from "./discovery.js";
import type { ProviderFetch } from "./net.js";
import { providerVouchesForEmail } from "./vouch.js";

export interface NativeIdentity {
  kind: OidcProviderKind;
  /** The provider's issuer URL: the link key's issuer. */
  issuerKey: string;
  subject: string;
  /** The tenant scopes to look the link up under, in order (§12.11.3). */
  tenantScopes: string[];
  email: string | null;
  /** Narrowed by `providerVouchesForEmail`, never the raw claim. */
  emailVerified: boolean;
  claims: JWTPayload;
}

export interface NativeVerifyOpts {
  fetch?: ProviderFetch;
  nowMs?: number;
}

/** Which provider minted `token`, from its unverified `iss`; `null` when neither. */
export function nativeProviderOf(token: string): OidcProviderKind | null {
  let iss: unknown;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    return null;
  }
  if (typeof iss !== "string") return null;
  for (const kind of ["google", "apple"] as const)
    if (PROVIDER_TOKEN_ISSUERS[kind].includes(iss)) return kind;
  return null;
}

/** §12.11.3: `iat` no more than 5 minutes old. jose widens its own max-age check by the clock tolerance. */
const NATIVE_MAX_AGE_SEC = 300;

function assertFresh(claims: JWTPayload, opts: NativeVerifyOpts): void {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (
    typeof claims.iat !== "number" ||
    nowSec - claims.iat > NATIVE_MAX_AGE_SEC
  )
    refuse();
}

function refuse(): never {
  throw new OidcVerifyError("native token refused");
}

/** The platform's own login-card clients are never a product audience, even from stale data. */
function assertNotPlatformClient(
  values: readonly string[],
  env: Readonly<Record<string, unknown>>,
): void {
  if (reservedValueIn({ reservedFrom: PLATFORM_CLIENT_VARS }, values, env))
    refuse();
}

export async function verifyNativeToken(
  token: string,
  nonce: string,
  audiences: PlatformSignInAudiences,
  env: Readonly<Record<string, unknown>>,
  opts: NativeVerifyOpts = {},
): Promise<NativeIdentity> {
  if (typeof nonce !== "string" || nonce === "") refuse();
  const kind = nativeProviderOf(token);
  if (!kind) refuse();
  const discovered = await discoverProvider(kind, opts);

  if (kind === "google") {
    const server = audiences.google.serverClientId;
    if (!server) refuse();
    const parties = [server, ...audiences.google.clientIds];
    assertNotPlatformClient(parties, env);
    const claims = await verifyProviderIdToken(discovered, token, {
      audience: server,
      authorizedParties: parties,
      nonce,
      ...opts,
    });
    assertFresh(claims, opts);
    const email =
      typeof claims.email === "string" && claims.email.includes("@")
        ? claims.email.trim().toLowerCase()
        : null;
    const hosted =
      typeof claims.hd === "string" && claims.hd.trim()
        ? claims.hd.trim().toLowerCase()
        : null;
    return {
      kind,
      issuerKey: PROVIDER_ISSUERS.google,
      subject: claims.sub as string,
      tenantScopes: ["", `google-client:${server}`],
      email,
      emailVerified: providerVouchesForEmail(
        {
          kind: "google",
          email,
          emailVerified: Boolean(
            email && providerAssertsVerified(claims.email_verified),
          ),
        },
        hosted,
      ),
      claims,
    };
  }

  const { bundleIds, teamId } = audiences.apple;
  // Without a team there is no scope to look a link up under.
  if (bundleIds.length === 0 || !teamId) refuse();
  assertNotPlatformClient(bundleIds, env);
  const claims = await verifyProviderIdToken(discovered, token, {
    audience: bundleIds,
    authorizedParties: [],
    nonce,
    ...opts,
  });
  assertFresh(claims, opts);
  const email =
    typeof claims.email === "string" && claims.email.includes("@")
      ? claims.email.trim().toLowerCase()
      : null;
  return {
    kind,
    issuerKey: PROVIDER_ISSUERS.apple,
    subject: claims.sub as string,
    tenantScopes: [`apple-team:${teamId}`],
    email,
    emailVerified: Boolean(
      email && providerAssertsVerified(claims.email_verified),
    ),
    claims,
  };
}
