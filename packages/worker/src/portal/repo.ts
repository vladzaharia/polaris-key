import type { Db } from "../db/types.js";
import { hashKey, mintToken, randomId } from "../crypto.js";
import type { Env } from "../env.js";
import type { DeviceRow, KeyRow, LicenseRow, ProductRow } from "../repo.js";

export interface PortalAccountRow {
  id: string;
  status: string;
  display_name: string | null;
  primary_email: string | null;
  created_at: number;
  modified_at: number;
}

export interface PortalProductSettingsRow {
  product: string;
  portal_enabled: number;
  oidc_enabled: number;
  magic_enabled: number;
  license_key_claim_enabled: number;
  releases_enabled: number;
  branding_json: string | null;
  created_at: number;
  modified_at: number;
}

export interface PortalProductSettingsView {
  portalEnabled: boolean;
  oidcEnabled: boolean;
  magicEnabled: boolean;
  licenseKeyClaimEnabled: boolean;
  releasesEnabled: boolean;
  branding: unknown;
  modifiedAt: number;
}

export interface PortalLicenseRow extends LicenseRow {
  product_name: string;
  product_branding_json: string | null;
}

export interface PortalReleaseRow {
  product: string;
  product_name: string;
  release_id: string;
  version: string;
  title: string | null;
  notes: string | null;
  source_url: string | null;
  metadata_access: string;
  artifacts_access: string;
  published_at: number | null;
  metadata_json: string | null;
}

export interface PortalArtifactRow {
  product: string;
  release_id: string;
  artifact_id: string;
  name: string;
  kind: string | null;
  platform: string | null;
  arch: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  source_url: string | null;
  access: string;
}

export interface PortalDownloadTokenRow {
  product: string;
  token_hash: string;
  release_id: string;
  artifact_id: string | null;
  scope_json: string | null;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseJsonUnknown(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getPortalAccount(
  db: Db,
  id: string,
): Promise<PortalAccountRow | null> {
  return db.first<PortalAccountRow>(
    "SELECT * FROM portal_accounts WHERE id = ?",
    id,
  );
}

async function insertPortalAccount(
  db: Db,
  input: { email?: string | null; displayName?: string | null },
  now: number,
): Promise<PortalAccountRow> {
  const id = randomId("acct");
  await db.run(
    `INSERT INTO portal_accounts
       (id, status, display_name, primary_email, created_at, modified_at)
     VALUES (?, 'active', ?, ?, ?, ?)`,
    id,
    input.displayName ?? input.email ?? null,
    input.email ? normalizeEmail(input.email) : null,
    now,
    now,
  );
  const row = await getPortalAccount(db, id);
  if (!row) throw new Error("portal account insert failed");
  return row;
}

export async function getOrCreateAccountByEmail(
  db: Db,
  email: string,
  now: number,
  displayName?: string | null,
): Promise<PortalAccountRow> {
  const normalized = normalizeEmail(email);
  const existing = await db.first<PortalAccountRow>(
    `SELECT a.* FROM portal_account_emails e
      JOIN portal_accounts a ON a.id = e.account_id
     WHERE e.email = ?`,
    normalized,
  );
  if (existing) return existing;
  const account = await insertPortalAccount(
    db,
    { email: normalized, displayName },
    now,
  );
  await linkEmail(db, account.id, normalized, now);
  return account;
}

export async function getOrCreateAccountByIdentity(
  db: Db,
  input: {
    provider: string;
    subject: string;
    email?: string | null;
    displayName?: string | null;
  },
  now: number,
): Promise<PortalAccountRow> {
  const existing = await db.first<PortalAccountRow>(
    `SELECT a.* FROM portal_account_identities i
      JOIN portal_accounts a ON a.id = i.account_id
     WHERE i.provider = ? AND i.subject = ?`,
    input.provider,
    input.subject,
  );
  if (existing) {
    await db.run(
      `UPDATE portal_account_identities
          SET email = ?, display_name = ?, last_seen_at = ?
        WHERE provider = ? AND subject = ?`,
      input.email ? normalizeEmail(input.email) : null,
      input.displayName ?? null,
      now,
      input.provider,
      input.subject,
    );
    if (input.email) await linkEmail(db, existing.id, input.email, now);
    return existing;
  }

  const emailAccount = input.email
    ? await db.first<PortalAccountRow>(
        `SELECT a.* FROM portal_account_emails e
          JOIN portal_accounts a ON a.id = e.account_id
         WHERE e.email = ?`,
        normalizeEmail(input.email),
      )
    : null;
  const account =
    emailAccount ??
    (await insertPortalAccount(
      db,
      { email: input.email ?? null, displayName: input.displayName ?? null },
      now,
    ));
  await db.run(
    `INSERT INTO portal_account_identities
       (provider, subject, account_id, email, display_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.provider,
    input.subject,
    account.id,
    input.email ? normalizeEmail(input.email) : null,
    input.displayName ?? null,
    now,
    now,
  );
  if (input.email) await linkEmail(db, account.id, input.email, now);
  return account;
}

export async function linkEmail(
  db: Db,
  accountId: string,
  email: string,
  now: number,
): Promise<void> {
  const normalized = normalizeEmail(email);
  await db.run(
    `INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       verified_at = excluded.verified_at`,
    normalized,
    accountId,
    now,
    now,
  );
  await db.run(
    `UPDATE portal_accounts
        SET primary_email = COALESCE(primary_email, ?),
            display_name = COALESCE(display_name, ?),
            modified_at = ?
      WHERE id = ?`,
    normalized,
    normalized,
    now,
    accountId,
  );
}

export async function linkLicense(
  db: Db,
  accountId: string,
  product: string,
  licenseId: string,
  source: "email" | "oidc" | "license-key" | "admin",
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO portal_license_links
       (account_id, product, license_id, source, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, product, license_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at`,
    accountId,
    product,
    licenseId,
    source,
    now,
    now,
  );
}

export async function syncAccountLicenseLinks(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  const emails = await db.all<{ email: string }>(
    "SELECT email FROM portal_account_emails WHERE account_id = ?",
    accountId,
  );
  for (const row of emails) {
    const matches = await db.all<{ product: string; id: string }>(
      "SELECT product, id FROM licenses WHERE lower(email) = ?",
      row.email,
    );
    for (const license of matches) {
      await linkLicense(
        db,
        accountId,
        license.product,
        license.id,
        "email",
        now,
      );
    }
  }

  const identities = await db.all<{ subject: string }>(
    "SELECT subject FROM portal_account_identities WHERE account_id = ?",
    accountId,
  );
  for (const identity of identities) {
    const matches = await db.all<{ product: string; id: string }>(
      "SELECT product, id FROM licenses WHERE sub = ?",
      identity.subject,
    );
    for (const license of matches) {
      await linkLicense(
        db,
        accountId,
        license.product,
        license.id,
        "oidc",
        now,
      );
    }
  }
}

export async function listPortalLicenses(
  db: Db,
  accountId: string,
): Promise<PortalLicenseRow[]> {
  return db.all<PortalLicenseRow>(
    `SELECT l.*, p.name AS product_name, p.branding_json AS product_branding_json
       FROM portal_license_links link
       JOIN licenses l ON l.product = link.product AND l.id = link.license_id
       JOIN products p ON p.slug = l.product
      WHERE link.account_id = ?
        AND COALESCE(p.status, 'active') != 'deleted'
      ORDER BY p.name ASC, l.activated_at DESC, l.id DESC`,
    accountId,
  );
}

export async function getPortalLicense(
  db: Db,
  accountId: string,
  product: string,
  licenseId: string,
): Promise<PortalLicenseRow | null> {
  return db.first<PortalLicenseRow>(
    `SELECT l.*, p.name AS product_name, p.branding_json AS product_branding_json
       FROM portal_license_links link
       JOIN licenses l ON l.product = link.product AND l.id = link.license_id
       JOIN products p ON p.slug = l.product
      WHERE link.account_id = ? AND link.product = ? AND link.license_id = ?`,
    accountId,
    product,
    licenseId,
  );
}

export async function listVisibleKeys(
  db: Db,
  product: string,
  licenseId: string,
): Promise<KeyRow[]> {
  return db.all<KeyRow>(
    `SELECT product, key_hash, license_id, status, label, created_at, created_by, last_used_at
       FROM keys_index
      WHERE product = ? AND license_id = ?
      ORDER BY created_at DESC`,
    product,
    licenseId,
  );
}

export async function listVisibleDevices(
  db: Db,
  product: string,
  licenseId: string,
): Promise<DeviceRow[]> {
  return db.all<DeviceRow>(
    "SELECT * FROM devices WHERE product = ? AND license_id = ? ORDER BY last_seen DESC",
    product,
    licenseId,
  );
}

export async function getPortalProductSettings(
  db: Db,
  product: string,
): Promise<PortalProductSettingsRow> {
  const row = await db.first<PortalProductSettingsRow>(
    "SELECT * FROM portal_product_settings WHERE product = ?",
    product,
  );
  return (
    row ?? {
      product,
      portal_enabled: 1,
      oidc_enabled: 1,
      magic_enabled: 1,
      license_key_claim_enabled: 1,
      releases_enabled: 1,
      branding_json: null,
      created_at: 0,
      modified_at: 0,
    }
  );
}

export function portalProductSettingsView(
  row: PortalProductSettingsRow,
): PortalProductSettingsView {
  return {
    portalEnabled: row.portal_enabled === 1,
    oidcEnabled: row.oidc_enabled === 1,
    magicEnabled: row.magic_enabled === 1,
    licenseKeyClaimEnabled: row.license_key_claim_enabled === 1,
    releasesEnabled: row.releases_enabled === 1,
    branding: parseJsonUnknown(row.branding_json),
    modifiedAt: row.modified_at,
  };
}

export async function upsertPortalProductSettings(
  db: Db,
  product: string,
  patch: Partial<{
    portalEnabled: boolean;
    oidcEnabled: boolean;
    magicEnabled: boolean;
    licenseKeyClaimEnabled: boolean;
    releasesEnabled: boolean;
    branding: unknown;
  }>,
  now: number,
): Promise<PortalProductSettingsRow> {
  const current = await getPortalProductSettings(db, product);
  const next = {
    portal_enabled:
      patch.portalEnabled === undefined
        ? current.portal_enabled
        : patch.portalEnabled
          ? 1
          : 0,
    oidc_enabled:
      patch.oidcEnabled === undefined
        ? current.oidc_enabled
        : patch.oidcEnabled
          ? 1
          : 0,
    magic_enabled:
      patch.magicEnabled === undefined
        ? current.magic_enabled
        : patch.magicEnabled
          ? 1
          : 0,
    license_key_claim_enabled:
      patch.licenseKeyClaimEnabled === undefined
        ? current.license_key_claim_enabled
        : patch.licenseKeyClaimEnabled
          ? 1
          : 0,
    releases_enabled:
      patch.releasesEnabled === undefined
        ? current.releases_enabled
        : patch.releasesEnabled
          ? 1
          : 0,
    branding_json:
      patch.branding === undefined
        ? current.branding_json
        : patch.branding == null
          ? null
          : JSON.stringify(patch.branding),
  };
  await db.run(
    `INSERT INTO portal_product_settings
       (product, portal_enabled, oidc_enabled, magic_enabled,
        license_key_claim_enabled, releases_enabled, branding_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET
       portal_enabled = excluded.portal_enabled,
       oidc_enabled = excluded.oidc_enabled,
       magic_enabled = excluded.magic_enabled,
       license_key_claim_enabled = excluded.license_key_claim_enabled,
       releases_enabled = excluded.releases_enabled,
       branding_json = excluded.branding_json,
       modified_at = excluded.modified_at`,
    product,
    next.portal_enabled,
    next.oidc_enabled,
    next.magic_enabled,
    next.license_key_claim_enabled,
    next.releases_enabled,
    next.branding_json,
    current.created_at || now,
    now,
  );
  return getPortalProductSettings(db, product);
}

export async function portalAuthCapabilities(db: Db): Promise<{
  portalEnabled: boolean;
  oidcEnabled: boolean;
  magicEnabled: boolean;
  licenseKeyClaimEnabled: boolean;
  releasesEnabled: boolean;
}> {
  const row = await db.first<{
    portal_count: number;
    oidc_count: number;
    magic_count: number;
    claim_count: number;
    release_count: number;
  }>(
    `SELECT
       SUM(CASE WHEN COALESCE(s.portal_enabled, 1) = 1 THEN 1 ELSE 0 END) AS portal_count,
       SUM(CASE WHEN COALESCE(s.portal_enabled, 1) = 1
                 AND COALESCE(s.oidc_enabled, 1) = 1 THEN 1 ELSE 0 END) AS oidc_count,
       SUM(CASE WHEN COALESCE(s.portal_enabled, 1) = 1
                 AND COALESCE(s.magic_enabled, 1) = 1 THEN 1 ELSE 0 END) AS magic_count,
       SUM(CASE WHEN COALESCE(s.portal_enabled, 1) = 1
                 AND COALESCE(s.license_key_claim_enabled, 1) = 1 THEN 1 ELSE 0 END) AS claim_count,
       SUM(CASE WHEN COALESCE(s.portal_enabled, 1) = 1
                 AND COALESCE(s.releases_enabled, 1) = 1 THEN 1 ELSE 0 END) AS release_count
       FROM products p
       LEFT JOIN portal_product_settings s ON s.product = p.slug
      WHERE COALESCE(p.status, 'active') != 'deleted'`,
  );
  return {
    portalEnabled: Number(row?.portal_count ?? 0) > 0,
    oidcEnabled: Number(row?.oidc_count ?? 0) > 0,
    magicEnabled: Number(row?.magic_count ?? 0) > 0,
    licenseKeyClaimEnabled: Number(row?.claim_count ?? 0) > 0,
    releasesEnabled: Number(row?.release_count ?? 0) > 0,
  };
}

export async function listPortalReleases(
  db: Db,
  products: string[],
): Promise<PortalReleaseRow[]> {
  if (products.length === 0) return [];
  const placeholders = products.map(() => "?").join(", ");
  return db.all<PortalReleaseRow>(
    `SELECT r.*, p.name AS product_name
       FROM release_metadata r
       JOIN products p ON p.slug = r.product
      WHERE r.product IN (${placeholders})
      ORDER BY COALESCE(r.published_at, 0) DESC, r.version DESC`,
    ...products,
  );
}

export async function listPortalArtifacts(
  db: Db,
  product: string,
  releaseId: string,
): Promise<PortalArtifactRow[]> {
  return db.all<PortalArtifactRow>(
    `SELECT product, release_id, artifact_id, name, kind, platform, arch,
            content_type, size_bytes, sha256, source_url, access
       FROM release_artifacts
      WHERE product = ? AND release_id = ?
      ORDER BY kind ASC, platform ASC, arch ASC, name ASC`,
    product,
    releaseId,
  );
}

export async function getPortalArtifact(
  db: Db,
  product: string,
  releaseId: string,
  artifactId: string,
): Promise<PortalArtifactRow | null> {
  return db.first<PortalArtifactRow>(
    `SELECT product, release_id, artifact_id, name, kind, platform, arch,
            content_type, size_bytes, sha256, source_url, access
       FROM release_artifacts
      WHERE product = ? AND release_id = ? AND artifact_id = ?`,
    product,
    releaseId,
    artifactId,
  );
}

export async function createPortalDownloadToken(
  env: Env,
  db: Db,
  input: {
    accountId: string;
    product: string;
    releaseId: string;
    artifactId: string;
    now: number;
  },
): Promise<string> {
  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  await db.run(
    `INSERT INTO release_download_tokens
       (product, token_hash, release_id, artifact_id, customer_id, device_id,
        scope_json, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.product,
    tokenHash,
    input.releaseId,
    input.artifactId,
    null,
    null,
    JSON.stringify({ portalAccountId: input.accountId }),
    input.now + 300,
    null,
    input.now,
  );
  return token;
}

export async function getPortalDownloadToken(
  env: Env,
  db: Db,
  token: string,
): Promise<PortalDownloadTokenRow | null> {
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  return db.first<PortalDownloadTokenRow>(
    "SELECT * FROM release_download_tokens WHERE token_hash = ?",
    tokenHash,
  );
}

export async function markPortalDownloadUsed(
  db: Db,
  product: string,
  tokenHash: string,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE release_download_tokens SET used_at = ? WHERE product = ? AND token_hash = ?",
    now,
    product,
    tokenHash,
  );
}

export async function portalAudit(
  db: Db,
  input: {
    accountId?: string | null;
    action: string;
    product?: string | null;
    targetKind?: string | null;
    targetId?: string | null;
    summary?: string | null;
    now: number;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO portal_audit
       (id, account_id, at, action, product, target_kind, target_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomId("paud"),
    input.accountId ?? null,
    input.now,
    input.action,
    input.product ?? null,
    input.targetKind ?? null,
    input.targetId ?? null,
    input.summary ?? null,
  );
}

export async function listLinkedProducts(
  db: Db,
  accountId: string,
): Promise<ProductRow[]> {
  return db.all<ProductRow>(
    `SELECT DISTINCT p.*
       FROM portal_license_links link
       JOIN products p ON p.slug = link.product
      WHERE link.account_id = ?
        AND COALESCE(p.status, 'active') != 'deleted'
      ORDER BY p.name`,
    accountId,
  );
}
