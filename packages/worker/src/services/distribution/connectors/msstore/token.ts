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
 * **Fixed host.** The token request goes only to `login.microsoftonline.com`; the tenant id from
 * the credential becomes one percent-encoded path segment after a format check (a GUID or a
 * domain name), and the final URL is re-checked, so a credential cannot make the Worker post its
 * client secret anywhere else.
 */

import type { Db, Env } from "../../../../core/platform.js";
import {
  openOutletCredential,
  outletCredentialVersion,
} from "../../../../core/outletCredentials.js";
import {
  outletTokenSlot,
  outletTokenSlotHash,
  readSealedToken,
  writeSealedToken,
  type FetchImpl,
} from "../../../../core/outletTokens.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";

export const ENTRA_ORIGIN = "https://login.microsoftonline.com";
/** The `resource` of every Store submission API token. */
export const STORE_API_RESOURCE = "https://manage.devcenter.microsoft.com";
/** The cache stops serving a token this long before Entra says it expires. */
export const ENTRA_CACHE_MARGIN = 300;
/** The most of a token response read (one is ~1.5 KiB). */
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** A tenant id: a GUID, or a verified domain such as `contoso.onmicrosoft.com`. */
const TENANT =
  /^(?:[0-9a-fA-F-]{36}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)+[A-Za-z]{2,63})$/;

/** The token endpoint of one tenant, or null for a tenant id that is neither form. */
export function entraTokenUrl(tenantId: string): string | null {
  if (!TENANT.test(tenantId) || tenantId.length > 253) return null;
  const url = new URL(
    `/${encodeURIComponent(tenantId)}/oauth2/token`,
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
  const { tenantId, clientId, clientSecret } = cred.value;
  const url = entraTokenUrl(tenantId);
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
      resource: STORE_API_RESOURCE,
    }).toString(),
  });
  if (!res.ok || isRedirect(res)) {
    await res.body?.cancel();
    throw new Error(`entra token exchange failed: ${res.status}`);
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

  await writeSealedToken(
    env,
    outletTokenSlot(
      product,
      credentialId,
      await outletTokenSlotHash(STORE_API_RESOURCE, cred.version),
    ),
    body.access_token,
    expiresIn - ENTRA_CACHE_MARGIN,
    now,
  );
  return body.access_token;
}
