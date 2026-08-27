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

import type { ManagedEntry, ManagedPayload } from "@plrs/protocol";
import type { Db } from "../../core/platform.js";
import { resolveMergedPayload } from "../../core/payload.js";
import type { DeviceRow, LicenseRow, TierRow } from "../../core/data.js";
import { tighterMax, tighterMin } from "./gate.js";

/** Parse a JSON string-array column, ignoring null/invalid. */
function parseChannelsJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? (v.filter((c) => typeof c === "string") as string[])
      : [];
  } catch {
    return [];
  }
}

/**
 * Inject the admin upgrade-channel + version-window policy (from the tier and license rows)
 * as ENFORCED entitlements, so the existing gate governs them with no gate-logic changes.
 *
 * The comparator parameters stay explicit rather than closing over `./gate.js` directly: the
 * legacy `licenseCore.resolveEffective` passes its caller's pair, and taking them as arguments
 * is what let this function move into the service without changing a single one of those call
 * sites.
 */
export function injectAdminPolicy(
  payload: ManagedPayload,
  tier: TierRow | null,
  license: LicenseRow,
  minOf: (a?: string, b?: string) => string | undefined,
  maxOf: (a?: string, b?: string) => string | undefined,
): void {
  const updatedAt = license.modified_at;
  const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
    state: "enforced",
    value,
    updatedAt,
  });

  // The license's plan, surfaced to the client as ordinary entitlements. This is what makes
  // remote re-licensing visible without touching the signed document's shape: changing
  // `licenses.tier_id` bumps `modified_at`, which changes these entries' `updatedAt`, which
  // changes the doc's ETag — so the client's next refresh detects a real content change.
  if (license.tier_id) {
    payload.entitlements["license.tier"] = enforced(license.tier_id);
    if (tier?.label) {
      payload.entitlements["license.tierLabel"] = enforced(tier.label);
    }
  }

  const channels = [
    ...new Set([
      ...parseChannelsJson(tier?.channels_json ?? null),
      ...parseChannelsJson(license.channels_json),
    ]),
  ];
  if (channels.length > 0)
    payload.entitlements["channels"] = enforced(channels);

  if (typeof tier?.policy_device_limit === "number") {
    payload.entitlements["deviceLimit"] = enforced(tier.policy_device_limit);
  }

  const minVersion = minOf(
    tier?.min_version ?? undefined,
    license.min_version ?? undefined,
  );
  if (minVersion) payload.entitlements["app.minVersion"] = enforced(minVersion);

  const maxVersion = maxOf(
    tier?.max_version ?? undefined,
    license.max_version ?? undefined,
  );
  if (maxVersion) payload.entitlements["app.maxVersion"] = enforced(maxVersion);
}

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
