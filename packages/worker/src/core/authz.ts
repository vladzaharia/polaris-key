/// <reference types="@cloudflare/workers-types" />

/**
 * The SEAT decision, and the licence-qualified device check that hangs off it — Core-mediated
 * because two services now perform them (design spec §5.1 "Boundary enforcement", §5.2).
 *
 * ── WHAT IS HERE ────────────────────────────────────────────────────────────────────────────
 *
 *   requireLicensedDevice   a live device token whose licence is usable
 *   resolveEntitlements     the merged entitlement map for one licence/device
 *   authorizeDevice         licence usability → tier → fingerprint MODE → [core]
 *                           reconcileDeviceHardware → seat limit → [core] bindDevice
 *   docProfile              the signed greeting block
 *   tierExpiresAt           the `expires_at` a licence gets from its tier
 *   resolveEffective        the legacy FUSED payload (config + secrets + entitlements)
 *
 * ── WHY IT IS IN CORE ───────────────────────────────────────────────────────────────────────
 *
 * These were License's when License was the only service that minted a grant. Identity's carve
 * (P3) makes that false: `POST /<p>/identity/session/license` and the whole OIDC sign-in path
 * authorize a device and mint a token, and `GET /<p>/identity/session` builds a document from
 * the same merged payload. A service may not import a sibling (`test/boundaries.test.ts`), and
 * duplicating a seat check is how two services end up admitting a different number of machines
 * to the same licence.
 *
 * So the computation lives here — exactly the argument `core/entitledAccess.ts` already makes
 * for the `entitled` access mode, and the argument that moved `injectAdminPolicy` and the
 * semver algebra into `core/entitlements.ts`. Every piece it is built from was already Core's:
 * `claimDeviceSeat`, `countActiveDevices`, `bindDevice`, `reconcileDeviceHardware`,
 * `licenseUsable`, `validateDeviceToken` (`core/devices.ts`), the layer walk
 * (`core/payload.ts`) and the entitlement algebra (`core/entitlements.ts`).
 *
 * `services/license/{authz,auth,entitlements}.ts` and the `licenseCore.ts` compat shim
 * re-export from here, so every existing importer is unchanged and the ORDER of side effects is
 * byte-for-byte what it was: the hardware check still runs before the seat check (a swapped
 * machine gets `hardware_mismatch`, not a confusing `device_limit`), and the rows are still
 * written only after a seat is claimed.
 */

import type {
  DocProfile,
  FingerprintComponent,
  FingerprintMode,
  ManagedEntry,
} from "@polaris-key/protocol";
import type { ManagedPayload } from "./payload.js";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import {
  claimDeviceSeat,
  countActiveDevices,
  getTier,
  seatActiveSince,
  type DeviceRow,
  type LicenseRow,
  type TierRow,
} from "./data.js";
import {
  resolveFingerprintMode,
  type PresentedFingerprint,
} from "./fingerprint.js";
import {
  bindDevice,
  licenseUsable,
  reconcileDeviceHardware,
  validateDeviceToken,
  type LicensedDeviceToken,
} from "./devices.js";
import { openManagedPayload, resolveMergedPayload } from "./payload.js";
import { injectAdminPolicy, tighterMax, tighterMin } from "./entitlements.js";

export type AuthzError =
  | { error: "unauthorized" }
  | { error: "device_limit"; limit: number; deviceCount: number }
  | { error: "fingerprint_required" }
  | {
      error: "hardware_mismatch";
      drift: number;
      changed: FingerprintComponent[];
    };

/**
 * Validate a device token AND require the licence behind it to be usable.
 *
 * Core's `validateDeviceToken` answers only "is this token a live device", because a
 * config-only product has devices with no licence at all (D-08) and a Core that refused them
 * could never serve `GET /<p>/config/document`. This is the second half, applied in exactly the
 * position the fused version applied it — after the device row, the token-hash binding and the
 * device/licence agreement have all been checked, and before anything is returned.
 *
 * Returns the same `{ error: "unauthorized" }` for a bad token and for a dead licence: telling
 * them apart would let an unauthenticated caller probe licence state with a stolen token.
 */
export async function requireLicensedDevice(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  now: number,
  opts: { deviceId?: string | null } = {},
): Promise<LicensedDeviceToken | { error: "unauthorized" }> {
  const valid = await validateDeviceToken(env, db, product, token, now, opts);
  if ("error" in valid) return valid;
  if (!licenseUsable(valid.license, now)) return { error: "unauthorized" };
  return {
    tokenHash: valid.tokenHash,
    license: valid.license,
    device: valid.device,
  };
}

/**
 * The effective entitlement map for one licence/device: every stored layer, merged, with the
 * admin policy stamped on top.
 *
 * `env` is deliberately absent. `resolveEffective`'s optional `env` opens sealed managed
 * secrets (R12-02), and entitlements are never sealed — the licence document carries no secret
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

/**
 * Merge every managed-payload layer for one licence/device into the effective FUSED payload.
 *
 * Wire v3 split the document in two, so nothing new should call this: License takes
 * `.entitlements` through `resolveEntitlements`, Config takes `.config`/`.secrets` through its
 * own document builder. What still wants all three at once is the pre-v3 shape identity's
 * `GET /<p>/identity/session` mints for a browser and the portal renders in its entitlement
 * view. It is composed from the SAME two steps the split documents use, in the same order, so
 * it cannot drift away from them.
 *
 * `env` is OPTIONAL and is the reader half of R12-02. `admin/lib/overrides.ts` `seal()`s
 * catalog-declared secrets before they reach `profiles.payload_json` /
 * `licenses.overrides_json`, so a stored value is an AES-GCM envelope rather than the plaintext
 * it used to be. Pass `env` on any path that mints a signed document or renders a value to an
 * owner and the envelopes are opened here; omit it and the envelope survives into the catalog
 * prune, which drops it as a schema violation — fail-closed, but the secret silently stops
 * being delivered. Callers that only read `payload.entitlements` (the portal's entitlement
 * view) do NOT need it: entitlements are never sealed.
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

/** The seat limit `authorizeDevice` enforces on `license`: its resolved `deviceLimit`
 *  entitlement, else the product default. Exported for the identity attach (P1-07), which must
 *  not move more devices onto a licence than this allows, and for the portal's seat meter
 *  (PX-W1), which must show the same "of N" this enforces. */
export async function licenseDeviceLimit(
  db: Db,
  product: Pick<Product, "slug" | "defaultDeviceLimit">,
  license: LicenseRow,
  now: number,
): Promise<number> {
  const entitlements = await resolveEntitlements(
    db,
    product.slug,
    license,
    null,
    now,
  );
  return resolveDeviceLimit(entitlements, product.defaultDeviceLimit);
}

/** The fingerprint mode `authorizeDevice` enforces on a licence of tier `tierId`: the tier's
 *  policy, else the product default, or `off` when the product opts out. Exported for the
 *  identity attach (P1-07), which must not merge onto a tier whose mint would refuse a device
 *  that presents no fingerprint (`strict`). */
export async function tierFingerprintMode(
  db: Db,
  product: Product,
  tierId: string | null,
): Promise<FingerprintMode> {
  if (!product.fingerprintPolicy.enabled) return "off";
  const tier = tierId ? await getTier(db, product.slug, tierId) : null;
  return resolveFingerprintMode(
    tier?.policy_fingerprint,
    product.fingerprintPolicy.defaultMode,
  );
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

  const mode = await tierFingerprintMode(db, product, license.tier_id);
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
    const limit = await licenseDeviceLimit(db, product, license, now);

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
