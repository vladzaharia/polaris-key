/**
 * The product `audit` rows that name an account's person, and their scrub on erasure (I-11;
 * S-16 §5.5: erasure "scrubs audit rows naming the account").
 *
 * `audit` is a product's console history, read by its developers, and a PERSON's identity reaches
 * it from these writers only: the portal's Discover claim (`license.create`, `portal/discover.ts`)
 * and the product sign-in's licence mint, merge, tier change and licence chooser (`oidc.ts`).
 * Each stores the person's platform IdP subject as `actor_sub`, their name and email as
 * `actor_name` and `actor_email`, and the email (or the subject) again inside `summary`. Erasure
 * removes the account; without this scrub those rows outlive it by up to 180 days (`pruneAudit`).
 *
 * ── WHICH ROWS ──────────────────────────────────────────────────────────────────────────────
 *
 * A row belongs to the account when BOTH hold:
 *
 *   1. Its actor is the account's identity: `actor_sub` equals the subject of one of the account's
 *      platform sign-in links (`account_links` with `kind = 'oidc'` and no tenant scope, the same
 *      subjects `syncAccountLicenseLinks` joins licences on, R5-02). Never an email, never a name:
 *      an address alone is not a link, and another person's row that merely shares it stays.
 *   2. It concerns that person's own licence: `target_kind = 'license'` and the licence (product +
 *      id) is one the account holds now, or one keyed by that very subject (a licence the account
 *      detached since keeps its `sub`); or it is the sign-in chooser's own row
 *      (`identity.signin.license_chosen`, which has no licence yet when the person asks for a new
 *      one). The second condition is what keeps an operator's console history: the console
 *      signs operators in at the same platform IdP, so a person who is also an operator shares
 *      the subject, and their actions on anyone else's licence, product or key must stay
 *      attributed. Erasing a portal account is never a way to anonymise console history.
 *
 * The product restriction (`product IN (...)`) is implied by the rest and written out so the
 * planner searches `idx_audit_time` by product, never scanning the whole table (R11-08).
 *
 * ── WHAT THE ROW BECOMES ────────────────────────────────────────────────────────────────────
 *
 * `actor_sub` becomes {@link ERASED_AUDIT_ACTOR}, `actor_name` and `actor_email` become NULL, and
 * `summary` becomes {@link ERASED_AUDIT_SUMMARY}. What stays is the event and its object: `product`,
 * `id`, `at`, `action`, `target_kind`, `target_id` and `parent_id` (and the settings columns, which
 * these writers never fill). The marker is a CONSTANT, not the account's tombstone id: the global
 * account id never reaches a developer (PX-W17, THREAT-MODEL item 12), and the same id in two
 * products' feeds would let their developers tell that one erased person acted in both. A NULL
 * `actor_sub` would not do either: the console reads it as a row Polaris Key itself wrote.
 *
 * The scrub is one statement in the erasure's final batch, ahead of the statements that delete the
 * links and detach the licences it reads, so it is atomic with them. It is idempotent: a scrubbed
 * row no longer carries the subject.
 */

import type { DbParam, DbStatement } from "../../../db/types.js";

/** The `actor_sub` of a row whose person erased their Polaris Key account. */
export const ERASED_AUDIT_ACTOR = "erased-account";
/** The `summary` of such a row (the original named the person). */
export const ERASED_AUDIT_SUMMARY =
  "Details removed when the account holder erased their account";
/** The sign-in licence chooser's audit action (`oidc.ts`); it can have no target licence. */
export const SIGNIN_LICENSE_CHOSEN_ACTION = "identity.signin.license_chosen";

/** The account's platform sign-in subjects (one `?`: the account id). */
const IDENTITY_SUBJECTS = `SELECT subject FROM account_links
        WHERE account_id = ? AND kind = 'oidc' AND tenant_scope = ''`;

/**
 * The `WHERE` clause (and its parameters) that selects the account's rows of `audit`. The table
 * must be named `audit`, unaliased: the clause refers to `audit.product` in a subquery. The same
 * clause scrubs the rows ({@link stmtScrubAccountAudit}) and lists them (an export of the
 * person's own activity), so what is exported is what is erased.
 */
export function accountAuditScope(accountId: string): {
  where: string;
  params: DbParam[];
} {
  return {
    where: `product IN (SELECT product FROM licenses WHERE account_id = ?
                         UNION
                         SELECT product FROM licenses WHERE sub IN (${IDENTITY_SUBJECTS}))
        AND actor_sub IN (${IDENTITY_SUBJECTS})
        AND (action = '${SIGNIN_LICENSE_CHOSEN_ACTION}'
             OR (target_kind = 'license'
                 AND EXISTS (SELECT 1 FROM licenses l
                              WHERE l.product = audit.product AND l.id = audit.target_id
                                AND (l.account_id = ? OR l.sub = audit.actor_sub))))`,
    params: [accountId, accountId, accountId, accountId],
  };
}

/**
 * Erasure: anonymise the account's rows of `audit`. Put it in the final batch BEFORE the links are
 * deleted and the licences detached, because the scope reads both.
 */
export function stmtScrubAccountAudit(accountId: string): DbStatement {
  const scope = accountAuditScope(accountId);
  return {
    sql: `UPDATE audit
             SET actor_sub = ?, actor_name = NULL, actor_email = NULL, summary = ?
           WHERE ${scope.where}`,
    params: [ERASED_AUDIT_ACTOR, ERASED_AUDIT_SUMMARY, ...scope.params],
  };
}
