// Admin-only repository helpers. These complement the hot-path repo (../repo.ts) with the
// list/mutate queries the admin console needs. EVERY query is product-scoped (a mandatory
// `product` predicate on every statement) so the tenant boundary holds even on a logic bug;
// the platform-product registry queries (products table) are the only intentionally
// unscoped ones, and they are gated on PLATFORM_ADMIN before they're reached.

import type { Db } from "../db/types.js";
import type {
  KeyRow,
  LicenseRow,
  MachineRow,
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
      | "default_machine_limit"
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

export async function deleteProduct(db: Db, slug: string): Promise<void> {
  // Order matters under foreign keys: child rows first, then the product.
  for (const table of [
    "audit",
    "machines",
    "keys_index",
    "licenses",
    "tiers",
    "profiles",
    "product_schema",
    "product_keys",
    "product_secrets",
    "oidc_config",
    "provisioning_config",
    "edge_mint_config",
    "release_config",
    "identity",
  ]) {
    const col = table === "products" ? "slug" : "product";
    await db.run(`DELETE FROM ${table} WHERE ${col} = ?`, slug);
  }
  await db.run("DELETE FROM products WHERE slug = ?", slug);
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
    "SELECT * FROM licenses WHERE product = ? ORDER BY enrolled_at DESC, id DESC",
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
      | "profile_id"
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

// ── Machines ─────────────────────────────────────────────────────────────────
export async function listMachinesByProduct(
  db: Db,
  product: string,
): Promise<MachineRow[]> {
  return db.all<MachineRow>(
    "SELECT * FROM machines WHERE product = ?",
    product,
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

export async function countLicensesUsingProfile(
  db: Db,
  product: string,
  profileId: string,
): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM licenses WHERE product = ? AND profile_id = ?",
    product,
    profileId,
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
    `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_machine_limit,
       channels_json, min_version, max_version, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, id) DO UPDATE SET
       label = excluded.label, profile_id = excluded.profile_id,
       policy_expiry_days = excluded.policy_expiry_days,
       policy_machine_limit = excluded.policy_machine_limit,
       channels_json = excluded.channels_json, min_version = excluded.min_version,
       max_version = excluded.max_version,
       modified_by = excluded.modified_by, modified_at = excluded.modified_at`,
    row.product,
    row.id,
    row.label,
    row.profile_id,
    row.policy_expiry_days,
    row.policy_machine_limit,
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

// ── Key (revoke by hash, list) — light wrappers used by the admin API ─────────
export async function listKeysForProduct(
  db: Db,
  product: string,
): Promise<KeyRow[]> {
  return db.all<KeyRow>("SELECT * FROM keys_index WHERE product = ?", product);
}
