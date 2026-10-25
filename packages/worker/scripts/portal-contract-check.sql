-- I-28.1: the production precondition for migrations/0141_a_portal_contract_purge.sql.
--
-- Read-only. Run it against the environment BEFORE the release that carries the purge deploys:
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/portal-contract-check.sql
-- One row, four counts of `portal_*` rows the account model does not yet hold. All four at 0 means
-- the purge deletes the four tables' rows and loses nothing; any other value means the purge
-- deletes NOTHING (its DELETEs are guarded by the sum of these same counts), and the leftovers are
-- the lead's to review. The migration repeats these four subqueries; test/services/identity/portalContractPurge.test.ts
-- runs both against the same fixtures.
--
--   unmigrated_accounts      `portal_accounts` ids in neither `accounts` nor `account_tombstones`.
--   identities_without_link  identities of an existing account with no `account_links` row (same
--                            account and subject, kind 'oidc', global scope).
--   emails_without_link      emails of an existing account with no `account_links` row (same
--                            account, kind 'email', subject = the address).
--   unsettled_license_links  links whose licence is floating or held by another account (the
--                            unsettled ownership conflict legacy.ts used to settle).

SELECT
  (SELECT COUNT(*) FROM portal_accounts p
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM account_tombstones t WHERE t.id = p.id))
    AS unmigrated_accounts,
  (SELECT COUNT(*) FROM portal_account_identities i
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = i.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.account_id = i.account_id AND l.subject = i.subject
                         AND l.kind = 'oidc' AND l.tenant_scope = ''))
    AS identities_without_link,
  (SELECT COUNT(*) FROM portal_account_emails e
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.kind = 'email' AND l.subject = e.email
                         AND l.account_id = e.account_id))
    AS emails_without_link,
  (SELECT COUNT(*) FROM portal_license_links k
    WHERE EXISTS (SELECT 1 FROM licenses li
                   WHERE li.product = k.product AND li.id = k.license_id
                     AND (li.account_id IS NULL OR li.account_id != k.account_id)))
    AS unsettled_license_links;
