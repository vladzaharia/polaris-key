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
import {
  attachLicenseAccount,
  licenseAccountId,
  subjectFor,
} from "../../../core/accountSubjects.js";
import { catchUpLegacyAccount } from "../accounts/legacy.js";
import { deleteAccount } from "../accounts/deletion.js";
import { signIn, type SignInResult } from "../accounts/signIn.js";
import {
  EMAIL_ISSUER,
  getAccountRow,
  insertLink,
  resolveAccount,
  verifiedAccountEmails,
} from "../accounts/repo.js";

/** The account fields the portal reads (I-05: a row of `accounts`). */
export interface PortalAccountRow {
  id: string;
  status: string;
  display_name: string | null;
  primary_email: string | null;
  /** I-07: the chosen picture's R2 key (`card/avatars.ts`); absent on a legacy catch-up row. */
  avatar_key?: string | null;
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
  /** PX-W5 (G7): customers may replace their own license key from the portal. Opt-in, default 0. */
  key_reissue_enabled: number;
  /** PX-W5 / S-16: an email-carrying license may be claimed by key without that email. Default 0. */
  claim_by_key: number;
  /** PX-W10 (G24): the product may be offered on Discover. Default 1 (migrations/0071). */
  discover_enabled: number;
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
  keyReissueEnabled: boolean;
  claimByKey: boolean;
  discoverEnabled: boolean;
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
  /** The build the file belongs to, when a descriptor or artifact map tied it to one. */
  build_id?: string | null;
  /** That build's platform (null for a platform-independent build); listings only. */
  build_platform?: string | null;
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

/**
 * The portal's view of an account (I-05: `accounts`, which replaced `portal_accounts` and kept
 * its ids). With `now`, an account absorbed by a merge in the last 30 days resolves to the
 * survivor, so its signed cookie keeps working; an id the new tables do not know yet (an account
 * a pre-I-05 Worker created during the deploy window) is copied across first.
 */
export async function getPortalAccount(
  db: Db,
  id: string,
  now?: number,
): Promise<PortalAccountRow | null> {
  const found =
    now === undefined
      ? await getAccountRow(db, id)
      : await resolveAccount(db, id, now);
  if (found) return found;
  if (await catchUpLegacyAccount(db, id)) return getAccountRow(db, id);
  return null;
}

function signedInAccount(result: SignInResult): PortalAccountRow {
  if (result.status !== "signed_in") {
    throw new Error(`portal sign-in did not complete: ${result.status}`);
  }
  return result.account;
}

/**
 * The account an email sign-in (a delivered magic link) belongs to, created on first sign-in.
 * A thin wrapper over `signIn` for callers that hold an address the portal itself proved; it
 * throws on a join offer (an address another account uses only as its primary email), which the
 * magic-link handler answers itself.
 */
export async function getOrCreateAccountByEmail(
  db: Db,
  email: string,
  now: number,
  displayName?: string | null,
): Promise<PortalAccountRow> {
  return signedInAccount(
    await signIn(
      db,
      {
        issuerKey: EMAIL_ISSUER,
        subject: normalizeEmail(email),
        kind: "email",
        displayName: displayName ?? null,
      },
      now,
    ),
  );
}

/** The issuer-less key every portal identity carried before I-01 (migrations/0059). */
export const LEGACY_PORTAL_IDENTITY_PROVIDER = "oidc";

/**
 * The `provider` key for identities minted by `issuer`: the configured issuer without a trailing
 * slash, the same normalisation every issuer URL in the portal flow gets. An operator editing
 * `PLATFORM_OIDC_ISSUER` only by its trailing slash therefore keeps every identity attached.
 */
export function portalIdentityIssuerKey(issuer: string): string {
  return issuer.replace(/\/$/, "");
}

/**
 * Re-key pre-I-01 portal identities from the literal `"oidc"` to the platform issuer (S-16 G14,
 * migrations/0059). The portal table is what a Worker rolled back to before I-05 reads; the
 * account links the 0068 backfill copied from it are re-keyed by `rekeyLegacyAccountLinks`, which
 * the portal callback runs right after this. Both must run before the identity lookup, or a
 * legacy user would get a second account. Idempotent; once no legacy row is left it is a single
 * empty search. `OR IGNORE` leaves a legacy row in place if the issuer-keyed row already exists.
 */
export async function rekeyLegacyPortalIdentities(
  db: Db,
  issuer: string,
): Promise<void> {
  await db.run(
    `UPDATE OR IGNORE portal_account_identities SET provider = ? WHERE provider = ?`,
    issuer,
    LEGACY_PORTAL_IDENTITY_PROVIDER,
  );
}

/**
 * The account a platform-IdP sign-in belongs to: a thin wrapper over `signIn` (the portal
 * callback calls `signIn` itself). Throws on a join offer: an unknown identity whose verified
 * email another account already uses is never attached to it silently (owner, 2026-10-04).
 */
export async function getOrCreateAccountByIdentity(
  db: Db,
  input: {
    /** The issuer URL that minted `subject` (migrations/0059), never a provider kind. */
    provider: string;
    subject: string;
    /** Pass only an email the IdP marked verified. */
    email?: string | null;
    displayName?: string | null;
    /** The IdP's `groups` claim (PX-W10): what Discover evaluates a product's `groupRoleMap`
     *  against. Omitted = not asserted, stored as NULL ("not known"). */
    groups?: readonly string[];
  },
  now: number,
): Promise<PortalAccountRow> {
  const result = await signIn(
    db,
    {
      issuerKey: input.provider,
      subject: input.subject,
      kind: "oidc",
      email: input.email ?? null,
      emailVerified: Boolean(input.email),
      displayName: input.displayName ?? null,
    },
    now,
  );
  const account = signedInAccount(result);
  if (result.status === "signed_in")
    await recordLinkGroups(db, result.linkId, input.groups);
  return account;
}

/**
 * Store the `groups` claim the platform IdP asserted at this sign-in on the account link it
 * signed in through (PX-W10, migrations/0071). Absent claim = NULL ("not known", fail closed):
 * an account so marked sees no group offers until it next signs in, never a wrong one.
 */
export async function recordLinkGroups(
  db: Db,
  linkId: string,
  groups: readonly string[] | undefined,
): Promise<void> {
  await db.run(
    "UPDATE account_links SET groups_json = ? WHERE id = ?",
    groups ? JSON.stringify(groups) : null,
    linkId,
  );
}

/**
 * Add an address the caller has just proved to the account as a verified email sign-in method.
 * A trusted primitive (no step-up): the interactive path is `linkIdentity`. An address that is
 * already another account's method is left where it is (one link, one account).
 */
export async function linkEmail(
  db: Db,
  accountId: string,
  email: string,
  now: number,
): Promise<void> {
  const normalized = normalizeEmail(email);
  await insertLink(
    db,
    accountId,
    {
      issuerKey: EMAIL_ISSUER,
      tenantScope: "",
      subject: normalized,
      kind: "email",
      email: normalized,
      emailVerified: true,
      displayName: null,
      amr: null,
    },
    now,
  );
  await db.run(
    `UPDATE accounts
        SET primary_email = COALESCE(primary_email, ?),
            primary_email_verified_at = CASE WHEN primary_email IS NULL OR primary_email = ?
              THEN COALESCE(primary_email_verified_at, ?) ELSE primary_email_verified_at END,
            display_name = COALESCE(display_name, ?),
            modified_at = ?
      WHERE id = ?`,
    normalized,
    normalized,
    now,
    normalized,
    now,
    accountId,
  );
}

/**
 * Attach a FLOATING licence to the account (first attach only; I-05's owner pointer). A licence
 * another account owns is left alone: an owned licence never moves this way. Creates the
 * (account, product) pairwise subject. `source` is kept for the call sites' readability.
 */
export async function linkLicense(
  db: Db,
  accountId: string,
  product: string,
  licenseId: string,
  _source: "email" | "oidc" | "license-key" | "admin",
  now: number,
): Promise<void> {
  await attachLicenseAccount(db, product, licenseId, accountId, now);
  if ((await licenseAccountId(db, product, licenseId)) === accountId) {
    await subjectFor(db, accountId, product, now);
  }
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
 * Every address the account verified (a delivered magic link, a platform IdP's
 * `email_verified: true` claim, a verified primary email). Security notices go to all of them
 * (PORTAL.md §6.3).
 */
export async function listVerifiedAccountEmails(
  db: Db,
  accountId: string,
): Promise<string[]> {
  return verifiedAccountEmails(db, accountId);
}

/**
 * Attach every FLOATING licence this account can prove it owns (I-05: the owner pointer replaced
 * `portal_license_links`). An owned licence is never touched, whoever owns it.
 *
 * Cross-product visibility is intentional (one account, every product the person holds a licence
 * for). What was NOT intentional was the join being a bare, unqualified equality on a
 * tenant-supplied string:
 *
 * - **R5-01** — `WHERE lower(email) = ?` with no product predicate and no verification
 *   requirement. Any tenant running its own IdP could assert `email: ceo@victim-corp.example`,
 *   and the victim's next portal request wrote the attacker's license into the victim's account.
 *   The fix belongs on the write side: only emails the PORTAL itself verified may drive an
 *   attach, and only into products that opted into auto-linking.
 * - **R5-02** — `WHERE sub = ?` with no product AND no issuer qualifier, so subjects minted by
 *   N mutually-untrusted IdPs shared one flat namespace. The left side of this join is ALWAYS a
 *   platform-IdP subject (the account's `oidc` links, keyed by the platform issuer), so the right
 *   side is restricted to licences whose product also authenticates against the platform issuer.
 *   A licence's `sub` therefore joins an account only through an existing link (plans/I-04.md
 *   §6.1); legacy `sub`-only licences of custom-issuer products stay floating (§8 Q6).
 *
 * R11-08: both queries are index SEARCHes (`idx_licenses_email_lower`, `idx_licenses_sub_global`).
 */
export async function syncAccountLicenseLinks(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  const matches: Array<{ product: string; id: string }> = [];
  for (const email of await verifiedAccountEmails(db, accountId)) {
    matches.push(
      ...(await db.all<{ product: string; id: string }>(
        `SELECT l.product AS product, l.id AS id
           FROM licenses l
           LEFT JOIN portal_product_settings s ON s.product = l.product
           LEFT JOIN oidc_config o ON o.product = l.product
          WHERE lower(l.email) = ? AND l.account_id IS NULL AND ${AUTO_LINK_ENABLED_SQL}`,
        email,
      )),
    );
  }
  const subjects = await db.all<{ subject: string }>(
    "SELECT subject FROM account_links WHERE account_id = ? AND kind = 'oidc'",
    accountId,
  );
  for (const link of subjects) {
    matches.push(
      ...(await db.all<{ product: string; id: string }>(
        `SELECT l.product AS product, l.id AS id
           FROM licenses l
           LEFT JOIN portal_product_settings s ON s.product = l.product
           LEFT JOIN oidc_config o ON o.product = l.product
          WHERE l.sub = ? AND l.account_id IS NULL
            AND COALESCE(o.provider, 'platform') = 'platform'
            AND ${AUTO_LINK_ENABLED_SQL}`,
        link.subject,
      )),
    );
  }
  for (const license of matches) {
    await linkLicense(db, accountId, license.product, license.id, "email", now);
  }
}

export async function listPortalLicenses(
  db: Db,
  accountId: string,
): Promise<PortalLicenseRow[]> {
  return db.all<PortalLicenseRow>(
    `SELECT l.*, p.name AS product_name, p.branding_json AS product_branding_json
       FROM licenses l
       JOIN products p ON p.slug = l.product
      WHERE l.account_id = ?
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
       FROM licenses l
       JOIN products p ON p.slug = l.product
      WHERE l.account_id = ? AND l.product = ? AND l.id = ?`,
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
      // Both PX-W5 switches default OFF, exactly as the migration's column defaults do.
      key_reissue_enabled: 0,
      claim_by_key: 0,
      // Discover defaults ON, as the migration's column default does (migrations/0071).
      discover_enabled: 1,
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
    keyReissueEnabled: row.key_reissue_enabled === 1,
    claimByKey: row.claim_by_key === 1,
    discoverEnabled: row.discover_enabled === 1,
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
    keyReissueEnabled: boolean;
    claimByKey: boolean;
    discoverEnabled: boolean;
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
    key_reissue_enabled:
      patch.keyReissueEnabled === undefined
        ? current.key_reissue_enabled
        : patch.keyReissueEnabled
          ? 1
          : 0,
    claim_by_key:
      patch.claimByKey === undefined
        ? current.claim_by_key
        : patch.claimByKey
          ? 1
          : 0,
    discover_enabled:
      patch.discoverEnabled === undefined
        ? current.discover_enabled
        : patch.discoverEnabled
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
        key_reissue_enabled, claim_by_key, discover_enabled, branding_json, created_at,
        modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET
       portal_enabled = excluded.portal_enabled,
       oidc_enabled = excluded.oidc_enabled,
       magic_enabled = excluded.magic_enabled,
       license_key_claim_enabled = excluded.license_key_claim_enabled,
       releases_enabled = excluded.releases_enabled,
       auto_link_enabled = excluded.auto_link_enabled,
       key_reissue_enabled = excluded.key_reissue_enabled,
       claim_by_key = excluded.claim_by_key,
       discover_enabled = excluded.discover_enabled,
       branding_json = excluded.branding_json,
       modified_at = excluded.modified_at`,
    product,
    next.portal_enabled,
    next.oidc_enabled,
    next.magic_enabled,
    next.license_key_claim_enabled,
    next.releases_enabled,
    next.auto_link_enabled,
    next.key_reissue_enabled,
    next.claim_by_key,
    next.discover_enabled,
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

/**
 * The releases the customer portal lists: the `app` deliverable's only. A pack release (P4-02)
 * and its content objects are game content a client fetches through its pin, never a download
 * a customer picks from the portal.
 */
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
        AND r.deliverable_id = 'app'
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
    // `build_platform` is the platform of the build the file belongs to, for the read-time
    // label inference in `api.ts` (a file with no platform of its own takes its build's).
    `SELECT a.product, a.release_id, a.artifact_id, a.name, a.kind, a.platform, a.arch,
            a.content_type, a.size_bytes, a.sha256, a.source_url, a.access,
            a.build_id, b.platform AS build_platform
       FROM release_artifacts a
       LEFT JOIN release_builds b
         ON b.product = a.product AND b.release_id = a.release_id
        AND b.build_id = a.build_id
      WHERE a.product = ? AND a.release_id = ?
        AND a.kind NOT IN ('signature', 'checksum')
      ORDER BY a.kind ASC, a.platform ASC, a.arch ASC, a.name ASC`,
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
 * lands (see the Remediation section of the R11 audit findings), this is called opportunistically from the
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
 * Erase an account and everything that identifies the person behind it (R11-09; I-05 moved the
 * work to `deleteAccount` in `accounts/deletion.ts`, which also runs the registered stores'
 * deletion hooks, clears every device binding, detaches the licences and emits `subject.deleted`).
 *
 * `licenses` are the PRODUCT's records, not the account's: deleting the account detaches them
 * (they become floating) and never destroys a tenant's customer record. What survives is
 * deliberately non-identifying: an id-only tombstone, and one final `portal.account.delete` row in
 * `portal_audit` carrying the opaque `acct_…` surrogate and no email, name or product.
 */
export async function deletePortalAccount(
  db: Db,
  accountId: string,
  now: number,
  env: Env,
  origin = "",
): Promise<void> {
  await deleteAccount({ db, env, now, origin }, accountId);
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
       FROM licenses l
       JOIN products p ON p.slug = l.product
      WHERE l.account_id = ?
        AND COALESCE(p.status, 'active') != 'deleted'
      ORDER BY p.name`,
    accountId,
  );
}

/**
 * Is this licence owned by an account OTHER than `accountId`? (The S-16 claim rule "an owned
 * licence never moves by its key".) Answers a boolean and nothing else: the activate preview may
 * say THAT a licence is held elsewhere, never by whom.
 */
export async function licenseLinkedElsewhere(
  db: Db,
  accountId: string,
  product: string,
  licenseId: string,
): Promise<boolean> {
  const owner = await licenseAccountId(db, product, licenseId);
  return owner !== null && owner !== accountId;
}

/** Has this account verified `email` (a magic link the portal delivered, or a verified IdP claim)? */
export async function accountHasVerifiedEmail(
  db: Db,
  accountId: string,
  email: string,
): Promise<boolean> {
  return (await verifiedAccountEmails(db, accountId)).includes(
    normalizeEmail(email),
  );
}

/** The account's identity at the platform IdP, as its last portal sign-in recorded it (PX-W10). */
export interface PortalPlatformIdentity {
  subject: string;
  email: string | null;
  displayName: string | null;
  /** `null` = not known (a row from before migrations/0071, or an IdP that sent no claim). */
  groups: string[] | null;
}

/**
 * The account's platform-IdP identity: the subject a `provider: platform` product's own sign-in
 * would carry for the same person (Pocket ID issues public subjects, notes/S-16 §3.1), so the
 * subject first-load auto-issue keys a licence by. When an account holds more than one subject at
 * that issuer (two IdP users merged by a verified email), the most recently used one wins.
 */
export async function getPlatformIdentity(
  db: Db,
  accountId: string,
  issuerKey: string,
): Promise<PortalPlatformIdentity | null> {
  const row = await db.first<{
    subject: string;
    email: string | null;
    display_name: string | null;
    groups_json: string | null;
  }>(
    `SELECT subject, CASE WHEN email_verified = 1 THEN email END AS email, display_name,
            groups_json
       FROM account_links
      WHERE account_id = ? AND issuer_key = ? AND tenant_scope = '' AND kind = 'oidc'
      ORDER BY last_used_at DESC, subject ASC
      LIMIT 1`,
    accountId,
    issuerKey,
  );
  if (!row) return null;
  const parsed = parseJsonUnknown(row.groups_json);
  return {
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    // A stored value that is not a string array grants nothing (fail closed), like a malformed map.
    groups: Array.isArray(parsed)
      ? parsed.filter((g): g is string => typeof g === "string")
      : null,
  };
}

/**
 * The products Discover may consider for any account (PX-W10, G24), before the policy runs: live,
 * portal on, Discover on, and authenticating against the PLATFORM issuer with auto-linking on.
 * The last two are exactly `syncAccountLicenseLinks`'s subject predicates, for the same reasons
 * (R5-01/R5-02): a licence keyed by the account's platform subject is only meaningful, and is only
 * linked back into this account, on a product whose own sign-in uses that issuer.
 */
export async function listDiscoverCandidates(
  db: Db,
  /** Answer for this one product only (the claim's re-evaluation). */
  only?: string,
): Promise<string[]> {
  const rows = await db.all<{ slug: string }>(
    `SELECT p.slug AS slug
       FROM products p
       LEFT JOIN portal_product_settings s ON s.product = p.slug
       LEFT JOIN oidc_config o ON o.product = p.slug
      WHERE COALESCE(p.status, 'active') = 'active'
        AND COALESCE(s.portal_enabled, 1) = 1
        AND COALESCE(s.discover_enabled, 1) = 1
        AND COALESCE(o.provider, 'platform') = 'platform'
        AND ${AUTO_LINK_ENABLED_SQL}
        AND (? IS NULL OR p.slug = ?)
      ORDER BY p.name ASC, p.slug ASC`,
    only ?? null,
    only ?? null,
  );
  return rows.map((r) => r.slug);
}

/** Does the account already hold any licence for this product (linked by any route)? */
export async function accountHoldsProduct(
  db: Db,
  accountId: string,
  product: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM licenses
      WHERE account_id = ? AND product = ? LIMIT 1`,
    accountId,
    product,
  );
  return row !== null;
}

/**
 * Record that Discover added `licenseId` to the account (PX-W10, G25: audit `source: discover`),
 * reporting whether THIS call recorded it. The row id is derived from the licence, so of two
 * racing claims for one account and product exactly one inserts it and sees `true`; the other
 * answers the same licence as already added. A double submit therefore audits once, whatever the
 * per-request link sweep did in between.
 */
export async function recordDiscoverClaim(
  db: Db,
  input: {
    accountId: string;
    product: string;
    licenseId: string;
    summary: string;
    now: number;
  },
): Promise<boolean> {
  const changes = await db.runChanges(
    `INSERT INTO portal_audit
       (id, account_id, at, action, product, target_kind, target_id, summary)
     VALUES (?, ?, ?, 'portal.discover.claim', ?, 'license', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    `paud_discover_${input.product}_${input.licenseId}`,
    input.accountId,
    input.now,
    input.product,
    input.licenseId,
    input.summary,
  );
  return changes > 0;
}
