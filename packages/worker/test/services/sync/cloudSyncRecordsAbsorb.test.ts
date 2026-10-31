/**
 * U-09.8: the records half of an account merge (`engine/absorbRecords.ts`, D3): every record shape
 * joins, a colliding `revision` record is parked and never overwritten, the key id (`kid`) of
 * settings, tombstones, members and records survives, and a retry writes nothing.
 * `cloudSyncSqlParityRecordsAbsorb.test.ts` replays this file over the SQLite store.
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { absorbSettings } from "../../../src/services/sync/engine/absorb.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { liveElements } from "../../../src/services/sync/engine/recordSets.js";
import type {
  Classification,
  RecordPolicy,
  StoredRecord,
} from "../../../src/services/sync/engine/types.js";
import { parseExportDocument } from "../../../src/services/sync/do/exportDoc.js";
import {
  applyAll,
  blinded as BLIND,
  kidOf,
  recordOp as mut,
  recordRoute as route,
  restartIds as reset,
  sealedBox as envelope,
  settingOp,
  settingRoute,
} from "./cloudSyncRecordsHarness.js";

const at = (ms: number) => formatHlc(1_760_000_000_000 + ms, 0);
const FROM = "subject-from";

type Op = [SyncMutation, Classification];
const put = (store: MemoryStore, ...ops: Op[]): void => {
  for (const r of applyAll(store, ops))
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
};
const maxS = (id: string, value: number, ms: number): Op => [
  mut("best", id, "set", { value: { s: value }, editedHlc: at(ms) }),
  { ...route("max"), conflictField: "s" },
];
const rec = (
  c: string,
  id: string,
  op: SyncMutation["op"],
  policy: RecordPolicy,
  extra: Partial<SyncMutation> = {},
  sealed = false,
): Op => [mut(c, id, op, extra), route(policy, { sealed })];

/** What the absorbed store exports, as the survivor's absorb reads it. */
const inputOf = (src: MemoryStore) => ({
  settings: src.rows(),
  clients: [],
  records: src.recordRows(),
  parked: src.parkedRecords(),
  fromSubject: FROM,
  now: 1_760_000_100,
});

const absorb = (
  to: MemoryStore,
  src: MemoryStore,
  extra: Partial<Parameters<typeof absorbSettings>[1]> = {},
) => to.transaction(() => absorbSettings(to, { ...inputOf(src), ...extra }));

const get = (s: MemoryStore, c: string, id: string) => s.getRecord(c, id);

describe("absorbing records: rows the survivor does not hold", () => {
  it("copies a value, a merge and a union record, and moves the usage with them", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(
      src,
      rec("saves", "a", "set", "revision", { value: { hp: 3 } }),
      rec("notes", "n", "setField", "merge", { field: "f", value: 1 }),
      rec("tags", "t", "add", "union", { element: "x" }),
      rec("tags", "t", "add", "union", { element: "y" }),
      rec("saves", "gone", "set", "revision", { value: 1 }),
    );
    put(src, rec("saves", "gone", "delete", "revision"));
    const out = absorb(to, src);
    expect(out).toMatchObject({ rows: 4, parked: 0 });
    expect(get(to, "saves", "a")?.value).toEqual({ hp: 3 });
    expect(get(to, "notes", "n")?.fields?.get("f")?.value).toBe(1);
    expect(get(to, "saves", "gone")?.deleted).toBe(true);
    const tags = get(to, "tags", "t");
    expect(liveElements(tags as StoredRecord).map(([k]) => k)).toEqual([
      '"x"',
      '"y"',
    ]);
    expect(to.getUsage()).toMatchObject({ records: 3 });
    expect(to.getUsage().recordBytes).toBe(src.getUsage().recordBytes);
  });

  it("tags the absorbed elements with the survivor's own sequence", () => {
    reset();
    const to = new MemoryStore();
    put(to, rec("notes", "n", "setField", "merge", { field: "f", value: 1 }));
    const seen = to.currentSeq();
    const src = new MemoryStore();
    // The absorbed store is further along than the survivor, with other sequences.
    src.setSeq(500);
    put(
      src,
      rec("tags", "t", "add", "union", { element: "x" }),
      rec("tags", "t", "add", "union", { element: "y" }),
    );
    absorb(to, src);
    const row = get(to, "tags", "t") as StoredRecord;
    const tags = [...(row.elements ?? [])].flatMap(([, e]) => e.tags);
    expect(tags.every((t) => t > seen && t <= to.currentSeq())).toBe(true);
    expect(row.version).toBe(to.currentSeq());
    // A device that pulled before the merge removes `x` with its old cursor: the absorbed
    // elements were added after it and survive.
    put(
      to,
      rec("tags", "t", "remove", "union", {
        element: "x",
        observedSeq: seen,
      }),
    );
    expect(
      liveElements(get(to, "tags", "t") as StoredRecord).map(([k]) => k),
    ).toEqual(['"x"', '"y"']);
  });
});

describe("absorbing records: a colliding revision record is parked (D3)", () => {
  const collide = () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(to, rec("saves", "a", "set", "revision", { value: { hp: 1 } }));
    put(src, rec("saves", "a", "set", "revision", { value: { hp: 9 } }));
    return { to, src };
  };

  it("keeps the survivor's record and parks the absorbed copy", () => {
    const { to, src } = collide();
    const before = get(to, "saves", "a");
    const out = absorb(to, src);
    expect(out).toMatchObject({ rows: 1, parked: 1 });
    expect(get(to, "saves", "a")).toEqual(before);
    expect(to.parkedRecords()).toEqual([
      expect.objectContaining({
        collection: "saves",
        id: "a",
        fromSubject: FROM,
        kind: "value",
        value: { hp: 9 },
        parkedAt: 1_760_000_100,
      }),
    ]);
    // Parked copies are data the person holds, not usage.
    expect(to.getUsage().records).toBe(1);
    expect(to.isEmpty()).toBe(false);
  });

  it("is idempotent, and a fresher export of the same source replaces its parked copy", () => {
    const { to, src } = collide();
    absorb(to, src);
    const snap = JSON.stringify(to.snapshot());
    expect(absorb(to, src)).toMatchObject({ rows: 0, parked: 0 });
    expect(JSON.stringify(to.snapshot())).toBe(snap);
    put(src, rec("saves", "a", "set", "revision", { value: { hp: 10 } }));
    expect(absorb(to, src, { now: 1_760_000_900 })).toMatchObject({
      rows: 1,
      parked: 1,
    });
    expect(to.parkedRecords()).toHaveLength(1);
    expect(to.parkedRecords()[0]).toMatchObject({
      value: { hp: 10 },
      parkedAt: 1_760_000_900,
    });
  });

  it("keeps copies of different sources side by side, and carries parked copies onward", () => {
    const { to, src } = collide();
    absorb(to, src);
    const third = new MemoryStore();
    put(third, rec("saves", "a", "set", "revision", { value: { hp: 5 } }));
    absorb(to, third, { fromSubject: "other" });
    // In the order they were parked, then by name.
    expect(to.parkedRecords().map((p) => p.fromSubject)).toEqual([
      "other",
      FROM,
    ]);
    // The survivor is later absorbed itself: its parked copies go with the rest of its data.
    const next = new MemoryStore();
    const out = absorb(next, to, { fromSubject: "to-subject" });
    expect(out.parked).toBe(2);
    expect(next.parkedRecords().map((p) => p.fromSubject)).toEqual([
      "other",
      FROM,
    ]);
    expect(get(next, "saves", "a")?.value).toEqual({ hp: 1 });
  });

  it("an equal value is no collision, and a rolled-back absorb leaves nothing parked", () => {
    const { to, src } = collide();
    put(src, rec("saves", "a", "set", "revision", { value: { hp: 1 } }));
    expect(absorb(to, src)).toMatchObject({ rows: 0, parked: 0 });
    expect(to.parkedRecords()).toEqual([]);
    put(src, rec("saves", "a", "set", "revision", { value: { hp: 2 } }));
    expect(() =>
      to.transaction(() => {
        absorbSettings(to, inputOf(src));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(to.parkedRecords()).toEqual([]);
  });

  it("parks a collision of two live records of different shapes", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(to, rec("c", "a", "set", "revision", { value: { f: 1 } }));
    put(src, rec("c", "a", "setField", "merge", { field: "f", value: 2 }));
    expect(absorb(to, src)).toMatchObject({ parked: 1 });
    expect(get(to, "c", "a")).toMatchObject({ kind: "value" });
    expect(to.parkedRecords()[0]).toMatchObject({ kind: "fields" });
    expect([...(to.parkedRecords()[0]?.fields ?? [])]).toHaveLength(1);
  });
});

describe("absorbing records: the other policies join by stamp", () => {
  it("lastWrite, when the caller names it, takes the newer stamp; max and min the better field", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(
      to,
      rec("lw", "a", "set", "lastWrite", { value: 1, editedHlc: at(10) }),
      maxS("a", 5, 50),
    );
    put(
      src,
      rec("lw", "a", "set", "lastWrite", { value: 2, editedHlc: at(20) }),
      maxS("a", 9, 1),
    );
    const out = absorb(to, src, {
      recordPolicies: new Map([
        ["lw", { policy: "lastWrite" }],
        ["best", { policy: "max", conflictField: "s" }],
      ]),
    });
    expect(out.parked).toBe(0);
    expect(get(to, "lw", "a")?.value).toBe(2);
    // The better value wins whatever its clock (the clock is the stamp's, which stays the survivor's... of the winner).
    expect(get(to, "best", "a")?.value).toEqual({ s: 9 });
    // The older lastWrite loses, with nothing parked.
    const older = new MemoryStore();
    put(
      older,
      rec("lw", "a", "set", "lastWrite", { value: 0, editedHlc: at(1) }),
    );
    expect(
      absorb(to, older, {
        recordPolicies: new Map([["lw", { policy: "lastWrite" }]]),
      }),
    ).toMatchObject({ rows: 0 });
    expect(get(to, "lw", "a")?.value).toBe(2);
  });

  it("a deletion newer than the value wins, an older one does not", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(
      to,
      rec("saves", "a", "set", "revision", { value: 1, editedHlc: at(10) }),
      rec("saves", "b", "set", "revision", { value: 1, editedHlc: at(10) }),
    );
    put(
      src,
      rec("saves", "a", "set", "revision", { value: 1, editedHlc: at(1) }),
      rec("saves", "b", "set", "revision", { value: 1, editedHlc: at(1) }),
    );
    put(
      src,
      rec("saves", "a", "delete", "revision", { editedHlc: at(20) }),
      rec("saves", "b", "delete", "revision", { editedHlc: at(5) }),
    );
    absorb(to, src);
    expect(get(to, "saves", "a")?.deleted).toBe(true);
    expect(get(to, "saves", "b")?.deleted).toBe(false);
    expect(to.getUsage().records).toBe(1);
  });
});

describe("absorbing records: merge and union", () => {
  it("merge cells union, each name keeping the later stamp, and a newer delete drops older cells", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(
      to,
      rec("n", "r", "setField", "merge", {
        field: "a",
        value: 1,
        editedHlc: at(10),
      }),
      rec("n", "r", "setField", "merge", {
        field: "b",
        value: 1,
        editedHlc: at(30),
      }),
      rec("n", "k", "setField", "merge", {
        field: "a",
        value: 1,
        editedHlc: at(10),
      }),
    );
    put(
      src,
      rec("n", "r", "setField", "merge", {
        field: "a",
        value: 2,
        editedHlc: at(20),
      }),
      rec("n", "r", "setField", "merge", {
        field: "b",
        value: 2,
        editedHlc: at(5),
      }),
      rec("n", "r", "setField", "merge", {
        field: "c",
        value: 3,
        editedHlc: at(6),
      }),
      rec("n", "k", "setField", "merge", {
        field: "a",
        value: 9,
        editedHlc: at(2),
      }),
    );
    put(src, rec("n", "k", "delete", "merge", { editedHlc: at(15) }));
    absorb(to, src);
    const r = get(to, "n", "r");
    expect(
      Object.fromEntries([...(r?.fields ?? [])].map(([n, c]) => [n, c.value])),
    ).toEqual({
      a: 2,
      b: 1,
      c: 3,
    });
    // The newer delete on the absorbed side cleared the survivor's older cell: a tombstone.
    expect(get(to, "n", "k")).toMatchObject({ deleted: true });
    expect(get(to, "n", "k")?.floor?.hlc).toBe(at(15));
    expect(to.getUsage().records).toBe(1);
  });

  it("a union adds only what the survivor does not hold, and a set deleted later takes nothing", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(
      to,
      rec("tags", "t", "add", "union", { element: "x", editedHlc: at(10) }),
      rec("tags", "gone", "add", "union", { element: "z", editedHlc: at(1) }),
    );
    put(to, rec("tags", "gone", "delete", "union", { editedHlc: at(50) }));
    put(
      src,
      rec("tags", "t", "add", "union", { element: "x", editedHlc: at(11) }),
      rec("tags", "t", "add", "union", { element: "y", editedHlc: at(12) }),
      rec("tags", "gone", "add", "union", { element: "w", editedHlc: at(20) }),
    );
    absorb(to, src);
    expect(
      liveElements(get(to, "tags", "t") as StoredRecord).map(([k]) => k),
    ).toEqual(['"x"', '"y"']);
    expect(get(to, "tags", "gone")?.deleted).toBe(true);
    const snap = JSON.stringify(to.snapshot());
    expect(absorb(to, src).rows).toBe(0);
    expect(JSON.stringify(to.snapshot())).toBe(snap);
  });

  it("a tombstone takes the other side's shape: a delete of a value record clears a merge record's older cells", () => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    put(
      to,
      rec("c", "a", "setField", "merge", {
        field: "f",
        value: 1,
        editedHlc: at(5),
      }),
    );
    put(src, rec("c", "a", "set", "revision", { value: 1, editedHlc: at(1) }));
    put(src, rec("c", "a", "delete", "revision", { editedHlc: at(9) }));
    absorb(to, src);
    expect(get(to, "c", "a")).toMatchObject({ kind: "fields", deleted: true });
  });
});

describe("absorbing records: the key id travels", () => {
  it("settings, their tombstones and their members keep `kid` through a parsed export", () => {
    reset();
    const src = new MemoryStore();
    put(
      src,
      [
        settingOp(BLIND(1), "set", { ct: envelope(7) }),
        settingRoute("lastWrite", true),
      ],
      [
        settingOp(BLIND(2), "setMember", { member: BLIND(3), ct: envelope(9) }),
        settingRoute("merge", true),
      ],
      [
        settingOp(BLIND(4), "set", { ct: envelope(5) }),
        settingRoute("lastWrite", true),
      ],
    );
    put(src, [settingOp(BLIND(4), "clear"), settingRoute("lastWrite", true)]);
    const doc = {
      settings: src.rows().map(({ members, ...r }) => ({
        ...r,
        ...(members ? { members: [...members] } : {}),
      })),
      clients: [],
    };
    const parsed = parseExportDocument(doc);
    expect(parsed).not.toBeNull();
    const to = new MemoryStore();
    to.transaction(() =>
      absorbSettings(to, { settings: parsed!.settings, clients: [] }),
    );
    const row = (k: string) => to.rows().find((r) => r.key === k);
    expect(row(BLIND(1))?.kid).toBe(kidOf(7));
    expect(row(BLIND(2))?.members?.get(BLIND(3))?.kid).toBe(kidOf(9));
    expect(row(BLIND(4))).toMatchObject({ deleted: true, kid: kidOf(5) });
    // A joined merge row keeps each member's own key id too.
    const more = new MemoryStore();
    put(more, [
      settingOp(BLIND(2), "setMember", {
        member: BLIND(6),
        ct: envelope(11),
        editedHlc: at(1),
      }),
      settingRoute("merge", true),
    ]);
    to.transaction(() =>
      absorbSettings(to, { settings: more.rows(), clients: [] }),
    );
    const members = row(BLIND(2))?.members;
    expect(members?.get(BLIND(3))?.kid).toBe(kidOf(9));
    expect(members?.get(BLIND(6))?.kid).toBe(kidOf(11));
    expect(row(BLIND(2))?.kid).toBeUndefined();
  });

  it("sealed records of every shape keep their key ids and join without reading them", () => {
    reset();
    const src = new MemoryStore();
    put(
      src,
      rec("c", BLIND(1), "set", "revision", { ct: envelope(7) }, true),
      rec(
        "c",
        BLIND(2),
        "setField",
        "merge",
        { field: BLIND(3), ct: envelope(8) },
        true,
      ),
      rec(
        "c",
        BLIND(4),
        "add",
        "union",
        { element: BLIND(5), ct: envelope(9) },
        true,
      ),
    );
    const doc = {
      settings: [],
      clients: [],
      records: src.recordRows().map(({ fields, elements, ...r }) => ({
        ...r,
        ...(fields ? { fields: [...fields] } : {}),
        ...(elements ? { elements: [...elements] } : {}),
      })),
    };
    const parsed = parseExportDocument(doc);
    expect(parsed?.records).toHaveLength(3);
    const to = new MemoryStore();
    to.transaction(() =>
      absorbSettings(to, {
        settings: [],
        clients: [],
        records: parsed!.records,
      }),
    );
    expect(get(to, "c", BLIND(1))?.kid).toBe(kidOf(7));
    expect(get(to, "c", BLIND(2))?.fields?.get(BLIND(3))?.kid).toBe(kidOf(8));
    expect(get(to, "c", BLIND(4))?.elements?.get(BLIND(5))?.kid).toBe(kidOf(9));
    // A different sealed value collides without being compared by content: parked.
    const other = new MemoryStore();
    put(
      other,
      rec("c", BLIND(1), "set", "revision", { ct: envelope(6) }, true),
    );
    expect(absorb(to, other)).toMatchObject({ parked: 1 });
    expect(to.parkedRecords()[0]?.kid).toBe(kidOf(6));
  });
});

describe("the export parser", () => {
  const base = { settings: [], clients: [] };
  const good = {
    collection: "saves",
    id: "a",
    version: 3,
    stamp: { hlc: at(1), clientId: "c_000000000000000client1" },
    deleted: false,
    kind: "value",
    value: { hp: 1 },
  };

  it("reads an export from before records as having none", () => {
    expect(parseExportDocument(base)).toMatchObject({
      records: [],
      parked: [],
    });
  });

  it("reads records, parked copies and refuses a malformed one whole", () => {
    expect(
      parseExportDocument({ ...base, records: [good] })?.records,
    ).toHaveLength(1);
    const parked = { ...good, fromSubject: "s", parkedAt: 5 };
    expect(
      parseExportDocument({ ...base, parked: [parked] })?.parked,
    ).toHaveLength(1);
    const bad = (over: object) => ({
      ...base,
      records: [{ ...good, ...over }],
    });
    for (const d of [
      { ...base, records: "nope" },
      { ...base, parked: {} },
      bad({ collection: "bad name" }),
      bad({ id: "" }),
      bad({ kind: "blob" }),
      bad({ deleted: "no" }),
      bad({ stamp: { hlc: "x", clientId: "c" } }),
      bad({ kid: "xyz" }),
      bad({ fields: [] }),
      bad({ kind: "fields", value: null }),
      bad({ kind: "fields", value: null, fields: [["f", { value: 1 }]] }),
      bad({
        kind: "set",
        value: null,
        elements: [["e", { element: 1, tags: [] }]],
      }),
      bad({
        kind: "set",
        value: null,
        elements: [["e", { element: 1, tags: [0] }]],
      }),
      bad({ floor: { hlc: "x", clientId: "c" } }),
      { ...base, parked: [{ ...parked, parkedAt: -1 }] },
      { ...base, parked: [{ ...parked, fromSubject: "" }] },
    ])
      expect(parseExportDocument(d), JSON.stringify(d)).toBeNull();
    // Settings carry the key id too: a malformed one is refused.
    expect(
      parseExportDocument({
        ...base,
        settings: [
          {
            key: "k",
            scope: "user",
            deleted: false,
            value: 1,
            stamp: good.stamp,
            kid: "nope",
          },
        ],
      }),
    ).toBeNull();
  });
});
