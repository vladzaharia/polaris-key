/// <reference types="@cloudflare/workers-types" />

/**
 * Compatibility surface for the pre-suite modules that have not been carved yet.
 *
 * Everything this file used to define now lives where the layout puts it:
 *
 *   - the device half (`validateDeviceToken`, `rotateDeviceToken`, `bindDevice`,
 *     `reconcileDeviceHardware`, `licenseUsable`)  →  `core/devices.ts`   (P1.T1)
 *   - the layer walk (`catalogDefaultPayload`, the merge)  →  `core/payload.ts`
 *   - the seat decision (`authorizeDevice`, `tierExpiresAt`, `docProfile`)
 *                                                          →  `services/license/authz.ts`
 *   - the admin policy injection (`injectAdminPolicy`)     →  `services/license/entitlements.ts`
 *
 * What is left is `resolveEffective`, which cannot simply move: it returns config, secrets AND
 * entitlements in one object because the v2 document fused all three, and three surfaces still
 * mint or render that fused shape — identity's browser session (`browserSession.ts`), the
 * portal's entitlement view (`portal/api.ts`), and the R12-02 regression test. Those move in
 * P3; until then this is the one definition they share, and it is composed from the SAME two
 * steps the split documents use, in the same order, so it cannot drift away from them:
 *
 *     core.resolveMergedPayload  →  license.injectAdminPolicy  →  (optional) open secrets
 *
 * Nothing new may be added here.
 */

import type { ManagedPayload } from "@plrs/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { openManagedPayload, resolveMergedPayload } from "./core/payload.js";
import { injectAdminPolicy } from "./services/license/entitlements.js";
import type { DeviceRow, LicenseRow } from "./repo.js";

export {
  authorizeDevice,
  docProfile,
  tierExpiresAt,
  type AuthzError,
} from "./services/license/authz.js";

/**
 * Merge every managed-payload layer for one license/device into the effective payload.
 *
 * `env` is OPTIONAL and is the reader half of R12-02. `admin/lib/overrides.ts` now `seal()`s
 * catalog-declared secrets (`kind: "secret"`, or `kind: "config"` with `secret: true`) before
 * they reach `profiles.payload_json` / `licenses.overrides_json`, so a stored value is an
 * AES-GCM envelope rather than the plaintext it used to be. Pass `env` on any path that mints
 * a signed document or renders a value to an owner and the envelopes are opened here; omit it
 * and the envelope survives into the catalog prune, which drops it as a schema violation —
 * fail-closed, but the secret silently stops being delivered.
 *
 * Callers that only read `payload.entitlements` (`portal/api.ts`'s `entitlementView`) do NOT
 * need it: entitlements are never sealed.
 */
export async function resolveEffective(
  db: Db,
  product: string,
  license: LicenseRow,
  device: DeviceRow | null | undefined,
  now: number,
  policy: {
    tighterMin: (a?: string, b?: string) => string | undefined;
    tighterMax: (a?: string, b?: string) => string | undefined;
  },
  env?: Env,
): Promise<ManagedPayload> {
  const { payload, tier } = await resolveMergedPayload(
    db,
    product,
    license,
    device,
    now,
  );
  injectAdminPolicy(
    payload,
    tier,
    license,
    policy.tighterMin,
    policy.tighterMax,
  );
  // Opening happens AFTER the merge so a sealed value in a lower layer that a higher layer
  // overrides is never decrypted at all, and after `injectAdminPolicy` because server policy is
  // authored here in plaintext and must not be mistaken for an envelope.
  return env ? openManagedPayload(env, product, payload) : payload;
}
