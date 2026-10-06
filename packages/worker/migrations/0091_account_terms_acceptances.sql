-- PX-W15 (PORTAL.md §4.29, §10.2 G31): a product's terms, accepted at the email gate, kept per
-- account, product and terms version.
--
-- One row per acceptance. A new terms version adds a row and never overwrites the earlier one, so
-- the record of what the person agreed to, and when, survives the next version (I-07 kept only
-- the latest version per product in `accounts.terms_json`). `url` is the terms document the gate
-- showed for that version. The gate asks again whenever the product's current version has no row
-- for the account.
--
-- Lifecycle: a merge moves the absorbed account's rows to the survivor (the survivor's own row
-- wins for a version both accepted); deleting the account erases them; deleting the product erases
-- that product's rows.
--
-- `accounts.terms_json` stays (expand-only) but is no longer read or written. No deployed Worker
-- ever wrote it: no front door passes a product's terms to the gate before I-08 and I-09, so
-- there is nothing to copy. It is dropped by the contract-phase migration after I-17, with the
-- `portal_*` tables. A Worker rolled back past this migration reads `terms_json` and at worst asks
-- for terms again, which is the safe direction.
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): Identity. Idempotent: a replay
-- converges (R11-04).

CREATE TABLE IF NOT EXISTS account_terms_acceptances (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,
  version     TEXT NOT NULL,
  url         TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product, version)
);

-- Product deletion clears a product's rows across accounts.
CREATE INDEX IF NOT EXISTS idx_account_terms_acceptances_product
  ON account_terms_acceptances(product);
