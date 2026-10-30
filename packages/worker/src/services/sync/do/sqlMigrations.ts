/**
 * The Durable Object store's schema, one entry per version (extracted from `sqlStore.ts`, which
 * re-exports both names). Each version is applied lazily, in one transaction with the version
 * row, by `SqlStore.prepare`. A schema from a newer build is refused, never rewritten.
 */

/** The schema version this build writes. A newer one in storage is refused, never rewritten. */
export const SCHEMA_VERSION = 4;

/** Steps to reach each version; `MIGRATIONS[n - 1]` takes a store from version n - 1 to n. */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS settings (
       scope TEXT NOT NULL, family TEXT NOT NULL, key TEXT NOT NULL,
       version INTEGER NOT NULL, hlc TEXT NOT NULL, client_id TEXT NOT NULL,
       value_json TEXT NOT NULL, is_merge INTEGER NOT NULL,
       floor_hlc TEXT, floor_client TEXT,
       PRIMARY KEY (scope, family, key)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS settings_version ON settings (version)`,
    `CREATE TABLE IF NOT EXISTS tombstones (
       scope TEXT NOT NULL, family TEXT NOT NULL, key TEXT NOT NULL,
       version INTEGER NOT NULL, hlc TEXT NOT NULL, client_id TEXT NOT NULL,
       value_json TEXT NOT NULL, is_merge INTEGER NOT NULL,
       floor_hlc TEXT, floor_client TEXT,
       PRIMARY KEY (scope, family, key)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS tombstones_version ON tombstones (version)`,
    `CREATE TABLE IF NOT EXISTS setting_members (
       ord INTEGER PRIMARY KEY AUTOINCREMENT,
       scope TEXT NOT NULL, family TEXT NOT NULL, key TEXT NOT NULL, member TEXT NOT NULL,
       value_json TEXT NOT NULL, removed INTEGER NOT NULL, hlc TEXT NOT NULL, client_id TEXT NOT NULL,
       UNIQUE (scope, family, key, member))`,
    `CREATE TABLE IF NOT EXISTS clients (
       client_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL) WITHOUT ROWID`,
  ],
  // v2 (U-05.9): when a client last pushed (epoch seconds), so an idle binding can expire.
  // Existing rows start their idle clock at the migration.
  [
    `ALTER TABLE clients ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0`,
    `UPDATE clients SET last_seen = CAST(strftime('%s', 'now') AS INTEGER)`,
  ],
  // v3 (U-09.3, plans/U-09-slices.md §2.1): Cloud Sync records, and the key id of sealed writes.
  [
    `CREATE TABLE IF NOT EXISTS records (
       collection TEXT NOT NULL, id TEXT NOT NULL,
       version INTEGER NOT NULL, hlc TEXT NOT NULL, client_id TEXT NOT NULL,
       value_json TEXT NOT NULL, kind TEXT NOT NULL, deleted INTEGER NOT NULL,
       floor_hlc TEXT, floor_client TEXT, kid TEXT,
       PRIMARY KEY (collection, id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS records_version ON records (version)`,
    `CREATE INDEX IF NOT EXISTS records_live ON records (collection, deleted)`,
    `CREATE INDEX IF NOT EXISTS records_dead ON records (deleted, hlc, client_id)`,
    `CREATE TABLE IF NOT EXISTS record_fields (
       ord INTEGER PRIMARY KEY AUTOINCREMENT,
       collection TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL,
       value_json TEXT NOT NULL, removed INTEGER NOT NULL, hlc TEXT NOT NULL, client_id TEXT NOT NULL,
       kid TEXT,
       UNIQUE (collection, id, field))`,
    `CREATE INDEX IF NOT EXISTS record_fields_dead ON record_fields (removed, collection, hlc, client_id)`,
    `CREATE TABLE IF NOT EXISTS set_elements (
       collection TEXT NOT NULL, id TEXT NOT NULL, element_key TEXT NOT NULL,
       element_json TEXT NOT NULL, add_tag INTEGER NOT NULL, kid TEXT,
       PRIMARY KEY (collection, id, element_key, add_tag)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS parked_records (
       collection TEXT NOT NULL, id TEXT NOT NULL, from_subject TEXT NOT NULL, kind TEXT NOT NULL,
       value_json TEXT, fields_json TEXT, elements_json TEXT,
       hlc TEXT NOT NULL, client_id TEXT NOT NULL, kid TEXT, parked_at INTEGER NOT NULL,
       PRIMARY KEY (collection, id, from_subject)) WITHOUT ROWID`,
    `ALTER TABLE settings ADD COLUMN kid TEXT`,
    `ALTER TABLE tombstones ADD COLUMN kid TEXT`,
    `ALTER TABLE setting_members ADD COLUMN kid TEXT`,
  ],
  // v4 (U-10.4, plans/U-10-U-11a-slices.md §2.1): files on records, their upload sessions and the
  // SSE-C keys of server-mode files. Nothing existing changes; an object with no file has empty
  // tables.
  [
    `CREATE TABLE IF NOT EXISTS files (
       collection TEXT NOT NULL, record_id TEXT NOT NULL, version INTEGER NOT NULL,
       object_key TEXT NOT NULL, format TEXT NOT NULL, enc TEXT NOT NULL,
       size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL,
       ssec_kid TEXT, created_at INTEGER NOT NULL, client_id TEXT NOT NULL,
       PRIMARY KEY (collection, record_id, version)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS files_status ON files (status)`,
    `CREATE TABLE IF NOT EXISTS uploads (
       upload_id TEXT PRIMARY KEY, collection TEXT NOT NULL, record_id TEXT NOT NULL,
       base_version INTEGER, mode TEXT NOT NULL, format TEXT NOT NULL, enc TEXT NOT NULL,
       size INTEGER NOT NULL, sha256 TEXT NOT NULL, part_bytes INTEGER, multipart_id TEXT,
       reserved_bytes INTEGER NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL, state TEXT NOT NULL, result_json TEXT) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS uploads_expires ON uploads (expires_at)`,
    `CREATE TABLE IF NOT EXISTS upload_parts (
       upload_id TEXT NOT NULL, n INTEGER NOT NULL, etag TEXT NOT NULL, bytes INTEGER NOT NULL,
       PRIMARY KEY (upload_id, n)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ssec_keys (
       kid TEXT PRIMARY KEY, key BLOB NOT NULL) WITHOUT ROWID`,
  ],
];

if (MIGRATIONS.length !== SCHEMA_VERSION)
  throw new Error("sqlStore: SCHEMA_VERSION and MIGRATIONS disagree");
