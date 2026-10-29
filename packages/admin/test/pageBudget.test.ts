/**
 * Page budget for the console sections: no file under `src/console/sections/` grows past 600
 * lines. Files already over it are listed in `OVER_BUDGET` with a ceiling at their current size.
 * The list only shrinks: a listed file that grows fails, and so does one that is back under 600
 * lines (delete its entry in the change that splits it). A new file over the budget, listed or
 * not, fails by name.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const BUDGET = 600;
const SECTIONS = join(import.meta.dirname, "../src/console/sections");

/**
 * Over-budget files (relative to `src/console/`) and the line count each may not exceed. Five
 * ceilings (UserRecord, PackageRecord, PackRecord, ReleaseRecord, ListingPage) were raised by the
 * `pk-vt-tabpanel` wrapper around each tab panel, merged from the UI-kit branches; split those
 * pages when next touched.
 */
const OVER_BUDGET: Record<string, number> = {
  "sections/core/pages/Keys.tsx": 870,
  "sections/core/pages/KeysCi.tsx": 714,
  "sections/core/pages/Overview.tsx": 896,
  "sections/core/pages/Settings.tsx": 668,
  "sections/core/pages/UserRecord.tsx": 686,
  "sections/distribution/components/RolloutDialogs.tsx": 847,
  "sections/distribution/components/StoreControls.tsx": 920,
  "sections/distribution/pages/CredentialsPage.tsx": 1146,
  "sections/distribution/pages/HealthPage.tsx": 736,
  "sections/distribution/pages/MatrixPage.tsx": 732,
  "sections/distribution/pages/OutletsPage.tsx": 1123,
  "sections/feeds/pages/FeedSettings.tsx": 1083,
  "sections/platform/pages/platformStores.tsx": 1790,
  "sections/release/components/PolicyDialog.tsx": 655,
  "sections/release/pages/CompatibilityPage.tsx": 753,
  "sections/release/pages/PackRecord.tsx": 755,
  "sections/release/pages/ReleaseRecord.tsx": 1216,
  "sections/release/pages/SimulatorPage.tsx": 766,
  "sections/storefronts/components/PolarisKeyPanel.tsx": 888,
};

/** Offences for a set of files (path -> line count) against a budget and an allow-list. */
function budgetOffences(
  files: Record<string, number>,
  allow: Record<string, number>,
  budget = BUDGET,
): string[] {
  const out: string[] = [];
  for (const [path, lines] of Object.entries(files)) {
    const ceiling = allow[path];
    if (ceiling === undefined) {
      if (lines > budget) out.push(`${path}: ${lines} lines, over ${budget}`);
    } else if (lines > ceiling) {
      out.push(`${path}: grew to ${lines} lines, ceiling ${ceiling}`);
    } else if (lines <= budget) {
      out.push(
        `${path}: ${lines} lines is within ${budget}; drop it from OVER_BUDGET`,
      );
    }
  }
  for (const path of Object.keys(allow)) {
    if (!(path in files)) out.push(`${path}: listed in OVER_BUDGET but gone`);
  }
  return out;
}

function sectionFiles(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) {
        const text = readFileSync(full, "utf8");
        out[relative(join(SECTIONS, ".."), full).split("\\").join("/")] =
          text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      }
    }
  };
  walk(SECTIONS);
  return out;
}

describe("console section page budget", () => {
  it("keeps every file under the budget or on the shrinking allow-list", () => {
    expect(budgetOffences(sectionFiles(), OVER_BUDGET)).toEqual([]);
  });

  it("negative control: the check names a new, a grown and a shrunk file", () => {
    const offences = budgetOffences(
      {
        "sections/x/pages/New.tsx": 601,
        "sections/x/pages/Grown.tsx": 701,
        "sections/x/pages/Small.tsx": 500,
      },
      { "sections/x/pages/Grown.tsx": 700, "sections/x/pages/Small.tsx": 650 },
    );
    expect(offences).toHaveLength(3);
    expect(budgetOffences({ "sections/x/pages/Ok.tsx": 600 }, {})).toEqual([]);
  });
});
