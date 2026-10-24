/**
 * AX-03b.2: `registry-docs` splices every generated block of AGENTS.md from a block table.
 * A missing marker throws, the repo map lists every workspace package, and it stays in budget.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOCKS,
  REPO_MAP_BUDGET,
  agentsTable,
  markers,
  readmeSummary,
  repoMap,
  spliceBlocks,
} from "./gen-generators-doc.js";
import { GENERATORS } from "./generators.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

describe("AGENTS.md generated blocks", () => {
  it("has a marker pair for every block in the table", () => {
    for (const b of BLOCKS) {
      const m = markers(b.name);
      expect(agents).toContain(m.start);
      expect(agents).toContain(m.end);
    }
  });

  it("splicing the committed file is a no-op (the file is current)", () => {
    expect(spliceBlocks(spliceBlocks(agents))).toBe(spliceBlocks(agents));
  });

  it("throws on a missing marker", () => {
    for (const b of BLOCKS) {
      const broken = agents.replace(markers(b.name).start, "");
      expect(() => spliceBlocks(broken)).toThrow(/lacks the/);
    }
  });

  it("replaces only what sits between the markers", () => {
    const m = markers("repo-map");
    const stub = `before\n${m.start}\nOLD\n${m.end}\nafter\n`;
    const only = spliceBlocks(
      stub +
        BLOCKS.filter((b) => b.name !== "repo-map")
          .map((b) => `${markers(b.name).start}${markers(b.name).end}`)
          .join("\n"),
    );
    expect(only).not.toContain("OLD");
    expect(only.startsWith("before\n")).toBe(true);
    expect(only).toContain("\nafter\n");
  });

  it("the generators block lists every family once, without a Regenerate column", () => {
    const t = agentsTable();
    for (const g of GENERATORS)
      expect(t).toContain(`- \`${g.id}\`: ${g.title}`);
    expect(t).not.toContain("| Regenerate |");
  });

  it("the repo map lists every workspace package and stays in budget", () => {
    const map = repoMap();
    for (const n of readdirSync(join(ROOT, "packages"))) {
      try {
        readFileSync(join(ROOT, "packages", n, "package.json"));
      } catch {
        continue;
      }
      expect(map).toContain(`[\`packages/${n}/\`]`);
    }
    for (const n of readdirSync(join(ROOT, "sdks")))
      expect(map).toContain(`[\`sdks/${n}/\`]`);
    for (const d of [
      "conformance",
      "tools",
      "products",
      "actions/publish",
      "examples",
      "docs",
    ])
      expect(map).toContain(`[\`${d}/\`]`);
    expect(Buffer.byteLength(map)).toBeLessThanOrEqual(REPO_MAP_BUDGET);
  });

  it("takes the first sentence of a README, cut on a word boundary", () => {
    const r = readmeSummary(
      "# t\n\nOne line that wraps\nacross two. Second sentence.\n",
    );
    expect(r).toEqual({ title: "t", line: "One line that wraps across two." });
    const long = readmeSummary(`# t\n\n${"word ".repeat(40)}end.\n`);
    expect(long.line.length).toBeLessThanOrEqual(101);
    expect(long.line.endsWith("…")).toBe(true);
  });
});
