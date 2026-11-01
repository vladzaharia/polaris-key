// @pkey-feature sync.records
// The records handle over the machine (plans/C-26 D-2): catalog checks before anything is
// journalled, one stamp per update, unknown fields untouched, change and outcome events.

import { describe, expect, it } from "vitest";
import {
  CloudSyncMachine,
  type CloudSyncOptions,
  type Json,
  type SyncEvent,
} from "../src/cloud-sync.js";
import { SyncCollection } from "../src/sync/collection.js";

const T0 = 1_760_000_000_000;
const ALICE = "sub_alice";
const cid = (n: number): string => `c_${`client${n}`.padStart(22, "0")}`;

function machine(): CloudSyncMachine {
  const ids = [cid(1), cid(2)];
  const opts: CloudSyncOptions = {
    product: "demo",
    catalog: {
      settings: [],
      collections: [
        { name: "prefs", policy: "merge" },
        { name: "tags", policy: "union" },
        { name: "best", policy: "max", field: "score" },
        { name: "saves", policy: "revision" },
      ],
    },
    document: { values: {}, locked: [] },
    now: T0,
    offsetMs: 0,
    contacted: true,
    subject: ALICE,
    network: "online",
    newClientId: () => ids.shift()!,
    encryption: "server",
  };
  const m = new CloudSyncMachine(opts);
  m.takeRequests();
  m.receive({
    status: 200,
    body: {
      subject: ALICE,
      serverNow: T0,
      cursor: 1,
      more: false,
      lastMutationId: 0,
      catalogVersion: 1,
      aliases: {},
      quota: { bytes: 268_435_456, files: true },
      usage: { bytes: 0, settings: 0, records: 0, files: 0 },
      changes: [
        { record: ["prefs", "main"], version: 1, value: { a: 1, extra: "x" } },
      ],
      tombstones: [],
    } as Json,
  });
  m.takeEvents();
  return m;
}

/** The mutations of the first push the machine has queued. */
function pushed(m: CloudSyncMachine): Array<Record<string, Json>> {
  const r = m.takeRequests().find((x) => "body" in x);
  return r && "body" in r
    ? (r.body as { mutations: Array<Record<string, Json>> }).mutations
    : [];
}

function handle(m: CloudSyncMachine, name: string) {
  const listeners = new Set<(e: SyncEvent[]) => void>();
  const c = new SyncCollection(name, {
    machine: m,
    onEvents: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  const pump = (): void => {
    const e = m.takeEvents();
    for (const fn of listeners) fn(e);
  };
  return { c, pump };
}

describe("SyncCollection", () => {
  it("refuses an undeclared name and a verb the policy does not allow, journalling nothing", () => {
    const m = machine();
    expect(handle(m, "nope").c.put("1", 1)).toEqual({
      ok: false,
      error: "collection_unknown",
    });
    const prefs = handle(m, "prefs").c;
    expect(prefs.add("main", 1)).toEqual({
      ok: false,
      error: "op_invalid_for_policy",
    });
    expect(prefs.put("main", { a: 1 }, { ifVersion: 1 })).toEqual({
      ok: false,
      error: "op_invalid_for_policy",
    });
    expect(handle(m, "tags").c.update("t", { set: { a: 1 } })).toEqual({
      ok: false,
      error: "op_invalid_for_policy",
    });
    expect(m.takeRequests()).toEqual([]);
  });

  it("update sends only the named fields under one stamp and keeps unknown ones", () => {
    const m = machine();
    const { c } = handle(m, "prefs");
    expect(c.update("main", { set: { b: 2 }, remove: ["a"] })).toEqual({
      ok: true,
    });
    const sent = pushed(m);
    expect(sent.map((x) => [x.op, x.field])).toEqual([
      ["setField", "b"],
      ["removeField", "a"],
    ]);
    expect(sent[0]!.editedHlc).toBe(sent[1]!.editedHlc);
    expect(c.get("main")).toEqual({
      value: { extra: "x", b: 2 },
      from: "pending",
    });
    expect(c.ids()).toEqual(["main"]);
  });

  it("refuses an empty, duplicated or oversize update and an oversize element", () => {
    const m = machine();
    const prefs = handle(m, "prefs").c;
    const changes: Array<{ set?: Record<string, Json>; remove?: string[] }> = [
      {},
      { set: { a: 1 }, remove: ["a"] },
      { set: { ["x".repeat(1025)]: 1 } },
      { set: { "": 1 } },
    ];
    for (const change of changes)
      expect(prefs.update("main", change)).toEqual({
        ok: false,
        error: "value_invalid",
      });
    expect(handle(m, "tags").c.add("t", "y".repeat(1100))).toEqual({
      ok: false,
      error: "value_invalid",
    });
    expect(m.takeRequests()).toEqual([]);
  });

  it("add, remove and delete on a union record", () => {
    const m = machine();
    const { c } = handle(m, "tags");
    expect(c.add("t", "a")).toEqual({ ok: true });
    expect(c.add("t", { k: 1 })).toEqual({ ok: true });
    expect(c.get("t")?.value).toEqual(["a", { k: 1 }]);
    expect(c.remove("t", "a")).toEqual({ ok: true });
    expect(c.get("t")?.value).toEqual([{ k: 1 }]);
    expect(c.delete("t")).toEqual({ ok: true });
    expect(c.get("t")).toBeNull();
    expect(c.ids()).toEqual([]);
  });

  it("signed out is typed, and sends nothing", () => {
    const m = machine();
    m.signOut({ discardUnsynced: true });
    m.takeEvents();
    expect(handle(m, "best").c.put("a", { score: 1 })).toEqual({
      ok: false,
      error: "signed_out",
    });
  });

  it("reports local and remote changes to this collection only", () => {
    const m = machine();
    const { c, pump } = handle(m, "prefs");
    const seen: unknown[] = [];
    const off = c.on((e) => seen.push(e));
    c.update("main", { set: { b: 2 } });
    pump();
    expect(seen).toEqual([{ type: "change", ids: ["main"], origin: "local" }]);
    handle(m, "tags").c.add("t", 1);
    pump();
    expect(seen).toHaveLength(1);
    off();
    c.update("main", { set: { b: 3 } });
    pump();
    expect(seen).toHaveLength(1);
  });

  it("a compare-and-set put reports its outcome to the listener", () => {
    const m = machine();
    const { c } = handle(m, "saves");
    const seen: unknown[] = [];
    c.on((e) => seen.push(e));
    const r = c.put("s1", { n: 1 }, { ifVersion: "*" });
    expect(r.ok && r.mutationId).toBe(1);
    const sent = pushed(m)[0] as { mutationId: number };
    m.receive({
      status: 200,
      body: {
        subject: ALICE,
        serverNow: T0,
        cursor: 2,
        more: false,
        lastMutationId: sent.mutationId,
        catalogVersion: 1,
        aliases: {},
        quota: { bytes: 268_435_456, files: true },
        usage: { bytes: 0, settings: 0, records: 1, files: 0 },
        changes: [],
        tombstones: [],
        results: [{ mutationId: sent.mutationId, status: "ok", version: 2 }],
      } as Json,
    });
    expect(seen).toContainEqual({
      type: "outcome",
      outcome: { mutationId: 1, status: "ok", version: 2 },
    });
  });
});
