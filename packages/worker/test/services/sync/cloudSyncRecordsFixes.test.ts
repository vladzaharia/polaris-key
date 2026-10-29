/**
 * U-09.R: the fixes of the U-09 security review, on the engine. Removed cells and tag rows are
 * charged and bounded per record (B1, B2), an absorb keeps sealed and plaintext rows apart (B3),
 * parked copies are charged and bounded (N1), a policy conversion keeps the 1 KiB caps (N3), and
 * `encryptionSince` is fixed by a write only, refusing server-mode writes after it (N5, N6).
 * `cloudSyncSqlParityRecordsFixes.test.ts` replays this file over the SQLite store.
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { absorbSettings } from "../../../src/services/sync/engine/absorb.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { MAX_PARKED_COPIES } from "../../../src/services/sync/engine/absorbRecords.js";
import {
  parkedCost,
  recordCost,
} from "../../../src/services/sync/engine/usage.js";
import type {
  Classification,
  RecordPolicy,
} from "../../../src/services/sync/engine/types.js";
import {
  absorbInputOf,
  applyAll,
  applyOk,
  blinded as BLIND,
  NOW,
  pullAs,
  recordOp as mut,
  recordRoute as route,
  restartIds as reset,
  sealedBox as envelope,
  settingOp,
  settingRoute,
} from "./cloudSyncRecordsHarness.js";

type Op = [SyncMutation, Classification];
const put = (store: MemoryStore, ...ops: Op[]): void => applyOk(store, ...ops);
const at = (n: number) => formatHlc(NOW - 100_000 + n, 0);
const one = (store: MemoryStore, ...op: Op) => applyAll(store, [op])[0]!;
const MERGE = route("merge", { maxRecords: 1000 });
const UNION = route("union");

const absorb = (to: MemoryStore, src: MemoryStore) =>
  to.transaction(() => absorbSettings(to, absorbInputOf(src, "from")));

describe("B1: removed cells are bounded per record", () => {
  const removeMany = (s: MemoryStore, from: number, to: number) => {
    for (let at0 = from; at0 < to; at0 += 100) {
      const ops: Op[] = [];
      for (let i = at0; i < Math.min(at0 + 100, to); i++)
        ops.push([
          mut("notes", "n", "removeField", {
            field: `gone${String(i).padStart(4, "0")}`,
            editedHlc: at(i),
          }),
          MERGE,
        ]);
      put(s, ...ops);
    }
  };

  it("keeps the newest 256 removed cells of a record, whichever names were removed", () => {
    reset();
    const s = new MemoryStore();
    put(s, [mut("notes", "n", "setField", { field: "keep", value: 1 }), MERGE]);
    removeMany(s, 0, 600);
    const cells = [...(s.getRecord("notes", "n")?.fields ?? [])];
    const removed = cells.filter(([, c]) => c.removed).map(([name]) => name);
    expect(removed).toHaveLength(256);
    // The oldest by stamp went: what is left is the last 256 names.
    expect(removed.sort()[0]).toBe("gone0344");
    expect(cells.find(([name]) => name === "keep")?.[1].removed).toBe(false);
    // A live cell is never dropped for the bound, and the record is live.
    expect(s.getRecord("notes", "n")?.deleted).toBe(false);
  });

  it("clamps the cells an absorb joins, and a copy of an absorbed record", () => {
    reset();
    const src = new MemoryStore();
    put(src, [
      mut("notes", "n", "setField", { field: "keep", value: 1 }),
      MERGE,
    ]);
    // Build 300 removed cells in the source the way a pre-fix store could hold them.
    const row = src.getRecord("notes", "n")!;
    for (let i = 0; i < 300; i++)
      row.fields!.set(`gone${String(i).padStart(3, "0")}`, {
        value: null,
        removed: true,
        stamp: { hlc: at(i), clientId: "c_000000000000000client1" },
      });
    src.putRecord(row);
    const to = new MemoryStore();
    absorb(to, src);
    const removed = [...(to.getRecord("notes", "n")?.fields ?? [])].filter(
      ([, c]) => c.removed,
    );
    expect(removed).toHaveLength(256);
    // Idempotent: the same export again changes nothing.
    expect(absorb(to, src).rows).toBe(0);
  });
});

describe("B2: every live entry and extra tag is charged", () => {
  it("charges 45 for a field and for an element, 8 for each tag past the first", () => {
    reset();
    const s = new MemoryStore();
    put(s, [mut("c", "r", "setField", { field: "ab", value: "x" }), MERGE]);
    // "c" + "r" + "ab" + `"x"` + 45
    expect(s.getUsage().recordBytes).toBe(1 + 1 + 2 + 3 + 45);
    const t = new MemoryStore();
    for (let i = 0; i < 9; i++)
      put(t, [mut("c", "r", "add", { element: "x" }), UNION]);
    // Eight tags at most: the element is `"x"`, 45, and seven extra tags.
    expect(recordCost(t.getRecord("c", "r")).bytes).toBe(
      1 + 1 + 3 + 45 + 7 * 8,
    );
    expect(t.getUsage().recordBytes).toBe(1 + 1 + 3 + 45 + 7 * 8);
  });

  it("holds a union record of tiny elements to what its charge allows", () => {
    reset();
    const s = new MemoryStore();
    let accepted = 0;
    outer: for (let batch = 0; batch < 40; batch++) {
      for (let i = 0; i < 50; i++) {
        const n = batch * 50 + i;
        const r = one(s, mut("c", "r", "add", { element: n }), UNION);
        if (r.status !== "ok") {
          expect(r).toMatchObject({
            status: "rejected",
            code: "value_invalid",
          });
          break outer;
        }
        accepted++;
      }
    }
    // 64 KiB / (45 + the element's digits + the array's comma): about 1,400, not the 13,000 that
    // canonical JSON alone would allow.
    expect(accepted).toBeGreaterThan(1000);
    expect(accepted).toBeLessThan(1500);
  });

  it("charges the tags in the record budget, so repeated adds cannot hide rows", () => {
    reset();
    const s = new MemoryStore();
    // Elements of 900 bytes, each added 8 times: charged 900 + 45 + 7 x 8 each, about 65 fit in
    // 64 KiB; with the tag rows free, 69 would.
    let full = 0;
    for (let i = 0; i < 80; i++) {
      const element = String(i).padStart(3, "0") + "e".repeat(897);
      let refused = false;
      for (let tag = 0; tag < 8 && !refused; tag++)
        refused =
          one(s, mut("c", "r", "add", { element }), UNION).status !== "ok";
      if (refused) break;
      full++;
    }
    expect(full).toBeGreaterThanOrEqual(60);
    expect(full).toBeLessThanOrEqual(66);
  });
});

/** A survivor that already holds a sealed record, so it has `encryptionSince`. */
const sealedSurvivor = (): MemoryStore => {
  const to = new MemoryStore();
  put(to, [
    mut("saves", BLIND(2), "set", { ct: envelope(9) }),
    route("revision", { sealed: true }),
  ]);
  return to;
};

describe("B3: an absorb keeps sealed and plaintext rows apart", () => {
  const sealedSource = () => {
    reset();
    const src = new MemoryStore();
    put(
      src,
      [
        mut("saves", BLIND(1), "set", { ct: envelope(9) }),
        route("revision", { sealed: true }),
      ],
      [
        settingOp("x:" + "B".repeat(43), "set", { ct: envelope(9) }),
        settingRoute("lastWrite", true),
      ],
    );
    return src;
  };
  const plainSource = () => {
    reset();
    const src = new MemoryStore();
    put(
      src,
      [
        mut("notes", "n1", "setField", { field: "title", value: "hello" }),
        MERGE,
      ],
      [mut("notes", "n1", "setField", { field: "count", value: 3 }), MERGE],
      [settingOp("plain.key", "set", { value: 1 }), settingRoute("lastWrite")],
    );
    return src;
  };

  it("sealed rows into a survivor without encryptionSince fix it, and are served sealed", () => {
    const src = sealedSource();
    const to = new MemoryStore();
    expect(to.getEncryptionSince()).toBeUndefined();
    absorb(to, src);
    const since = to.getEncryptionSince();
    expect(since).toBeDefined();
    const pulled = pullAs(to, { e2e: true });
    expect(pulled.encryptionSince).toBe(since);
    expect(pulled.changes).toHaveLength(2);
    for (const c of pulled.changes) {
      expect(c.version).toBeGreaterThanOrEqual(since!);
      expect("ct" in c).toBe(true);
    }
  });

  it("plaintext rows join first, below encryptionSince, beside sealed ones", () => {
    const sealed = sealedSource();
    const to = new MemoryStore();
    put(to, [
      mut("legacy", "l", "set", { value: { a: 1 } }),
      route("revision"),
    ]);
    const plain = plainSource();
    // One export carrying both kinds.
    const mixed = {
      ...absorbInputOf(sealed, "from"),
      settings: [...plain.rows(), ...sealed.rows()],
      records: [...plain.recordRows(), ...sealed.recordRows()],
    };
    to.transaction(() => absorbSettings(to, mixed));
    const since = to.getEncryptionSince()!;
    expect(since).toBeDefined();
    const notes = to.getRecord("notes", "n1")!;
    expect(notes.version).toBeLessThan(since);
    expect(to.getRecord("saves", BLIND(1))!.version).toBeGreaterThanOrEqual(
      since,
    );
    expect(to.getRecord("legacy", "l")!.version).toBeLessThan(since);
    const change = pullAs(to, { e2e: true }).changes.find(
      (c) => "record" in c && c.record[0] === "notes",
    );
    // Below `encryptionSince` it is legacy plaintext: served as it is.
    expect(change).toMatchObject({ value: { count: 3, title: "hello" } });
  });

  it("live plaintext rows into a survivor with encryptionSince are parked or left out, never written", () => {
    const src = plainSource();
    const to = sealedSurvivor();
    const out = absorb(to, src);
    expect(to.getRecord("notes", "n1")).toBeUndefined();
    expect(to.getParkedRecord("notes", "n1", "from")).toBeDefined();
    expect(out.parked).toBe(1);
    // A setting has no parked table: it is left out, and counted.
    expect(to.rows().some((r) => r.key === "plain.key")).toBe(false);
    expect(out.skipped).toBe(1);
    // Nothing plaintext is served as sealed.
    for (const c of pullAs(to, { e2e: true }).changes)
      expect("record" in c ? c.record[0] : "").not.toBe("notes");
    // Absorbing it again changes nothing.
    expect(absorb(to, src).rows).toBe(0);
  });

  it("a plaintext tombstone still joins a survivor with encryptionSince", () => {
    reset();
    const src = new MemoryStore();
    put(
      src,
      [
        mut("notes", "n1", "setField", {
          field: "f",
          value: 1,
          editedHlc: at(1),
        }),
        MERGE,
      ],
      [mut("notes", "n1", "delete", { editedHlc: at(2) }), MERGE],
    );
    const to = sealedSurvivor();
    absorb(to, src);
    expect(to.getRecord("notes", "n1")?.deleted).toBe(true);
    expect(to.parkedCount()).toBe(0);
  });

  it("a sealed record meeting a live legacy-plaintext record is parked, never mixed", () => {
    const src = sealedSource();
    const to = new MemoryStore();
    // The survivor holds a plaintext record of the same name, written before any sealed one.
    put(to, [
      mut("saves", BLIND(1), "set", { value: { hp: 1 } }),
      route("revision"),
    ]);
    const out = absorb(to, src);
    expect(to.getRecord("saves", BLIND(1))).toMatchObject({ value: { hp: 1 } });
    expect(to.getParkedRecord("saves", BLIND(1), "from")).toBeDefined();
    expect(out.parked).toBeGreaterThanOrEqual(1);
  });
});

describe("N1: parked copies are charged and bounded", () => {
  const collide = (count: number, value: (i: number) => number) => {
    reset();
    const to = new MemoryStore();
    const src = new MemoryStore();
    const ids = Array.from(
      { length: count },
      (_, i) => `r${String(i).padStart(3, "0")}`,
    );
    for (const [s, f] of [
      [to, (i: number) => i],
      [src, value],
    ] as const)
      for (let i = 0; i < ids.length; i += 50)
        put(
          s,
          ...ids
            .slice(i, i + 50)
            .map(
              (id, k) =>
                [
                  mut("saves", id, "set", { value: { v: f(i + k) } }),
                  route("revision", { maxRecords: 1000 }),
                ] as Op,
            ),
        );
    return { to, src, ids };
  };

  it("counts the bytes of a parked copy in the usage", () => {
    const { to, src } = collide(3, (i) => i + 100);
    const before = to.getUsage().bytes;
    absorb(to, src);
    const parked = to.parkedRecords();
    expect(parked).toHaveLength(3);
    expect(to.getUsage().bytes).toBe(
      before + parked.reduce((n, p) => n + parkedCost(p), 0),
    );
    expect(to.getUsage().bytes).toBeGreaterThan(before);
  });

  it("keeps at most 64 parked copies, dropping the oldest, and the usage follows", () => {
    const { to, src, ids } = collide(70, (i) => i + 1000);
    const live = to.recordRows().reduce((n, r) => n + recordCost(r).bytes, 0);
    absorb(to, src);
    const parked = to.parkedRecords();
    expect(parked).toHaveLength(MAX_PARKED_COPIES);
    expect(to.parkedCount()).toBe(MAX_PARKED_COPIES);
    // The copies parked last stay: the oldest by (time, name) went.
    expect(parked.map((p) => p.id)).toContain(ids[69]);
    expect(parked.map((p) => p.id)).not.toContain(ids[0]);
    expect(to.getUsage().bytes).toBe(
      live + parked.reduce((n, p) => n + parkedCost(p), 0),
    );
  });

  it("a fresher copy from the same source replaces the earlier one (the earlier is lost)", () => {
    const { to, src } = collide(1, () => 500);
    absorb(to, src);
    const first = to.getParkedRecord("saves", "r000", "from")!;
    expect(first.value).toEqual({ v: 500 });
    const fresh = new MemoryStore();
    put(fresh, [
      mut("saves", "r000", "set", { value: { v: 99999 } }),
      route("revision"),
    ]);
    absorb(to, fresh);
    expect(to.parkedCount()).toBe(1);
    expect(to.getParkedRecord("saves", "r000", "from")!.value).toEqual({
      v: 99999,
    });
  });
});

describe("N3: a policy conversion keeps the 1 KiB caps", () => {
  it("an over-long field name of a converted object is op_invalid_for_policy", () => {
    reset();
    const s = new MemoryStore();
    const big = "n".repeat(2000);
    put(s, [
      mut("c", "r", "set", { value: { [big]: 1, ok: 2 } }),
      route("revision"),
    ]);
    expect(
      one(s, mut("c", "r", "setField", { field: "z", value: 1 }), MERGE),
    ).toMatchObject({
      status: "rejected",
      code: "op_invalid_for_policy",
    });
    // Within the cap it converts, as before.
    const t = new MemoryStore();
    put(t, [mut("c", "r", "set", { value: { ok: 2 } }), route("revision")]);
    expect(
      one(t, mut("c", "r", "setField", { field: "z", value: 1 }), MERGE).status,
    ).toBe("ok");
  });

  it("an over-long element of a converted array is op_invalid_for_policy", () => {
    reset();
    const s = new MemoryStore();
    put(s, [
      mut("c", "r", "set", { value: ["s".repeat(2000), "t"] }),
      route("revision"),
    ]);
    expect(one(s, mut("c", "r", "add", { element: "u" }), UNION)).toMatchObject(
      {
        status: "rejected",
        code: "op_invalid_for_policy",
      },
    );
  });
});

describe("N5 and N6: encryptionSince is fixed by a write, and closes the store to plaintext", () => {
  it("a sealed mutation that wrote nothing does not fix it", () => {
    reset();
    const s = new MemoryStore();
    const sealedRev = route("revision", { sealed: true });
    // A delete of a record the store does not hold: `ok`, and nothing written.
    expect(one(s, mut("saves", BLIND(1), "delete"), sealedRev).status).toBe(
      "ok",
    );
    expect(s.getEncryptionSince()).toBeUndefined();
    put(s, [mut("saves", BLIND(1), "set", { ct: envelope(9) }), sealedRev]);
    expect(s.getEncryptionSince()).toBe(1);
  });

  it("is the sequence of the first sealed write, after plaintext writes of the same batch", () => {
    reset();
    const s = new MemoryStore();
    put(
      s,
      [mut("legacy", "l", "set", { value: 1 }), route("revision")],
      [
        mut("saves", BLIND(1), "set", { ct: envelope(9) }),
        route("revision", { sealed: true }),
      ],
    );
    expect(s.getEncryptionSince()).toBe(2);
    expect(s.getRecord("legacy", "l")!.version).toBe(1);
  });

  it("refuses a server-mode write once it is set, and still takes a delete", () => {
    reset();
    const s = new MemoryStore();
    put(s, [
      mut("saves", BLIND(1), "set", { ct: envelope(9) }),
      route("revision", { sealed: true }),
    ]);
    const mismatch = { status: "rejected", code: "encryption_mismatch" };
    for (const [m, r] of [
      [mut("legacy", "l", "set", { value: 1 }), route("revision")],
      [mut("notes", "n", "setField", { field: "f", value: 1 }), MERGE],
      [mut("tags", "t", "add", { element: "x" }), UNION],
      [settingOp("plain.key", "set", { value: 1 }), settingRoute("lastWrite")],
    ] as Op[])
      expect(one(s, m, r)).toMatchObject(mismatch);
    expect(s.getRecord("legacy", "l")).toBeUndefined();
    expect(one(s, mut("legacy", "l", "delete"), route("revision")).status).toBe(
      "ok",
    );
    // Sealed writes go on.
    expect(
      one(
        s,
        mut("saves", BLIND(3), "set", { ct: envelope(9) }),
        route("revision", { sealed: true }),
      ).status,
    ).toBe("ok");
  });
});

export type { RecordPolicy };
