/**
 * Entitlements — the License service's half of the old fused payload (WIRE-CONTRACT-V3 §2.1).
 *
 * Wire v3 makes `entitlements` the ONLY carrier of grant data (D-20). Everything a client is
 * allowed to do arrives here: the catalog's declared `flag` entries, as authored into profiles
 * and overrides, plus the admin/tier policy this module injects — `license.tier`,
 * `license.tierLabel`, `channels`, `app.minVersion`, `app.maxVersion`, `deviceLimit`.
 *
 * ── THE SPLIT ───────────────────────────────────────────────────────────────────────────────
 *
 * `licenseCore.resolveEffective` used to return config, secrets and entitlements together
 * because one document carried all three. Two documents means two owners:
 *
 *     core.resolveMergedPayload   the layer walk, jointly owned (see core/payload.ts)
 *       ├─ this file              + injectAdminPolicy  →  entitlements  →  license document
 *       └─ services/config        + open sealed values →  config/secrets →  config document
 *
 * The merge is not duplicated; only the slice differs. `resolveEffective` survives as a legacy
 * shim over exactly these two steps, so the surfaces that still mint a v2 document (identity's
 * `/session`, the portal's entitlement view) are byte-identical to before the split.
 */

import type { ManagedEntry } from "@plrs/protocol";
import type { Db } from "../../core/platform.js";
import { resolveMergedPayload } from "../../core/payload.js";
import type { DeviceRow, LicenseRow } from "../../core/data.js";
import { injectAdminPolicy } from "../../core/entitlements.js";
import { tighterMax, tighterMin } from "./gate.js";

// `injectAdminPolicy` moved to `core/entitlements.ts` in P2.T3 so the `entitled` release/update
// access mode (D-13) computes the SAME entitlement map this document carries, rather than a
// second row-only derivation that would silently ignore channels authored in a profile or an
// override. Re-exported here because `licenseCore.resolveEffective` — and through it identity's
// `/session` and the portal's entitlement view — imports it from this module.
export { injectAdminPolicy } from "../../core/entitlements.js";

/**
 * The effective entitlement map for one license/device: every stored layer, merged, with the
 * admin policy stamped on top.
 *
 * `env` is deliberately absent. `resolveEffective`'s optional `env` opens sealed managed
 * secrets (R12-02), and entitlements are never sealed — the license document carries no secret
 * material at all, which is the wire-level reason it can be handed to a build gate without
 * decrypting anything.
 */
export async function resolveEntitlements(
  db: Db,
  product: string,
  license: LicenseRow,
  device: DeviceRow | null | undefined,
  now: number,
): Promise<Record<string, ManagedEntry>> {
  const { payload, tier } = await resolveMergedPayload(
    db,
    product,
    license,
    device,
    now,
  );
  injectAdminPolicy(payload, tier, license, tighterMin, tighterMax);
  return payload.entitlements;
}
