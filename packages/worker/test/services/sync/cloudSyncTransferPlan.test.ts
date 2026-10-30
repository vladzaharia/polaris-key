/**
 * U-10.5: `syncTransferPlan` replays `transferPlanCases` of `sync-vectors.json` (U-34), the table
 * every SDK pins its own planner to (WIRE-CONTRACT-V5 §13.8.1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNC_FILE_MAX_BYTES,
  SYNC_PART_MAX_BYTES,
  SYNC_PART_MIN_BYTES,
} from "@polaris-key/protocol/sync";
import { syncTransferPlan } from "../../../src/services/sync/engine/files.js";
import { WORKER_ROOT } from "../../paths.js";

interface PlanCase {
  id: string;
  size: number;
  delta: boolean;
  expect: { mode: string; partBytes: number | null; parts: number | null };
}

const cases = (
  JSON.parse(
    readFileSync(
      join(WORKER_ROOT, "..", "..", "conformance/corpus/v2/sync-vectors.json"),
      "utf8",
    ),
  ) as { transferPlanCases: PlanCase[] }
).transferPlanCases;

describe("syncTransferPlan", () => {
  it("has the corpus's cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const plan = syncTransferPlan(c.size, c.delta);
    expect(plan.mode).toBe(c.expect.mode);
    expect("partBytes" in plan ? plan.partBytes : null).toBe(
      c.expect.partBytes,
    );
    expect("parts" in plan ? plan.parts : null).toBe(c.expect.parts);
  });

  it("keeps every part inside R2's range and the part count under its cap, up to 1 GiB", () => {
    for (
      let size = 16 * 1024 * 1024 + 1;
      size <= SYNC_FILE_MAX_BYTES;
      size += 7_340_033
    ) {
      const p = syncTransferPlan(size, false);
      if (p.mode !== "multipart") throw new Error(`size ${size}: ${p.mode}`);
      expect(p.partBytes).toBeGreaterThanOrEqual(SYNC_PART_MIN_BYTES);
      expect(p.partBytes).toBeLessThanOrEqual(SYNC_PART_MAX_BYTES);
      expect(p.partBytes % (1024 * 1024)).toBe(0);
      expect(p.parts * p.partBytes).toBeGreaterThanOrEqual(size);
      expect((p.parts - 1) * p.partBytes).toBeLessThan(size);
      expect(p.parts).toBeLessThanOrEqual(9999);
    }
  });

  it("refuses sizes that are not byte counts", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])
      expect(syncTransferPlan(bad, false).mode).toBe("too_large");
  });
});
