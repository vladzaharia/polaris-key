/// <reference types="@cloudflare/workers-types" />

import { Catalog } from "@polaris-key/catalog";
import {
  FINGERPRINT_ANCHOR,
  type DocProfile,
  type FingerprintComponent,
  type FingerprintMode,
  type ManagedEntry,
  type ManagedPayload,
} from "@polaris-key/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { hashKey, mintToken, randomId } from "./crypto.js";
import { mergePayloads } from "./merge.js";
import { tighterMax, tighterMin } from "./gate.js";
import {
  appendAudit,
  claimDeviceSeat,
  countActiveDevices,
  seatActiveSince,
  findFingerprintByHwid,
  getActiveSchema,
  getFingerprint,
  getLicense,
  getDevice,
  getDeviceByTokenHash,
  getProfile,
  getTier,
  listLicenseProfiles,
  setDeviceStatus,
  upsertDevice,
  upsertFingerprint,
  type FingerprintRow,
  type LicenseRow,
  type DeviceRow,
  type TierRow,
} from "./repo.js";
import {
  computeHwid,
  matchFingerprint,
  resolveFingerprintMode,
  type ComponentMap,
  type PresentedFingerprint,
  type StoredFingerprint,
} from "./fingerprint.js";
import {
  deleteTokenRecord,
  getTokenRecord,
  putTokenRecord,
  type TokenRecord,
} from "./kv.js";
import { openManagedPayload } from "./admin/lib/managedSecrets.js";

export interface ValidDeviceToken {
  tokenHash: string;
  license: LicenseRow;
  device: DeviceRow;
}

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

export function licenseUsable(
  license: LicenseRow | null,
  now: number,
): license is LicenseRow {
  if (!license || license.status !== "active") return false;
  if (license.expires_at !== null && now > license.expires_at) return false;
  return true;
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

/** Rehydrate a stored fingerprint row into the shape the pure matcher takes. */
function toStoredFingerprint(row: FingerprintRow): StoredFingerprint {
  let components: ComponentMap = {};
  try {
    const parsed: unknown = JSON.parse(row.components_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      components = parsed as ComponentMap;
    }
  } catch {
    // A corrupt row must not wedge activation — an empty component map simply matches
    // nothing that was stored, so the device rebinds on its next attempt.
  }
  return {
    hwid: row.hwid,
    components,
    anchorHash: row.anchor_hash,
    status: row.status === "unverified" ? "unverified" : "verified",
  };
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
  // fingerprinting keep working everywhere else (recorded `unverified` below).
  if (mode === "strict" && !presented) return { error: "fingerprint_required" };

  const existing = await getDevice(db, product.slug, deviceId);

  // The hardware check runs BEFORE the seat check so a swapped machine gets a precise
  // `hardware_mismatch` instead of a confusing `device_limit`.
  let drift: { count: number; changed: FingerprintComponent[] } | null = null;
  if (presented && mode !== "off" && existing?.status === "authorized") {
    const storedRow = await getFingerprint(db, product.slug, deviceId);
    if (storedRow) {
      const match = matchFingerprint(
        toStoredFingerprint(storedRow),
        presented,
        mode,
      );
      if (match.kind === "mismatch") {
        // Retire the binding rather than rebinding in place. The old machine is gone, so it
        // must not keep holding a seat; deauthorizing frees it (and purges the fingerprint
        // and facts rows via setDeviceStatus). The client's retry then re-authorizes this
        // same device_id through the normal path — `isNewAuthorization` is now true, so the
        // seat check runs again and the new hardware binds cleanly.
        await setDeviceStatus(db, product.slug, deviceId, "deauthorized");
        if (existing.token_hash) {
          await deleteTokenRecord(env, product.slug, existing.token_hash);
        }
        await appendAudit(db, {
          product: product.slug,
          id: randomId("aud"),
          at: now,
          actor_sub: null,
          actor_name: null,
          actor_email: null,
          action: "device.fingerprint.mismatch",
          target_kind: "device",
          target_id: deviceId,
          parent_id: license.id,
          summary: `Hardware mismatch (${match.drift} components changed: ${match.changed.join(", ")}); binding retired`,
        });
        return {
          error: "hardware_mismatch",
          drift: match.drift,
          changed: match.changed,
        };
      }
      if (match.kind === "drift") {
        drift = { count: match.drift, changed: match.changed };
      }
    }
  }

  const isNewAuthorization =
    !existing ||
    existing.status !== "authorized" ||
    existing.license_id !== license.id;

  // `X-PKey-Device` is a client-chosen string with no uniqueness requirement, so before this
  // the cheapest way to hold N seats was to activate N times with N device ids from ONE
  // machine — the server computed N identical hwids and never compared them.
  // `findFingerprintByHwid` existed for exactly this and had zero callers (R3-11).
  //
  // POLICY: one machine holds one seat per license, and the NEWEST device id wins. Coalescing
  // rather than refusing is deliberate — a reinstall or a cleared config legitimately produces
  // a fresh device id, and refusing would strand the customer on a seat they can no longer
  // reach. Retiring the stale id frees its seat and purges its fingerprint/facts rows through
  // the same `setDeviceStatus` path the hardware-mismatch arm above uses.
  //
  // Scoped to the SAME license on purpose: one machine may legitimately hold this product's
  // free enrolled license AND a purchased one, and those are different seat pools.
  //
  // Gated on `mode !== "off"` so a product whose customers genuinely run several instances on
  // one host (containers sharing a machine UUID) has a documented escape hatch: turning
  // fingerprint enforcement off for the product or the tier restores independent device ids.
  const hwid = presented ? await computeHwid(presented.components) : null;
  if (isNewAuthorization && hwid && mode !== "off") {
    const sibling = await findFingerprintByHwid(db, product.slug, hwid);
    if (sibling && sibling.device_id !== deviceId) {
      const siblingDevice = await getDevice(
        db,
        product.slug,
        sibling.device_id,
      );
      if (
        siblingDevice?.status === "authorized" &&
        siblingDevice.license_id === license.id
      ) {
        await setDeviceStatus(
          db,
          product.slug,
          sibling.device_id,
          "deauthorized",
        );
        if (siblingDevice.token_hash) {
          await deleteTokenRecord(env, product.slug, siblingDevice.token_hash);
        }
        await appendAudit(db, {
          product: product.slug,
          id: randomId("aud"),
          at: now,
          actor_sub: null,
          actor_name: null,
          actor_email: null,
          action: "device.seat.coalesced",
          target_kind: "device",
          target_id: sibling.device_id,
          parent_id: license.id,
          summary: `Same hardware re-registered as ${deviceId}; retired the stale device id so one machine holds one seat`,
        });
      }
    }
  }

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

  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  if (existing?.token_hash && existing.token_hash !== tokenHash) {
    await deleteTokenRecord(env, product.slug, existing.token_hash);
  }

  const device: DeviceRow = {
    product: product.slug,
    device_id: deviceId,
    customer_id: existing?.customer_id ?? null,
    license_id: license.id,
    status: "authorized",
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    ua: opts.userAgent ?? existing?.ua ?? null,
    label: existing?.label ?? null,
    overrides_json: existing?.overrides_json ?? null,
    reported_json: existing?.reported_json ?? null,
    token_hash: tokenHash,
    platform: opts.platform ?? existing?.platform ?? null,
    arch: opts.arch ?? existing?.arch ?? null,
    app_version: opts.appVersion ?? existing?.app_version ?? null,
    sdk_name: opts.sdkName ?? existing?.sdk_name ?? null,
    sdk_version: opts.sdkVersion ?? existing?.sdk_version ?? null,
  };
  await upsertDevice(db, device);

  if (presented) {
    // The client's own hwid is never trusted — recomputing it here is what stops a forged
    // value from colliding with another device's free-tier dedupe key.
    const priorRow = await getFingerprint(db, product.slug, deviceId);
    await upsertFingerprint(db, {
      product: product.slug,
      device_id: deviceId,
      hwid: hwid ?? (await computeHwid(presented.components)),
      components_json: JSON.stringify(presented.components),
      anchor_hash: presented.components[FINGERPRINT_ANCHOR] ?? null,
      status: "verified",
      first_seen: priorRow?.first_seen ?? now,
      last_seen: now,
      last_drift_at: drift ? now : (priorRow?.last_drift_at ?? null),
      last_drift_count: drift
        ? drift.count
        : (priorRow?.last_drift_count ?? null),
    });
    if (drift) {
      await appendAudit(db, {
        product: product.slug,
        id: randomId("aud"),
        at: now,
        actor_sub: null,
        actor_name: null,
        actor_email: null,
        action: "device.fingerprint.drift",
        target_kind: "device",
        target_id: deviceId,
        parent_id: license.id,
        summary: `Hardware drift tolerated (${drift.count} changed: ${drift.changed.join(", ")})`,
      });
    }
  } else if (mode !== "off") {
    // No fingerprint from a client that could have sent one: record the device as unverified
    // so an operator can tell "predates fingerprinting" from "declined to identify".
    const priorRow = await getFingerprint(db, product.slug, deviceId);
    if (!priorRow) {
      await upsertFingerprint(db, {
        product: product.slug,
        device_id: deviceId,
        hwid: "",
        components_json: "{}",
        anchor_hash: null,
        status: "unverified",
        first_seen: now,
        last_seen: now,
        last_drift_at: null,
        last_drift_count: null,
      });
    }
  }

  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    deviceId: deviceId,
    licenseId: license.id,
  });
  return { token, device };
}

export async function validateDeviceToken(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  now: number,
  opts: { deviceId?: string | null } = {},
): Promise<ValidDeviceToken | { error: "unauthorized" }> {
  if (!token) return { error: "unauthorized" };
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const cached = await getTokenRecord(env, product.slug, tokenHash);
  if (cached && cached.product !== product.slug)
    return { error: "unauthorized" };
  const device = cached
    ? await getDevice(db, product.slug, cached.deviceId)
    : await getDeviceByTokenHash(db, product.slug, tokenHash);
  const rec: TokenRecord | null =
    cached ??
    (device
      ? {
          product: product.slug,
          deviceId: device.device_id,
          licenseId: device.license_id,
        }
      : null);

  if (opts.deviceId && rec?.deviceId !== opts.deviceId)
    return { error: "unauthorized" };
  if (!device || device.status !== "authorized")
    return { error: "unauthorized" };
  if (!rec) return { error: "unauthorized" };
  if (device.license_id !== rec.licenseId || device.token_hash !== tokenHash)
    return { error: "unauthorized" };

  const license = await getLicense(db, product.slug, rec.licenseId);
  if (!licenseUsable(license, now)) return { error: "unauthorized" };

  // R10-12 — the cache is back-filled ONLY once every check above has passed. Writing it as
  // soon as the device row was found (the previous behaviour) meant replaying a token that had
  // just been revoked — deauthorized device, disabled or expired license — silently recreated
  // the KV record that `deleteTokenRecord` had purged, so a "revoked" credential kept
  // re-materialising its own hot-path entry on every attempt.
  if (!cached) await putTokenRecord(env, product.slug, tokenHash, rec);
  return { tokenHash, license, device };
}

export async function rotateDeviceToken(
  env: Env,
  db: Db,
  product: Product,
  valid: ValidDeviceToken,
  now: number,
): Promise<string> {
  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  await deleteTokenRecord(env, product.slug, valid.tokenHash);
  await upsertDevice(db, {
    ...valid.device,
    last_seen: now,
    token_hash: tokenHash,
  });
  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    deviceId: valid.device.device_id,
    licenseId: valid.license.id,
  });
  return token;
}
