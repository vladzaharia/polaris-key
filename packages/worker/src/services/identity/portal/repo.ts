import { adminOidcConfig } from "../../../platform/platformOidc.js";
import { isConsoleIdpIssuer } from "../../../core/rbac/operatorIssuer.js";
import { portalAudit } from "../../../core/accounts/portalAudit.js";
import { normalizeEmail } from "../../../platform/email.js";
import { parseJsonColumn } from "../../../platform/json.js";
import { publicBranding } from "./branding.js";
import type { Db, DbParam, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type {
  DeviceRow,
  KeyRow,
  LicenseRow,
  ProductRow,
} from "../../../core/repo.js";
import { parseServices } from "../../../core/services.js";
import {
  portalEnabledSql,
  readPortalToggles,
} from "../../../core/portalToggles.js";
import {
  resolveListing,
  type GroupLabels,
  type ListingAudience,
  type ListingState,
  type ObtainPathKind,
} from "../../../core/storefront/polarisKeyListing.js";
import {
  attachLicenseAccount,
  licenseAccountId,
  subjectFor,
} from "../../../core/accounts/accountSubjects.js";
import {
  notAutoAttachBlockedSql,
  type JoinedLicense,
} from "../../../core/licensing/licenseHolders.js";
import { deleteAccount, type ErasureResult } from "../accounts/deletion.js";
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
  /** I-07, PX-W16: the picture in use, an asset id (`card/avatars.ts`); absent on a legacy
   *  catch-up row. */
  avatar_key?: string | null;
  created_at: number;
  modified_at: number;
}

export interface PortalProductSettingsRow {
  product: string;
  portal_enabled: number;
  /** PX-W5 (G7): customers may replace their own license key from the portal. Opt-in, default 0. */
  key_reissue_enabled: number;
  /** PX-W5 / S-16: an email-carrying license may be claimed by key without that email. Default 0. */
  claim_by_key: number;
  /** PX-W10 (G24): the product may be offered on Discover. Default 1 (migrations/0071). */
  discover_enabled: number;
  /** PS-02: the Polaris Key listing state (migrations/0085). Read through `resolveListing`. */
  store_listed: ListingState;
  store_audience: ListingAudience;
  /** A JSON array of obtain-path kinds; NULL = every kind. */
  store_offer_paths_json: string | null;
  /** A JSON object `{<group>: <label>}`; NULL = no labels. */
  store_group_labels_json: string | null;
  branding_json: string | null;
  created_at: number;
  modified_at: number;
}

export interface PortalProductSettingsView {
  portalEnabled: boolean;
  keyReissueEnabled: boolean;
  claimByKey: boolean;
  discoverEnabled: boolean;
  /** PS-02: the effective listing state (`discoverEnabled: false` reads `unlisted`). */
  storeListed: ListingState;
  storeAudience: ListingAudience;
  /** `null` = every obtain-path kind. */
  storeOfferPaths: readonly ObtainPathKind[] | null;
  storeGroupLabels: GroupLabels;
  branding: unknown;
  modifiedAt: number;
}

export interface PortalLicenseRow extends LicenseRow {
  product_name: string;
  product_branding_json: string | null;
}

/**
 * The portal's view of an account (I-05: `accounts`, which replaced `portal_accounts` and kept
 * its ids). With `now`, an account absorbed by a merge in the last 30 days resolves to the
 * survivor, so its signed cookie keeps working; an id the account tables do not know reads as
 * signed out (I-28: the portal catch-up is gone).
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
  return found;
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
 * magic-link handler answers itself. No request reaches it: it signs in `unfenced` (no erasure
 * ledger is read), so it is for fixtures that build accounts, never for a route.
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
      { unfenced: true },
    ),
  );
}

/**
 * The `provider` key for identities minted by `issuer`: the configured issuer without a trailing
 * slash, the same normalisation every issuer URL in the portal flow gets. An operator editing
 * `PLATFORM_OIDC_ISSUER` only by its trailing slash therefore keeps every identity attached.
 */
export function portalIdentityIssuerKey(issuer: string): string {
  return issuer.replace(/\/$/, "");
}

/**
 * The account a platform-IdP sign-in belongs to: a thin wrapper over `signIn` (the portal
 * callback calls `signIn` itself). Throws on a join offer: an unknown identity whose verified
 * email another account already uses is never attached to it silently (owner, 2026-10-04). Like
 * {@link getOrCreateAccountByEmail} it signs in `unfenced`: for fixtures, never for a route.
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
    { unfenced: true },
  );
  const account = signedInAccount(result);
  if (result.status === "signed_in")
    await recordLinkGroups(db, result.linkId, input.groups, now);
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
  now: number,
  /**
   * The connection that asserted them (`console-idp` for the console's own sign-in); null for a
   * caller with no connection, whose facts no access rule reads. Claims are replaced with the
   * groups, in the same statement: a path that has no claim map writes none, so a claim the IdP
   * dropped cannot outlive the sign-in that dropped it (ST-32.3).
   */
  connectionId: string | null = null,
): Promise<void> {
  // `asserted_at` (ST-30, ST-28 §2.4) moves in THIS statement and nowhere else: it is when the IdP
  // last asserted these groups, so a sign-in that does not rewrite them cannot freshen them.
  await db.run(
    "UPDATE account_links SET groups_json = ?, claims_json = NULL, asserted_at = ?, asserted_connection_id = ? WHERE id = ?",
    groups ? JSON.stringify(groups) : null,
    groups ? now : null,
    connectionId,
    linkId,
  );
}

/**
 * What a connection asserted at this sign-in, on the link it signed in through (I-30; plans/I-27.md
 * §2.3 "Links"): the mapped groups and the access-rule claims, replaced together in ONE `UPDATE`.
 * `null` is "not asserted" (fail closed). `asserted_at` (ST-30) is written in this same statement, always;
 * nothing else writes these columns for a connection link.
 *
 * A link is keyed by (issuer, subject), not by the connection that wrote it. On the console IdP's
 * own issuer the console's root rule reads `groups_json` and `asserted_at`, so ONLY the console
 * sign-in (`recordLinkGroups`, the IdP's own groups claim) may write them there: a connection's
 * claim map is operator-editable and may name any claim. On such a link this writes nothing: the
 * console's access rules read the claims there too. Elsewhere the facts
 * carry the asserting connection's id, and a rule reads them only for that connection.
 */
export async function recordLinkAssertion(
  env: Env,
  db: Db,
  linkId: string,
  assertion: {
    groups: readonly string[] | null;
    claims: Readonly<Record<string, string>> | null;
    /** The asserting connection's id: the only connection whose rules read these facts. */
    connectionId: string;
  },
  now: number,
): Promise<void> {
  const link = await db.first<{ issuer_key: string }>(
    "SELECT issuer_key FROM account_links WHERE id = ?",
    linkId,
  );
  if (!link) return;
  // The console's root rule reads the groups and `asserted_at` of the link on the console IdP's own
  // issuer, whichever connection wrote them, so on that link only the console sign-in
  // (`recordLinkGroups`) writes the groups, `asserted_at` and the connection id: a connection's
  // assertion there writes nothing. On any other issuer the root rule reads nothing, and
  // the facts are bound to the asserting connection by `asserted_connection_id` (ST-32.3), which
  // is how an operator connection on a listed host gets its own groups and claims read.
  const consoleIssuer = adminOidcConfig(env)?.issuer;
  if (
    isConsoleIdpIssuer(env, link.issuer_key) ||
    (consoleIssuer !== undefined &&
      link.issuer_key === portalIdentityIssuerKey(consoleIssuer))
  ) {
    // Nor the claims: the `console-idp` access rules read `claims_json` on this link (ST-32.3),
    // and `asserted_connection_id` still names the console sign-in, so another connection's
    // claims written here would be read as the console's. That connection's own rules never read
    // this link (its id is not the asserting one), so it loses nothing.
    return;
  }
  // `asserted_at` and the connection id are set at every sign-in through a connection, even one
  // that maps nothing, so a `domain` rule works on an IdP with no groups or claims mapped (ST-32.3).
  await db.run(
    "UPDATE account_links SET groups_json = ?, claims_json = ?, asserted_at = ?, asserted_connection_id = ? WHERE id = ?",
    assertion.groups ? JSON.stringify(assertion.groups) : null,
    assertion.claims ? JSON.stringify(assertion.claims) : null,
    now,
    assertion.connectionId,
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
 * for. The rule is "on for platform-issuer products, off for custom-issuer products", so a
 * tenant that stands up its own Keycloak/Authentik is opted out automatically rather than by an
 * operator remembering to. I-29 retired the per-product override: the issuer is the whole decision.
 *
 * This is the PRODUCT-level rule, for the callers with no licence in hand (`autoLinkEnabled`,
 * the storefront's eligibility): it reads the provider as it stands now.
 */
const AUTO_LINK_ENABLED_SQL = `
  (CASE WHEN COALESCE(o.provider, 'platform') = 'custom' THEN 0 ELSE 1 END) = 1`;

/**
 * The LICENCE-level rule: the derived default underneath the operator override is a write-time
 * fact about the row. It used to read the product's provider as it stands at the moment of the
 * query, so the containment was reversible by editing the product: mint licences for a victim's
 * address under your own `custom` issuer, push a `.pkey/product` that lowers `oidc.provider`
 * from `custom` to `platform`, and every one of those rows became auto-linkable RETROACTIVELY,
 * permanently, with no self-service removal. `licenses.email_issuer_class` (0118) records the
 * provider that was resolved when the address was written, so a later manifest push cannot
 * re-decide it. `l` is a licence row (or anything with that column).
 *
 * The fallback to `o.provider` is not a hole, it is the earlier rule kept for the rows that
 * genuinely have no issuer: an admin-created or enrolled licence carries an operator-entered
 * address that no IdP asserted, and those rows keep behaving exactly as they did. There is
 * no operator override (I-29).
 */
const LICENSE_ISSUER_CLASS_SQL = `COALESCE(l.email_issuer_class, COALESCE(o.provider, 'platform'))`;

const LICENSE_AUTO_LINK_ENABLED_SQL = `
  (CASE WHEN ${LICENSE_ISSUER_CLASS_SQL} = 'custom' THEN 0 ELSE 1 END) = 1`;

/**
 * Whether implicit auto-linking resolves ON for `product`: `AUTO_LINK_ENABLED_SQL` for one
 * product, so a caller outside the link sweep (the legacy sign-in's licence chooser, I-26)
 * applies the identical rule rather than a copy of it.
 */
export async function autoLinkEnabled(
  db: Db,
  product: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one
       FROM (SELECT ? AS product) l
       LEFT JOIN portal_product_settings s ON s.product = l.product
       LEFT JOIN oidc_config o ON o.product = l.product
      WHERE ${AUTO_LINK_ENABLED_SQL}`,
    product,
  );
  return row !== null;
}

/**
 * `autoLinkEnabled` for one LICENCE: the same rule with the issuer class recorded on the licence
 * (`email_issuer_class`) in place of the product's live provider, so the answer for a licence
 * minted under a tenant's own issuer does not change when the product's provider is edited. A
 * licence with no recorded class (an admin-created or enrolled one) reads the live provider.
 */
export async function licenseAutoLinkEnabled(
  db: Db,
  license: Pick<LicenseRow, "product" | "email_issuer_class">,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one
       FROM (SELECT ? AS product, ? AS email_issuer_class) l
       LEFT JOIN portal_product_settings s ON s.product = l.product
       LEFT JOIN oidc_config o ON o.product = l.product
      WHERE ${LICENSE_AUTO_LINK_ENABLED_SQL}`,
    license.product,
    license.email_issuer_class ?? null,
  );
  return row !== null;
}

/**
 * PS-06: may the storefront's identity paths (`group`, `auto_issue`) run on `product` at all? The
 * candidate query's `identity_eligible` (`listStorefrontCandidates`) for one product, whatever its
 * listing: the platform issuer with auto-linking on (R5-01/R5-02).
 */
export async function storefrontIdentityEligible(
  db: Db,
  product: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one
       FROM (SELECT ? AS product) l
       LEFT JOIN portal_product_settings s ON s.product = l.product
       LEFT JOIN oidc_config o ON o.product = l.product
      WHERE COALESCE(o.provider, 'platform') = 'platform'
        AND ${AUTO_LINK_ENABLED_SQL}`,
    product,
  );
  return row !== null;
}

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

/** How an automatic attach found its licence: the account verified its email, or its `sub`. */
export type AutoAttachVia = "email" | "oidc";

/**
 * The `account.license.attach` row every attach writes (S-24 §7.4), automatic or not:
 * `Attached a license (<via>)`. `attachLicense` (`accounts/claim.ts`) writes it for a key, device
 * or creation-time attach, and the sweep below for an email or OIDC-subject match.
 */
export async function auditLicenseAttach(
  db: Db,
  input: {
    accountId: string;
    product: string;
    licenseId: string;
    via: string;
    now: number;
  },
): Promise<void> {
  await portalAudit(db, {
    accountId: input.accountId,
    action: "account.license.attach",
    product: input.product,
    targetKind: "license",
    targetId: input.licenseId,
    summary: `Attached a license (${input.via})`,
    now: input.now,
  });
}

/** One automatic attach: conditional on the licence still being unattached, then audited. */
async function attachAutomatically(
  db: Db,
  accountId: string,
  licence: { product: string; id: string },
  via: AutoAttachVia,
  now: number,
): Promise<boolean> {
  if (
    !(await attachLicenseAccount(
      db,
      licence.product,
      licence.id,
      accountId,
      now,
    ))
  )
    return false;
  await subjectFor(db, accountId, licence.product, now);
  await auditLicenseAttach(db, {
    accountId,
    product: licence.product,
    licenseId: licence.id,
    via,
    now,
  });
  return true;
}

/**
 * The email half of the sweep for ONE address the account has verified (the body of Core's
 * `onAccountEmailVerified` hook, registered by `accounts/holders.ts`). Attaches every licence that
 * names `email`, is in no account, whose auto-link resolves on for the issuer class recorded on
 * the licence, and is not blocked for this account (a licence removed from the library stays out).
 * The caller guarantees the address is verified on the account. Answers how many joined.
 *
 * The `idx_licenses_email_lower` index serves this query.
 */
export async function attachWaitingLicensesByEmail(
  db: Db,
  accountId: string,
  email: string,
  now: number,
): Promise<number> {
  return (await attachWaitingLicensesByEmailRows(db, accountId, email, now))
    .length;
}

/** `attachWaitingLicensesByEmail`, answering the licences that joined (LX-27c.3). */
export async function attachWaitingLicensesByEmailRows(
  db: Db,
  accountId: string,
  email: string,
  now: number,
): Promise<JoinedLicense[]> {
  const address = normalizeEmail(email);
  if (!address) return [];
  const rows = await db.all<{
    product: string;
    id: string;
    invited_at: number | null;
    status: string;
    expires_at: number | null;
  }>(
    `SELECT l.product AS product, l.id AS id, l.invited_at AS invited_at,
            l.status AS status, l.expires_at AS expires_at
       FROM licenses l
       LEFT JOIN portal_product_settings s ON s.product = l.product
       LEFT JOIN oidc_config o ON o.product = l.product
      WHERE lower(l.email) = ? AND l.account_id IS NULL AND ${LICENSE_AUTO_LINK_ENABLED_SQL}
        AND ${notAutoAttachBlockedSql("l")}`,
    address,
    accountId,
  );
  const joined: JoinedLicense[] = [];
  for (const licence of rows) {
    if (await attachAutomatically(db, accountId, licence, "email", now))
      joined.push({
        product: licence.product,
        id: licence.id,
        invitedAt: licence.invited_at ?? null,
        active:
          licence.status === "active" &&
          (licence.expires_at === null || licence.expires_at > now),
      });
  }
  return joined;
}

/**
 * Attach every licence this account can prove it owns and that is in no account (I-05: the owner
 * pointer replaced `portal_license_links`). An owned licence is never touched, whoever owns it,
 * and a licence the account removed from its library is never attached again automatically
 * (LX-26, S-24 D19: `license_auto_attach_blocks`; the key still adds it back).
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
 *   side is restricted to licences whose product also authenticates against the platform issuer
 *   and that the platform issuer minted (`email_issuer_class`, so a licence a tenant minted under
 *   its own issuer does not join once the product is edited to the platform one).
 *   A licence's `sub` therefore joins an account only through an existing link (plans/I-04.md
 *   §6.1); legacy `sub`-only licences of custom-issuer products stay floating (§8 Q6).
 *
 * The email half is the account-email hook's body (`attachWaitingLicensesByEmail`), run for every
 * address the account verified; every attach is audited (`account.license.attach`).
 *
 * R11-08: both queries are index SEARCHes (`idx_licenses_email_lower`, `idx_licenses_sub_global`).
 */
export async function syncAccountLicenseLinks(
  db: Db,
  accountId: string,
  now: number,
  /** LX-27c.3: told which licences joined by address (and that address), for the library notice. */
  onJoined?: (joined: JoinedLicense[], email: string) => Promise<void>,
): Promise<void> {
  for (const email of await verifiedAccountEmails(db, accountId)) {
    const joined = await attachWaitingLicensesByEmailRows(
      db,
      accountId,
      email,
      now,
    );
    if (onJoined && joined.length > 0) await onJoined(joined, email);
  }
  const subjects = await db.all<{ subject: string }>(
    "SELECT subject FROM account_links WHERE account_id = ? AND kind = 'oidc'",
    accountId,
  );
  for (const link of subjects) {
    const rows = await db.all<{ product: string; id: string }>(
      `SELECT l.product AS product, l.id AS id
         FROM licenses l
         LEFT JOIN portal_product_settings s ON s.product = l.product
         LEFT JOIN oidc_config o ON o.product = l.product
        WHERE l.sub = ? AND l.account_id IS NULL
          AND COALESCE(o.provider, 'platform') = 'platform'
          AND ${LICENSE_ISSUER_CLASS_SQL} = 'platform'
          AND ${LICENSE_AUTO_LINK_ENABLED_SQL}
          AND ${notAutoAttachBlockedSql("l")}`,
      link.subject,
      accountId,
    );
    for (const licence of rows) {
      await attachAutomatically(db, accountId, licence, "oidc", now);
    }
  }
}

export async function listPortalLicenses(
  db: Db,
  accountId: string,
): Promise<PortalLicenseRow[]> {
  return db.all<PortalLicenseRow>(
    `SELECT l.*, p.name AS product_name, (SELECT s.branding_json FROM portal_product_settings s WHERE s.product = l.product) AS product_branding_json
       FROM licenses l
       JOIN products p ON p.slug = l.product
      WHERE l.account_id = ?
        AND COALESCE(p.status, 'active') != 'deleted'
      ORDER BY p.name ASC, l.activated_at DESC, l.id DESC`,
    accountId,
  );
}

/**
 * How many distinct products each address brought in (PX-W19): the account's licences whose own
 * email is that address (case-insensitive, the licence email LX-26 attaches by), leaving out
 * deleted and portal-off products as the Library does. One grouped query for every address;
 * keys are lower-cased.
 */
export async function productCountsByEmail(
  db: Db,
  accountId: string,
): Promise<Map<string, number>> {
  const rows = await db.all<{ email: string; n: number }>(
    `SELECT lower(l.email) AS email, COUNT(DISTINCT l.product) AS n
       FROM licenses l
       JOIN products p ON p.slug = l.product
      WHERE l.account_id = ? AND l.email IS NOT NULL
        AND COALESCE(p.status, 'active') != 'deleted'
        AND ${portalEnabledSql("l.product")}
      GROUP BY lower(l.email)`,
    accountId,
  );
  return new Map(rows.map((r) => [r.email, r.n]));
}

export async function getPortalLicense(
  db: Db,
  accountId: string,
  product: string,
  licenseId: string,
): Promise<PortalLicenseRow | null> {
  return db.first<PortalLicenseRow>(
    `SELECT l.*, p.name AS product_name, (SELECT s.branding_json FROM portal_product_settings s WHERE s.product = l.product) AS product_branding_json
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

/**
 * A product's portal settings: the listing columns and branding of its `portal_product_settings`
 * row, with the three switches (`portal_enabled`, `key_reissue_enabled`, `claim_by_key`) read from
 * their settings rows (ST-14; `core/portalToggles.ts`). The table's own switch columns are
 * dropped (migration 0140).
 */
export async function getPortalProductSettings(
  db: Db,
  product: string,
): Promise<PortalProductSettingsRow> {
  const [row, toggles] = await Promise.all([
    db.first<
      Omit<
        PortalProductSettingsRow,
        "portal_enabled" | "key_reissue_enabled" | "claim_by_key"
      >
    >(
      `SELECT product, discover_enabled, store_listed, store_audience, store_offer_paths_json,
              store_group_labels_json, branding_json, created_at, modified_at
         FROM portal_product_settings WHERE product = ?`,
      product,
    ),
    readPortalToggles(db, product),
  ]);
  return {
    ...(row ?? {
      product,
      portal_enabled: 1,
      key_reissue_enabled: 0,
      claim_by_key: 0,
      // Discover defaults ON, as the migration's column default does (migrations/0071).
      discover_enabled: 1,
      // The Polaris Key listing defaults, as the migration's column defaults (migrations/0085).
      store_listed: "auto",
      store_audience: "eligible",
      store_offer_paths_json: null,
      store_group_labels_json: null,
      branding_json: null,
      created_at: 0,
      modified_at: 0,
    }),
    portal_enabled: toggles.portalEnabled ? 1 : 0,
    key_reissue_enabled: toggles.keyReissueEnabled ? 1 : 0,
    claim_by_key: toggles.claimByKey ? 1 : 0,
  };
}

export function portalProductSettingsView(
  row: PortalProductSettingsRow,
): PortalProductSettingsView {
  return {
    portalEnabled: row.portal_enabled === 1,
    keyReissueEnabled: row.key_reissue_enabled === 1,
    claimByKey: row.claim_by_key === 1,
    ...listingView(row),
    branding: publicBranding(row.branding_json),
    modifiedAt: row.modified_at,
  };
}

function listingView(
  row: PortalProductSettingsRow,
): Pick<
  PortalProductSettingsView,
  | "discoverEnabled"
  | "storeListed"
  | "storeAudience"
  | "storeOfferPaths"
  | "storeGroupLabels"
> {
  const l = resolveListing(row);
  return {
    // Derived from the resolved state, so a deploy-window row (`discover_enabled = 1` written by
    // a pre-0085 Worker over `store_listed = 'unlisted'`) never reads "Discover on" while hidden.
    discoverEnabled: l.listed !== "unlisted",
    storeListed: l.listed,
    storeAudience: l.audience,
    storeOfferPaths: l.offerPathsAll ? null : l.offerPaths,
    storeGroupLabels: l.groupLabels,
  };
}

/** The listing part of a portal-settings patch (PS-02), written as registry settings (ST-04). */
export interface ListingPatch {
  discoverEnabled?: boolean;
  /** Wins over `discoverEnabled` in one patch. */
  storeListed?: ListingState;
  storeAudience?: ListingAudience;
  /** `null` restores "every kind". */
  storeOfferPaths?: readonly ObtainPathKind[] | null;
  storeGroupLabels?: GroupLabels;
}

/**
 * The listing settings a patch changes, as `writeSetting()` writes (ST-04): the registry keys
 * `storefront.polarisKey.*` with the values that differ from `current`. The PS-02 rules hold: the
 * listing state is derived from the EFFECTIVE state (dual-read), the Discover switch alone turned
 * off makes the product `unlisted`, turned back on returns an `unlisted` product to `auto` (any
 * other state is kept), and `storeListed` wins over it. The `listed` column adapter keeps
 * `discover_enabled` in step (0 exactly when `unlisted`), so a pre-0085 Worker still agrees.
 */
export function listingSettingWrites(
  current: PortalProductSettingsRow,
  patch: ListingPatch,
): { key: string; value: unknown }[] {
  const effective = resolveListing(current);
  let listed: ListingState = effective.listed;
  if (patch.storeListed !== undefined) listed = patch.storeListed;
  else if (patch.discoverEnabled === false) listed = "unlisted";
  else if (patch.discoverEnabled === true && listed === "unlisted")
    listed = "auto";
  const out: { key: string; value: unknown }[] = [];
  if (
    listed !== current.store_listed ||
    (listed === "unlisted" ? 0 : 1) !== current.discover_enabled
  )
    out.push({ key: "storefront.polarisKey.listed", value: listed });
  if (
    patch.storeAudience !== undefined &&
    patch.storeAudience !== current.store_audience
  )
    out.push({
      key: "storefront.polarisKey.audience",
      value: patch.storeAudience,
    });
  if (patch.storeOfferPaths !== undefined) {
    const next =
      patch.storeOfferPaths === null
        ? null
        : JSON.stringify(patch.storeOfferPaths);
    if (next !== current.store_offer_paths_json)
      out.push({
        key: "storefront.polarisKey.offerPaths",
        value:
          patch.storeOfferPaths === null ? null : [...patch.storeOfferPaths],
      });
  }
  if (patch.storeGroupLabels !== undefined) {
    const next =
      Object.keys(patch.storeGroupLabels).length === 0
        ? null
        : JSON.stringify(patch.storeGroupLabels);
    if (next !== current.store_group_labels_json)
      out.push({
        key: "storefront.polarisKey.groupLabels",
        value: { ...patch.storeGroupLabels },
      });
  }
  return out;
}

/**
 * The portal branding a console or sign-in-settings patch may set. The switches are settings rows
 * (`portal.enabled`, `portal.keyReissue`, written through `writeSetting()`), not part of a patch.
 */
export type PortalSettingsPatch = Partial<{
  branding: unknown;
}>;

/**
 * The upsert of a product's portal branding, as one statement (`guard`, when given, is ANDed in so
 * it can ride in a `writeSetting()` batch). The listing columns (`discover_enabled`, `store_*`) are
 * registry settings, written only through `writeSetting()` (ST-04), and the portal switches and
 * `claim_by_key` are rows (ST-14): none is named here, and a new row takes the column defaults.
 */
export function stmtUpsertPortalProductSettings(
  current: PortalProductSettingsRow,
  product: string,
  patch: PortalSettingsPatch,
  now: number,
  guard: { sql: string; params: DbParam[] } = { sql: "1", params: [] },
): DbStatement {
  const branding_json =
    patch.branding === undefined
      ? current.branding_json
      : patch.branding == null
        ? null
        : JSON.stringify(patch.branding);
  return {
    sql: `INSERT INTO portal_product_settings
       (product, branding_json, created_at, modified_at)
     SELECT ?, ?, ?, ? WHERE (${guard.sql})
     ON CONFLICT(product) DO UPDATE SET
       branding_json = excluded.branding_json,
       modified_at = excluded.modified_at`,
    params: [
      product,
      branding_json,
      current.created_at || now,
      now,
      ...guard.params,
    ],
  };
}

/** Upsert a product's portal switches and branding (not its listing: see above). */
export async function upsertPortalProductSettings(
  db: Db,
  product: string,
  patch: PortalSettingsPatch,
  now: number,
): Promise<PortalProductSettingsRow> {
  const current = await getPortalProductSettings(db, product);
  const stmt = stmtUpsertPortalProductSettings(current, product, patch, now);
  await db.run(stmt.sql, ...stmt.params);
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
 * What the customer portal offers for ONE product, or (without `product`) for the platform.
 *
 * I-29: the per-product sign-in toggles (OIDC, magic link, key claim, auto-link) are retired and their columns dropped. Email and passkeys are always on, platform
 * single sign-on follows the platform's connections, and key claim is always on; a domain's
 * owner turns the email methods off for its addresses with an enforced domain (I-30), which the
 * sign-in routes check on their own. The releases toggle is retired too: downloads follow the
 * product's Release service (Ship builds).
 *
 * R5-06 stays: a `product` evaluates that one product's row with no cross-tenant term, and the
 * answer for no product (the root login page, which has no product context) reveals nothing
 * about any tenant beyond "some portal is on": `releasesEnabled` is false there, as there is
 * nothing to download without a product.
 */
export async function portalAuthCapabilities(
  db: Db,
  product?: string | null,
): Promise<{
  portalEnabled: boolean;
  releasesEnabled: boolean;
}> {
  const rows = await db.all<{
    portal_enabled: number;
    services_json: string | null;
  }>(
    `SELECT
       CASE WHEN ${portalEnabledSql("p.slug")} THEN 1 ELSE 0 END AS portal_enabled,
       p.services_json AS services_json
       FROM products p
      WHERE COALESCE(p.status, 'active') != 'deleted'
        AND (? IS NULL OR p.slug = ?)`,
    product ?? null,
    product ?? null,
  );
  const live = rows.filter((row) => row.portal_enabled === 1);
  return {
    portalEnabled: live.length > 0,
    releasesEnabled:
      product != null &&
      live.some((row) => releaseServiceEnabled(row.services_json)),
  };
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
): Promise<ErasureResult> {
  return deleteAccount({ db, env, now, origin }, accountId);
}

export { portalAudit };

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
  const parsed = parseJsonColumn(row.groups_json);
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
 * One product the Polaris Key storefront may consider for any account (PS-03, notes/S-21 §6.3
 * "Candidates"), before any path is evaluated: its listing columns, resolved by the engine through
 * `resolveListing`, and whether Identity's own paths (`group`, `auto_issue`) may run on it.
 */
export interface StorefrontCandidateRow {
  slug: string;
  /**
   * 1 when the product authenticates against the PLATFORM issuer with auto-linking on: exactly
   * `syncAccountLicenseLinks`'s subject predicates (R5-01/R5-02). A licence keyed by the account's
   * platform subject is only meaningful, and is only linked back into this account, on a product
   * whose own sign-in uses that issuer, so the identity paths run only where this is 1.
   */
  identity_eligible: number;
  discover_enabled: number;
  store_listed: string | null;
  store_audience: string | null;
  store_offer_paths_json: string | null;
  store_group_labels_json: string | null;
}

/**
 * The products the storefront engine may consider for any account (PS-03, which rebuilt PX-W10's
 * Discover candidates on it): live, portal on, and not `unlisted` (PS-02: `discover_enabled = 0`
 * or `store_listed = 'unlisted'` hides it until PS-11 retires `discover_enabled`). The platform
 * issuer and auto-link predicate no longer narrows the set: it rides along as
 * `identity_eligible`, and stays on the identity paths unchanged, because a path that grants no
 * licence (`open`) does not key anything by a subject. The deployment switch
 * (`storefront.polarisKey.enabled`) is the caller's, read once per listing.
 */
export async function listStorefrontCandidates(
  db: Db,
  /** Answer for this one product only (a claim's re-evaluation). */
  only?: string,
): Promise<StorefrontCandidateRow[]> {
  return db.all<StorefrontCandidateRow>(
    `SELECT p.slug AS slug,
            CASE WHEN COALESCE(o.provider, 'platform') = 'platform'
                  AND ${AUTO_LINK_ENABLED_SQL}
                 THEN 1 ELSE 0 END AS identity_eligible,
            COALESCE(s.discover_enabled, 1) AS discover_enabled,
            s.store_listed AS store_listed,
            s.store_audience AS store_audience,
            s.store_offer_paths_json AS store_offer_paths_json,
            s.store_group_labels_json AS store_group_labels_json
       FROM products p
       LEFT JOIN portal_product_settings s ON s.product = p.slug
       LEFT JOIN oidc_config o ON o.product = p.slug
      WHERE COALESCE(p.status, 'active') = 'active'
        AND ${portalEnabledSql("p.slug")}
        AND COALESCE(s.discover_enabled, 1) = 1
        AND COALESCE(s.store_listed, 'auto') <> 'unlisted'
        AND (? IS NULL OR p.slug = ?)
      ORDER BY p.name ASC, p.slug ASC`,
    only ?? null,
    only ?? null,
  );
}

/**
 * The products in the account's library WITHOUT a licence (`library_entries`, PS-04, notes/S-21
 * §6.4): an open product someone added. The storefront never offers or counts one of these, as
 * it never offers a held product.
 */
export async function listLibraryEntryProducts(
  db: Db,
  accountId: string,
): Promise<Set<string>> {
  const rows = await db.all<{ product: string }>(
    "SELECT product FROM library_entries WHERE account_id = ?",
    accountId,
  );
  return new Set(rows.map((r) => r.product));
}

/** Why a library entry exists (`library_entries.via`): the `open` obtain path only. */
export type LibraryEntryVia = "open";

/** One library entry (PS-04): a product in the account's library with no licence behind it. */
export interface LibraryEntryRow {
  product: string;
  via: LibraryEntryVia;
  added_at: number;
}

/** The account's library entries, oldest first; or the one for `product` when given. */
export async function listLibraryEntries(
  db: Db,
  accountId: string,
  product?: string,
): Promise<LibraryEntryRow[]> {
  return db.all<LibraryEntryRow>(
    `SELECT product, via, added_at FROM library_entries
      WHERE account_id = ? AND (? IS NULL OR product = ?)
      ORDER BY added_at ASC, product ASC`,
    accountId,
    product ?? null,
    product ?? null,
  );
}

/**
 * Add `product` to the account's library without a licence, reporting whether THIS call wrote the
 * row. The primary key (account, product) decides a racing double submit: exactly one insert
 * lands, and the other caller answers the same entry as already added.
 */
export async function addLibraryEntry(
  db: Db,
  input: {
    accountId: string;
    product: string;
    via: LibraryEntryVia;
    now: number;
  },
): Promise<boolean> {
  const changes = await db.runChanges(
    `INSERT INTO library_entries (account_id, product, via, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, product) DO NOTHING`,
    input.accountId,
    input.product,
    input.via,
    input.now,
  );
  return changes > 0;
}

/** Remove the account's library entry for `product`; `false` when there was none. */
export async function removeLibraryEntry(
  db: Db,
  accountId: string,
  product: string,
): Promise<boolean> {
  return (
    (await db.runChanges(
      "DELETE FROM library_entries WHERE account_id = ? AND product = ?",
      accountId,
      product,
    )) > 0
  );
}

/**
 * Every product the account holds a licence for, linked by any route (a key claim, a store
 * purchase, a sign-in, a Discover add, an operator grant): the products its library lists, before
 * the portal toggle hides any. Discover never offers or counts one of these.
 */
export async function listHeldProducts(
  db: Db,
  accountId: string,
): Promise<Set<string>> {
  const rows = await db.all<{ product: string }>(
    "SELECT DISTINCT product FROM licenses WHERE account_id = ?",
    accountId,
  );
  return new Set(rows.map((r) => r.product));
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
 * The id of the `portal.discover.claim` row for one added licence: derived from the licence, so a
 * racing double submit inserts it once, and the storefront's activation count (PS-04) finds the
 * claim behind a licence by primary key.
 */
export function discoverClaimAuditId(
  product: string,
  licenseId: string,
): string {
  return `paud_discover_${product}_${licenseId}`;
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
    discoverClaimAuditId(input.product, input.licenseId),
    input.accountId,
    input.now,
    input.product,
    input.licenseId,
    input.summary,
  );
  return changes > 0;
}
