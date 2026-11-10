// Guards against tests that break for reasons unrelated to the code under test.
//
//  1. Every vitest config imports tools/pin-test-env.mjs, so TZ and locale are the same on a
//     laptop and in CI.
//  2. A test never reads the wall clock for a bare `new Date()`: a value that depends on when the
//     test runs is injected, or the line carries a `brittle-ok: <reason>` comment (same line or
//     the line above) saying why the real clock is right there.
//  3. A test never waits on a real sleep (`setTimeout(resolve, N)`, `sleep(N)`, `waitForTimeout`):
//     a positive wait fails on a starved CPU and a negative one passes without proving anything.
//     Await the condition (`until`, `vi.waitFor`, an event, a fake clock) or annotate the line
//     `brittle-ok: <why>`. The sleeps already in the tree are held in tools/brittle-sleeps.json,
//     a per-file count that only shrinks: a new sleep fails, and so does a count that is too high.

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

/**
 * Real sleeps used as a wait, as 1-based line numbers: `waitForTimeout(…)`, `sleep(…)` / `delay(…)`,
 * and `setTimeout(<resolver>, <delay>)` with a literal delay of 10 ms or more (or a computed one).
 * A line carrying `brittle-ok:`, or the line above it, is exempt.
 */
export function findSleeps(text: string): number[] {
  const lines = text.split("\n");
  const hits: number[] = [];
  const patterns = [
    /\bwaitForTimeout\s*\(/g,
    /\b(?:sleep|delay)\s*\(/g,
    /\bsetTimeout\s*\(\s*(?:\(\s*\)\s*=>\s*)?(?:r|res|resolve|resolved|done|ok|fn)\b(?:\s*\(\s*\))?\s*,\s*([A-Za-z_$][\w$.]*|\d+)/g,
  ];
  for (const [k, re] of patterns.entries()) {
    for (const m of text.matchAll(re)) {
      if (k === 2 && /^\d+$/.test(m[1]!) && Number(m[1]) < 10) continue;
      const line = text.slice(0, m.index).split("\n").length;
      if (
        /\b(?:function|async function)\s+(?:sleep|delay)\b/.test(
          lines[line - 1]!,
        )
      )
        continue;
      if (
        /brittle-ok:/.test(lines[line - 1]!) ||
        /brittle-ok:/.test(lines[line - 2] ?? "")
      )
        continue;
      hits.push(line);
    }
  }
  return [...new Set(hits)].sort((a, b) => a - b);
}

describe("tests do not sleep for real", () => {
  it("flags a seeded sleep", () => {
    const seeded = [
      "await new Promise((r) => setTimeout(r, 50));",
      "await page.waitForTimeout(300);",
      "await sleep(20);",
      "await new Promise((resolve) =>",
      "  setTimeout(resolve, ms));",
    ].join("\n");
    expect(findSleeps(seeded)).toEqual([1, 2, 3, 5]);
  });

  it("honours brittle-ok on the line or the line above, and ignores a sub-10 ms yield", () => {
    const text = [
      "await sleep(20); // brittle-ok: a real socket needs a real beat",
      "// brittle-ok: negative wait",
      "await page.waitForTimeout(100);",
      "await new Promise((r) => setTimeout(r, 0));",
      "await new Promise((r) => setTimeout(r, 5));",
      "const t = setTimeout(() => stop(), 500);",
    ].join("\n");
    expect(findSleeps(text)).toEqual([]);
  });

  const testFiles = tracked(
    "packages/*/test/*.ts",
    "packages/*/test/*.tsx",
    "packages/*/test-*/*.ts",
    "packages/*/e2e/*.ts",
    "conformance/runners/*.ts",
  );
  const ledger = JSON.parse(
    readFileSync(join(ROOT, "tools/brittle-sleeps.json"), "utf8"),
  ) as { files: Record<string, number> };

  it("no test file gains a sleep, and the ledger holds no stale count", () => {
    const over: string[] = [];
    const stale: string[] = [];
    const seen = new Set<string>();
    for (const f of testFiles) {
      const n = findSleeps(readFileSync(f, "utf8")).length;
      const held = ledger.files[rel(f)] ?? 0;
      if (n > 0 || held > 0) seen.add(rel(f));
      if (n > held)
        over.push(
          `${rel(f)}: ${n} sleeps, ledger ${held} (await the condition, or brittle-ok:)`,
        );
      if (n < held)
        stale.push(`${rel(f)}: ${n} sleeps, ledger ${held} (lower it)`);
    }
    for (const k of Object.keys(ledger.files))
      if (!seen.has(k))
        stale.push(`${k}: no longer a test file with sleeps (remove it)`);
    expect({ over, stale }).toEqual({ over: [], stale: [] });
  });
});
