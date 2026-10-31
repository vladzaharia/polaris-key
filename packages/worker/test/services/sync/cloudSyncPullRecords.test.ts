/**
 * U-09.7: the pull's record half (WIRE-CONTRACT-V5 §13.4), over the in-memory store: the merged
 * page across settings and records, the record change and tombstone shapes in both modes,
 * `usage.records` and `empty`. `cloudSyncSqlParityPullRecords.test.ts` replays this file over the
 * Durable Object's SQLite store.
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { applyPull } from "../../../src/services/sync/engine/pull.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";
import {
  ago,
  applyOk,
  blinded as BLIND,
  pullAs as pull,
  recordOp,
  recordRoute,
  restartIds,
  sealedBox as envelope,
  settingOp,
  settingRoute,
} from "./cloudSyncRecordsHarness.js";

/** The HLC of the n-th write: later numbers are later. */
const at = (n: number) => ago(100_000 - n);

/** A record mutation stamped `at(clock)`, pushed under `policy` (E2E when `sealed`). */
const write = (
  policy: Parameters<typeof recordRoute>[0],
  [collection, id]: [string, string],
  op: SyncMutation["op"],
  clock: number,
  extra: Partial<SyncMutation> = {},
  sealed = false,
): [SyncMutation, Classification] => [
  recordOp(collection, id, op, { editedHlc: at(clock), ...extra }),
  recordRoute(policy, { sealed }),
];

describe("record changes, server mode", () => {
  it("serves a scalar, a merge object, a union array and a tombstone", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(
      store,
      write("revision", ["saves", "s1"], "set", 1, { value: { n: 1 } }),
      write("merge", ["notes", "n1"], "setField", 2, { field: "a", value: 1 }),
      write("merge", ["notes", "n1"], "setField", 3, {
        field: "b",
        value: "x",
      }),
      write("union", ["tags", "t1"], "add", 4, { element: "x" }),
      write("union", ["tags", "t1"], "add", 5, { element: { k: 1 } }),
      write("revision", ["saves", "gone"], "set", 6, { value: 1 }),
      write("revision", ["saves", "gone"], "delete", 7),
    );
    const out = pull(store);
    expect(out.changes).toEqual([
      {
        record: ["saves", "s1"],
        value: { n: 1 },
        version: 1,
        editedHlc: at(1),
      },
      {
        record: ["notes", "n1"],
        value: { a: 1, b: "x" },
        version: 3,
        editedHlc: at(3),
      },
      {
        record: ["tags", "t1"],
        value: ["x", { k: 1 }],
        version: 5,
        editedHlc: at(5),
      },
    ]);
    expect(out.tombstones).toEqual([
      { record: ["saves", "gone"], editedHlc: at(7) },
    ]);
    expect(out.usage).toMatchObject({ records: 3, settings: 0, files: 0 });
    expect(out.usage.bytes).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("encryptionSince");
  });

  it("is empty only when no record, setting or tombstone is stored", () => {
    restartIds();
    const store = new MemoryStore();
    expect(pull(store, { cursor: 0 }).empty).toBe(true);
    applyOk(store, write("revision", ["saves", "s1"], "set", 1, { value: 1 }));
    expect(pull(store, { cursor: 0 }).empty).toBeUndefined();
    // A deleted record leaves a tombstone: still not empty.
    applyOk(store, write("revision", ["saves", "s1"], "delete", 2));
    expect(pull(store, { cursor: 0 }).empty).toBeUndefined();
  });

  it("every device sees every record, whatever its platform family", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(store, write("revision", ["saves", "s1"], "set", 1, { value: 1 }));
    expect(pull(store, { family: "mobile" }).changes).toHaveLength(1);
    expect(pull(store, { family: "console" }).changes).toHaveLength(1);
  });

  it("a cursor below the tombstone watermark is expired once a record tombstone is forgotten", () => {
    restartIds();
    const store = new MemoryStore();
    const small = recordRoute("revision", { maxRecords: 1 });
    for (let i = 0; i < 4; i++) {
      const slot = ["saves", `s${i}`];
      applyOk(
        store,
        [
          recordOp("saves", slot[1] as string, "set", {
            value: i,
            editedHlc: at(10 + i),
          }),
          small,
        ],
        [
          recordOp("saves", slot[1] as string, "delete", {
            editedHlc: at(20 + i),
          }),
          small,
        ],
      );
    }
    expect(store.getWatermark()).toBeGreaterThan(0);
    expect(
      applyPull(store, { deviceId: "dev1", family: "d", cursor: 1 }),
    ).toEqual({ ok: false, error: "cursor_expired" });
    expect(
      applyPull(store, { deviceId: "dev1", family: "d", cursor: 0 }).ok,
    ).toBe(true);
  });
});

describe("the merged page", () => {
  it("interleaves settings and records in version order across pages", () => {
    restartIds();
    const store = new MemoryStore();
    // versions: s1=1 r1=2 s2=3 r2=4 s3=5 r3=6 s4=7
    const s = (n: number): [SyncMutation, Classification] => [
      settingOp(`s${n}`, "set", { value: n }),
      settingRoute("lastWrite"),
    ];
    const r = (n: number) =>
      write("revision", ["saves", `r${n}`], "set", n, { value: n });
    applyOk(store, s(1), r(1), s(2), r(2), s(3), r(3), s(4));
    const names: string[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = pull(store, { cursor, pageSize: 3 });
      for (const c of page.changes)
        names.push("setting" in c ? c.setting : (c.record[1] as string));
      cursor = page.cursor;
      if (!page.more) {
        expect(cursor).toBe(7);
        break;
      }
      expect(page.changes.length + page.tombstones.length).toBe(3);
    }
    expect(names).toEqual(["s1", "r1", "s2", "r2", "s3", "r3", "s4"]);
  });

  it("pages tombstones with changes, and a middle page cursor is its last row", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(
      store,
      write("revision", ["saves", "a"], "set", 1, { value: 1 }), // 1
      write("revision", ["saves", "b"], "set", 2, { value: 1 }), // 2
      write("revision", ["saves", "a"], "delete", 3), // 3
      [settingOp("k", "set", { value: 1 }), settingRoute("lastWrite")], // 4
    );
    // The first record's write is superseded by its delete: rows are b (2), a's tombstone (3), k (4).
    const first = pull(store, { pageSize: 2 });
    expect(first.more).toBe(true);
    expect(first.cursor).toBe(3);
    expect(first.changes).toHaveLength(1); // b
    expect(first.tombstones).toEqual([
      expect.objectContaining({ record: ["saves", "a"] }),
    ]);
    const second = pull(store, { cursor: first.cursor, pageSize: 2 });
    expect(second.more).toBe(false);
    expect(second.tombstones).toEqual([]);
    expect(second.changes).toHaveLength(1); // k
  });
});

describe("record changes, end-to-end mode", () => {
  /** An E2E write under `policy`, whose names are blinded from `n`. */
  const sealed = (
    policy: Parameters<typeof recordRoute>[0],
    [collection, id]: [string, string],
    op: SyncMutation["op"],
    clock: number,
    extra: Partial<SyncMutation> = {},
  ) => write(policy, [collection, id], op, clock, extra, true);

  const notes: [string, string] = ["notes", BLIND(2)];
  const tags: [string, string] = ["tags", BLIND(3)];
  /** Two sealed fields of `notes` (clocks 2, 3) and two sealed elements of `tags` (4, 5). */
  const pair = () => [
    sealed("merge", notes, "setField", 2, {
      field: BLIND(10),
      ct: envelope(2),
    }),
    sealed("merge", notes, "setField", 3, {
      field: BLIND(11),
      ct: envelope(3),
    }),
    sealed("union", tags, "add", 4, { element: BLIND(20), ct: envelope(4) }),
    sealed("union", tags, "add", 5, { element: BLIND(21), ct: envelope(5) }),
  ];

  it("serves ct, fields, elements, and a tombstone, with no value", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(
      store,
      sealed("revision", ["saves", BLIND(1)], "set", 1, { ct: envelope(1) }),
      ...pair(),
      sealed("revision", ["saves", BLIND(4)], "set", 6, { ct: envelope(6) }),
      sealed("revision", ["saves", BLIND(4)], "delete", 7),
    );
    const out = pull(store, { e2e: true });
    expect(out.encryptionSince).toBe(1);
    expect(out.changes).toEqual([
      {
        record: ["saves", BLIND(1)],
        ct: envelope(1),
        version: 1,
        editedHlc: at(1),
      },
      {
        record: notes,
        fields: [
          { field: BLIND(10), ct: envelope(2), editedHlc: at(2) },
          { field: BLIND(11), ct: envelope(3), editedHlc: at(3) },
        ],
        version: 3,
        editedHlc: at(3),
      },
      {
        record: tags,
        elements: [
          { element: BLIND(20), ct: envelope(4) },
          { element: BLIND(21), ct: envelope(5) },
        ],
        version: 5,
      },
    ]);
    for (const c of out.changes) expect(c).not.toHaveProperty("value");
    expect(out.tombstones).toEqual([
      { record: ["saves", BLIND(4)], editedHlc: at(7) },
    ]);
  });

  it("a list is the whole live content: a removed field or element is absent", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(
      store,
      ...pair(),
      sealed("merge", notes, "removeField", 4, { field: BLIND(10) }),
      sealed("union", tags, "remove", 6, {
        element: BLIND(20),
        observedSeq: 5,
      }),
    );
    const out = pull(store, { e2e: true });
    expect(out.changes[0]).toMatchObject({ fields: [{ field: BLIND(11) }] });
    expect(out.changes[1]).toMatchObject({
      elements: [{ element: BLIND(21) }],
    });
  });

  it("a plaintext record below encryptionSince leaves as a value, as settings do", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(
      store,
      write("revision", ["saves", "legacy"], "set", 1, { value: { n: 1 } }),
    );
    applyOk(
      store,
      sealed("revision", ["saves", BLIND(1)], "set", 2, { ct: envelope(1) }),
    );
    const out = pull(store, { e2e: true });
    expect(out.encryptionSince).toBe(2);
    expect(out.changes[0]).toEqual({
      record: ["saves", "legacy"],
      value: { n: 1 },
      version: 1,
      editedHlc: at(1),
    });
    expect(out.changes[1]).toMatchObject({ ct: envelope(1), version: 2 });
  });
});
