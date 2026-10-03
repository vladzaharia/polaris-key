/**
 * The docs site's half of the service-table drift gate (P0-09).
 *
 * Every row of `tools/services.json` is a service with its own docs section: a
 * `src/content/docs/services/<slug>/` directory and a "Services" sidebar entry in
 * `astro.config.mjs` that autogenerates from it. Both are hand-written (a docs page is prose,
 * not generated output), so each is asserted here and a new table row fails with a message
 * naming what is missing (/docs/contribute/layout/#adding-a-service).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
