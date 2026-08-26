// Admin-only repository helpers. These complement the hot-path repo (../repo.ts) with the
// list/mutate queries the admin console needs. EVERY query is product-scoped (a mandatory
// `product` predicate on every statement) so the tenant boundary holds even on a logic bug;
// the platform-product registry queries (products table) are the only intentionally
// unscoped ones, and they are gated on PLATFORM_ADMIN before they're reached.

import type { Db } from "../db/types.js";
import type {
  KeyRow,
  LicenseRow,
  DeviceRow,
  ProductRow,
  ProfileRow,
  TierRow,
} from "../repo.js";

// ── Products (platform registry) ─────────────────────────────────────────────
export async function updateProduct(
  db: Db,
  slug: string,
  fields: Partial<
    Pick<
      ProductRow,
      | "name"
      | "compat_min"
      | "compat_max"
      | "default_max_offline_days"
      | "default_device_limit"
      | "admin_group"
      | "branding_json"
    >
  >,
  now: number,
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(val as string | number | null);
  }
  sets.push("modified_at = ?");
  params.push(now);
  params.push(slug);
  await db.run(
    `UPDATE products SET ${sets.join(", ")} WHERE slug = ?`,
    ...params,
  );
}

/**
 * Soft-delete a product and revoke everything that authenticates against it.
 *
 * R11-09 / R12-10: the soft delete used to be a pure status flip that deleted NOTHING, so
 * `licenses.email`, `.name`, `.sub` and `.groups_json` survived verbatim forever and
 * right-to-erasure was structurally unimplementable. The status flip is still the right
 * primitive (audit trails, license ids and device history stay intact), but the personal data
 * is now erased in the same atomic batch: a deleted product retains the SHAPE of its licenses,
 * not the people behind them. `sub` and `enroll_hwid` go too — they are re-identifiers and,
 * left in place, they keep occupying `idx_licenses_sub` / `idx_licenses_enroll_hwid` so a
 * re-created product could never re-issue to the same subject or machine.
 */
export async function deleteProduct(
  db: Db,
  slug: string,
  now: number,
): Promise<void> {
  await db.batch([
    {
      sql: "UPDATE products SET status = 'deleted', deleted_at = ?, modified_at = ? WHERE slug = ?",
      params: [now, now, slug],
    },
    {
      sql: `UPDATE licenses
               SET status = 'disabled',
                   email = NULL, name = NULL, sub = NULL, groups_json = NULL,
                   enroll_hwid = NULL, modified_at = ?
             WHERE product = ?`,
      params: [now, slug],
    },
    {
      sql: "DELETE FROM portal_license_links WHERE product = ?",
      params: [slug],
    },
    {
      sql: "UPDATE devices SET status = 'deauthorized' WHERE product = ?",
      params: [slug],
    },
    {
      sql: "UPDATE keys_index SET status = 'revoked' WHERE product = ?",
      params: [slug],
    },
    {
      sql: "UPDATE product_keys SET status = 'revoked', rotated_at = ? WHERE product = ?",
      params: [now, slug],
    },
  ]);
}

// ── Schema (catalog) writes ──────────────────────────────────────────────────
export async function deactivateSchemas(
  db: Db,
  product: string,
): Promise<void> {
  await db.run(
    "UPDATE product_schema SET active = 0 WHERE product = ?",
    product,
  );
}

export async function nextSchemaVersion(
  db: Db,
  product: string,
): Promise<number> {
  const r = await db.first<{ v: number | null }>(
    "SELECT MAX(catalog_version) AS v FROM product_schema WHERE product = ?",
    product,
  );
  return (r?.v ?? 0) + 1;
}

// ── Licenses ─────────────────────────────────────────────────────────────────
export async function listLicenses(
  db: Db,
  product: string,
): Promise<LicenseRow[]> {
  return db.all<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? ORDER BY activated_at DESC, id DESC",
    product,
  );
}

export async function setLicenseStatus(
  db: Db,
  product: string,
  id: string,
  status: string,
  modifiedBy: string | null,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE licenses SET status = ?, modified_by = ?, modified_at = ? WHERE product = ? AND id = ?",
    status,
    modifiedBy,
    now,
    product,
    id,
  );
}

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

// ── Devices ──────────────────────────────────────────────────────────────────
export async function listDevicesByProduct(
  db: Db,
  product: string,
): Promise<DeviceRow[]> {
  return db.all<DeviceRow>("SELECT * FROM devices WHERE product = ?", product);
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

export async function upsertProfile(db: Db, row: ProfileRow): Promise<void> {
  await db.run(
    `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, id) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       payload_json = excluded.payload_json, modified_by = excluded.modified_by,
       modified_at = excluded.modified_at`,
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

export async function upsertTier(db: Db, row: TierRow): Promise<void> {
  await db.run(
    `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
       channels_json, min_version, max_version, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, id) DO UPDATE SET
       label = excluded.label, profile_id = excluded.profile_id,
       policy_expiry_days = excluded.policy_expiry_days,
       policy_device_limit = excluded.policy_device_limit,
       channels_json = excluded.channels_json, min_version = excluded.min_version,
       max_version = excluded.max_version,
       modified_by = excluded.modified_by, modified_at = excluded.modified_at`,
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
