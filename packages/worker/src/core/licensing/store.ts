// Licensing store (P0-18): the `licenses`, `keys_index`, `tiers` and `license_profiles` queries.
// Split out of `core/repo.ts`; the seats, grants and lifecycle live beside it in `core/licensing/`.

import type { Db, DbParam, DbStatement } from "../../db/types.js";
import type {
  KeyRow,
  LicenseProfileRow,
  LicenseRow,
  ProfileRow,
  TierRow,
} from "../repo.js";
import {
  claimDeviceSeat,
  countActiveDevices,
  releaseDormantSeats,
  seatActiveSince,
} from "../devices/store.js";

// ── Licenses ─────────────────────────────────────────────────────────────────
export async function getLicense(
  db: Db,
  product: string,
  id: string,
): Promise<LicenseRow | null> {
  return db.first<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? AND id = ?",
    product,
    id,
  );
}

export async function getLicenseBySub(
  db: Db,
  product: string,
  sub: string,
): Promise<LicenseRow | null> {
  return db.first<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? AND sub = ?",
    product,
    sub,
  );
}

export async function insertLicense(db: Db, row: LicenseRow): Promise<void> {
  const stmt = stmtInsertLicense(row);
  await db.run(stmt.sql, ...stmt.params);
}

/** `insertLicense` as a statement, so a new licence and what it carries from birth (LX-08: its
 *  `oidc` grant) land in one batch. */
export function stmtInsertLicense(row: LicenseRow): DbStatement {
  return {
    sql: `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id,
       activated_at, expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
       origin, enroll_hwid, email_issuer_class, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.product,
      row.id,
      row.status,
      row.sub,
      row.name,
      row.email,
      row.groups_json,
      row.tier_id,
      row.activated_at,
      row.expires_at,
      row.max_offline_days,
      row.overrides_json,
      row.channels_json,
      row.min_version,
      row.max_version,
      row.origin ?? "admin",
      row.enroll_hwid ?? null,
      // Only a writer that knows which issuer produced `email` sets this: today the OIDC lane
      // alone (`activateFromIdentity`). NULL = nobody recorded one, so an operator-entered address
      // on an admin-minted licence keeps resolving through the product's live provider.
      row.email_issuer_class ?? null,
      row.modified_by,
      row.modified_at,
    ],
  };
}

/** Resolve the auto-issued license bound to a machine. Backed by the partial unique index
 *  `idx_licenses_enroll_hwid`, which is what actually guarantees one per machine. */
export async function getLicenseByEnrollHwid(
  db: Db,
  product: string,
  hwid: string,
): Promise<LicenseRow | null> {
  if (!hwid) return null;
  return db.first<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? AND enroll_hwid = ?",
    product,
    hwid,
  );
}

/**
 * Attach an identity to an enrolled license, converting it in place to an OIDC license.
 *
 * R3-05: this used to `SET enroll_hwid = NULL`. `idx_licenses_enroll_hwid` is the ONLY thing
 * enforcing one free license per machine, so releasing the column released the guard: sign in,
 * claim, enrol again, sign in with a second identity, claim again — unbounded free licenses
 * from one machine. The binding is now permanent. `enroll.ts` refuses to hand a claimed row to
 * a later anonymous enrolment, so keeping the value costs the machine nothing it should have.
 */
export async function claimEnrolledLicense(
  db: Db,
  product: string,
  licenseId: string,
  identity: {
    sub: string;
    name: string | null;
    email: string | null;
    groupsJson: string | null;
    tierId: string | null;
    expiresAt: number | null;
    /** The issuer class that produced `email`, written in the same statement. */
    emailIssuerClass: string;
  },
  at: number,
): Promise<void> {
  await db.run(
    `UPDATE licenses SET sub = ?, name = ?, email = ?, groups_json = ?, tier_id = ?,
       expires_at = ?, origin = 'oidc', email_issuer_class = ?, modified_by = 'oidc',
       modified_at = ? WHERE product = ? AND id = ?`,
    identity.sub,
    identity.name,
    identity.email,
    identity.groupsJson,
    identity.tierId,
    identity.expiresAt,
    identity.emailIssuerClass,
    at,
    product,
    licenseId,
  );
}

/**
 * Plan re-pointing every device of one license at another — the migrate arm of the merge table
 * (LX-03, notes/S-19 §4.3 G6). Answers the statements, or `null` when the move would take the
 * destination past `limit` (nothing is written but the dormant-seat release below).
 *
 * The move is SEAT-CHECKED, the way `claimDeviceSeat` is, instead of dropping the ordinal:
 *
 *   - The destination's dormant seats are released first (`releaseDormantSeats`, as
 *     `claimDeviceSeat` does), so what is left holding an ordinal there is occupying capacity.
 *   - Every AUTHORIZED device on the source moves, dormant ones included, and each one counts:
 *     a dormant device given no ordinal would come back through `validateDeviceToken` without
 *     ever claiming a seat (THREAT-MODEL, R1-07). Moving `m` of them onto a destination with
 *     `held` seat-holding devices (the same dormancy floor `authorizeDevice` counts with) is
 *     refused when `limit <= 0` or `m + held > limit`.
 *   - Each moved authorized device takes the lowest free ordinal of the destination, in the order
 *     the devices first appeared. The ordinals are planned here and written by the caller's
 *     batch, so `idx_devices_seat` is still the arbiter: a concurrent `claimDeviceSeat` that takes
 *     a planned ordinal first makes the whole batch throw (and roll back), and the caller plans
 *     again.
 *   - A device that is not authorized moves without an ordinal (it holds no seat anywhere). An
 *     authorized device that reaches the source after this read is left on it: it was never
 *     seat-checked against the destination.
 */
export async function planDeviceMove(
  db: Db,
  product: string,
  fromLicenseId: string,
  toLicenseId: string,
  limit: number,
  now: number,
): Promise<DbStatement[] | null> {
  if (fromLicenseId === toLicenseId) return [];
  await releaseDormantSeats(db, product, now, toLicenseId);
  const moving = await db.all<{ device_id: string }>(
    `SELECT device_id FROM devices
      WHERE product = ? AND license_id = ? AND status = 'authorized'
      ORDER BY first_seen ASC, device_id ASC`,
    product,
    fromLicenseId,
  );
  const held = await countActiveDevices(
    db,
    product,
    toLicenseId,
    seatActiveSince(now),
  );
  if (!Number.isFinite(limit) || limit <= 0 || moving.length + held > limit)
    return null;
  const taken = new Set(
    (
      await db.all<{ seat_no: number }>(
        `SELECT seat_no FROM devices
          WHERE product = ? AND license_id = ? AND status = 'authorized'
            AND seat_no IS NOT NULL`,
        product,
        toLicenseId,
      )
    ).map((r) => r.seat_no),
  );
  const free: number[] = [];
  for (let n = 1; n <= limit && free.length < moving.length; n++)
    if (!taken.has(n)) free.push(n);
  // `held` counts every seat-holder (the release above left none dormant), so `limit - held`
  // ordinals are free and the check above makes that at least `moving.length`.
  if (free.length < moving.length) return null;
  return [
    ...moving.map((d, i) => ({
      sql: `UPDATE devices SET license_id = ?, seat_no = ?
             WHERE product = ? AND device_id = ? AND license_id = ? AND status = 'authorized'`,
      params: [toLicenseId, free[i]!, product, d.device_id, fromLicenseId],
    })),
    {
      sql: `UPDATE devices SET license_id = ?, seat_no = NULL
             WHERE product = ? AND license_id = ? AND status <> 'authorized'`,
      params: [toLicenseId, product, fromLicenseId],
    },
  ];
}

/**
 * {@link planDeviceMove}, applied in one batch. `false` (nothing moved) when the destination's
 * seats would be exceeded. A batch that loses an ordinal to a concurrent activation throws.
 */
export async function moveDevices(
  db: Db,
  product: string,
  fromLicenseId: string,
  toLicenseId: string,
  limit: number,
  now: number,
): Promise<boolean> {
  const plan = await planDeviceMove(
    db,
    product,
    fromLicenseId,
    toLicenseId,
    limit,
    now,
  );
  if (plan === null) return false;
  if (plan.length > 0) await db.batch(plan);
  return true;
}

export async function listLicenseProfiles(
  db: Db,
  product: string,
  licenseId: string,
): Promise<LicenseProfileRow[]> {
  return db.all<LicenseProfileRow>(
    "SELECT * FROM license_profiles WHERE product = ? AND license_id = ? ORDER BY sort_order ASC, profile_id ASC",
    product,
    licenseId,
  );
}

export async function setLicenseProfiles(
  db: Db,
  product: string,
  licenseId: string,
  profileIds: string[],
): Promise<void> {
  const unique = [...new Set(profileIds.filter((id) => id.trim()))];
  await db.batch([
    {
      sql: "DELETE FROM license_profiles WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
    ...unique.map((profileId, sortOrder) => ({
      sql: "INSERT INTO license_profiles (product, license_id, profile_id, sort_order) VALUES (?, ?, ?, ?)",
      params: [product, licenseId, profileId, sortOrder],
    })),
  ]);
}

// ── Keys (list source-of-truth; KV is the hot read) ──────────────────────────
export async function insertKey(db: Db, row: KeyRow): Promise<void> {
  await db.run(
    `INSERT INTO keys_index (product, key_hash, license_id, status, label, created_at, created_by, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product,
    row.key_hash,
    row.license_id,
    row.status,
    row.label,
    row.created_at,
    row.created_by,
    row.last_used_at,
  );
}

export async function getKey(
  db: Db,
  product: string,
  keyHash: string,
): Promise<KeyRow | null> {
  return db.first<KeyRow>(
    "SELECT * FROM keys_index WHERE product = ? AND key_hash = ?",
    product,
    keyHash,
  );
}

export async function listKeysByLicense(
  db: Db,
  product: string,
  licenseId: string,
): Promise<KeyRow[]> {
  return db.all<KeyRow>(
    "SELECT * FROM keys_index WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
}

export async function touchKey(
  db: Db,
  product: string,
  keyHash: string,
  at: number,
): Promise<void> {
  await db.run(
    "UPDATE keys_index SET last_used_at = ? WHERE product = ? AND key_hash = ?",
    at,
    product,
    keyHash,
  );
}

export async function setKeyStatus(
  db: Db,
  product: string,
  keyHash: string,
  status: string,
): Promise<void> {
  await db.run(
    "UPDATE keys_index SET status = ? WHERE product = ? AND key_hash = ?",
    status,
    product,
    keyHash,
  );
}

/**
 * Replace every active key of a licence with `row`, atomically (PX-W5, the portal's "Get a new
 * key", docs/design/PORTAL.md G7): the old keys are revoked and the new one inserted in ONE batch,
 * so there is no moment at which the licence has two working keys, and no failure that leaves it
 * with none. Answers how many keys were revoked. Devices are untouched: a key only activates new
 * devices, and every device already activated keeps its own token.
 */
export async function replaceLicenseKeys(db: Db, row: KeyRow): Promise<number> {
  const statements: DbStatement[] = [
    {
      sql: "UPDATE keys_index SET status = 'revoked' WHERE product = ? AND license_id = ? AND status = 'active'",
      params: [row.product, row.license_id],
    },
    {
      sql: `INSERT INTO keys_index (product, key_hash, license_id, status, label, created_at, created_by, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        row.product,
        row.key_hash,
        row.license_id,
        row.status,
        row.label,
        row.created_at,
        row.created_by,
        row.last_used_at,
      ],
    },
  ];
  if (db.batchChanges) {
    const [revoked] = await db.batchChanges(statements);
    return revoked ?? 0;
  }
  const before = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM keys_index WHERE product = ? AND license_id = ? AND status = 'active'",
    row.product,
    row.license_id,
  );
  await db.batch(statements);
  return before?.n ?? 0;
}

// ── Profiles / tiers (for the effective-config merge) ────────────────────────
export async function getProfile(
  db: Db,
  product: string,
  id: string,
): Promise<ProfileRow | null> {
  return db.first<ProfileRow>(
    "SELECT * FROM profiles WHERE product = ? AND id = ?",
    product,
    id,
  );
}

export async function getTier(
  db: Db,
  product: string,
  id: string,
): Promise<TierRow | null> {
  return db.first<TierRow>(
    "SELECT * FROM tiers WHERE product = ? AND id = ?",
    product,
    id,
  );
}

/**
 * Compare-and-set a licence's holder (name and email), for the admin's holder moves and their
 * undo: it applies only while the licence is still in `expectedAccountId` (`null`: in no account)
 * and still carries `expectedEmail` (`""` for none). Returns the rows changed: 1 when it applied,
 * 0 when the licence moved on.
 */
export async function setLicenseHolder(
  db: Db,
  args: {
    product: string;
    licenseId: string;
    name: string | null;
    email: string | null;
    expectedAccountId: string | null;
    expectedEmail: string;
    by: string;
    now: number;
  },
): Promise<number> {
  return db.runChanges(
    `UPDATE licenses SET name = ?, email = ?, modified_by = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS ? AND COALESCE(email, '') = ?`,
    args.name,
    args.email,
    args.by,
    args.now,
    args.product,
    args.licenseId,
    args.expectedAccountId,
    args.expectedEmail,
  );
}

/** Put a licence back in `accountId` when an account merge is undone: only while `from` holds it. */
export function stmtRestoreLicenseAccount(
  product: string,
  licenseId: string,
  accountId: string,
  from: string,
): DbStatement {
  return {
    sql: "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ? AND account_id = ?",
    params: [accountId, product, licenseId, from],
  };
}
