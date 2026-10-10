import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs build script with no declarations
import { BUDGETS, verdict } from "../scripts/size-budget.mjs";

const row = (deltaGzip: number, wasm: string[] = []) => ({
  name: "provider+use-license",
  deltaGzip,
  budget: BUDGETS["provider+use-license"] as number,
  wasm,
});

// The measuring itself (a Vite build of each case) runs in CI after `pnpm build`
// (`pnpm --filter @polaris-key/react size`), with a negative control beside it.
describe("size budget verdict", () => {
  it("passes at and under the budget", () => {
    expect(verdict([row(BUDGETS["provider+use-license"])])).toEqual([]);
    expect(verdict([row(1)])).toEqual([]);
  });
  it("fails one byte over the budget", () => {
    expect(verdict([row(BUDGETS["provider+use-license"] + 1)])).toHaveLength(1);
  });
  it("fails on any wasm in the initial load, however small the JS", () => {
    expect(verdict([row(1, ["assets/zdec.wasm"])])).toHaveLength(1);
  });
  it("has a budget for every case", () => {
    expect(Object.keys(BUDGETS).sort()).toEqual([
      "provider+license-gate",
      "provider+use-license",
    ]);
  });
});
