/**
 * U-09.4: the scalar record policies of the Cloud Sync engine (WIRE-CONTRACT-V5 §13.3;
 * plans/U-09-slices.md §2.2), over the in-memory store. `cloudSyncSqlParityRecords.test.ts`
 * replays this file over the Durable Object's SQLite store.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_MAX_CLOCK_SKEW_MS,
  type MutationResult,
  type PushRequest,
  type SyncJson,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { applyPush } from "../../../src/services/sync/engine/push.js";
import { MAX_PERSON_RECORD_TOMBSTONES } from "../../../src/services/sync/engine/records.js";
import type {
  Classification,
  PushInput,
  PushLimits,
  PushOutcome,
  RecordPolicy,
} from "../../../src/services/sync/engine/types.js";
import { recordCost } from "../../../src/services/sync/engine/usage.js";

const C1 = "c_000000000000000client1";
const C2 = "c_000000000000000client2";
const NOW = 1_760_000_000_000;
const at = (ms: number, counter = 0) => formatHlc(ms, counter);

type Route = Extract<Classification, { verdict: "record" }>;
const route = (
  policy: RecordPolicy,
  extra: Partial<Omit<Route, "verdict" | "policy">> = {},
): Route => ({ verdict: "record", policy, maxRecords: 100, ...extra });

let nextId = 1;
const mut = (
  collection: string,
  id: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: nextId++,
  target: { record: [collection, id] },
  op,
  editedHlc: at(NOW - 1000),
  ...extra,
});

/** Applies a batch as one client of one device; `classified` is one route for all, or per mutation. */
function push(
  store: MemoryStore,
  mutations: SyncMutation[],
  classified: Classification | Classification[],
  opts: { clientId?: string; limits?: PushLimits; atomic?: boolean } = {},
): PushOutcome {
  const request: PushRequest = {
    clientId: opts.clientId ?? C1,
    cursor: 0,
    mutations,
  };
  if (opts.atomic !== undefined) request.atomic = opts.atomic;
  const routes = Array.isArray(classified)
    ? classified
    : mutations.map(() => classified);
  const input: PushInput = {
    deviceId: "dev1",
    serverNow: NOW,
    classified: routes,
    request,
  };
  if (opts.limits) input.limits = opts.limits;
  return applyPush(store, input);
}

/** The results of a push that was not refused as a whole. */
const run = (...args: Parameters<typeof push>): MutationResult[] => {
  const out = push(...args);
  if (!out.ok) throw new Error(`push failed: ${JSON.stringify(out)}`);
  return out.results;
};

const one = (
  store: MemoryStore,
  m: SyncMutation,
  r: Classification,
  opts?: Parameters<typeof push>[3],
): MutationResult => run(store, [m], r, opts)[0] as MutationResult;

const ENV_LEN = 49 + 64;
/** A shaped envelope with a recognisable key id (byte 1 = `kid`, the rest filler). */
const envelope = (kid = 7): string => {
  const bytes = new Uint8Array(ENV_LEN).fill(kid);
  bytes[0] = 1;
  return Buffer.from(bytes).toString("base64url");
};
const BLIND = (c: number) => `x:${String(c).padStart(43, "A")}`;

const reset = () => {
  nextId = 1;
};

describe("revision records", () => {
  it("creates unconditionally, then compare-and-swaps on baseVersion", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision");
    const a = one(s, mut("saves", "s1", "set", { value: { n: 1 } }), r);
    expect(a).toMatchObject({ status: "ok", version: 1 });
    // The right version swaps.
    expect(
      one(s, mut("saves", "s1", "set", { value: { n: 2 }, baseVersion: 1 }), r),
    ).toMatchObject({ status: "ok", version: 2 });
    // A stale version is a conflict carrying the server copy.
    expect(
      one(s, mut("saves", "s1", "set", { value: { n: 3 }, baseVersion: 1 }), r),
    ).toMatchObject({
      status: "conflict",
      server: { value: { n: 2 }, version: 2, editedHlc: at(NOW - 1000) },
    });
    // Absent is unconditional, whatever the clock.
    expect(
      one(
        s,
        mut("saves", "s1", "set", { value: { n: 4 }, editedHlc: at(1) }),
        r,
      ),
    ).toMatchObject({ status: "ok", version: 3 });
    expect(s.getRecord("saves", "s1")?.value).toEqual({ n: 4 });
  });

  it("star is create-only, and a number against a missing record conflicts", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision");
    expect(
      one(s, mut("saves", "s1", "set", { value: 1, baseVersion: 5 }), r),
    ).toMatchObject({
      status: "conflict",
      server: { value: null, version: 0 },
    });
    expect(
      one(s, mut("saves", "s1", "set", { value: 1, baseVersion: "*" }), r),
    ).toMatchObject({ status: "ok", version: 1 });
    expect(
      one(s, mut("saves", "s1", "set", { value: 2, baseVersion: "*" }), r),
    ).toMatchObject({ status: "conflict", server: { value: 1, version: 1 } });
  });

  it("a mutation without editedHlc is stamped with the server's clock", () => {
    reset();
    const s = new MemoryStore();
    const m = mut("saves", "s1", "set", { value: 1, baseVersion: "*" });
    delete m.editedHlc;
    one(s, m, route("revision"));
    expect(s.getRecord("saves", "s1")?.stamp.hlc).toBe(at(NOW, 0));
  });

  it("clamps an editedHlc from the future", () => {
    reset();
    const s = new MemoryStore();
    one(
      s,
      mut("saves", "s1", "set", {
        value: 1,
        editedHlc: at(NOW + SYNC_MAX_CLOCK_SKEW_MS + 60_000),
      }),
      route("revision"),
    );
    expect(s.getRecord("saves", "s1")?.stamp.hlc).toBe(at(NOW, 0));
  });
});

describe("lastWrite records", () => {
  it("orders by editedHlc, clientId breaking ties; a loser takes the server copy", () => {
    reset();
    const s = new MemoryStore();
    const r = route("lastWrite");
    one(
      s,
      mut("session", "a", "set", { value: "new", editedHlc: at(NOW - 10) }),
      r,
    );
    expect(
      one(
        s,
        mut("session", "a", "set", { value: "old", editedHlc: at(NOW - 20) }),
        r,
        { clientId: C2 },
      ),
    ).toMatchObject({
      status: "conflict",
      server: { value: "new", editedHlc: at(NOW - 10) },
    });
    expect(
      one(
        s,
        mut("session", "a", "set", { value: "newer", editedHlc: at(NOW - 5) }),
        r,
        { clientId: C2 },
      ),
    ).toMatchObject({ status: "ok" });
    // Equal clocks: the larger clientId wins.
    expect(
      one(
        s,
        mut("session", "a", "set", { value: "tie1", editedHlc: at(NOW - 5) }),
        r,
        { clientId: C1 },
      ),
    ).toMatchObject({ status: "conflict" });
  });

  it("a baseVersion makes it compare-and-swap", () => {
    reset();
    const s = new MemoryStore();
    const r = route("lastWrite");
    one(
      s,
      mut("session", "a", "set", { value: 1, editedHlc: at(NOW - 10) }),
      r,
    );
    // Older clock but the right version: the swap decides.
    expect(
      one(
        s,
        mut("session", "a", "set", {
          value: 2,
          baseVersion: 1,
          editedHlc: at(NOW - 99),
        }),
        r,
      ),
    ).toMatchObject({ status: "ok", version: 2 });
  });
});

describe("max and min records, server mode", () => {
  const r = route("max", { conflictField: "best" });
  /** `scores/p` holds best 10 at NOW - 10. */
  const seedBest = (s: MemoryStore, rt: Classification) =>
    one(
      s,
      mut("scores", "p", "set", {
        value: { best: 10 },
        editedHlc: at(NOW - 10),
      }),
      rt,
    );
  it("the better field wins whatever its clock; a tie falls back to lastWrite", () => {
    reset();
    const s = new MemoryStore();
    seedBest(s, r);
    // Worse but newer: loses.
    expect(
      one(
        s,
        mut("scores", "p", "set", {
          value: { best: 5 },
          editedHlc: at(NOW - 1),
        }),
        r,
      ),
    ).toMatchObject({ status: "conflict", server: { value: { best: 10 } } });
    // Better but older: wins.
    expect(
      one(
        s,
        mut("scores", "p", "set", {
          value: { best: 20 },
          editedHlc: at(NOW - 99),
        }),
        r,
      ),
    ).toMatchObject({ status: "ok" });
    // A tie: the older clock loses, the newer wins.
    expect(
      one(
        s,
        mut("scores", "p", "set", {
          value: { best: 20, x: 1 },
          editedHlc: at(NOW - 200),
        }),
        r,
      ),
    ).toMatchObject({ status: "conflict" });
    expect(
      one(
        s,
        mut("scores", "p", "set", {
          value: { best: 20, x: 2 },
          editedHlc: at(NOW - 50),
        }),
        r,
      ),
    ).toMatchObject({ status: "ok" });
    // min keeps the smaller.
    const lo = route("min", { conflictField: "best" });
    one(s, mut("fast", "p", "set", { value: { best: 9 } }), lo);
    expect(
      one(s, mut("fast", "p", "set", { value: { best: 10 } }), lo),
    ).toMatchObject({
      status: "conflict",
    });
    expect(
      one(s, mut("fast", "p", "set", { value: { best: 8 } }), lo),
    ).toMatchObject({
      status: "ok",
    });
  });

  it("a missing or non-number conflictField is op_invalid_for_policy", () => {
    reset();
    const s = new MemoryStore();
    for (const value of [
      { other: 1 },
      { best: "7" },
      "7",
      null,
      { best: null },
    ] as SyncJson[])
      expect(one(s, mut("scores", "p", "set", { value }), r)).toMatchObject({
        status: "rejected",
        code: "op_invalid_for_policy",
      });
    expect(
      one(s, mut("scores", "p", "set", { value: { best: 1 } }), route("max")),
    ).toMatchObject({ code: "op_invalid_for_policy" });
    expect(s.recordRows()).toEqual([]);
  });

  it("delete is decided by editedHlc alone", () => {
    reset();
    const s = new MemoryStore();
    seedBest(s, r);
    expect(
      one(s, mut("scores", "p", "delete", { editedHlc: at(NOW - 20) }), r),
    ).toMatchObject({ status: "conflict" });
    expect(
      one(s, mut("scores", "p", "delete", { editedHlc: at(NOW - 5) }), r),
    ).toMatchObject({ status: "ok" });
    // A set older than the delete is ignored; a newer one re-creates the record.
    expect(
      one(
        s,
        mut("scores", "p", "set", {
          value: { best: 99 },
          editedHlc: at(NOW - 8),
        }),
        r,
      ),
    ).toMatchObject({ status: "conflict", server: { value: null } });
    expect(
      one(
        s,
        mut("scores", "p", "set", {
          value: { best: 1 },
          editedHlc: at(NOW - 1),
        }),
        r,
      ),
    ).toMatchObject({ status: "ok" });
  });
});

describe("max and min records, E2E register", () => {
  const r = route("max", { sealed: true });
  it("is decided by baseVersion alone, never by value", () => {
    reset();
    const s = new MemoryStore();
    const c1 = envelope(1);
    const c2 = envelope(2);
    // A number against a missing record conflicts; "*" creates.
    expect(
      one(s, mut("scores", BLIND(1), "set", { ct: c1, baseVersion: 3 }), r),
    ).toMatchObject({ status: "conflict" });
    expect(
      one(s, mut("scores", BLIND(1), "set", { ct: c1, baseVersion: "*" }), r),
    ).toMatchObject({ status: "ok", version: 1 });
    expect(
      one(s, mut("scores", BLIND(1), "set", { ct: c2, baseVersion: "*" }), r),
    ).toMatchObject({ status: "conflict", server: { ct: c1, version: 1 } });
    expect(
      one(s, mut("scores", BLIND(1), "set", { ct: c2, baseVersion: 1 }), r),
    ).toMatchObject({ status: "ok", version: 2 });
    expect(s.getRecord("scores", BLIND(1))?.value).toBe(c2);
    // Absent falls back to the lastWrite order.
    expect(
      one(s, mut("scores", BLIND(1), "set", { ct: c1, editedHlc: at(1) }), r),
    ).toMatchObject({ status: "conflict" });
  });

  it("a delete keeps its version, and a later set re-creates on it", () => {
    reset();
    const s = new MemoryStore();
    one(
      s,
      mut("scores", BLIND(1), "set", { ct: envelope(1), baseVersion: "*" }),
      r,
    );
    expect(one(s, mut("scores", BLIND(1), "delete"), r)).toMatchObject({
      status: "ok",
      version: 2,
    });
    expect(
      one(
        s,
        mut("scores", BLIND(1), "set", { ct: envelope(3), baseVersion: 1 }),
        r,
      ),
    ).toMatchObject({
      status: "conflict",
      server: { value: null, version: 2 },
    });
    expect(
      one(
        s,
        mut("scores", BLIND(1), "set", { ct: envelope(3), baseVersion: "*" }),
        r,
      ),
    ).toMatchObject({ status: "ok", version: 3 });
  });
});

describe("delete", () => {
  it("a record the store holds no row for answers ok and writes nothing", () => {
    reset();
    const s = new MemoryStore();
    one(s, mut("saves", "s1", "set", { value: 1 }), route("revision"));
    const before = s.snapshot();
    const res = one(s, mut("saves", "ghost", "delete"), route("revision"));
    expect(res).toMatchObject({ status: "ok", version: 1 });
    expect(s.getRecord("saves", "ghost")).toBeUndefined();
    expect(s.currentSeq()).toBe(1);
    expect(s.recordTombstoneCount()).toBe(0);
    expect(s.snapshot()).toMatchObject({
      seq: (before as { seq: number }).seq,
    });
  });

  it("deletes a live record into a tombstone and frees its slot and bytes", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision");
    one(s, mut("saves", "s1", "set", { value: { n: 1 } }), r);
    expect(s.getUsage()).toMatchObject({ records: 1 });
    expect(s.getUsage().recordBytes).toBeGreaterThan(0);
    expect(one(s, mut("saves", "s1", "delete"), r)).toMatchObject({
      status: "ok",
      version: 2,
    });
    expect(s.getRecord("saves", "s1")).toMatchObject({
      deleted: true,
      version: 2,
      value: null,
    });
    expect(s.getUsage()).toMatchObject({
      records: 0,
      recordBytes: 0,
      bytes: 0,
    });
    // A tombstone costs nothing; a repeated delete changes nothing.
    expect(recordCost(s.getRecord("saves", "s1"))).toEqual({
      records: 0,
      bytes: 0,
    });
    expect(one(s, mut("saves", "s1", "delete"), r)).toMatchObject({
      status: "ok",
      version: 2,
    });
    // The slot is free again; "*" re-creates over the tombstone.
    expect(
      one(s, mut("saves", "s1", "set", { value: 5, baseVersion: "*" }), r),
    ).toMatchObject({ status: "ok", version: 3 });
  });

  it("honours baseVersion on revision and the clock on lastWrite", () => {
    reset();
    const s = new MemoryStore();
    one(s, mut("saves", "s1", "set", { value: 1 }), route("revision"));
    expect(
      one(
        s,
        mut("saves", "s1", "delete", { baseVersion: 9 }),
        route("revision"),
      ),
    ).toMatchObject({ status: "conflict", server: { version: 1 } });
    expect(
      one(
        s,
        mut("saves", "s1", "delete", { baseVersion: 1 }),
        route("revision"),
      ),
    ).toMatchObject({ status: "ok" });
    one(
      s,
      mut("session", "a", "set", { value: 1, editedHlc: at(NOW - 10) }),
      route("lastWrite"),
    );
    expect(
      one(
        s,
        mut("session", "a", "delete", { editedHlc: at(NOW - 20) }),
        route("lastWrite"),
      ),
    ).toMatchObject({ status: "conflict" });
    expect(
      one(
        s,
        mut("session", "a", "set", { value: 2, editedHlc: at(NOW - 15) }),
        route("lastWrite"),
      ),
    ).toMatchObject({ status: "conflict" });
  });

  it("a delete is never refused for quota", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision");
    one(s, mut("saves", "s1", "set", { value: "x".repeat(50) }), r);
    const tight = { limits: { quotaBytes: 1, productOverCeiling: true } };
    expect(one(s, mut("saves", "s1", "delete"), r, tight)).toMatchObject({
      status: "ok",
    });
    expect(one(s, mut("saves", "nobody", "delete"), r, tight)).toMatchObject({
      status: "ok",
    });
  });
});

describe("check order inside the object", () => {
  it("the classifier's value_invalid beats an operation the policy does not allow", () => {
    reset();
    const s = new MemoryStore();
    expect(
      one(
        s,
        mut("saves", "s1", "setField", { field: "f", value: 1 }),
        route("revision", { valueInvalid: true }),
      ),
    ).toMatchObject({ code: "value_invalid" });
    expect(
      one(
        s,
        mut("saves", "s1", "setField", { field: "f", value: 1 }),
        route("revision"),
      ),
    ).toMatchObject({ code: "op_invalid_for_policy" });
  });

  it("an observedSeq above the store sequence is value_invalid, before check 5", () => {
    reset();
    const s = new MemoryStore();
    expect(
      one(
        s,
        mut("saves", "s1", "remove", { element: "a", observedSeq: 9 }),
        route("revision"),
      ),
    ).toMatchObject({ code: "value_invalid" });
    expect(
      one(
        s,
        mut("saves", "s1", "remove", { element: "a", observedSeq: 0 }),
        route("revision"),
      ),
    ).toMatchObject({ code: "op_invalid_for_policy" });
  });

  it("every policy refuses an operation it does not list", () => {
    reset();
    const s = new MemoryStore();
    const cases: [RecordPolicy, SyncMutation["op"]][] = [
      ["revision", "add"],
      ["lastWrite", "setField"],
      ["max", "removeField"],
      ["min", "remove"],
    ];
    for (const [policy, op] of cases)
      expect(
        one(
          s,
          mut("c", "i", op, { field: "f", element: "e", observedSeq: 0 }),
          route(policy, { conflictField: "f" }),
        ),
      ).toMatchObject({ code: "op_invalid_for_policy" });
  });

  it("a conflict answers before quota_exceeded and is never charged", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision", { maxRecords: 1 });
    one(s, mut("saves", "s1", "set", { value: 1 }), r);
    // A create past maxRecords whose "*" would also conflict would be a conflict... the id is new,
    // so use a stale swap on the existing record under a quota of 0: conflict, not quota.
    expect(
      one(s, mut("saves", "s1", "set", { value: 2, baseVersion: 99 }), r, {
        limits: { quotaBytes: 0 },
      }),
    ).toMatchObject({ status: "conflict" });
  });
});

describe("quota and maxRecords", () => {
  it("only a create can hit maxRecords: scope collection", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision", { maxRecords: 2 });
    run(
      s,
      [
        mut("saves", "a", "set", { value: 1 }),
        mut("saves", "b", "set", { value: 1 }),
      ],
      r,
    );
    expect(one(s, mut("saves", "c", "set", { value: 1 }), r)).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "collection",
    });
    expect(s.getRecord("saves", "c")).toBeUndefined();
    // An update, and a delete, never hit it; the freed slot can be used.
    expect(one(s, mut("saves", "a", "set", { value: 2 }), r)).toMatchObject({
      status: "ok",
    });
    expect(one(s, mut("saves", "a", "delete"), r)).toMatchObject({
      status: "ok",
    });
    expect(one(s, mut("saves", "c", "set", { value: 1 }), r)).toMatchObject({
      status: "ok",
    });
    // Another concrete collection under the same declaration has its own count.
    expect(
      one(s, mut("saves.other", "a", "set", { value: 1 }), r),
    ).toMatchObject({
      status: "ok",
    });
  });

  it("counts creates made earlier in the same push", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision", { maxRecords: 2 });
    const res = run(
      s,
      [1, 2, 3, 4].map((n) => mut("saves", `s${n}`, "set", { value: n })),
      r,
    );
    expect(res.map((x) => x.status)).toEqual([
      "ok",
      "ok",
      "rejected",
      "rejected",
    ]);
  });

  it("answers collection, then product, then user when a create is over several", () => {
    reset();
    const full = route("revision", { maxRecords: 1 });
    const mk = () => {
      const s = new MemoryStore();
      one(s, mut("saves", "a", "set", { value: 1 }), full);
      return s;
    };
    const all = { quotaBytes: 0, productOverCeiling: true };
    expect(
      one(mk(), mut("saves", "b", "set", { value: 1 }), full, { limits: all }),
    ).toMatchObject({ scope: "collection" });
    const roomy = route("revision", { maxRecords: 5 });
    expect(
      one(mk(), mut("saves", "b", "set", { value: 1 }), roomy, { limits: all }),
    ).toMatchObject({ scope: "product" });
    expect(
      one(mk(), mut("saves", "b", "set", { value: 1 }), roomy, {
        limits: { quotaBytes: 0 },
      }),
    ).toMatchObject({ scope: "user" });
    expect(
      one(mk(), mut("saves", "b", "set", { value: 1 }), roomy, {
        limits: { quotaBytes: 1_000_000 },
      }),
    ).toMatchObject({ status: "ok" });
  });

  it("charges the stored bytes against the quota; usage tracks the live records", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision");
    one(s, mut("saves", "a", "set", { value: "xxxx" }), r);
    // "saves" 5 + "a" 1 + "\"xxxx\"" 6.
    expect(s.getUsage()).toMatchObject({
      records: 1,
      recordBytes: 12,
      bytes: 12,
    });
    expect(
      one(s, mut("saves", "b", "set", { value: "xxxx" }), r, {
        limits: { quotaBytes: 20 },
      }),
    ).toMatchObject({ code: "quota_exceeded", scope: "user" });
    expect(
      one(s, mut("saves", "b", "set", { value: "xxxx" }), r, {
        limits: { quotaBytes: 24 },
      }),
    ).toMatchObject({ status: "ok" });
    expect(s.getUsage()).toMatchObject({
      records: 2,
      recordBytes: 24,
      bytes: 24,
    });
  });

  it("an atomic batch rolls the records back with the rest", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision", { maxRecords: 1 });
    const out = push(
      s,
      [
        mut("saves", "a", "set", { value: 1 }),
        mut("saves", "b", "set", { value: 1 }),
      ],
      r,
      { atomic: true },
    );
    expect(out.ok && out.results.map((x) => x.status)).toEqual([
      "aborted",
      "rejected",
    ]);
    expect(s.recordRows()).toEqual([]);
    expect(s.getUsage()).toMatchObject({ records: 0, recordBytes: 0 });
  });
});

describe("end-to-end records", () => {
  it("stores the ct and its key id, and the first accepted sealed write sets encryptionSince", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision", { sealed: true });
    // A rejected sealed write does not count.
    expect(
      one(
        s,
        mut("saves", BLIND(1), "set", { ct: envelope(1) }),
        route("revision", { sealed: true, valueInvalid: true }),
      ),
    ).toMatchObject({ code: "value_invalid" });
    expect(s.getEncryptionSince()).toBeUndefined();
    const res = one(
      s,
      mut("saves", BLIND(1), "set", { ct: envelope(0xab) }),
      r,
    );
    expect(res).toMatchObject({ status: "ok", version: 1 });
    expect(s.getEncryptionSince()).toBe(1);
    const row = s.getRecord("saves", BLIND(1));
    expect(row?.value).toBe(envelope(0xab));
    expect(row?.kid).toBe("ab".repeat(16));
    // A conflict copy of a sealed record carries ct, not value.
    expect(
      one(
        s,
        mut("saves", BLIND(1), "set", { ct: envelope(1), baseVersion: 9 }),
        r,
      ),
    ).toMatchObject({
      status: "conflict",
      server: { ct: envelope(0xab), version: 1 },
    });
  });

  it("a legacy plaintext record keeps its value in a conflict copy", () => {
    reset();
    const s = new MemoryStore();
    one(
      s,
      mut("saves", "legacy", "set", { value: { n: 1 } }),
      route("revision"),
    );
    one(
      s,
      mut("saves", BLIND(1), "set", { ct: envelope() }),
      route("revision", { sealed: true }),
    );
    expect(s.getEncryptionSince()).toBe(2);
    expect(
      one(
        s,
        mut("saves", "legacy", "set", { ct: envelope(), baseVersion: 9 }),
        route("revision", { sealed: true }),
      ),
    ).toMatchObject({ status: "conflict", server: { value: { n: 1 } } });
  });
});

describe("forgotten state is bounded", () => {
  const tombstoneIds = (s: MemoryStore, c: string) =>
    s
      .recordRows()
      .filter((r) => r.collection === c && r.deleted)
      .map((r) => r.id)
      .sort();

  it("keeps 2 x maxRecords tombstones per concrete collection, forgetting the oldest", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision", { maxRecords: 2 });
    for (let n = 1; n <= 6; n++) {
      one(s, mut("saves", `s${n}`, "set", { value: n }), r);
      one(
        s,
        mut("saves", `s${n}`, "delete", { editedHlc: at(NOW - 1000 + n) }),
        r,
      );
    }
    // Four are kept: the newest by clock.
    expect(tombstoneIds(s, "saves")).toEqual(["s3", "s4", "s5", "s6"]);
    // The watermark rose past what was forgotten, so an old cursor is refused, not silently wrong.
    expect(s.getWatermark()).toBeGreaterThan(0);
    // Another concrete collection is counted on its own.
    one(s, mut("saves.b", "x", "set", { value: 1 }), r);
    one(s, mut("saves.b", "x", "delete"), r);
    expect(tombstoneIds(s, "saves.b")).toEqual(["x"]);
    expect(tombstoneIds(s, "saves")).toHaveLength(4);
  });

  it("keeps 20,000 tombstones per person across collections", () => {
    reset();
    const s = new MemoryStore();
    expect(MAX_PERSON_RECORD_TOMBSTONES).toBe(20_000);
    for (let n = 0; n < MAX_PERSON_RECORD_TOMBSTONES; n++)
      s.putRecord({
        collection: `c${n % 4}`,
        id: `r${n}`,
        version: n + 1,
        stamp: { hlc: at(1_000 + n), clientId: C1 },
        deleted: true,
        kind: "value",
        value: null,
      });
    s.setSeq(MAX_PERSON_RECORD_TOMBSTONES);
    expect(s.recordTombstoneCount()).toBe(MAX_PERSON_RECORD_TOMBSTONES);
    const r = route("revision", { maxRecords: 10_000 });
    one(s, mut("c0", "fresh", "set", { value: 1 }), r);
    one(s, mut("c0", "fresh", "delete", { editedHlc: at(NOW - 1) }), r);
    // One more tombstone arrived; the oldest by clock went.
    expect(s.recordTombstoneCount()).toBe(MAX_PERSON_RECORD_TOMBSTONES);
    expect(s.getRecord("c0", "r0")).toBeUndefined();
    expect(s.getRecord("c1", "r1")).toBeDefined();
    expect(s.getRecord("c0", "fresh")?.deleted).toBe(true);
    expect(s.getWatermark()).toBe(1);
  });

  it("inventing ids stores nothing", () => {
    reset();
    const s = new MemoryStore();
    const r = route("revision");
    const res = run(
      s,
      Array.from({ length: 50 }, (_, n) =>
        mut("scratch", `ghost${n}`, "delete"),
      ),
      r,
    );
    expect(res.every((x) => x.status === "ok")).toBe(true);
    expect(s.recordRows()).toEqual([]);
    expect(s.currentSeq()).toBe(0);
  });
});
