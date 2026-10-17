/**
 * The layer table on `build/ui/frameworks/index.mdx` ("| Kit | Status | (a) Drop-in flow | (b) Styled parts |
 * (c) Headless |") mixes five languages in one table, so the snippet symbol check (one language per
 * covered page) cannot read it. This test checks it row by row: each row's kit maps to an SDK
 * language through `UI_KITS`, and every backticked name in cells (a) to (c) must be one that SDK
 * exports. A cell that says "Planned" or "coming in" is not held to that.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UI_KITS } from "../src/lib/uiKits";
import { pythonBin, pythonSymbols, tsExports } from "./snippets/lanes";
import {
  exportsOf,
  nativeMentions,
  type NativeLang,
} from "./snippets/nativeLanes";
import { IGNORED } from "./snippets/nativeIgnore";
import { mentions } from "./snippets/symbols";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "packages/docs/src/content/docs/build/ui/frameworks/index.mdx";
const source = readFileSync(
  join(
    docsRoot,
    "src",
    "content",
    "docs",
    "build",
    "ui",
    "frameworks",
    "index.mdx",
  ),
  "utf8",
);

type Lang = "ts" | "python" | NativeLang;

const LANG_OF_SDK: Record<(typeof UI_KITS)[number]["sdk"], Lang> = {
  "JS / TS": "ts",
  Node: "ts",
  Python: "python",
  Swift: "swift",
  Kotlin: "kotlin",
  Godot: "gdscript",
};

/** The exports of each language; `python` is null when the SDK's venv is missing. */
type Known = Record<Lang, Set<string> | null>;

const PLANNED = /planned|coming in/i;

/** The row's three claim cells (a), (b), (c), in order. */
const CLAIM_CELLS = [2, 3, 4] as const;

/**
 * Every plain identifier a backticked span names: `<Foo>`, `foo(args)`, `Foo.bar()`,
 * `.modifier(x)`, `await Foo.bar()`. Module paths (`a.b.c`), file names (`x.gd`) and directories
 * (`ui/model/`) are not symbols, so they yield nothing.
 */
function identifiers(raw: string): string[] {
  const span = raw
    .trim()
    .replace(/^await\s+/, "")
    .replace(/^<\/?([A-Za-z]\w*)[^>]*>$/s, "$1");
  const m = /^\.?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(\(|\{|\s|$)/.exec(span);
  if (!m) return [];
  const segments = (m[1] ?? "").split(".");
  const called = m[2] === "(";
  if (segments.length > 1 && !called && segments.every((s) => /^[a-z]/.test(s)))
    return [];
  return [segments[segments.length - 1] ?? ""];
}

/** The names a table cell claims, as the language's own symbol check reads them plus every plain
 *  identifier in a code span, so a short name (`stepRow`, `gate_view`) is held to the same rule. */
function claimed(
  cell: string,
  line: number,
  lang: Lang,
): { name: string; text: string }[] {
  // The TypeScript check reads a name, not a JSX tag.
  const prose = [
    { line, text: cell.replace(/`<([A-Za-z]\w*)[^`>]*>`/g, "`$1`") },
  ];
  const seen = new Map<string, string>();
  if (lang === "ts" || lang === "python")
    for (const x of mentions(prose, lang)) seen.set(x.name, x.text);
  else for (const x of nativeMentions(prose, lang)) seen.set(x.name, x.text);
  for (const m of cell.matchAll(/`([^`\n]+)`/g))
    for (const name of identifiers(m[1] ?? ""))
      if (!seen.has(name)) seen.set(name, (m[1] ?? "").trim());
  const ignored = lang === "ts" || lang === "python" ? null : IGNORED[lang];
  return [...seen]
    .filter(([name]) => !ignored?.has(name))
    .map(([name, text]) => ({ name, text }));
}

/** `file:line \`name\`` for each name the table claims that its row's SDK does not export. */
export function checkLayerTable(
  markdown: string,
  known: Known,
  file = PAGE,
): string[] {
  const problems: string[] = [];
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Kit\s*\|/.test(l));
  if (start < 0) return [`${file}: no "| Kit | Status | …" layer table found`];
  for (let i = start + 2; i < lines.length; i++) {
    const row = lines[i] ?? "";
    if (!row.startsWith("|")) break;
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const label = cells[0] ?? "";
    const kit = UI_KITS.find((k) => k.label === label);
    if (!kit) {
      problems.push(`${file}:${i + 1} \`${label}\` is not a UI_KITS label`);
      continue;
    }
    const lang = LANG_OF_SDK[kit.sdk];
    const exported = known[lang];
    if (!exported) continue;
    for (const c of CLAIM_CELLS) {
      const cell = cells[c] ?? "";
      if (PLANNED.test(cell)) continue;
      for (const { name, text } of claimed(cell, i + 1, lang))
        if (!exported.has(name))
          problems.push(`${file}:${i + 1} \`${text}\` (${label}: ${name})`);
    }
  }
  return problems;
}

const python = pythonBin();
const LONG = 240_000;
// A machine without the SDK's venv skips the Python rows loudly; CI always has it.
const pyIt = python ? it : process.env.CI ? it : it.skip;

describe("the layer table on build/ui/frameworks/index.mdx", () => {
  pyIt(
    "names only symbols its row's SDK exports, or labels them planned",
    () => {
      const known: Known = {
        ts: tsExports(),
        python: pythonSymbols(python ?? "python3"),
        swift: exportsOf("swift"),
        kotlin: exportsOf("kotlin"),
        gdscript: exportsOf("gdscript"),
      };
      expect(checkLayerTable(source, known)).toEqual([]);
    },
    LONG,
  );

  it("has a row for every kit it labels, with the rows' kits all in UI_KITS", () => {
    const labels = source
      .split("\n")
      .filter((l) => /^\|\s*(?!Kit\b|-)/.test(l))
      .map((l) => (l.split("|")[1] ?? "").trim())
      .filter((l) => UI_KITS.some((k) => k.label === l));
    expect(labels).toEqual(
      expect.arrayContaining([
        "React",
        "Terminal (Node)",
        "Terminal (Python)",
        "SwiftUI",
        "Compose",
        "Godot",
      ]),
    );
  });

  it("fails when a row names a symbol its SDK does not export", () => {
    const table = [
      "| Kit | Status | (a) Drop-in flow | (b) Styled parts | (c) Headless |",
      "| --- | --- | --- | --- | --- |",
      "| React | Ships today | `<NoSuchReactGate>` | `NoSuchReactPart` | `useNoSuchHook()` |",
      "| Terminal (Node) | Ships today | `registerNoSuchCommands(program)` | `noSuchHeader` | `NoSuchCopy` |",
      "| Terminal (Python) | Ships today | `register_no_such(subparsers)` | `NoSuchScreen` | `no_such_view` |",
      "| SwiftUI | Ships today | `.polarisKeyNoSuch(client)` | `NoSuchView` | `NoSuchModel` |",
      "| Compose | Ships today | `NoSuchApp(client) { }` | `PolarisNoSuchGate` | `rememberNoSuch` |",
      "| Godot | Ships today | `await PolarisKey.no_such_boot()` | `PKeyNoSuchView` | `PKeyNoSuchController`; `no_such_view()` |",
      "| Qt | Planned | Planned: `NoSuchQtGate` | Planned: `NoSuchQtPart` | Planned: `NoSuchQtModel` |",
      "",
    ].join("\n");
    const empty: Known = {
      ts: new Set(),
      python: new Set(),
      swift: new Set(),
      kotlin: new Set(),
      gdscript: new Set(),
    };
    const problems = checkLayerTable(table, empty, "fake.mdx").join("\n");
    for (const name of [
      "NoSuchReactGate",
      "NoSuchReactPart",
      "useNoSuchHook",
      "registerNoSuchCommands",
      "noSuchHeader",
      "NoSuchCopy",
      "register_no_such",
      "NoSuchScreen",
      "no_such_view",
      "polarisKeyNoSuch",
      "NoSuchView",
      "NoSuchModel",
      "NoSuchApp",
      "PolarisNoSuchGate",
      "rememberNoSuch",
      "no_such_boot",
      "PKeyNoSuchView",
      "PKeyNoSuchController",
    ])
      expect(problems, name).toContain(`: ${name})`);
    // Planned cells are not held to the SDK's exports.
    expect(problems).not.toMatch(/NoSuchQt/);
    // A name each SDK does export passes.
    const real: Known = {
      ts: new Set(["PolarisKeyProvider"]),
      python: new Set(),
      swift: new Set(),
      kotlin: new Set(),
      gdscript: new Set(),
    };
    expect(
      checkLayerTable(
        "| Kit | S | (a) | (b) | (c) |\n| - | - | - | - | - |\n| React | Ships today | `<PolarisKeyProvider>` | | |\n",
        real,
        "fake.mdx",
      ),
    ).toEqual([]);
  });
});
