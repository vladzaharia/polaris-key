-- U-09.9 (plans/U-09-slices.md §2.4, D8): the Cloud Sync directory keeps a person's record bytes.
-- The number 0149 is provisional: the lead renumbers this file and its rollback at merge.
-- `sync_directory.bytes` is every kind together and `records` a count; the Usage page and the
-- product aggregate need the records' bytes on their own, so settings are told apart from records
-- without waking an object. The object writes it with the rest of the row after a push or an
-- absorb. Rows written before this migration read 0 until the person's next flush.
-- Owned by `sync` (TABLE_OWNERS: sync_directory already is). Expand-only: a Worker built before
-- this migration never names the column. Rollback:
-- scripts/rollback/0149_sync_directory_record_bytes.down.sql.
ALTER TABLE sync_directory ADD COLUMN record_bytes INTEGER NOT NULL DEFAULT 0;
