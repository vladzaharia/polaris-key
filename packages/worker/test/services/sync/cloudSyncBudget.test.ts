/**
 * U-05.5: byte accounting, the settings budget, the quota and the ceiling (§13.1), over the
 * in-memory store. L8: nothing here ever deletes.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_MAX_SETTINGS,
  SYNC_MAX_SETTINGS_BYTES,
  type MutationResult,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { applyPush } from "../../../src/services/sync/engine/push.js";
import type {
  Classification,
  PushLimits,
  SettingPolicy,
} from "../../../src/services/sync/engine/types.js";
import {
  canonicalJson,
  rowCost,
  valueBytes,
} from "../../../src/services/sync/engine/usage.js";

const C1 = "c_000000000000000client1";
const NOW = 1_760_000_000_000;
const accept = (policy: SettingPolicy = "lastWrite"): Classification => ({
  verdict: "accept",
  scope: "user",
  policy,
});

let id = 1;
let tick = 0;
const mut = (
  op: SyncMutation["op"],
  key: string,
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: id++,
  target: { setting: key, scope: "user" },
  op,
  editedHlc: formatHlc(NOW - 1_000_000 + tick++, 0),
  ...extra,
});

function push(
  store: MemoryStore,
  mutations: SyncMutation[],
  opts: { limits?: PushLimits; policy?: SettingPolicy } = {},
): MutationResult[] {
  const out = applyPush(store, {
    deviceId: "dev1",
    serverNow: NOW,
    classified: mutations.map(() => accept(opts.policy)),
    request: { clientId: C1, cursor: 0, mutations },
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  if (!out.ok) throw new Error(out.error);
  return out.results;
}
const one = (r: MutationResult[]) => r[0] as MutationResult;
const BIG = { quotaBytes: 1 << 30 };

describe("byte accounting", () => {
  it("canonical JSON sorts members and has no whitespace", () => {
    expect(canonicalJson({ b: [1, { z: 1, a: "é" }], a: null })).toBe(
      '{"a":null,"b":[1,{"a":"é","z":1}]}',
    );
    expect(valueBytes("é")).toBe(4);
  });

  it("a setting costs its key plus its value; a tombstone nothing", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "ab", { value: { y: 1, x: "é" } })], {
      limits: BIG,
    });
    // "ab" 2 + {"x":"é","y":1} = 16 bytes
    expect(store.getUsage()).toEqual({
      settings: 1,
      settingsBytes: 2 + 16,
      records: 0,
      recordBytes: 0,
      bytes: 2 + 16,
    });
    expect(rowCost(store.getSetting("ab", "user"))).toEqual({
      settings: 1,
      bytes: 18,
      budget: 18,
    });
    push(store, [mut("clear", "ab")], { limits: BIG });
    expect(store.getUsage()).toEqual({
      settings: 0,
      settingsBytes: 0,
      records: 0,
      recordBytes: 0,
      bytes: 0,
    });
  });

  it("a rewrite moves usage by the difference, and a merged row counts its live members", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: "aaaa" })]);
    push(store, [mut("set", "k", { value: "aa" })]);
    expect(store.getUsage().bytes).toBe(1 + 4);
    push(store, [mut("setMember", "m", { member: "a", value: 1 })], {
      policy: "merge",
    });
    push(store, [mut("setMember", "m", { member: "b", value: 22 })], {
      policy: "merge",
    });
    expect(store.getUsage().bytes).toBe(5 + 1 + `{"a":1,"b":22}`.length);
    push(store, [mut("removeMember", "m", { member: "b" })], {
      policy: "merge",
    });
    expect(store.getUsage().bytes).toBe(5 + 1 + `{"a":1}`.length);
    expect(store.getUsage().settings).toBe(2);
  });

  it("a rolled-back atomic batch leaves usage alone", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: 1 })]);
    const before = store.getUsage();
    const out = applyPush(store, {
      deviceId: "dev1",
      serverNow: NOW,
      classified: [accept(), { verdict: "reject", code: "setting_not_synced" }],
      request: {
        clientId: C1,
        cursor: 0,
        atomic: true,
        mutations: [
          mut("set", "k2", { value: 1 }),
          mut("set", "k3", { value: 1 }),
        ],
      },
    });
    expect(out.ok && out.results.map((r) => r.status)).toEqual([
      "aborted",
      "rejected",
    ]);
    expect(store.getUsage()).toEqual(before);
  });
});

describe("the settings budget (256 keys, 64 KiB)", () => {
  it("refuses the 257th key as quota_exceeded, scope user", () => {
    const store = new MemoryStore();
    for (let i = 0; i < SYNC_MAX_SETTINGS; i += 100) {
      const n = Math.min(100, SYNC_MAX_SETTINGS - i);
      const rs = push(
        store,
        Array.from({ length: n }, (_, j) =>
          mut("set", `k${i + j}`, { value: 1 }),
        ),
      );
      for (const r of rs) expect(r.status).toBe("ok");
    }
    expect(
      one(push(store, [mut("set", "overflow", { value: 1 })])),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
    // An existing key still rewrites, and a clear frees a slot.
    expect(one(push(store, [mut("set", "k0", { value: 2 })])).status).toBe(
      "ok",
    );
    expect(one(push(store, [mut("clear", "k1")])).status).toBe("ok");
    expect(
      one(push(store, [mut("set", "overflow", { value: 1 })])).status,
    ).toBe("ok");
  });

  it("refuses growth past 64 KiB but lets a smaller rewrite through", () => {
    const store = new MemoryStore();
    const chunk = "x".repeat(8000);
    for (let i = 0; i < 8; i++)
      expect(
        one(push(store, [mut("set", `big${i}`, { value: chunk })])).status,
      ).toBe("ok");
    expect(store.getUsage().settingsBytes).toBeLessThanOrEqual(
      SYNC_MAX_SETTINGS_BYTES,
    );
    expect(
      one(push(store, [mut("set", "big8", { value: chunk })])),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
    expect(
      one(push(store, [mut("set", "big0", { value: "small" })])).status,
    ).toBe("ok");
  });

  it("a member's size goes against the budget", () => {
    const store = new MemoryStore();
    const chunk = "y".repeat(8000);
    for (let i = 0; i < 8; i++)
      push(store, [mut("setMember", "m", { member: `a${i}`, value: chunk })], {
        policy: "merge",
      });
    expect(
      one(
        push(store, [mut("setMember", "m", { member: "z", value: chunk })], {
          policy: "merge",
        }),
      ),
    ).toMatchObject({ status: "rejected", code: "quota_exceeded" });
  });

  it("a store already over the budget keeps everything and refuses only growth", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: "ab" })]);
    store.setUsage({
      settings: 400,
      settingsBytes: 200_000,
      records: 0,
      recordBytes: 0,
      bytes: 200_000,
    });
    expect(one(push(store, [mut("set", "k", { value: "cd" })])).status).toBe(
      "ok",
    );
    expect(one(push(store, [mut("set", "k", { value: "cdef" })])).status).toBe(
      "rejected",
    );
    expect(store.getSetting("k", "user")?.value).toBe("cd");
  });
});

describe("quota (the requesting device's) and the product ceiling", () => {
  it("quota never deletes: over it, the device reads, clears and removes but cannot write", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: "v" })], { limits: BIG });
    push(store, [mut("setMember", "m", { member: "a", value: 1 })], {
      limits: BIG,
      policy: "merge",
    });
    store.setUsage({
      settings: 2,
      settingsBytes: 30,
      records: 0,
      recordBytes: 0,
      bytes: 2_000_000,
    });
    const tight = { quotaBytes: 1_000_000 };
    const before = store.rows();
    expect(
      one(push(store, [mut("set", "k", { value: "w" })], { limits: tight })),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
    expect(store.rows()).toEqual(before);
    expect(
      one(
        push(store, [mut("removeMember", "m", { member: "a" })], {
          limits: tight,
          policy: "merge",
        }),
      ).status,
    ).toBe("ok");
    expect(
      one(push(store, [mut("clear", "k")], { limits: tight })).status,
    ).toBe("ok");
  });

  it("quota 0 is reads only", () => {
    const store = new MemoryStore();
    expect(
      one(
        push(store, [mut("set", "k", { value: 1 })], {
          limits: { quotaBytes: 0 },
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
  });

  it("a write that fits exactly passes; one byte over does not", () => {
    const store = new MemoryStore();
    // "k" + "ab" (with quotes) = 1 + 4 = 5 bytes
    expect(
      one(
        push(store, [mut("set", "k", { value: "ab" })], {
          limits: { quotaBytes: 5 },
        }),
      ).status,
    ).toBe("ok");
    expect(
      one(
        push(store, [mut("set", "j", { value: "ab" })], {
          limits: { quotaBytes: 5 },
        }),
      ).status,
    ).toBe("rejected");
  });

  it("the product ceiling refuses growth with scope product, not a shrink or an equal rewrite", () => {
    const store = new MemoryStore();
    const over = { quotaBytes: 1 << 30, productOverCeiling: true };
    push(store, [mut("set", "k", { value: "ab" })], { limits: BIG });
    expect(
      one(push(store, [mut("set", "j", { value: 1 })], { limits: over })),
    ).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "product",
    });
    expect(
      one(push(store, [mut("set", "k", { value: "cd" })], { limits: over }))
        .status,
    ).toBe("ok");
    expect(one(push(store, [mut("clear", "k")], { limits: over })).status).toBe(
      "ok",
    );
  });

  it("a refusal consumes its id (rule 1) and writes no sequence", () => {
    const store = new MemoryStore();
    const m = mut("set", "k", { value: 1 });
    const out = applyPush(store, {
      deviceId: "dev1",
      serverNow: NOW,
      classified: [accept()],
      limits: { quotaBytes: 0 },
      request: { clientId: C1, cursor: 0, mutations: [m] },
    });
    expect(out.ok && out.lastMutationId).toBe(m.mutationId);
    expect(store.currentSeq()).toBe(0);
  });

  it("an atomic batch with a quota refusal writes nothing", () => {
    const store = new MemoryStore();
    const out = applyPush(store, {
      deviceId: "dev1",
      serverNow: NOW,
      classified: [accept(), accept()],
      limits: { quotaBytes: 3 },
      request: {
        clientId: C1,
        cursor: 0,
        atomic: true,
        mutations: [
          mut("set", "a", { value: 1 }),
          mut("set", "b", { value: 1 }),
        ],
      },
    });
    expect(out.ok && out.results.map((r) => r.status)).toEqual([
      "aborted",
      "rejected",
    ]);
    expect(store.rows()).toEqual([]);
    expect(store.getUsage().bytes).toBe(0);
  });
});
