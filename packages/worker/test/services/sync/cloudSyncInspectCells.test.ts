/** F7-R4: the console Data tab's per-collection bytes count `merge` cells and `union` elements. */
import { describe, expect, it } from "vitest";
import { SqlTestStore } from "../../cloudSyncSqlTestStore.js";
import {
  applyAll,
  recordOp as mut,
  recordRoute as route,
  restartIds,
} from "./cloudSyncRecordsHarness.js";

describe("inspect counts field and element bytes", () => {
  it("a merge record's cells and a union record's elements add to the collection", () => {
    restartIds();
    const s = new SqlTestStore();
    applyAll(s as never, [
      [
        mut("m", "r", "setField", { field: "hp", value: "x".repeat(100) }),
        route("merge"),
      ],
      [mut("u", "r", "add", { element: "y".repeat(100) }), route("union")],
    ]);
    const t = s.inspectTables();
    const bytes = (n: string) =>
      t.collections.find((c) => c.name === n)?.bytes ?? 0;
    expect(bytes("m")).toBeGreaterThanOrEqual(100);
    expect(bytes("u")).toBeGreaterThanOrEqual(100);
  });
});
