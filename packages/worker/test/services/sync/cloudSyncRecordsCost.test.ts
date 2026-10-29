/**
 * U-09.R B1: what a write to a `merge` record costs the object stays flat however many fields were
 * removed from it: the record keeps at most 256 removed cells, so its rows read per push stop
 * growing (the SQLite store's meter counts them).
 */
import { describe, expect, it } from "vitest";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import type { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { SqlTestStore } from "../../cloudSyncSqlTestStore.js";
import {
  applyAll,
  NOW,
  recordOp as mut,
  recordRoute as route,
  restartIds as reset,
} from "./cloudSyncRecordsHarness.js";

const MERGE = route("merge", { maxRecords: 1000 });
const at = (n: number) => formatHlc(NOW - 1_000_000 + n, 0);

describe("the rows a push reads do not grow with the fields removed from a record", () => {
  it("is the same after 300 and after 900 removals", () => {
    reset();
    const s = new SqlTestStore();
    const apply = (items: Parameters<typeof applyAll>[1]) =>
      applyAll(s as unknown as MemoryStore, items);
    const batch = (
      from: number,
      count: number,
    ): [SyncMutation, typeof MERGE][] =>
      Array.from({ length: count }, (_, k) => [
        mut("notes", "n", "removeField", {
          field: `gone${String(from + k).padStart(5, "0")}`,
          editedHlc: at(from + k),
        }),
        MERGE,
      ]);
    apply([
      [mut("notes", "n", "setField", { field: "keep", value: 1 }), MERGE],
    ]);
    let done = 0;
    const grow = (to: number) => {
      while (done < to) {
        apply(batch(done, 100));
        done += 100;
      }
    };
    const probe = () => {
      s.takeMeter();
      apply([
        [
          mut("notes", "n", "setField", {
            field: "keep",
            value: done,
            editedHlc: at(done + 5000),
          }),
          MERGE,
        ],
      ]);
      return s.takeMeter();
    };
    grow(300);
    const early = probe();
    grow(900);
    const late = probe();
    expect(late.rowsRead).toBe(early.rowsRead);
    // The record holds 256 removed cells and the live one, not 900.
    const row = s.getRecord("notes", "n")!;
    expect([...row.fields!.values()].filter((c) => c.removed)).toHaveLength(
      256,
    );
    // A push of 100 removals reads a bounded number of rows (the reviewer measured 151,911 at 800
    // cells before the bound).
    s.takeMeter();
    apply(batch(done, 100));
    expect(s.takeMeter().rowsRead).toBeLessThan(100 * 600);
  });
});
