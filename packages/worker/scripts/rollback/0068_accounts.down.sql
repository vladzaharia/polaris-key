-- I-05 rollback: the `down` path of migrations 0068_a..e (plans/I-04.md §6.1).
--
-- WHEN. Only after rolling the Worker back to a build before I-05. That Worker reads the
-- untouched `portal_*` tables, so it serves every account that existed at the migration without
-- this script; what it cannot see is what the I-05 Worker CREATED afterwards. This script copies
-- those rows back, so nobody who signed up, added a sign-in method or attached a licence under
-- I-05 loses it on the way down.
--
-- WHAT THE I-05 WORKER ALREADY KEEPS IN STEP. Removals are mirrored into `portal_*` at the time
-- they happen, so a rollback never resurrects them: removing a sign-in method deletes its portal
-- row, a detach or relink deletes every portal link to that licence (every account's), an account
-- deletion deletes every portal row of the account, a disable sets the portal status too, and a
-- merge deletes the absorbed account's portal rows (this script then re-creates the survivor's
-- from the moved links and licences).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0068_accounts.down.sql
-- Every statement is idempotent (`INSERT OR IGNORE`, one guarded `UPDATE`), so a second run is a no-op. It leaves the
-- I-05 tables and columns in place (dropping them is not needed for the old Worker, and keeping
-- them lets a roll-forward pick up where it stopped). It is exercised by
-- test/accountsMigration.test.ts.

-- Accounts created by the I-05 Worker.
INSERT OR IGNORE INTO portal_accounts (id, status, display_name, primary_email, created_at, modified_at)
SELECT id, CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'active' END, display_name,
       primary_email, created_at, modified_at
  FROM accounts
 WHERE status != 'deleted';

-- A disable the I-05 Worker made (it mirrors it too; this covers a disable from before that fix).
UPDATE portal_accounts SET status = 'disabled'
 WHERE status != 'disabled' AND id IN (SELECT id FROM accounts WHERE status = 'disabled');

-- OIDC sign-in methods (the old Worker knows only the platform issuer's).
INSERT OR IGNORE INTO portal_account_identities
  (provider, subject, account_id, email, display_name, created_at, last_seen_at)
SELECT issuer_key, subject, account_id, email, display_name, created_at, last_used_at
  FROM account_links
 WHERE kind = 'oidc' AND tenant_scope = ''
   AND account_id IN (SELECT id FROM portal_accounts);

-- Email sign-in methods.
INSERT OR IGNORE INTO portal_account_emails (email, account_id, verified_at, created_at)
SELECT subject, account_id, CASE WHEN email_verified = 1 THEN last_used_at ELSE 0 END, created_at
  FROM account_links
 WHERE kind = 'email'
   AND account_id IN (SELECT id FROM portal_accounts);

-- Licence ownership.
INSERT OR IGNORE INTO portal_license_links
  (account_id, product, license_id, source, created_at, last_seen_at)
SELECT account_id, product, id, 'license-key', modified_at, modified_at
  FROM licenses
 WHERE account_id IS NOT NULL
   AND account_id IN (SELECT id FROM portal_accounts);
