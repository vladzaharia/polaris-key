/// <reference types="@cloudflare/workers-types" />

/**
 * The Device principal — core's always-on substrate for "which machine is this, and is its
 * credential still live" (design spec §5.1: registration, `pkeyt_` tokens, list/rename/
 * deauthorize, fingerprints, facts/telemetry).
 *
 * Assembled from the device halves of `licenseCore.ts` (`validateDeviceToken`,
 * `rotateDeviceToken`, and the device-row bookkeeping inside `authorizeDevice`) and
 * `licensing.ts` (`/devices` self-service, the report/facts surface, device metadata and the
 * activation-body fingerprint reader). Nothing here changed behaviour in the move.
 *
 * ── THE SEAM WITH LICENSE ────────────────────────────────────────────────────────────────────
 *
 * `authorizeDevice` genuinely straddles: it is a SEAT decision (license-owned: is the licence
 * usable, what does the tier allow, is there capacity) wrapped around DEVICE bookkeeping
 * (hardware reconciliation, token mint/rotation/purge, the `devices`/`device_fingerprints`
 * rows, the KV token record). It is split rather than moved:
 *
 *   licenseCore.authorizeDevice   licence usability -> tier -> fingerprint MODE -> [core]
 *                                 reconcileDeviceHardware -> seat limit -> [core] bindDevice
 *
 * so the ordering of side effects is byte-for-byte what it was: the hardware check still runs
 * before the seat check (a swapped machine gets `hardware_mismatch`, not a confusing
 * `device_limit`), and the rows are still written only after a seat is claimed.
 *
 * `licenseUsable` lives here, not with the rest of the licence logic, because Core's own
 * `validateDeviceToken` depends on it — a device token is live only while the licence behind it
 * is — and Core must never import a service. It is a pure predicate over a `LicenseRow`; License
 * imports it back from core.
 */

import {
  FINGERPRINT_ANCHOR,
  MAX_DEVICE_PROBES,
  type DeviceProbeResult,
  type FingerprintComponent,
  type FingerprintMode,
} from "@polaris-key/protocol";
import {
  HEADER_ARCH,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol/core";
import {
  normalizeArchHeader,
  normalizePlatformHeader,
  normalizeSdkHeader,
} from "./clientMetadata.js";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product, ProductPublic } from "./products.js";
import {
  hashKey,
  isDeviceToken,
  mintDeviceToken,
  randomId,
} from "../crypto.js";
import {
  appendAudit,
  findFingerprintByHwid,
  getDevice,
  getDeviceByTokenHash,
  getFingerprint,
  getLicense,
  listDevicesByLicense,
  setDeviceLabel,
  setDeviceReported,
  setDeviceStatus,
  upsertDevice,
  upsertDeviceFacts,
  upsertFingerprint,
  type DeviceFactsRow,
  type DeviceRow,
  type FingerprintRow,
  type LicenseRow,
} from "../repo.js";
import {
  computeHwid,
  matchFingerprint,
  parseFingerprint,
  type ComponentMap,
  type PresentedFingerprint,
  type StoredFingerprint,
} from "../fingerprint.js";
import {
  deleteTokenRecord,
  getTokenRecord,
  putTokenRecord,
  type TokenRecord,
} from "../kv.js";
import { bearer } from "../http.js";
import { errorResponse, ErrorCode, json, methodNotAllowed } from "./errors.js";
import {
  boundedUpdates,
  recordUpdateEvents,
  staticScope,
  updateScope,
} from "./updateHealth.js";
import type { ServiceHooks } from "./hooks.js";

/**
 * What a valid device token proves, at CORE's level of authority: this token belongs to this
 * live device row of this product.
 *
 * `license` is the row the device is BOUND to, loaded because the caller almost always needs it
 * and re-reading it would be a second query for the same answer — but it is deliberately NOT
 * usability-checked here, and it is nullable.
 *
 * ── THE SEAM WITH LICENSE (wire v3 §6, D-08) ────────────────────────────────────────────────
 *
 * Until v3, "is this token valid" and "is the licence behind it usable" were one question, and
 * `validateDeviceToken` answered both. They are now different questions, because a product may
 * run Config with License DISABLED: its devices are registered, hold real `pkeyt_` tokens, and
 * have no licence at all. If Core kept refusing a device whose licence is missing or lapsed,
 * `GET /<p>/config/document` could never answer for such a product, and service independence
 * would be unimplementable at the only layer that could enforce it.
 *
 * So the split is:
 *
 *     core.validateDeviceToken          token → device row.        (this function)
 *     services/license/auth.requireLicensedDevice
 *                                       token → device row, AND the licence is usable.
 *
 * Every surface that was license-gated before still is — `requireLicensedDevice` is what they
 * call, and it applies `licenseUsable` in exactly the position this function used to, so the
 * 401s are the same 401s for the same reasons. `GET /<p>/config/document` takes the core-only
 * answer outright; Core's own `/devices` and `/devices/report`, and the config service's
 * edge-mint guard, take it CONDITIONALLY — see `coreDeviceAllowed` below for the rule and why
 * it is scoped to the enablement flag rather than to the presence of a licence row.
 */
export interface ValidDeviceToken {
  tokenHash: string;
  /** The licence this device is bound to; `null` when the row names one that no longer exists.
   *  NOT checked for usability — see `licenseUsable` and the seam note above. */
  license: LicenseRow | null;
  device: DeviceRow;
}

/** `ValidDeviceToken` narrowed to the license-enabled case: the licence exists AND is usable.
 *  Produced only by `services/license/auth.requireLicensedDevice`. */
export interface LicensedDeviceToken extends ValidDeviceToken {
  license: LicenseRow;
}

/** The hardware-reconciliation outcome that aborts an authorization. Structurally identical to
 *  `AuthzError`'s `hardware_mismatch` member, which stays license-side with `authorizeDevice`. */
export interface DeviceHardwareMismatch {
  error: "hardware_mismatch";
  drift: number;
  changed: FingerprintComponent[];
}

/** Hardware state reconciled against the stored binding, ready for the seat decision. */
export interface ReconciledDevice {
  /** The device row as it stands, or null for a first-ever authorization. */
  existing: DeviceRow | null;
  /** True when this authorization needs a seat: new device, revoked device, or relicensed. */
  isNewAuthorization: boolean;
  /** The SERVER-computed hwid for the presented components (never the client's own). */
  hwid: string | null;
  /** Tolerated drift to record on the fingerprint row, when the match was not exact. */
  drift: { count: number; changed: FingerprintComponent[] } | null;
}

/**
 * What `devices.license_id` holds for a device that was REGISTERED rather than activated
 * (wire v3 §6): the empty string.
 *
 * ── WHY A SENTINEL AND NOT NULL ─────────────────────────────────────────────────────────────
 *
 * `devices.license_id` is `TEXT NOT NULL` (migrations/0001_init.sql), and SQLite cannot relax a
 * NOT NULL in place — it takes a full table rebuild, which is a materially riskier migration
 * than the column it would fix, on the hot table every device row lives in. The empty string is
 * a value no minted licence id can collide with (`randomId` always emits `lic_…`), it is what
 * the KV token record carries too, and it reads back through the ONE lookup that matters —
 * `getLicense(db, product, "")` finds nothing, so `validateDeviceToken` sees `license: null`,
 * which is precisely the D-08 shape it already handles.
 *
 * The one rule it imposes: **never pass this to `listDevicesByLicense`**. That query groups by
 * licence, and every unlicensed device of a product shares this value — so asking it for "the
 * seats of licence ''" would hand one customer's device the whole product's device list. The
 * two call sites below therefore key off `valid.license` being null, not off the id.
 */
export const NO_LICENSE_ID = "";

export function licenseUsable(
  license: LicenseRow | null,
  now: number,
): license is LicenseRow {
  if (!license || license.status !== "active") return false;
  if (license.expires_at !== null && now > license.expires_at) return false;
  return true;
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

/**
 * Retire a device binding: deauthorize the row (which purges its fingerprint and facts through
 * `setDeviceStatus`) and evict its cached token record so the credential stops working now
 * rather than at KV expiry.
 */
export async function retireDeviceBinding(
  env: Env,
  db: Db,
  product: string,
  deviceId: string,
  tokenHash: string | null,
): Promise<void> {
  await setDeviceStatus(db, product, deviceId, "deauthorized");
  if (tokenHash) {
    await deleteTokenRecord(env, product, tokenHash);
  }
}

/**
 * Reconcile the presented hardware against what this product already knows, BEFORE any seat
 * decision is taken (see the seam note at the top of this file).
 */
export async function reconcileDeviceHardware(
  env: Env,
  db: Db,
  product: Product,
  license: LicenseRow,
  deviceId: string,
  now: number,
  opts: { mode: FingerprintMode; presented: PresentedFingerprint | null },
): Promise<ReconciledDevice | DeviceHardwareMismatch> {
  const { mode, presented } = opts;
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
        await retireDeviceBinding(
          env,
          db,
          product.slug,
          deviceId,
          existing.token_hash,
        );
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
        await retireDeviceBinding(
          env,
          db,
          product.slug,
          sibling.device_id,
          siblingDevice.token_hash,
        );
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

  return { existing, isNewAuthorization, hwid, drift };
}

/**
 * Mint the device's token and write every row the binding consists of: the `devices` row, the
 * fingerprint row (verified, or `unverified` for a client that could have identified itself and
 * did not), and the KV token record. Called only once the licence side has granted a seat.
 */
export async function bindDevice(
  env: Env,
  db: Db,
  product: Product,
  license: LicenseRow,
  deviceId: string,
  now: number,
  opts: {
    existing: DeviceRow | null;
    presented: PresentedFingerprint | null;
    hwid: string | null;
    mode: FingerprintMode;
    drift: { count: number; changed: FingerprintComponent[] } | null;
    metadata?: {
      userAgent?: string | null;
      platform?: string | null;
      arch?: string | null;
      appVersion?: string | null;
      sdkName?: string | null;
      sdkVersion?: string | null;
    };
  },
): Promise<{ token: string; device: DeviceRow }> {
  const { existing, presented, hwid, mode, drift } = opts;
  const meta = opts.metadata ?? {};

  const token = mintDeviceToken();
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
    ua: meta.userAgent ?? existing?.ua ?? null,
    label: existing?.label ?? null,
    overrides_json: existing?.overrides_json ?? null,
    reported_json: existing?.reported_json ?? null,
    token_hash: tokenHash,
    platform: meta.platform ?? existing?.platform ?? null,
    arch: meta.arch ?? existing?.arch ?? null,
    app_version: meta.appVersion ?? existing?.app_version ?? null,
    sdk_name: meta.sdkName ?? existing?.sdk_name ?? null,
    sdk_version: meta.sdkVersion ?? existing?.sdk_version ?? null,
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

/** What the presented request tells us about the machine, as `deviceMetadata` reads it. */
export type PresentedDeviceMetadata = ReturnType<typeof deviceMetadata>;

/**
 * Mint a device token for a device that has NO licence — the `POST /<p>/devices/register` half
 * of the device principal (wire v3 §6).
 *
 * Kept beside `bindDevice` rather than folded into it, because the two do genuinely different
 * work despite writing the same table. `bindDevice` is the tail of a SEAT decision: it exists to
 * record which licence granted this machine a place, and everything it does beyond the row —
 * the drift audit, the `unverified` fingerprint marker, the seat bookkeeping its callers wrap it
 * in — is about that grant. Registration grants nothing. There is no seat pool to dedupe
 * against, no tier to demand a fingerprint, and no licence to attribute an audit entry to, so
 * this is deliberately the shorter function rather than `bindDevice` with four parameters
 * carrying `null`.
 *
 * Fingerprint handling reflects that: a presented fingerprint is stored (recomputing the hwid
 * server-side, never trusting the client's), and an absent one is simply absent. No `unverified`
 * row — under an `open` policy declining to identify is the documented normal, not a signal.
 *
 * Re-registering an id that already holds a token is a TOKEN ROTATION, which is what a client
 * that lost its credential needs. The caller (`core/register.ts`) is responsible for refusing
 * the one case this must never do: taking over an id already bound to a real licence.
 */
export async function registerDeviceBinding(
  env: Env,
  db: Db,
  product: Product,
  deviceId: string,
  now: number,
  opts: {
    existing: DeviceRow | null;
    presented: PresentedFingerprint | null;
    metadata: PresentedDeviceMetadata;
  },
): Promise<{ token: string; device: DeviceRow }> {
  const { existing, presented, metadata: meta } = opts;

  const token = mintDeviceToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  if (existing?.token_hash && existing.token_hash !== tokenHash) {
    await deleteTokenRecord(env, product.slug, existing.token_hash);
  }

  const device: DeviceRow = {
    product: product.slug,
    device_id: deviceId,
    customer_id: existing?.customer_id ?? null,
    license_id: NO_LICENSE_ID,
    status: "authorized",
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    ua: meta.userAgent ?? existing?.ua ?? null,
    label: existing?.label ?? null,
    overrides_json: existing?.overrides_json ?? null,
    reported_json: existing?.reported_json ?? null,
    token_hash: tokenHash,
    platform: meta.platform ?? existing?.platform ?? null,
    arch: meta.arch ?? existing?.arch ?? null,
    app_version: meta.appVersion ?? existing?.app_version ?? null,
    sdk_name: meta.sdkName ?? existing?.sdk_name ?? null,
    sdk_version: meta.sdkVersion ?? existing?.sdk_version ?? null,
  };
  await upsertDevice(db, device);

  if (presented) {
    const priorRow = await getFingerprint(db, product.slug, deviceId);
    await upsertFingerprint(db, {
      product: product.slug,
      device_id: deviceId,
      hwid: await computeHwid(presented.components),
      components_json: JSON.stringify(presented.components),
      anchor_hash: presented.components[FINGERPRINT_ANCHOR] ?? null,
      status: "verified",
      first_seen: priorRow?.first_seen ?? now,
      last_seen: now,
      last_drift_at: priorRow?.last_drift_at ?? null,
      last_drift_count: priorRow?.last_drift_count ?? null,
    });
  }

  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    deviceId,
    licenseId: NO_LICENSE_ID,
  });
  return { token, device };
}

export async function validateDeviceToken(
  env: Env,
  db: Db,
  product: ProductPublic,
  token: string | null,
  now: number,
  opts: { deviceId?: string | null } = {},
): Promise<ValidDeviceToken | { error: "unauthorized" }> {
  if (!token) return { error: "unauthorized" };
  // Wire v3 §6/§8: the device principal is `pkeyt_`. Anything else — a `plrst_` token, a licence
  // key, or a session cookie value pasted into the Authorization header — is refused on SHAPE,
  // before the pepper HMAC and the KV/D1 reads it would otherwise cost. That rejection has to be
  // an explicit rule and not merely a consequence of no such hash existing, or it would be a
  // fact about the current contents of a table rather than about this code.
  if (!isDeviceToken(token)) return { error: "unauthorized" };
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

  // R10-12 — the cache is back-filled ONLY once every check above has passed. Writing it as
  // soon as the device row was found (the previous behaviour) meant replaying a token that had
  // just been revoked — deauthorized device, disabled or expired license — silently recreated
  // the KV record that `deleteTokenRecord` had purged, so a "revoked" credential kept
  // re-materialising its own hot-path entry on every attempt.
  //
  // `licenseUsable` survives here as a CACHE-WRITE guard even though it is no longer an
  // authorization decision (that moved to `requireLicensedDevice`). Splitting the two questions
  // must not un-fix R10-12: a token whose licence is disabled or expired still re-warms
  // nothing, whatever the caller goes on to decide. A device with NO licence row is the D-08
  // shape rather than a revocation, so it is cached normally.
  if (!cached && (license === null || licenseUsable(license, now))) {
    await putTokenRecord(env, product.slug, tokenHash, rec);
  }
  return { tokenHash, license, device };
}

export async function rotateDeviceToken(
  env: Env,
  db: Db,
  product: Product,
  valid: ValidDeviceToken,
  now: number,
): Promise<string> {
  const token = mintDeviceToken();
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
    // The DEVICE row's binding, not the licence object's id — `validateDeviceToken` has
    // already asserted the two agree, and reading it here keeps rotation working for a device
    // that holds no licence row at all (§6).
    licenseId: valid.device.license_id,
  });
  return token;
}

/**
 * Fold the request's client metadata into the device row and stamp `last_seen`.
 *
 * Was inline in `/config`, which was the one hot path every SDK hit on a schedule. Wire v3
 * splits that request into two documents, so the touch moves into Core and BOTH document
 * routes call it: whichever services a product runs, a device that is talking to us is
 * recorded as seen. The write is a full-row upsert of values that are almost always unchanged,
 * so calling it twice in one sync is idempotent rather than merely tolerable.
 */
export async function touchDeviceMetadata(
  db: Db,
  device: DeviceRow,
  meta: ReturnType<typeof deviceMetadata>,
  now: number,
): Promise<void> {
  await upsertDevice(db, {
    ...device,
    last_seen: now,
    ua: meta.userAgent ?? device.ua,
    platform: meta.platform ?? device.platform ?? null,
    arch: meta.arch ?? device.arch ?? null,
    app_version: meta.appVersion ?? device.app_version ?? null,
    sdk_name: meta.sdkName ?? device.sdk_name ?? null,
    sdk_version: meta.sdkVersion ?? device.sdk_version ?? null,
  });
}

/** The client metadata headers as stored (WIRE-CONTRACT-V3 §5.2 rule 3): platform, arch and SDK
 *  canonical where the spelling is known (`core/clientMetadata.ts`), and an empty header absent,
 *  so `?? existing` at the merge sites keeps the stored value rather than blanking it. */
export function deviceMetadata(req: Request): {
  userAgent: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sdkName: string | null;
  sdkVersion: string | null;
} {
  return {
    userAgent: req.headers.get("user-agent"),
    platform: normalizePlatformHeader(req.headers.get(HEADER_PLATFORM)),
    arch: normalizeArchHeader(req.headers.get(HEADER_ARCH)),
    appVersion: req.headers.get(HEADER_VERSION),
    sdkName: normalizeSdkHeader(req.headers.get(HEADER_SDK_NAME)),
    sdkVersion: req.headers.get(HEADER_SDK_VERSION),
  };
}

/** Largest activation body we will read. A fingerprint is a handful of short digests; this is
 *  generous for that and far below the report cap. */
const MAX_ACTIVATE_BODY = 4 * 1024;

/**
 * Read the optional activation body's fingerprint.
 *
 * `/activate` carried no body before fingerprinting, so an absent, empty, oversized, or
 * unparseable body means "no fingerprint" and never an error — otherwise every already-shipped
 * client would start failing the moment this deployed. Whether a missing fingerprint is
 * actually acceptable is the tier's decision, enforced in `authorizeDevice`.
 */
export async function readFingerprint(
  req: Request,
): Promise<PresentedFingerprint | null> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_ACTIVATE_BODY) return null;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (!raw.trim() || raw.length > MAX_ACTIVATE_BODY) return null;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    return parseFingerprint(body.fingerprint);
  } catch {
    return null;
  }
}

/**
 * The licence requirement Core's own surfaces apply — `GET/PATCH/DELETE /<p>/devices[/:id]` and
 * `POST /<p>/devices/report`.
 *
 * ── THE RULE (wire v3 §6, D-08) ─────────────────────────────────────────────────────────────
 *
 * **The licence check applies if and only if the product runs the License service.**
 *
 * These two surfaces are Core's, "available under every policy" (§6), and until registration
 * existed that cost nothing: every device had a licence, so requiring a usable one was a
 * distinction without a difference. It is a difference now. A config-only product's devices
 * hold real `pkeyt_` tokens and no licence at all, and a Core surface that refused them would
 * make "Core is always on" false for exactly the products the suite exists to enable — they
 * could fetch a signed config document but could not rename the device that fetched it.
 *
 * The relaxation is scoped to the enablement flag, not to the presence of a licence row, so a
 * LICENSED product's behaviour is byte-for-byte what it was: an expired, revoked or missing
 * licence is still a 401 on both surfaces, and no device of such a product gains anything by
 * arriving without one.
 */
function coreDeviceAllowed(
  product: Product,
  valid: ValidDeviceToken,
  now: number,
): boolean {
  if (!product.services.license.enabled) return true;
  return licenseUsable(valid.license, now);
}

export function shapeDevice(device: DeviceRow, currentDeviceId?: string) {
  return {
    id: device.device_id,
    licenseId: device.license_id,
    label: device.label,
    status: device.status,
    current: device.device_id === currentDeviceId,
    firstSeen: device.first_seen,
    lastSeen: device.last_seen,
    userAgent: device.ua,
    platform: device.platform ?? null,
    arch: device.arch ?? null,
    appVersion: device.app_version ?? null,
    sdkName: device.sdk_name ?? null,
    sdkVersion: device.sdk_version ?? null,
  };
}

/** GET/PATCH/DELETE /<product>/devices[/<id>] — self-service device management. */
export async function handleDevices(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  deviceId?: string,
): Promise<Response> {
  const token = bearer(req);
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid || !coreDeviceAllowed(product, valid, now))
    return errorResponse(401, ErrorCode.Unauthorized);

  // WHAT `/devices` LISTS, and why it is not always "the licence's seats".
  //
  // For an activated device it is the seat pool: the caller paid for those seats and managing
  // them is the point of the surface. For a REGISTERED device there is no pool — it is its own
  // principal — so the list is exactly itself. That distinction is load-bearing rather than
  // cosmetic: every unlicensed device of a product shares `NO_LICENSE_ID`, so grouping them by
  // licence id would hand each one the whole product's device list. Keying off `valid.license`
  // (null for a registered device) instead of off the id is what makes that impossible.
  const devices = valid.license
    ? await listDevicesByLicense(db, product.slug, valid.license.id)
    : [valid.device];
  if (req.method === "GET") {
    return json({
      currentDeviceId: valid.device.device_id,
      devices: devices.map((device) =>
        shapeDevice(device, valid.device.device_id),
      ),
    });
  }

  if (!deviceId)
    return errorResponse(400, ErrorCode.BadRequest, "missing device id");
  const target = devices.find((device) => device.device_id === deviceId);
  if (!target) return errorResponse(404, ErrorCode.NotFound);

  // R3-09: a device token authenticates ONE device, not the licence. Listing siblings is
  // legitimate self-service (the caller already paid for the seats), but MUTATING one is not:
  // any device could relabel or deauthorize every other install on the same licence — and the
  // DELETE arm purges the victim's fingerprint through `setDeviceStatus`, so the eviction is
  // not even recoverable by re-activating the same hardware. Cross-device management belongs
  // on the portal, which authenticates the licence OWNER and rate-limits the action.
  if (deviceId !== valid.device.device_id) {
    return errorResponse(
      403,
      ErrorCode.Forbidden,
      "a device token may only manage its own device",
    );
  }

  if (req.method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, ErrorCode.BadRequest, "invalid json");
    }
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 120)
        : null;
    await setDeviceLabel(db, product.slug, deviceId, label);
    return json({
      ok: true,
      device: { ...shapeDevice(target, valid.device.device_id), label },
    });
  }

  if (req.method === "DELETE") {
    await retireDeviceBinding(
      env,
      db,
      product.slug,
      deviceId,
      target.token_hash,
    );
    return json({ ok: true });
  }

  return methodNotAllowed();
}

// ── Device facts / telemetry ─────────────────────────────────────────────────

// The report allowlist. Anything not named here is DROPPED SILENTLY, so a new client field
// that isn't added here vanishes without an error anywhere — add the key here and a test in
// licensingEdge.test.ts together. The first six keys are the software-facts additions; the
// next nine are the original v1 set and must stay; `engine` and `outlet` (P1-05) carry a game
// engine's build facts and where the install came from (the stamped outlet refined by on-device
// detection, P3-11; an outlet id or kind only), each with its own bound below; `content` (P4-02,
// plans/P4-01.md §2.11) carries the active pack set's id; `updates` (P6-03) carries update
// outcome events, validated strictly and counted by `core/updateHealth.ts`.
export const REPORT_KEYS = [
  "os",
  "hardware",
  "runtime",
  "locale",
  "timezone",
  "probes",
  "sdk",
  "sdkVersion",
  "appVersion",
  "platform",
  "arch",
  "gate",
  "config",
  "entitlements",
  "timestamp",
  "engine",
  "outlet",
  "content",
  "updates",
] as const;

/** The fields `engine` may carry; anything else in it is dropped. All are strings except
 *  `debug`. Names are proposed by P1-05 (the Godot SDK); P1b-02 generates them later. */
const ENGINE_STRING_FIELDS = [
  "id",
  "version",
  "renderer",
  "videoAdapter",
  "videoVendor",
  "videoApi",
  "display",
] as const;

/** Bound `engine`: an object of known fields, strings truncated to 128 characters, `debug`
 *  kept only as a boolean, unknown fields and wrong-typed values dropped. Not an object:
 *  `undefined` (the key is dropped). */
function boundedEngine(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ENGINE_STRING_FIELDS) {
    const value = src[key];
    if (typeof value === "string") out[key] = value.slice(0, 128);
  }
  if (typeof src.debug === "boolean") out.debug = src.debug;
  return out;
}

/** Bound `outlet`: a string truncated to 64 characters. Outlet ids are not validated here,
 *  because later work adds outlets and this Worker must not drop a newer client's value. */
function boundedOutlet(input: unknown): string | undefined {
  return typeof input === "string" ? input.slice(0, 64) : undefined;
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Bound `content` (P4-02): keep only `packSetId` and `appRelease`, each kept only when it is 64
 *  lowercase hex (the active set's `packSetId`, the running app release's record hash). Not an
 *  object, or neither member well formed: `undefined` (the key is dropped). */
function boundedContent(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const src = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["packSetId", "appRelease"] as const) {
    const v = src[key];
    if (typeof v === "string" && HEX64_RE.test(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function boundedReport(input: unknown): Record<string, unknown> {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const key of REPORT_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  // `probes` is the one open-ended map a client controls, so it gets its own bound on top of
  // the body-size cap: a truncated inventory must not be able to ride in under 16 KiB.
  const probes = out.probes;
  if (probes !== undefined) {
    out.probes = boundedProbes(probes);
  }
  // `engine` and `outlet` are kept opaque like the v1 keys, but bounded: neither may carry an
  // unbounded string or an open-ended map.
  if (out.engine !== undefined) {
    const engine = boundedEngine(out.engine);
    if (engine === undefined) delete out.engine;
    else out.engine = engine;
  }
  if (out.outlet !== undefined) {
    const outlet = boundedOutlet(out.outlet);
    if (outlet === undefined) delete out.outlet;
    else out.outlet = outlet;
  }
  if (out.content !== undefined) {
    const content = boundedContent(out.content);
    if (content === undefined) delete out.content;
    else out.content = content;
  }
  // `updates` (P6-03): at most 16 strictly validated events; malformed entries and unknown
  // events are dropped, unknown fields stripped (`core/updateHealth.ts` `boundedUpdates`).
  if (out.updates !== undefined) {
    const updates = boundedUpdates(out.updates);
    if (updates === undefined) delete out.updates;
    else out.updates = updates;
  }
  return out;
}

function boundedProbes(input: unknown): Record<string, DeviceProbeResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, DeviceProbeResult> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DEVICE_PROBES) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.present !== "boolean") continue;
    out[id.slice(0, 64)] = {
      present: entry.present,
      ...(typeof entry.version === "string"
        ? { version: entry.version.slice(0, 64) }
        : {}),
    };
  }
  return out;
}

/** Project the allowlisted report into the flat `device_facts` row shape. */
function factsFromReport(
  product: string,
  deviceId: string,
  report: Record<string, unknown>,
  now: number,
): DeviceFactsRow {
  const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const str = (value: unknown): string | null =>
    typeof value === "string" ? value.slice(0, 128) : null;
  const int = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : null;

  const os = obj(report.os);
  const hardware = obj(report.hardware);
  const runtime = obj(report.runtime);
  return {
    product,
    device_id: deviceId,
    os_name: str(os.name),
    os_version: str(os.version),
    os_build: str(os.build),
    kernel: str(os.kernel),
    cpu_model: str(hardware.cpuModel),
    cpu_cores: int(hardware.cpuCores),
    ram_mb: int(hardware.ramMb),
    machine_model: str(hardware.machineModel),
    locale: str(report.locale),
    timezone: str(report.timezone),
    runtime_name: str(runtime.name),
    runtime_version: str(runtime.version),
    probes_json:
      report.probes === undefined ? null : JSON.stringify(report.probes),
    updated_at: now,
  };
}

/**
 * POST /<product>/devices/report — store the device's reported (non-secret) snapshot.
 *
 * Relocated from `/<product>/config/report` (R1): it was always licence anti-fraud telemetry
 * living under a config path, and wire v3 §6 makes it a Core surface. Same allowlist, same
 * caps, same 401 — with the licence requirement now scoped by `coreDeviceAllowed`, so a
 * registered device of a config-only product can report its facts and a licensed product's
 * device still cannot report without a usable licence.
 */
export async function handleReport(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  /** The product's hooks (dispatch builds them): the outlets and channels update events are
   *  checked against. Absent, every event counts as `unknown`. */
  hooks?: ServiceHooks,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const token = bearer(req);
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid || !coreDeviceAllowed(product, valid, now))
    return errorResponse(401, ErrorCode.Unauthorized);
  const len = req.headers.get("content-length");
  if (len && Number(len) > 16 * 1024)
    return errorResponse(413, "body_too_large", "report body too large");
  const rawText = await req.text();
  if (rawText.length > 16 * 1024)
    return errorResponse(413, "body_too_large", "report body too large");
  let snapshot: unknown;
  try {
    snapshot = rawText.trim() ? (JSON.parse(rawText) as unknown) : {};
  } catch {
    return errorResponse(400, ErrorCode.BadRequest, "invalid body");
  }
  const report = boundedReport(snapshot);
  await setDeviceReported(
    db,
    product.slug,
    valid.device.device_id,
    JSON.stringify(report),
    now,
  );
  await upsertDeviceFacts(
    db,
    factsFromReport(product.slug, valid.device.device_id, report, now),
  );
  // Count the update outcome events (P6-03) after the snapshot is stored, in the update-health
  // Durable Object — never D1. Deduplicated on (device, eventId), so a retried report counts
  // nothing twice; fails open, so telemetry can never cost a device its report.
  const updates = report.updates as
    | Parameters<typeof recordUpdateEvents>[3]
    | undefined;
  if (updates && updates.length > 0)
    await recordUpdateEvents(
      env,
      product.slug,
      valid.device.device_id,
      updates,
      now,
      hooks
        ? await updateScope(hooks)
        : staticScope({ outlets: [], channels: [], releases: [] }),
    );
  return json({ ok: true });
}
