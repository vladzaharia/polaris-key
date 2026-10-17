// Product store (P0-18): the `products` row and its policies, sealed key custody, the active
// catalog, and the registration statement-builders. Split out of `core/repo.ts`.

import { stmtRevokeProductCiTokens } from "../publisher.js";
import { stmtRevokeProductRegistryTokens } from "../registry/registryTokens.js";
import { productGrantErasureStatements } from "../licensing/grants.js";
import { productDeletionStatements } from "../contributions.js";
import { stmtDeleteProductAutoAttachBlocks } from "../licensing/licenseHolders.js";
import type { Db, DbStatement, DbParam } from "../../db/types.js";
import type {
  ProductRow,
  SchemaRow,
  ProductKeyRow,
  ProductSecretRow,
  ProductSyncStateRow,
} from "../repo.js";

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

/**
 * `presentation_json` (migrations/0106, HA-12) is named only when the row carries it: the manifest
 * writers always do (NULL when undeclared), while a product created without a manifest (the
 * console, a test seed) leaves it to the column's NULL default. So an insert still works against
 * a database migrated only up to an older schema.
 */
function presentationInsert(row: ProductRow): {
  column: string;
  values: (string | null)[];
} {
  return row.presentation_json === undefined
    ? { column: "", values: [] }
    : { column: ", presentation_json", values: [row.presentation_json] };
}

export async function insertProduct(db: Db, row: ProductRow): Promise<void> {
  const presentation = presentationInsert(row);
  await db.run(
    `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_device_limit, admin_group, branding_json, release_source${presentation.column},
       created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${presentation.values.map(() => ", ?").join("")}, ?, ?)`,
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
    ...presentation.values,
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

// ── Sealed key custody (envelope-encrypted under the platform KEK; see src/platform/keyvault.ts) ──
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

/** The active catalog version of every product that has one, in ONE query: the same answer as
 *  `getActiveSchema(slug)?.catalog_version` per product (highest active version), for a listing. */
export async function activeSchemaVersions(
  db: Db,
): Promise<Map<string, number>> {
  const rows = await db.all<{ product: string; v: number }>(
    "SELECT product, MAX(catalog_version) AS v FROM product_schema WHERE active = 1 GROUP BY product",
  );
  return new Map(rows.map((r) => [r.product, r.v]));
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
  /** LX-08: `licensing.tiers[].rank` (0 when omitted). */
  rank?: number;
  /** LX-08: `licensing.tiers[].policyOfflineGraceDays` (null when omitted). */
  policyOfflineGraceDays?: number | null;
  modifiedAt: number;
}

/** `stmtInsertTier`'s params from `label` to `policy_offline_grace_days`: the manifest-owned
 *  columns a resync and the settings backfill compare (`slice(...TIER_COMPARED_PARAMS)`). */
export const TIER_COMPARED_PARAMS = [2, 12] as const;

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
             channels_json, min_version, max_version, policy_fingerprint, rank,
             policy_offline_grace_days, modified_by, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
      t.rank ?? 0,
      t.policyOfflineGraceDays ?? null,
      t.modifiedAt,
    ],
  };
}

/** ST-42: a profile the console's create adds (`source = 'console'`: a resync never rewrites it). */
export function stmtInsertConsoleProfile(p: {
  product: string;
  id: string;
  name: string;
  payloadJson: string;
  author: string;
  now: number;
}): DbStatement {
  return {
    sql: `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at, source)
          VALUES (?, ?, ?, NULL, ?, ?, ?, 'console')`,
    params: [p.product, p.id, p.name, p.payloadJson, p.author, p.now],
  };
}

/** ST-42: the starter tier the console's create adds (rank 0, the product's limits). */
export function stmtInsertConsoleTier(t: {
  product: string;
  id: string;
  label: string;
  profileId: string;
  author: string;
  now: number;
}): DbStatement {
  return {
    sql: `INSERT INTO tiers (product, id, label, profile_id, rank, modified_by, modified_at, source)
          VALUES (?, ?, ?, ?, 0, ?, ?, 'console')`,
    params: [t.product, t.id, t.label, t.profileId, t.author, t.now],
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
             channels_json, min_version, max_version, policy_fingerprint, rank,
             policy_offline_grace_days, modified_by, modified_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'manifest')
          ON CONFLICT(product, id) DO UPDATE SET
            label = excluded.label, profile_id = excluded.profile_id,
            policy_expiry_days = excluded.policy_expiry_days,
            policy_device_limit = excluded.policy_device_limit,
            channels_json = excluded.channels_json, min_version = excluded.min_version,
            max_version = excluded.max_version, policy_fingerprint = excluded.policy_fingerprint,
            rank = excluded.rank, policy_offline_grace_days = excluded.policy_offline_grace_days,
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
  /** Who may mint this recipe. Omitted persists as `licensed`: fail closed. */
  requires?: "none" | "registered" | "licensed";
  /** A catalog flag the caller's merged payload must carry, truthy. */
  requiredEntitlement?: string | null;
}
export function stmtInsertEdgeMint(e: EdgeMintInput): DbStatement {
  return {
    sql: `INSERT INTO edge_mint_config (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience, auth_page_template, requires, required_entitlement)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    params: [
      e.product,
      e.id,
      e.alg,
      e.signingKeySecret,
      e.kid ?? null,
      JSON.stringify(e.claimsTemplate),
      e.ttlSeconds,
      e.audience ?? null,
      // The `??` restates the column's own fail-closed default, so a caller that builds an
      // `EdgeMintInput` by hand (a test, a future admin path) does not rely on the DDL to decide
      // its authorization posture.
      e.requires ?? "licensed",
      e.requiredEntitlement ?? null,
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
  const presentation = presentationInsert(row);
  return {
    sql: `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
            default_max_offline_days, default_device_limit, admin_group, branding_json, release_source,
            services_json, services_source, compat_source, web_origins_json${presentation.column},
            created_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${presentation.values.map(() => ", ?").join("")}, ?, ?)`,
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
      ...presentation.values,
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

/**
 * Insert a key and say whether the `kid` was free: `false` means that kid already exists for the
 * product, not that something went wrong.
 *
 * A bare `INSERT` turned a rotation `kid` collision on `PRIMARY KEY (product, kid)` into an
 * undiagnosable 500 with nothing naming the cause. `ON CONFLICT DO NOTHING` plus the changes
 * count turns it into a fact the caller can report, and leaves the existing row untouched.
 *
 * Not a batch, because the caller needs the answer. Staging a key is a single-row insert of a
 * STAGED key; it has nothing to be atomic with.
 */
export async function insertProductKeyIfAbsent(
  db: Db,
  row: ProductKeyRow,
): Promise<boolean> {
  const stmt = stmtInsertProductKey(row);
  const changes = await db.runChanges(
    `${stmt.sql} ON CONFLICT(product, kid) DO NOTHING`,
    ...stmt.params,
  );
  return changes > 0;
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

// ── Products (platform registry) ─────────────────────────────────────────────
export type ProductUpdateFields = Partial<
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
>;

export async function updateProduct(
  db: Db,
  slug: string,
  fields: ProductUpdateFields,
  now: number,
): Promise<void> {
  const stmt = stmtUpdateProduct(slug, fields, now);
  await db.run(stmt.sql, ...stmt.params);
}

/** `updateProduct` as a statement, so a console write and its claims (ST-01b) share one batch. */
export function stmtUpdateProduct(
  slug: string,
  fields: ProductUpdateFields,
  now: number,
): DbStatement {
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
  return {
    sql: `UPDATE products SET ${sets.join(", ")} WHERE slug = ?`,
    params,
  };
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
    // Each mounted service erases its own rows for the product (`contributes.productDeletion`):
    // License revokes the active licences and erases their holders; Identity drops the account
    // links, subjects, grants, terms acceptances, library entries, storefront aggregates and
    // relink history; Config drops the account overrides and the migration report; Distribution
    // switches the product's package feeds off.
    ...productDeletionStatements(slug, now),
    // LX-26: the auto-attach blocks name accounts; the licences they guarded are erased above.
    stmtDeleteProductAutoAttachBlocks(slug),
    // LX-08: the licensing model's account- and store-held grants, the Steam identities verified
    // on its devices and the entitlement-event feed (subjects); licence-held grants stay with
    // their licences (`core/licensing/grants.ts`).
    ...productGrantErasureStatements(slug),
    {
      sql: "UPDATE devices SET status = 'deauthorized', subject = NULL WHERE product = ?",
      params: [slug],
    },
    {
      sql: "UPDATE product_keys SET status = 'revoked', rotated_at = ?, revoked_at = ? WHERE product = ?",
      params: [now, now, slug],
    },
    // P5-01: a deleted product keeps no store keys. Deleted, not flagged: an outlet credential
    // is a live key to someone else's account, and nothing about a deleted product needs it.
    // (This and the KEK sweep are the only places outside `core/outletCredentials.ts` allowed
    // to name the table — `test/outletCredentialReach.test.ts`.)
    {
      sql: "DELETE FROM outlet_credentials WHERE product = ?",
      params: [slug],
    },
    // ST-40: SDK sightings hold no personal data; a deleted product keeps none of them.
    { sql: "DELETE FROM sdk_sightings WHERE product = ?", params: [slug] },
    // A-16: a deleted product holds no platform store app: its pins on the team credentials go,
    // which frees the app for another product.
    {
      sql: "DELETE FROM platform_credential_pins WHERE product = ?",
      params: [slug],
    },
    // P2-02: no CI credential outlives its product (`lookupCiToken` also refuses a deleted
    // product's tokens; this makes the revocation visible in the token list too).
    stmtRevokeProductCiTokens(slug, now),
    // F-21: nor any registry token (the lookup also joins `products.status <> 'deleted'`).
    stmtRevokeProductRegistryTokens(slug, now),
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

/**
 * Every catalog version a product has published, newest first (ADMIN.md A-6). Versions are never
 * deleted: a publish deactivates the old row and inserts the next, so this is the full history.
 */
export async function listSchemaVersions(
  db: Db,
  product: string,
): Promise<SchemaRow[]> {
  return db.all<SchemaRow>(
    "SELECT * FROM product_schema WHERE product = ? ORDER BY catalog_version DESC",
    product,
  );
}

/** One catalog version, active or not. */
export async function getSchemaVersion(
  db: Db,
  product: string,
  version: number,
): Promise<SchemaRow | null> {
  return db.first<SchemaRow>(
    "SELECT * FROM product_schema WHERE product = ? AND catalog_version = ?",
    product,
    version,
  );
}

/**
 * Who published each console catalog version: the `schema.publish` audit rows (their target id
 * is the version). A version with no row came from the product's manifest (create or resync).
 */
export async function listSchemaPublishers(
  db: Db,
  product: string,
): Promise<
  {
    target_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
  }[]
> {
  return db.all(
    "SELECT target_id, actor_name, actor_email FROM audit WHERE product = ? AND action = 'schema.publish'",
    product,
  );
}
