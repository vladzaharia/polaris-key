/**
 * The docs site's half of the service-table drift gate (P0-09).
 *
 * Every row of `tools/services.json` is a service with its own docs section: a
 * `src/content/docs/services/<slug>/` directory and a "Services" sidebar entry in
 * `astro.config.mjs` that autogenerates from it. Both are hand-written (a docs page is prose,
 * not generated output), so each is asserted here and a new table row fails with a message
 * naming what is missing (/docs/contribute/layout/#adding-a-service).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const astroConfig = readFileSync(join(docsRoot, "astro.config.mjs"), "utf8");

describe("the service table, as the docs site sees it", () => {
  it("every service has a services/<slug>/ docs directory with an index page", () => {
    for (const row of table.services) {
      const dir = join(
        docsRoot,
        "src",
        "content",
        "docs",
        "services",
        row.slug,
      );
      expect(
        existsSync(dir),
        `src/content/docs/services/${row.slug}/ is missing (docs section for "${row.slug}", served at ${row.docs})`,
      ).toBe(true);
      expect(
        ["index.md", "index.mdx"].some((f) => existsSync(join(dir, f))),
        `src/content/docs/services/${row.slug}/ has no index page for ${row.docs}`,
      ).toBe(true);
    }
  });

  it("astro.config.mjs has a Services sidebar entry per service, in table order", () => {
    const entry = (row: Row): RegExp =>
      new RegExp(
        `\\{\\s*label:\\s*"${row.label}",\\s*items:\\s*\\[\\s*\\{\\s*autogenerate:\\s*\\{\\s*directory:\\s*"services/${row.slug}"\\s*\\}\\s*\\}\\s*\\]`,
      );
    const positions: number[] = [];
    for (const row of table.services) {
      const match = entry(row).exec(astroConfig);
      expect(
        match,
        `astro.config.mjs has no sidebar entry { label: "${row.label}", items: [{ autogenerate: { directory: "services/${row.slug}" } }] }`,
      ).not.toBeNull();
      positions.push(match!.index);
    }
    expect(
      positions,
      "astro.config.mjs lists the service sidebar entries out of table order",
    ).toEqual([...positions].sort((a, b) => a - b));
  });
});

/**
 * P0-48: prose that counts the services agrees with the table. "The six service slugs" outlived
 * Cloud Sync's row; a count of the WHOLE set ("the N service slugs", "one of the N opt-in
 * services", "all N services", "which of the N services") must say the table's size. A count of
 * a named subset ("the two services sign…", "the three services split…") is not matched.
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
        const word = m.slice(1).find((g) => g !== undefined)!.toLowerCase();
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
