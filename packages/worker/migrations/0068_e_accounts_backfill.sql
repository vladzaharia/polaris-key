-- I-05 (plans/I-04.md §6.1): the indexes on the new columns, then the backfill from the portal
-- tables into the account model. Every statement is idempotent (`IF NOT EXISTS`, `INSERT OR
-- IGNORE`, `UPDATE … WHERE account_id IS NULL`), so a replay, or a second run after the old Worker
-- wrote more portal rows during the deploy window, converges. The Worker repeats the same copy
-- for those late rows (`catchUpLegacyAccounts`, src/services/identity/accounts/legacy.ts), from
-- the scheduled job and on first sight of an account id it does not know.
--
-- Nothing is deleted or changed in `portal_*`: a Worker rolled back to before I-05 reads them as
-- they were. scripts/rollback/0068_accounts.down.sql copies back what the new Worker created.
--
-- Rehearsed on a production-shaped copy by test/accountsMigration.test.ts.

CREATE INDEX IF NOT EXISTS idx_licenses_account
  ON licenses(account_id, product) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_subject
  ON devices(product, subject) WHERE subject IS NOT NULL;

-- 1. portal_accounts → accounts, ids kept. The primary email is verified when the account holds
--    a verified `portal_account_emails` row for it.
INSERT OR IGNORE INTO accounts
  (id, status, primary_email, primary_email_verified_at, display_name,
   created_at, modified_at, last_sign_in_at)
SELECT a.id, a.status, a.primary_email,
       (SELECT e.verified_at FROM portal_account_emails e
         WHERE e.account_id = a.id AND e.email = a.primary_email AND e.verified_at > 0),
       a.display_name, a.created_at, a.modified_at, NULL
  FROM portal_accounts a;

-- 2. portal_account_identities → OIDC links, keyed by issuer (I-01). A row still holding the
--    legacy literal 'oidc' keeps it here and is re-keyed by the Worker at that user's next sign-in
--    (`rekeyLegacyAccountLinks`), exactly as I-01 does for the portal table. The portal wrote the
--    identity's email only when the IdP marked it verified (portal/auth.ts), so a present email
--    is a verified one.
INSERT OR IGNORE INTO account_links
  (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
   display_name, created_at, last_used_at)
SELECT 'lnk_' || lower(hex(randomblob(12))), i.account_id, i.provider, '', i.subject, 'oidc',
       i.email, CASE WHEN i.email IS NULL THEN 0 ELSE 1 END, i.display_name,
       i.created_at, i.last_seen_at
  FROM portal_account_identities i
  JOIN accounts a ON a.id = i.account_id;

-- 3. portal_account_emails → email links (the subject is the normalised address).
INSERT OR IGNORE INTO account_links
  (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
   display_name, created_at, last_used_at)
SELECT 'lnk_' || lower(hex(randomblob(12))), e.account_id, 'email', '', e.email, 'email',
       e.email, CASE WHEN e.verified_at > 0 THEN 1 ELSE 0 END, NULL,
       e.created_at, e.verified_at
  FROM portal_account_emails e
  JOIN accounts a ON a.id = e.account_id;

-- 4. portal_license_links → licenses.account_id, ONE owner per licence (§8 Q1, owner-approved):
--    the strongest link wins, oidc > email > admin > license-key, then the earliest, then the
--    lowest account id so a replay picks the same owner. The losers keep their portal row (so a
--    rollback still shows it) and are reported, emailed and have their licence-bound registry
--    tokens revoked by the Worker (`settleOwnershipConflicts`). A licence's `sub` alone never
--    attaches it here: it joins an account only through an existing link (I-17 claims the rest).
UPDATE licenses
   SET account_id = (
     SELECT l.account_id FROM portal_license_links l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.product = licenses.product AND l.license_id = licenses.id
      ORDER BY CASE l.source WHEN 'oidc' THEN 0 WHEN 'email' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
               l.created_at, l.account_id
      LIMIT 1)
 WHERE account_id IS NULL
   AND EXISTS (
     SELECT 1 FROM portal_license_links l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.product = licenses.product AND l.license_id = licenses.id);

-- 5. A pairwise subject for every (account, product) that holds a licence: first contact
--    happened before this migration. `ps_` + 22 hex characters (88 random bits) is inside the
--    `^ps_[A-Za-z0-9_-]{22}$` contract; the Worker mints 128-bit base64url ones from here on.
INSERT OR IGNORE INTO account_product_subjects (account_id, product, subject, created_at)
SELECT account_id, product, 'ps_' || substr(lower(hex(randomblob(11))), 1, 22),
       CAST(strftime('%s', 'now') AS INTEGER)
  FROM licenses
 WHERE account_id IS NOT NULL
 GROUP BY account_id, product;
