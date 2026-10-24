/**
 * The person's own data as JSON files (I-11; S-16 §5.5 "Per-product deletion and export" and "A
 * full account export covers the account and every product's data for that person").
 *
 *   `exportAccountData`  → `GET /api/me/export`: the account, and every product the account is
 *                          linked to, under {@link ACCOUNT_EXPORT_SCHEMA}.
 *   `exportProductData`  → `GET /api/products/<product>/export`: what is held for the person for
 *                          ONE product, under {@link PRODUCT_EXPORT_SCHEMA}. Never anything from
 *                          the account that is not about that product (no sign-in methods, no
 *                          other product, no birth date).
 *
 * Both are read-only: nothing here mints a subject, attaches a licence or writes a row, so asking
 * for a copy leaves no trace but the audit row the route writes. Every query is keyed by the
 * caller's account id (or by the pairwise subject that account owns), so there is no path by
 * which another person's row can enter a document.
 *
 * ── THE ALLOW-LIST ──────────────────────────────────────────────────────────────────────────
 *
 * Each document is assembled field by field, never by spreading a row, so a column added to a
 * table tomorrow is NOT exported until someone decides it should be. The OpenAPI schemas
 * (`PortalAccountExport`, `PortalProductExport`) declare `additionalProperties: false`, and
 * `test/portalDataExport.test.ts` validates real documents against them, so the schema and this
 * module cannot drift apart. What is deliberately absent, and why:
 *
 *   credentials   no session id (hash), device token (hash), licence key (hash or text),
 *                 registry token (hash or text), passkey credential id, public key, signature
 *                 counter or user handle, no provider picture reference, no consent scope hash.
 *   other people  no operator or developer identity (who revoked a token, who relinked a
 *                 licence), no other account's row, no relink history (a developer's record).
 *   machinery     the account-join undo snapshot (it copies the absorbed account's passkey user
 *                 handle), the retired pre-I-05 `portal_*` tables (no code reads them since
 *                 I-28), the legacy `accounts.terms_json`, device fingerprints and software
 *                 facts (hashed hardware components the developer's product keeps for licence
 *                 enforcement), store purchase records, a licence's `overrides_json` and `groups_json`, and the
 *                 developer's own audit log.
 *
 * Secrets that live in a product's registered stores stay sealed: a store's `export` names a
 * secret and says whether it is set, never its value (`config.accountOverrides`).
 */

import { customerTierId } from "../../../core/licensing/implicitTier.js";
import {
  listAccountTokens,
  type PersonalTokenView,
} from "../../../core/accounts/personalTokens.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { jsonList, jsonListArg } from "../../../core/sqlIn.js";
import { getProduct } from "../../../core/products/store.js";
import {
  accountLicenses,
  existingSubjectFor,
} from "../../../core/accounts/accountSubjects.js";
import { runSubjectExport } from "../../../core/accounts/subjectHooks.js";
import { parseJsonOr, parseJsonStringList } from "../../../platform/json.js";
import {
  EMAIL_ISSUER,
  PASSKEY_ISSUER,
  getAccountRow,
  listLinks,
  type AccountLinkRow,
} from "../accounts/repo.js";
import { accountDeletionSchedule } from "../accounts/lifecycle.js";
import { consentedClaims } from "../accounts/productUsers.js";
import { termsAcceptancesOf } from "../accounts/terms.js";
import { avatarView, type AvatarView } from "../card/avatars.js";
import {
  parseLinkProfile,
  profileView,
  type ProfileView,
} from "../card/profile.js";
import { listAccountPasskeys } from "../passkeys/repo.js";
import { passkeyView } from "../passkeys/routes.js";
import type { PortalHooksFor } from "./api.js";
import { licenseGrants } from "./entitlements.js";
import { licenseStores, portalLicenseOrigin, storeKey } from "./origin.js";
import {
  listLibraryEntries,
  listPortalLicenses,
  listVisibleDevices,
  listVisibleKeys,
  type PortalLicenseRow,
} from "./repo.js";

/** The `schema` member of the full account export. A breaking change to its shape bumps it. */
export const ACCOUNT_EXPORT_SCHEMA = "pkey-account-export/1";
/** The `schema` member of a per-product export. */
export const PRODUCT_EXPORT_SCHEMA = "pkey-product-export/1";

/**
 * The most activity rows one document carries (newest first). The portal keeps 180 days of them
 * (`prunePortalAudit`), so this is a ceiling for an unusually busy account, not a routine cut;
 * when it bites the document says so (`activityTruncated`), it never drops rows silently.
 */
export const EXPORT_ACTIVITY_LIMIT = 5000;
/** The most account sessions listed: live ones plus a month of ended ones (`SESSION_PRUNE_AFTER_SECONDS`). */
const EXPORT_SESSION_LIMIT = 500;

/** What an export reads with. */
export interface ExportContext {
  db: Db;
  env: Env;
  now: number;
  /** Only to name how each licence reached the person (a store purchase needs License's hook). */
  hooksFor?: PortalHooksFor | undefined;
}

// ── The shapes ──────────────────────────────────────────────────────────────────────────────

export interface ExportedKey {
  label: string | null;
  status: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ExportedDevice {
  deviceId: string;
  status: string;
  /** Null when the device is signed in as somebody else's subject: not this person's data. */
  label: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sdkName: string | null;
  sdkVersion: string | null;
  userAgent: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface ExportedLicense {
  id: string;
  name: string | null;
  email: string | null;
  status: string;
  tier: string | null;
  activatedAt: number;
  expiresAt: number | null;
  maxOfflineDays: number | null;
  /** How it reached the person: `key`, `store-key`, `store`, `developer` or `signin`. */
  origin: string;
  originStore: string | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
  entitlements: Array<{ key: string; label: string; value: unknown }>;
  keys: ExportedKey[];
  devices: ExportedDevice[];
}

export interface ExportedSubjectEvent {
  id: string;
  type: string;
  at: number;
  alias?: string;
  licenseIds?: string[];
}

/** What exists for one product, whichever document carries it. */
export interface ProductSection {
  product: { slug: string; name: string };
  /** The person's pairwise id for this product (their support code), or null before contact. */
  subject: string | null;
  subjectCreatedAt: number | null;
  /** Earlier ids of the same person for this product, absorbed by an account join. */
  mergedSubjects: Array<{ subject: string; mergedAt: number }>;
  licenses: ExportedLicense[];
  events: ExportedSubjectEvent[];
  /** Each registered store's export for the subject, by store name; `{}` without a subject. */
  stores: Record<string, unknown>;
}

export interface ExportedConsent {
  product: string;
  claims: string[];
  grantedAt: number;
  modifiedAt: number;
}

export interface ExportedTerms {
  /** A product slug, or `_platform` for Polaris Key's own terms. */
  product: string;
  version: string;
  url: string;
  acceptedAt: number;
}

export interface ExportedLibraryEntry {
  product: string;
  via: string;
  addedAt: number;
}

export interface ExportedRemovedLicense {
  product: string;
  licenseId: string;
  removedAt: number;
}

export interface ExportedPackageToken {
  product: string;
  tokenId: string;
  label: string;
  /** The plaintext's last four characters, as the portal's own list shows them. */
  hint: string;
  scopes: string[];
  ecosystems: string[] | null;
  binding: string;
  licenseId: string | null;
  presentation: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
}

export interface ExportedActivity {
  at: number;
  action: string;
  product: string | null;
  targetKind: string | null;
  targetId: string | null;
  summary: string | null;
}

export interface ExportedSignInMethod {
  id: string;
  kind: string;
  group: "accounts" | "email" | "passkeys";
  /** The OIDC issuer of a single sign-on connection; null for email, passkeys and providers. */
  issuer: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  /** The provider's id for the person; null for a passkey (its credential id is a credential). */
  providerSubject: string | null;
  tenantScoped: boolean;
  connectedAt: number;
  lastUsedAt: number;
  /** What the provider reported since linking (`consent_revoked`, …). */
  flag: string | null;
  signedInWith: string[];
  /** A single sign-on connection's groups and access-rule claims at the last sign-in. */
  groups: string[];
  claims: Record<string, string>;
  /** What the provider supplied at link time: the name, locale and the copied picture. */
  profileImport: {
    name: string | null;
    locale: string | null;
    picture: AvatarView | null;
  };
}

export interface ExportedPicture {
  asset: string;
  origin: string;
  bytes: number;
  createdAt: number;
  url: string;
  url96: string;
  /** The picture in use, or one a sign-in method's import still points at. */
  inUse: boolean;
}

export interface ExportedPasskey {
  methodId: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
  synced: boolean | null;
  aaguid: string | null;
  addedFrom: string | null;
  /** The name the account gave the passkey; null when it has none. */
  name: string | null;
}

export interface ExportedSession {
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  endedAt: number | null;
  browser: string | null;
  signedInWith: string[];
  current: boolean;
}

export interface AccountExport {
  schema: typeof ACCOUNT_EXPORT_SCHEMA;
  exportedAt: number;
  account: {
    id: string;
    status: string;
    primaryEmail: string | null;
    primaryEmailVerifiedAt: number | null;
    createdAt: number;
    modifiedAt: number;
    lastSignInAt: number | null;
    signInNudgeShownAt: number | null;
    /** A pending deletion request: when it was made and when it becomes irreversible. */
    deletion: { requestedAt: number; dueAt: number } | null;
  };
  profile: Omit<ProfileView, "sources">;
  pictures: ExportedPicture[];
  signInMethods: ExportedSignInMethod[];
  passkeys: ExportedPasskey[];
  sessions: ExportedSession[];
  connectedApps: ExportedConsent[];
  termsAcceptances: ExportedTerms[];
  library: {
    entries: ExportedLibraryEntry[];
    removedLicenses: ExportedRemovedLicense[];
  };
  packageTokens: ExportedPackageToken[];
  /** F-33: the account's personal tokens (metadata only: never the plaintext, never the hash). */
  personalTokens: PersonalTokenView[];
  joins: Array<{
    joinedAt: number;
    undoableUntil: number;
    undoneAt: number | null;
  }>;
  activity: ExportedActivity[];
  activityTruncated: boolean;
  products: ProductSection[];
}

export interface ProductExport extends ProductSection {
  schema: typeof PRODUCT_EXPORT_SCHEMA;
  exportedAt: number;
  consent: ExportedConsent | null;
  termsAcceptances: ExportedTerms[];
  libraryEntry: ExportedLibraryEntry | null;
  removedLicenses: ExportedRemovedLicense[];
  packageTokens: ExportedPackageToken[];
  activity: ExportedActivity[];
  activityTruncated: boolean;
}

// ── The account's links to a product ────────────────────────────────────────────────────────

/**
 * Is the account linked to `product`? A licence it holds, a pairwise subject, a library entry, a
 * consent, an accepted terms version or a licence it removed from its library all count: each is
 * a record the product page and the removal act on. A product that does not exist (or was
 * deleted) is never linked. Everything else about a product is invisible to the caller.
 */
export async function productLinked(
  db: Db,
  accountId: string,
  product: string,
): Promise<boolean> {
  if (!(await getProduct(db, product))) return false;
  if ((await accountLicenses(db, accountId, product)).length > 0) return true;
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM (
       SELECT 1 FROM account_product_subjects WHERE account_id = ? AND product = ?
       UNION ALL SELECT 1 FROM library_entries WHERE account_id = ? AND product = ?
       UNION ALL SELECT 1 FROM account_product_grants WHERE account_id = ? AND product = ?
       UNION ALL SELECT 1 FROM account_terms_acceptances WHERE account_id = ? AND product = ?
       UNION ALL SELECT 1 FROM license_auto_attach_blocks WHERE account_id = ? AND product = ?
     ) LIMIT 1`,
    ...Array.from({ length: 5 }, () => [accountId, product]).flat(),
  );
  return row !== null;
}

// ── Shared readers ──────────────────────────────────────────────────────────────────────────

const group = (l: AccountLinkRow): ExportedSignInMethod["group"] =>
  l.issuer_key === EMAIL_ISSUER
    ? "email"
    : l.issuer_key === PASSKEY_ISSUER
      ? "passkeys"
      : "accounts";

async function consents(
  db: Db,
  accountId: string,
  product?: string,
): Promise<ExportedConsent[]> {
  const rows = await db.all<{
    product: string;
    claims_json: string | null;
    granted_at: number;
    modified_at: number;
  }>(
    `SELECT product, claims_json, granted_at, modified_at FROM account_product_grants
      WHERE account_id = ? AND (? IS NULL OR product = ?) ORDER BY product`,
    accountId,
    product ?? null,
    product ?? null,
  );
  return rows.map((r) => ({
    product: r.product,
    claims: [...consentedClaims(r.claims_json)].sort(),
    grantedAt: r.granted_at,
    modifiedAt: r.modified_at,
  }));
}

async function terms(
  db: Db,
  accountId: string,
  product?: string,
): Promise<ExportedTerms[]> {
  return (await termsAcceptancesOf(db, accountId))
    .filter((r) => product === undefined || r.product === product)
    .map((r) => ({
      product: r.product,
      version: r.version,
      url: r.url,
      acceptedAt: r.accepted_at,
    }));
}

async function libraryEntries(
  db: Db,
  accountId: string,
  product?: string,
): Promise<ExportedLibraryEntry[]> {
  return (await listLibraryEntries(db, accountId, product)).map((r) => ({
    product: r.product,
    via: r.via,
    addedAt: r.added_at,
  }));
}

async function removedLicenses(
  db: Db,
  accountId: string,
  product?: string,
): Promise<ExportedRemovedLicense[]> {
  const rows = await db.all<{
    product: string;
    license_id: string;
    created_at: number;
  }>(
    `SELECT product, license_id, created_at FROM license_auto_attach_blocks
      WHERE account_id = ? AND (? IS NULL OR product = ?)
      ORDER BY created_at, product, license_id`,
    accountId,
    product ?? null,
    product ?? null,
  );
  return rows.map((r) => ({
    product: r.product,
    licenseId: r.license_id,
    removedAt: r.created_at,
  }));
}

/** The package tokens the account minted (metadata only: never the plaintext, never the hash). */
async function packageTokens(
  db: Db,
  accountId: string,
  now: number,
  product?: string,
): Promise<ExportedPackageToken[]> {
  const rows = await db.all<{
    product: string;
    token_id: string;
    label: string;
    hint: string;
    scopes_json: string;
    ecosystems_json: string | null;
    binding: string;
    license_id: string | null;
    presentation: string;
    created_at: number;
    expires_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
    revoke_reason: string | null;
  }>(
    `SELECT product, token_id, label, hint, scopes_json, ecosystems_json, binding, license_id,
            presentation, created_at, expires_at, last_used_at, revoked_at, revoke_reason
       FROM registry_tokens
      WHERE portal_account_id = ? AND (? IS NULL OR product = ?)
      ORDER BY created_at DESC, product, token_id DESC`,
    accountId,
    product ?? null,
    product ?? null,
  );
  return rows.map((r) => ({
    product: r.product,
    tokenId: r.token_id,
    label: r.label,
    hint: r.hint,
    scopes: parseJsonStringList(r.scopes_json),
    ecosystems:
      r.ecosystems_json === null
        ? null
        : parseJsonStringList(r.ecosystems_json),
    binding: r.binding,
    licenseId: r.license_id,
    presentation: r.presentation,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revokeReason: r.revoke_reason,
    status:
      r.revoked_at !== null
        ? "revoked"
        : r.expires_at <= now
          ? "expired"
          : "active",
  }));
}

async function activity(
  db: Db,
  accountId: string,
  product?: string,
): Promise<{ rows: ExportedActivity[]; truncated: boolean }> {
  const rows = await db.all<{
    at: number;
    action: string;
    product: string | null;
    target_kind: string | null;
    target_id: string | null;
    summary: string | null;
  }>(
    `SELECT at, action, product, target_kind, target_id, summary FROM portal_audit
      WHERE account_id = ? AND (? IS NULL OR product = ?)
      ORDER BY at DESC, id DESC LIMIT ?`,
    accountId,
    product ?? null,
    product ?? null,
    EXPORT_ACTIVITY_LIMIT + 1,
  );
  return {
    truncated: rows.length > EXPORT_ACTIVITY_LIMIT,
    rows: rows.slice(0, EXPORT_ACTIVITY_LIMIT).map((r) => ({
      at: r.at,
      action: r.action,
      product: r.product,
      targetKind: r.target_kind,
      targetId: r.target_id,
      summary: r.summary,
    })),
  };
}

// ── One product ─────────────────────────────────────────────────────────────────────────────

/** The pairwise ids that stand for the account in `product`: its own, and the ones a join absorbed. */
async function ownSubjects(
  db: Db,
  product: string,
  subject: string | null,
): Promise<{ aliases: Array<{ subject: string; mergedAt: number }> }> {
  if (subject === null) return { aliases: [] };
  const rows = await db.all<{ alias: string; merged_at: number }>(
    `SELECT alias, merged_at FROM account_product_subject_aliases
      WHERE product = ? AND subject = ? ORDER BY merged_at, alias`,
    product,
    subject,
  );
  return {
    aliases: rows.map((r) => ({ subject: r.alias, mergedAt: r.merged_at })),
  };
}

async function subjectEvents(
  db: Db,
  product: string,
  subjects: readonly string[],
): Promise<ExportedSubjectEvent[]> {
  if (subjects.length === 0) return [];
  const rows = await db.all<{
    id: string;
    type: string;
    created_at: number;
    payload_json: string | null;
  }>(
    `SELECT id, type, created_at, payload_json FROM subject_events
      WHERE product = ? AND subject IN ${jsonList()}
      ORDER BY created_at DESC, id`,
    product,
    jsonListArg(subjects),
  );
  return rows.map((e) => {
    const payload = parseJsonOr<Record<string, unknown>>(e.payload_json, {});
    return {
      id: e.id,
      type: e.type,
      at: e.created_at,
      ...(typeof payload.alias === "string" ? { alias: payload.alias } : {}),
      ...(Array.isArray(payload.licenseIds)
        ? {
            licenseIds: payload.licenseIds.filter(
              (x): x is string => typeof x === "string",
            ),
          }
        : {}),
    };
  });
}

async function exportLicense(
  ctx: ExportContext,
  row: PortalLicenseRow,
  own: ReadonlySet<string>,
  store: string | null,
): Promise<ExportedLicense> {
  const { db, now } = ctx;
  const keys = await listVisibleKeys(db, row.product, row.id);
  const devices = await listVisibleDevices(db, row.product, row.id);
  const grants = await licenseGrants(db, row, now);
  const origin = portalLicenseOrigin({
    origin: row.origin ?? null,
    sub: row.sub,
    email: row.email,
    keyCount: keys.length,
    store,
  });
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    tier: await customerTierId(db, row),
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    maxOfflineDays: row.max_offline_days,
    origin: origin.origin,
    originStore: origin.originStore,
    channels: grants.channels,
    minVersion: grants.minVersion,
    maxVersion: grants.maxVersion,
    entitlements: grants.entitlements.map((e) => ({
      key: e.key,
      label: e.label,
      value: e.value,
    })),
    keys: keys.map((k) => ({
      label: k.label,
      status: k.status,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
    })),
    // A device signed in as someone else's subject is theirs, not this person's: left out whole.
    devices: devices
      .filter(
        (d) =>
          d.subject === undefined || d.subject === null || own.has(d.subject),
      )
      .map((d) => ({
        deviceId: d.device_id,
        status: d.status,
        label: d.label,
        platform: d.platform ?? null,
        arch: d.arch ?? null,
        appVersion: d.app_version ?? null,
        sdkName: d.sdk_name ?? null,
        sdkVersion: d.sdk_version ?? null,
        userAgent: d.ua,
        firstSeen: d.first_seen,
        lastSeen: d.last_seen,
      })),
  };
}

/** One product's section, from the licences the account holds in it and the subject it owns. */
async function productSection(
  ctx: ExportContext,
  accountId: string,
  slug: string,
  name: string,
  licenses: readonly PortalLicenseRow[],
  stores: ReadonlyMap<string, string | null>,
): Promise<ProductSection> {
  const { db, env, now } = ctx;
  const subject = await existingSubjectFor(db, accountId, slug);
  const created = subject
    ? await db.first<{ created_at: number }>(
        "SELECT created_at FROM account_product_subjects WHERE account_id = ? AND product = ?",
        accountId,
        slug,
      )
    : null;
  const { aliases } = await ownSubjects(db, slug, subject);
  const own = new Set<string>(
    subject ? [subject, ...aliases.map((a) => a.subject)] : [],
  );
  const exported: ExportedLicense[] = [];
  for (const row of licenses)
    exported.push(
      await exportLicense(
        ctx,
        row,
        own,
        stores.get(storeKey(slug, row.id)) ?? null,
      ),
    );
  return {
    product: { slug, name },
    subject,
    subjectCreatedAt: created?.created_at ?? null,
    mergedSubjects: aliases,
    licenses: exported,
    events: await subjectEvents(db, slug, [...own]),
    stores: subject
      ? await runSubjectExport({ db, env, now }, { product: slug, subject })
      : {},
  };
}

/**
 * The per-product export, or `null` when the account is not linked to the product (the route
 * answers `404`, the same for a product that does not exist).
 */
export async function exportProductData(
  ctx: ExportContext,
  accountId: string,
  slug: string,
): Promise<ProductExport | null> {
  const { db, now } = ctx;
  const product = await getProduct(db, slug);
  if (!product || !(await productLinked(db, accountId, slug))) return null;
  const licenses = (await listPortalLicenses(db, accountId)).filter(
    (l) => l.product === slug,
  );
  const stores = await licenseStores(db, licenses, ctx.hooksFor, now);
  const section = await productSection(
    ctx,
    accountId,
    slug,
    product.name,
    licenses,
    stores,
  );
  const log = await activity(db, accountId, slug);
  return {
    schema: PRODUCT_EXPORT_SCHEMA,
    exportedAt: now,
    ...section,
    consent: (await consents(db, accountId, slug))[0] ?? null,
    termsAcceptances: await terms(db, accountId, slug),
    libraryEntry: (await libraryEntries(db, accountId, slug))[0] ?? null,
    removedLicenses: await removedLicenses(db, accountId, slug),
    packageTokens: await packageTokens(db, accountId, now, slug),
    activity: log.rows,
    activityTruncated: log.truncated,
  };
}

// ── The whole account ───────────────────────────────────────────────────────────────────────

/**
 * The full account export, or `null` when the account row is gone. `currentSessionIdHash` only
 * marks which listed session is the caller's own.
 */
export async function exportAccountData(
  ctx: ExportContext,
  accountId: string,
  currentSessionIdHash: string | null,
): Promise<AccountExport | null> {
  const { db, now } = ctx;
  const account = await getAccountRow(db, accountId);
  if (!account) return null;
  const profile = await profileView(db, accountId);
  if (!profile) return null;
  const { sources: _sources, ...profileWithoutSources } = profile;

  const links = (await listLinks(db, accountId)) as Array<
    AccountLinkRow & {
      profile_json?: string | null;
      groups_json?: string | null;
      claims_json?: string | null;
    }
  >;
  const pictureRows = await db.all<{
    asset: string;
    origin: string;
    bytes: number;
    created_at: number;
  }>(
    `SELECT asset, origin, bytes, created_at FROM account_avatars
      WHERE account_id = ? ORDER BY created_at, asset`,
    accountId,
  );
  const imports = links.map((l) => parseLinkProfile(l.profile_json));
  const used = new Set<string>(
    [account.avatar_key, ...imports.map((p) => p.avatarKey)].filter(
      (k): k is string => typeof k === "string",
    ),
  );
  const signInMethods: ExportedSignInMethod[] = links.map((l, i) => {
    const g = group(l);
    const imported = imports[i]!;
    const claims = parseJsonOr<Record<string, unknown>>(l.claims_json, {});
    return {
      id: l.id,
      kind: l.kind,
      group: g,
      issuer: g === "accounts" && l.kind === "oidc" ? l.issuer_key : null,
      email: l.kind === "email" ? l.subject : l.email,
      emailVerified: l.email_verified === 1,
      displayName: l.display_name,
      providerSubject: g === "accounts" ? l.subject : null,
      tenantScoped: l.tenant_scope !== "",
      connectedAt: l.created_at,
      lastUsedAt: l.last_used_at,
      flag: l.provider_flag ?? null,
      signedInWith: parseJsonStringList(l.amr_json),
      groups: parseJsonStringList(l.groups_json),
      claims: Object.fromEntries(
        Object.entries(claims).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
      profileImport: {
        name: imported.name,
        locale: imported.locale,
        picture: avatarView(imported.avatarKey),
      },
    };
  });
  const passkeys: ExportedPasskey[] = (
    await listAccountPasskeys(db, accountId)
  ).map((p) => {
    // An explicit projection: a new passkey view field stays out of the export until it is listed
    // here. The credential id is a credential; the method id names the passkey instead.
    const v = passkeyView(p);
    return {
      methodId: v.methodId,
      createdAt: v.createdAt,
      lastUsedAt: v.lastUsedAt,
      transports: v.transports,
      synced: v.synced,
      aaguid: v.aaguid,
      addedFrom: v.addedFrom,
      name: v.name,
    };
  });
  const sessions = (
    await db.all<{
      id_hash: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      revoked_at: number | null;
      user_agent: string | null;
      amr_json: string | null;
    }>(
      `SELECT id_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent, amr_json
         FROM account_sessions WHERE account_id = ?
        ORDER BY created_at DESC, id_hash LIMIT ?`,
      accountId,
      EXPORT_SESSION_LIMIT,
    )
  ).map(
    (s): ExportedSession => ({
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      endedAt: s.revoked_at,
      browser: s.user_agent,
      signedInWith: parseJsonStringList(s.amr_json),
      current: s.id_hash === currentSessionIdHash,
    }),
  );
  const joins = (
    await db.all<{
      merged_at: number;
      undo_until: number;
      undone_at: number | null;
    }>(
      `SELECT merged_at, undo_until, undone_at FROM account_merges
        WHERE survivor_id = ? ORDER BY merged_at DESC, id`,
      accountId,
    )
  ).map((j) => ({
    joinedAt: j.merged_at,
    undoableUntil: j.undo_until,
    undoneAt: j.undone_at,
  }));
  const log = await activity(db, accountId);

  // One section per product the person holds a licence in or has a subject for.
  const licenses = await listPortalLicenses(db, accountId);
  const subjectRows = await db.all<{ product: string }>(
    "SELECT product FROM account_product_subjects WHERE account_id = ? ORDER BY product",
    accountId,
  );
  const slugs = [
    ...new Set([
      ...licenses.map((l) => l.product),
      ...subjectRows.map((s) => s.product),
    ]),
  ].sort();
  const stores = await licenseStores(db, licenses, ctx.hooksFor, now);
  const products: ProductSection[] = [];
  for (const slug of slugs) {
    const product = await getProduct(db, slug);
    if (!product) continue;
    products.push(
      await productSection(
        ctx,
        accountId,
        slug,
        product.name,
        licenses.filter((l) => l.product === slug),
        stores,
      ),
    );
  }

  const withNudge = account as typeof account & {
    nudge_shown_at?: number | null;
  };
  return {
    schema: ACCOUNT_EXPORT_SCHEMA,
    exportedAt: now,
    account: {
      id: account.id,
      status: account.status,
      primaryEmail: account.primary_email,
      primaryEmailVerifiedAt: account.primary_email_verified_at,
      createdAt: account.created_at,
      modifiedAt: account.modified_at,
      lastSignInAt: account.last_sign_in_at,
      signInNudgeShownAt: withNudge.nudge_shown_at ?? null,
      deletion: await accountDeletionSchedule(db, accountId),
    },
    profile: profileWithoutSources,
    pictures: pictureRows.map((p) => {
      const view = avatarView(p.asset);
      return {
        asset: p.asset,
        origin: p.origin,
        bytes: p.bytes,
        createdAt: p.created_at,
        url: view?.url ?? "",
        url96: view?.url96 ?? "",
        inUse: used.has(p.asset),
      };
    }),
    signInMethods,
    passkeys,
    sessions,
    connectedApps: await consents(db, accountId),
    termsAcceptances: await terms(db, accountId),
    library: {
      entries: await libraryEntries(db, accountId),
      removedLicenses: await removedLicenses(db, accountId),
    },
    packageTokens: await packageTokens(db, accountId, now),
    personalTokens: await listAccountTokens(db, accountId, now),
    joins,
    activity: log.rows,
    activityTruncated: log.truncated,
    products,
  };
}
