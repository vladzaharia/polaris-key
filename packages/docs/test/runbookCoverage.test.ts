/**
 * Every H2 of the operator files renders on a page. `docs/RUNBOOK.md` is cut into sections that
 * `<RunbookSection>` places on the runbook pages; a section no page places is written but never
 * shown. `docs/DEPLOYMENT.md` renders whole on the Deploy page.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitSections } from "../src/lib/runbook";

const here = dirname(fileURLToPath(import.meta.url));
const content = join(here, "..", "src", "content", "docs");
const docsDir = join(here, "..", "..", "..", "docs");

function* pages(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* pages(full);
    else if (/\.mdx?$/.test(entry)) yield full;
  }
}

const placed = new Set<string>();
const wholeFiles = new Set<string>();
for (const file of pages(content)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(
    /<RunbookSection\s+file="(\w+)"\s+heading="([^"]+)"\s*\/>/g,
  ))
    placed.add(`${m[1]}|${m[2]}`);
  for (const m of text.matchAll(/docs\/(RUNBOOK|DEPLOYMENT)\.md"/g))
    wholeFiles.add(m[1]!);
}

describe("operator files", () => {
  it("renders every RUNBOOK H2 on a page", () => {
    const sections = splitSections(
      readFileSync(join(docsDir, "RUNBOOK.md"), "utf8"),
    );
    const missing = sections
      .map((s) => s.heading)
      .filter((h) => !placed.has(`RUNBOOK|${h}`));
    expect(missing).toEqual([]);
  });

  it("places no section that RUNBOOK lacks", () => {
    const headings = new Set(
      splitSections(readFileSync(join(docsDir, "RUNBOOK.md"), "utf8")).map(
        (s) => s.heading,
      ),
    );
    const unknown = [...placed]
      .filter((p) => p.startsWith("RUNBOOK|"))
      .map((p) => p.slice("RUNBOOK|".length))
      .filter((h) => !headings.has(h));
    expect(unknown).toEqual([]);
  });

  it("renders DEPLOYMENT whole on a page", () => {
    expect(wholeFiles.has("DEPLOYMENT")).toBe(true);
  });
});
