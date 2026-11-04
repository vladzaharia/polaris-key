import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MASTHEAD_DEBT } from "../e2e/layoutDebt.js";
import { UX_BAR_DEBT } from "../e2e/uxBar.js";

/**
 * The "paid debt" half of the console and portal e2e runs. The suites that own a ledger are split
 * over test files, and in CI over jobs, so no one part can say an entry matched nothing. Each part
 * wrote what it matched to `PK_DEBT_DIR`; the entries nothing matched across ALL parts are stale
 * and must be deleted (the ledgers only shrink). The suites and the parts they must have run:
 */
const REQUIRED: Record<string, number> = { layout: 8, portalUxBar: 2 };

interface Recorded {
  suite: string;
  index: number;
  count: number;
  masthead?: number[];
  ux?: number[];
}

const dir = process.env.PK_DEBT_DIR;
const recorded: Recorded[] =
  dir && existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Recorded)
    : [];

describe("the e2e debt ledgers", () => {
  it("has every part of every suite that owns a ledger", () => {
    expect(dir, "PK_DEBT_DIR names where the parts recorded").toBeTruthy();
    for (const [suite, count] of Object.entries(REQUIRED)) {
      const have = recorded
        .filter((r) => r.suite === suite)
        .map((r) => `${r.index}of${r.count}`)
        .sort();
      const want = Array.from({ length: count }, (_, i) => `${i}of${count}`);
      expect(have, `parts of ${suite}`).toEqual(want);
    }
  });

  it("holds no MASTHEAD_DEBT entry that no violation matches", () => {
    const used = new Set(recorded.flatMap((r) => r.masthead ?? []));
    const paid = MASTHEAD_DEBT.filter((_, i) => !used.has(i));
    expect(
      paid.map((d) => `${d.cases} (${d.owner})`),
      "MASTHEAD_DEBT entries that no longer match a violation (delete them)",
    ).toEqual([]);
  });

  it("holds no UX_BAR_DEBT entry that no finding matches", () => {
    const used = new Set(recorded.flatMap((r) => r.ux ?? []));
    const stale = UX_BAR_DEBT.flatMap((d, i) =>
      used.has(i) ? [] : [`${d.rule} ${d.match} (${d.owner})`],
    );
    expect(
      stale,
      "UX_BAR_DEBT entries that no longer match a finding (delete them)",
    ).toEqual([]);
  });
});
