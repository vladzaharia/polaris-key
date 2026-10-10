/**
 * The Microsoft Store submission API's bearer token (P5-04): a Microsoft Entra ID access token
 * from the client-credentials grant, minted from the `ms-partner-center` outlet credential.
 *
 *     POST https://login.microsoftonline.com/<tenantId>/oauth2/token
 *     grant_type=client_credentials & client_id & client_secret
 *       & resource=https://manage.devcenter.microsoft.com
 *
 * (Microsoft's "Create and manage submissions" page, step 2; tokens last 60 minutes, and the v1
 * endpoint sends `expires_in` as a string.)
 *
 * **Cache first, open on a miss** — P5-01's sealed cache (`core/outletTokens.ts`): the slot is
 * keyed by the credential's non-secret version marker (`outletCredentialVersion`) and the
 * resource, so a hit costs no open, no decryption and no `outlet_credential.use` audit row, and a
 * rotated secret never serves its predecessor's token. Only a miss opens the credential (audited
 * under `use`). The cached token is sealed under the outlet-credential AAD kind; a KV dump yields
 * ciphertext. It stops being served 300 s before Entra says it expires.
 *
 * **No redirects, bounded body.** `redirect: "manual"` and any 3xx is a failure, so the client
 * secret is never re-posted elsewhere; the response is read through `readCappedText`.
 *
 * **The platform Partner Center app (A-16).** `platformMsStoreToken` mints the same token from the
 * platform's team credential for a product whose platform pin is its Store ID (checked before the
 * cache and inside the open) or for the platform apps listing. This file is one of the two
 * reviewed callers of `openPlatformCredential` outside Core (`outletCredentialReach.test.ts`).
 *
 * **The MSI/EXE audience (A-18f).** The write client (`write.ts`) needs a second token from the
 * same application: `platformMsStoreToken(…, "msi")` exchanges at the v2.0 endpoint for the scope
 * `https://api.store.microsoft.com/.default`, cached in its own sealed slot (the audience is part
 * of the slot hash), and `platformMsStoreSellerId` reads the seller id from the credential's
 * non-secret metadata. The default (`"classic"`) is P5-04's token, unchanged.
 *
 * **Fixed host.** The token request goes only to `login.microsoftonline.com`; the tenant id from
 * the credential becomes one percent-encoded path segment after a format check (a GUID or a
 * domain name), and the final URL is re-checked, so a credential cannot make the Worker post its
 * client secret anywhere else.
 */

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../env.js";
import {
  openOutletCredential,
  outletCredentialVersion,
  type TransientOutletCredential,
} from "../../../../core/outletCredentials.js";
import {
  oauthErrorCode,
  outletTokenSlot,
  outletTokenSlotHash,
  readSealedToken,
  TokenExchangeError,
  writeSealedToken,
  type FetchImpl,
} from "../../../../core/outletTokens.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";
import {
  openPlatformCredential,
  PLATFORM_SEAL_PRODUCT,
  platformPin,
  resolvePlatformCredential,
  type PlatformOpenPurpose,
} from "../../../../core/platformCredentials.js";

/** The platform credential the fallback uses (A-16). */
export const MSSTORE_PLATFORM_CREDENTIAL =
  "microsoft-store.partner-center" as const;

export const ENTRA_ORIGIN = "https://login.microsoftonline.com";
/** The `resource` of every Store submission API token. */
export const STORE_API_RESOURCE = "https://manage.devcenter.microsoft.com";
/**
 * The `scope` of an MSI/EXE submission API token (A-18f): a v2.0 endpoint token, sent with the
 * seller id in `X-Seller-Account-Id`. Same Entra application, different audience.
 */
export const MSI_API_SCOPE = "https://api.store.microsoft.com/.default";

/** Which Store API a token is for: the classic API (v1 `resource`) or MSI/EXE (v2 `scope`). */
export type MsStoreTokenApi = "classic" | "msi";
/** The cache stops serving a token this long before Entra says it expires. */
export const ENTRA_CACHE_MARGIN = 300;
/** The most of a token response read (one is ~1.5 KiB). */
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** A tenant id: a GUID, or a verified domain such as `contoso.onmicrosoft.com`. */
const TENANT =
  /^(?:[0-9a-fA-F-]{36}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)+[A-Za-z]{2,63})$/;

/** The token endpoint of one tenant, or null for a tenant id that is neither form. The v1
 *  endpoint for the classic API, v2.0 for MSI/EXE (A-18f). */
export function entraTokenUrl(
  tenantId: string,
  api: MsStoreTokenApi = "classic",
): string | null {
  if (!TENANT.test(tenantId) || tenantId.length > 253) return null;
  const url = new URL(
    `/${encodeURIComponent(tenantId)}/oauth2/${api === "msi" ? "v2.0/token" : "token"}`,
    ENTRA_ORIGIN,
  );
  return url.origin === ENTRA_ORIGIN ? url.toString() : null;
}

/** `expires_in` as the v1 endpoint sends it (a string of digits) or as a number. */
function seconds(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^[0-9]{1,7}$/.test(v)
        ? Number(v)
        : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The Store API token for the `ms-partner-center` credential `credentialId`: from the sealed cache
 * when it holds one for this credential version, otherwise from a fresh open (audited under `use`,
 * e.g. `ms-store:poll`) and a client-credentials exchange.
 *
 * `null` — "unusable credential" — when the credential is unknown, disabled, of another kind or
 * will not open. THROWS when the exchange fails; the message carries the HTTP status only, never
 * the response body or anything from the credential.
 */
export async function msStoreToken(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  use: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<string | null> {
  const version = await outletCredentialVersion(
    db,
    product,
    credentialId,
    "ms-partner-center",
  );
  if (version === null) return null;
  const cached = await readSealedToken(
    env,
    outletTokenSlot(
      product,
      credentialId,
      await outletTokenSlotHash(STORE_API_RESOURCE, version),
    ),
    now,
  );
  if (cached) return cached.token;

  const cred = await openOutletCredential(env, db, product, credentialId, use, {
    kind: "ms-partner-center",
    now,
  });
  if (!cred) return null;
  const { token, ttl } = await entraExchange(cred.value, fetchImpl);
  await writeSealedToken(
    env,
    outletTokenSlot(
      product,
      credentialId,
      await outletTokenSlotHash(STORE_API_RESOURCE, cred.version),
    ),
    token,
    ttl,
    now,
  );
  return token;
}

/** The client-credentials exchange (see the header): the token and how long it may be cached.
 *  THROWS with a status line only. */
async function entraExchange(
  value: { tenantId: string; clientId: string; clientSecret: string },
  fetchImpl: FetchImpl,
  api: MsStoreTokenApi = "classic",
): Promise<{ token: string; ttl: number }> {
  const { tenantId, clientId, clientSecret } = value;
  const url = entraTokenUrl(tenantId, api);
  if (!url)
    throw new Error("entra token: the credential's tenantId is invalid");
  const res = await fetchImpl(url, {
    method: "POST",
    // Never follow a redirect with the client secret in the body.
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      ...(api === "msi"
        ? { scope: MSI_API_SCOPE }
        : { resource: STORE_API_RESOURCE }),
    }).toString(),
  });
  if (!res.ok || isRedirect(res)) {
    // The error body's `error` token and first AADSTS number only (UX-69's live check says why).
    const code = isRedirect(res) ? null : await oauthErrorCode(res);
    if (isRedirect(res)) await res.body?.cancel();
    throw new TokenExchangeError(
      `entra token exchange failed: ${res.status}`,
      res.status,
      code,
    );
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = JSON.parse(
      await readCappedText(
        res,
        MAX_TOKEN_RESPONSE_BYTES,
        () => new Error("too large"),
      ),
    ) as typeof body;
  } catch {
    throw new Error("entra token exchange returned no JSON");
  }
  if (!body || typeof body !== "object") body = {};
  const expiresIn = seconds(body.expires_in);
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    expiresIn === null
  )
    throw new Error("entra token exchange returned no token");
  return { token: body.access_token, ttl: expiresIn - ENTRA_CACHE_MARGIN };
}

/**
 * The Store API token minted from the PLATFORM Partner Center app
 * (`microsoft-store.partner-center`, A-16), for a product acting on its pinned Store ID
 * (`{product, pin: productId}`) or a team-wide read (`{team}`). The pin is checked BEFORE the
 * sealed cache (slot under `_platform`), and again inside the open. `null` when unusable; THROWS
 * on a failed exchange (status only).
 */
export async function platformMsStoreToken(
  env: Env,
  db: Db,
  purpose: PlatformOpenPurpose,
  use: string,
  now: number,
  fetchImpl: FetchImpl,
  api: MsStoreTokenApi = "classic",
): Promise<string | null> {
  const id = MSSTORE_PLATFORM_CREDENTIAL;
  if (
    "product" in purpose &&
    (await platformPin(db, id, purpose.product)) !== purpose.pin
  )
    return null;
  const ref = await resolvePlatformCredential(env, db, id);
  if (!ref) return null;
  // One cache slot per audience: a classic token is never served to the MSI/EXE API.
  const audience = api === "msi" ? MSI_API_SCOPE : STORE_API_RESOURCE;
  const slotFor = async (version: string) =>
    outletTokenSlot(
      PLATFORM_SEAL_PRODUCT,
      id,
      await outletTokenSlotHash(audience, version),
    );
  const cached = await readSealedToken(env, await slotFor(ref.version), now);
  if (cached) return cached.token;
  const cred = await openPlatformCredential(env, db, id, use, purpose, now);
  if (!cred) return null;
  const { token, ttl } = await entraExchange(cred.value, fetchImpl, api);
  await writeSealedToken(env, await slotFor(cred.version), token, ttl, now);
  return token;
}

/**
 * The seller id the MSI/EXE API needs in `X-Seller-Account-Id` (A-18f), from the platform
 * credential's NON-SECRET metadata: no open, no audit row. Null when no credential is configured
 * or its metadata lacks a plain seller id (letters, digits, hyphens).
 */
export async function platformMsStoreSellerId(
  env: Env,
  db: Db,
): Promise<string | null> {
  const ref = await resolvePlatformCredential(
    env,
    db,
    MSSTORE_PLATFORM_CREDENTIAL,
  );
  const seller = (ref?.meta as { sellerId?: unknown } | null | undefined)
    ?.sellerId;
  return typeof seller === "string" && /^[A-Za-z0-9-]{1,64}$/.test(seller)
    ? seller
    : null;
}

/**
 * The Store API token for an UNSAVED Partner Center app (UX-69's live check): the same
 * client-credentials exchange, on the same fixed host, never cached. THROWS a
 * `TokenExchangeError` (status, `error` token, AADSTS number) when Entra refuses.
 */
export async function transientMsStoreToken(
  cred: TransientOutletCredential<"ms-partner-center">,
  fetchImpl: FetchImpl,
): Promise<string> {
  return (await entraExchange(cred.reveal(), fetchImpl)).token;
}
