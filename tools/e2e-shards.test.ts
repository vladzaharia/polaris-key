import { describe, expect, it } from "vitest";
import {
  assign,
  costOf,
  e2eFiles,
  loadTimings,
  problems,
} from "./e2e-shards.mjs";

/** The console and portal e2e files are spread over CI jobs by `tools/e2e-shards.mjs` (CS-1). */
const SHARDS = 6;

describe("e2e shards", () => {
  const files = e2eFiles();
  const timings = loadTimings();

  it("puts every e2e file in exactly one shard, and lists no file that is gone", () => {
    expect(problems(files, assign(files, SHARDS, timings), timings)).toEqual(
      [],
    );
  });

  it("matches the shard count the console job in ci.yml runs", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    expect(ci).toContain(
      `shard: [${Array.from({ length: SHARDS }, (_, i) => i).join(", ")}]`,
    );
    expect(ci).toContain(`e2e-shards.mjs files \${{ matrix.shard }} ${SHARDS}`);
  });

  it("balances by duration: no shard is far above the mean", () => {
    const shards = assign(files, SHARDS, timings);
    const mean = shards.reduce((n, s) => n + s.load, 0) / SHARDS;
    for (const s of shards) expect(s.load).toBeLessThan(mean * 1.1);
  });

  it("is deterministic and costs an unlisted file the default", () => {
    expect(assign(files, SHARDS, timings)).toEqual(
      assign([...files].reverse(), SHARDS, timings),
    );
    expect(costOf("brand-new.e2e.test.ts", { _default: 17 })).toBe(17);
  });

  it("keeps every file within about one fork's share of a shard", () => {
    const longest = Math.max(...files.map((f) => costOf(f, timings)));
    const shards = assign(files, SHARDS, timings);
    const perFork = Math.min(...shards.map((s) => s.load)) / 3;
    expect(longest).toBeLessThan(perFork * 1.1);
  });

  it("splits more files than shards over fewer shards too", () => {
    for (const n of [1, 2, 4, 6, 9])
      expect(problems(files, assign(files, n, timings), timings)).toEqual([]);
  });
});
