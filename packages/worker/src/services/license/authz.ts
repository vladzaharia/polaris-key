/// <reference types="@cloudflare/workers-types" />

/**
 * The SEAT decision — is this licence usable, what does its tier allow, and is there capacity
 * for one more machine (design spec §5.2: `licenses`, `tiers` are License-owned).
 *
 * Moved verbatim from `licenseCore.ts`, whose device half already landed in `core/devices.ts`
 * during the Core extraction. The seam that file documents is unchanged and load-bearing:
 *
 *   authorizeDevice   licence usability → tier → fingerprint MODE → [core]
 *                     reconcileDeviceHardware → seat limit → [core] bindDevice
 *
 * so the ordering of side effects is byte-for-byte what it was — the hardware check still runs
 * before the seat check (a swapped machine gets `hardware_mismatch`, not a confusing
 * `device_limit`), and the rows are still written only after a seat is claimed.
 *
 * `licenseCore.ts` now re-exports this module for the pre-suite callers that have not moved
 * yet (identity's OIDC + browser session, the admin licence handlers).
 */

import type { FingerprintComponent, FingerprintMode } from "@plrs/protocol";
import type { ManagedEntry } from "@plrs/protocol";
import type { Env, Db } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import type { DocProfile } from "@plrs/protocol";
import {
  claimDeviceSeat,
  countActiveDevices,
  seatActiveSince,
  getTier,
  type LicenseRow,
  type DeviceRow,
  type TierRow,
} from "../../core/data.js";
import {
  resolveFingerprintMode,
  type PresentedFingerprint,
} from "../../core/fingerprint.js";
import {
  bindDevice,
  licenseUsable,
  reconcileDeviceHardware,
} from "../../core/devices.js";
import { resolveEntitlements } from "./entitlements.js";

export type AuthzError =
  | { error: "unauthorized" }
  | { error: "device_limit"; limit: number; deviceCount: number }
  | { error: "fingerprint_required" }
  | {
      error: "hardware_mismatch";
      drift: number;
      changed: FingerprintComponent[];
    };

/** The signed greeting block: name/email as the licence knows them, so a client can render a
 *  personalised, tamper-proof welcome offline. Tolerates a null name/email (an anonymous
 *  enrolment) by rendering empty strings rather than special-casing the document shape. */
export function docProfile(license: LicenseRow): DocProfile {
  const name = license.name ?? "";
  return {
    name,
    firstName: name.split(" ")[0] ?? "",
    email: license.email ?? "",
    activatedAt: license.activated_at,
  };
}

/**
 * The `expires_at` a licence gets from its tier — the single definition of "this tier is time
 * boxed", shared by every path that creates or re-tiers a licence.
 *
 * R3-06: `policy_expiry_days` was honoured on only two of the three insert sites. The two that
 * ignored it are the ADMIN paths, and the business consequence is the expensive direction: a
 * trial→paid re-licence kept the trial's `expires_at` and killed the licence days after the
 * customer paid, while paid→trial left a time-boxed tier perpetual. A tier's expiry policy is
 * a property of the tier, so it must be re-derived whenever the tier is assigned, not copied
 * once at creation.
 *
 * `null` means "no expiry": either the tier is not time boxed, or there is no tier.
 */
export function tierExpiresAt(
  tier: Pick<TierRow, "policy_expiry_days"> | null | undefined,
  now: number,
): number | null {
  return tier?.policy_expiry_days
    ? now + tier.policy_expiry_days * 86400
    : null;
}

function resolveDeviceLimit(
  entitlements: Record<string, ManagedEntry>,
  fallback: number,
): number {
  const e = entitlements["deviceLimit"];
  return e && typeof e.value === "number" ? e.value : fallback;
}

export async function authorizeDevice(
  env: Env,
  db: Db,
  product: Product,
  license: LicenseRow,
  deviceId: string,
  now: number,
  opts: {
    userAgent?: string | null;
    platform?: string | null;
    arch?: string | null;
    appVersion?: string | null;
    sdkName?: string | null;
    sdkVersion?: string | null;
    /** Validated hardware components, when the client supplied any. */
    fingerprint?: PresentedFingerprint | null;
  } = {},
): Promise<{ token: string; device: DeviceRow } | AuthzError> {
  if (!licenseUsable(license, now)) return { error: "unauthorized" };

  const tier = license.tier_id
    ? await getTier(db, product.slug, license.tier_id)
    : null;
  const mode: FingerprintMode = product.fingerprintPolicy.enabled
    ? resolveFingerprintMode(
        tier?.policy_fingerprint,
        product.fingerprintPolicy.defaultMode,
      )
    : "off";
  const presented = opts.fingerprint ?? null;

  // `strict` is the only mode that makes a fingerprint mandatory, so clients that predate
  // fingerprinting keep working everywhere else (recorded `unverified` by `bindDevice`).
  if (mode === "strict" && !presented) return { error: "fingerprint_required" };

  // Core owns the hardware reconciliation and the device-row bookkeeping it implies: retiring
  // a swapped binding, and coalescing a re-registered machine's stale device id. It runs
  // BEFORE the seat check for two reasons that are both behaviour — a swapped machine gets a
  // precise `hardware_mismatch` instead of a confusing `device_limit`, and a coalesced sibling
  // has already released its seat by the time capacity is counted below.
  const reconciled = await reconcileDeviceHardware(
    env,
    db,
    product,
    license,
    deviceId,
    now,
    { mode, presented },
  );
  if ("error" in reconciled) return reconciled;
  const { isNewAuthorization } = reconciled;
  if (isNewAuthorization) {
    // The seat limit is an ENTITLEMENT, resolved through the same pipeline the license
    // document is built from — so the number enforced here and the `deviceLimit` the client
    // reads out of its document can never disagree.
    const entitlements = await resolveEntitlements(
      db,
      product.slug,
      license,
      null,
      now,
    );
    const limit = resolveDeviceLimit(entitlements, product.defaultDeviceLimit);

    // R3-02 / R11-02 — the seat is claimed by the DATABASE, not by a read-then-write.
    // `claimDeviceSeat` takes the lowest free ordinal under `idx_devices_seat`
    // (UNIQUE (product, license_id, seat_no) WHERE status = 'authorized'), so two isolates
    // that compute the same ordinal cannot both commit: the loser retries against the ordinal
    // set as it now stands and eventually runs out. N concurrent activations against a limit
    // of L therefore admit exactly L, where previously all N were admitted.
    //
    // A non-positive limit now DENIES rather than meaning "unlimited" — reading `<= 0` as
    // unlimited was the fail-open half of R11-02, and the DB no longer accepts such a value.
    // The pre-count is kept ahead of the claim for two reasons: it reports the true
    // `deviceCount` in the error, and it still refuses rows written before `seat_no` existed
    // (a legacy authorized device holds no ordinal, so the seat map alone would under-count).
    // Dormant devices do not hold seats (`SEAT_DORMANCY_SECONDS`): the count and
    // `claimDeviceSeat`'s ordinal map must agree on who is still occupying capacity, or the
    // pre-count would refuse an activation the seat map would happily have granted.
    const count = await countActiveDevices(
      db,
      product.slug,
      license.id,
      seatActiveSince(now),
    );
    if (limit <= 0 || count >= limit) {
      return { error: "device_limit", limit, deviceCount: count };
    }
    if (
      !(await claimDeviceSeat(
        db,
        product.slug,
        license.id,
        deviceId,
        limit,
        now,
      ))
    ) {
      return {
        error: "device_limit",
        limit,
        deviceCount: await countActiveDevices(
          db,
          product.slug,
          license.id,
          seatActiveSince(now),
        ),
      };
    }
  }

  // Core mints the token and writes every row the binding consists of.
  return bindDevice(env, db, product, license, deviceId, now, {
    existing: reconciled.existing,
    presented,
    hwid: reconciled.hwid,
    mode,
    drift: reconciled.drift,
    metadata: opts,
  });
}
