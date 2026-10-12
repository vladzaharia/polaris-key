/**
 * AX-01: the root README is a router, so it must stay true to the workspace. Its layout block
 * names every directory under `packages/` and `sdks/` and every top-level directory the repository
 * ships, its start-here table has one row per task, and it carries no test counts (they rot).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

const dirsOf = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "node_modules")
    .map((d) => d.name);

/** The first fenced block under the "Layout" heading. */
function layoutBlock(): string {
  const section = readme.split(/^## Layout$/m)[1] ?? "";
  const match = /```\n([\s\S]*?)```/.exec(section);
  return match?.[1] ?? "";
}

describe("README.md", () => {
  const layout = layoutBlock();

  it("has a layout block", () => {
    expect(layout).toContain("packages/");
  });

  it.each(dirsOf("packages"))("the layout block lists packages/%s", (dir) => {
    expect(layout).toMatch(new RegExp(`^  ${dir}/ `, "m"));
  });

  it.each(dirsOf("sdks"))("the layout block lists sdks/%s", (dir) => {
    expect(layout).toMatch(new RegExp(`^  ${dir}/ `, "m"));
  });

  it.each(["conformance", "tools", "products", "actions", "examples", "docs"])(
    "the layout block lists %s/",
    (dir) => {
      expect(existsSync(join(ROOT, dir))).toBe(true);
      expect(layout).toMatch(new RegExp(`^${dir}(/| )`, "m"));
    },
  );

  it("has a start-here table with the three tasks", () => {
    const section =
      readme.split(/^## Start here$/m)[1]?.split(/^## /m)[0] ?? "";
    for (const task of ["Use an SDK", "Run a product", "Change the platform"])
      expect(section).toContain(task);
  });

  it("states no test counts", () => {
    expect(readme).not.toMatch(/\b\d[\d,]*\s+tests\b/i);
    expect(readme).not.toMatch(/\bworker \d{3,}/i);
  });
});
