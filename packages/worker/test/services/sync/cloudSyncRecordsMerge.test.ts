/**
 * U-09.5: `merge` (field cells) and `union` (observed-remove set) records of the Cloud Sync engine
 * (WIRE-CONTRACT-V5 §13.3, plans/U-09-slices.md §2.2), in both modes, over the in-memory store.
 * `cloudSyncSqlParityRecordsMerge.test.ts` replays this file over the Durable Object's SQLite
 * store.
 */
import { describe, expect, it } from "vitest";
import type { MutationResult, SyncMutation } from "@polaris-key/protocol/sync";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import {
  MAX_ELEMENT_TAGS,
  liveElements,
} from "../../../src/services/sync/engine/recordSets.js";
import type {
  Classification,
  PushLimits,
} from "../../../src/services/sync/engine/types.js";
import {
  NOW,
  applyAll,
  blinded as BLIND,
  kidOf,
  recordOp as mut,
  recordRoute as route,
  restartIds as reset,
  sealedBox as envelope,
} from "./cloudSyncRecordsHarness.js";

const at = (ms: number) => formatHlc(ms, 0);

const MERGE = route("merge");
const UNION = route("union");
const SEALED_MERGE = route("merge", { sealed: true });
const SEALED_UNION = route("union", { sealed: true });

/** A mutation of the record `("c", "r")`. */
const m = (op: SyncMutation["op"], extra: Partial<SyncMutation> = {}) =>
  mut("c", "r", op, extra);

const one = (
  store: MemoryStore,
  mutation: SyncMutation,
  r: Classification,
  opts: { limits?: PushLimits } = {},
): MutationResult =>
  applyAll(store, [[mutation, r]], opts.limits)[0] as MutationResult;

const live = (s: MemoryStore, c = "c", id = "r") => {
  const row = s.getRecord(c, id);
  return row && !row.deleted ? row : undefined;
};

describe("merge records, server mode", () => {
  it("each field is its own last-write-wins cell; a loser takes the server copy", () => {
    reset();
    const s = new MemoryStore();
    expect(
      one(s, m("setField", { field: "a", value: 1, editedHlc: at(10) }), MERGE),
    ).toMatchObject({ status: "ok", version: 1 });
    expect(
      one(s, m("setField", { field: "b", value: 2, editedHlc: at(5) }), MERGE),
    ).toMatchObject({ status: "ok", version: 2 });
    // Another field, at any clock, never conflicts; the same field older than its cell does.
    const stale = one(
      s,
      m("setField", { field: "a", value: 9, editedHlc: at(9) }),
      MERGE,
    );
    expect(stale).toMatchObject({
      status: "conflict",
      server: { value: { a: 1, b: 2 }, version: 2, editedHlc: at(10) },
    });
    expect(
      one(s, m("setField", { field: "a", value: 3, editedHlc: at(11) }), MERGE),
    ).toMatchObject({ status: "ok", version: 3 });
    expect(live(s)?.kind).toBe("fields");
    expect(live(s)?.stamp.hlc).toBe(at(11));
    expect(s.getUsage().records).toBe(1);
  });

  it("a removed field is a cell tombstone that a later set beats and an earlier set loses to", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "a", value: 1, editedHlc: at(10) }), MERGE);
    one(s, m("setField", { field: "b", value: 2, editedHlc: at(10) }), MERGE);
    expect(
      one(s, m("removeField", { field: "a", editedHlc: at(20) }), MERGE),
    ).toMatchObject({ status: "ok" });
    expect(
      one(s, m("setField", { field: "a", value: 7, editedHlc: at(15) }), MERGE),
    ).toMatchObject({
      status: "conflict",
      server: { value: { b: 2 } },
    });
    expect(
      one(s, m("setField", { field: "a", value: 8, editedHlc: at(21) }), MERGE),
    ).toMatchObject({ status: "ok" });
    expect(
      Object.fromEntries(
        [...(live(s)?.fields ?? [])].map(([k, c]) => [k, c.value]),
      ),
    ).toEqual({ a: 8, b: 2 });
  });

  it("a record whose last field goes is a tombstone, and frees its slot", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "a", value: 1 }), MERGE);
    expect(s.getUsage().records).toBe(1);
    one(s, m("removeField", { field: "a", editedHlc: at(NOW - 500) }), MERGE);
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
    expect(s.getUsage()).toMatchObject({
      records: 0,
      recordBytes: 0,
      bytes: 0,
    });
    // The cell tombstone survives, so an older set still loses.
    expect(
      one(
        s,
        m("setField", { field: "a", value: 2, editedHlc: at(NOW - 900) }),
        MERGE,
      ),
    ).toMatchObject({ status: "conflict", server: { value: null } });
  });

  it("a removeField or delete of a record the store holds no row for stores nothing", () => {
    reset();
    const s = new MemoryStore();
    expect(one(s, m("removeField", { field: "a" }), MERGE)).toMatchObject({
      status: "ok",
      version: 0,
    });
    expect(one(s, m("delete"), MERGE)).toMatchObject({
      status: "ok",
      version: 0,
    });
    expect(s.recordRows()).toEqual([]);
    expect(s.currentSeq()).toBe(0);
  });

  it("delete drops the cells at or below it and sets a floor an older set cannot cross", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "a", value: 1, editedHlc: at(10) }), MERGE);
    one(s, m("setField", { field: "b", value: 2, editedHlc: at(30) }), MERGE);
    // A newer cell survives an older delete.
    expect(one(s, m("delete", { editedHlc: at(20) }), MERGE)).toMatchObject({
      status: "ok",
    });
    expect(live(s)?.fields?.has("a")).toBe(false);
    expect(live(s)?.fields?.get("b")?.value).toBe(2);
    // Delete again, later: the record is gone.
    one(s, m("delete", { editedHlc: at(40) }), MERGE);
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
    // Nothing at or below the floor comes back; a newer set re-creates the record.
    expect(
      one(s, m("setField", { field: "a", value: 5, editedHlc: at(35) }), MERGE),
    ).toMatchObject({ status: "conflict", server: { value: null } });
    expect(
      one(s, m("setField", { field: "a", value: 5, editedHlc: at(41) }), MERGE),
    ).toMatchObject({ status: "ok" });
    expect(live(s)?.fields?.get("a")?.value).toBe(5);
  });

  it("an operation another policy owns is op_invalid_for_policy", () => {
    reset();
    const s = new MemoryStore();
    for (const op of ["set", "add", "remove"] as const)
      expect(
        one(s, m(op, { value: 1, element: 1, observedSeq: 0 }), MERGE),
      ).toMatchObject({ status: "rejected", code: "op_invalid_for_policy" });
    for (const op of ["setField", "removeField"] as const)
      expect(one(s, m(op, { field: "a", value: 1 }), UNION)).toMatchObject({
        status: "rejected",
        code: "op_invalid_for_policy",
      });
  });

  it("a record over 64 KiB is value_invalid; one under it is not", () => {
    reset();
    const s = new MemoryStore();
    const big = "x".repeat(20_000);
    for (const f of ["a", "b", "c"])
      expect(
        one(s, m("setField", { field: f, value: big }), MERGE),
      ).toMatchObject({ status: "ok" });
    expect(
      one(s, m("setField", { field: "d", value: big }), MERGE),
    ).toMatchObject({ status: "rejected", code: "value_invalid" });
    // Overwriting a field with a smaller value is fine.
    expect(
      one(
        s,
        m("setField", { field: "a", value: "s", editedHlc: at(NOW) }),
        MERGE,
      ),
    ).toMatchObject({ status: "ok" });
  });

  it("creates count against maxRecords; updates and removals do not", () => {
    reset();
    const s = new MemoryStore();
    const r = route("merge", { maxRecords: 1 });
    one(s, mut("c", "one", "setField", { field: "a", value: 1 }), r);
    expect(
      one(s, mut("c", "two", "setField", { field: "a", value: 1 }), r),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "collection",
    });
    expect(
      one(s, mut("c", "one", "setField", { field: "b", value: 1 }), r),
    ).toMatchObject({ status: "ok" });
  });

  it("a removal is never refused for quota; a set is", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "a", value: 1 }), MERGE);
    one(s, m("setField", { field: "b", value: 2 }), MERGE);
    const before = s.getUsage().bytes;
    const none: PushLimits = { quotaBytes: 0 };
    expect(
      one(s, m("setField", { field: "c", value: 3 }), MERGE, { limits: none }),
    ).toMatchObject({ status: "rejected", code: "quota_exceeded" });
    expect(
      one(s, m("removeField", { field: "a", editedHlc: at(NOW) }), MERGE, {
        limits: none,
      }),
    ).toMatchObject({ status: "ok" });
    expect(s.getUsage().bytes).toBeLessThan(before);
  });

  it("charges the collection, id and live cells; usage follows the record", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "name", value: "ab" }), MERGE);
    // "c" + "r" + "name" + `"ab"`
    expect(s.getUsage()).toMatchObject({
      records: 1,
      recordBytes: 1 + 1 + 4 + 4,
      bytes: 10,
    });
  });
});

describe("removed field cells are bounded", () => {
  it("keeps 2 x maxRecords per concrete collection, forgetting the oldest", () => {
    reset();
    const s = new MemoryStore();
    const r = route("merge", { maxRecords: 2 });
    const rid = "keep";
    one(s, mut("c", rid, "setField", { field: "keep", value: 1 }), r);
    for (let i = 0; i < 8; i++) {
      one(
        s,
        mut("c", rid, "setField", {
          field: `f${i}`,
          value: i,
          editedHlc: at(100 + i),
        }),
        r,
      );
      one(
        s,
        mut("c", rid, "removeField", {
          field: `f${i}`,
          editedHlc: at(200 + i),
        }),
        r,
      );
    }
    expect(s.removedFieldCount("c")).toBe(4);
    const cells = live(s, "c", rid)?.fields;
    // The oldest removals were forgotten, the newest kept.
    expect([...(cells?.keys() ?? [])].sort()).toEqual([
      "f4",
      "f5",
      "f6",
      "f7",
      "keep",
    ]);
    // A forgotten cell no longer beats an older write; a kept one still does.
    expect(
      one(
        s,
        mut("c", rid, "setField", {
          field: "f0",
          value: 1,
          editedHlc: at(150),
        }),
        r,
      ),
    ).toMatchObject({ status: "ok" });
    expect(
      one(
        s,
        mut("c", rid, "setField", {
          field: "f7",
          value: 1,
          editedHlc: at(150),
        }),
        r,
      ),
    ).toMatchObject({ status: "conflict" });
  });

  it("is per concrete collection: another collection's cells are not forgotten", () => {
    reset();
    const s = new MemoryStore();
    const r = route("merge", { maxRecords: 1 });
    for (const c of ["a.1", "b.1"]) {
      one(s, mut(c, "r", "setField", { field: "keep", value: 1 }), r);
      for (let i = 0; i < 2; i++) {
        one(s, mut(c, "r", "setField", { field: `f${i}`, value: i }), r);
        one(
          s,
          mut(c, "r", "removeField", { field: `f${i}`, editedHlc: at(NOW) }),
          r,
        );
      }
    }
    expect(s.removedFieldCount("a.1")).toBe(2);
    expect(s.removedFieldCount("b.1")).toBe(2);
    expect(s.removedFieldCount()).toBe(4);
  });

  it("inventing field names on a live record stores a bounded number of cells", () => {
    reset();
    const s = new MemoryStore();
    const r = route("merge", { maxRecords: 3 });
    one(s, mut("c", "r", "setField", { field: "keep", value: 1 }), r);
    for (let i = 0; i < 50; i++)
      one(
        s,
        mut("c", "r", "removeField", {
          field: `ghost${i}`,
          editedHlc: at(300 + i),
        }),
        r,
      );
    expect(s.removedFieldCount("c")).toBe(6);
  });
});

describe("union records, server mode", () => {
  /** Adds each element in turn: the n-th add is store sequence n. */
  const addAll = (s: MemoryStore, ...els: string[]) => {
    for (const element of els) one(s, m("add", { element }), UNION);
  };
  const elements = (s: MemoryStore) =>
    liveElements(s.getRecord("c", "r") as NonNullable<ReturnType<typeof live>>);

  it("add tags the element with the store sequence; equal elements are one element", () => {
    reset();
    const s = new MemoryStore();
    expect(one(s, m("add", { element: "x" }), UNION)).toMatchObject({
      status: "ok",
      version: 1,
    });
    one(s, m("add", { element: { b: 1, a: 2 } }), UNION);
    // The same element again (keys in another order) is the same element with a second tag.
    one(s, m("add", { element: { a: 2, b: 1 } }), UNION);
    const els = elements(s);
    expect(els.map(([, e]) => e.element)).toEqual(["x", { b: 1, a: 2 }]);
    expect(els.map(([, e]) => e.tags)).toEqual([[1], [2, 3]]);
  });

  it("a concurrent add survives a stale remove", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("add", { element: "x" }), UNION); // 1
    one(s, m("add", { element: "x" }), UNION); // 2: another device
    // The remover had seen version 1 only.
    expect(
      one(s, m("remove", { element: "x", observedSeq: 1 }), UNION),
    ).toMatchObject({ status: "ok" });
    expect(elements(s).map(([, e]) => e.tags)).toEqual([[2]]);
    // Having seen 2, it removes the element, and the empty set is a tombstone.
    one(s, m("remove", { element: "x", observedSeq: 2 }), UNION);
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
    expect(s.getUsage().records).toBe(0);
  });

  it("returns the array in the order of each element's first surviving add tag", () => {
    reset();
    const s = new MemoryStore();
    for (const e of ["a", "b", "c"]) one(s, m("add", { element: e }), UNION); // 1 2 3
    one(s, m("add", { element: "a" }), UNION); // a: 1, 4
    // Removing what was seen at 1 leaves a at tag 4: it moves behind b and c.
    one(s, m("remove", { element: "a", observedSeq: 1 }), UNION);
    expect(elements(s).map(([, e]) => e.element)).toEqual(["b", "c", "a"]);
  });

  it("a remove of what the record does not hold, or has no tag at or below, writes nothing", () => {
    reset();
    const s = new MemoryStore();
    addAll(s, "x", "y");
    const before = s.currentSeq();
    expect(
      one(s, m("remove", { element: "nope", observedSeq: 2 }), UNION),
    ).toMatchObject({ status: "ok", version: before });
    // observedSeq 0 is below every tag.
    expect(
      one(s, m("remove", { element: "y", observedSeq: 0 }), UNION),
    ).toMatchObject({ status: "ok", version: before });
    expect(s.currentSeq()).toBe(before);
    expect(elements(s)).toHaveLength(2);
  });

  it("an observedSeq above the store sequence is value_invalid", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("add", { element: "x" }), UNION);
    expect(
      one(s, m("remove", { element: "x", observedSeq: 5 }), UNION),
    ).toMatchObject({ status: "rejected", code: "value_invalid" });
  });

  it("a remove on a record the store holds no row for stores nothing", () => {
    reset();
    const s = new MemoryStore();
    expect(
      one(s, m("remove", { element: "x", observedSeq: 0 }), UNION),
    ).toMatchObject({ status: "ok", version: 0 });
    expect(one(s, m("delete"), UNION)).toMatchObject({
      status: "ok",
      version: 0,
    });
    expect(s.recordRows()).toEqual([]);
  });

  it("delete tombstones the record; a later add re-creates it with one element", () => {
    reset();
    const s = new MemoryStore();
    addAll(s, "x", "y");
    one(s, m("delete"), UNION);
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
    one(s, m("add", { element: "z" }), UNION);
    expect(elements(s).map(([, e]) => e.element)).toEqual(["z"]);
  });

  it("an element keeps a bounded number of tags: repeated adds cannot grow storage", () => {
    reset();
    const s = new MemoryStore();
    for (let i = 0; i < 25; i++) one(s, m("add", { element: "x" }), UNION);
    const tags = elements(s)[0]?.[1].tags as number[];
    expect(tags).toHaveLength(MAX_ELEMENT_TAGS);
    // The oldest tag keeps the place; the newest decides whether the element lives.
    expect(tags[0]).toBe(1);
    expect(tags[tags.length - 1]).toBe(25);
    one(s, m("remove", { element: "x", observedSeq: 24 }), UNION);
    expect(elements(s).map(([, e]) => e.tags)).toEqual([[25]]);
    one(s, m("remove", { element: "x", observedSeq: 25 }), UNION);
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
  });

  it("a set over 64 KiB is value_invalid; removals are never refused for quota", () => {
    reset();
    const s = new MemoryStore();
    const big = "x".repeat(1000);
    let last: MutationResult | undefined;
    for (let i = 0; i < 70; i++)
      last = one(s, m("add", { element: `${i}${big}`.slice(0, 1000) }), UNION);
    expect(last).toMatchObject({ status: "rejected", code: "value_invalid" });
    expect(
      one(
        s,
        m("remove", { element: "0" + big.slice(1), observedSeq: 1 }),
        UNION,
        {
          limits: { quotaBytes: 0 },
        },
      ),
    ).toMatchObject({ status: "ok" });
  });

  it("add charges the stored bytes against the quota", () => {
    reset();
    const s = new MemoryStore();
    expect(
      one(s, m("add", { element: "x" }), UNION, { limits: { quotaBytes: 0 } }),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
    one(s, m("add", { element: "x" }), UNION);
    expect(s.getUsage()).toMatchObject({ records: 1, recordBytes: 1 + 1 + 3 });
  });
});

describe("a policy change converts at write", () => {
  it("an object becomes field cells at the record's stamp; an older set then loses", () => {
    reset();
    const s = new MemoryStore();
    one(
      s,
      m("set", { value: { a: 1, b: 2 }, editedHlc: at(50) }),
      route("lastWrite"),
    );
    // Reading converts nothing.
    expect(s.getRecord("c", "r")?.kind).toBe("value");
    expect(
      one(s, m("setField", { field: "c", value: 3, editedHlc: at(60) }), MERGE),
    ).toMatchObject({ status: "ok" });
    const row = live(s);
    expect(row?.kind).toBe("fields");
    expect(
      Object.fromEntries(
        [...(row?.fields ?? [])].map(([k, c]) => [k, c.value]),
      ),
    ).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
    // A write older than what the record held at the change cannot cross its floor.
    expect(
      one(s, m("setField", { field: "a", value: 0, editedHlc: at(40) }), MERGE),
    ).toMatchObject({ status: "conflict" });
  });

  it("an array becomes elements tagged with the version it was stored at", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("set", { value: ["x", "y", "x"] }), route("lastWrite")); // version 1
    one(s, m("add", { element: "z" }), UNION); // 2
    const els = liveElements(live(s) as NonNullable<ReturnType<typeof live>>);
    expect(els.map(([, e]) => e.tags)).toEqual([[1], [1], [2]]);
    // A remove from a client that had seen version 1 drops the converted ones.
    one(s, m("remove", { element: "x", observedSeq: 1 }), UNION);
    one(s, m("remove", { element: "y", observedSeq: 1 }), UNION);
    expect(
      liveElements(live(s) as NonNullable<ReturnType<typeof live>>).map(
        ([, e]) => e.element,
      ),
    ).toEqual(["z"]);
  });

  it("a stored shape that cannot convert is op_invalid_for_policy, and a delete still works", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("set", { value: 5 }), route("lastWrite"));
    expect(
      one(s, m("setField", { field: "a", value: 1 }), MERGE),
    ).toMatchObject({ status: "rejected", code: "op_invalid_for_policy" });
    expect(one(s, m("add", { element: 1 }), UNION)).toMatchObject({
      status: "rejected",
      code: "op_invalid_for_policy",
    });
    expect(s.getRecord("c", "r")?.value).toBe(5);
    expect(one(s, m("delete", { editedHlc: at(NOW) }), MERGE)).toMatchObject({
      status: "ok",
    });
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
    // A merge record is not an array, and a set is not an object.
    expect(
      one(
        s,
        m("setField", { field: "a", value: 1, editedHlc: at(NOW) }),
        MERGE,
      ),
    ).toMatchObject({ status: "ok" });
    expect(one(s, m("add", { element: 1 }), UNION)).toMatchObject({
      status: "rejected",
      code: "op_invalid_for_policy",
    });
  });

  it("a scalar write over field cells or elements replaces the whole record", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "a", value: 1 }), MERGE); // 1
    expect(
      one(s, m("set", { value: { n: 1 }, baseVersion: 1 }), route("revision")),
    ).toMatchObject({ status: "ok", version: 2 });
    expect(s.getRecord("c", "r")).toMatchObject({
      kind: "value",
      value: { n: 1 },
    });
    expect(s.getRecord("c", "r")?.fields).toBeUndefined();
    one(s, m("delete", { baseVersion: 2 }), route("revision"));
    one(s, m("add", { element: "q" }), UNION);
    expect(
      one(s, m("set", { value: [1], editedHlc: at(NOW) }), route("lastWrite")),
    ).toMatchObject({ status: "ok" });
    expect(s.getRecord("c", "r")).toMatchObject({ kind: "value", value: [1] });
    expect(s.getRecord("c", "r")?.elements).toBeUndefined();
  });
});

describe("merge records, end-to-end mode", () => {
  it("stores the ct and key id of each cell; the first accepted sealed write sets encryptionSince", () => {
    reset();
    const s = new MemoryStore();
    expect(s.getEncryptionSince()).toBeUndefined();
    one(s, m("setField", { field: BLIND(1), ct: envelope(7) }), SEALED_MERGE);
    one(s, m("setField", { field: BLIND(2), ct: envelope(8) }), SEALED_MERGE);
    expect(s.getEncryptionSince()).toBe(1);
    const cells = live(s)?.fields;
    expect(cells?.get(BLIND(1))?.kid).toBe(kidOf(7));
    expect(cells?.get(BLIND(2))?.kid).toBe(kidOf(8));
    expect(cells?.get(BLIND(1))?.value).toBe(envelope(7));
  });

  it("the conflict copy is server {fields, version, editedHlc}", () => {
    reset();
    const s = new MemoryStore();
    one(
      s,
      m("setField", { field: BLIND(1), ct: envelope(7), editedHlc: at(20) }),
      SEALED_MERGE,
    );
    one(
      s,
      m("setField", { field: BLIND(2), ct: envelope(8), editedHlc: at(30) }),
      SEALED_MERGE,
    );
    const lost = one(
      s,
      m("setField", { field: BLIND(1), ct: envelope(9), editedHlc: at(10) }),
      SEALED_MERGE,
    );
    expect(lost).toMatchObject({
      status: "conflict",
      server: {
        version: 2,
        editedHlc: at(30),
        fields: [
          { field: BLIND(1), ct: envelope(7), editedHlc: at(20) },
          { field: BLIND(2), ct: envelope(8), editedHlc: at(30) },
        ],
      },
    });
    const server = (lost as unknown as { server: Record<string, unknown> })
      .server;
    expect(server).not.toHaveProperty("value");
    expect(server).not.toHaveProperty("ct");
  });

  it("charges each cell max(envelope - 113, 0) + 45 against the 64 KiB", () => {
    reset();
    const s = new MemoryStore();
    // 100 blocks: 6,449 bytes, 6,336 over the overhead, 6,381 with the name: ten fit, an eleventh
    // does not.
    const ct = envelope(7, 100);
    for (let i = 0; i < 10; i++)
      expect(
        one(s, m("setField", { field: BLIND(i), ct }), SEALED_MERGE),
      ).toMatchObject({ status: "ok" });
    expect(
      one(s, m("setField", { field: BLIND(10), ct }), SEALED_MERGE),
    ).toMatchObject({ status: "rejected", code: "value_invalid" });
    // Replacing a cell does not double-charge it.
    expect(
      one(
        s,
        m("setField", { field: BLIND(0), ct, editedHlc: at(NOW) }),
        SEALED_MERGE,
      ),
    ).toMatchObject({ status: "ok" });
  });

  it("converts nothing: a sealed record of another shape is op_invalid_for_policy, but can be deleted", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("set", { ct: envelope(7) }), route("lastWrite", { sealed: true }));
    expect(
      one(s, m("setField", { field: BLIND(1), ct: envelope(7) }), SEALED_MERGE),
    ).toMatchObject({ status: "rejected", code: "op_invalid_for_policy" });
    expect(
      one(s, m("add", { element: BLIND(1), ct: envelope(7) }), SEALED_UNION),
    ).toMatchObject({ status: "rejected", code: "op_invalid_for_policy" });
    expect(
      one(s, m("delete", { editedHlc: at(NOW) }), SEALED_MERGE),
    ).toMatchObject({ status: "ok" });
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
    // And the other way: a sealed field record cannot take a scalar value.
    one(
      s,
      m("setField", { field: BLIND(1), ct: envelope(7), editedHlc: at(NOW) }),
      SEALED_MERGE,
    );
    expect(
      one(
        s,
        m("set", { ct: envelope(7) }),
        route("lastWrite", { sealed: true }),
      ),
    ).toMatchObject({ status: "rejected", code: "op_invalid_for_policy" });
  });

  it("a live legacy plaintext record of the same shape is not mixed with sealed cells", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("setField", { field: "a", value: 1 }), MERGE); // version 1, plaintext
    // The first sealed write anywhere fixes encryptionSince at the next sequence.
    one(
      s,
      mut("other", "o", "set", { ct: envelope(7) }),
      route("lastWrite", { sealed: true }),
    );
    expect(
      one(s, m("setField", { field: BLIND(1), ct: envelope(7) }), SEALED_MERGE),
    ).toMatchObject({ status: "rejected", code: "op_invalid_for_policy" });
  });
});

describe("union records, end-to-end mode", () => {
  it("keys an element by its blinded name; a second add keeps one element and a newer ct", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("add", { element: BLIND(1), ct: envelope(7) }), SEALED_UNION);
    one(s, m("add", { element: BLIND(2), ct: envelope(8) }), SEALED_UNION);
    one(s, m("add", { element: BLIND(1), ct: envelope(9) }), SEALED_UNION);
    const els = liveElements(live(s) as NonNullable<ReturnType<typeof live>>);
    expect(els.map(([k]) => k)).toEqual([BLIND(1), BLIND(2)]);
    expect(els[0]?.[1]).toMatchObject({
      element: envelope(9),
      tags: [1, 3],
      kid: kidOf(9),
    });
    expect(s.getEncryptionSince()).toBe(1);
  });

  it("remove takes the blinded name and observedSeq; a concurrent add survives", () => {
    reset();
    const s = new MemoryStore();
    one(s, m("add", { element: BLIND(1), ct: envelope(7) }), SEALED_UNION); // 1
    one(s, m("add", { element: BLIND(1), ct: envelope(7) }), SEALED_UNION); // 2
    one(s, m("remove", { element: BLIND(1), observedSeq: 1 }), SEALED_UNION);
    expect(live(s)).toBeDefined();
    one(s, m("remove", { element: BLIND(1), observedSeq: 2 }), SEALED_UNION);
    expect(s.getRecord("c", "r")?.deleted).toBe(true);
  });

  it("charges each element max(envelope - 113, 0) + 45 against the 64 KiB", () => {
    reset();
    const s = new MemoryStore();
    const ct = envelope(7, 100);
    for (let i = 0; i < 10; i++)
      expect(
        one(s, m("add", { element: BLIND(i), ct }), SEALED_UNION),
      ).toMatchObject({ status: "ok" });
    expect(
      one(s, m("add", { element: BLIND(10), ct }), SEALED_UNION),
    ).toMatchObject({ status: "rejected", code: "value_invalid" });
  });

  it("charges the blinded name to the quota as well as the ct", () => {
    reset();
    const s = new MemoryStore();
    const ct = envelope(7);
    one(s, m("add", { element: BLIND(1), ct }), SEALED_UNION);
    expect(s.getUsage().recordBytes).toBe(1 + 1 + 45 + (ct.length + 2));
  });
});
