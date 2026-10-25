-- U-27.6 rollback: the `down` path of migration 0133_provisioned_secret_moves.sql.
--
-- WHEN. Only after rolling the Worker back to a build before U-27.6. That Worker never names the
-- table. Run the job's own `down` first (Platform -> Migrations, `core.provisioned-secrets-to-account`)
-- if any apply finished: the ledger is the only record of which entries to put back on which
-- licence, and dropping it makes the move permanent (the old Worker still reads both layers).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0133_provisioned_secret_moves.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS provisioned_secret_moves;
