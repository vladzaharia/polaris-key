// Guards against tests that break for reasons unrelated to the code under test.
//
//  1. Every vitest config imports tools/pin-test-env.mjs, so TZ and locale are the same on a
//     laptop and in CI.
//  2. A test never reads the wall clock for a bare `new Date()`: a value that depends on when the
//     test runs is injected, or the line carries a `brittle-ok: <reason>` comment (same line or
//     the line above) saying why the real clock is right there.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Tracked files under the given git pathspecs (`*` crosses directories in a pathspec). */
const tracked = (...specs: string[]): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", ...specs], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((f) => join(ROOT, f));

const packages = readdirSync(join(ROOT, "packages")).map((n) =>
  join(ROOT, "packages", n),
);
const rel = (p: string) => relative(ROOT, p);

describe("vitest configs pin the test environment", () => {
  const configs = [
    ...packages.flatMap((p) =>
      readdirSync(p)
        .filter((n) => /^(vitest\..*config|vite\.config)\.ts$/.test(n))
        .map((n) => join(p, n)),
    ),
    join(ROOT, "tools/vitest.config.ts"),
    ...["browser", "node"].map((n) =>
      join(ROOT, "conformance/runners", n, "vitest.config.ts"),
    ),
  ];

  it("finds the configs", () => {
    expect(configs.length).toBeGreaterThan(10);
  });

  for (const c of configs)
    it(`${rel(c)} imports pin-test-env`, () => {
      expect(readFileSync(c, "utf8")).toMatch(
        /^import "(\.\.?\/)+(tools\/)?pin-test-env\.mjs";/m,
      );
    });
});

describe("tests do not read the wall clock through a bare new Date()", () => {
  const testFiles = tracked(
    "packages/*/test/*.ts",
    "packages/*/test/*.tsx",
    "packages/*/test-*/*.ts",
    "packages/*/e2e/*.ts",
    "conformance/runners/*.ts",
  );

  it("finds the test files", () => {
    expect(testFiles.length).toBeGreaterThan(100);
  });

  it("every bare new Date() says why the real clock is right", () => {
    const bad: string[] = [];
    for (const f of testFiles) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\bnew Date\(\s*\)/.test(line)) return;
        if (/brittle-ok:/.test(line) || /brittle-ok:/.test(lines[i - 1] ?? ""))
          return;
        bad.push(`${rel(f)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
