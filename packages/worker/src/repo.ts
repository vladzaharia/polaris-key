// The repository layer. Every query is product-scoped (a mandatory `product` predicate on
// every statement) so a tenant boundary can't be crossed even on a logic bug. Repos take
// the `Db` abstraction, so they unit-test against in-memory SQLite and run unchanged on D1.

import type { Db } from "./db/types.js";

// ── Row types (mirror migrations/0001_init.sql) ──────────────────────────────
export interface ProductRow {
  slug: string;
  name: string;
  signing_kid: string;
  signing_key_secret: string;
  signing_pub: string | null;
  compat_min: string;
  compat_max: string;
  default_max_offline_days: number;
  default_machine_limit: number;
  admin_group: string | null;
  branding_json: string | null;
  created_at: number;
  modified_at: number;
}

export interface LicenseRow {
  product: string;
  id: string;
  status: string;
  sub: string | null;
  name: string | null;
  email: string | null;
  groups_json: string | null;
  tier_id: string | null;
  profile_id: string | null;
  enrolled_at: number;
  expires_at: number | null;
  max_offline_days: number | null;
  overrides_json: string | null;
  modified_by: string | null;
  modified_at: number;
}

export interface KeyRow {
  product: string;
  key_hash: string;
  license_id: string;
  status: string;
  label: string | null;
  created_at: number;
  created_by: string | null;
  last_used_at: number | null;
}

export interface MachineRow {
  product: string;
  machine_id: string;
  license_id: string;
  status: string;
  first_seen: number;
  last_seen: number;
  ua: string | null;
  label: string | null;
  overrides_json: string | null;
  reported_json: string | null;
  token_hash: string | null;
}

export interface ProfileRow {
  product: string;
  id: string;
  name: string;
  description: string | null;
  payload_json: string;
  modified_by: string | null;
  modified_at: number;
}

export interface TierRow {
  product: string;
  id: string;
  label: string;
  profile_id: string | null;
  policy_expiry_days: number | null;
  policy_machine_limit: number | null;
  modified_by: string | null;
  modified_at: number;
}

export interface SchemaRow {
  product: string;
  catalog_version: number;
  catalog_json: string;
  active: number;
  created_at: number;
}

export interface AuditRow {
  product: string;
  id: string;
  at: number;
  actor_sub: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  parent_id: string | null;
  summary: string | null;
}

// ── Products ─────────────────────────────────────────────────────────────────
export async function getProduct(db: Db, slug: string): Promise<ProductRow | null> {
  return db.first<ProductRow>("SELECT * FROM products WHERE slug = ?", slug);
}

export async function listProducts(db: Db): Promise<ProductRow[]> {
  return db.all<ProductRow>("SELECT * FROM products ORDER BY slug");
}

export async function insertProduct(db: Db, row: ProductRow): Promise<void> {
  await db.run(
    `INSERT INTO products (slug, name, signing_kid, signing_key_secret, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_machine_limit, admin_group, branding_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.slug, row.name, row.signing_kid, row.signing_key_secret, row.signing_pub, row.compat_min, row.compat_max,
    row.default_max_offline_days, row.default_machine_limit, row.admin_group, row.branding_json,
    row.created_at, row.modified_at,
  );
}

// ── Product schema (data-driven catalog) ─────────────────────────────────────
export async function getActiveSchema(db: Db, product: string): Promise<SchemaRow | null> {
  return db.first<SchemaRow>(
    "SELECT * FROM product_schema WHERE product = ? AND active = 1 ORDER BY catalog_version DESC LIMIT 1",
    product,
  );
}

export async function insertSchema(db: Db, row: SchemaRow): Promise<void> {
  await db.run(
    "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?, ?, ?, ?, ?)",
    row.product, row.catalog_version, row.catalog_json, row.active, row.created_at,
  );
}

// ── Licenses ─────────────────────────────────────────────────────────────────
export async function getLicense(db: Db, product: string, id: string): Promise<LicenseRow | null> {
  return db.first<LicenseRow>("SELECT * FROM licenses WHERE product = ? AND id = ?", product, id);
}

export async function getLicenseBySub(db: Db, product: string, sub: string): Promise<LicenseRow | null> {
  return db.first<LicenseRow>("SELECT * FROM licenses WHERE product = ? AND sub = ?", product, sub);
}

export async function insertLicense(db: Db, row: LicenseRow): Promise<void> {
  await db.run(
    `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, profile_id,
       enrolled_at, expires_at, max_offline_days, overrides_json, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product, row.id, row.status, row.sub, row.name, row.email, row.groups_json, row.tier_id,
    row.profile_id, row.enrolled_at, row.expires_at, row.max_offline_days, row.overrides_json,
    row.modified_by, row.modified_at,
  );
}

// ── Keys (list source-of-truth; KV is the hot read) ──────────────────────────
export async function insertKey(db: Db, row: KeyRow): Promise<void> {
  await db.run(
    `INSERT INTO keys_index (product, key_hash, license_id, status, label, created_at, created_by, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product, row.key_hash, row.license_id, row.status, row.label, row.created_at, row.created_by, row.last_used_at,
  );
}

export async function getKey(db: Db, product: string, keyHash: string): Promise<KeyRow | null> {
  return db.first<KeyRow>("SELECT * FROM keys_index WHERE product = ? AND key_hash = ?", product, keyHash);
}

export async function listKeysByLicense(db: Db, product: string, licenseId: string): Promise<KeyRow[]> {
  return db.all<KeyRow>("SELECT * FROM keys_index WHERE product = ? AND license_id = ?", product, licenseId);
}

export async function touchKey(db: Db, product: string, keyHash: string, at: number): Promise<void> {
  await db.run("UPDATE keys_index SET last_used_at = ? WHERE product = ? AND key_hash = ?", at, product, keyHash);
}

export async function setKeyStatus(db: Db, product: string, keyHash: string, status: string): Promise<void> {
  await db.run("UPDATE keys_index SET status = ? WHERE product = ? AND key_hash = ?", status, product, keyHash);
}

// ── Machines ─────────────────────────────────────────────────────────────────
export async function getMachine(db: Db, product: string, machineId: string): Promise<MachineRow | null> {
  return db.first<MachineRow>("SELECT * FROM machines WHERE product = ? AND machine_id = ?", product, machineId);
}

export async function listMachinesByLicense(db: Db, product: string, licenseId: string): Promise<MachineRow[]> {
  return db.all<MachineRow>("SELECT * FROM machines WHERE product = ? AND license_id = ?", product, licenseId);
}

export async function countActiveMachines(db: Db, product: string, licenseId: string): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM machines WHERE product = ? AND license_id = ? AND status = 'authorized'",
    product, licenseId,
  );
  return r?.n ?? 0;
}

export async function upsertMachine(db: Db, row: MachineRow): Promise<void> {
  await db.run(
    `INSERT INTO machines (product, machine_id, license_id, status, first_seen, last_seen, ua, label,
       overrides_json, reported_json, token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, machine_id) DO UPDATE SET
       license_id = excluded.license_id, status = excluded.status, last_seen = excluded.last_seen,
       ua = excluded.ua, token_hash = excluded.token_hash`,
    row.product, row.machine_id, row.license_id, row.status, row.first_seen, row.last_seen, row.ua,
    row.label, row.overrides_json, row.reported_json, row.token_hash,
  );
}

export async function setMachineStatus(
  db: Db,
  product: string,
  machineId: string,
  status: string,
): Promise<void> {
  await db.run("UPDATE machines SET status = ? WHERE product = ? AND machine_id = ?", status, product, machineId);
}

export async function setMachineReported(
  db: Db,
  product: string,
  machineId: string,
  reportedJson: string,
  at: number,
): Promise<void> {
  await db.run(
    "UPDATE machines SET reported_json = ?, last_seen = ? WHERE product = ? AND machine_id = ?",
    reportedJson, at, product, machineId,
  );
}

// ── Profiles / tiers (for the effective-config merge) ────────────────────────
export async function getProfile(db: Db, product: string, id: string): Promise<ProfileRow | null> {
  return db.first<ProfileRow>("SELECT * FROM profiles WHERE product = ? AND id = ?", product, id);
}

export async function getTier(db: Db, product: string, id: string): Promise<TierRow | null> {
  return db.first<TierRow>("SELECT * FROM tiers WHERE product = ? AND id = ?", product, id);
}

// ── Audit (keyset pagination on (at DESC, id DESC)) ──────────────────────────
export async function appendAudit(db: Db, row: AuditRow): Promise<void> {
  await db.run(
    `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, parent_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product, row.id, row.at, row.actor_sub, row.actor_name, row.actor_email, row.action,
    row.target_kind, row.target_id, row.parent_id, row.summary,
  );
}

export async function listAudit(
  db: Db,
  product: string,
  opts: { beforeAt?: number; beforeId?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.beforeAt !== undefined && opts.beforeId !== undefined) {
    return db.all<AuditRow>(
      `SELECT * FROM audit WHERE product = ? AND (at < ? OR (at = ? AND id < ?))
       ORDER BY at DESC, id DESC LIMIT ?`,
      product, opts.beforeAt, opts.beforeAt, opts.beforeId, limit,
    );
  }
  return db.all<AuditRow>(
    "SELECT * FROM audit WHERE product = ? ORDER BY at DESC, id DESC LIMIT ?",
    product, limit,
  );
}
