-- LX-26 (notes/S-24 §5.5, §6.1, D19): a licence removed from a library stays out of it.
--
-- An assigned licence joins the account that verified its email automatically (D3): at creation,
-- at the email's verification, and on the portal's per-request link sweep. Before this table,
-- "Remove from my library" (`detachLicense`) cleared `licenses.account_id` but kept the licence's
-- email, so the next portal request attached it again (S-24 H5). One row here says "never attach
-- this licence to this account automatically again". It is per account: another account that
-- verifies the same email still gets it, and the person can always add it back with its key.
--
--   product, license_id  the licence (`licenses`), keyed like every licence row
--   account_id           the account it must not rejoin automatically. INTERNAL: the global
--                        account id never leaves the Worker's Identity and Core code (S-16 §5.1)
--   created_at           when the block was written (epoch seconds)
--
-- Written by `detachLicense` and by a reassignment away from an account (`reassignLicense`, I-12);
-- read by the link sweep, the verification hook and the creation-time association
-- (`core/licenseHolders.ts`); removed when the licence moves back into that account (a key claim,
-- a reassignment's undo), moved to the survivor by an account merge, removed by the account's
-- deletion and by the licence's deletion.
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): Core. Expand-only; every
-- statement is `IF NOT EXISTS`, so a replay converges (R11-04).
CREATE TABLE IF NOT EXISTS license_auto_attach_blocks (
  product    TEXT NOT NULL,
  license_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, license_id, account_id)
);
-- A merge moves an account's rows and a deletion removes them.
CREATE INDEX IF NOT EXISTS idx_license_auto_attach_blocks_account
  ON license_auto_attach_blocks(account_id);
