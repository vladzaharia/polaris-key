/**
 * Sign in with Apple on the login card (I-06; S-16 §5.2 "the Apple specifics").
 *
 * Apple is not generic OIDC:
 *
 * - **The client secret is a JWT** Polaris mints per exchange: ES256, signed with the Sign in
 *   with Apple key's `.p8` (sealed, `config.ts`), `iss` = the Team ID, `sub` = the Services ID,
 *   `aud` = `https://appleid.apple.com`, five minutes of life. The `.p8` never leaves the Worker.
 * - **`response_mode=form_post`** (required once `name` or `email` is in scope): Apple answers
 *   with a cross-site top-level `POST` to the callback. A `SameSite=Lax` cookie is not sent on it,
 *   so the flow is found by its `state`, server-side, in the single-use store (`flow.ts`).
 * - **The name arrives only on first consent**, as an unsigned `user` form field. It is kept as
 *   a display suggestion for the interstitial (I-07) and never as an identifier; the email is
 *   always taken from the signed ID token, never from that field.
 * - **Server-to-server notifications** (`email-disabled`, `email-enabled`, `consent-revoked`,
 *   `account-delete`) arrive as a signed JWT; `verifyAppleNotification` checks it like an ID
 *   token (signature, issuer, exactly the Services ID as audience) and `flow.ts` flags the link.
 * - **Private relay** addresses (`is_private_email`) receive mail only from registered sender
 *   domains; the flag is passed on for I-18.
 *
 * The login card's audience is the Polaris Services ID and nothing else, so an ID token Apple
 * minted for a developer's bundle id (I-13's native sign-in) is refused here, and the reverse.
 */

import { importPKCS8, SignJWT } from "jose";
import type { AppleClientConfig } from "./config.js";
import {
  providerAssertsVerified,
  ProviderVerifyError,
  verifyProviderIdToken,
  type DiscoveredProvider,
} from "./discovery.js";
import { gatedJson, type ProviderFetch } from "./net.js";
import { cleanDisplay, type ProviderSignInResult } from "./types.js";

/** The account link's issuer key for Apple: its issuer URL. The login card's Apple subjects are
 *  scoped to Polaris's own team and stored with an empty tenant scope (the platform client);
 *  I-13's native subjects carry the developer's team as their tenant scope. */
export const APPLE_ISSUER_KEY = "https://appleid.apple.com";

/** The `aud` of an Apple client secret. */
export const APPLE_CLIENT_SECRET_AUDIENCE = "https://appleid.apple.com";

const CLIENT_SECRET_TTL_SECONDS = 300;

/** Mint the ES256 client secret for one token request. */
export async function appleClientSecret(
  client: AppleClientConfig,
  nowSec: number,
): Promise<string> {
  let key: CryptoKey;
  try {
    key = (await importPKCS8(client.privateKeyPem, "ES256")) as CryptoKey;
  } catch {
    throw new ProviderVerifyError("apple signing key is unusable");
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: client.keyId })
    .setIssuer(client.teamId)
    .setSubject(client.servicesId)
    .setAudience(APPLE_CLIENT_SECRET_AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

export function appleAuthorizeUrl(
  client: AppleClientConfig,
  discovered: DiscoveredProvider,
  flow: { redirectUri: string; state: string; nonce: string },
): string {
  const u = new URL(discovered.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "form_post");
  u.searchParams.set("client_id", client.servicesId);
  u.searchParams.set("redirect_uri", flow.redirectUri);
  u.searchParams.set("scope", "name email");
  u.searchParams.set("state", flow.state);
  u.searchParams.set("nonce", flow.nonce);
  return u.toString();
}

/**
 * The name from Apple's first-consent `user` field (`{"name":{"firstName","lastName"},…}`), or
 * `null`. Malformed input is ignored rather than refused: the field is unsigned decoration.
 */
export function appleFirstConsentName(user: string | null): string | null {
  if (!user || user.length > 4096) return null;
  try {
    const parsed = JSON.parse(user) as {
      name?: { firstName?: unknown; lastName?: unknown };
    };
    const first = cleanDisplay(parsed?.name?.firstName, 60);
    const last = cleanDisplay(parsed?.name?.lastName, 60);
    return cleanDisplay([first, last].filter(Boolean).join(" "));
  } catch {
    return null;
  }
}

export async function completeAppleSignIn(
  client: AppleClientConfig,
  discovered: DiscoveredProvider,
  response: {
    code: string;
    redirectUri: string;
    nonce: string;
    /** The raw `user` form field, present on first consent only. */
    user: string | null;
  },
  opts: { fetch?: ProviderFetch; nowSec?: number } = {},
): Promise<ProviderSignInResult> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tokens = await gatedJson(
    "apple",
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
        client_id: client.servicesId,
        client_secret: await appleClientSecret(client, nowSec),
      }).toString(),
    },
    opts.fetch,
  );
  // The ID token from the token endpoint, never the one in the form post: the exchange is what
  // proves the code was issued to this client.
  if (typeof tokens.id_token !== "string") {
    throw new ProviderVerifyError("apple token response has no id_token");
  }
  const claims = await verifyProviderIdToken(discovered, tokens.id_token, {
    audience: client.servicesId,
    nonce: response.nonce,
    fetch: opts.fetch,
  });
  const email =
    typeof claims.email === "string" && claims.email.includes("@")
      ? claims.email.trim().toLowerCase()
      : null;
  const firstConsentName = appleFirstConsentName(response.user);
  return {
    provider: "apple",
    identity: {
      issuerKey: APPLE_ISSUER_KEY,
      tenantScope: "",
      subject: claims.sub as string,
      kind: "apple",
      email,
      emailVerified: Boolean(
        email && providerAssertsVerified(claims.email_verified),
      ),
      displayName: firstConsentName,
      amr: ["apple"],
    },
    profile: {
      displayName: firstConsentName,
      avatarUrl: null,
      firstConsentName,
      privateRelayEmail: providerAssertsVerified(claims.is_private_email),
    },
  };
}

export const APPLE_NOTIFICATION_TYPES = [
  "email-disabled",
  "email-enabled",
  "consent-revoked",
  "account-delete",
] as const;
export type AppleNotificationType = (typeof APPLE_NOTIFICATION_TYPES)[number];

export interface AppleNotification {
  type: AppleNotificationType;
  sub: string;
}

/** Verify a server-to-server notification's signed `payload` and read its event. */
export async function verifyAppleNotification(
  client: AppleClientConfig,
  discovered: DiscoveredProvider,
  payload: string,
  opts: { fetch?: ProviderFetch } = {},
): Promise<AppleNotification> {
  const claims = await verifyProviderIdToken(discovered, payload, {
    audience: client.servicesId,
    // Apple retries delivery; the effects are idempotent flags, so an event up to a week old is
    // accepted as long as it is signed and addressed to the Services ID.
    shape: "notification",
    fetch: opts.fetch,
  });
  let events: unknown = claims.events;
  if (typeof events === "string") {
    try {
      events = JSON.parse(events);
    } catch {
      throw new ProviderVerifyError("apple notification events unreadable");
    }
  }
  const ev = events as { type?: unknown; sub?: unknown } | null;
  if (
    !ev ||
    typeof ev.sub !== "string" ||
    !ev.sub ||
    !(APPLE_NOTIFICATION_TYPES as readonly unknown[]).includes(ev.type)
  ) {
    throw new ProviderVerifyError("apple notification event unrecognised");
  }
  return { type: ev.type as AppleNotificationType, sub: ev.sub };
}
