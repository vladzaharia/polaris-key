/// <reference types="@cloudflare/workers-types" />

import { Catalog } from "@plrs/catalog";
import {
  type DocProfile,
  type FingerprintComponent,
  type FingerprintMode,
  type ManagedEntry,
  type ManagedPayload,
} from "@plrs/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./core/products.js";
import { mergePayloads } from "./merge.js";
import { tighterMax, tighterMin } from "./gate.js";
import {
  claimDeviceSeat,
  countActiveDevices,
  seatActiveSince,
  getActiveSchema,
  getProfile,
  getTier,
  listLicenseProfiles,
  type LicenseRow,
  type DeviceRow,
  type TierRow,
} from "./repo.js";
import {
  resolveFingerprintMode,
  type PresentedFingerprint,
} from "./fingerprint.js";
import {
  bindDevice,
  licenseUsable,
  reconcileDeviceHardware,
} from "./core/devices.js";
import { openManagedPayload } from "./admin/lib/managedSecrets.js";

export type AuthzError =
  | { error: "unauthorized" }
  | { error: "device_limit"; limit: number; deviceCount: number }
  | { error: "fingerprint_required" }
  | {
      error: "hardware_mismatch";
      drift: number;
      changed: FingerprintComponent[];
    };

function docProfile(license: LicenseRow): DocProfile {
  const name = license.name ?? "";
  return {
    name,
    firstName: name.split(" ")[0] ?? "",
    email: license.email ?? "",
    activatedAt: license.activated_at,
  };
}

export { docProfile };

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
 */
function injectAdminPolicy(
  payload: ManagedPayload,
  tier: TierRow | null,
  license: LicenseRow,
  tighterMin: (a?: string, b?: string) => string | undefined,
  tighterMax: (a?: string, b?: string) => string | undefined,
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

  const minVersion = tighterMin(
    tier?.min_version ?? undefined,
    license.min_version ?? undefined,
  );
  if (minVersion) payload.entitlements["app.minVersion"] = enforced(minVersion);

  const maxVersion = tighterMax(
    tier?.max_version ?? undefined,
    license.max_version ?? undefined,
  );
  if (maxVersion) payload.entitlements["app.maxVersion"] = enforced(maxVersion);
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

function resolveDeviceLimit(payload: ManagedPayload, fallback: number): number {
  const e = payload.entitlements["deviceLimit"];
  return e && typeof e.value === "number" ? e.value : fallback;
}

async function catalogDefaultPayload(
  db: Db,
  product: string,
  now: number,
): Promise<string | null> {
  const schemaRow = await getActiveSchema(db, product);
  if (!schemaRow) return null;
  try {
    const catalog = new Catalog(JSON.parse(schemaRow.catalog_json));
    const payload: ManagedPayload = {
      config: {},
      secrets: {},
      entitlements: {},
    };
    for (const entry of catalog.entries) {
      if (entry.kind !== "config" || entry.default === undefined) continue;
      payload.config[entry.key] = {
        state: entry.managementDefault ?? "default",
        value: entry.default as ManagedEntry["value"],
        updatedAt: now,
      };
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

/**
 * Merge every managed-payload layer for one license/device into the effective payload.
 *
 * `env` is OPTIONAL and is the reader half of R12-02. `admin/lib/overrides.ts` now `seal()`s
 * catalog-declared secrets (`kind: "secret"`, or `kind: "config"` with `secret: true`) before
 * they reach `profiles.payload_json` / `licenses.overrides_json`, so a stored value is an
 * AES-GCM envelope rather than the plaintext it used to be. Pass `env` on any path that mints
 * a signed config doc or renders a value to an owner and the envelopes are opened here; omit it
 * and the envelope survives into `configDoc.validatePayload`, which prunes it as a schema
 * violation — fail-closed, but the secret silently stops being delivered.
 *
 * Callers that only read `payload.entitlements` (the seat check below, `portal/api.ts`'s
 * `entitlementView`) do NOT need it: entitlements are never sealed.
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
  const layers: (string | null | undefined)[] = [
    await catalogDefaultPayload(db, product, now),
  ];

  let tier: TierRow | null = null;
  if (license.tier_id) {
    tier = await getTier(db, product, license.tier_id);
    if (tier?.profile_id) {
      const p = await getProfile(db, product, tier.profile_id);
      layers.push(p?.payload_json ?? null);
    }
  }

  const profiles = await listLicenseProfiles(db, product, license.id);
  if (profiles.length > 0) {
    for (const ref of profiles) {
      const p = await getProfile(db, product, ref.profile_id);
      layers.push(p?.payload_json ?? null);
    }
  }

  layers.push(license.overrides_json, device?.overrides_json ?? null);
  const payload = mergePayloads(...layers);
  injectAdminPolicy(
    payload,
    tier,
    license,
    policy.tighterMin,
    policy.tighterMax,
  );
  // R12-02 read half. Opening happens AFTER the merge so a sealed value in a lower layer that
  // a higher layer overrides is never decrypted at all, and after `injectAdminPolicy` because
  // server policy is authored here in plaintext and must not be mistaken for an envelope.
  return env ? openManagedPayload(env, product, payload) : payload;
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
    // Use gate.ts's semver-correct comparators rather than a lexicographic string compare.
    // Only `deviceLimit` is read from this result today, so the old inline version wasn't
    // producing a visible bug — but it was duplicated, drift-prone logic sitting next to the
    // real hot path that already imports the correct ones.
    const eff = await resolveEffective(db, product.slug, license, null, now, {
      tighterMin,
      tighterMax,
    });
    const limit = resolveDeviceLimit(eff, product.defaultDeviceLimit);

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
