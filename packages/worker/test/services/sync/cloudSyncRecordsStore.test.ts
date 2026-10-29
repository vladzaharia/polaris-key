// U-09.3: the record methods of `SyncStore` (plans/U-09-slices.md §2.1), proved on both stores:
// the reference `MemoryStore` and the Durable Object's `SqlStore`. Plus the v2 to v3 migration.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import type {
  FieldCell,
  StoredRecord,
  SyncStore,
} from "../../../src/services/sync/engine/types.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  SqlStore,
} from "../../../src/services/sync/do/sqlStore.js";
import { SqlTestStore } from "../../cloudSyncSqlTestStore.js";
import { DoStorageMock } from "../../cloudSyncDoMock.js";

const stamp = (n: number) => ({
  hlc: `0190f3a2c1b4:${n.toString(16).padStart(4, "0")}`,
  clientId: "c_aaaaaaaaaaaaaaaaaaaaaa",
});

const GONE: [string, FieldCell] = [
  "gone",
  { value: null, removed: true, stamp: stamp(3), kid: "cd".repeat(16) },
];

const valueRecord = (
  collection: string,
  id: string,
  version: number,
  value: StoredRecord["value"] = { a: 1 },
  deleted = false,
): StoredRecord => ({
  collection,
  id,
  version,
  stamp: stamp(version),
  deleted,
  kind: "value",
  value,
});

const stores: [string, () => SyncStore][] = [
  ["memory", () => new MemoryStore()],
  ["sql", () => new SqlTestStore()],
];

describe.each(stores)("record methods: %s store", (_name, make) => {
  it("round-trips a value record, a tombstone and the key id", () => {
    const s = make();
    expect(s.getRecord("saves", "slot-1")).toBeUndefined();
    s.putRecord({ ...valueRecord("saves", "slot-1", 1), kid: "ab".repeat(16) });
    s.putRecord(valueRecord("saves", "slot-2", 2, null, true));
    expect(s.getRecord("saves", "slot-1")).toEqual({
      ...valueRecord("saves", "slot-1", 1),
      kid: "ab".repeat(16),
    });
    expect(s.getRecord("saves", "slot-2")?.deleted).toBe(true);
    s.putRecord(valueRecord("saves", "slot-1", 3, { a: 2 }));
    expect(s.getRecord("saves", "slot-1")).toEqual(
      valueRecord("saves", "slot-1", 3, { a: 2 }),
    );
    s.deleteRecordRow("saves", "slot-1");
    expect(s.getRecord("saves", "slot-1")).toBeUndefined();
  });

  it("keeps merge field cells, removed ones included, and a union's tags", () => {
    const s = make();
    s.putRecord({
      collection: "notes",
      id: "n1",
      version: 4,
      stamp: stamp(4),
      deleted: false,
      kind: "fields",
      value: null,
      floor: stamp(1),
      fields: new Map([
        ["title", { value: "Hi", removed: false, stamp: stamp(2) }],
        GONE,
      ]),
    });
    s.putRecord({
      collection: "tags",
      id: "t1",
      version: 9,
      stamp: stamp(9),
      deleted: false,
      kind: "set",
      value: null,
      elements: new Map([
        ["b", { element: "b", tags: [5, 8] }],
        ["a", { element: "a", tags: [6] }],
      ]),
    });
    const notes = s.getRecord("notes", "n1");
    expect([...(notes?.fields ?? [])]).toEqual([
      ["title", { value: "Hi", removed: false, stamp: stamp(2) }],
      GONE,
    ]);
    expect(notes?.floor).toEqual(stamp(1));
    const tags = s.getRecord("tags", "t1");
    // Listed by first surviving add tag: b (5), then a (6).
    expect([...(tags?.elements ?? [])]).toEqual([
      ["b", { element: "b", tags: [5, 8] }],
      ["a", { element: "a", tags: [6] }],
    ]);
    // A diff write: one field goes, one element tag goes.
    s.putRecord({
      ...(notes as StoredRecord),
      version: 10,
      fields: new Map([
        ["title", { value: "Hi", removed: false, stamp: stamp(2) }],
      ]),
    });
    s.putRecord({
      ...(tags as StoredRecord),
      version: 11,
      elements: new Map([["b", { element: "b", tags: [8] }]]),
    });
    expect([...(s.getRecord("notes", "n1")?.fields?.keys() ?? [])]).toEqual([
      "title",
    ]);
    expect([...(s.getRecord("tags", "t1")?.elements ?? [])]).toEqual([
      ["b", { element: "b", tags: [8] }],
    ]);
    s.deleteRecordRow("tags", "t1");
    expect(s.getRecord("tags", "t1")).toBeUndefined();
  });

  it("pages by version, and counts live records per concrete collection", () => {
    const s = make();
    s.putRecord(valueRecord("a", "1", 5));
    s.putRecord(valueRecord("a", "2", 3));
    s.putRecord(valueRecord("b", "1", 4));
    s.putRecord(valueRecord("a", "3", 6, null, true));
    expect(s.recordsPageAfter(0, 10).map((r) => r.version)).toEqual([
      3, 4, 5, 6,
    ]);
    expect(s.recordsPageAfter(3, 2).map((r) => r.version)).toEqual([4, 5]);
    expect(s.recordsPageThrough(3, 5, 10).map((r) => r.version)).toEqual([
      4, 5,
    ]);
    expect(s.liveRecordCount("a")).toBe(2);
    expect(s.liveRecordCount("b")).toBe(1);
    expect(s.liveRecordCount("none")).toBe(0);
  });

  it("counts removed field cells and lists the oldest first, per collection or in all", () => {
    const s = make();
    const gone = (n: number): FieldCell => ({
      value: null,
      removed: true,
      stamp: stamp(n),
    });
    const live: FieldCell = { value: 1, removed: false, stamp: stamp(0) };
    const record = (
      collection: string,
      id: string,
      version: number,
      cells: [string, FieldCell][],
    ): StoredRecord => ({
      ...valueRecord(collection, id, version, null),
      kind: "fields",
      fields: new Map(cells),
    });
    s.putRecord(
      record("a", "1", 1, [
        ["x", gone(5)],
        ["y", live],
        ["z", gone(2)],
      ]),
    );
    s.putRecord(record("a", "2", 2, [["x", gone(9)]]));
    s.putRecord(record("b", "1", 3, [["x", gone(4)]]));
    expect(s.removedFieldCount()).toBe(4);
    expect(s.removedFieldCount("a")).toBe(3);
    expect(s.removedFieldCount("none")).toBe(0);
    expect(s.oldestRemovedFields(2, "a").map((c) => [c.id, c.field])).toEqual([
      ["1", "z"],
      ["1", "x"],
    ]);
    expect(
      s.oldestRemovedFields(3).map((c) => [c.collection, c.id, c.field]),
    ).toEqual([
      ["a", "1", "z"],
      ["b", "1", "x"],
      ["a", "1", "x"],
    ]);
    expect(s.oldestRemovedFields(1)[0]?.stamp).toEqual(stamp(2));
  });

  it("counts records in isEmpty and heldData, a tombstone alone in neither heldData", () => {
    const s = make();
    expect(s.isEmpty()).toBe(true);
    expect(s.heldData()).toBe(false);
    s.putRecord(valueRecord("a", "1", 1, null, true));
    expect(s.isEmpty()).toBe(false);
    expect(s.heldData()).toBe(false);
    s.putRecord(valueRecord("a", "2", 2));
    expect(s.heldData()).toBe(true);
  });

  it("holds records and recordBytes in the usage, defaulting to zero", () => {
    const s = make();
    expect(s.getUsage()).toEqual({
      settings: 0,
      settingsBytes: 0,
      records: 0,
      recordBytes: 0,
      bytes: 0,
    });
    s.setUsage({
      settings: 1,
      settingsBytes: 2,
      records: 3,
      recordBytes: 4,
      bytes: 6,
    });
    expect(s.getUsage()).toMatchObject({ records: 3, recordBytes: 4 });
  });

  it("rolls a failed transaction's record writes back", () => {
    const s = make();
    s.putRecord(valueRecord("a", "1", 1));
    expect(() =>
      s.transaction(() => {
        s.putRecord(valueRecord("a", "1", 2, { z: 1 }));
        s.putRecord(valueRecord("a", "2", 3));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getRecord("a", "1")).toEqual(valueRecord("a", "1", 1));
    expect(s.getRecord("a", "2")).toBeUndefined();
  });
});

describe("SqlStore: schema v3", () => {
  it("migrates a v2 object: rows kept, record tables made, kid columns added", () => {
    const storage = new DoStorageMock();
    // Build a v2 object from the first two migration steps.
    for (const step of MIGRATIONS.slice(0, 2))
      for (const stmt of step) storage.sql.exec(stmt);
    storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('schema_version', '2')`,
    );
    storage.sql.exec(
      `INSERT INTO settings (scope, family, key, version, hlc, client_id, value_json, is_merge)
       VALUES ('user', '', 'k', 1, '0190f3a2c1b4:0001', 'c_aaaaaaaaaaaaaaaaaaaaaa', '5', 0)`,
    );
    const store = new SqlStore(
      storage as unknown as ConstructorParameters<typeof SqlStore>[0],
    );
    expect(store.schemaVersion()).toBe(2);
    store.prepare(false);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(3);
    expect(store.getSetting("k", "user")?.value).toBe(5);
    const names = (
      storage.sql.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      "clients",
      "meta",
      "parked_records",
      "record_fields",
      "records",
      "set_elements",
      "setting_members",
      "settings",
      "tombstones",
    ]);
    for (const table of ["settings", "tombstones", "setting_members"]) {
      const cols = (
        storage.sql.db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(cols).toContain("kid");
    }
    store.putRecord(valueRecord("saves", "s", 2));
    expect(store.getRecord("saves", "s")?.version).toBe(2);
  });

  it("a v4 store is refused, never rewritten", () => {
    const store = new SqlTestStore();
    store.setMeta("schema_version", "4");
    expect(() => store.prepare(true)).toThrow(/newer/);
    expect(store.getMeta("schema_version")).toBe("4");
  });
});
