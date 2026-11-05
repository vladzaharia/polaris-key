import { mkdirSync, writeFileSync } from "node:fs";

/**
 * One heavy e2e suite split over several test files, so CI can spread it over jobs (CS-1).
 *
 * A suite module (`layoutSuite.ts`, `portalQuality.suite.ts`, …) holds every test and assertion
 * once. Each thin `*.e2e.test.ts` beside it calls `runPart` with its slice, which names the slice
 * in a global and then imports the suite; the suite reads the slice back with `currentPart()` and
 * registers only its share. Every test is registered by exactly one thin file: the test-name list
 * of the thin files together equals the list the single file had (`e2e/parts.test.ts` pins the
 * partition of the layout viewports).
 */
export interface Part {
  /** The suite name (`layout`, `portalQuality`, …). */
  suite: string;
  /** This slice, from 0. */
  index: number;
  /** How many slices the suite has. */
  count: number;
}

const KEY = "__pkE2ePart";

/** Names the slice, then imports the suite so its `describe`s register only that slice. */
export async function runPart(
  part: Part,
  load: () => Promise<unknown>,
): Promise<void> {
  (globalThis as Record<string, unknown>)[KEY] = part;
  await load();
}

/** The slice the importing test file runs; undefined when the suite runs whole. */
export function currentPart(): Part | undefined {
  return (globalThis as Record<string, unknown>)[KEY] as Part | undefined;
}

/** This slice's share of a list: every `count`th item from `index`, so cost spreads evenly. */
export function partOf<T>(items: readonly T[]): T[] {
  const p = currentPart();
  return p ? items.filter((_, i) => i % p.count === p.index) : [...items];
}

/** What a slice found matched in the shrink-only debt ledgers (indexes into the ledgers). */
export interface DebtUse {
  masthead?: number[];
  ux?: number[];
}

/**
 * A slice cannot tell whether a ledger entry is stale: the page that matches it may belong to
 * another slice, and so to another CI job. With `PK_DEBT_DIR` set it writes what it matched and
 * `scripts/e2e-debt.ts` merges every slice and fails on an entry that nothing matched. Returns
 * true when the slice recorded (the caller then skips its own whole-run check).
 */
export function recordDebtUse(use: DebtUse): boolean {
  const p = currentPart();
  const dir = process.env.PK_DEBT_DIR;
  if (!p) return false;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/${p.suite}.${p.index}of${p.count}.json`,
      JSON.stringify({ ...p, ...use }),
    );
  }
  return true;
}
