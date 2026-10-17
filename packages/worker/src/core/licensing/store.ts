// Licensing store (P0-18): the `licenses`, `keys_index`, `tiers` and `license_profiles` queries.
// Split out of `core/repo.ts`; the seats, grants and lifecycle live beside it in `core/licensing/`.

import { holderFilterSql, type HolderFilter } from "./licenseHolders.js";
import type { Db, DbParam, DbStatement } from "../../db/types.js";
import type {
  LicenseRow,
  ProfileRow,
  TierRow,
  KeyRow,
  LicenseProfileRow,
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

/** {@link listLicenseProfiles} for many licences: one read per 90 ids, licence id → its rows in order. */
export async function listLicenseProfileRows(
  db: Db,
  product: string,
  licenseIds: readonly string[],
): Promise<Map<string, LicenseProfileRow[]>> {
  const out = new Map<string, LicenseProfileRow[]>();
  for (let i = 0; i < licenseIds.length; i += 90) {
    const ids = licenseIds.slice(i, i + 90);
    const rows = await db.all<LicenseProfileRow>(
      `SELECT * FROM license_profiles WHERE product = ? AND license_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY license_id, sort_order ASC, profile_id ASC`,
      product,
      ...ids,
    );
    for (const r of rows) {
      const list = out.get(r.license_id) ?? [];
      list.push(r);
      out.set(r.license_id, list);
    }
  }
  return out;
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

// ── Licenses ─────────────────────────────────────────────────────────────────
/** The licence list's page size when the caller names none (P0-29). */
export const LICENSE_PAGE_DEFAULT = 50;
/** The largest page: what one `IN (…)` read binds (D1 allows 100 parameters, one is the product). */
export const LICENSE_PAGE_MAX = 90;

/** A keyset position in the list's order (`activated_at DESC, id DESC`). */
export interface LicenseCursor {
  activatedAt: number;
  id: string;
}

/** The cursor of the last licence of a page: `<activated_at>.<id>`, opaque to the caller. */
export function encodeLicenseCursor(l: {
  activated_at: number;
  id: string;
}): string {
  return `${l.activated_at}.${l.id}`;
}

/** A cursor back to its position; `null` when it is not one this module wrote. */
export function decodeLicenseCursor(raw: string): LicenseCursor | null {
  const m = /^(-?\d{1,15})\.([A-Za-z0-9_-]{1,64})$/.exec(raw);
  return m ? { activatedAt: Number(m[1]), id: m[2]! } : null;
}

/** The licence list's computed states, as the console names them (LIC-1). */
export const LICENSE_LIST_STATES = [
  "active",
  "expiring",
  "expired",
  "disabled",
] as const;
export type LicenseListState = (typeof LICENSE_LIST_STATES)[number];

/**
 * What the list narrows by: holder state, batch, tier (`tier_id`) and computed state. `state`
 * needs `now` (epoch seconds), the same clock the counts use.
 */
export interface LicenseListFilter {
  holder?: HolderFilter;
  batch?: string;
  tier?: string;
  state?: LicenseListState;
  now?: number;
}

/** The licence list's computed states, as the console names them (LIC-1). */
export interface LicenseStateCounts {
  active: number;
  expiring: number;
  expired: number;
  disabled: number;
}

/** Days before expiry at which a licence reads "expiring soon" (the console's `EXPIRES_SOON_DAYS`). */
const EXPIRES_SOON_SECONDS = 14 * 86_400;

function filterSql(
  filter: LicenseListFilter,
  params: (string | number)[],
): string {
  // LX-26: the holder filter is the derived rule as SQL (`core/licensing/licenseHolders.ts`), never a copy.
  let sql = filter.holder
    ? ` AND ${holderFilterSql(filter.holder, "licenses")}`
    : "";
  // LX-28: one batch's licences (`idx_licenses_batch`).
  if (filter.batch !== undefined) {
    sql += " AND batch_id = ?";
    params.push(filter.batch);
  }
  if (filter.tier !== undefined) {
    sql += " AND tier_id = ?";
    params.push(filter.tier);
  }
  if (filter.state !== undefined && filter.now !== undefined) {
    const now = filter.now;
    // The same ladder as `countLicenses`: disabled, then expired, then expiring, else active.
    switch (filter.state) {
      case "disabled":
        sql += " AND status = 'disabled'";
        break;
      case "expired":
        sql +=
          " AND status <> 'disabled' AND expires_at IS NOT NULL AND expires_at <= ?";
        params.push(now);
        break;
      case "expiring":
        sql +=
          " AND status <> 'disabled' AND expires_at IS NOT NULL AND expires_at > ? AND expires_at - ? <= ?";
        params.push(now, now, EXPIRES_SOON_SECONDS);
        break;
      case "active":
        sql +=
          " AND status <> 'disabled' AND (expires_at IS NULL OR expires_at - ? > ?)";
        params.push(now, EXPIRES_SOON_SECONDS);
        break;
    }
  }
  return sql;
}

/**
 * How many licences the filter matches and how many sit in each computed state: one GROUP BY,
 * the same on every page of the list, so the console reads them with page 1.
 */
export async function countLicenses(
  db: Db,
  product: string,
  filter: LicenseListFilter,
  now: number,
): Promise<{ total: number; counts: LicenseStateCounts }> {
  const params: (string | number)[] = [];
  // The tiles count every state of the other filters, so the state filter is left out here.
  const { state, ...rest } = filter;
  const where = filterSql(rest, params);
  const rows = await db.all<{ s: keyof LicenseStateCounts; n: number }>(
    `SELECT CASE
        WHEN status = 'disabled' THEN 'disabled'
        WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired'
        WHEN expires_at IS NOT NULL AND expires_at - ? <= ? THEN 'expiring'
        ELSE 'active' END AS s, COUNT(*) AS n
       FROM licenses WHERE product = ?${where} GROUP BY s`,
    now,
    now,
    EXPIRES_SOON_SECONDS,
    product,
    ...params,
  );
  const counts: LicenseStateCounts = {
    active: 0,
    expiring: 0,
    expired: 0,
    disabled: 0,
  };
  for (const r of rows) counts[r.s] = r.n;
  const total = state
    ? counts[state]
    : counts.active + counts.expiring + counts.expired + counts.disabled;
  return { total, counts };
}

export async function listLicenses(
  db: Db,
  product: string,
  filter: LicenseListFilter = {},
): Promise<LicenseRow[]> {
  return (await listLicensePage(db, product, filter)).licenses;
}

/**
 * One page of the list, newest first by keyset (`activated_at DESC, id DESC`), or all of it when
 * `page.limit` is absent. `nextCursor` is `null` on the last page.
 */
export async function listLicensePage(
  db: Db,
  product: string,
  filter: LicenseListFilter = {},
  page: { limit?: number; after?: LicenseCursor } = {},
): Promise<{ licenses: LicenseRow[]; nextCursor: string | null }> {
  const filterParams: (string | number)[] = [];
  const where = filterSql(filter, filterParams);
  const after = page.after
    ? " AND (activated_at < ? OR (activated_at = ? AND id < ?))"
    : "";
  const rows = await db.all<LicenseRow>(
    `SELECT * FROM licenses WHERE product = ?${where}${after} ORDER BY activated_at DESC, id DESC${
      page.limit !== undefined ? " LIMIT ?" : ""
    }`,
    product,
    ...filterParams,
    ...(page.after
      ? [page.after.activatedAt, page.after.activatedAt, page.after.id]
      : []),
    ...(page.limit !== undefined ? [page.limit + 1] : []),
  );
  const licenses = page.limit !== undefined ? rows.slice(0, page.limit) : rows;
  const last = licenses[licenses.length - 1];
  return {
    licenses,
    nextCursor:
      page.limit !== undefined && rows.length > page.limit && last
        ? encodeLicenseCursor(last)
        : null,
  };
}

/**
 * The licences an ACCOUNT holds in one product (F-33): the library's entries for it, as the
 * portal reads them (`licenses.account_id`). Newest activation first.
 */
export async function listAccountLicenses(
  db: Db,
  accountId: string,
  product: string,
): Promise<LicenseRow[]> {
  return db.all<LicenseRow>(
    `SELECT * FROM licenses WHERE account_id = ? AND product = ?
      ORDER BY activated_at DESC, id DESC LIMIT 50`,
    accountId,
    product,
  );
}

// A licence's status changes only through the lifecycle (LX-12): `transitionLicense` in
// `core/licensing/lifecycleWrites.ts`, which writes `ended_reason` with it.

export async function patchLicense(
  db: Db,
  product: string,
  id: string,
  fields: Partial<
    Pick<
      LicenseRow,
      | "name"
      | "email"
      | "expires_at"
      | "max_offline_days"
      | "tier_id"
      | "overrides_json"
      | "channels_json"
      | "min_version"
      | "max_version"
      | "device_limit"
    >
  >,
  modifiedBy: string | null,
  now: number,
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(val as string | number | null);
  }
  if (sets.length === 0) return;
  sets.push("modified_by = ?", "modified_at = ?");
  params.push(modifiedBy, now, product, id);
  await db.run(
    `UPDATE licenses SET ${sets.join(", ")} WHERE product = ? AND id = ?`,
    ...params,
  );
}

// ── Keys ─────────────────────────────────────────────────────────────────────
export async function countKeysByLicense(
  db: Db,
  product: string,
  licenseId: string,
): Promise<{ total: number; active: number }> {
  const total = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM keys_index WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
  const active = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM keys_index WHERE product = ? AND license_id = ? AND status = 'active'",
    product,
    licenseId,
  );
  return { total: total?.n ?? 0, active: active?.n ?? 0 };
}

// ── Profiles ─────────────────────────────────────────────────────────────────
export async function listProfiles(
  db: Db,
  product: string,
): Promise<ProfileRow[]> {
  return db.all<ProfileRow>(
    "SELECT * FROM profiles WHERE product = ? ORDER BY id",
    product,
  );
}

/**
 * The console's profile write. ST-01b: a console create or edit owns the row (`source =
 * 'console'`), so a resync leaves it alone from then on — a manifest row edited here is claimed.
 *
 * `claim: false` keeps the stored owner: the one console write that is NOT a claim is setting a
 * managed secret's value, which a manifest cannot express and the resync already carries forward
 * on a manifest row (R2, `resync.ts` `withStoredSecrets`).
 */
export async function upsertProfile(
  db: Db,
  row: ProfileRow,
  opts: { claim?: boolean } = {},
): Promise<void> {
  const claim = opts.claim ?? true;
  await db.run(
    `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at,
       source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'console')
     ON CONFLICT(product, id) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       payload_json = excluded.payload_json, modified_by = excluded.modified_by,
       modified_at = excluded.modified_at${claim ? ", source = 'console'" : ""}`,
    row.product,
    row.id,
    row.name,
    row.description,
    row.payload_json,
    row.modified_by,
    row.modified_at,
  );
}

export async function deleteProfile(
  db: Db,
  product: string,
  id: string,
): Promise<void> {
  await db.run(
    "DELETE FROM profiles WHERE product = ? AND id = ?",
    product,
    id,
  );
}

/**
 * How many things still point at this profile — across EVERY referrer, not just the direct
 * license attachments.
 *
 * R11-01: this used to count `license_profiles` only. A tier attaches a baseline profile via
 * `tiers.profile_id` (the documented way to give a whole tier a managed payload,
 * 0001_init.sql:38-39) and that column is a plain TEXT with no foreign key, so deleting a
 * tier's baseline passed the 0-reference guard, returned 200, and silently stripped the
 * config defaults, secrets and ENFORCED ENTITLEMENTS that every license on that tier inherits
 * — `resolveEffective` treats a dangling profile_id as an empty layer, so nothing errors.
 */
export async function countLicensesUsingProfile(
  db: Db,
  product: string,
  profileId: string,
): Promise<number> {
  const r = await db.first<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM license_profiles
              WHERE product = ? AND profile_id = ?)
          + (SELECT COUNT(*) FROM tiers
              WHERE product = ? AND profile_id = ?) AS n`,
    product,
    profileId,
    product,
    profileId,
  );
  return r?.n ?? 0;
}

/**
 * What points at each profile, by profile id: the tiers whose baseline it is and the licenses
 * that list it (`license_profiles`), the two referrer classes `countLicensesUsingProfile` sums.
 * The console's Profiles list shows the counts, the profile record lists them, and Delete stays
 * disabled while either is non-empty.
 */
export async function listProfileReferences(
  db: Db,
  product: string,
): Promise<{
  tiers: { profile_id: string; id: string; label: string }[];
  licenses: {
    profile_id: string;
    id: string;
    name: string | null;
    email: string | null;
  }[];
}> {
  const tiers = await db.all<{ profile_id: string; id: string; label: string }>(
    "SELECT profile_id, id, label FROM tiers WHERE product = ? AND profile_id IS NOT NULL ORDER BY id",
    product,
  );
  const licenses = await db.all<{
    profile_id: string;
    id: string;
    name: string | null;
    email: string | null;
  }>(
    `SELECT lp.profile_id AS profile_id, l.id AS id, l.name AS name, l.email AS email
       FROM license_profiles lp
       JOIN licenses l ON l.product = lp.product AND l.id = lp.license_id
      WHERE lp.product = ?
      ORDER BY l.id`,
    product,
  );
  return { tiers, licenses };
}

export async function countLicensesUsingTier(
  db: Db,
  product: string,
  tierId: string,
): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM licenses WHERE product = ? AND tier_id = ?",
    product,
    tierId,
  );
  return r?.n ?? 0;
}

// ── Tiers ────────────────────────────────────────────────────────────────────
export async function listTiers(db: Db, product: string): Promise<TierRow[]> {
  return db.all<TierRow>(
    "SELECT * FROM tiers WHERE product = ? ORDER BY id",
    product,
  );
}

/** The console's tier write; ST-01b: it owns the row (`source = 'console'`), like `upsertProfile`. */
export async function upsertTier(db: Db, row: TierRow): Promise<void> {
  await db.run(
    `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
       channels_json, min_version, max_version, modified_by, modified_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'console')
     ON CONFLICT(product, id) DO UPDATE SET
       label = excluded.label, profile_id = excluded.profile_id,
       policy_expiry_days = excluded.policy_expiry_days,
       policy_device_limit = excluded.policy_device_limit,
       channels_json = excluded.channels_json, min_version = excluded.min_version,
       max_version = excluded.max_version,
       modified_by = excluded.modified_by, modified_at = excluded.modified_at,
       source = 'console'`,
    row.product,
    row.id,
    row.label,
    row.profile_id,
    row.policy_expiry_days,
    row.policy_device_limit,
    row.channels_json,
    row.min_version,
    row.max_version,
    row.modified_by,
    row.modified_at,
  );
}

export async function deleteTier(
  db: Db,
  product: string,
  id: string,
): Promise<void> {
  await db.run("DELETE FROM tiers WHERE product = ? AND id = ?", product, id);
}
