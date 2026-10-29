/**
 * U-09.4/.6: record pushes through the Worker (WIRE-CONTRACT-V5 §13.3): the real `dispatch`
 * pipeline, the classifier against a catalog that declares collections, and the real `CloudSyncDO`
 * over the SQLite mock. Server mode; the E2E record wire is the engine suite's.
 */
import { describe, expect, it } from "vitest";
import type {
  MutationResult,
  PushResponse,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import {
  count,
  hlc,
  nextId,
  pull,
  push,
  world,
  type World,
} from "./cloudSyncAbuseWorld.js";

const catalog = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "saves", template: "saves" },
      { name: "session", template: "session" },
      { name: "vip", requires: "game.vip" },
      { name: "scratch.*", conflict: "lastWrite", maxRecords: 1 },
    ],
  },
};

const rec = (
  collection: string,
  id: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: nextId(),
  target: { record: [collection, id] },
  op,
  editedHlc: hlc,
  ...extra,
});

const tag = (r: MutationResult | undefined): string =>
  !r
    ? "none"
    : r.status === "rejected"
      ? `rejected:${r.code}${"scope" in r ? `:${r.scope}` : ""}`
      : r.status;

const pushed = async (w: World, ms: SyncMutation[]) => {
  const res = await push(w, ms);
  expect(res.status).toBe(200);
  return (await res.json()) as PushResponse;
};

describe("record pushes", () => {
  it("answers each record mutation by the first failing check, in the order of 13.3", async () => {
    const w = await world({ catalog });
    const b = await pushed(w, [
      rec("saves", "slot1", "set", { value: { playtime: 5 } }),
      rec("saves", "slot1", "set", { value: { playtime: 6 }, baseVersion: 99 }),
      rec("nope", "a", "set", { value: 1 }),
      rec("vip", "a", "set", { value: 1 }),
      rec("vip", "a", "delete"),
      rec("saves", "slot2", "set", { value: { playtime: -1 } }),
      rec("session", "a", "setField", { field: "f", value: 1 }),
      rec("scratch.a", "1", "set", { value: 1 }),
      rec("scratch.a", "2", "set", { value: 1 }),
      rec("scratch.b", "1", "set", { value: 1 }),
      rec("saves", "slot1", "delete", { baseVersion: 1 }),
      rec("saves", "slot1", "set", { value: 1, ct: "AQ" }),
    ]);
    expect(b.results.map(tag)).toEqual([
      "ok",
      "conflict",
      "rejected:collection_unknown",
      "rejected:entitlement_required",
      "ok",
      "rejected:value_invalid",
      "rejected:op_invalid_for_policy",
      "ok",
      "rejected:quota_exceeded:collection",
      "ok",
      "ok",
      "rejected:encryption_mismatch",
    ]);
    // slot1 was deleted again at the end; scratch.a/1 and scratch.b/1 are live.
    expect(count(w, "records")).toBe(3);
    expect(b.usage.records).toBe(2);
  });

  it("a delete of an absent record under a lapsed requires is ok and stores nothing", async () => {
    const w = await world({ catalog });
    const b = await pushed(w, [rec("vip", "ghost", "delete")]);
    expect(b.results.map(tag)).toEqual(["ok"]);
    expect(count(w, "records")).toBe(0);
  });

  it("records count in the pull's usage", async () => {
    const w = await world({ catalog });
    await pushed(w, [
      rec("saves", "a", "set", { value: { playtime: 1 } }),
      rec("saves", "b", "set", { value: { playtime: 2 } }),
    ]);
    const body = (await (await pull(w)).json()) as {
      usage: { records: number; bytes: number };
    };
    expect(body.usage.records).toBe(2);
    expect(body.usage.bytes).toBeGreaterThan(0);
  });
});
