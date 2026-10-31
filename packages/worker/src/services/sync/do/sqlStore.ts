/**
 * `SyncStore` over a Durable Object's SQLite database (U-05.6; plans/U-05-slices.md §3). The
 * engine's rules are `engine/`'s and run unchanged; this file only persists them, so the same
 * suites that drive the in-memory store drive this one (`test/cloudSyncSqlParity*.test.ts`).
 *
 * Tables (one database per product × subject object, so no statement names a subject):
 *   meta             key/value: schema_version, product, subject (the pin), seq, watermark, usage_*
 *   settings         live rows, PK (scope, family, key); family is '' for `user` rows
 *   tombstones       deleted rows (the clear's stamp), same key, so a later edit still wins
 *   setting_members  the merge cells of a row, live or removed, in the engine's order
 *   clients          clientId -> first device, last processed mutation id, last push (v2: idle ones expire)
 *   records          v3 (U-09): one row per (collection, id), live or tombstone, `kind` value|fields|set
 *   record_fields    v3: the cells of a `merge` record, live or removed (mirrors setting_members)
 *   set_elements     v3: the tagged elements of a `union` record, one row per live add tag
 *   parked_records   v3: a colliding `revision` record an account merge parked instead of overwriting
 *   files            v4 (U-10): one row per (collection, record, version): the R2 key, size, hash, status
 *   uploads          v4: one row per file upload session, from `begin` to the end of its retention
 *   upload_parts     v4: the parts a session has received (a single `PUT` is part 1)
 *   ssec_keys        v4: the SSE-C key of a server-mode file, referenced by `files.ssec_kid`
 *   (v3 also adds a nullable `kid` to settings, tombstones and setting_members: the envelope key id
 *   of a sealed write; rows written before it stay NULL and are not backfilled)
 *
 * A row moves between `settings` and `tombstones` as `deleted` flips; its members stay put.
 *
 * Lazy: an object that was never written has no tables. Reads answer from "no schema" as an empty
 * store without creating anything (a pull never writes: T14); `prepare(true)` creates the schema
 * (the first write) and `prepare(false)` only migrates one that already exists. Every statement
 * is parameterised: nothing here concatenates a value into SQL.
 */

import type { SyncJson, SyncScope } from "@polaris-key/protocol/sync";
import { FileTables } from "./sqlFiles.js";
import { SCHEMA_VERSION, MIGRATIONS } from "./sqlMigrations.js";
import {
  readFloorAndKid,
  RecordTables,
  settle,
  type Row,
} from "./sqlRecords.js";
import { inspectTables, type InspectTables } from "./sqlInspect.js";
import type {
  ClientRecord,
  MemberCell,
  ParkedRecord,
  RemovedField,
  StoredFile,
  StoredRecord,
  StoredSetting,
  StoreUsage,
  SyncStore,
  UploadPart,
  UploadRow,
} from "../engine/types.js";
import { compactUsage } from "../engine/usage.js";

export { MIGRATIONS, SCHEMA_VERSION } from "./sqlMigrations.js";

/** Rows the SQL API read and wrote for one operation. Counts only, never a value or a name. */
export interface RowMeter {
  rowsRead: number;
  rowsWritten: number;
}

/** What a storage handle must offer: the SQL API and a synchronous transaction. */
export interface SqlHandle {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

interface SettingRow extends Row {
  scope: string;
  family: string;
  key: string;
  version: number;
  hlc: string;
  client_id: string;
  value_json: string;
  is_merge: number;
  floor_hlc: string | null;
  floor_client: string | null;
  kid: string | null;
}

interface MemberRow extends Row {
  member: string;
  value_json: string;
  removed: number;
  hlc: string;
  client_id: string;
  kid: string | null;
}

export class SqlStore implements SyncStore {
  private schema: "unknown" | "absent" | "ready" = "unknown";
  private readonly recordTables = new RecordTables({
    all: (q, ...b) => this.all(q, ...b),
    run: (q, ...b) => this.run(q, ...b),
  });
  private readonly fileTables = new FileTables({
    all: (q, ...b) => this.all(q, ...b),
    run: (q, ...b) => this.run(q, ...b),
  });

  constructor(
    private readonly h: SqlHandle,
    /** Epoch seconds; stamps `clients.last_seen`. */
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  // ---- schema ------------------------------------------------------------------------------

  // The per-operation meter (U-05.18): rows the SQL API counted since the last `takeMeter`. A
  // cursor's counts are final once it is drained, which `toArray` does; a rolled-back statement
  // still counts, because the runtime bills it.
  private meterRead = 0;
  private meterWritten = 0;

  /** The rows read and written since the last call, and a fresh count. */
  takeMeter(): RowMeter {
    const out = { rowsRead: this.meterRead, rowsWritten: this.meterWritten };
    this.meterRead = 0;
    this.meterWritten = 0;
    return out;
  }

  private all<T extends Row>(q: string, ...b: SqlStorageValue[]): T[] {
    const cursor = this.h.sql.exec<T>(q, ...b);
    const rows = cursor.toArray();
    this.meterRead += cursor.rowsRead;
    this.meterWritten += cursor.rowsWritten;
    return rows;
  }

  private run(q: string, ...b: SqlStorageValue[]): void {
    const cursor = this.h.sql.exec(q, ...b);
    cursor.toArray();
    this.meterRead += cursor.rowsRead;
    this.meterWritten += cursor.rowsWritten;
  }

  private hasSchema(): boolean {
    if (this.schema === "unknown")
      this.schema =
        this.all(
          `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'`,
        ).length > 0
          ? "ready"
          : "absent";
    return this.schema === "ready";
  }

  /** The stored schema version (0: the object was never written). */
  schemaVersion(): number {
    if (!this.hasSchema()) return 0;
    const r = this.all<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'schema_version'`,
    )[0];
    return r ? Number(r.value) : 0;
  }

  /**
   * Brings the schema to `SCHEMA_VERSION`. `create` is true for a write (the first one makes the
   * tables); a read passes false and leaves a never-written object without tables. A schema from
   * a newer build is refused.
   */
  prepare(create: boolean): void {
    const have = this.schemaVersion();
    if (have > SCHEMA_VERSION)
      throw new Error(
        `sync store: schema ${have} is newer than ${SCHEMA_VERSION}`,
      );
    if (have === SCHEMA_VERSION) return;
    if (have === 0 && !create && !this.hasSchema()) return;
    this.h.transactionSync(() => {
      for (let v = have; v < SCHEMA_VERSION; v++) {
        for (const stmt of MIGRATIONS[v] ?? []) this.run(stmt);
        this.run(
          `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`,
          String(v + 1),
        );
      }
    });
    this.schema = "ready";
  }

  /** Forgets the cached schema probe (after `deleteAll`). */
  reset(): void {
    this.schema = "unknown";
  }

  private requireWritable(): void {
    if (this.schemaVersion() !== SCHEMA_VERSION)
      throw new Error("sync store: written before prepare(true)");
  }

  // ---- meta --------------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    if (!this.hasSchema()) return undefined;
    return this.all<{ value: string }>(
      `SELECT value FROM meta WHERE key = ?`,
      key,
    )[0]?.value;
  }

  setMeta(key: string, value: string): void {
    this.requireWritable();
    this.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
      key,
      value,
    );
  }

  deleteMeta(key: string): void {
    this.requireWritable();
    this.run(`DELETE FROM meta WHERE key = ?`, key);
  }

  private num(key: string): number {
    const v = this.getMeta(key);
    return v === undefined ? 0 : Number(v);
  }

  // ---- SyncStore ---------------------------------------------------------------------------

  transaction<T>(fn: () => T): T {
    return this.h.transactionSync(fn);
  }

  currentSeq(): number {
    return this.num("seq");
  }

  nextSeq(): number {
    this.requireWritable();
    const n = this.num("seq") + 1;
    this.setMeta("seq", String(n));
    return n;
  }

  getWatermark(): number {
    return this.num("watermark");
  }

  setWatermark(seq: number): void {
    this.setMeta("watermark", String(seq));
  }

  getEncryptionSince(): number | undefined {
    const v = this.getMeta("encryption_since");
    return v === undefined ? undefined : Number(v);
  }

  setEncryptionSince(seq: number): void {
    this.setMeta("encryption_since", String(seq));
  }

  getUsage(): StoreUsage {
    return compactUsage({
      settings: this.num("usage_settings"),
      settingsBytes: this.num("usage_settings_bytes"),
      records: this.num("usage_records"),
      recordBytes: this.num("usage_record_bytes"),
      bytes: this.num("usage_bytes"),
      files: this.num("usage_files"),
      fileBytes: this.num("usage_file_bytes"),
      revisionBytes: this.num("usage_revision_bytes"),
      reservedBytes: this.num("usage_reserved_bytes"),
    });
  }

  setUsage(u: StoreUsage): void {
    this.setMeta("usage_settings", String(u.settings));
    this.setMeta("usage_settings_bytes", String(u.settingsBytes));
    // The record counters change only when a record does: a settings-only object (and every
    // object written before v3) writes no extra rows for them.
    // The file counters follow the same rule (U-10): an object that never held a file writes none.
    for (const [key, n] of [
      ["usage_records", u.records],
      ["usage_record_bytes", u.recordBytes],
      ["usage_files", u.files ?? 0],
      ["usage_file_bytes", u.fileBytes ?? 0],
      ["usage_revision_bytes", u.revisionBytes ?? 0],
      ["usage_reserved_bytes", u.reservedBytes ?? 0],
    ] as const)
      if (this.num(key) !== n) this.setMeta(key, String(n));
    this.setMeta("usage_bytes", String(u.bytes));
  }

  getClient(clientId: string): ClientRecord | undefined {
    if (!this.hasSchema()) return undefined;
    const r = this.all<{
      device_id: string;
      last_mutation_id: number;
    }>(
      `SELECT device_id, last_mutation_id FROM clients WHERE client_id = ?`,
      clientId,
    )[0];
    return r
      ? { clientId, deviceId: r.device_id, lastMutationId: r.last_mutation_id }
      : undefined;
  }

  /**
   * The count of writes that did not move `seq`: a client binding changes without a sequence (a
   * conflict-only push advances `lastMutationId`). An absorbed object is deleted only while both
   * `seq` and this are what the export saw (SR-1 N2).
   */
  writeCount(): number {
    return this.num("writes");
  }

  putClient(c: ClientRecord): void {
    this.requireWritable();
    this.setMeta("writes", String(this.num("writes") + 1));
    this.run(
      `INSERT OR REPLACE INTO clients (client_id, device_id, last_mutation_id, last_seen) VALUES (?, ?, ?, ?)`,
      c.clientId,
      c.deviceId,
      c.lastMutationId,
      this.clock(),
    );
  }

  clientCount(): number {
    if (!this.hasSchema()) return 0;
    return Number(
      this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM clients`)[0]?.n ?? 0,
    );
  }

  dropIdleClient(cutoffSeconds: number): boolean {
    if (!this.hasSchema()) return false;
    this.requireWritable();
    const r = this.all<{ client_id: string; last_seen: number }>(
      `SELECT client_id, last_seen FROM clients ORDER BY last_seen, client_id LIMIT 1`,
    )[0];
    if (!r || r.last_seen > cutoffSeconds) return false;
    this.setMeta("writes", String(this.num("writes") + 1));
    this.run(`DELETE FROM clients WHERE client_id = ?`, r.client_id);
    return true;
  }

  /** Forgets client bindings that have not pushed since `cutoff` (epoch seconds). Returns how many. */
  expireClients(cutoff: number): number {
    if (!this.hasSchema()) return 0;
    this.requireWritable();
    const n = this.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM clients WHERE last_seen < ?`,
      cutoff,
    )[0]?.n;
    if (!n) return 0;
    // A binding leaving is a write that does not move `seq`: the merge's write guard sees it.
    this.setMeta("writes", String(this.num("writes") + 1));
    this.run(`DELETE FROM clients WHERE last_seen < ?`, cutoff);
    return Number(n);
  }

  /** Every client record, for the export. */
  clients(): ClientRecord[] {
    if (!this.hasSchema()) return [];
    return this.all<{
      client_id: string;
      device_id: string;
      last_mutation_id: number;
    }>(
      `SELECT client_id, device_id, last_mutation_id FROM clients ORDER BY client_id`,
    ).map((r) => ({
      clientId: r.client_id,
      deviceId: r.device_id,
      lastMutationId: r.last_mutation_id,
    }));
  }

  getSetting(
    key: string,
    scope: SyncScope,
    family?: string,
  ): StoredSetting | undefined {
    if (!this.hasSchema()) return undefined;
    const fam = scope === "platform" ? (family ?? "") : "";
    for (const table of ["settings", "tombstones"] as const) {
      const r = this.all<SettingRow>(
        `SELECT * FROM ${table} WHERE scope = ? AND family = ? AND key = ?`,
        scope,
        fam,
        key,
      )[0];
      if (r) return this.hydrate(r, table === "tombstones");
    }
    return undefined;
  }

  /**
   * Writes the row. The row itself is one upsert (and one delete from the table it left), and the
   * merge cells of a merged row are written as a diff against what is stored: only a cell that is
   * new or changed is upserted (its `ord` kept), and only a name the row no longer holds is deleted
   * (SR-1 B2). A mutation therefore writes O(mutations) rows however many cells the row holds.
   */
  putSetting(row: StoredSetting): void {
    this.requireWritable();
    if (!row.deleted && this.getMeta("held_data") !== "1")
      this.setMeta("held_data", "1");
    const fam = row.scope === "platform" ? (row.family ?? "") : "";
    const [table, other] = row.deleted
      ? (["tombstones", "settings"] as const)
      : (["settings", "tombstones"] as const);
    this.run(
      `DELETE FROM ${other} WHERE scope = ? AND family = ? AND key = ?`,
      row.scope,
      fam,
      row.key,
    );
    this.run(
      `INSERT INTO ${table}
         (scope, family, key, version, hlc, client_id, value_json, is_merge, floor_hlc, floor_client, kid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, family, key) DO UPDATE SET
         version = excluded.version, hlc = excluded.hlc, client_id = excluded.client_id,
         value_json = excluded.value_json, is_merge = excluded.is_merge,
         floor_hlc = excluded.floor_hlc, floor_client = excluded.floor_client,
         kid = excluded.kid`,
      row.scope,
      fam,
      row.key,
      row.version,
      row.stamp.hlc,
      row.stamp.clientId,
      JSON.stringify(row.value),
      row.members ? 1 : 0,
      row.floor?.hlc ?? null,
      row.floor?.clientId ?? null,
      row.kid ?? null,
    );
    const have = new Map<string, MemberRow>();
    for (const m of this.all<MemberRow>(
      `SELECT member, value_json, removed, hlc, client_id, kid FROM setting_members
         WHERE scope = ? AND family = ? AND key = ?`,
      row.scope,
      fam,
      row.key,
    ))
      have.set(m.member, m);
    const members = row.members ?? new Map<string, MemberCell>();
    for (const [name, cell] of members) {
      const json = JSON.stringify(cell.value);
      if (settle(have, name, json, cell)) continue;
      this.run(
        `INSERT INTO setting_members
           (scope, family, key, member, value_json, removed, hlc, client_id, kid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, family, key, member) DO UPDATE SET
           value_json = excluded.value_json, removed = excluded.removed,
           hlc = excluded.hlc, client_id = excluded.client_id, kid = excluded.kid`,
        row.scope,
        fam,
        row.key,
        name,
        json,
        cell.removed ? 1 : 0,
        cell.stamp.hlc,
        cell.stamp.clientId,
        cell.kid ?? null,
      );
    }
    // What is left in `have` was pruned, cleared or collected.
    for (const name of have.keys())
      this.run(
        `DELETE FROM setting_members
           WHERE scope = ? AND family = ? AND key = ? AND member = ?`,
        row.scope,
        fam,
        row.key,
        name,
      );
  }

  deleteSetting(key: string, scope: SyncScope, family?: string): void {
    this.requireWritable();
    const fam = scope === "platform" ? (family ?? "") : "";
    for (const table of ["settings", "tombstones", "setting_members"])
      this.run(
        `DELETE FROM ${table} WHERE scope = ? AND family = ? AND key = ?`,
        scope,
        fam,
        key,
      );
  }

  settingsAfter(seq: number): StoredSetting[] {
    if (!this.hasSchema()) return [];
    const rows: [SettingRow, boolean][] = [
      ...this.all<SettingRow>(
        `SELECT * FROM settings WHERE version > ?`,
        seq,
      ).map((r): [SettingRow, boolean] => [r, false]),
      ...this.all<SettingRow>(
        `SELECT * FROM tombstones WHERE version > ?`,
        seq,
      ).map((r): [SettingRow, boolean] => [r, true]),
    ];
    rows.sort(
      ([a], [b]) =>
        a.version - b.version ||
        (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
        (a.family < b.family ? -1 : a.family > b.family ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    return rows.map(([r, dead]) => this.hydrate(r, dead));
  }

  settingsPageThrough(
    after: number,
    through: number,
    limit: number,
  ): StoredSetting[] {
    if (!this.hasSchema()) return [];
    const rows = this.all<SettingRow & { dead: number }>(
      `SELECT * FROM (
         SELECT *, 0 AS dead FROM settings WHERE version > ? AND version <= ?
         UNION ALL
         SELECT *, 1 AS dead FROM tombstones WHERE version > ? AND version <= ?)
       ORDER BY version, scope, family, key LIMIT ?`,
      after,
      through,
      after,
      through,
      limit,
    );
    return rows.map((r) => this.hydrate(r, r.dead === 1));
  }

  settingsPageAfter(
    seq: number,
    family: string,
    limit: number,
  ): StoredSetting[] {
    if (!this.hasSchema()) return [];
    const visible = `(scope = 'user' OR family = ?)`;
    // Versions are unique per row (every write takes the next sequence), so `version` orders the
    // union; the scope, family and key terms only make an impossible tie deterministic.
    const rows = this.all<SettingRow & { dead: number }>(
      `SELECT * FROM (
         SELECT *, 0 AS dead FROM settings WHERE version > ? AND ${visible}
         UNION ALL
         SELECT *, 1 AS dead FROM tombstones WHERE version > ? AND ${visible})
       ORDER BY version, scope, family, key LIMIT ?`,
      seq,
      family,
      seq,
      family,
      limit,
    );
    return rows.map((r) => this.hydrate(r, r.dead === 1));
  }

  isEmpty(): boolean {
    if (!this.hasSchema()) return true;
    return (
      this.all(
        `SELECT 1 AS x FROM settings UNION ALL SELECT 1 FROM tombstones
         UNION ALL SELECT 1 FROM records UNION ALL SELECT 1 FROM parked_records LIMIT 1`,
      ).length === 0
    );
  }

  heldData(): boolean {
    if (this.getMeta("held_data") === "1") return true;
    // An object written before the flag existed: any live setting row counts.
    if (!this.hasSchema()) return false;
    return this.all(`SELECT 1 AS x FROM settings LIMIT 1`).length > 0;
  }

  // ---- records (U-09; the rows are `sqlRecords.ts`'s) ---------------------------------------

  getRecord(collection: string, id: string): StoredRecord | undefined {
    if (!this.hasSchema()) return undefined;
    return this.recordTables.read(collection, id);
  }

  putRecord(row: StoredRecord): void {
    this.requireWritable();
    if (!row.deleted && this.getMeta("held_data") !== "1")
      this.setMeta("held_data", "1");
    this.recordTables.write(row);
  }

  deleteRecordRow(collection: string, id: string): void {
    this.requireWritable();
    this.recordTables.remove(collection, id);
  }

  recordsPageAfter(seq: number, limit: number): StoredRecord[] {
    return this.recordsPageThrough(seq, Number.MAX_SAFE_INTEGER, limit);
  }

  recordsPageThrough(
    after: number,
    through: number,
    limit: number,
  ): StoredRecord[] {
    if (!this.hasSchema()) return [];
    return this.recordTables.page(after, through, limit);
  }

  // ---- files (U-10; the rows are `sqlFiles.ts`'s) --------------------------------------------

  getFile(
    collection: string,
    recordId: string,
    version: number,
  ): StoredFile | undefined {
    if (!this.hasSchema()) return undefined;
    return this.fileTables.get(collection, recordId, version);
  }

  liveFile(collection: string, recordId: string): StoredFile | undefined {
    if (!this.hasSchema()) return undefined;
    return this.fileTables.live(collection, recordId);
  }

  putFile(row: StoredFile): void {
    this.requireWritable();
    this.fileTables.put(row);
  }

  deleteFile(collection: string, recordId: string, version: number): void {
    this.requireWritable();
    this.fileTables.remove(collection, recordId, version);
  }

  filesOf(collection: string, recordId: string): StoredFile[] {
    if (!this.hasSchema()) return [];
    return this.fileTables.of(collection, recordId);
  }

  allFiles(): StoredFile[] {
    if (!this.hasSchema()) return [];
    return this.fileTables.all();
  }

  getUpload(uploadId: string): UploadRow | undefined {
    if (!this.hasSchema()) return undefined;
    return this.fileTables.upload(uploadId);
  }

  putUpload(row: UploadRow): void {
    this.requireWritable();
    this.fileTables.putUpload(row);
  }

  deleteUpload(uploadId: string): void {
    this.requireWritable();
    this.fileTables.removeUpload(uploadId);
  }

  openUploads(nowMs: number): UploadRow[] {
    if (!this.hasSchema()) return [];
    return this.fileTables.open(nowMs);
  }

  expiredUploads(nowMs: number, limit: number): UploadRow[] {
    if (!this.hasSchema()) return [];
    return this.fileTables.expired(nowMs, limit);
  }

  getParts(uploadId: string): UploadPart[] {
    if (!this.hasSchema()) return [];
    return this.fileTables.parts(uploadId);
  }

  putPart(row: UploadPart): void {
    this.requireWritable();
    this.fileTables.putPart(row);
  }

  deletePart(uploadId: string, n: number): void {
    this.requireWritable();
    this.fileTables.removePart(uploadId, n);
  }

  getSsecKey(kid: string): Uint8Array | undefined {
    if (!this.hasSchema()) return undefined;
    return this.fileTables.ssecKey(kid);
  }

  putSsecKey(kid: string, key: Uint8Array): void {
    this.requireWritable();
    this.fileTables.putSsecKey(kid, key);
  }

  deleteSsecKey(kid: string): void {
    this.requireWritable();
    this.fileTables.removeSsecKey(kid);
  }

  allSsecKeys(): [string, Uint8Array][] {
    if (!this.hasSchema()) return [];
    return this.fileTables.allSsecKeys();
  }

  getParkedRecord(
    collection: string,
    id: string,
    fromSubject: string,
  ): ParkedRecord | undefined {
    if (!this.hasSchema()) return undefined;
    return this.recordTables.readParked(collection, id, fromSubject);
  }

  putParkedRecord(row: ParkedRecord): void {
    this.requireWritable();
    if (this.getMeta("held_data") !== "1") this.setMeta("held_data", "1");
    // A parked copy does not move `seq`: the write count is what tells an export it changed.
    this.setMeta("writes", String(this.num("writes") + 1));
    this.recordTables.writeParked(row);
  }

  parkedRecords(): ParkedRecord[] {
    if (!this.hasSchema()) return [];
    return this.recordTables.allParked();
  }

  parkedCount(): number {
    if (!this.hasSchema()) return 0;
    return this.recordTables.parkedCount();
  }

  oldestParked(limit: number): ParkedRecord[] {
    if (!this.hasSchema()) return [];
    return this.recordTables.oldestParked(limit);
  }

  deleteParkedRecord(
    collection: string,
    id: string,
    fromSubject: string,
  ): void {
    this.requireWritable();
    this.setMeta("writes", String(this.num("writes") + 1));
    this.recordTables.deleteParked(collection, id, fromSubject);
  }

  liveRecordCount(collection: string): number {
    if (!this.hasSchema()) return 0;
    return this.recordTables.liveCount(collection);
  }

  recordTombstoneCount(collection?: string): number {
    if (!this.hasSchema()) return 0;
    return this.recordTables.tombstoneCount(collection);
  }

  oldestRecordTombstones(limit: number, collection?: string): StoredRecord[] {
    if (!this.hasSchema()) return [];
    return this.recordTables.oldestTombstones(limit, collection);
  }

  removedFieldCount(collection?: string): number {
    if (!this.hasSchema()) return 0;
    return this.recordTables.removedCount(collection);
  }

  oldestRemovedFields(limit: number, collection?: string): RemovedField[] {
    if (!this.hasSchema()) return [];
    return this.recordTables.oldestRemoved(limit, collection);
  }

  /** The console's per-collection counters (U-11a.1); the queries are `sqlInspect.ts`'s. */
  inspectTables(): InspectTables {
    return inspectTables(this.all.bind(this), this.hasSchema());
  }

  private hydrate(r: SettingRow, deleted: boolean): StoredSetting {
    const out: StoredSetting = {
      key: r.key,
      scope: r.scope as SyncScope,
      ...(r.scope === "platform" ? { family: r.family } : {}),
      version: r.version,
      stamp: { hlc: r.hlc, clientId: r.client_id },
      deleted,
      value: JSON.parse(r.value_json) as SyncJson,
    };
    readFloorAndKid(out, r);
    if (r.is_merge) {
      const members = new Map<string, MemberCell>();
      for (const m of this.all<MemberRow>(
        `SELECT member, value_json, removed, hlc, client_id, kid FROM setting_members
           WHERE scope = ? AND family = ? AND key = ? ORDER BY ord`,
        r.scope,
        r.family,
        r.key,
      ))
        members.set(m.member, {
          value: JSON.parse(m.value_json) as SyncJson,
          removed: m.removed === 1,
          stamp: { hlc: m.hlc, clientId: m.client_id },
          ...(m.kid !== null ? { kid: m.kid } : {}),
        });
      out.members = members;
    }
    return out;
  }
}
