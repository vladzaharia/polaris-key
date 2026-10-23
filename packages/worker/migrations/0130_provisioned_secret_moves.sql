-- U-27.6: the ledger of the P0-49 job `core.provisioned-secrets-to-account`.
--
-- The job moves a provisioned secret from an owned licence's `overrides_json` column up one layer
-- to the owner's account overrides row (`account_overrides`). One row per (product, licence, key)
-- it removed from a column, so the job's `down` is exact. NO VALUES ARE STORED: the moved entry
-- lives on the account row, and `entry_sha256` (SHA-256 of its canonical JSON) lets `down` prove
-- the row still holds it before putting the entry back. A copy removed
-- because the account entry above it already held the key (`shadowed = 1`) is restored from that
-- entry when its hash still matches.
--
--   subject            the owner's pairwise subject (erased with it: the `core.provisionedSecretMoves`
--                      subject store, and `deleteProduct` and licence deletion).
--   added_to_account   1 when this move put the entry on the account row.
--   position           the key's index in the licence's `secrets` object, so `down` puts it back in place.
--
-- Core owns the table (TABLE_OWNERS). Expand-only: a Worker deployed before this migration never
-- names it. Dropped in U-27b with the job. Rollback:
-- scripts/rollback/0130_provisioned_secret_moves.down.sql.
CREATE TABLE IF NOT EXISTS provisioned_secret_moves (
  product          TEXT NOT NULL,
  license_id       TEXT NOT NULL,
  key              TEXT NOT NULL,
  subject          TEXT NOT NULL,
  entry_sha256     TEXT NOT NULL,
  added_to_account INTEGER NOT NULL CHECK (added_to_account IN (0, 1)),
  shadowed         INTEGER NOT NULL DEFAULT 0 CHECK (shadowed IN (0, 1)),
  position         INTEGER NOT NULL DEFAULT 0,
  run_id           TEXT NOT NULL,
  at               INTEGER NOT NULL,
  PRIMARY KEY (product, license_id, key)
);
