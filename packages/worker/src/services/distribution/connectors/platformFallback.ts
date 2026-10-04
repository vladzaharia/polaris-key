/**
 * The platform fallback every store connector and commerce context shares (A-16).
 *
 * A product with NO active credential of the kind of its own may use the platform's team
 * credential — but only for the one app a platform admin assigned to it: its platform pin
 * (`platform_credential_pins`) must equal the app the product is about to act on, exactly as an
 * own credential's pin must. The answer is either the credential's HANDLE
 * (`platform:<id>`, which the token helpers route to the platform path and which re-check the pin
 * before any cache), or why not, in the connectors' own inert vocabulary. Metadata only: nothing
 * is opened here.
 *
 * The caller decides "no own credential": an own credential that is unpinned or mis-pinned is
 * inert on its own terms and never falls through to the team key.
 */

import type { Db, Env } from "../../../core/platform.js";
import {
  platformCredentialHandle,
  platformPin,
  resolvePlatformCredential,
  type PlatformCredentialId,
  type PlatformCredentialSource,
} from "../../../core/platformCredentials.js";

export type PlatformFallback =
  | { ok: true; handle: string; origin: PlatformCredentialSource }
  | { ok: false; reason: "no_credential"; pinned: null }
  | { ok: false; reason: "pin_missing"; pinned: null }
  | { ok: false; reason: "pin_mismatch"; pinned: string };

export async function platformFallback(
  env: Env,
  db: Db,
  product: string,
  id: PlatformCredentialId,
  expected: string,
): Promise<PlatformFallback> {
  const ref = await resolvePlatformCredential(env, db, id);
  if (!ref) return { ok: false, reason: "no_credential", pinned: null };
  const pinned = await platformPin(db, id, product);
  if (pinned === null) return { ok: false, reason: "pin_missing", pinned };
  if (pinned !== expected) return { ok: false, reason: "pin_mismatch", pinned };
  return { ok: true, handle: platformCredentialHandle(id), origin: ref.source };
}

/** The console sentence for a platform-fallback refusal. */
export function platformFallbackMessage(
  storeLabel: string,
  store: string,
  field: string,
  expected: string,
  product: string,
  f: Exclude<PlatformFallback, { ok: true }>,
): string {
  if (f.reason === "no_credential")
    return `a platform admin must store a credential of this product's own pinned to this app, or configure the platform ${storeLabel} connection and assign this app to the product`;
  if (f.reason === "pin_missing")
    return `the platform ${storeLabel} credential is not assigned to an app for this product: a platform admin must assign ${field} ${expected} to ${product} (Platform → Store connections; PUT /manage/api/platform/store-connections/${store}/apps/${expected}/product) after checking that this is the product's app`;
  return `.pkey/distribution names ${field} ${expected}, but the platform ${storeLabel} credential is assigned to ${field} ${f.pinned} for this product: nothing is read or changed until the manifest names the assigned app again, or a platform admin assigns ${expected} to ${product}`;
}
