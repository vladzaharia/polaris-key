/**
 * P0-42: the generator registry (tools/generators.ts) is the one list of generators.
 * Every GENERATED banner in the repository is claimed by a registered output, every registered
 * output glob matches a tracked file, and `pnpm gen` selects families the way its help says.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs, select } from "./gen.js";
import {
  checkSteps,
  defaultFamilies,
  familiesTouching,
  GENERATORS,
  globToRegExp,
  matchesAny,
  ownerOf,
} from "./generators.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  },
)
  .toString()
  .split("\0")
  .filter(Boolean);

// A banner is a comment line that opens with GENERATED or @generated, within the first lines.
const BANNER =
  /^[ \t]*(?:\/\/|#|\/\*+|\*|<!--|\{\/\*|;|--)[ \t]*(?:GENERATED|@generated)\b/m;
const BINARY =
  /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zst|bin|wasm|zip|pdf|svg)$/i;
// Files whose own header is not a banner of their own: a lockfile cargo writes.
const NOT_OURS = /(^|\/)Cargo\.lock$/;

describe("the registry", () => {
  it("has unique ids and orders, and resolvable aliases", () => {
    const ids = GENERATORS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = GENERATORS.map((g) => g.order);
    expect(new Set(orders).size).toBe(orders.length);
    for (const g of GENERATORS) if (g.via) expect(ids).toContain(g.via);
  });

  it("gives every default family something to run", () => {
    for (const g of defaultFamilies()) {
      expect(g.write?.length ?? 0, g.id).toBeGreaterThan(0);
      expect(checkSteps(g).length, g.id).toBeGreaterThan(0);
    }
  });

  it("matches every output glob to a tracked file", () => {
    for (const g of GENERATORS)
      for (const glob of g.outputs)
        expect(
          tracked.some((f) => globToRegExp(glob).test(f)),
          `${g.id}: ${glob}`,
        ).toBe(true);
  });

  it("matches every input glob to a tracked file", () => {
    for (const g of GENERATORS)
      for (const glob of g.inputs)
        expect(
          tracked.some((f) => globToRegExp(glob).test(f)),
          `${g.id}: ${glob}`,
        ).toBe(true);
  });
});

describe("GENERATED banners", () => {
  it("every one maps to a registered output", () => {
    const orphans: string[] = [];
    for (const f of tracked) {
      if (
        BINARY.test(f) ||
        NOT_OURS.test(f) ||
        f.startsWith("docs/research/2026-09-29-godot-omniplatform/prototype/")
      )
        continue;
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), "utf8");
      } catch {
        continue;
      }
      const head = text.split("\n", 8).join("\n");
      if (BANNER.test(head) && !ownerOf(f)) orphans.push(f);
    }
    expect(orphans).toEqual([]);
  });
});

describe("globs", () => {
  it("handles **, *, braces and a trailing slash", () => {
    expect(matchesAny(["a/**"], "a/b/c.txt")).toBe(true);
    expect(matchesAny(["a/*.json"], "a/b/c.json")).toBe(false);
    expect(matchesAny(["a/{x,y}.ts"], "a/y.ts")).toBe(true);
    expect(matchesAny(["a/"], "a/b/c")).toBe(true);
    expect(matchesAny(["a/**/c.ts"], "a/c.ts")).toBe(true);
  });
});

describe("pnpm gen selection", () => {
  it("tolerates the literal -- pnpm forwards and reads the flags", () => {
    expect(parseArgs(["--", "--check", "corpus", "brand"])).toMatchObject({
      check: true,
      names: ["corpus", "brand"],
    });
    expect(parseArgs(["mirrors", "--catalog", "c.json"]).forward).toEqual([
      "--catalog",
      "c.json",
    ]);
  });

  it("runs the default families in registry order, without manual or alias entries", () => {
    const ids = select(parseArgs([])).map((g) => g.id);
    expect(ids).toEqual(
      [...ids].sort(
        (a, b) =>
          (GENERATORS.find((g) => g.id === a)?.order ?? 0) -
          (GENERATORS.find((g) => g.id === b)?.order ?? 0),
      ),
    );
    expect(ids).toContain("corpus");
    expect(ids).toContain("brand");
    expect(ids).not.toContain("mirrors");
    expect(ids).not.toContain("ui-matrix");
  });

  it("runs an alias through its parent and rejects unknown names", () => {
    expect(select(parseArgs(["ui-matrix"])).map((g) => g.id)).toEqual([
      "corpus",
    ]);
    expect(() => select(parseArgs(["nope"]))).toThrow(/unknown generator/);
  });

  it("--fast keeps only the cheap families", () => {
    expect(select(parseArgs(["--fast"])).map((g) => g.id)).toEqual([
      "corpus",
      "services",
      "registry-docs",
    ]);
  });

  it("--changed selects the families whose inputs or outputs changed", () => {
    const ids = (files: string[]) =>
      select(parseArgs(["--changed"]), () => files).map((g) => g.id);
    expect(ids(["tools/services.json"])).toContain("services");
    expect(ids(["tools/services.json"])).not.toContain("brand");
    expect(ids(["tools/ui-matrix.ts"])).toContain("corpus");
    expect(ids(["README.md"])).toEqual([]);
    expect(
      familiesTouching(["packages/brand/tokens.json"]).map((g) => g.id),
    ).toContain("brand");
  });
});
