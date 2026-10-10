/**
 * The docs snippet gate (SP-45a): every fenced block on a covered page compiles in its SDK lane,
 * a page that names an export the SDK lacks fails, and a deliberately broken page proves both fail.
 * Sources outside `COVERED_PAGES` are held to a baseline that may only shrink.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { COVERED_PAGES, coveredLanguage } from "./covered";
import {
  allSnippets,
  extractFences,
  proseOf,
  REPO,
  type Snippet,
} from "./extract";
import {
  compilePython,
  compileTs,
  laneOf,
  pythonBin,
  pythonSymbols,
  tsExports,
  type Failure,
} from "./lanes";
import { mentions } from "./symbols";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "advisory-baseline.json");
const python = pythonBin();
// A machine without the SDK's venv skips the Python lane loudly; CI always has it.
const LONG = 240_000;
const pyIt = python ? it : process.env.CI ? it : it.skip;
if (!python)
  console.warn(
    "Python lane skipped: no sdks/python/.venv (python3 -m venv sdks/python/.venv && sdks/python/.venv/bin/pip install -e 'sdks/python[dev]')",
  );

const idOf = (s: Snippet): string =>
  `${s.file}::${createHash("sha1").update(s.code).digest("hex").slice(0, 10)}`;
const show = (fs: Failure[]): string[] =>
  fs.map((f) => `${f.snippet.file}:${f.line} ${f.message}`);
const isTs = (s: Snippet): boolean => s.lang !== "python";

const snippets = allSnippets();
const covered = snippets.filter((s) => coveredLanguage(s.file) !== null);
const advisory = snippets.filter(
  (s) => coveredLanguage(s.file) === null && !s.optOut,
);

describe("the extractor", () => {
  it("reads fences by language and honours the opt-out marker", () => {
    const found = extractFences(
      "x.md",
      "```ts\nlet a = 1;\n```\n\n- item\n\n  ```python\n  x = 1\n  ```\n\n```ts no-compile\n???\n```\n\n```sh\nls\n```\n",
    );
    expect(found.map((s) => [s.lang, s.optOut])).toEqual([
      ["ts", false],
      ["python", false],
      ["ts", true],
    ]);
    expect(found[1]?.code).toBe("x = 1");
  });

  it("classifies a block by the SDK it imports", () => {
    const [react, node] = extractFences(
      "x.md",
      '```tsx\nimport { LicenseGate } from "@polaris-key/react/license";\n```\n\n```ts\nimport { PolarisKeyClient } from "@polaris-key/node";\n```\n',
    );
    expect([react, node].map((s) => s && laneOf(s))).toEqual(["react", "node"]);
  });
});

describe("a deliberately broken page", () => {
  const source = readFileSync(join(HERE, "fixtures/broken.md"), "utf8");
  const blocks = extractFences("broken.md", source);

  it(
    "fails the TypeScript lane",
    () => {
      const failures = compileTs(
        blocks.filter((s) => s.lang === "ts" && !s.optOut),
      );
      expect(show(failures).join("\n")).toMatch(/noSuchMethod/);
      expect(blocks.some((s) => s.optOut)).toBe(true);
    },
    LONG,
  );

  pyIt(
    "fails the Python lane",
    () => {
      const failures = compilePython(
        blocks.filter((s) => s.lang === "python"),
        python ?? "python3",
      );
      expect(show(failures).join("\n")).toMatch(/no_such_method/);
    },
    LONG,
  );

  it(
    "fails the symbol check",
    () => {
      const named = mentions(proseOf(source), "ts").map((m) => m.name);
      expect(named).toContain("NotAnExportAtAll");
      expect(tsExports().has("NotAnExportAtAll")).toBe(false);
      expect(tsExports().has("PolarisKeyClient")).toBe(true);
    },
    LONG,
  );
});

describe("covered pages", () => {
  it("name at least one page, and use no opt-out", () => {
    expect(COVERED_PAGES.length).toBeGreaterThan(0);
    expect(
      covered.filter((s) => s.optOut).map((s) => `${s.file}:${s.line}`),
    ).toEqual([]);
  });

  it(
    "compile in the TypeScript lane",
    () => {
      const failures = compileTs(covered.filter(isTs));
      expect(show(failures)).toEqual([]);
    },
    LONG,
  );

  pyIt(
    "compile in the Python lane",
    () => {
      const failures = compilePython(
        covered.filter((s) => !isTs(s)),
        python ?? "python3",
      );
      expect(show(failures)).toEqual([]);
    },
    LONG,
  );

  it(
    "name only symbols the SDK exports, or label them planned",
    () => {
      const exportsTs = tsExports();
      const exportsPy = python ? pythonSymbols(python) : null;
      const missing: string[] = [];
      for (const c of COVERED_PAGES) {
        const files = c.path.endsWith("/")
          ? [...new Set(snippets.map((s) => s.file))].filter((f) =>
              f.startsWith(c.path),
            )
          : [c.path];
        for (const file of files) {
          const known = c.language === "ts" ? exportsTs : exportsPy;
          if (!known) continue;
          const prose = proseOf(readFileSync(join(REPO, file), "utf8"));
          for (const m of mentions(prose, c.language))
            if (!known.has(m.name))
              missing.push(`${file}:${m.line} \`${m.text}\``);
        }
      }
      expect(missing).toEqual([]);
    },
    LONG,
  );
});

describe("other sources (advisory)", () => {
  let failing: string[] = [];
  beforeAll(() => {
    const ts = compileTs(advisory.filter(isTs));
    const py = python
      ? compilePython(
          advisory.filter((s) => !isTs(s)),
          python,
        )
      : [];
    failing = [...new Set([...ts, ...py].map((f) => idOf(f.snippet)))].sort();
  }, 300_000);

  it("fail no block that is not in the baseline", () => {
    if (process.env.UPDATE_SNIPPET_BASELINE) {
      writeFileSync(BASELINE, `${JSON.stringify(failing, null, 2)}\n`);
      return;
    }
    const known = new Set(
      JSON.parse(readFileSync(BASELINE, "utf8")) as string[],
    );
    expect(failing.filter((id) => !known.has(id))).toEqual([]);
  });
});
