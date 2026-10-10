/**
 * Terms acceptances (PX-W15; PORTAL.md §4.29, §10.2 G31): a product's terms, accepted at the email
 * gate, stored per account, product and terms version in `account_terms_acceptances`.
 *
 *   - The gate asks while the product's CURRENT version has no row for the account, so a new
 *     version asks again and the same version never does.
 *   - A row is written once: accepting a version again (another browser, a race) keeps the first
 *     acceptance's time and URL, and a later version adds a row beside the earlier ones. The table
 *     is the record of what the person agreed to and when.
 *   - A merge moves the absorbed account's rows to the survivor (`stmtsMoveTermsAcceptances`);
 *     deleting the account erases them (`stmtDeleteTermsAcceptances`); deleting the product erases
 *     the product's rows (`deleteProduct`).
 *   - Polaris Key's own terms (I-33, `identity.platformTerms`) are rows of the same table under
 *     the product `_platform` (`PLATFORM_TERMS_PRODUCT`), which no product slug can be. Only a
 *     terms document is accepted: a privacy notice is linked beside it and gets no row.
 *
 * `accounts.terms_json` (I-05's column) is superseded and neither read nor written (see the
 * migration's header).
 */

import type { Db, DbStatement } from "../../../db/types.js";
import type { Delivery } from "../../../core/hooks.js";
import { httpsUrl, TERMS_VERSION_RE } from "../../../core/platformTerms.js";

/**
 * Terms the gate asks for: a product's (`identity.terms`, I-09's setting) with its URLs resolved
 * by `productTerms`, or Polaris Key's (`core/platformTerms.ts`, recorded under `_platform`).
 */
export interface TermsRequirement {
  /** The terms document the gate shows and the acceptance row keeps. */
  url: string;
  version: string;
  /** I-33: the privacy notice linked beside the terms. It informs, so it gets no row. */
  privacyUrl?: string | null;
}

/** What a product declares (`identity.terms {version, url?}`, plans/I-27.md §3). */
export interface DeclaredTerms {
  version: string;
  url?: string | null;
}

/**
 * A product's terms with their URLs (I-33; plans/I-27.md §2.4): `url` defaults to the listing's
 * `eulaUrl`, and the listing's `privacyUrl` is linked beside it. `null` when nothing is declared,
 * the version is not one, or no https terms URL resolves: there is nothing to accept. The front
 * door that passes a product's terms to the gate (I-08's, reading I-09's setting) calls this
 * with the product's `delivery` hook, which is `null` while Distribution is off.
 */
export async function productTerms(
  declared: DeclaredTerms | null,
  delivery: Pick<Delivery, "legalUrls"> | null,
): Promise<TermsRequirement | null> {
  if (!declared || !TERMS_VERSION_RE.test(declared.version)) return null;
  const listing = (await delivery?.legalUrls?.()) ?? {
    eulaUrl: null,
    privacyUrl: null,
  };
  const url = httpsUrl(declared.url) ?? listing.eulaUrl;
  if (!url) return null;
  return { version: declared.version, url, privacyUrl: listing.privacyUrl };
}

export interface TermsAcceptanceRow {
  product: string;
  version: string;
  url: string;
  accepted_at: number;
}

/** Whether `accountId` accepted `version` of `product`'s terms. */
export async function termsAccepted(
  db: Db,
  accountId: string,
  product: string,
  version: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM account_terms_acceptances
      WHERE account_id = ? AND product = ? AND version = ?`,
    accountId,
    product,
    version,
  );
  return row !== null;
}

/** Record an acceptance. The first acceptance of a version stands; a repeat changes nothing. */
export function stmtRecordTermsAcceptance(
  accountId: string,
  product: string,
  terms: TermsRequirement,
  now: number,
): DbStatement {
  return {
    sql: `INSERT OR IGNORE INTO account_terms_acceptances
            (account_id, product, version, url, accepted_at)
          VALUES (?, ?, ?, ?, ?)`,
    params: [accountId, product, terms.version, terms.url, now],
  };
}

export async function recordTermsAcceptance(
  db: Db,
  accountId: string,
  product: string,
  terms: TermsRequirement,
  now: number,
): Promise<void> {
  const stmt = stmtRecordTermsAcceptance(accountId, product, terms, now);
  await db.run(stmt.sql, ...stmt.params);
}

/** Every acceptance of an account, per product, oldest first. */
export async function termsAcceptancesOf(
  db: Db,
  accountId: string,
): Promise<TermsAcceptanceRow[]> {
  return db.all<TermsAcceptanceRow>(
    `SELECT product, version, url, accepted_at FROM account_terms_acceptances
      WHERE account_id = ? ORDER BY product, accepted_at, version`,
    accountId,
  );
}

/**
 * A merge (I-05, D21): the absorbed account's acceptances become the survivor's. Where both
 * accepted the same version, the survivor's row stands.
 */
export function stmtsMoveTermsAcceptances(
  survivor: string,
  absorbed: string,
): DbStatement[] {
  return [
    {
      sql: `INSERT OR IGNORE INTO account_terms_acceptances
              (account_id, product, version, url, accepted_at)
            SELECT ?, product, version, url, accepted_at
              FROM account_terms_acceptances WHERE account_id = ?`,
      params: [survivor, absorbed],
    },
    {
      sql: "DELETE FROM account_terms_acceptances WHERE account_id = ?",
      params: [absorbed],
    },
  ];
}

/** Account deletion: no acceptance outlives the account. */
export function stmtDeleteTermsAcceptances(accountId: string): DbStatement {
  return {
    sql: "DELETE FROM account_terms_acceptances WHERE account_id = ?",
    params: [accountId],
  };
}
