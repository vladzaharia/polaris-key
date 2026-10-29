/**
 * U-05.5: the pull (§13.4) and the tombstone horizon (U-01b R4 rules 4 to 7), over the in-memory
 * store: pages, the L9 row selection, `empty`, the ETag, `cursor_expired`, tombstone collection.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_PULL_PAGE_CHANGES,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import {
  applyPull,
  collectTombstones,
  pullEtag,
} from "../../../src/services/sync/engine/pull.js";
import { applyPush } from "../../../src/services/sync/engine/push.js";
import type {
  Classification,
  SettingPolicy,
} from "../../../src/services/sync/engine/types.js";

const C1 = "c_000000000000000client1";
const C2 = "c_000000000000000client2";
const NOW = 1_760_000_000_000;

let id = 1;
let tick = 0;
const mut = (
  op: SyncMutation["op"],
  key: string,
  extra: Partial<SyncMutation> & { scope?: "user" | "platform" } = {},
): SyncMutation => {
  const { scope = "user", ...rest } = extra;
  return {
    mutationId: id++,
    target: { setting: key, scope },
    op,
    editedHlc: formatHlc(NOW - 1_000_000 + tick++, 0),
    ...rest,
  };
};

function push(
  store: MemoryStore,
  mutations: SyncMutation[],
  opts: {
    clientId?: string;
    deviceId?: string;
    family?: string;
    policy?: SettingPolicy;
  } = {},
) {
  const classified: Classification[] = mutations.map((m) => ({
    verdict: "accept",
    scope: (m.target as { scope: "user" | "platform" }).scope,
    policy: opts.policy ?? "lastWrite",
  }));
  const out = applyPush(store, {
    deviceId: opts.deviceId ?? "dev1",
    family: opts.family ?? "desktop",
    serverNow: NOW,
    classified,
    request: { clientId: opts.clientId ?? C1, cursor: 0, mutations },
  });
  if (!out.ok) throw new Error(out.error);
  return out;
}

const pull = (
  store: MemoryStore,
  over: Partial<Parameters<typeof applyPull>[1]> = {},
) => {
  const out = applyPull(store, {
    deviceId: "dev1",
    family: "desktop",
    ...over,
  });
  if (!out.ok) throw new Error(out.error);
  return out;
};

describe("an empty principal", () => {
  it("answers empty:true on a cursor-0 pull, and not otherwise", () => {
    const store = new MemoryStore();
    const first = pull(store);
    expect(first).toMatchObject({
      empty: true,
      more: false,
      cursor: 0,
      changes: [],
      tombstones: [],
    });
    expect(pull(store, { cursor: 0 }).empty).toBe(true);
    push(store, [mut("set", "k", { value: 1 })]);
    expect(pull(store).empty).toBeUndefined();
  });

  it("a principal holding only a tombstone is not empty", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: 1 }), mut("clear", "k")]);
    expect(store.rows()[0]?.deleted).toBe(true);
    expect(pull(store).empty).toBeUndefined();
  });
});

/** Rows written straight into the store, as an import or a long history would leave them. */
function seed(store: MemoryStore, n: number, family?: string): void {
  for (let i = 1; i <= n; i++) {
    const seq = store.nextSeq();
    store.putSetting({
      key: `s${seq}`,
      scope: family ? "platform" : "user",
      ...(family ? { family } : {}),
      version: seq,
      stamp: { hlc: formatHlc(NOW - 10_000_000, i), clientId: C2 },
      deleted: false,
      value: seq,
    });
  }
}

describe("pages", () => {
  it("serves 500 changes a page with more, and the cursor walks to the end", () => {
    expect(SYNC_PULL_PAGE_CHANGES).toBe(500);
    const store = new MemoryStore();
    seed(store, 1200);
    const seen: number[] = [];
    let cursor = 0;
    const sizes: number[] = [];
    const mores: boolean[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const page = pull(store, { cursor });
      sizes.push(page.changes.length + page.tombstones.length);
      mores.push(page.more);
      for (const c of page.changes) seen.push(c.version);
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(sizes).toEqual([500, 500, 200]);
    expect(mores).toEqual([true, true, false]);
    expect(seen).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
    expect(cursor).toBe(1200);
  });

  it("a page holds changes and tombstones together, in cursor order", () => {
    const store = new MemoryStore();
    push(store, [
      mut("set", "a", { value: 1 }),
      mut("set", "b", { value: 2 }),
      mut("set", "c", { value: 3 }),
      mut("clear", "a"),
    ]);
    // Versions: b=2, c=3, then a=4 (the tombstone).
    const page = pull(store, { pageSize: 2 });
    expect(page.more).toBe(true);
    expect(page.changes.map((c) => c.version)).toEqual([2, 3]);
    expect(page.tombstones).toEqual([]);
    expect(page.cursor).toBe(3);
    const next = pull(store, { cursor: page.cursor, pageSize: 2 });
    expect(next.more).toBe(false);
    expect(
      next.tombstones.map((t) => (t as { setting: string }).setting),
    ).toEqual(["a"]);
    expect(next.cursor).toBe(4);
  });

  it("a cursor at the head answers nothing new, with the head as its cursor", () => {
    const store = new MemoryStore();
    seed(store, 3);
    const out = pull(store, { cursor: 3 });
    expect(out).toMatchObject({ changes: [], more: false, cursor: 3 });
    expect(out.empty).toBeUndefined();
  });
});

describe("which rows (L9)", () => {
  it("returns user rows and this device's family rows, and keeps the others", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "u", { value: "user" })]);
    push(store, [mut("set", "p", { value: "desk", scope: "platform" })], {
      family: "desktop",
    });
    push(store, [mut("set", "p", { value: "phone", scope: "platform" })], {
      family: "mobile",
    });
    expect(store.rows()).toHaveLength(3);
    const desktop = pull(store, { family: "desktop" });
    expect(
      desktop.changes.map((c) => [
        (c as { scope: string }).scope,
        (c as { value: unknown }).value,
      ]),
    ).toEqual([
      ["user", "user"],
      ["platform", "desk"],
    ]);
    const mobile = pull(store, { family: "mobile" });
    expect(mobile.changes.map((c) => (c as { value: unknown }).value)).toEqual([
      "user",
      "phone",
    ]);
    const web = pull(store, { family: "web" });
    expect(web.changes.map((c) => (c as { value: unknown }).value)).toEqual([
      "user",
    ]);
    // Dormant, not deleted: the web device's pull changed nothing.
    expect(store.rows()).toHaveLength(3);
  });

  it("one key under the two scopes is two rows, and a policy change rewrites nothing", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: 1 })], { policy: "lastWrite" });
    const before = store.snapshot();
    // The catalog now routes the key as a max: nothing is touched until someone writes it.
    pull(store);
    expect(store.snapshot()).toEqual(before);
  });

  it("a merged setting is one change whose value is its live members", () => {
    const store = new MemoryStore();
    push(
      store,
      [
        mut("setMember", "m", { member: "a", value: 1 }),
        mut("setMember", "m", { member: "b", value: 2 }),
        mut("removeMember", "m", { member: "a" }),
      ],
      { policy: "merge" },
    );
    const out = pull(store);
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]).toMatchObject({
      setting: "m",
      scope: "user",
      value: { b: 2 },
      updatedBy: C1,
    });
    expect(out.changes[0]).not.toHaveProperty("members");
  });

  it("a cleared key is a tombstone with its editedHlc", () => {
    const store = new MemoryStore();
    const set = mut("set", "k", { value: 1 });
    const clear = mut("clear", "k");
    push(store, [set, clear]);
    const out = pull(store);
    expect(out.changes).toEqual([]);
    expect(out.tombstones).toEqual([
      { setting: "k", editedHlc: clear.editedHlc },
    ]);
  });
});

describe("lastMutationId, usage and the ETag", () => {
  it("reports the asking device's client, and 0 for a client bound to another device", () => {
    const store = new MemoryStore();
    const out = push(store, [mut("set", "k", { value: 1 })]);
    const mine = pull(store, { clientId: C1 });
    expect(mine.lastMutationId).toBe(out.lastMutationId);
    expect(pull(store, { clientId: C1, deviceId: "dev2" }).lastMutationId).toBe(
      0,
    );
    expect(pull(store, { clientId: C2 }).lastMutationId).toBe(0);
    expect(pull(store).lastMutationId).toBe(0);
  });

  it('is the strong ETag "<seq>.<lastMutationId>", and moves with either', () => {
    const store = new MemoryStore();
    const a = push(store, [mut("set", "k", { value: 1 })]);
    const first = pull(store, { clientId: C1 });
    expect(first.etag).toBe(pullEtag(1, a.lastMutationId));
    expect(first.etag).toBe(`"1.${a.lastMutationId}"`);
    // A refused write consumes an id without moving the sequence: the ETag still changes.
    push(store, [mut("clear", "absent")]);
    expect(pull(store, { clientId: C1 }).etag).not.toBe(first.etag);
  });

  it("carries the person's totals", () => {
    const store = new MemoryStore();
    push(store, [mut("set", "k", { value: "v" })]);
    expect(pull(store).usage).toEqual({
      bytes: 4,
      settings: 1,
      records: 0,
      files: 0,
    });
  });
});

describe("the tombstone horizon", () => {
  it("collects tombstones through a sequence and answers older cursors cursor_expired", () => {
    const store = new MemoryStore();
    push(store, [
      mut("set", "a", { value: 1 }),
      mut("set", "b", { value: 1 }),
      mut("clear", "a"),
      mut("set", "c", { value: 1 }),
    ]);
    // a=3 (tombstone), b=2, c=4
    expect(collectTombstones(store, 3)).toBe(1);
    expect(store.getSetting("a", "user")).toBeUndefined();
    expect(store.getSetting("b", "user")).toBeDefined();
    expect(store.getWatermark()).toBe(3);
    expect(
      applyPull(store, { deviceId: "dev1", family: "desktop", cursor: 2 }),
    ).toEqual({
      ok: false,
      error: "cursor_expired",
    });
    // At the watermark the client has seen every collected tombstone.
    expect(
      applyPull(store, { deviceId: "dev1", family: "desktop", cursor: 3 }).ok,
    ).toBe(true);
    // A snapshot is always served.
    expect(
      pull(store, { cursor: 0 }).changes.map(
        (c) => (c as { setting: string }).setting,
      ),
    ).toEqual(["b", "c"]);
  });

  it("never lowers the watermark, and keeps live rows", () => {
    const store = new MemoryStore();
    seed(store, 5);
    collectTombstones(store, 4);
    collectTombstones(store, 2);
    expect(store.getWatermark()).toBe(4);
    expect(store.rows()).toHaveLength(5);
  });

  it("forgets removed-member cells of old merged rows but keeps their floor", () => {
    const store = new MemoryStore();
    push(
      store,
      [
        mut("setMember", "m", { member: "a", value: 1 }),
        mut("setMember", "m", { member: "b", value: 1 }),
        mut("removeMember", "m", { member: "a" }),
      ],
      { policy: "merge" },
    );
    collectTombstones(store, store.currentSeq());
    const row = store.getSetting("m", "user");
    expect([...(row?.members?.keys() ?? [])]).toEqual(["b"]);
  });

  it("a cursor from the future (another store) is cursor_expired", () => {
    const store = new MemoryStore();
    seed(store, 2);
    expect(
      applyPull(store, { deviceId: "dev1", family: "desktop", cursor: 9 }),
    ).toEqual({
      ok: false,
      error: "cursor_expired",
    });
  });
});
