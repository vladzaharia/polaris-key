-- ST-32.3 rollback: the `down` path of migration 0149_link_asserted_connection.sql.
--
-- WHEN. Only after rolling the Worker back to a build before ST-32.3, which never names the column.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0149_link_asserted_connection.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

ALTER TABLE account_links DROP COLUMN asserted_connection_id;
