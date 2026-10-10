/**
 * The docs site's half of the service-table drift gate (P0-09).
 *
 * Every row of `tools/services.json` is a service with a docs home: it belongs to a feature in
 * `src/lib/features.ts`, whose `src/content/docs/features/<feature>/` directory has an index
 * page, and that feature has a group in the Developers sidebar (`src/lib/doors.ts`). A new table
 * row fails here with a message naming what is missing (/docs/contribute/layout/#adding-a-service).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOOR_TREES } from "../src/lib/doors";
import { FEATURES, type Feature } from "../src/lib/features";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "..", "..");

interface Row {
  slug: string;
  label: string;
  docs: string;
}

const table = JSON.parse(
  readFileSync(join(repoRoot, "tools", "services.json"), "utf8"),
) as { services: Row[] };

const featureOf = (slug: string): Feature | undefined =>
  Object.values(FEATURES).find((f) => f.services.includes(slug));

describe("the service table, as the docs site sees it", () => {
  it("every service belongs to a feature", () => {
    for (const row of table.services)
      expect(
        featureOf(row.slug),
        `src/lib/features.ts has no feature for service "${row.slug}" (add it to a feature's services)`,
      ).toBeDefined();
  });

  it("every service's feature has a docs directory with an index page", () => {
    for (const row of table.services) {
      const feature = featureOf(row.slug)!;
      const dir = join(
        docsRoot,
        "src",
        "content",
        "docs",
        "features",
        feature.id,
      );
      expect(
        existsSync(dir),
        `src/content/docs/features/${feature.id}/ is missing (docs for service "${row.slug}")`,
      ).toBe(true);
      expect(
        ["index.md", "index.mdx"].some((f) => existsSync(join(dir, f))),
        `src/content/docs/features/${feature.id}/ has no index page`,
      ).toBe(true);
    }
  });

  it("every feature with a service has a group in the Developers sidebar", () => {
    const developers = DOOR_TREES.find((t) => t.door === "developers")!;
    const labels = developers.groups.map((g) => g.label);
    for (const feature of Object.values(FEATURES)) {
      if (feature.services.length === 0) continue;
      expect(
        labels,
        `src/lib/doors.ts has no Developers group "${feature.label}"`,
      ).toContain(feature.label);
    }
  });
});

/**
 * P0-48: prose that counts the services agrees with the table. "The six service slugs" outlived
 * Cloud Sync's row; a count of the WHOLE set ("the N service slugs", "one of the N opt-in
 * services", "all N services", "which of the N services", "with all N flags off") must say the
 * table's size. A count of a named subset ("the two services sign…", "the three services
 * split…") is not matched.
 */
describe("prose that counts the services", () => {
  const WORDS = [
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ];
  const n = `(${WORDS.join("|")})`;
  const WHOLE_SET = new RegExp(
    [
      `\\bthe ${n} service (?:slugs|namespaces|accents)\\b`,
      `\\bthe ${n} opt-in services\\b`,
      `\\ball ${n} (?:opt-in )?services\\b`,
      `\\bof the ${n} (?:opt-in )?services\\b`,
      `\\bcarries ${n} services\\b`,
      `\\ball ${n} service flags\\b`,
      `\\bwith all ${n} flags off\\b`,
    ].join("|"),
    "gi",
  );

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.mdx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it("says the service table's size wherever it counts the whole set", () => {
    const expected = WORDS[table.services.length - 2]!;
    const files = [
      ...walk(join(docsRoot, "src", "content", "docs")),
      join(repoRoot, "README.md"),
      join(repoRoot, "AGENTS.md"),
    ];
    const wrong: string[] = [];
    let counted = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
      for (const m of text.matchAll(WHOLE_SET)) {
        counted++;
        const word = m
          .slice(1)
          .find((g) => g !== undefined)!
          .toLowerCase();
        if (word !== expected)
          wrong.push(`${relative(repoRoot, file)}: "${m[0]}"`);
      }
    }
    // The pattern must still be finding the counts it polices.
    expect(counted).toBeGreaterThan(0);
    expect(
      wrong,
      `tools/services.json has ${table.services.length} rows ("${expected}")`,
    ).toEqual([]);
  });
});
