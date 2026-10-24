-- I-28.1: the guarded purge of the four contract `portal_*` tables (accounts contract, release N).
--
-- Nothing in the Worker writes these tables any more (the account model is the only writer, and
-- the mirrors stop in this release), so they are emptied here and dropped by I-28b no sooner than
-- 14 days after this release is live (RUNBOOK -> Migration ledger, "Portal tables"). Emptying
-- them first also makes `scripts/rollback/0068_accounts.down.sql` exact again: it rebuilds all
-- four from the account model.
--
-- THE GUARD. Every DELETE runs only while `leftovers` is 0: the sum of four counts of portal rows
-- the account model does not hold (an account in neither `accounts` nor `account_tombstones`; an
-- identity or an email of an existing account with no matching `account_links` row; a licence
-- link whose licence is floating or held by another account). They are the same four counts, as
-- named columns, that `scripts/portal-contract-check.sql` reports. If any is above 0 NOTHING is
-- deleted and the migration still succeeds, so a deploy is never blocked by it; the lead reads the
-- check and decides.
--
-- ALL OR NOTHING, REPLAY-SAFE. Deleting rows cannot create a leftover (every count is over rows of
-- these tables, restricted by what the account model holds), and no statement changes a table
-- the counts read other than the four being emptied. So the four statements all see 0 or all see
-- the same non-zero total, and a half-applied run that is replayed finishes the job. A replay on
-- empty tables is a no-op. Children first, so the cascade foreign keys never fire.
--
-- Rows only; the tables, their indexes and `portal_audit` / `portal_product_settings` stay.
-- Down: `scripts/rollback/0068_accounts.down.sql` (the rows come back from the account model).
-- 0140_b_index_assertion.sql drops the three portal indexes from the required set.

WITH leftovers(n) AS (
  SELECT
      (SELECT COUNT(*) FROM portal_accounts p
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM account_tombstones t WHERE t.id = p.id)) +
      (SELECT COUNT(*) FROM portal_account_identities i
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = i.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.account_id = i.account_id AND l.subject = i.subject
                         AND l.kind = 'oidc' AND l.tenant_scope = '')) +
      (SELECT COUNT(*) FROM portal_account_emails e
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.kind = 'email' AND l.subject = e.email
                         AND l.account_id = e.account_id)) +
      (SELECT COUNT(*) FROM portal_license_links k
    WHERE EXISTS (SELECT 1 FROM licenses li
                   WHERE li.product = k.product AND li.id = k.license_id
                     AND (li.account_id IS NULL OR li.account_id != k.account_id)))
)
DELETE FROM portal_license_links WHERE (SELECT n FROM leftovers) = 0;

WITH leftovers(n) AS (
  SELECT
      (SELECT COUNT(*) FROM portal_accounts p
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM account_tombstones t WHERE t.id = p.id)) +
      (SELECT COUNT(*) FROM portal_account_identities i
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = i.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.account_id = i.account_id AND l.subject = i.subject
                         AND l.kind = 'oidc' AND l.tenant_scope = '')) +
      (SELECT COUNT(*) FROM portal_account_emails e
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.kind = 'email' AND l.subject = e.email
                         AND l.account_id = e.account_id)) +
      (SELECT COUNT(*) FROM portal_license_links k
    WHERE EXISTS (SELECT 1 FROM licenses li
                   WHERE li.product = k.product AND li.id = k.license_id
                     AND (li.account_id IS NULL OR li.account_id != k.account_id)))
)
DELETE FROM portal_account_identities WHERE (SELECT n FROM leftovers) = 0;

WITH leftovers(n) AS (
  SELECT
      (SELECT COUNT(*) FROM portal_accounts p
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM account_tombstones t WHERE t.id = p.id)) +
      (SELECT COUNT(*) FROM portal_account_identities i
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = i.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.account_id = i.account_id AND l.subject = i.subject
                         AND l.kind = 'oidc' AND l.tenant_scope = '')) +
      (SELECT COUNT(*) FROM portal_account_emails e
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.kind = 'email' AND l.subject = e.email
                         AND l.account_id = e.account_id)) +
      (SELECT COUNT(*) FROM portal_license_links k
    WHERE EXISTS (SELECT 1 FROM licenses li
                   WHERE li.product = k.product AND li.id = k.license_id
                     AND (li.account_id IS NULL OR li.account_id != k.account_id)))
)
DELETE FROM portal_account_emails WHERE (SELECT n FROM leftovers) = 0;

WITH leftovers(n) AS (
  SELECT
      (SELECT COUNT(*) FROM portal_accounts p
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM account_tombstones t WHERE t.id = p.id)) +
      (SELECT COUNT(*) FROM portal_account_identities i
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = i.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.account_id = i.account_id AND l.subject = i.subject
                         AND l.kind = 'oidc' AND l.tenant_scope = '')) +
      (SELECT COUNT(*) FROM portal_account_emails e
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id)
      AND NOT EXISTS (SELECT 1 FROM account_links l
                       WHERE l.kind = 'email' AND l.subject = e.email
                         AND l.account_id = e.account_id)) +
      (SELECT COUNT(*) FROM portal_license_links k
    WHERE EXISTS (SELECT 1 FROM licenses li
                   WHERE li.product = k.product AND li.id = k.license_id
                     AND (li.account_id IS NULL OR li.account_id != k.account_id)))
)
DELETE FROM portal_accounts WHERE (SELECT n FROM leftovers) = 0;
