/**
 * U-05.4: the Cloud Sync engine's push rules for settings (plans/U-05-slices.md §3;
 * WIRE-CONTRACT-V4 §13.3, §13.6), over the in-memory store. The engine is pure, so these run
 * without a Durable Object, a route or a database.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_IMPORT_HLC,
  SYNC_MAX_CLOCK_SKEW_MS,
  SYNC_MAX_MUTATIONS,
  type MutationResult,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import {
  clampHlc,
  compareStamps,
  formatHlc,
  parseHlc,
} from "../../../src/services/sync/engine/hlc.js";
import {
  applyPush,
  CLIENT_BINDING_IDLE_SECONDS,
  MAX_CLIENT_BINDINGS,
} from "../../../src/services/sync/engine/push.js";
import { POLICY_OPS } from "../../../src/services/sync/engine/settings.js";
import type {
  Classification,
  SettingPolicy,
} from "../../../src/services/sync/engine/types.js";
import { validatePush } from "../../../src/services/sync/engine/validate.js";

const C1 = "c_000000000000000client1";
const C2 = "c_000000000000000client2";
const NOW = 1_760_000_000_000;
const at = (ms: number, counter = 0) => formatHlc(ms, counter);

const route = (
  policy: SettingPolicy,
  scope: "user" | "platform" = "user",
  extra: { valueInvalid?: boolean; open?: boolean } = {},
): Classification => ({ verdict: "accept", scope, policy, ...extra });

let nextId = 1;
const reset = () => {
  nextId = 1;
};
const mut = (
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> & {
    key?: string;
    scope?: "user" | "platform";
  } = {},
): SyncMutation => {
  const { key = "k", scope = "user", ...rest } = extra;
  return {
    mutationId: nextId++,
    target: { setting: key, scope },
    op,
    editedHlc: at(NOW - 1000),
    ...rest,
  };
};

function push(
  store: MemoryStore,
  mutations: SyncMutation[],
  classified: Classification[] | Classification,
  opts: {
    clientId?: string;
    deviceId?: string;
    atomic?: boolean;
    serverNow?: number;
  } = {},
) {
  return applyPush(store, {
    deviceId: opts.deviceId ?? "dev1",
    serverNow: opts.serverNow ?? NOW,
    classified: Array.isArray(classified)
      ? classified
      : mutations.map(() => classified),
    request: {
      clientId: opts.clientId ?? C1,
      cursor: 0,
      ...(opts.atomic !== undefined ? { atomic: opts.atomic } : {}),
      mutations,
    },
  });
}

function results(
  store: MemoryStore,
  mutations: SyncMutation[],
  classified: Classification | Classification[],
  opts?: Parameters<typeof push>[3],
): MutationResult[] {
  const out = push(store, mutations, classified, opts);
  if (!out.ok) throw new Error(`push failed: ${JSON.stringify(out)}`);
  return out.results;
}

describe("HLC", () => {
  it("parses, formats and orders", () => {
    expect(parseHlc("0199c82cc000:0001")).toEqual({
      ms: 0x0199c82cc000,
      counter: 1,
    });
    expect(parseHlc("nope")).toBeNull();
    expect(formatHlc(NOW, 3)).toBe(at(NOW, 3));
    expect(
      compareStamps({ hlc: at(1), clientId: C1 }, { hlc: at(2), clientId: C1 }),
    ).toBeLessThan(0);
    expect(
      compareStamps(
        { hlc: at(1, 2), clientId: C1 },
        { hlc: at(1, 1), clientId: C2 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareStamps({ hlc: at(1), clientId: C1 }, { hlc: at(1), clientId: C2 }),
    ).toBeLessThan(0);
  });

  it("clamps only what is later than serverNow plus the skew", () => {
    expect(clampHlc(at(NOW + SYNC_MAX_CLOCK_SKEW_MS), NOW)).toBe(
      at(NOW + SYNC_MAX_CLOCK_SKEW_MS),
    );
    expect(clampHlc(at(NOW + SYNC_MAX_CLOCK_SKEW_MS + 1, 7), NOW)).toBe(
      at(NOW, 0),
    );
    expect(clampHlc(SYNC_IMPORT_HLC, NOW)).toBe(SYNC_IMPORT_HLC);
    expect(clampHlc(at(1), NOW)).toBe(at(1));
  });

  it("a far-future write cannot pin a key: it is stored at serverNow", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [
        mut("set", {
          value: 1,
          editedHlc: at(NOW + 10 * SYNC_MAX_CLOCK_SKEW_MS),
        }),
      ],
      route("lastWrite"),
    );
    expect(s.rows()[0]?.stamp.hlc).toBe(at(NOW, 0));
    // An honest write a minute later beats it.
    const r = results(
      s,
      [mut("set", { value: 2, editedHlc: at(NOW + 60_000) })],
      route("lastWrite"),
      { serverNow: NOW + 60_000 },
    );
    expect(r[0]).toMatchObject({ status: "ok" });
  });

  it("accepts the import floor and loses to any cloud value", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: "cloud", editedHlc: at(5) })],
      route("lastWrite"),
    );
    const r = results(
      s,
      [mut("set", { value: "local", editedHlc: SYNC_IMPORT_HLC })],
      route("lastWrite"),
    );
    expect(r[0]).toMatchObject({
      status: "conflict",
      server: { value: "cloud" },
    });
    // And on an empty store the floor stamp is accepted.
    const s2 = new MemoryStore();
    reset();
    expect(
      results(
        s2,
        [mut("set", { value: "x", editedHlc: SYNC_IMPORT_HLC })],
        route("lastWrite"),
      )[0]?.status,
    ).toBe("ok");
  });
});

describe("shape (request-level bad_request)", () => {
  const base = { clientId: C1, cursor: 0, mutations: [] as unknown[] };
  const bad = (b: unknown) => {
    const v = validatePush(b);
    return v.ok ? "ok" : v.reason;
  };
  it("rejects malformed bodies with a reason", () => {
    reset();
    expect(bad({ ...base })).toBe("ok");
    expect(bad({ ...base, clientId: "c_short" })).toBe("client_id");
    expect(bad({ ...base, clientId: "x_000000000000000client1" })).toBe(
      "client_id",
    );
    expect(bad({ ...base, cursor: -1 })).toBe("cursor");
    expect(bad({ ...base, atomic: "yes" })).toBe("atomic");
    expect(bad({ ...base, mutations: "no" })).toBe("mutations");
    expect(
      bad({
        ...base,
        mutations: Array.from({ length: SYNC_MAX_MUTATIONS + 1 }, () =>
          mut("clear"),
        ),
      }),
    ).toBe("too_many_mutations");
    expect(
      bad({ ...base, mutations: [mut("clear", { key: "bad key!" })] }),
    ).toBe("setting_key");
    expect(
      bad({ ...base, mutations: [mut("clear", { scope: "device" as never })] }),
    ).toBe("scope");
    expect(
      bad({ ...base, mutations: [{ ...mut("clear"), mutationId: 0 }] }),
    ).toBe("mutation_id");
    expect(
      bad({ ...base, mutations: [{ ...mut("clear"), mutationId: 1.5 }] }),
    ).toBe("mutation_id");
    expect(
      bad({ ...base, mutations: [{ ...mut("clear"), mutationId: 2 ** 53 }] }),
    ).toBe("mutation_id");
    expect(
      bad({ ...base, mutations: [{ ...mut("clear"), op: "explode" }] }),
    ).toBe("op");
    expect(
      bad({
        ...base,
        mutations: [mut("clear", { editedHlc: "0199C82CC000:0001" })],
      }),
    ).toBe("edited_hlc");
    expect(
      bad({
        ...base,
        mutations: [mut("set", { editedHlc: undefined, value: 1 })],
      }),
    ).toBe("edited_hlc_required");
    expect(bad({ ...base, mutations: [mut("set")] })).toBe("value_required");
    expect(bad({ ...base, mutations: [mut("setMember", { value: 1 })] })).toBe(
      "member_required",
    );
    reset();
    const a = mut("clear");
    const b = mut("clear");
    expect(bad({ ...base, mutations: [b, a] })).toBe("mutation_id_order");
    expect(
      bad({ ...base, mutations: [a, { ...b, mutationId: a.mutationId }] }),
    ).toBe("mutation_id_order");
  });

  it("a bad request writes nothing and binds nothing", () => {
    const s = new MemoryStore();
    const out = applyPush(s, {
      deviceId: "dev1",
      serverNow: NOW,
      classified: [],
      request: { clientId: "nope", cursor: 0, mutations: [] },
    });
    expect(out).toEqual({
      ok: false,
      error: "bad_request",
      reason: "client_id",
    });
    expect(s.getClient("nope")).toBeUndefined();
    expect(s.snapshot()).toEqual(new MemoryStore().snapshot());
  });
});

describe("classification and the operation-versus-policy table", () => {
  it("the table is exactly §13.3's setting rows", () => {
    expect([...POLICY_OPS.lastWrite]).toEqual(["set", "clear"]);
    expect([...POLICY_OPS.max]).toEqual(["set", "clear"]);
    expect([...POLICY_OPS.min]).toEqual(["set", "clear"]);
    expect([...POLICY_OPS.merge]).toEqual([
      "setMember",
      "removeMember",
      "clear",
    ]);
  });

  const ops: SyncMutation["op"][] = [
    "set",
    "clear",
    "setMember",
    "removeMember",
    "setField",
    "removeField",
    "delete",
    "add",
    "remove",
  ];
  for (const policy of ["lastWrite", "max", "min", "merge"] as const) {
    it(`${policy}: every operation outside its row is op_invalid_for_policy`, () => {
      for (const op of ops) {
        reset();
        const s = new MemoryStore();
        const m = mut(op, {
          value: 1,
          member: "m",
          field: "f",
          element: 1,
          observedSeq: 1,
        });
        const r = results(s, [m], route(policy))[0];
        if (POLICY_OPS[policy].has(op)) expect(r?.status).toBe("ok");
        else
          expect(r).toEqual({
            mutationId: m.mutationId,
            status: "rejected",
            code: "op_invalid_for_policy",
          });
      }
    });
  }

  it("a rejection writes nothing and consumes no sequence", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("setMember", { member: "m", value: 1 })],
      route("lastWrite"),
    );
    expect(s.currentSeq()).toBe(0);
    expect(s.rows()).toEqual([]);
  });

  it("the Worker's rejections pass through", () => {
    reset();
    const s = new MemoryStore();
    const ms = [
      mut("set", { value: 1 }),
      mut("set", { value: 1 }),
      mut("set", { value: 1 }),
    ];
    const r = results(s, ms, [
      { verdict: "reject", code: "setting_not_synced" },
      { verdict: "reject", code: "collection_unknown" },
      route("lastWrite", "user", { valueInvalid: true }),
    ]);
    expect(r.map((x) => (x.status === "rejected" ? x.code : x.status))).toEqual(
      ["setting_not_synced", "collection_unknown", "value_invalid"],
    );
    expect(s.rows()).toEqual([]);
  });

  it("a target scope other than the route's is setting_not_synced", () => {
    reset();
    const r = results(
      new MemoryStore(),
      [mut("set", { value: 1, scope: "platform" })],
      route("lastWrite", "user"),
    );
    expect(r[0]).toMatchObject({
      status: "rejected",
      code: "setting_not_synced",
    });
    reset();
    const r2 = results(
      new MemoryStore(),
      [mut("set", { value: 1, scope: "user" })],
      route("lastWrite", "platform"),
    );
    expect(r2[0]).toMatchObject({
      status: "rejected",
      code: "setting_not_synced",
    });
  });

  it("a record target never reaches the settings rules", () => {
    reset();
    const s = new MemoryStore();
    const m: SyncMutation = {
      mutationId: 1,
      target: { record: ["progress", "r1"] },
      op: "set",
      value: 1,
    };
    expect(results(s, [m], route("lastWrite"))[0]).toMatchObject({
      status: "rejected",
      code: "collection_unknown",
    });
  });

  it("platform and user scopes of one key are separate rows", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: "u", scope: "user" })],
      route("lastWrite", "user"),
    );
    results(
      s,
      [mut("set", { value: "p", scope: "platform" })],
      route("lastWrite", "platform"),
    );
    expect(
      s
        .rows()
        .map((r) => [r.scope, r.value])
        .sort(),
    ).toEqual([
      ["platform", "p"],
      ["user", "u"],
    ]);
  });
});

describe("lastWrite", () => {
  it("the higher stamp wins and a loser gets the server copy", () => {
    reset();
    const s = new MemoryStore();
    const [a] = results(
      s,
      [mut("set", { value: 0.5, editedHlc: at(NOW - 100) })],
      route("lastWrite"),
    );
    expect(a).toMatchObject({ status: "ok", version: 1 });
    const [b] = results(
      s,
      [mut("set", { value: 0.9, editedHlc: at(NOW - 200) })],
      route("lastWrite"),
    );
    expect(b).toMatchObject({
      status: "conflict",
      server: { value: 0.5, version: 1, editedHlc: at(NOW - 100) },
    });
    const [c] = results(
      s,
      [mut("set", { value: 0.7, editedHlc: at(NOW - 50) })],
      route("lastWrite"),
    );
    expect(c).toMatchObject({ status: "ok", version: 2 });
  });

  it("a counter breaks a same-millisecond tie, then the clientId", () => {
    // `stored` is written by C2 at (NOW-5, 1); `incoming` arrives from C1 or C3 afterwards.
    const C3 = "c_000000000000000client3";
    const run = (counter: number, clientId: string) => {
      reset();
      const s = new MemoryStore();
      results(
        s,
        [mut("set", { value: "a", editedHlc: at(NOW - 5, 1) })],
        route("lastWrite"),
        { clientId: C2, deviceId: "d2" },
      );
      reset();
      return results(
        s,
        [mut("set", { value: "b", editedHlc: at(NOW - 5, counter) })],
        route("lastWrite"),
        { clientId, deviceId: "d9" },
      )[0]?.status;
    };
    expect(run(0, C3)).toBe("conflict"); // lower counter loses even from the higher clientId
    expect(run(2, C1)).toBe("ok"); // higher counter wins even from the lower clientId
    expect(run(1, C1)).toBe("conflict"); // same stamp: the lower clientId loses
    expect(run(1, C3)).toBe("ok"); // same stamp: the higher clientId wins
  });

  it("the same client's later mutation at the same stamp is kept", () => {
    reset();
    const s = new MemoryStore();
    const [a, b] = results(
      s,
      [mut("set", { value: 1 }), mut("set", { value: 2 })],
      route("lastWrite"),
    );
    expect([a?.status, b?.status]).toEqual(["ok", "ok"]);
    expect(s.rows()[0]?.value).toBe(2);
  });

  it("clear writes a tombstone; a later edit wins over it, an older one loses", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: 1, editedHlc: at(NOW - 300) })],
      route("lastWrite"),
    );
    expect(
      results(
        s,
        [mut("clear", { editedHlc: at(NOW - 200) })],
        route("lastWrite"),
      )[0],
    ).toMatchObject({ status: "ok", version: 2 });
    expect(s.rows()[0]).toMatchObject({ deleted: true, value: null });
    // Older than the clear: ignored, the server copy is the cleared key.
    expect(
      results(
        s,
        [mut("set", { value: 2, editedHlc: at(NOW - 250) })],
        route("lastWrite"),
      )[0],
    ).toMatchObject({
      status: "conflict",
      server: { value: null, version: 2, editedHlc: at(NOW - 200) },
    });
    // Later than the clear: the key is back.
    expect(
      results(
        s,
        [mut("set", { value: 3, editedHlc: at(NOW - 100) })],
        route("lastWrite"),
      )[0]?.status,
    ).toBe("ok");
    expect(s.rows()[0]).toMatchObject({ deleted: false, value: 3 });
  });

  it("a clear older than the stored value loses; a clear of nothing still leaves a tombstone", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: 1, editedHlc: at(NOW - 100) })],
      route("lastWrite"),
    );
    expect(
      results(
        s,
        [mut("clear", { editedHlc: at(NOW - 200) })],
        route("lastWrite"),
      )[0]?.status,
    ).toBe("conflict");
    const s2 = new MemoryStore();
    reset();
    results(
      s2,
      [mut("clear", { key: "never", editedHlc: at(NOW - 100) })],
      route("lastWrite"),
    );
    expect(s2.rows()[0]).toMatchObject({ key: "never", deleted: true });
    expect(
      results(
        s2,
        [mut("set", { key: "never", value: 1, editedHlc: at(NOW - 150) })],
        route("lastWrite"),
      )[0]?.status,
    ).toBe("conflict");
  });

  it("any value is storable, null and objects included", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [
        mut("set", { value: null }),
        mut("set", { key: "o", value: { a: [1, { b: 2 }] } }),
      ],
      route("lastWrite"),
    );
    expect(s.getSetting("k", "user")).toMatchObject({
      deleted: false,
      value: null,
    });
    expect(s.getSetting("o", "user")?.value).toEqual({ a: [1, { b: 2 }] });
  });
});

describe("max and min", () => {
  it("max keeps the larger whatever the clock; a tie falls back to lastWrite", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: 120, editedHlc: at(NOW - 100) })],
      route("max"),
    );
    // Smaller but newer: the stored value beats it.
    expect(
      results(
        s,
        [mut("set", { value: 100, editedHlc: at(NOW - 10) })],
        route("max"),
      )[0],
    ).toMatchObject({ status: "conflict", server: { value: 120 } });
    // Larger but older: it wins.
    expect(
      results(
        s,
        [mut("set", { value: 150, editedHlc: at(NOW - 500) })],
        route("max"),
      )[0],
    ).toMatchObject({ status: "ok" });
    expect(s.rows()[0]?.value).toBe(150);
    // A tie: the newer stamp is kept, the older is a conflict.
    expect(
      results(
        s,
        [mut("set", { value: 150, editedHlc: at(NOW - 600) })],
        route("max"),
      )[0]?.status,
    ).toBe("conflict");
    expect(
      results(
        s,
        [mut("set", { value: 150, editedHlc: at(NOW - 50) })],
        route("max"),
      )[0]?.status,
    ).toBe("ok");
  });

  it("min keeps the smaller", () => {
    reset();
    const s = new MemoryStore();
    results(s, [mut("set", { value: 50 })], route("min"));
    expect(
      results(
        s,
        [mut("set", { value: 60, editedHlc: at(NOW - 1) })],
        route("min"),
      )[0]?.status,
    ).toBe("conflict");
    expect(
      results(
        s,
        [mut("set", { value: 40, editedHlc: at(NOW - 2000) })],
        route("min"),
      )[0]?.status,
    ).toBe("ok");
    expect(s.rows()[0]?.value).toBe(40);
  });

  it("a non-number is value_invalid", () => {
    reset();
    const s = new MemoryStore();
    for (const value of ["9", null, true, { a: 1 }, [1]]) {
      const r = results(s, [mut("set", { value })], route("max"))[0];
      expect(r).toMatchObject({ status: "rejected", code: "value_invalid" });
    }
    expect(s.rows()).toEqual([]);
  });

  it("clear is a reset at its clock: older sets are ignored, newer ones start afresh", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: 999, editedHlc: at(NOW - 400) })],
      route("max"),
    );
    expect(
      results(s, [mut("clear", { editedHlc: at(NOW - 300) })], route("max"))[0]
        ?.status,
    ).toBe("ok");
    expect(
      results(
        s,
        [mut("set", { value: 1000, editedHlc: at(NOW - 350) })],
        route("max"),
      )[0]?.status,
    ).toBe("conflict");
    // A newer set below the old maximum is accepted: the reset forgot it.
    expect(
      results(
        s,
        [mut("set", { value: 5, editedHlc: at(NOW - 200) })],
        route("max"),
      )[0],
    ).toMatchObject({ status: "ok" });
    expect(s.rows()[0]).toMatchObject({ deleted: false, value: 5 });
  });
});

describe("merge", () => {
  const members = (s: MemoryStore, key = "k") => {
    const row = s.getSetting(key, "user");
    return [...(row?.members ?? [])]
      .filter(([, c]) => !c.removed)
      .map(([n, c]) => [n, c.value])
      .sort();
  };

  it("each member is its own lastWrite", () => {
    reset();
    const s = new MemoryStore();
    const r = results(
      s,
      [
        mut("setMember", {
          member: "jump",
          value: "space",
          editedHlc: at(NOW - 100),
        }),
        mut("setMember", {
          member: "crouch",
          value: "ctrl",
          editedHlc: at(NOW - 100),
        }),
      ],
      route("merge"),
    );
    expect(r.map((x) => x.status)).toEqual(["ok", "ok"]);
    // An older write to one member loses; the other member is unaffected.
    expect(
      results(
        s,
        [
          mut("setMember", {
            member: "jump",
            value: "j",
            editedHlc: at(NOW - 200),
          }),
        ],
        route("merge"),
      )[0],
    ).toMatchObject({
      status: "conflict",
      server: {
        value: { jump: "space", crouch: "ctrl" },
        version: 2,
        editedHlc: at(NOW - 100),
      },
    });
    expect(
      results(
        s,
        [
          mut("setMember", {
            member: "jump",
            value: "j",
            editedHlc: at(NOW - 50),
          }),
        ],
        route("merge"),
      )[0]?.status,
    ).toBe("ok");
    expect(members(s)).toEqual([
      ["crouch", "ctrl"],
      ["jump", "j"],
    ]);
  });

  it("removeMember leaves a member tombstone that an older set cannot undo", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [
        mut("setMember", {
          member: "dash",
          value: "shift",
          editedHlc: at(NOW - 300),
        }),
      ],
      route("merge"),
    );
    expect(
      results(
        s,
        [mut("removeMember", { member: "dash", editedHlc: at(NOW - 200) })],
        route("merge"),
      )[0]?.status,
    ).toBe("ok");
    expect(members(s)).toEqual([]);
    expect(s.getSetting("k", "user")?.deleted).toBe(true);
    expect(
      results(
        s,
        [
          mut("setMember", {
            member: "dash",
            value: "x",
            editedHlc: at(NOW - 250),
          }),
        ],
        route("merge"),
      )[0]?.status,
    ).toBe("conflict");
    expect(
      results(
        s,
        [
          mut("setMember", {
            member: "dash",
            value: "y",
            editedHlc: at(NOW - 100),
          }),
        ],
        route("merge"),
      )[0]?.status,
    ).toBe("ok");
    expect(members(s)).toEqual([["dash", "y"]]);
    expect(s.getSetting("k", "user")?.deleted).toBe(false);
  });

  it("clear drops members at or below its clock and sets a floor", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [
        mut("setMember", { member: "old", value: 1, editedHlc: at(NOW - 400) }),
        mut("setMember", { member: "new", value: 2, editedHlc: at(NOW - 100) }),
      ],
      route("merge"),
    );
    expect(
      results(
        s,
        [mut("clear", { editedHlc: at(NOW - 200) })],
        route("merge"),
      )[0]?.status,
    ).toBe("ok");
    expect(members(s)).toEqual([["new", 2]]);
    // A member write below the floor is ignored; an older clear is a conflict.
    expect(
      results(
        s,
        [
          mut("setMember", {
            member: "late",
            value: 3,
            editedHlc: at(NOW - 300),
          }),
        ],
        route("merge"),
      )[0]?.status,
    ).toBe("conflict");
    expect(
      results(
        s,
        [mut("clear", { editedHlc: at(NOW - 250) })],
        route("merge"),
      )[0]?.status,
    ).toBe("conflict");
  });

  it("a member called __proto__ is data, not a prototype", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("setMember", { member: "__proto__", value: 1 })],
      route("merge"),
    );
    const [r] = results(
      s,
      [mut("setMember", { member: "x", value: 1, editedHlc: at(1) })],
      route("merge"),
    );
    expect(r?.status).toBe("ok");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const row = s.getSetting("k", "user");
    expect(row?.members?.has("__proto__")).toBe(true);
  });

  it("converts lossless to and from a scalar when the policy changes", () => {
    reset();
    const s = new MemoryStore();
    results(
      s,
      [mut("set", { value: { a: 1, b: 2 }, editedHlc: at(NOW - 300) })],
      route("lastWrite"),
    );
    // Now a merge key: the stored object's entries become members at its stamp.
    expect(
      results(
        s,
        [mut("setMember", { member: "b", value: 9, editedHlc: at(NOW - 100) })],
        route("merge"),
      )[0]?.status,
    ).toBe("ok");
    expect(members(s)).toEqual([
      ["a", 1],
      ["b", 9],
    ]);
    // Back to lastWrite: the live members are the value.
    expect(
      results(
        s,
        [mut("set", { value: { z: 1 }, editedHlc: at(NOW - 50) })],
        route("lastWrite"),
      )[0]?.status,
    ).toBe("ok");
    expect(s.getSetting("k", "user")).toMatchObject({
      value: { z: 1 },
      deleted: false,
    });
    expect(s.getSetting("k", "user")?.members).toBeUndefined();
  });
});

describe("results, rule 1 and rule 4", () => {
  it("every processed mutation advances the last id, whatever its result", () => {
    reset();
    const s = new MemoryStore();
    const ms = [
      mut("set", { value: 1, editedHlc: at(NOW - 100) }),
      mut("set", { value: 2, editedHlc: at(NOW - 200) }), // conflict
      mut("setMember", { member: "m", value: 1 }), // op_invalid_for_policy
      mut("set", { key: "other", value: 1 }),
    ];
    const out = push(s, ms, route("lastWrite"));
    expect(out).toMatchObject({
      ok: true,
      lastMutationId: 4,
      seq: 2,
      counts: { accepted: 2, conflicts: 1 },
    });
    expect(s.getClient(C1)).toEqual({
      clientId: C1,
      deviceId: "dev1",
      lastMutationId: 4,
    });
  });

  it("an id at or below the last processed is a duplicate and writes nothing", () => {
    reset();
    const s = new MemoryStore();
    const ms = [mut("set", { value: 1 }), mut("set", { key: "b", value: 2 })];
    push(s, ms, route("lastWrite"));
    const before = s.snapshot();
    const again = push(s, ms, route("lastWrite"));
    expect(again).toMatchObject({
      ok: true,
      lastMutationId: 2,
      counts: { accepted: 0, conflicts: 0 },
    });
    expect((again as { results: MutationResult[] }).results).toEqual([
      { mutationId: 1, status: "duplicate" },
      { mutationId: 2, status: "duplicate" },
    ]);
    expect(s.snapshot()).toEqual(before);
  });

  it("applying a batch twice equals applying it once (every policy, with a conflict in it)", () => {
    reset();
    const ms = [
      mut("set", { key: "a", value: 1, editedHlc: at(NOW - 100) }),
      mut("set", { key: "a", value: 0, editedHlc: at(NOW - 300) }),
      mut("set", { key: "n", value: 5 }),
      mut("setMember", { key: "m", member: "x", value: 1 }),
      mut("clear", { key: "c" }),
    ];
    const cls = [
      route("lastWrite"),
      route("lastWrite"),
      route("max"),
      route("merge"),
      route("lastWrite"),
    ];
    const once = new MemoryStore();
    push(once, ms, cls);
    const twice = new MemoryStore();
    push(twice, ms, cls);
    push(twice, ms, cls);
    expect(twice.snapshot()).toEqual(once.snapshot());
  });

  it("a partly-new batch applies only the new part", () => {
    reset();
    const s = new MemoryStore();
    const first = [mut("set", { value: 1 })];
    push(s, first, route("lastWrite"));
    const second = [...first, mut("set", { key: "b", value: 2 })];
    const out = push(s, second, route("lastWrite"));
    expect(
      (out as { results: MutationResult[] }).results.map((r) => r.status),
    ).toEqual(["duplicate", "ok"]);
  });

  it("a gap in ids is fine; ids never go back across requests", () => {
    reset();
    const s = new MemoryStore();
    push(
      s,
      [{ ...mut("set", { value: 1 }), mutationId: 10 }],
      route("lastWrite"),
    );
    const out = push(
      s,
      [{ ...mut("set", { value: 2 }), mutationId: 7 }],
      route("lastWrite"),
    );
    expect((out as { results: MutationResult[] }).results[0]).toEqual({
      mutationId: 7,
      status: "duplicate",
    });
  });

  it("a clientId binds to its first device; another device is client_mismatch and nothing is written", () => {
    reset();
    const s = new MemoryStore();
    push(s, [mut("set", { value: 1 })], route("lastWrite"), {
      deviceId: "dev1",
    });
    const before = s.snapshot();
    const out = push(
      s,
      [mut("set", { key: "z", value: 9 })],
      route("lastWrite"),
      { deviceId: "dev2" },
    );
    expect(out).toEqual({ ok: false, error: "client_mismatch" });
    expect(s.snapshot()).toEqual(before);
    // The same device with another clientId is a different journal.
    expect(
      push(s, [mut("set", { key: "z", value: 9 })], route("lastWrite"), {
        deviceId: "dev2",
        clientId: C2,
      }).ok,
    ).toBe(true);
  });

  it("an empty push from an unknown client binds nothing", () => {
    const s = new MemoryStore();
    push(s, [], [], { deviceId: "dev1" });
    expect(s.getClient(C1)).toBeUndefined();
    expect(s.clientCount()).toBe(0);
  });

  it("a known client's binding survives an empty push", () => {
    const s = new MemoryStore();
    push(s, [mut("set", { key: "a.b", value: 1 })], route("lastWrite"), {
      deviceId: "dev1",
    });
    expect(push(s, [], [], { deviceId: "dev2" })).toEqual({
      ok: false,
      error: "client_mismatch",
    });
    expect(s.getClient(C1)).toMatchObject({ deviceId: "dev1" });
  });

  it("keeps at most MAX_CLIENT_BINDINGS bindings: a new client past the cap needs an idle one to replace", () => {
    let now = NOW;
    const s = new MemoryStore(() => now / 1000);
    const id = (i: number) => `c_${String(i).padStart(22, "A")}`;
    const first = (i: number) =>
      push(s, [mut("set", { key: "a.b", value: i })], route("lastWrite"), {
        clientId: id(i),
        serverNow: now,
      });
    for (let i = 0; i < MAX_CLIENT_BINDINGS; i++) {
      expect(first(i).ok).toBe(true);
      now += 1000;
    }
    expect(s.clientCount()).toBe(MAX_CLIENT_BINDINGS);
    // All of them are recent: a new client is refused.
    expect(first(900)).toEqual({
      ok: false,
      error: "bad_request",
      reason: "too_many_clients",
    });
    expect(s.clientCount()).toBe(MAX_CLIENT_BINDINGS);
    // A day later the longest idle one is replaced.
    now += CLIENT_BINDING_IDLE_SECONDS * 1000;
    expect(first(900).ok).toBe(true);
    expect(s.clientCount()).toBe(MAX_CLIENT_BINDINGS);
    expect(s.getClient(id(0))).toBeUndefined();
  });

  it("clearing an open key the store never held writes no row, and a declared one still keeps its tombstone", () => {
    const s = new MemoryStore();
    const out = results(
      s,
      [mut("clear", { key: "open.x" })],
      route("lastWrite", "user", { open: true }),
    );
    expect(out[0]?.status).toBe("ok");
    expect(s.rows()).toEqual([]);
    results(s, [mut("clear", { key: "declared.x" })], route("lastWrite"));
    expect(s.rows()).toHaveLength(1);
  });

  it("an object that only ever held tombstones is still a new person at the users ceiling", () => {
    const s = new MemoryStore();
    const limits = { quotaBytes: 1 << 20, usersAtCeiling: true };
    const run = (m: SyncMutation, c: Classification) =>
      applyPush(s, {
        deviceId: "dev1",
        serverNow: NOW,
        limits,
        classified: [c],
        request: { clientId: C1, cursor: 0, mutations: [m] },
      });
    // A declared-key clear leaves a tombstone, but no live row ever existed.
    run(mut("clear", { key: "declared.x" }), route("lastWrite"));
    expect(s.isEmpty()).toBe(false);
    const grow = run(mut("set", { key: "a.b", value: 1 }), route("lastWrite"));
    expect(grow.ok && grow.results[0]).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "product",
    });
  });

  it("two people's stores are separate engines: a version is the store's own sequence", () => {
    reset();
    const a = new MemoryStore();
    const b = new MemoryStore();
    results(
      a,
      [mut("set", { value: 1 }), mut("set", { key: "b", value: 1 })],
      route("lastWrite"),
    );
    reset();
    expect(
      results(b, [mut("set", { value: 1 })], route("lastWrite"))[0],
    ).toMatchObject({ version: 1 });
  });
});

describe("atomic batches", () => {
  const batch = () => {
    reset();
    return [
      mut("set", { key: "a", value: 1 }),
      mut("set", { key: "b", value: 2, editedHlc: at(NOW - 5000) }), // loses to the seeded value
      mut("set", { key: "c", value: 3 }),
    ];
  };
  const seed = () => {
    const s = new MemoryStore();
    reset();
    results(
      s,
      [mut("set", { key: "b", value: "server", editedHlc: at(NOW - 10) })],
      route("lastWrite"),
      { clientId: C2, deviceId: "d2" },
    );
    return s;
  };

  it("a failure rolls everything back: the failing result is kept, every other is aborted", () => {
    const s = seed();
    const before = s.rows();
    const ms = batch();
    const out = push(s, ms, route("lastWrite"), { atomic: true });
    expect(out).toMatchObject({
      ok: true,
      lastMutationId: 3,
      counts: { accepted: 0, conflicts: 1 },
    });
    expect((out as { results: MutationResult[] }).results).toEqual([
      { mutationId: 1, status: "aborted" },
      {
        mutationId: 2,
        status: "conflict",
        server: { value: "server", version: 1, editedHlc: at(NOW - 10) },
      },
      { mutationId: 3, status: "aborted" },
    ]);
    expect(s.rows()).toEqual(before);
    expect(s.currentSeq()).toBe(1);
    // The ids are processed, so a resend is a duplicate.
    expect(
      (
        push(s, ms, route("lastWrite"), { atomic: true }) as {
          results: MutationResult[];
        }
      ).results.map((r) => r.status),
    ).toEqual(["duplicate", "duplicate", "duplicate"]);
  });

  it("a rejection fails an atomic batch too", () => {
    reset();
    const s = new MemoryStore();
    const ms = [
      mut("set", { key: "a", value: 1 }),
      mut("setMember", { key: "a", member: "x", value: 1 }),
    ];
    const out = push(s, ms, route("lastWrite"), { atomic: true });
    expect((out as { results: MutationResult[] }).results).toEqual([
      { mutationId: 1, status: "aborted" },
      { mutationId: 2, status: "rejected", code: "op_invalid_for_policy" },
    ]);
    expect(s.rows()).toEqual([]);
  });

  it("an atomic batch that succeeds applies in full", () => {
    reset();
    const s = new MemoryStore();
    const out = push(
      s,
      [mut("set", { key: "a", value: 1 }), mut("set", { key: "b", value: 2 })],
      route("lastWrite"),
      { atomic: true },
    );
    expect(
      (out as { results: MutationResult[] }).results.map((r) => r.status),
    ).toEqual(["ok", "ok"]);
    expect(s.rows()).toHaveLength(2);
  });

  it("the same batch non-atomic applies the rest", () => {
    const s = seed();
    const out = push(s, batch(), route("lastWrite"));
    expect(
      (out as { results: MutationResult[] }).results.map((r) => r.status),
    ).toEqual(["ok", "conflict", "ok"]);
  });

  it("atomic duplicates stay duplicates", () => {
    reset();
    const s = new MemoryStore();
    const first = [mut("set", { key: "a", value: 1 })];
    push(s, first, route("lastWrite"));
    const ms = [
      ...first,
      mut("setMember", { key: "a", member: "x", value: 1 }),
    ];
    const out = push(s, ms, route("lastWrite"), { atomic: true });
    expect(
      (out as { results: MutationResult[] }).results.map((r) => r.status),
    ).toEqual(["duplicate", "rejected"]);
  });
});
