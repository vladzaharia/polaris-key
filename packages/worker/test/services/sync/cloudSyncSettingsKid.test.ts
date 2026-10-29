/**
 * U-09.5: a sealed write records the envelope's key id (`kid`, bytes 1 to 16 as hex) on the
 * setting row, the tombstone and the merge member it produced (plans/U-09-slices.md §2.1, D6). A
 * plaintext write has none. `cloudSyncSqlParitySettingsKid.test.ts` replays this file over the
 * Durable Object's SQLite store, which persists the column in `settings`, `tombstones` and
 * `setting_members`.
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import type { SettingPolicy } from "../../../src/services/sync/engine/types.js";
import {
  applyOk,
  blinded as BLIND,
  kidOf,
  sealedBox as envelope,
  settingOp,
  settingRoute,
} from "./cloudSyncRecordsHarness.js";

function push(
  store: MemoryStore,
  m: Pick<SyncMutation, "op" | "ct" | "value" | "member" | "baseVersion">,
  key: string,
  policy: SettingPolicy,
  sealed: boolean,
): void {
  applyOk(store, [settingOp(key, m.op, m), settingRoute(policy, sealed)]);
}

const row = (store: MemoryStore, key: string) =>
  store.rows().find((r) => r.key === key);

describe("the key id of a sealed setting write", () => {
  it("is recorded on a scalar row, and not on a plaintext one", () => {
    const store = new MemoryStore();
    push(store, { op: "set", ct: envelope(7) }, BLIND(1), "lastWrite", true);
    push(store, { op: "set", value: 1 }, "plain", "lastWrite", false);
    expect(row(store, BLIND(1))?.kid).toBe(kidOf(7));
    expect(row(store, "plain")?.kid).toBeUndefined();
  });

  it("follows the latest write of a row (an E2E max/min re-set)", () => {
    const store = new MemoryStore();
    push(store, { op: "set", ct: envelope(7) }, "best", "max", true);
    push(
      store,
      { op: "set", ct: envelope(9), baseVersion: 1 },
      "best",
      "max",
      true,
    );
    expect(row(store, "best")?.kid).toBe(kidOf(9));
  });

  it("is recorded on each sealed merge member, and not on the merged row", () => {
    const store = new MemoryStore();
    push(
      store,
      { op: "setMember", member: BLIND(2), ct: envelope(3) },
      "set",
      "merge",
      true,
    );
    push(
      store,
      { op: "setMember", member: BLIND(3), ct: envelope(4) },
      "set",
      "merge",
      true,
    );
    const r = row(store, "set");
    expect(r?.kid).toBeUndefined();
    expect(r?.members?.get(BLIND(2))?.kid).toBe(kidOf(3));
    expect(r?.members?.get(BLIND(3))?.kid).toBe(kidOf(4));
    // A removal carries no envelope and so no kid.
    push(store, { op: "removeMember", member: BLIND(2) }, "set", "merge", true);
    expect(row(store, "set")?.members?.get(BLIND(2))?.kid).toBeUndefined();
    expect(row(store, "set")?.members?.get(BLIND(3))?.kid).toBe(kidOf(4));
  });

  it("stays on the tombstone a clear leaves", () => {
    const store = new MemoryStore();
    push(store, { op: "set", ct: envelope(7) }, BLIND(1), "lastWrite", true);
    push(store, { op: "clear" }, BLIND(1), "lastWrite", true);
    const r = row(store, BLIND(1));
    expect(r?.deleted).toBe(true);
    expect(r?.kid).toBe(kidOf(7));
  });
});
