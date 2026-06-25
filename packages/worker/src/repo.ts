// The repository layer. Every query is product-scoped (a mandatory `product` predicate on
// every statement) so a tenant boundary can't be crossed even on a logic bug. Repos take
// the `Db` abstraction, so they unit-test against in-memory SQLite and run unchanged on D1.

import type { Db, DbStatement } from "./db/types.js";

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
  release_source: string | null;
  created_at: number;
  modified_at: number;
}

// Sealed Ed25519 signing key material (migrations/0003_keyvault.sql). enc_private_json is a
// `JSON.stringify(Sealed)` blob opened under the platform KEK; public_b64url is the raw key.
export interface ProductKeyRow {
  product: string;
  kid: string;
  alg: string;
  public_b64url: string;
  enc_private_json: string;
  status: string;
  created_at: number;
  rotated_at: number | null;
}

// Sealed per-product secret (OIDC client secret, edge-mint key material, …).
export interface ProductSecretRow {
  product: string;
  name: string;
  enc_value_json: string;
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
  // Admin upgrade-channel + version-window policy (injected as enforced entitlements).
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
  modified_by: string | null;
  modified_at: number;
}

export interface LicenseProfileRow {
  product: string;
  license_id: string;
  profile_id: string;
  sort_order: number;
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
  // Admin upgrade-channel + version-window policy (injected as enforced entitlements).
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
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

export interface ProductSyncStateRow {
  product: string;
  source: string;
  status: string;
  last_checked_at: number;
  last_synced_at: number | null;
  commit_sha: string | null;
  changed_paths_json: string | null;
  updated_json: string | null;
  errors_json: string | null;
  message: string | null;
}

// ── Products ─────────────────────────────────────────────────────────────────
export async function getProduct(
  db: Db,
  slug: string,
): Promise<ProductRow | null> {
  return db.first<ProductRow>("SELECT * FROM products WHERE slug = ?", slug);
}

export async function listProducts(db: Db): Promise<ProductRow[]> {
  return db.all<ProductRow>("SELECT * FROM products ORDER BY slug");
}

export async function insertProduct(db: Db, row: ProductRow): Promise<void> {
  await db.run(
    `INSERT INTO products (slug, name, signing_kid, signing_key_secret, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_machine_limit, admin_group, branding_json, release_source, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.slug,
    row.name,
    row.signing_kid,
    row.signing_key_secret,
    row.signing_pub,
    row.compat_min,
    row.compat_max,
    row.default_max_offline_days,
    row.default_machine_limit,
    row.admin_group,
    row.branding_json,
    row.release_source,
    row.created_at,
    row.modified_at,
  );
}

export async function getProductSyncState(
  db: Db,
  product: string,
): Promise<ProductSyncStateRow | null> {
  return db.first<ProductSyncStateRow>(
    "SELECT * FROM product_sync_state WHERE product = ?",
    product,
  );
}

export async function listProductsByGithubRepo(
  db: Db,
  owner: string,
  repo: string,
): Promise<ProductRow[]> {
  return db.all<ProductRow>(
    `SELECT p.* FROM products p
       JOIN release_config r ON r.product = p.slug
      WHERE p.release_source = 'github'
        AND lower(r.gh_owner) = lower(?)
        AND lower(r.gh_repo) = lower(?)
      ORDER BY p.slug`,
    owner,
    repo,
  );
}

export async function upsertProductSyncState(
  db: Db,
  row: ProductSyncStateRow,
): Promise<void> {
  await db.run(
    `INSERT INTO product_sync_state
       (product, source, status, last_checked_at, last_synced_at, commit_sha,
        changed_paths_json, updated_json, errors_json, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET
       source = excluded.source,
       status = excluded.status,
       last_checked_at = excluded.last_checked_at,
       last_synced_at = excluded.last_synced_at,
       commit_sha = excluded.commit_sha,
       changed_paths_json = excluded.changed_paths_json,
       updated_json = excluded.updated_json,
       errors_json = excluded.errors_json,
       message = excluded.message`,
    row.product,
    row.source,
    row.status,
    row.last_checked_at,
    row.last_synced_at,
    row.commit_sha,
    row.changed_paths_json,
    row.updated_json,
    row.errors_json,
    row.message,
  );
}

// ── Sealed key custody (envelope-encrypted under the platform KEK; see src/keyvault.ts) ──
export async function getActiveProductKey(
  db: Db,
  product: string,
): Promise<ProductKeyRow | null> {
  return db.first<ProductKeyRow>(
    "SELECT * FROM product_keys WHERE product = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    product,
  );
}

export async function listVerificationProductKeys(
  db: Db,
  product: string,
): Promise<ProductKeyRow[]> {
  return db.all<ProductKeyRow>(
    `SELECT * FROM product_keys
     WHERE product = ? AND status IN ('active', 'retired')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
    product,
  );
}

export async function insertProductKey(
  db: Db,
  row: ProductKeyRow,
): Promise<void> {
  await db.run(
    `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at, rotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product,
    row.kid,
    row.alg,
    row.public_b64url,
    row.enc_private_json,
    row.status,
    row.created_at,
    row.rotated_at,
  );
}

/** Retire every currently-active key for a product (key rotation: old → retired). */
export async function retireProductKeys(
  db: Db,
  product: string,
  at: number,
): Promise<void> {
  await db.run(
    "UPDATE product_keys SET status = 'retired', rotated_at = ? WHERE product = ? AND status = 'active'",
    at,
    product,
  );
}

export function stmtRetireProductKeys(
  product: string,
  at: number,
): DbStatement {
  return {
    sql: "UPDATE product_keys SET status = 'retired', rotated_at = ? WHERE product = ? AND status = 'active'",
    params: [at, product],
  };
}

export async function getProductSecret(
  db: Db,
  product: string,
  name: string,
): Promise<ProductSecretRow | null> {
  return db.first<ProductSecretRow>(
    "SELECT * FROM product_secrets WHERE product = ? AND name = ?",
    product,
    name,
  );
}

export async function upsertProductSecret(
  db: Db,
  row: ProductSecretRow,
): Promise<void> {
  await db.run(
    `INSERT INTO product_secrets (product, name, enc_value_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(product, name) DO UPDATE SET
       enc_value_json = excluded.enc_value_json, modified_at = excluded.modified_at`,
    row.product,
    row.name,
    row.enc_value_json,
    row.created_at,
    row.modified_at,
  );
}

// ── Product schema (data-driven catalog) ─────────────────────────────────────
export async function getActiveSchema(
  db: Db,
  product: string,
): Promise<SchemaRow | null> {
  return db.first<SchemaRow>(
    "SELECT * FROM product_schema WHERE product = ? AND active = 1 ORDER BY catalog_version DESC LIMIT 1",
    product,
  );
}

export async function insertSchema(db: Db, row: SchemaRow): Promise<void> {
  await db.run(
    "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?, ?, ?, ?, ?)",
    row.product,
    row.catalog_version,
    row.catalog_json,
    row.active,
    row.created_at,
  );
}

// ── Product registration statement-builders ──────────────────────────────────
// These return `DbStatement`s (rather than running themselves) so a product-creation flow
// can compose them into a single atomic `db.batch([...])`. Column order mirrors
// products/gen-seed.ts so the manual + GitHub paths persist identically to the seed SQL.

export interface OidcConfigInput {
  product: string;
  issuer: string;
  clientId: string;
  clientSecretSecret: string;
  redirectUris: string[];
  groupRoleMap: Record<string, unknown>;
}
export function stmtInsertOidcConfig(o: OidcConfigInput): DbStatement {
  return {
    sql: `INSERT INTO oidc_config (product, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      o.product,
      o.issuer,
      o.clientId,
      o.clientSecretSecret,
      JSON.stringify(o.redirectUris),
      JSON.stringify(o.groupRoleMap),
    ],
  };
}

export interface TierInput {
  product: string;
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyMachineLimit: number | null;
  channels?: string[] | null;
  minVersion?: string | null;
  maxVersion?: string | null;
  modifiedAt: number;
}

export interface ProfileInput {
  product: string;
  id: string;
  name: string;
  description?: string | null;
  payloadJson: string;
  modifiedAt: number;
}
export function stmtInsertProfile(p: ProfileInput): DbStatement {
  return {
    sql: `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    params: [
      p.product,
      p.id,
      p.name,
      p.description ?? null,
      p.payloadJson,
      p.modifiedAt,
    ],
  };
}
export function stmtInsertTier(t: TierInput): DbStatement {
  return {
    sql: `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_machine_limit,
             channels_json, min_version, max_version, modified_by, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    params: [
      t.product,
      t.id,
      t.label,
      t.profileId,
      t.policyExpiryDays,
      t.policyMachineLimit,
      t.channels && t.channels.length > 0 ? JSON.stringify(t.channels) : null,
      t.minVersion ?? null,
      t.maxVersion ?? null,
      t.modifiedAt,
    ],
  };
}

export interface ProvisioningInput {
  product: string;
  claim: string;
  entitlementKey?: string;
  entitlementValue?: unknown;
  secretKey?: string;
  secretUrlTemplate?: string;
  allowedHosts?: string[];
}
export function stmtInsertProvisioning(h: ProvisioningInput): DbStatement {
  return {
    sql: `INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      h.product,
      h.claim,
      h.entitlementKey ?? null,
      h.entitlementValue !== undefined
        ? JSON.stringify(h.entitlementValue)
        : null,
      h.secretKey ?? null,
      h.secretUrlTemplate ?? null,
      h.allowedHosts ? JSON.stringify(h.allowedHosts) : null,
    ],
  };
}

export interface ReleaseConfigInput {
  product: string;
  ghOwner: string;
  ghRepo: string;
  ghInstallationId: number;
  channelWorkflow: string | null;
  betaBranch: string;
  binaryName: string;
  sparkleEd25519Pub: string | null;
  summaryMarker: string;
}
export function stmtInsertReleaseConfig(r: ReleaseConfigInput): DbStatement {
  return {
    sql: `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
            manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    params: [
      r.product,
      r.ghOwner,
      r.ghRepo,
      r.ghInstallationId,
      r.channelWorkflow,
      r.betaBranch,
      r.binaryName,
      r.sparkleEd25519Pub,
      r.summaryMarker,
    ],
  };
}

export interface EdgeMintInput {
  product: string;
  id: string;
  alg: string;
  signingKeySecret: string;
  kid?: string;
  claimsTemplate: Record<string, unknown>;
  ttlSeconds: number;
  audience?: string | null;
}
export function stmtInsertEdgeMint(e: EdgeMintInput): DbStatement {
  return {
    sql: `INSERT INTO edge_mint_config (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience, auth_page_template)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      e.product,
      e.id,
      e.alg,
      e.signingKeySecret,
      e.kid ?? null,
      JSON.stringify(e.claimsTemplate),
      e.ttlSeconds,
      e.audience ?? null,
    ],
  };
}

/** Build the `products`-INSERT as a statement (for atomic batch with its child rows). */
export function stmtInsertProduct(row: ProductRow): DbStatement {
  return {
    sql: `INSERT INTO products (slug, name, signing_kid, signing_key_secret, signing_pub, compat_min, compat_max,
            default_max_offline_days, default_machine_limit, admin_group, branding_json, release_source, created_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.slug,
      row.name,
      row.signing_kid,
      row.signing_key_secret,
      row.signing_pub,
      row.compat_min,
      row.compat_max,
      row.default_max_offline_days,
      row.default_machine_limit,
      row.admin_group,
      row.branding_json,
      row.release_source,
      row.created_at,
      row.modified_at,
    ],
  };
}

/** Build the active-schema INSERT as a statement (for atomic batch). */
export function stmtInsertSchema(row: SchemaRow): DbStatement {
  return {
    sql: "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?, ?, ?, ?, ?)",
    params: [
      row.product,
      row.catalog_version,
      row.catalog_json,
      row.active,
      row.created_at,
    ],
  };
}

/** Build the sealed product-key INSERT as a statement (for atomic batch). */
export function stmtInsertProductKey(row: ProductKeyRow): DbStatement {
  return {
    sql: `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at, rotated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.product,
      row.kid,
      row.alg,
      row.public_b64url,
      row.enc_private_json,
      row.status,
      row.created_at,
      row.rotated_at,
    ],
  };
}

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
  await db.run(
    `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, profile_id,
       enrolled_at, expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
       modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product,
    row.id,
    row.status,
    row.sub,
    row.name,
    row.email,
    row.groups_json,
    row.tier_id,
    row.profile_id,
    row.enrolled_at,
    row.expires_at,
    row.max_offline_days,
    row.overrides_json,
    row.channels_json,
    row.min_version,
    row.max_version,
    row.modified_by,
    row.modified_at,
  );
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
    {
      sql: "UPDATE licenses SET profile_id = ? WHERE product = ? AND id = ?",
      params: [unique[0] ?? null, product, licenseId],
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

// ── Machines ─────────────────────────────────────────────────────────────────
export async function getMachine(
  db: Db,
  product: string,
  machineId: string,
): Promise<MachineRow | null> {
  return db.first<MachineRow>(
    "SELECT * FROM machines WHERE product = ? AND machine_id = ?",
    product,
    machineId,
  );
}

export async function listMachinesByLicense(
  db: Db,
  product: string,
  licenseId: string,
): Promise<MachineRow[]> {
  return db.all<MachineRow>(
    "SELECT * FROM machines WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
}

export async function countActiveMachines(
  db: Db,
  product: string,
  licenseId: string,
): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM machines WHERE product = ? AND license_id = ? AND status = 'authorized'",
    product,
    licenseId,
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
    row.product,
    row.machine_id,
    row.license_id,
    row.status,
    row.first_seen,
    row.last_seen,
    row.ua,
    row.label,
    row.overrides_json,
    row.reported_json,
    row.token_hash,
  );
}

export async function setMachineStatus(
  db: Db,
  product: string,
  machineId: string,
  status: string,
): Promise<void> {
  await db.run(
    "UPDATE machines SET status = ? WHERE product = ? AND machine_id = ?",
    status,
    product,
    machineId,
  );
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
    reportedJson,
    at,
    product,
    machineId,
  );
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

// ── Audit (keyset pagination on (at DESC, id DESC)) ──────────────────────────
export async function appendAudit(db: Db, row: AuditRow): Promise<void> {
  await db.run(
    `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, parent_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product,
    row.id,
    row.at,
    row.actor_sub,
    row.actor_name,
    row.actor_email,
    row.action,
    row.target_kind,
    row.target_id,
    row.parent_id,
    row.summary,
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
      product,
      opts.beforeAt,
      opts.beforeAt,
      opts.beforeId,
      limit,
    );
  }
  return db.all<AuditRow>(
    "SELECT * FROM audit WHERE product = ? ORDER BY at DESC, id DESC LIMIT ?",
    product,
    limit,
  );
}
