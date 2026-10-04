-- F-03 (plans/F-01.md §6.4) — `release_deliverables` learns the third kind, `package`.
--
-- 0027_a pinned `CHECK (kind IN ('app', 'pack'))`, and SQLite cannot change a CHECK in place, so
-- the table is rebuilt with `'package'` added and two columns a package deliverable carries:
-- `ecosystem` (one of @polaris-key/manifest's PACKAGE_ECOSYSTEMS) and `package_name` (the declared
-- name). Both are NULL for the app and for packs (a CHECK). A package's are required by the code
-- that writes it (`stmtUpsertDeliverable`), not by a CHECK, and both repeat its `def_json`: the
-- copy below names only 0027_a's columns, so a full replay over an already-migrated database
-- (which D1's migration bookkeeping never runs) keeps every row and loses only these two
-- derived columns, which the product's next resync writes again.
--
-- WHY THE CHILD ROWS ARE SET ASIDE FIRST (a correction to the plan's `defer_foreign_keys`).
--
-- Two tables hold foreign keys into `release_deliverables`: `release_channel_policy` (0027_a) and
-- `release_pack_floors` (0046_a). With foreign keys enforced (D1 always enforces them), dropping a
-- parent that still has child rows runs an implicit DELETE that violates them. Deferring the check
-- (`PRAGMA defer_foreign_keys = ON`) does not help: SQLite counts the violations the implicit
-- DELETE makes and never recounts them when the renamed copy brings the parent rows back, so the
-- transaction still fails at its end. So the child rows are copied aside, removed, and put back
-- after the rename — the parent is then dropped with no child pointing at it, under any pragma.
--
-- EVERY STEP IS REPLAY-SAFE (the 0017 discipline: D1 may run this file with no wrapping
-- transaction, so it must converge from any point it dies at):
--
--   * the set-aside tables are `CREATE … IF NOT EXISTS … AS SELECT … WHERE 0` and filled with
--     `INSERT … SELECT`; a replay may copy a row twice, which the restore's `INSERT OR IGNORE`
--     (each child's primary key) absorbs;
--   * `CREATE TABLE IF NOT EXISTS release_deliverables`, FIRST, closes the window between the drop
--     and the rename, as in 0017: a replay recreates the original empty (before anything touches
--     a child table, whose writes need their parent table to exist), copies nothing into a `_v2`
--     that holds every row already, drops the shell and renames `_v2` into place;
--   * the restore runs only after the rename, and the set-aside tables are dropped last.
--
-- The rebuild is forward-only, like 0016: an older Worker reads and writes the table unchanged
-- (no column is renamed or removed), but rolling the SCHEMA back past this file needs the rows of
-- kind `package` removed first (docs/RUNBOOK.md, "Package feeds").

CREATE TABLE IF NOT EXISTS release_deliverables (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  pack_type       TEXT,
  def_json        TEXT,
  def_source      TEXT NOT NULL DEFAULT 'manifest',
  created_at      INTEGER NOT NULL,
  modified_at     INTEGER NOT NULL,
  PRIMARY KEY (product, deliverable_id),
  CHECK (kind IN ('app', 'pack'))
);

CREATE TABLE IF NOT EXISTS release_channel_policy_f03 AS
  SELECT * FROM release_channel_policy WHERE 0;
CREATE TABLE IF NOT EXISTS release_pack_floors_f03 AS
  SELECT * FROM release_pack_floors WHERE 0;
INSERT INTO release_channel_policy_f03 SELECT * FROM release_channel_policy;
INSERT INTO release_pack_floors_f03 SELECT * FROM release_pack_floors;
DELETE FROM release_pack_floors;
DELETE FROM release_channel_policy;

CREATE TABLE IF NOT EXISTS release_deliverables_v2 (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  pack_type       TEXT,
  def_json        TEXT,
  def_source      TEXT NOT NULL DEFAULT 'manifest',
  created_at      INTEGER NOT NULL,
  modified_at     INTEGER NOT NULL,
  ecosystem       TEXT,
  package_name    TEXT,
  PRIMARY KEY (product, deliverable_id),
  CHECK (kind IN ('app', 'pack', 'package')),
  CHECK (kind = 'package' OR (ecosystem IS NULL AND package_name IS NULL))
);

INSERT OR IGNORE INTO release_deliverables_v2
  (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at)
SELECT product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at
  FROM release_deliverables;

DROP TABLE release_deliverables;

ALTER TABLE release_deliverables_v2 RENAME TO release_deliverables;

INSERT OR IGNORE INTO release_channel_policy SELECT * FROM release_channel_policy_f03;
INSERT OR IGNORE INTO release_pack_floors SELECT * FROM release_pack_floors_f03;
DROP TABLE IF EXISTS release_channel_policy_f03;
DROP TABLE IF EXISTS release_pack_floors_f03;
