// The repository layer. Every query is product-scoped (a mandatory `product` predicate on
// every statement) so a tenant boundary can't be crossed even on a logic bug. Repos take
// the `Db` abstraction, so they unit-test against in-memory SQLite and run unchanged on D1.

import type { Db, DbParam, DbStatement } from "./db/types.js";

// ── Row types (mirror migrations/0001_init.sql) ──────────────────────────────
export interface ProductRow {
  slug: string;
  name: string;
  signing_kid: string;
  signing_pub: string | null;
  compat_min: string;
  compat_max: string;
  default_max_offline_days: number;
  default_device_limit: number;
  admin_group: string | null;
  branding_json: string | null;
  release_source: string | null;
  status?: string;
  deleted_at?: number | null;
  // Fingerprint policy (migrations/0010_fingerprint.sql). `source` decides whether a manifest
  // resync may rewrite `fingerprint_policy_json` or must leave an operator's live edit alone.
  fingerprint_policy_json?: string | null;
  fingerprint_policy_source?: string;
  // Auto-issue policy (migrations/0011_auto_issue.sql), same ownership rules.
  auto_issue_json?: string | null;
  auto_issue_source?: string;
  // Polaris Key service enablement (migrations/0019+0020), same ownership rules again. Parsed by
  // `core/services.ts`; NULL reads back as the defaults (license + config).
  services_json?: string | null;
  services_source?: string | null;
  // Ownership of `compat_min`/`compat_max` (migrations/0022_a), same rules once more: NULL or
  // 'manifest' lets a resync rewrite the window, 'admin' (set by `update/settings`) makes it skip.
  compat_source?: string | null;
  // The per-product CORS allowlist (migrations/0024): a JSON array of exact origins from the
  // manifest's `web.origins`. Manifest-owned with no `_source` column — link writes it, every
  // resync rewrites it. NULL reads back as "no origin allowed". Parsed by `core/cors.ts`.
  web_origins_json?: string | null;
  /** 1 for the platform's own product (`SYSTEM_PRODUCT_SLUG`, migrations/0058_a), set only by
   *  the package-feeds bootstrap; delete and rename refuse it. */
  system?: number;
  // The device-trust policy (migrations/0053_d/e, P6-02): operator-owned, never written by an
  // ingest. NULL reads back as the default policy (`core/deviceTrust.ts`).
  trust_policy_json?: string | null;
  trust_policy_source?: string;
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
  /** Stamped by the revoke action (0021); NULL for keys revoked before the column existed. */
  revoked_at: number | null;
}

// Sealed per-product secret (OIDC client secret, edge-mint key material, …).
export interface ProductSecretRow {
  product: string;
  name: string;
  enc_value_json: string;
  /**
   * What the secret may be used for (P0-12, migration 0025): NULL = general, `'edge-mint'` = an
   * operator marked it as edge-mint signing material. Set only through the admin API. On a
   * write, `undefined` leaves an existing row's usage alone (a new row is general).
   */
  usage?: string | null;
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
  activated_at: number;
  expires_at: number | null;
  max_offline_days: number | null;
  overrides_json: string | null;
  // Admin upgrade-channel + version-window policy (injected as enforced entitlements).
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
  // How this license came into existence: admin | oidc | enroll (0011_auto_issue.sql).
  origin?: string;
  /** The hwid an enrolled license is bound to; NULL for every other origin. */
  enroll_hwid?: string | null;
  /** I-05: the Polaris Key account the licence is attached to; NULL = floating. INTERNAL — the
   *  global account id never reaches a developer-facing response, so every shaper names the
   *  columns it emits. Written only through `core/accountSubjects.ts`. */
  account_id?: string | null;
  /** LX-14a (0084): the licence's own seat limit, a positive integer; NULL (or absent on a row
   *  read before the migration) inherits the tier, a `deviceLimit` entitlement, then the product
   *  default. Written only by the admin licence PATCH. */
  device_limit?: number | null;
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

export interface DeviceRow {
  product: string;
  device_id: string;
  customer_id: string | null;
  license_id: string;
  status: string;
  first_seen: number;
  last_seen: number;
  ua: string | null;
  label: string | null;
  overrides_json: string | null;
  reported_json: string | null;
  token_hash: string | null;
  platform?: string | null;
  arch?: string | null;
  app_version?: string | null;
  sdk_name?: string | null;
  sdk_version?: string | null;
  /** R11-02 — the seat ordinal this device holds. NULL = holds no seat. Written only by
   *  `claimDeviceSeat`/`releaseDeviceSeat`; `upsertDevice` deliberately preserves it. */
  seat_no?: number | null;
  /** P6-02 — `basic` or `attested` (migrations/0053_a). Written only by `setDeviceTrust` and
   *  `resetDeviceTrust`; `upsertDevice` deliberately preserves it, like `seat_no`. */
  trust_level?: string;
  attested_at?: number | null;
  /** The last attestation verdict summary (never a raw token or attestation object). */
  attestation_json?: string | null;
  /** I-05 — the pairwise subject signed in on this device (S-17's binding), never the account
   *  id. Written only by `core/accountSubjects.ts` (`setDeviceSubject`, the clearing hook) and by
   *  `bindDevice`/`registerDeviceBinding` for a sign-in; `upsertDevice` preserves it. */
  subject?: string | null;
  /** I-05 — how the row was last bound: key | enroll | register | signin | store. NULL on rows
   *  written before migrations/0068_d. `upsertDevice` keeps the stored value when omitted. */
  bound_by?: DeviceBoundBy | null;
}

/** I-05 (plans/I-04.md §6.1): how a device row was last bound. */
export type DeviceBoundBy = "key" | "enroll" | "register" | "signin" | "store";

export interface ProfileRow {
  product: string;
  id: string;
  name: string;
  description: string | null;
  payload_json: string;
  modified_by: string | null;
  modified_at: number;
  /** ST-01b (0079): who owns the row. Absent on rows read before the migration ran. */
  source?: RowSource;
}

/**
 * ST-01b (migrations/0079): who owns a tier or profile row. A resync upserts only `manifest` rows
 * and leaves `console` rows (created or edited in the console) alone.
 */
export type RowSource = "manifest" | "console";

export interface TierRow {
  product: string;
  id: string;
  label: string;
  profile_id: string | null;
  policy_expiry_days: number | null;
  policy_device_limit: number | null;
  // Admin upgrade-channel + version-window policy (injected as enforced entitlements).
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
  // Fingerprint enforcement strength for this tier; null inherits the product default.
  policy_fingerprint?: string | null;
  modified_by: string | null;
  modified_at: number;
  /** ST-01b (0079): who owns the row. */
  source?: RowSource;
}

// Current hardware fingerprint per device (migrations/0010_fingerprint.sql). One row per
// device — drift is recorded in `audit`, not kept as history here.
export interface FingerprintRow {
  product: string;
  device_id: string;
  hwid: string;
  components_json: string;
  anchor_hash: string | null;
  status: string;
  first_seen: number;
  last_seen: number;
  last_drift_at: number | null;
  last_drift_count: number | null;
}

// Current software snapshot per device (migrations/0010_fingerprint.sql).
export interface DeviceFactsRow {
  product: string;
  device_id: string;
  os_name: string | null;
  os_version: string | null;
  os_build: string | null;
  kernel: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  ram_mb: number | null;
  machine_model: string | null;
  locale: string | null;
  timezone: string | null;
  runtime_name: string | null;
  runtime_version: string | null;
  probes_json: string | null;
  updated_at: number;
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
  return db.first<ProductRow>(
    "SELECT * FROM products WHERE slug = ? AND COALESCE(status, 'active') != 'deleted'",
    slug,
  );
}

export async function listProducts(db: Db): Promise<ProductRow[]> {
  return db.all<ProductRow>(
    "SELECT * FROM products WHERE COALESCE(status, 'active') != 'deleted' ORDER BY slug",
  );
}

/**
 * Every registered slug, INCLUDING soft-deleted products.
 *
 * `listProducts` hides `status = 'deleted'`, which is right for every serving path and wrong for
 * retention: a soft-deleted product keeps its `audit` rows, its `portal_audit` rows and its
 * download tokens, and those are precisely the rows most in need of pruning. Deletion is a
 * status flip, so the slug is still the only key that scopes the sweep.
 */
export async function listAllProductSlugs(db: Db): Promise<string[]> {
  const rows = await db.all<{ slug: string }>(
    "SELECT slug FROM products ORDER BY slug",
  );
  return rows.map((r) => r.slug);
}

export async function insertProduct(db: Db, row: ProductRow): Promise<void> {
  await db.run(
    `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_device_limit, admin_group, branding_json, release_source, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.slug,
    row.name,
    row.signing_kid,
    row.signing_pub,
    row.compat_min,
    row.compat_max,
    row.default_max_offline_days,
    row.default_device_limit,
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
       AND COALESCE(p.status, 'active') != 'deleted'
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
  /** Also include keys REVOKED at or after this time (wire §2.3's explicit-revocation
   *  window — the trust manifest passes `now − 2×cacheSeconds`). Omit for surfaces that
   *  build TRUSTED key sets (JWKS, discovery): a revoked key never belongs there. */
  revokedSince?: number,
): Promise<ProductKeyRow[]> {
  if (revokedSince === undefined) {
    return db.all<ProductKeyRow>(
      `SELECT * FROM product_keys
       WHERE product = ? AND status IN ('active', 'staged', 'retired')
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'staged' THEN 1 ELSE 2 END, created_at DESC`,
      product,
    );
  }
  return db.all<ProductKeyRow>(
    `SELECT * FROM product_keys
     WHERE product = ? AND (status IN ('active', 'staged', 'retired')
        OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= ?))
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'staged' THEN 1 WHEN 'retired' THEN 2 ELSE 3 END, created_at DESC`,
    product,
    revokedSince,
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

export function stmtRetireProductKeys(
  product: string,
  at: number,
): DbStatement {
  return {
    sql: "UPDATE product_keys SET status = 'retired', rotated_at = ? WHERE product = ? AND status = 'active'",
    params: [at, product],
  };
}

export function stmtSetProductKeyStatus(
  product: string,
  kid: string,
  status: "active" | "staged" | "retired" | "revoked",
  at: number,
): DbStatement {
  return {
    sql: "UPDATE product_keys SET status = ?, rotated_at = ? WHERE product = ? AND kid = ?",
    params: [status, at, product, kid],
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

/**
 * Seal-and-store a product secret. `row.usage === undefined` keeps the stored usage of an
 * existing row (re-uploading a rotated key must not silently change what it may sign), and a
 * new row is general; any other value (including `null` = general) is written as given.
 */
export async function upsertProductSecret(
  db: Db,
  row: ProductSecretRow,
): Promise<void> {
  const setUsage = row.usage !== undefined;
  await db.run(
    `INSERT INTO product_secrets (product, name, enc_value_json, usage, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, name) DO UPDATE SET
       enc_value_json = excluded.enc_value_json, modified_at = excluded.modified_at,
       usage = CASE WHEN ? THEN excluded.usage ELSE product_secrets.usage END`,
    row.product,
    row.name,
    row.enc_value_json,
    row.usage ?? null,
    row.created_at,
    row.modified_at,
    setUsage ? 1 : 0,
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
  provider?: "platform" | "custom";
  issuer?: string;
  clientId?: string;
  clientSecretSecret?: string;
  redirectUris: string[];
  groupRoleMap: Record<string, unknown>;
}
export function stmtInsertOidcConfig(o: OidcConfigInput): DbStatement {
  const provider = o.provider ?? "platform";
  return {
    sql: `INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      o.product,
      provider,
      provider === "custom" ? (o.issuer ?? "") : "",
      provider === "custom" ? (o.clientId ?? "") : "",
      provider === "custom" ? (o.clientSecretSecret ?? "") : "",
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
  policyDeviceLimit: number | null;
  policyFingerprint?: string | null;
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
    sql: `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
             channels_json, min_version, max_version, policy_fingerprint, modified_by, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    params: [
      t.product,
      t.id,
      t.label,
      t.profileId,
      t.policyExpiryDays,
      t.policyDeviceLimit,
      t.channels && t.channels.length > 0 ? JSON.stringify(t.channels) : null,
      t.minVersion ?? null,
      t.maxVersion ?? null,
      t.policyFingerprint ?? null,
      t.modifiedAt,
    ],
  };
}

/**
 * ST-01b: the resync's write of one manifest-declared tier. Inserts it as a `manifest` row, or
 * updates the stored row only while it is still manifest-owned — the guard is the upsert's own
 * WHERE, so a console edit that lands after the resync's reads is never overwritten.
 */
export function stmtUpsertManifestTier(t: TierInput): DbStatement {
  return {
    sql: `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
             channels_json, min_version, max_version, policy_fingerprint, modified_by, modified_at,
             source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'manifest')
          ON CONFLICT(product, id) DO UPDATE SET
            label = excluded.label, profile_id = excluded.profile_id,
            policy_expiry_days = excluded.policy_expiry_days,
            policy_device_limit = excluded.policy_device_limit,
            channels_json = excluded.channels_json, min_version = excluded.min_version,
            max_version = excluded.max_version, policy_fingerprint = excluded.policy_fingerprint,
            modified_by = NULL, modified_at = excluded.modified_at
          WHERE tiers.source = 'manifest'`,
    params: stmtInsertTier(t).params,
  };
}

/** ST-01b: the resync's write of one manifest-declared profile, under the same guard. */
export function stmtUpsertManifestProfile(p: ProfileInput): DbStatement {
  return {
    sql: `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at, source)
          VALUES (?, ?, ?, ?, ?, NULL, ?, 'manifest')
          ON CONFLICT(product, id) DO UPDATE SET
            name = excluded.name, description = excluded.description,
            payload_json = excluded.payload_json, modified_by = NULL,
            modified_at = excluded.modified_at
          WHERE profiles.source = 'manifest'`,
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

/** ST-01b: drop a manifest tier the manifest no longer declares (never a console row). */
export function stmtDeleteManifestTier(
  product: string,
  id: string,
): DbStatement {
  return {
    sql: "DELETE FROM tiers WHERE product = ? AND id = ? AND source = 'manifest'",
    params: [product, id],
  };
}

/** ST-01b: drop a manifest profile the manifest no longer declares (never a console row). */
export function stmtDeleteManifestProfile(
  product: string,
  id: string,
): DbStatement {
  return {
    sql: "DELETE FROM profiles WHERE product = ? AND id = ? AND source = 'manifest'",
    params: [product, id],
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
  /** NULL for the system product, linked by the deploy hook rather than through the App. */
  ghInstallationId: number | null;
  channelWorkflow: string | null;
  betaBranch: string;
  binaryName: string;
  sparkleEd25519Pub: string | null;
  summaryMarker: string;
  manualChannelsJson?: string | null;
  artifactPolicyJson?: string | null;
  metadataAccess?: string;
  artifactsAccess?: string;
  /** Owner of the two access modes (0022_b). A freshly linked row is manifest-owned. */
  accessSource?: "manifest" | "admin" | null;
  /** The operator-only artifact policy (0022_c). No manifest path supplies it; link leaves it NULL. */
  operatorPolicyJson?: string | null;
  stableTagPattern?: string | null;
  ignoreTagsJson?: string | null;
  /** `release.releaseKeys` (0044, P3-03); NULL when none or refused at link. */
  releaseKeysJson?: string | null;
}
export function stmtInsertReleaseConfig(r: ReleaseConfigInput): DbStatement {
  return {
    sql: `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
            manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker, artifact_policy_json,
            metadata_access, artifacts_access, access_source, operator_policy_json,
            stable_tag_pattern, ignore_tags_json, release_keys_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      r.product,
      r.ghOwner,
      r.ghRepo,
      r.ghInstallationId,
      r.channelWorkflow,
      r.betaBranch,
      r.manualChannelsJson ?? null,
      r.binaryName,
      r.sparkleEd25519Pub,
      r.summaryMarker,
      r.artifactPolicyJson ?? null,
      r.metadataAccess ?? "public",
      r.artifactsAccess ?? "public",
      r.accessSource ?? null,
      r.operatorPolicyJson ?? null,
      r.stableTagPattern ?? null,
      r.ignoreTagsJson ?? null,
      r.releaseKeysJson ?? null,
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

/**
 * Drop the edge-mint approvals whose recipe id the product no longer declares (P0-12). Pushed
 * into the link/resync batch AFTER the `edge_mint_config` re-insert, so the sub-select sees the
 * manifest's new recipe set. The ingest path only ever DELETES approvals: an approval is an
 * operator decision and is written by the Config admin API alone, never from a manifest.
 */
export function stmtDeleteOrphanEdgeMintApprovals(
  product: string,
): DbStatement {
  return {
    sql: `DELETE FROM edge_mint_approvals
           WHERE product = ?
             AND id NOT IN (SELECT id FROM edge_mint_config WHERE product = ?)`,
    params: [product, product],
  };
}

/** Build the `products`-INSERT as a statement (for atomic batch with its child rows). */
/**
 * Build the products INSERT as a statement (for atomic batch).
 *
 * `services_json`/`services_source` are in the column list rather than applied afterwards like
 * the fingerprint and auto-issue policies: which services a product runs decides which of its
 * routes exist at all, so a product row must never be visible without one. Both are nullable,
 * and a NULL pair reads back as the defaults (`core/services.ts`), so callers with nothing to
 * say simply omit them.
 */
export function stmtInsertProduct(row: ProductRow): DbStatement {
  return {
    sql: `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
            default_max_offline_days, default_device_limit, admin_group, branding_json, release_source,
            services_json, services_source, compat_source, web_origins_json, created_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.slug,
      row.name,
      row.signing_kid,
      row.signing_pub,
      row.compat_min,
      row.compat_max,
      row.default_max_offline_days,
      row.default_device_limit,
      row.admin_group,
      row.branding_json,
      row.release_source,
      row.services_json ?? null,
      row.services_source ?? null,
      row.compat_source ?? null,
      row.web_origins_json ?? null,
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
    `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id,
       activated_at, expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
       origin, enroll_hwid, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    row.modified_by,
    row.modified_at,
  );
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
  },
  at: number,
): Promise<void> {
  await db.run(
    `UPDATE licenses SET sub = ?, name = ?, email = ?, groups_json = ?, tier_id = ?,
       expires_at = ?, origin = 'oidc', modified_by = 'oidc',
       modified_at = ? WHERE product = ? AND id = ?`,
    identity.sub,
    identity.name,
    identity.email,
    identity.groupsJson,
    identity.tierId,
    identity.expiresAt,
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
  const base = `UPDATE devices SET seat_no = NULL
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
    try {
      const changes = await db.runChanges(
        `INSERT INTO devices
           (product, device_id, license_id, status, seat_no, first_seen, last_seen)
         VALUES (?, ?, ?, 'authorized', ?, ?, ?)
         ON CONFLICT(product, device_id) DO UPDATE SET
           license_id = excluded.license_id,
           status = 'authorized',
           seat_no = excluded.seat_no,
           last_seen = excluded.last_seen
         WHERE devices.seat_no IS NULL OR devices.status <> 'authorized'`,
        product,
        deviceId,
        licenseId,
        free.n,
        now,
        now,
      );
      if (changes > 0) return true;
      // The row exists and already holds a seat — nothing to claim.
      return true;
    } catch {
      // UNIQUE constraint on idx_devices_seat: another isolate took this ordinal first.
      continue;
    }
  }
  return false;
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

export async function upsertDevice(db: Db, row: DeviceRow): Promise<void> {
  // I-05: `subject` is written on INSERT only (a first-ever bind through a sign-in) and otherwise
  // preserved, like `seat_no`: the binding changes only through `core/accountSubjects.ts`, so a
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

/** P6-02 — write the operator's device-trust policy (`trust_policy_source = 'admin'`). */
export async function setTrustPolicy(
  db: Db,
  product: string,
  json: string | null,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE products SET trust_policy_json = ?, trust_policy_source = ?, modified_at = ? WHERE slug = ?",
    json,
    json === null ? "default" : "admin",
    now,
    product,
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

/**
 * Write a product's fingerprint policy.
 *
 * `source` is what makes "configured in the manifest AND editable by an operator" coherent
 * rather than a live edit that silently evaporates on the next push: a manifest resync passes
 * `"manifest"` and the UPDATE is skipped whenever an admin has already claimed the row, while
 * an admin write passes `"admin"` and always wins.
 */
export async function setFingerprintPolicy(
  db: Db,
  product: string,
  policyJson: string | null,
  source: "manifest" | "admin",
  at: number,
): Promise<void> {
  const stmt = stmtSetFingerprintPolicy(product, policyJson, source, at);
  await db.run(stmt.sql, ...stmt.params);
}

/** `setFingerprintPolicy` as a statement, for a batch (ST-01b: the resync applies in one batch). */
export function stmtSetFingerprintPolicy(
  product: string,
  policyJson: string | null,
  source: "manifest" | "admin",
  at: number,
): DbStatement {
  if (source === "manifest")
    return {
      sql: `UPDATE products SET fingerprint_policy_json = ?, modified_at = ?
         WHERE slug = ? AND COALESCE(fingerprint_policy_source, 'manifest') = 'manifest'`,
      params: [policyJson, at, product],
    };
  return {
    sql: `UPDATE products SET fingerprint_policy_json = ?, fingerprint_policy_source = 'admin',
       modified_at = ? WHERE slug = ?`,
    params: [policyJson, at, product],
  };
}

/** Write a product's auto-issue policy under the same manifest-vs-admin ownership rule as
 *  the fingerprint policy: a resync only writes while the row is still manifest-owned. */
export async function setAutoIssuePolicy(
  db: Db,
  product: string,
  policyJson: string | null,
  source: "manifest" | "admin",
  at: number,
): Promise<void> {
  const stmt = stmtSetAutoIssuePolicy(product, policyJson, source, at);
  await db.run(stmt.sql, ...stmt.params);
}

/** `setAutoIssuePolicy` as a statement, for a batch (ST-01b: the resync applies in one batch). */
export function stmtSetAutoIssuePolicy(
  product: string,
  policyJson: string | null,
  source: "manifest" | "admin",
  at: number,
): DbStatement {
  if (source === "manifest")
    return {
      sql: `UPDATE products SET auto_issue_json = ?, modified_at = ?
         WHERE slug = ? AND COALESCE(auto_issue_source, 'manifest') = 'manifest'`,
      params: [policyJson, at, product],
    };
  return {
    sql: `UPDATE products SET auto_issue_json = ?, auto_issue_source = 'admin',
       modified_at = ? WHERE slug = ?`,
    params: [policyJson, at, product],
  };
}

/**
 * Write a product's Polaris Key service enablement under the same manifest-vs-admin ownership rule
 * as the fingerprint and auto-issue policies: a resync only writes while the row is still
 * manifest-owned, so an operator who turns a service off in the console does not have it turned
 * back on by the next push to the product repo.
 *
 * The stakes are higher here than for the sibling policies — this decides which ROUTES exist —
 * which is exactly why the guard is the same `WHERE … = 'manifest'` predicate in the UPDATE
 * itself rather than a read-then-write in the caller.
 */
export async function setServices(
  db: Db,
  product: string,
  servicesJson: string | null,
  source: "manifest" | "admin",
  at: number,
): Promise<void> {
  const stmt = stmtSetServices(product, servicesJson, source, at);
  await db.run(stmt.sql, ...stmt.params);
}

/** `setServices` as a statement, for a batch (ST-01b: the resync applies in one batch). */
export function stmtSetServices(
  product: string,
  servicesJson: string | null,
  source: "manifest" | "admin",
  at: number,
): DbStatement {
  if (source === "manifest")
    return {
      sql: `UPDATE products SET services_json = ?, modified_at = ?
         WHERE slug = ? AND COALESCE(services_source, 'manifest') = 'manifest'`,
      params: [servicesJson, at, product],
    };
  return {
    sql: `UPDATE products SET services_json = ?, services_source = 'admin',
       modified_at = ? WHERE slug = ?`,
    params: [servicesJson, at, product],
  };
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
       status, first_seen, last_seen, last_drift_at, last_drift_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, device_id) DO UPDATE SET
       hwid = excluded.hwid, components_json = excluded.components_json,
       anchor_hash = excluded.anchor_hash, status = excluded.status,
       last_seen = excluded.last_seen, last_drift_at = excluded.last_drift_at,
       last_drift_count = excluded.last_drift_count`,
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
/** `appendAudit` as a statement, for a caller that must write the row in the same atomic batch
 *  as the change it records (A-16's app assignment). */
export function auditStatement(row: AuditRow): DbStatement {
  return {
    sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, parent_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
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
    ],
  };
}

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

/**
 * Delete one product's `audit` rows older than `cutoff`. Returns how many were removed.
 *
 * R11-09: nothing has ever deleted from this table. Bounded by `limit` and driven from the
 * `scheduled()` sweep, which calls it repeatedly until a pass removes fewer rows than it asked
 * for — so an old, huge backlog drains over several nights instead of one statement trying to
 * delete millions of rows inside a single D1 invocation.
 *
 * `idx_audit_time(product, at DESC, id DESC)` serves the inner SELECT. The `product` predicate
 * is mandatory, as everywhere else in this file: retention on a shared table must never be able
 * to reach past the tenant it was asked about.
 */
export async function pruneAudit(
  db: Db,
  product: string,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM audit
      WHERE rowid IN (
        SELECT rowid FROM audit WHERE product = ? AND at < ? LIMIT ?
      )`,
    product,
    cutoff,
    limit,
  );
}

/**
 * The activity feed's filters (A-2). Every one narrows; none widens. `action` is a PREFIX
 * (`license.` matches `license.create` and `license.tier.change`), compared with `substr` so a
 * `%` or `_` in it is literal. `actor` matches the subject or the email exactly; the reserved
 * value `system` matches the rows the runtime writes with no session behind them. `since` and
 * `until` are epoch seconds, inclusive.
 */
export interface AuditFilters {
  action?: string;
  actor?: string;
  targetKind?: string;
  targetId?: string;
  since?: number;
  until?: number;
}

export async function listAudit(
  db: Db,
  product: string,
  opts: {
    beforeAt?: number;
    beforeId?: string;
    limit?: number;
  } & AuditFilters = {},
): Promise<AuditRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: string[] = ["product = ?"];
  const params: DbParam[] = [product];
  if (opts.beforeAt !== undefined && opts.beforeId !== undefined) {
    where.push("(at < ? OR (at = ? AND id < ?))");
    params.push(opts.beforeAt, opts.beforeAt, opts.beforeId);
  }
  if (opts.action) {
    where.push("substr(action, 1, ?) = ?");
    params.push(opts.action.length, opts.action);
  }
  if (opts.actor === "system") {
    where.push("(actor_sub IS NULL OR actor_sub = '')");
  } else if (opts.actor) {
    where.push("(actor_sub = ? OR actor_email = ?)");
    params.push(opts.actor, opts.actor);
  }
  if (opts.targetKind) {
    where.push("target_kind = ?");
    params.push(opts.targetKind);
  }
  if (opts.targetId) {
    where.push("target_id = ?");
    params.push(opts.targetId);
  }
  if (opts.since !== undefined) {
    where.push("at >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push("at <= ?");
    params.push(opts.until);
  }
  return db.all<AuditRow>(
    `SELECT * FROM audit WHERE ${where.join(" AND ")}
     ORDER BY at DESC, id DESC LIMIT ?`,
    ...params,
    limit,
  );
}

// ── Platform audit (A-12; product-less twin of `audit`, keyset on (at DESC, id DESC)) ──────
export interface PlatformAuditRow {
  id: string;
  at: number;
  actor_sub: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  summary: string | null;
  before_json: string | null;
  after_json: string | null;
}

/** `appendPlatformAudit` as a statement, for an atomic batch (A-16). */
export function platformAuditStatement(row: PlatformAuditRow): DbStatement {
  return {
    sql: `INSERT INTO platform_audit (id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.id,
      row.at,
      row.actor_sub,
      row.actor_name,
      row.actor_email,
      row.action,
      row.target_kind,
      row.target_id,
      row.summary,
      row.before_json,
      row.after_json,
    ],
  };
}

export async function appendPlatformAudit(
  db: Db,
  row: PlatformAuditRow,
): Promise<void> {
  await db.run(
    `INSERT INTO platform_audit (id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.at,
    row.actor_sub,
    row.actor_name,
    row.actor_email,
    row.action,
    row.target_kind,
    row.target_id,
    row.summary,
    row.before_json,
    row.after_json,
  );
}

export async function listPlatformAudit(
  db: Db,
  opts: { beforeAt?: number; beforeId?: string; limit?: number } = {},
): Promise<PlatformAuditRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.beforeAt !== undefined && opts.beforeId !== undefined) {
    return db.all<PlatformAuditRow>(
      `SELECT * FROM platform_audit WHERE (at < ? OR (at = ? AND id < ?))
       ORDER BY at DESC, id DESC LIMIT ?`,
      opts.beforeAt,
      opts.beforeAt,
      opts.beforeId,
      limit,
    );
  }
  return db.all<PlatformAuditRow>(
    "SELECT * FROM platform_audit ORDER BY at DESC, id DESC LIMIT ?",
    limit,
  );
}

/**
 * Delete `platform_audit` rows older than `cutoff`, at most `limit` per call (the nightly sweep
 * drains it like `pruneAudit`). The table has no product column: it is platform-level by
 * construction, which `scheduled.ts`'s "product-scoped" property names explicitly.
 */
export async function prunePlatformAudit(
  db: Db,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM platform_audit
      WHERE rowid IN (SELECT rowid FROM platform_audit WHERE at < ? LIMIT ?)`,
    cutoff,
    limit,
  );
}

// ── Platform deploys (A-11; written only by deploy.yml, read here) ─────────────────────────
export interface PlatformDeployRow {
  id: string;
  at: number;
  environment: string;
  tag: string;
  git_sha: string;
  run_url: string | null;
  scripts: string;
  latest_migration: string | null;
  cf_version_id: string | null;
  deltas_version_id: string | null;
  smoke: string | null;
}

export async function listPlatformDeploys(
  db: Db,
  opts: { beforeAt?: number; beforeId?: string; limit?: number } = {},
): Promise<PlatformDeployRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  if (opts.beforeAt !== undefined && opts.beforeId !== undefined) {
    return db.all<PlatformDeployRow>(
      `SELECT * FROM platform_deploys WHERE (at < ? OR (at = ? AND id < ?))
       ORDER BY at DESC, id DESC LIMIT ?`,
      opts.beforeAt,
      opts.beforeAt,
      opts.beforeId,
      limit,
    );
  }
  return db.all<PlatformDeployRow>(
    "SELECT * FROM platform_deploys ORDER BY at DESC, id DESC LIMIT ?",
    limit,
  );
}
