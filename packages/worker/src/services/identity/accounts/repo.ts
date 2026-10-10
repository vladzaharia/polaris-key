/**
 * The account tables (I-05; plans/I-04.md §6.1): `accounts` and `account_links`, plus the small
 * reads every account flow shares. Identity owns these tables (`TABLE_OWNERS`); Core reads only
 * the subject rows, through `core/accounts/accountSubjects.ts`.
 *
 * The account id is INTERNAL: it lives in Identity and Core and never reaches a developer.
 */

import { normalizeEmail } from "../../../platform/email.js";
import { randomId } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import { MERGE_REDIRECT_SECONDS } from "../../../core/accounts/accountSubjects.js";

export interface AccountRow {
  id: string;
  status: "active" | "disabled" | "deleted";
  primary_email: string | null;
  primary_email_verified_at: number | null;
  display_name: string | null;
  avatar_key: string | null;
  locale: string | null;
  details_source_json: string | null;
  /** Superseded by `account_terms_acceptances` (PX-W15): neither read nor written. */
  terms_json: string | null;
  /**
   * I-33: the optional birth date (`YYYY-MM-DD`) and where it came from (`user`,
   * `connection:<id>`), `accounts/birthdate.ts`. Private to the person: never answered outside
   * their own profile.
   */
  birthdate?: string | null;
  birthdate_source?: string | null;
  created_at: number;
  modified_at: number;
  last_sign_in_at: number | null;
  deleted_at: number | null;
}

export interface AccountLinkRow {
  id: string;
  account_id: string;
  issuer_key: string;
  tenant_scope: string;
  subject: string;
  kind: string;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  amr_json: string | null;
  created_at: number;
  last_used_at: number;
  /** I-06: what the provider reported since linking (`consent_revoked`, `account_deleted`,
   *  `email_disabled`), or NULL. Absent on rows read before migration 0081 applies. */
  provider_flag?: string | null;
}

/** The issuer key of an email sign-in method (its subject is the normalised address). */
export const EMAIL_ISSUER = "email";

/** The issuer key of a passkey sign-in method (I-16): its subject is the WebAuthn credential id
 *  (base64url), and its WebAuthn material lives in `account_passkeys` under the same id. */
export const PASSKEY_ISSUER = "passkey";

/** The issuer-less key every portal identity carried before I-01 (migrations/0059). */
export const LEGACY_OIDC_ISSUER = "oidc";

/** The account row, exactly as stored (no tombstone redirect). */
export async function getAccountRow(
  db: Db,
  id: string,
): Promise<AccountRow | null> {
  return db.first<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
}

/**
 * The account an id names TODAY: the row itself, or, for an account absorbed by a merge less than
 * 30 days ago, the survivor (S-16 §5.1: the tombstone redirects sign-ins for 30 days). A session
 * cookie of the absorbed account therefore keeps working, as the survivor. `null` otherwise.
 */
export async function resolveAccount(
  db: Db,
  id: string,
  now: number,
): Promise<AccountRow | null> {
  const row = await getAccountRow(db, id);
  if (row) return row;
  const tomb = await db.first<{
    merged_into: string | null;
    deleted_at: number;
  }>("SELECT merged_into, deleted_at FROM account_tombstones WHERE id = ?", id);
  if (!tomb?.merged_into || now - tomb.deleted_at > MERGE_REDIRECT_SECONDS) {
    return null;
  }
  // One hop is enough in practice, but a chain of merges inside 30 days resolves fully.
  return resolveAccount(db, tomb.merged_into, now);
}

/** Create an account. Only `signIn` calls this, and only after a credential was verified. */
export async function insertAccount(
  db: Db,
  input: {
    primaryEmail: string | null;
    primaryEmailVerified: boolean;
    displayName: string | null;
  },
  now: number,
): Promise<AccountRow> {
  const id = randomId("acct");
  await db.run(
    `INSERT INTO accounts
       (id, status, primary_email, primary_email_verified_at, display_name,
        created_at, modified_at, last_sign_in_at)
     VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`,
    id,
    input.primaryEmail ? normalizeEmail(input.primaryEmail) : null,
    input.primaryEmail && input.primaryEmailVerified ? now : null,
    input.displayName ?? input.primaryEmail ?? null,
    now,
    now,
    now,
  );
  const row = await getAccountRow(db, id);
  if (!row) throw new Error("account insert failed");
  return row;
}

/** The link for an exact (issuer, tenant scope, subject), whichever account holds it. */
export async function findLink(
  db: Db,
  key: { issuerKey: string; tenantScope: string; subject: string },
): Promise<AccountLinkRow | null> {
  return db.first<AccountLinkRow>(
    `SELECT * FROM account_links
      WHERE issuer_key = ? AND tenant_scope = ? AND subject = ?`,
    key.issuerKey,
    key.tenantScope,
    key.subject,
  );
}

export async function listLinks(
  db: Db,
  accountId: string,
): Promise<AccountLinkRow[]> {
  return db.all<AccountLinkRow>(
    "SELECT * FROM account_links WHERE account_id = ? ORDER BY created_at, id",
    accountId,
  );
}

/** Insert a link. The UNIQUE key makes a concurrent duplicate fail rather than double-attach. */
export async function insertLink(
  db: Db,
  accountId: string,
  link: {
    issuerKey: string;
    tenantScope: string;
    subject: string;
    kind: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    amr: readonly string[] | null;
  },
  now: number,
): Promise<boolean> {
  const changes = await db.runChanges(
    `INSERT OR IGNORE INTO account_links
       (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
        display_name, amr_json, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomId("lnk"),
    accountId,
    link.issuerKey,
    link.tenantScope,
    link.subject,
    link.kind,
    link.email ? normalizeEmail(link.email) : null,
    link.emailVerified ? 1 : 0,
    link.displayName,
    link.amr ? JSON.stringify(link.amr) : null,
    now,
    now,
  );
  return changes > 0;
}

/**
 * Every address this account has verified: its verified email sign-in methods, the
 * provider-verified email of any link, and the primary email once verified. The licence claim
 * rule (an email-carrying licence attaches only to an account that verified that email) and the
 * security-notice fan-out both read this one list. {@link accountsVerifyingEmail} is its inverse
 * and must stay in step: change what "verified" means here and change it there too
 * (`test/licenseHolders.test.ts` pins the two agree).
 */
export async function verifiedAccountEmails(
  db: Db,
  accountId: string,
): Promise<string[]> {
  const rows = await db.all<{ email: string }>(
    `SELECT email FROM account_links
      WHERE account_id = ? AND email IS NOT NULL AND email_verified = 1
     UNION
     SELECT primary_email AS email FROM accounts
      WHERE id = ? AND primary_email IS NOT NULL AND primary_email_verified_at IS NOT NULL
     ORDER BY email`,
    accountId,
    accountId,
  );
  return rows.map((r) => r.email);
}

/**
 * The ACTIVE accounts that verified `email`: the inverse of {@link verifiedAccountEmails}. The
 * account holding it as an email sign-in method comes first (that link key is unique, so at most
 * one), then any other account in id order. INTERNAL: for the licence association only (LX-26);
 * nothing about it reaches a developer. The same two sources as `verifiedAccountEmails` (a link
 * whose email is verified, a verified primary email), read the other way; only active accounts
 * answer. Keep the two in step (`test/licenseHolders.test.ts` pins that they agree).
 */
export async function accountsVerifyingEmail(
  db: Db,
  email: string,
): Promise<Array<{ accountId: string; emailMethod: boolean }>> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const rows = await db.all<{ account_id: string; method: number }>(
    `SELECT v.account_id AS account_id, MAX(v.method) AS method
       FROM (SELECT account_id,
                    CASE WHEN issuer_key = ? AND tenant_scope = '' AND subject = ? THEN 1 ELSE 0 END
                      AS method
               FROM account_links
              WHERE email = ? AND email_verified = 1
             UNION ALL
             SELECT id AS account_id, 0 AS method FROM accounts
              WHERE primary_email = ? AND primary_email_verified_at IS NOT NULL) v
       JOIN accounts a ON a.id = v.account_id AND a.status = 'active'
      GROUP BY v.account_id
      ORDER BY method DESC, v.account_id`,
    EMAIL_ISSUER,
    normalized,
    normalized,
    normalized,
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    emailMethod: r.method === 1,
  }));
}

/**
 * Which OTHER account already uses `email`: as an email sign-in method, or as its verified
 * primary email. The login card's join offer starts here (S-16 §5.1); nothing is ever attached on
 * this answer alone ("never by email match").
 */
export async function accountUsingEmail(
  db: Db,
  email: string,
  exceptAccountId: string | null = null,
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const row = await db.first<{ account_id: string }>(
    `SELECT account_id FROM account_links
      WHERE issuer_key = ? AND tenant_scope = '' AND subject = ?
        AND (? IS NULL OR account_id != ?)
     UNION ALL
     SELECT id AS account_id FROM accounts
      WHERE primary_email = ? AND primary_email_verified_at IS NOT NULL
        AND status != 'deleted' AND (? IS NULL OR id != ?)
     LIMIT 1`,
    EMAIL_ISSUER,
    normalized,
    exceptAccountId,
    exceptAccountId,
    normalized,
    exceptAccountId,
    exceptAccountId,
  );
  return row?.account_id ?? null;
}

/**
 * Re-key links still holding the pre-I-01 literal `oidc` to the platform issuer (migrations/0059;
 * the 0068 backfill copied them verbatim). Runs before each portal OIDC sign-in, like I-01's
 * portal re-key; idempotent, and a single empty search once none is left. `OR IGNORE` leaves a
 * legacy row in place when the issuer-keyed row already exists.
 */
export async function rekeyLegacyAccountLinks(
  db: Db,
  issuerKey: string,
): Promise<void> {
  await db.run(
    `UPDATE OR IGNORE account_links SET issuer_key = ?
      WHERE issuer_key = ? AND tenant_scope = ''`,
    issuerKey,
    LEGACY_OIDC_ISSUER,
  );
}

export async function touchLink(
  db: Db,
  linkId: string,
  input: {
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
  },
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE account_links
        SET email = COALESCE(?, email),
            email_verified = CASE WHEN ? IS NOT NULL THEN ? ELSE email_verified END,
            display_name = COALESCE(?, display_name),
            last_used_at = ?
      WHERE id = ?`,
    input.email ? normalizeEmail(input.email) : null,
    input.email,
    input.emailVerified ? 1 : 0,
    input.displayName,
    now,
    linkId,
  );
}

export async function touchAccountSignIn(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE accounts SET last_sign_in_at = ? WHERE id = ?",
    now,
    accountId,
  );
}
