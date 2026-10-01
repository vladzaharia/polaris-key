import {
  hashKey,
  mintOpaqueToken,
  randomId,
  type Db,
  type Env,
} from "../../../core/platform.js";
import type {
  DeviceRow,
  KeyRow,
  LicenseRow,
  ProductRow,
} from "../../../core/data.js";
import { parseServices } from "../../../core/services.js";

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
  /** R5-01/R5-02. NULL = derive from the product's OIDC provider (see AUTO_LINK_ENABLED_SQL). */
  auto_link_enabled: number | null;
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
  autoLinkEnabled: boolean | null;
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
  /** The deliverable the release belongs to (P2-03); delivery access is decided per deliverable. */
  deliverable_id: string;
  /** The channel it was published to; `null` = derived from GitHub (read as stable). */
  channel: string | null;
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

/**
 * Is implicit auto-linking allowed for the license's product?
 *
 * R5-01/R5-02. A product's `oidc_config.provider` is `'platform'` or `'custom'`; `'custom'`
 * means a TENANT-CONTROLLED issuer, whose `email` and `sub` claims the platform cannot vouch
 * for. `portal_product_settings.auto_link_enabled` is NULL by default and resolves to "on for
 * platform-issuer products, off for custom-issuer products", so a tenant that stands up its own
 * Keycloak/Authentik after this migration is opted out automatically rather than by an
 * operator remembering to. An explicit 1/0 is an operator override in either direction.
 */
const AUTO_LINK_ENABLED_SQL = `
  COALESCE(
    s.auto_link_enabled,
    CASE WHEN COALESCE(o.provider, 'platform') = 'custom' THEN 0 ELSE 1 END
  ) = 1`;

/**
 * Fold every license this account can prove it owns into `portal_license_links`.
 *
 * Cross-product visibility is intentional (one portal account, every product the person holds
 * a license for). What was NOT intentional was the join being a bare, unqualified equality on
 * a tenant-supplied string:
 *
 * - **R5-01** — `WHERE lower(email) = ?` with no product predicate and no verification
 *   requirement. Any tenant running its own IdP could assert `email: ceo@victim-corp.example`
 *   (product-side `mapClaims` does not check `email_verified`), and the victim's next portal
 *   request wrote the attacker's license — with attacker-controlled `name` and branding —
 *   into the victim's account, along with `hasLinkedProductLicense` for the attacker's product.
 *   R5 proved this is an INJECTION primitive, not an extraction one, so the fix belongs on the
 *   write side: only emails the PORTAL itself verified may drive a link, and only into products
 *   that opted into auto-linking.
 * - **R5-02** — `WHERE sub = ?` with no product AND no issuer qualifier, so subjects minted by
 *   N mutually-untrusted IdPs shared one flat namespace and `evilco` could mint a license with
 *   `sub = "1000"` to collide with a platform-IdP subject. The left side of this join is ALWAYS
 *   a platform-IdP subject (`portal/auth.ts` hardcodes `provider: "oidc"` with the issuer from
 *   `platformOidcConfig`), so the right side must be restricted to licenses whose product also
 *   authenticates against the platform issuer. That is the issuer qualifier, derived from
 *   `oidc_config` rather than from a new denormalised column the product-OIDC lane would have
 *   to populate.
 *
 * R11-08: both queries were also full `SCAN licenses` — across every tenant, twice per portal
 * request. `idx_licenses_email_lower` and `idx_licenses_sub_global` (0015) make them SEARCHes.
 */
export async function syncAccountLicenseLinks(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  // Only addresses the portal itself verified — a magic link it delivered, or an
  // `email_verified: true` claim from the PLATFORM IdP (portal/auth.ts:286).
  const emails = await db.all<{ email: string }>(
    "SELECT email FROM portal_account_emails WHERE account_id = ? AND verified_at > 0",
    accountId,
  );
  for (const row of emails) {
    const matches = await db.all<{ product: string; id: string }>(
      `SELECT l.product AS product, l.id AS id
         FROM licenses l
         LEFT JOIN portal_product_settings s ON s.product = l.product
         LEFT JOIN oidc_config o ON o.product = l.product
        WHERE lower(l.email) = ? AND ${AUTO_LINK_ENABLED_SQL}`,
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
      `SELECT l.product AS product, l.id AS id
         FROM licenses l
         LEFT JOIN portal_product_settings s ON s.product = l.product
         LEFT JOIN oidc_config o ON o.product = l.product
        WHERE l.sub = ?
          AND COALESCE(o.provider, 'platform') = 'platform'
          AND ${AUTO_LINK_ENABLED_SQL}`,
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
      auto_link_enabled: null,
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
    // null = "auto" (derived from the product's OIDC issuer). See AUTO_LINK_ENABLED_SQL.
    autoLinkEnabled:
      row.auto_link_enabled == null ? null : row.auto_link_enabled === 1,
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
    /** `null` restores "auto" (derived from the product's OIDC issuer) — R5-01/R5-02. */
    autoLinkEnabled: boolean | null;
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
    auto_link_enabled:
      patch.autoLinkEnabled === undefined
        ? current.auto_link_enabled
        : patch.autoLinkEnabled === null
          ? null
          : patch.autoLinkEnabled
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
        license_key_claim_enabled, releases_enabled, auto_link_enabled,
        branding_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET
       portal_enabled = excluded.portal_enabled,
       oidc_enabled = excluded.oidc_enabled,
       magic_enabled = excluded.magic_enabled,
       license_key_claim_enabled = excluded.license_key_claim_enabled,
       releases_enabled = excluded.releases_enabled,
       auto_link_enabled = excluded.auto_link_enabled,
       branding_json = excluded.branding_json,
       modified_at = excluded.modified_at`,
    product,
    next.portal_enabled,
    next.oidc_enabled,
    next.magic_enabled,
    next.license_key_claim_enabled,
    next.releases_enabled,
    next.auto_link_enabled,
    next.branding_json,
    current.created_at || now,
    now,
  );
  return getPortalProductSettings(db, product);
}

/**
 * Does this product actually run the Release service (spec §2.2)?
 *
 * One predicate for two callers — the capability answer below and the downloads listing in
 * `api.ts` — because the failure mode being closed here is precisely the two of them disagreeing:
 * a nav item that is hidden while the endpoint behind it still enumerates the same rows to
 * anyone who deep-links it. Two `parseServices(...).services.release.enabled` spellings would
 * read as the same rule and drift the first time only one of them is edited.
 *
 * The fail-safe direction is inherited from `parseServices`, and it is the one that matters here:
 * an absent or unreadable `services_json` lands on `DEFAULT_SERVICES`, where Release is OFF.
 * A product that has never said it distributes builds does not get a Downloads tab by accident.
 */
export function releaseServiceEnabled(
  servicesJson: string | null | undefined,
): boolean {
  return parseServices(servicesJson).services.release.enabled;
}

/**
 * Which auth methods and modules are available.
 *
 * R5-06 — this used to be an unconditional `SUM(...) > 0` across EVERY tenant, so one tenant
 * leaving magic-link on kept it enabled platform-wide for a tenant that had deliberately set
 * `magic_enabled = 0`, and the last tenant to disable a feature turned it off for everyone. It
 * is reached PRE-AUTHENTICATION, so the unauthenticated `/api/capabilities` response also
 * leaked whether *any* tenant had each feature on.
 *
 * Passing `product` evaluates the settings where they belong — on that one product's row, with
 * no cross-tenant term at all. Omitting it keeps the platform-wide aggregate, which is the
 * honest answer for the ONE surface that genuinely has no product context: the root portal
 * login page, where the visitor has not yet identified a product. That aggregate is now an
 * explicit, documented choice rather than an accident of a missing predicate, and every
 * product-scoped decision downstream still re-checks `getPortalProductSettings`.
 *
 * ── WHY THE FOLD LEFT SQL (task 7.2) ────────────────────────────────────────────────────────
 *
 * `releasesEnabled` used to be `portal_product_settings.releases_enabled` and nothing else, so a
 * product whose RELEASE SERVICE was off still advertised `modules.releases: true` and the portal
 * put a Downloads tab over an empty truth store. The two switches answer different questions —
 * the portal flag is "show this tenant's customers the tab", `products.services_json` is "this
 * product distributes builds at all" — and the second is the stronger one, because a product
 * that does not run Release has no `release_metadata` for the tab to render. `core/services.ts`
 * is the single enablement authority, so `modules.releases` becomes a projection of it rather
 * than a fifth opinion.
 *
 * `services_json` is a TEXT blob, which is exactly why this is no longer one aggregate query:
 * SQLite cannot ask whether `release.enabled` is true, so `SUM(CASE …)` had nowhere to put the
 * term. The statement therefore returns one row PER surviving product and the ANY/ALL decision
 * is made here, in TypeScript, where `parseServices` can run. The cost is a handful of small
 * JSON parses over the live product list, on a route that is already doing a database
 * round-trip and — in its unscoped form — is only reached by the root login page.
 *
 * The `COALESCE(s.x, 1)` defaults stay in SQL rather than moving into the fold: "no settings row
 * means enabled" is what every other portal read of this table assumes, and stating it once in
 * the projection keeps the code below a plain conjunction instead of a second place that has to
 * remember the default. `some` over the empty row set is `false`, which is the same answer the
 * old `SUM(...) > 0` gave for a deleted or unknown slug.
 */
export async function portalAuthCapabilities(
  db: Db,
  product?: string | null,
): Promise<{
  portalEnabled: boolean;
  oidcEnabled: boolean;
  magicEnabled: boolean;
  licenseKeyClaimEnabled: boolean;
  releasesEnabled: boolean;
}> {
  const rows = await db.all<{
    portal_enabled: number;
    oidc_enabled: number;
    magic_enabled: number;
    license_key_claim_enabled: number;
    releases_enabled: number;
    services_json: string | null;
  }>(
    `SELECT
       COALESCE(s.portal_enabled, 1) AS portal_enabled,
       COALESCE(s.oidc_enabled, 1) AS oidc_enabled,
       COALESCE(s.magic_enabled, 1) AS magic_enabled,
       COALESCE(s.license_key_claim_enabled, 1) AS license_key_claim_enabled,
       COALESCE(s.releases_enabled, 1) AS releases_enabled,
       p.services_json AS services_json
       FROM products p
       LEFT JOIN portal_product_settings s ON s.product = p.slug
      WHERE COALESCE(p.status, 'active') != 'deleted'
        AND (? IS NULL OR p.slug = ?)`,
    product ?? null,
    product ?? null,
  );
  // Every term is conjoined WITHIN a row before anything is aggregated ACROSS rows — the shape
  // the old `SUM(CASE WHEN portal AND x …)` had. Tenant A's portal being on must not license
  // tenant B's magic link, and with `product` set there is at most one row anyway, so the
  // cross-product reading only ever applies to the deliberate platform aggregate.
  const live = rows.filter((row) => row.portal_enabled === 1);
  return {
    portalEnabled: live.length > 0,
    oidcEnabled: live.some((row) => row.oidc_enabled === 1),
    magicEnabled: live.some((row) => row.magic_enabled === 1),
    licenseKeyClaimEnabled: live.some(
      (row) => row.license_key_claim_enabled === 1,
    ),
    releasesEnabled: live.some(
      (row) =>
        row.releases_enabled === 1 && releaseServiceEnabled(row.services_json),
    ),
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
        AND kind NOT IN ('signature', 'checksum')
      ORDER BY kind ASC, platform ASC, arch ASC, name ASC`,
    product,
    releaseId,
  );
}

/** The facts the delivery-access decision needs about one release, or `null` when it is gone. */
export async function getPortalReleaseFacts(
  db: Db,
  product: string,
  releaseId: string,
): Promise<Pick<
  PortalReleaseRow,
  "deliverable_id" | "version" | "channel"
> | null> {
  return db.first(
    `SELECT deliverable_id, version, channel FROM release_metadata
      WHERE product = ? AND release_id = ?`,
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
  const token = mintOpaqueToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  await db.run(
    // R11-13: `customer_id` went with the dead `customers` table (0016_drop_dead_pii) — it was
    // always written as a literal NULL and read nowhere.
    `INSERT INTO release_download_tokens
       (product, token_hash, release_id, artifact_id, device_id,
        scope_json, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.product,
    tokenHash,
    input.releaseId,
    input.artifactId,
    null,
    JSON.stringify({ portalAccountId: input.accountId }),
    input.now + 300,
    null,
    input.now,
  );
  return token;
}

/**
 * Resolve a `/download/<token>` bearer to its row.
 *
 * R5-10 / R11-12: the PRIMARY KEY is `(product, token_hash)`, so a bare `token_hash` predicate
 * was neither unique — two products could hold the same hash and `db.first` picked one
 * arbitrarily, which then became the authorization SCOPE for every downstream check — nor
 * indexed: R11-05 measured `SCAN release_download_tokens` on an unauthenticated, unrate-limited
 * endpoint backed by a table that only ever grew. This route has no product in its URL, so the
 * predicate cannot be product-scoped; `idx_release_download_tokens_hash` (0015) instead makes
 * the hash GLOBALLY unique, which is the real invariant (it is a 256-bit secret) and turns the
 * lookup into a single-row index SEARCH. The unexpired/unused predicates are pushed into SQL
 * so an expired or spent token is never even returned to the caller.
 */
export async function getPortalDownloadToken(
  env: Env,
  db: Db,
  token: string,
  now: number,
): Promise<PortalDownloadTokenRow | null> {
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  return db.first<PortalDownloadTokenRow>(
    `SELECT * FROM release_download_tokens
      WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL`,
    tokenHash,
    now,
  );
}

/**
 * Spend a single-use download token. Returns false when it was already spent.
 *
 * R9-05b / R11-05: the read at `portal/api.ts` and this UPDATE sat ~6 awaits apart with no
 * `used_at IS NULL` predicate, so two concurrent redemptions of the same token both read
 * `used_at = null`, both passed, and both got the redirect — "single-use" was advisory. The
 * predicate moves the decision into the statement: exactly one caller sees `changes === 1`.
 */
export async function markPortalDownloadUsed(
  db: Db,
  product: string,
  tokenHash: string,
  now: number,
): Promise<boolean> {
  const changes = await db.runChanges(
    `UPDATE release_download_tokens
        SET used_at = ?
      WHERE product = ? AND token_hash = ? AND used_at IS NULL`,
    now,
    product,
    tokenHash,
  );
  return changes > 0;
}

/**
 * R11-05 / R11-09 / R12-10 — retention for `release_download_tokens`.
 *
 * NOTHING deleted from this table: `grep "DELETE FROM"` over `src/` returned eight statements,
 * none against it, and the worker exports no `scheduled()` handler, so no cron could exist.
 * Every portal download-URL mint added a row with a 300-second TTL and infinite retention, and
 * `idx_release_download_tokens_expiry` existed with no consumer. Until a `scheduled()` handler
 * lands (see the Remediation section of R11-data.md), this is called opportunistically from the
 * download path itself — bounded work, on the one route that reads the table.
 */
export async function purgeExpiredDownloadTokens(
  db: Db,
  now: number,
  limit = 200,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM release_download_tokens
      WHERE rowid IN (
        SELECT rowid FROM release_download_tokens WHERE expires_at < ? LIMIT ?
      )`,
    now,
    limit,
  );
}

/**
 * Product-scoped retention for `release_download_tokens` — the `scheduled()` counterpart of the
 * opportunistic sweep above. Returns how many rows were removed.
 *
 * Two statements, not one `OR`, because they want different indexes. The expiry pass rides
 * `idx_release_download_tokens_expiry(product, expires_at)`; the spent pass is a short scan of
 * what the first pass left behind, which by construction is only this product's still-live
 * tokens (a 300-second TTL). Both are bounded by `limit`, so neither can turn into an unbounded
 * delete inside a single cron invocation.
 *
 * A spent token is deleted before it expires on purpose: `markPortalDownloadUsed` is the
 * single-use gate, so a row with `used_at` set can never authorize another download — retaining
 * it buys nothing and keeps a row naming an account, a product and an artifact.
 */
export async function purgeDownloadTokensForProduct(
  db: Db,
  product: string,
  now: number,
  limit = 500,
): Promise<number> {
  const expired = await db.runChanges(
    `DELETE FROM release_download_tokens
      WHERE rowid IN (
        SELECT rowid FROM release_download_tokens
         WHERE product = ? AND expires_at < ? LIMIT ?
      )`,
    product,
    now,
    limit,
  );
  const spent = await db.runChanges(
    `DELETE FROM release_download_tokens
      WHERE rowid IN (
        SELECT rowid FROM release_download_tokens
         WHERE product = ? AND used_at IS NOT NULL LIMIT ?
      )`,
    product,
    limit,
  );
  return expired + spent;
}

/**
 * Delete `portal_audit` rows older than `cutoff` for one product, or — when `product` is null —
 * for the platform-level rows that name no product at all.
 *
 * `portal_audit.product` is nullable by design (a magic-link sign-in belongs to no tenant), so a
 * purely per-product sweep would leave those rows growing forever. The null pass is therefore
 * not an edge case to tolerate but a required arm of the same job. `idx_portal_audit_product_at`
 * (0017) serves both: SQLite indexes NULLs, so `product IS NULL AND at < ?` is a SEARCH too.
 */
export async function prunePortalAudit(
  db: Db,
  product: string | null,
  cutoff: number,
  limit: number,
): Promise<number> {
  const predicate = product === null ? "product IS NULL" : "product = ?";
  const params = product === null ? [cutoff, limit] : [product, cutoff, limit];
  return db.runChanges(
    `DELETE FROM portal_audit
      WHERE rowid IN (
        SELECT rowid FROM portal_audit WHERE ${predicate} AND at < ? LIMIT ?
      )`,
    ...params,
  );
}

/**
 * Erase a portal account and everything that identifies the person behind it.
 *
 * R11-09 called right-to-erasure "structurally unimplementable", and the sharpest edge was that
 * `portal_account_emails.email` is the PRIMARY KEY: there is nowhere to record "this address was
 * erased" without re-storing the address, so erasure can only mean *deleting the row*. That is
 * what happens here, and it is the correct answer rather than a compromise — a tombstone keyed
 * on the address would retain exactly the datum the account holder asked to have removed.
 *
 * What survives is deliberately non-identifying:
 *
 * - `licenses` are the PRODUCT's records, not the portal account's. A portal account is a *view*
 *   onto licences that already existed; deleting it must unlink, not destroy a tenant's customer
 *   record. Per-product erasure is `deleteProduct`'s PII scrub, and a per-subject erase endpoint
 *   remains reported.
 * - one final `portal.account.delete` row in `portal_audit`, carrying the opaque `acct_…`
 *   surrogate and no email, name or product. The account row it pointed at is gone, so the id no
 *   longer resolves to a person; what remains is a dated receipt that an erasure happened, which
 *   is the one record an erasure must not delete.
 *
 * The three child deletes are also implied by `ON DELETE CASCADE` (0017). They are still issued
 * explicitly and FIRST, in one batch with the parent delete, so the erasure is atomic and does
 * not depend on `PRAGMA foreign_keys` being on in whichever engine is underneath.
 */
export async function deletePortalAccount(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  await db.batch([
    {
      sql: "DELETE FROM portal_account_emails WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_account_identities WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_license_links WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_audit WHERE account_id = ?",
      params: [accountId],
    },
    { sql: "DELETE FROM portal_accounts WHERE id = ?", params: [accountId] },
    {
      sql: `INSERT INTO portal_audit
              (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'portal.account.delete', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        accountId,
        now,
        accountId,
        "Portal account erased at the account holder's request",
      ],
    },
  ]);
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
