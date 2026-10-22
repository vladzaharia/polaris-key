/**
 * U-05.5: merge members past the 256 cap, and catalog migrations (rule 6), over the in-memory store.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_MAX_MERGE_MEMBERS,
  SYNC_MAX_UNION_ELEMENT_BYTES,
  type MutationResult,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { formatHlc } from "../src/services/sync/engine/hlc.js";
import { MemoryStore } from "../src/services/sync/engine/memoryStore.js";
import { resolveKey } from "../src/services/sync/engine/migrations.js";
import { applyPush } from "../src/services/sync/engine/push.js";
import type {
  CatalogMigrations,
  Classification,
  SettingPolicy,
} from "../src/services/sync/engine/types.js";

const C1 = "c_000000000000000client1";
const NOW = 1_760_000_000_000;
const route = (
  policy: SettingPolicy,
  scope: "user" | "platform" = "user",
): Classification => ({ verdict: "accept", scope, policy });

let id = 1;
let tick = 0;
const mut = (
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> & { key?: string } = {},
): SyncMutation => {
  const { key = "k", ...rest } = extra;
  return {
    mutationId: id++,
    target: { setting: key, scope: "user" },
    op,
    editedHlc: formatHlc(NOW - 100_000 + tick++, 0),
    ...rest,
  };
};

function push(
  store: MemoryStore,
  mutations: SyncMutation[],
  policy: SettingPolicy,
  extra: { migrations?: CatalogMigrations; atomic?: boolean } = {},
) {
  const out = applyPush(store, {
    deviceId: "dev1",
    serverNow: NOW,
    classified: mutations.map(() => route(policy)),
    request: { clientId: C1, cursor: 0, mutations, atomic: extra.atomic },
    ...(extra.migrations ? { migrations: extra.migrations } : {}),
  });
  if (!out.ok) throw new Error(out.error);
  return out.results;
}

const only = (r: MutationResult[]) => r[0] as MutationResult;

describe("merge: the member name bound (SR-1 B1)", () => {
  it("refuses a name over 1 KiB of UTF-8 as value_invalid, on both ops, at quota 0, and stores nothing", () => {
    const store = new MemoryStore();
    const long = "x".repeat(SYNC_MAX_UNION_ELEMENT_BYTES + 1);
    // 342 three-byte characters are 1026 bytes: the bound counts bytes, not characters.
    const wide = "\u20ac".repeat(342);
    for (const member of [long, wide])
      for (const op of ["setMember", "removeMember"] as const) {
        const out = applyPush(store, {
          deviceId: "dev1",
          serverNow: NOW,
          limits: { quotaBytes: 0 },
          classified: [route("merge")],
          request: {
            clientId: C1,
            cursor: 0,
            mutations: [mut(op, { member, value: 1 })],
          },
        });
        if (!out.ok) throw new Error(out.error);
        expect(out.results[0]).toMatchObject({
          status: "rejected",
          code: "value_invalid",
        });
      }
    expect(store.getSetting("k", "user")).toBeUndefined();
    expect(store.rows()).toEqual([]);
    expect(store.currentSeq()).toBe(0);
    // Exactly 1 KiB is allowed.
    const ok = "y".repeat(SYNC_MAX_UNION_ELEMENT_BYTES);
    expect(
      only(
        push(store, [mut("removeMember", { member: ok })], "merge"),
      ).status,
    ).toBe("ok");
  });
});

describe("merge: the 256-member cap", () => {
  it("accepts 256 live members and refuses the 257th as value_invalid", () => {
    const store = new MemoryStore();
    const batch = Array.from({ length: SYNC_MAX_MERGE_MEMBERS }, (_, i) =>
      mut("setMember", { member: `m${i}`, value: i }),
    );
    // 100 mutations at most per push: chunk it.
    for (let i = 0; i < batch.length; i += 100)
      for (const r of push(store, batch.slice(i, i + 100), "merge"))
        expect(r.status).toBe("ok");
    const over = push(
      store,
      [mut("setMember", { member: "extra", value: 1 })],
      "merge",
    );
    expect(only(over)).toMatchObject({
      status: "rejected",
      code: "value_invalid",
    });
    // Rewriting a live member, or removing one then adding another, is fine.
    expect(
      only(push(store, [mut("setMember", { member: "m0", value: 9 })], "merge"))
        .status,
    ).toBe("ok");
    expect(
      only(push(store, [mut("removeMember", { member: "m1" })], "merge"))
        .status,
    ).toBe("ok");
    expect(
      only(
        push(store, [mut("setMember", { member: "extra", value: 1 })], "merge"),
      ).status,
    ).toBe("ok");
  });

  it("does not count removed members, and bounds the removed ones it remembers", () => {
    const store = new MemoryStore();
    for (let round = 0; round < 6; round++) {
      const adds = Array.from({ length: 100 }, (_, i) =>
        mut("setMember", { member: `r${round}-${i}`, value: 1 }),
      );
      push(store, adds, "merge");
      push(
        store,
        adds.map((a) => mut("removeMember", { member: a.member })),
        "merge",
      );
    }
    const row = store.getSetting("k", "user");
    expect(row?.members?.size).toBeLessThanOrEqual(2 * SYNC_MAX_MERGE_MEMBERS);
    // 600 members came and went; a new one still fits.
    expect(
      only(push(store, [mut("setMember", { member: "x", value: 1 })], "merge"))
        .status,
    ).toBe("ok");
  });

  it("an atomic batch rolls the cap refusal back whole", () => {
    const store = new MemoryStore();
    const fill = Array.from({ length: 100 }, (_, i) =>
      mut("setMember", { member: `m${i}`, value: 1 }),
    );
    push(store, fill, "merge");
    const more = Array.from({ length: 100 }, (_, i) =>
      mut("setMember", { member: `n${i}`, value: 1 }),
    );
    push(store, more, "merge");
    const rest = Array.from({ length: 56 }, (_, i) =>
      mut("setMember", { member: `o${i}`, value: 1 }),
    );
    push(store, rest, "merge");
    const before = store.snapshot();
    const results = push(
      store,
      [
        mut("setMember", { member: "fits?", value: 1 }),
        mut("setMember", { member: "no", value: 1 }),
      ],
      "merge",
      { atomic: true },
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "aborted"]);
    expect((store.snapshot() as { settings: unknown }).settings).toEqual(
      (before as { settings: unknown }).settings,
    );
  });
});

describe("rule 6: catalog migrations", () => {
  const migrations: CatalogMigrations = {
    renamedTo: new Map([
      ["old.q", "new.q"],
      ["older.q", "old.q"],
      ["__proto__", "safe"],
    ]),
    dropped: new Set(["gone", "old.gone"]),
  };

  it("resolves renames through chains, drops first, and ignores cycles", () => {
    expect(resolveKey("old.q", migrations)).toEqual({
      kind: "renamed",
      to: "new.q",
    });
    expect(resolveKey("older.q", migrations)).toEqual({
      kind: "renamed",
      to: "new.q",
    });
    expect(resolveKey("gone", migrations)).toEqual({ kind: "dropped" });
    expect(resolveKey("plain", migrations)).toEqual({ kind: "same" });
    expect(resolveKey("__proto__", migrations)).toEqual({
      kind: "renamed",
      to: "safe",
    });
    expect(resolveKey("x", undefined)).toEqual({ kind: "same" });
    const cycle: CatalogMigrations = {
      renamedTo: new Map([
        ["a", "b"],
        ["b", "a"],
      ]),
      dropped: new Set(),
    };
    expect(resolveKey("a", cycle)).toEqual({ kind: "same" });
    const intoDropped: CatalogMigrations = {
      renamedTo: new Map([["a", "b"]]),
      dropped: new Set(["b"]),
    };
    expect(resolveKey("a", intoDropped)).toEqual({ kind: "dropped" });
  });

  it("writes a renamed key under its new name and answers renamedTo", () => {
    const store = new MemoryStore();
    const r = only(
      push(store, [mut("set", { key: "older.q", value: "low" })], "lastWrite", {
        migrations,
      }),
    );
    expect(r).toMatchObject({ status: "ok", renamedTo: "new.q" });
    expect(store.getSetting("new.q", "user")?.value).toBe("low");
    expect(store.getSetting("older.q", "user")).toBeUndefined();
    expect(store.getSetting("old.q", "user")).toBeUndefined();
  });

  it("a renamed write competes with the new key's own stamps", () => {
    const store = new MemoryStore();
    const first = mut("set", { key: "new.q", value: "new" });
    const later = mut("set", { key: "old.q", value: "old" });
    later.editedHlc = formatHlc(NOW - 50_000, 0);
    first.editedHlc = formatHlc(NOW - 10_000, 0);
    push(store, [first], "lastWrite", { migrations });
    const r = only(push(store, [later], "lastWrite", { migrations }));
    expect(r.status).toBe("conflict");
    expect(store.getSetting("new.q", "user")?.value).toBe("new");
  });

  it("a dropped key answers dropped and writes nothing, whatever its classification", () => {
    const store = new MemoryStore();
    const m = mut("set", { key: "gone", value: true });
    const out = applyPush(store, {
      deviceId: "dev1",
      serverNow: NOW,
      classified: [{ verdict: "reject", code: "setting_not_synced" }],
      request: { clientId: C1, cursor: 0, mutations: [m] },
      migrations,
    });
    expect(out.ok && out.results[0]).toEqual({
      mutationId: m.mutationId,
      status: "ok",
      dropped: true,
    });
    expect(store.currentSeq()).toBe(0);
    expect(store.rows()).toEqual([]);
    // It counts as processed (rule 1).
    expect(out.ok && out.lastMutationId).toBe(m.mutationId);
  });

  it("a renamed key follows the new key's policy refusals", () => {
    const store = new MemoryStore();
    const r = only(
      push(
        store,
        [mut("setMember", { key: "old.q", member: "a", value: 1 })],
        "lastWrite",
        {
          migrations,
        },
      ),
    );
    expect(r).toMatchObject({
      status: "rejected",
      code: "op_invalid_for_policy",
    });
  });
});
