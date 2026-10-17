// Device store (P0-18): `devices`, seats, device trust, fingerprints and device facts. Split out
// of `core/repo.ts`.

import type { Db, DbParam, DbStatement } from "../../db/types.js";
import type { DeviceRow, DeviceFactsRow, FingerprintRow } from "../repo.js";

// ── Devices ──────────────────────────────────────────────────────────────────
export async function getDevice(
  db: Db,
  product: string,
  deviceId: string,
): Promise<DeviceRow | null> {
  return db.first<DeviceRow>(
    "SELECT * FROM devices WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
}

export async function getDeviceByTokenHash(
  db: Db,
  product: string,
  tokenHash: string,
): Promise<DeviceRow | null> {
  return db.first<DeviceRow>(
    "SELECT * FROM devices WHERE product = ? AND token_hash = ?",
    product,
    tokenHash,
  );
}

export async function listDevicesByLicense(
  db: Db,
  product: string,
  licenseId: string,
): Promise<DeviceRow[]> {
  return db.all<DeviceRow>(
    "SELECT * FROM devices WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
}

/**
 * How long a device may go without checking in before its seat becomes reclaimable.
 *
 * R3 (business model): `countActiveDevices` had no recency predicate and neither did
 * `claimDeviceSeat`'s ordinal map, so a device that had not been seen for a year still held
 * its seat forever. On a 1- or 2-seat product, a decommissioned laptop permanently consumed
 * capacity the customer had paid for, and the only remedy was an operator.
 *
 * Reclamation is silent and safe in both directions: a dormant device that DOES come back
 * authenticates with a `token_hash` that is still valid, and simply re-claims a seat (or gets
 * a clean `device_limit` error if the licence has genuinely filled up since). Nothing is
 * deleted here — the row keeps its status and its data. Properly deauthorizing dormant rows,
 * so `releaseDeviceSeat`/`purgeDeviceData` run, needs the `scheduled()` handler that R11-09
 * reports as still missing.
 */
export const SEAT_DORMANCY_SECONDS = 90 * 86400;

/** The `last_seen` floor a device must be above to still be counted as holding a seat. */
export function seatActiveSince(now: number): number {
  return now - SEAT_DORMANCY_SECONDS;
}

export async function countActiveDevices(
  db: Db,
  product: string,
  licenseId: string,
  /** Omit to count every authorized device regardless of dormancy (admin/reporting views). */
  activeSince?: number,
): Promise<number> {
  const base =
    "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized'";
  const r =
    activeSince === undefined
      ? await db.first<{ n: number }>(base, product, licenseId)
      : await db.first<{ n: number }>(
          `${base} AND last_seen > ?`,
          product,
          licenseId,
          activeSince,
        );
  // R11-11: `COUNT(*)` ALWAYS returns exactly one row, so a missing row means the read did not
  // happen. The old `?? 0` turned that into "this license has no devices" — fail-OPEN in the
  // one query that decides whether a seat may be granted. Refuse instead.
  if (!r || typeof r.n !== "number") {
    throw new Error("countActiveDevices: seat-count read returned no row");
  }
  return r.n;
}

/**
 * Atomically reserve a device seat, or refuse because the license is full.
 *
 * R11-02 / R3-02 — this replaces the check-then-act pair in `licenseCore.authorizeDevice`
 * (`countActiveDevices()` … `await` … `upsertDevice()`), where N concurrent activations all
 * read `count = limit - 1`, all passed, and all committed: final seat count `limit - 1 + N`.
 * The `activate` rate limit bounds the burst but does not serialise it, and it is per-IP.
 *
 * The arbiter is `idx_devices_seat` (0015): `UNIQUE (product, license_id, seat_no) WHERE
 * status = 'authorized' AND seat_no IS NOT NULL`. Two isolates that compute the same free
 * ordinal cannot both commit — the loser takes a UNIQUE violation, retries against the ordinal
 * set as it now stands, and eventually either finds a genuinely free ordinal or runs out. This
 * is the same pattern `idx_licenses_enroll_hwid` already uses for enrolment, where the
 * migration comment celebrates that "a race between two concurrent enrolments therefore cannot
 * mint two licenses".
 *
 * A device that ALREADY holds an authorized seat on this license re-activates for free — that
 * is a refresh, not a new install. `limit <= 0` denies rather than meaning "unlimited"; callers
 * must express "unlimited" by not calling this at all.
 *
 * Seats held by DORMANT devices are reclaimed first (see `SEAT_DORMANCY_SECONDS`). Excluding
 * them from the free-ordinal search alone would not work: the unique index still holds their
 * ordinal, so the INSERT would collide and retry forever. The ordinal has to actually be
 * released, which is what `releaseDormantSeats` does.
 */
/**
 * Free the seat ordinals of devices that have stopped checking in. Returns how many were freed.
 *
 * The row itself is left alone — same `status`, same `token_hash`, same data — so a device
 * that comes back simply re-claims a seat on its next activation. Only the *capacity* is
 * returned to the customer.
 *
 * Two callers, one statement. `claimDeviceSeat` passes `licenseId` and reclaims just in time,
 * for the one licence about to be counted. The `scheduled()` sweep omits it and reclaims a whole
 * product at once, which is what makes the capacity come back for customers who are NOT
 * currently activating — under the just-in-time path alone, a 2-seat licence whose only two
 * devices went dark stays visibly "full" in the portal and the admin console until someone tries
 * to activate a third. Both are `UPDATE ... WHERE seat_no IS NOT NULL`, so both are idempotent
 * and a second run frees nothing.
 */
export async function releaseDormantSeats(
  db: Db,
  product: string,
  now: number,
  licenseId?: string,
): Promise<number> {
  // The credential goes with the seat. A released row keeps `status = 'authorized'`,
  // so its old token would otherwise keep validating with no seat while another device holds it.
  const base = `UPDATE devices SET seat_no = NULL, token_hash = NULL
      WHERE product = ? AND status = 'authorized'
        AND seat_no IS NOT NULL AND last_seen <= ?`;
  return licenseId === undefined
    ? db.runChanges(base, product, seatActiveSince(now))
    : db.runChanges(
        `${base} AND license_id = ?`,
        product,
        seatActiveSince(now),
        licenseId,
      );
}

export async function claimDeviceSeat(
  db: Db,
  product: string,
  licenseId: string,
  deviceId: string,
  limit: number,
  now: number,
  opts: {
    /**
     * The licence id AND status the caller OBSERVED on the row it was authorised to
     * take over (ownership proven, or a dead row). A compare-and-set: the upsert below moves a
     * row off another licence only while it still shows exactly this pair, so a row that changed
     * hands, or that its owner re-activated after the check, is left alone rather than stolen.
     * The same batch clears what the row carried for that licence, so a bind that
     * fails after the claim cannot leave the old overrides or label on the new licence.
     */
    adoptFrom?: { licenseId: string; status: string };
    /**
     * PX-W9 (WIRE-CONTRACT-V4 §12.2 step 5): a statement written in the SAME batch as the seat
     * INSERT, and before it, so it commits exactly when the claim does: a lost ordinal race rolls
     * both back. Built afresh for each attempt. The key-entry counter passes
     * `core/licensing/keyEntries.ts` `stmtRecordDeviceKeyEntry`, whose guard reads the row as it was before
     * the claim. Never run for a device that already holds a seat on this licence.
     */
    withClaim?: () => DbStatement;
  } = {},
): Promise<boolean> {
  await releaseDormantSeats(db, product, now, licenseId);
  const held = await db.first<{ seat_no: number | null }>(
    `SELECT seat_no FROM devices
      WHERE product = ? AND device_id = ? AND license_id = ? AND status = 'authorized'`,
    product,
    deviceId,
    licenseId,
  );
  if (held) {
    if (held.seat_no != null) return true;
    // An authorized device from before this column existed: adopt it into the seat map below.
  }
  if (!Number.isFinite(limit) || limit <= 0) return false;

  // One attempt per seat: each failure removes at least one ordinal from contention.
  for (let attempt = 0; attempt <= limit; attempt++) {
    const free = await db.first<{ n: number | null }>(
      `WITH RECURSIVE seats(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM seats WHERE n < ?
       )
       SELECT MIN(n) AS n FROM seats
        WHERE n NOT IN (
          SELECT seat_no FROM devices
           WHERE product = ? AND license_id = ?
             AND status = 'authorized' AND seat_no IS NOT NULL
             AND last_seen > ?
        )`,
      limit,
      product,
      licenseId,
      seatActiveSince(now),
    );
    if (!free || free.n == null) return false; // every seat is taken
    const seat: DbStatement = {
      sql: `INSERT INTO devices
           (product, device_id, license_id, status, seat_no, first_seen, last_seen)
         VALUES (?, ?, ?, 'authorized', ?, ?, ?)
         ON CONFLICT(product, device_id) DO UPDATE SET
           license_id = excluded.license_id,
           status = 'authorized',
           seat_no = excluded.seat_no,
           last_seen = excluded.last_seen
         WHERE (devices.license_id = excluded.license_id
                AND (devices.seat_no IS NULL OR devices.status <> 'authorized'))
            OR (devices.license_id = ? AND devices.status = ?)`,
      params: [
        product,
        deviceId,
        licenseId,
        free.n,
        now,
        now,
        opts.adoptFrom?.licenseId ?? null,
        opts.adoptFrom?.status ?? null,
      ],
    };
    const adopt = opts.adoptFrom;
    const clear: DbStatement[] = adopt
      ? [
          {
            sql: `UPDATE devices SET label = NULL, overrides_json = NULL, reported_json = NULL,
                    customer_id = NULL
                  WHERE product = ? AND device_id = ? AND license_id = ? AND status = ?`,
            params: [product, deviceId, adopt.licenseId, adopt.status],
          },
          {
            sql: `DELETE FROM device_facts WHERE product = ? AND device_id = ?
                    AND EXISTS (SELECT 1 FROM devices WHERE product = ? AND device_id = ?
                                  AND license_id = ? AND status = ?)`,
            params: [
              product,
              deviceId,
              product,
              deviceId,
              adopt.licenseId,
              adopt.status,
            ],
          },
        ]
      : [];
    try {
      // Applied, or a no-op because the row already holds a seat: either way nothing is left to
      // claim. Only a UNIQUE loss on `idx_devices_seat` (below) tries again.
      if (opts.withClaim) await db.batch([opts.withClaim(), ...clear, seat]);
      else if (clear.length > 0) await db.batch([...clear, seat]);
      else await db.runChanges(seat.sql, ...seat.params);
      // A no-op upsert is success only when the row is ours: a row held by another licence is
      // never reported as claimed (the caller turns this into a refusal, not a seat).
      const mine = await db.first<{ one: number }>(
        `SELECT 1 AS one FROM devices
          WHERE product = ? AND device_id = ? AND license_id = ?
            AND status = 'authorized' AND seat_no IS NOT NULL`,
        product,
        deviceId,
        licenseId,
      );
      return mine !== null;
    } catch (e) {
      // UNIQUE constraint on idx_devices_seat: another isolate took this ordinal first, so try
      // again. Anything else (a failed `withClaim` write, a database error) is not a full licence
      // and surfaces as an error rather than as `device_limit`.
      if (!isUniqueViolation(e)) throw e;
      continue;
    }
  }
  return false;
}

/** A UNIQUE-constraint failure, as better-sqlite3 and D1 both word it. */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/** Free the seat a device was holding, so a deauthorized install stops occupying capacity. */
export async function releaseDeviceSeat(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  await db.run(
    "UPDATE devices SET seat_no = NULL WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
}

/**
 * Drop what a device row carried for its previous licence — the operator overrides, the
 * label, the reported data, the commerce customer and the software snapshot. `upsertDevice` never
 * rewrites `overrides_json` / `reported_json` and keeps an existing label, so a row changing
 * licence must be cleared explicitly or the new licence's document inherits them.
 */
export async function clearDeviceInheritance(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  await db.batch([
    {
      sql: `UPDATE devices SET label = NULL, overrides_json = NULL, reported_json = NULL,
              customer_id = NULL WHERE product = ? AND device_id = ?`,
      params: [product, deviceId],
    },
    {
      sql: "DELETE FROM device_facts WHERE product = ? AND device_id = ?",
      params: [product, deviceId],
    },
  ]);
}

export async function upsertDevice(db: Db, row: DeviceRow): Promise<void> {
  // I-05: `subject` is written on INSERT only (a first-ever bind through a sign-in) and otherwise
  // preserved, like `seat_no`: the binding changes only through `core/accounts/accountSubjects.ts`, so a
  // metadata touch or a token rotation can never set or drop it. `bound_by` keeps the stored
  // value unless the caller names one (a fresh bind does; a touch does not). PX-W13 §8 Q2:
  // `label` is seeded from the device's reported label only while the row has none, so a
  // console or portal rename always wins over what the device reports.
  await db.run(
    `INSERT INTO devices (product, device_id, customer_id, license_id, status, first_seen, last_seen, ua, label,
       overrides_json, reported_json, token_hash, platform, arch, app_version, sdk_name, sdk_version,
       subject, bound_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, device_id) DO UPDATE SET
       customer_id = excluded.customer_id, license_id = excluded.license_id,
       status = excluded.status, last_seen = excluded.last_seen,
       ua = excluded.ua, token_hash = excluded.token_hash, platform = excluded.platform,
       arch = excluded.arch, app_version = excluded.app_version, sdk_name = excluded.sdk_name,
       sdk_version = excluded.sdk_version,
       bound_by = COALESCE(excluded.bound_by, devices.bound_by),
       label = COALESCE(devices.label, excluded.label)`,
    row.product,
    row.device_id,
    row.customer_id,
    row.license_id,
    row.status,
    row.first_seen,
    row.last_seen,
    row.ua,
    row.label,
    row.overrides_json,
    row.reported_json,
    row.token_hash,
    row.platform ?? null,
    row.arch ?? null,
    row.app_version ?? null,
    row.sdk_name ?? null,
    row.sdk_version ?? null,
    row.subject ?? null,
    row.bound_by ?? null,
  );
}

/**
 * P6-02 — record an attestation outcome on a device row. `level` is written only when the
 * verdict raised the device (`attested`); a refused attempt records its verdict and leaves the
 * level alone, so a bad attestation can never lower or raise anything.
 */
export async function setDeviceTrust(
  db: Db,
  product: string,
  deviceId: string,
  t: { attested: boolean; at: number; json: string },
): Promise<void> {
  if (t.attested) {
    await db.run(
      "UPDATE devices SET trust_level = 'attested', attested_at = ?, attestation_json = ? WHERE product = ? AND device_id = ?",
      t.at,
      t.json,
      product,
      deviceId,
    );
    return;
  }
  await db.run(
    "UPDATE devices SET attestation_json = ? WHERE product = ? AND device_id = ?",
    t.json,
    product,
    deviceId,
  );
}

/**
 * P6-02 — drop a device back to `basic`. Called whenever a NEW credential is minted for a device
 * id without proof of the old one (keyless re-registration, a licence bind or rebind): the device
 * id is client-chosen, so whoever holds the new token has not shown they are the attested
 * install. A token rotation, which presents the old token, keeps the level.
 */
export async function resetDeviceTrust(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  await db.run(
    "UPDATE devices SET trust_level = 'basic', attested_at = NULL WHERE product = ? AND device_id = ? AND trust_level != 'basic'",
    product,
    deviceId,
  );
}

export async function setDeviceStatus(
  db: Db,
  product: string,
  deviceId: string,
  status: string,
): Promise<void> {
  await db.run(
    "UPDATE devices SET status = ? WHERE product = ? AND device_id = ?",
    status,
    product,
    deviceId,
  );
  // Retention is device lifetime. A deauthorized device keeps its `devices` row (so seat
  // history and labels survive) but loses its fingerprint and software snapshot. Every
  // deauthorize path — self-service, /deauthorize, admin, portal — routes through here, so
  // none of them can forget to purge, and no scheduled job is needed.
  //
  // R11-02: the seat ordinal is released on the same path, for the same reason — every
  // deauthorize goes through here, so a freed seat can never be left occupied by a device that
  // is no longer authorized.
  if (status === "deauthorized") {
    await releaseDeviceSeat(db, product, deviceId);
    await purgeDeviceData(db, product, deviceId);
  }
}

/** Drop a device's fingerprint and software snapshot. Safe to call when neither exists. */
export async function purgeDeviceData(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  await db.batch([
    {
      sql: "DELETE FROM device_fingerprints WHERE product = ? AND device_id = ?",
      params: [product, deviceId],
    },
    {
      sql: "DELETE FROM device_facts WHERE product = ? AND device_id = ?",
      params: [product, deviceId],
    },
  ]);
}

// ── Fingerprints / device facts ──────────────────────────────────────────────
export async function getFingerprint(
  db: Db,
  product: string,
  deviceId: string,
): Promise<FingerprintRow | null> {
  return db.first<FingerprintRow>(
    "SELECT * FROM device_fingerprints WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
}

/** Resolve a device from its composite hwid. Unverified devices are stored with an empty
 *  hwid, so an empty query must never match them all — it resolves to nothing. */
export async function findFingerprintByHwid(
  db: Db,
  product: string,
  hwid: string,
): Promise<FingerprintRow | null> {
  if (!hwid) return null;
  return db.first<FingerprintRow>(
    "SELECT * FROM device_fingerprints WHERE product = ? AND hwid = ?",
    product,
    hwid,
  );
}

export async function upsertFingerprint(
  db: Db,
  row: FingerprintRow,
): Promise<void> {
  await db.run(
    `INSERT INTO device_fingerprints (product, device_id, hwid, components_json, anchor_hash,
       status, first_seen, last_seen, last_drift_at, last_drift_count,
       baseline_components_json, baseline_anchor_hash, baseline_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, device_id) DO UPDATE SET
       hwid = excluded.hwid, components_json = excluded.components_json,
       anchor_hash = excluded.anchor_hash, status = excluded.status,
       last_seen = excluded.last_seen, last_drift_at = excluded.last_drift_at,
       last_drift_count = excluded.last_drift_count,
       baseline_components_json = COALESCE(device_fingerprints.baseline_components_json,
         excluded.baseline_components_json),
       baseline_anchor_hash = COALESCE(device_fingerprints.baseline_anchor_hash,
         excluded.baseline_anchor_hash),
       baseline_at = COALESCE(device_fingerprints.baseline_at, excluded.baseline_at)`,
    row.product,
    row.device_id,
    row.hwid,
    row.components_json,
    row.anchor_hash,
    row.status,
    row.first_seen,
    row.last_seen,
    row.last_drift_at,
    row.last_drift_count,
    // A verified row seeds its baseline from what it stores; the COALESCE above keeps any
    // existing one, so drift can never move it.
    row.baseline_components_json ??
      (row.status === "verified" ? row.components_json : null),
    row.baseline_anchor_hash ??
      (row.status === "verified" ? row.anchor_hash : null),
    row.baseline_at ?? (row.status === "verified" ? row.last_seen : null),
  );
}

/** Clear a device's binding so its next check-in re-binds cleanly (the admin escape hatch). */
export async function clearFingerprint(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  await db.run(
    "DELETE FROM device_fingerprints WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
}

export async function getDeviceFacts(
  db: Db,
  product: string,
  deviceId: string,
): Promise<DeviceFactsRow | null> {
  return db.first<DeviceFactsRow>(
    "SELECT * FROM device_facts WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
}

export async function upsertDeviceFacts(
  db: Db,
  row: DeviceFactsRow,
): Promise<void> {
  await db.run(
    `INSERT INTO device_facts (product, device_id, os_name, os_version, os_build, kernel,
       cpu_model, cpu_cores, ram_mb, machine_model, locale, timezone, runtime_name,
       runtime_version, probes_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, device_id) DO UPDATE SET
       os_name = excluded.os_name, os_version = excluded.os_version,
       os_build = excluded.os_build, kernel = excluded.kernel,
       cpu_model = excluded.cpu_model, cpu_cores = excluded.cpu_cores,
       ram_mb = excluded.ram_mb, machine_model = excluded.machine_model,
       locale = excluded.locale, timezone = excluded.timezone,
       runtime_name = excluded.runtime_name, runtime_version = excluded.runtime_version,
       probes_json = excluded.probes_json, updated_at = excluded.updated_at`,
    row.product,
    row.device_id,
    row.os_name,
    row.os_version,
    row.os_build,
    row.kernel,
    row.cpu_model,
    row.cpu_cores,
    row.ram_mb,
    row.machine_model,
    row.locale,
    row.timezone,
    row.runtime_name,
    row.runtime_version,
    row.probes_json,
    row.updated_at,
  );
}

export async function setDeviceLabel(
  db: Db,
  product: string,
  deviceId: string,
  label: string | null,
): Promise<void> {
  await db.run(
    "UPDATE devices SET label = ? WHERE product = ? AND device_id = ?",
    label,
    product,
    deviceId,
  );
}

export async function setDeviceReported(
  db: Db,
  product: string,
  deviceId: string,
  reportedJson: string,
  at: number,
): Promise<void> {
  await db.run(
    "UPDATE devices SET reported_json = ?, last_seen = ? WHERE product = ? AND device_id = ?",
    reportedJson,
    at,
    product,
    deviceId,
  );
}

// ── Devices ──────────────────────────────────────────────────────────────────
export async function listDevicesByProduct(
  db: Db,
  product: string,
): Promise<DeviceRow[]> {
  return db.all<DeviceRow>("SELECT * FROM devices WHERE product = ?", product);
}

// ── Devices, product-wide (Platform → Devices) ───────────────────────────────

/** `devices.license_id` for a device that holds no license (open / requires-identity
 *  registration). Mirrors `NO_LICENSE_ID` in core/devices.ts; repeated here as a literal because
 *  this module only ever depends on `repo.ts` types. */
const LICENSE_FREE = "";

export interface DeviceListFilter {
  /** `all` drops the status predicate. */
  status: "authorized" | "deauthorized" | "all";
  platform?: string;
  /** true = holds a license, false = license-free, undefined = both. */
  licensed?: boolean;
  /** Case-insensitive prefix of the device id or the label. */
  q?: string;
  limit: number;
  /** Keyset position: the last row of the previous page. */
  after?: { lastSeen: number; deviceId: string };
}

/** Escape `%`, `_` and the escape character itself so `q` is matched literally. */
function likePrefix(q: string): string {
  return `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * One page of a product's devices, newest `last_seen` first, `device_id` ascending as the
 * tie-break so the keyset is total. Summaries only: no fingerprint or facts join (the license
 * view's N+1 is deliberately not repeated; detail is fetched on demand).
 *
 * Cost: `status = ?` walks `idx_devices_status (product, status, last_seen DESC)` in order.
 * `status = 'all'` has no equality prefix on that index, so SQLite scans the product's rows and
 * sorts; fine at today's sizes, and the reason the console defaults to `authorized`.
 *
 * Returns `limit + 1` rows at most; the caller trims the extra one to learn whether a next page
 * exists.
 */
export async function listDevicesPage(
  db: Db,
  product: string,
  f: DeviceListFilter,
): Promise<DeviceRow[]> {
  const where = ["product = ?"];
  const params: (string | number)[] = [product];
  if (f.status !== "all") {
    where.push("status = ?");
    params.push(f.status);
  }
  if (f.platform !== undefined) {
    where.push("platform = ?");
    params.push(f.platform);
  }
  if (f.licensed === true) where.push(`license_id <> '${LICENSE_FREE}'`);
  if (f.licensed === false) where.push(`license_id = '${LICENSE_FREE}'`);
  if (f.q) {
    where.push(
      "(device_id LIKE ? ESCAPE '\\' OR (label IS NOT NULL AND label LIKE ? ESCAPE '\\'))",
    );
    const like = likePrefix(f.q);
    params.push(like, like);
  }
  if (f.after) {
    where.push("(last_seen < ? OR (last_seen = ? AND device_id > ?))");
    params.push(f.after.lastSeen, f.after.lastSeen, f.after.deviceId);
  }
  params.push(f.limit + 1);
  return db.all<DeviceRow>(
    `SELECT * FROM devices WHERE ${where.join(" AND ")}
     ORDER BY last_seen DESC, device_id ASC LIMIT ?`,
    ...params,
  );
}

export interface DeviceCount {
  value: string | null;
  count: number;
}

export interface DeviceSummaryCounts {
  total: number;
  byStatus: DeviceCount[];
  licensed: { licensed: number; licenseFree: number };
  byPlatform: DeviceCount[];
  byArch: DeviceCount[];
  bySdkName: DeviceCount[];
  byAppVersion: DeviceCount[];
}

/** How many `app_version` groups the summary returns. */
export const APP_VERSION_TOP_N = 20;

/**
 * Counts for the Devices tab. `byStatus` covers every device of the product; every other
 * breakdown counts AUTHORIZED devices only (a deauthorized device has had its facts purged and is
 * no longer part of the installed base). One GROUP BY per dimension, each over a single product;
 * fine today, and the first thing to revisit for a very large free game.
 */
export async function deviceSummary(
  db: Db,
  product: string,
): Promise<DeviceSummaryCounts> {
  const by = (col: string, limit?: number): Promise<DeviceCount[]> =>
    db.all<DeviceCount>(
      `SELECT ${col} AS value, COUNT(*) AS count FROM devices
       WHERE product = ? AND status = 'authorized'
       GROUP BY ${col} ORDER BY count DESC, value IS NULL, value ASC${limit ? ` LIMIT ${limit}` : ""}`,
      product,
    );
  const [byStatus, split, byPlatform, byArch, bySdkName, byAppVersion] =
    await Promise.all([
      db.all<DeviceCount>(
        `SELECT status AS value, COUNT(*) AS count FROM devices
         WHERE product = ? GROUP BY status ORDER BY count DESC, value ASC`,
        product,
      ),
      db.first<{ licensed: number | null; free: number | null }>(
        `SELECT SUM(license_id <> '${LICENSE_FREE}') AS licensed,
                SUM(license_id = '${LICENSE_FREE}') AS free
         FROM devices WHERE product = ? AND status = 'authorized'`,
        product,
      ),
      by("platform"),
      by("arch"),
      by("sdk_name"),
      by("app_version", APP_VERSION_TOP_N),
    ]);
  return {
    total: byStatus.reduce((n, r) => n + r.count, 0),
    byStatus,
    licensed: {
      licensed: split?.licensed ?? 0,
      licenseFree: split?.free ?? 0,
    },
    byPlatform,
    byArch,
    bySdkName,
    byAppVersion,
  };
}
