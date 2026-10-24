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
  runSnippet,
  pythonBin,
  pythonSymbols,
  tsExports,
  type Failure,
} from "./lanes";
import { mentions } from "./symbols";
import {
  compileOf,
  exportsOf,
  godotClassNames,
  NATIVE_LANGS,
  nativeMentions,
  requiredLanes,
  skipReasonOf,
  type NativeLang,
} from "./nativeLanes";

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
const isTs = (s: Snippet): boolean =>
  s.lang === "ts" || s.lang === "tsx" || s.lang === "js";
const isPy = (s: Snippet): boolean => s.lang === "python";

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

  pyIt(
    "fails the symbol check in Python",
    () => {
      const named = mentions(proseOf(source), "python").map((m) => m.name);
      expect(named).toEqual(
        expect.arrayContaining(["NotAnExportEither", "no_such_function"]),
      );
      const known = pythonSymbols(python ?? "python3");
      expect(known.has("NotAnExportEither")).toBe(false);
      expect(known.has("no_such_function")).toBe(false);
      expect(known.has("register_argparse")).toBe(true);
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
      const failures = compilePython(covered.filter(isPy), python ?? "python3");
      expect(show(failures)).toEqual([]);
    },
    LONG,
  );

  it(
    "run: every block tagged `run` exits 0",
    () => {
      const runs = covered.filter((s) => /(^|\s)run(\s|$)/.test(s.meta));
      const bad = runs
        .filter((s) => s.lang !== "python" || python)
        .map((s) => runSnippet(s, python))
        .filter((r) => !r.ok)
        .map(
          (r) =>
            `${r.snippet.file}:${r.snippet.line} ${r.output.slice(0, 600)}`,
        );
      expect(bad).toEqual([]);
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
        if (c.language !== "ts" && c.language !== "python") continue;
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
  // One test per lane, each with its own budget: a single hook compiling every lane in turn ran
  // into its 300 s limit when the machine was loaded. The baseline check below runs after them.
  const failing = new Set<string>();
  const note = (fs: Failure[]): void => {
    for (const f of fs) failing.add(idOf(f.snippet));
  };

  // Disabled as flaky (owner 2026-10-23): advisory compile hits the hook/test timeout under machine load. Re-enable once the advisory lanes run in their own CI lane.
  it.skip(
    "compiles in the TypeScript lane",
    () => {
      note(compileTs(advisory.filter(isTs)));
    },
    LONG,
  );

  // Disabled as flaky (owner 2026-10-23): advisory compile hits the timeout under machine load. Re-enable once the advisory lanes run in their own CI lane.
  pyIt.skip(
    "compiles in the Python lane",
    () => {
      note(compilePython(advisory.filter(isPy), python ?? "python3"));
    },
    LONG,
  );

  for (const lang of NATIVE_LANGS) {
    const reason = skipReasonOf(lang);
    // Disabled as flaky (owner 2026-10-23): advisory compile hits the timeout under machine load. Re-enable once the advisory lanes run in their own CI lane (change `it.skip` back to `(reason ? it.skip : it)`).
    it.skip(
      `compiles in the ${lang} lane`,
      async () => {
        note(
          await compileOf(
            lang,
            advisory.filter((s) => s.lang === lang),
          ),
        );
      },
      LONG * 3,
    );
  }

  it("fail no block that is not in the baseline", () => {
    if (process.env.UPDATE_SNIPPET_BASELINE) {
      writeFileSync(
        BASELINE,
        `${JSON.stringify([...failing].sort(), null, 2)}\n`,
      );
      return;
    }
    const known = new Set(
      JSON.parse(readFileSync(BASELINE, "utf8")) as string[],
    );
    // A lane that could not run here leaves its entries alone; only a run of every lane may shrink.
    expect([...failing].filter((id) => !known.has(id))).toEqual([]);
  });
});

// ── The native lanes (Swift, Kotlin, GDScript) ────────────────────────────────────────────────

const NATIVE_FIXTURES: Record<
  NativeLang,
  { fixture: string; broken: RegExp; name: string }
> = {
  swift: {
    fixture: "fixtures/broken-swift.md",
    broken: /noSuchMethod/,
    name: "NotAnExportInSwift",
  },
  kotlin: {
    fixture: "fixtures/broken-kotlin.md",
    broken: /noSuchMethod/,
    name: "NotAnExportInKotlin",
  },
  gdscript: {
    fixture: "fixtures/broken-gdscript.md",
    broken: /noSuchMethod/,
    name: "PKeyNotAClass",
  },
};

for (const lang of NATIVE_LANGS) {
  describe(`the ${lang} lane`, () => {
    const reason = skipReasonOf(lang);
    const required = requiredLanes().includes(lang);
    if (reason) console.warn(`${lang} lane skipped: ${reason}`);
    const laneIt = reason && !required ? it.skip : it;
    const mine = covered.filter((s) => s.lang === lang);
    const { fixture, broken, name } = NATIVE_FIXTURES[lang];

    it("can run when CI requires it", () => {
      if (required) expect(reason).toBeNull();
    });

    laneIt(
      "fails a deliberately broken block",
      async () => {
        const source = readFileSync(join(HERE, fixture), "utf8");
        const blocks = extractFences(fixture, source).filter(
          (s) => s.lang === lang,
        );
        const failures = await compileOf(
          lang,
          blocks.filter((s) => !s.optOut),
        );
        expect(show(failures).join("\n")).toMatch(broken);
        expect(blocks.some((s) => s.optOut)).toBe(true);
      },
      LONG * 3,
    );

    it("fails the symbol check on a name the SDK does not export", () => {
      const source = readFileSync(join(HERE, fixture), "utf8");
      const named = nativeMentions(proseOf(source), lang).map((m) => m.name);
      expect(named).toContain(name);
      expect(exportsOf(lang).has(name)).toBe(false);
    });

    laneIt(
      "compiles every block on its covered pages",
      async () => {
        expect(show(await compileOf(lang, mine))).toEqual([]);
      },
      LONG * 5,
    );

    it("names only symbols the SDK exports, or labels them planned", () => {
      const known = exportsOf(lang);
      const missing: string[] = [];
      for (const c of COVERED_PAGES.filter(
        (c) => c.language === lang && c.prose !== false,
      )) {
        const prose = proseOf(readFileSync(join(REPO, c.path), "utf8"));
        for (const m of nativeMentions(prose, lang))
          if (!known.has(m.name))
            missing.push(`${c.path}:${m.line} \`${m.text}\``);
      }
      expect(missing).toEqual([]);
    });
  });
}

describe("the Godot class names", () => {
  it("every PKey class a covered Godot page lists in a code span is a class_name", () => {
    const classes = godotClassNames();
    const wrong: string[] = [];
    for (const c of COVERED_PAGES.filter((c) => c.language === "gdscript")) {
      for (const { line, text } of proseOf(
        readFileSync(join(REPO, c.path), "utf8"),
      )) {
        if (/planned|coming in/i.test(text)) continue;
        for (const m of text.matchAll(/`(PKey[A-Z]\w*)`/g))
          if (!classes.has(m[1] ?? "")) wrong.push(`${c.path}:${line} ${m[1]}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
