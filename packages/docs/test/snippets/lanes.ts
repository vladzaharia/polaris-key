/**
 * The compile lanes: a TypeScript lane (Node and React, against the built workspace packages) and a
 * Python lane (the SDK's own venv: ast at the 3.9 floor, then mypy against `polaris_key`).
 *
 * A block is compiled as its own module next to the real `pkey sdk` output, so a page's
 * `./polaris.config` import resolves exactly as it does for a reader.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { REPO, type Snippet } from "./extract";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_PKG = join(HERE, "../..");

export type Lane = "node" | "react" | "python";

export interface Failure {
  snippet: Snippet;
  /** Line within the source file the message points at. */
  line: number;
  message: string;
}

export function laneOf(s: Snippet): Lane {
  if (s.lang === "python") return "python";
  return /from\s+["']@polaris-key\/react|import\s+["']@polaris-key\/react/.test(
    s.code,
  ) || s.lang === "tsx"
    ? "react"
    : "node";
}

// ── TypeScript ─────────────────────────────────────────────────────────────────────────────────

const SAMPLES: Record<"node" | "react", string> = {
  node: join(REPO, "conformance/runners/node/sdkConfigSample.ts"),
  react: join(REPO, "packages/sdk-react/test/sdkConfigSample.ts"),
};

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  // NestJS blocks use decorators, which every Nest project enables.
  experimentalDecorators: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: true,
  checkJs: true,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: ["node"],
  typeRoots: [join(DOCS_PKG, "node_modules/@types")],
  esModuleInterop: true,
  resolveJsonModule: true,
  // The workspace packages a page may import that the docs package does not depend on: the
  // wire types and the isomorphic core, against their built declarations.
  paths: {
    "@polaris-key/client-core": [
      join(REPO, "packages/client-core/dist/index.d.ts"),
    ],
    "@polaris-key/client-core/*": [
      join(REPO, "packages/client-core/dist/*.d.ts"),
    ],
    "@polaris-key/protocol": [
      join(REPO, "packages/shared-protocol/dist/index.d.ts"),
    ],
    "@polaris-key/protocol/*": [
      join(REPO, "packages/shared-protocol/dist/*.d.ts"),
    ],
  },
};

/** The virtual path of a block: its own module inside the lane's directory. */
function virtualPath(
  index: number,
  s: Snippet,
  lane: "node" | "react",
): string {
  const ext = s.lang === "js" ? "mjs" : lane === "react" ? "tsx" : "ts";
  return join(
    DOCS_PKG,
    ".snippets",
    lane,
    `block-${String(index).padStart(4, "0")}.${ext}`,
  );
}

/** Parsed real files (libs, declarations), kept for the life of the process: they never change
 *  while the suite runs, and parsing them is most of a program's cost. */
const sourceFiles = new Map<string, ts.SourceFile | undefined>();

function cachedHost(): ts.CompilerHost {
  const host = ts.createCompilerHost(OPTIONS);
  const real = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const key = `${resolve(f)}|${typeof lang === "object" ? lang.languageVersion : lang}`;
    if (!sourceFiles.has(key))
      sourceFiles.set(key, real(f, lang, onError, shouldCreate));
    return sourceFiles.get(key);
  };
  return host;
}

/** A failure of the harness itself (a broken sample, a lane that did not run), not of a page. */
export const harnessFailure = (
  message: string,
  lang: Snippet["lang"] = "ts",
): Failure => ({
  snippet: {
    file: "(harness)",
    line: 0,
    lang,
    meta: "",
    optOut: false,
    code: "",
  },
  line: 0,
  message,
});

/**
 * Compile several named groups of blocks in ONE program: each block is its own module, so the
 * groups (the covered pages, the advisory sources, a deliberately broken control) cannot see one
 * another, and the failures come back partitioned by group.
 */
export function compileTsGroups<K extends string>(
  groups: Record<K, Snippet[]>,
): Record<K, Failure[]> {
  const files = new Map<string, string>();
  const owner = new Map<string, { snippet: Snippet; group: K }>();
  const ambient = join(DOCS_PKG, ".snippets", "ambient.d.ts");
  files.set(ambient, readFileSync(join(HERE, "ambient.d.ts"), "utf8"));
  for (const lane of ["node", "react"] as const)
    files.set(
      join(DOCS_PKG, ".snippets", lane, "polaris.config.ts"),
      readFileSync(SAMPLES[lane], "utf8"),
    );
  let index = 0;
  for (const group of Object.keys(groups) as K[])
    for (const s of groups[group]) {
      const lane = laneOf(s) === "react" ? "react" : "node";
      const path = virtualPath(index++, s, lane);
      // A block with no import or export is a script; make it a module so top-level await and its
      // own `const client` stay local.
      const code = /^\s*(import|export)\s/m.test(s.code)
        ? s.code
        : `export {};\n${s.code}`;
      files.set(path, code);
      owner.set(path, { snippet: s, group });
    }

  const host = cachedHost();
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realDirectoryExists = host.directoryExists?.bind(host);
  const virtualRoot = join(DOCS_PKG, ".snippets");
  host.directoryExists = (d) =>
    resolve(d).startsWith(virtualRoot) || (realDirectoryExists?.(d) ?? true);
  host.fileExists = (f) => files.has(resolve(f)) || realFileExists(f);
  host.readFile = (f) => files.get(resolve(f)) ?? realReadFile(f);
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const text = files.get(resolve(f));
    return text === undefined
      ? realGetSourceFile(f, lang, onError, shouldCreate)
      : ts.createSourceFile(f, text, lang, true);
  };

  const program = ts.createProgram({
    rootNames: [ambient, ...owner.keys()],
    options: OPTIONS,
    host,
  });
  const out = {} as Record<K, Failure[]>;
  for (const group of Object.keys(groups) as K[]) out[group] = [];
  const harness: Failure[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file?.fileName;
    const own = file ? owner.get(resolve(file)) : undefined;
    if (!own || !d.file || d.start === undefined) {
      // A diagnostic in the harness itself (ambient.d.ts, a sample) is the harness's, not a page's.
      if (file && file.includes(".snippets"))
        harness.push(
          harnessFailure(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
        );
      continue;
    }
    const s = own.snippet;
    const prefixed = !/^\s*(import|export)\s/m.test(s.code);
    const at =
      d.file.getLineAndCharacterOfPosition(d.start).line +
      1 -
      (prefixed ? 1 : 0);
    out[own.group].push({
      snippet: s,
      line: s.line + Math.max(at, 1) - 1,
      message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    });
  }
  // The harness is every group's: a broken sample fails whichever group asks.
  for (const group of Object.keys(groups) as K[]) out[group].push(...harness);
  return out;
}

export function compileTs(snippets: Snippet[]): Failure[] {
  return compileTsGroups({ all: snippets }).all;
}

/**
 * The lazy, per-process form of {@link compileTsGroups}: declare every group up front, and the
 * first `get` compiles them all in one program (the positive blocks, the advisory ones and the
 * negative control share it).
 */
export function sharedTs<K extends string>(groups: Record<K, Snippet[]>) {
  let done: Record<K, Failure[]> | undefined;
  return (group: K): Failure[] => (done ??= compileTsGroups(groups))[group];
}

let tsExportsMemo: Set<string> | undefined;

/** Every export of the SDK entry points, by name (computed once per process). */
export function tsExports(): Set<string> {
  return (tsExportsMemo ??= computeTsExports());
}

function computeTsExports(): Set<string> {
  const pkgs = ["node", "react"] as const;
  const entries: string[] = [];
  for (const p of pkgs) {
    const dir = p === "node" ? "packages/sdk-node" : "packages/sdk-react";
    const manifest = JSON.parse(
      readFileSync(join(REPO, dir, "package.json"), "utf8"),
    ) as {
      name: string;
      exports: Record<string, unknown>;
    };
    for (const sub of Object.keys(manifest.exports))
      if (!sub.includes("*") && !sub.endsWith(".json"))
        entries.push(
          sub === "." ? manifest.name : `${manifest.name}/${sub.slice(2)}`,
        );
  }
  const probe = join(DOCS_PKG, ".snippets", "exports.ts");
  const source = entries
    .map((e, i) => `import * as m${i} from "${e}"; void m${i};`)
    .join("\n");
  const host = cachedHost();
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  host.fileExists = (f) => resolve(f) === probe || realFileExists(f);
  host.readFile = (f) => (resolve(f) === probe ? source : realReadFile(f));
  host.getSourceFile = (f, lang, onError, shouldCreate) =>
    resolve(f) === probe
      ? ts.createSourceFile(f, source, lang, true)
      : realGetSourceFile(f, lang, onError, shouldCreate);
  const program = ts.createProgram({
    rootNames: [probe],
    options: OPTIONS,
    host,
  });
  const checker = program.getTypeChecker();
  const names = new Set<string>();
  const sf = program.getSourceFile(probe);
  if (!sf) return names;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const sym = checker.getSymbolAtLocation(stmt.moduleSpecifier);
    if (!sym) continue;
    for (const e of checker.getExportsOfModule(sym)) names.add(e.getName());
  }
  return names;
}

// ── Python ─────────────────────────────────────────────────────────────────────────────────────

const PY_DIR = join(REPO, "sdks/python");

/** The interpreter of the Python lane: PKEY_DOCS_PYTHON, else the SDK's own venv. */
export function pythonBin(): string | null {
  const env = process.env.PKEY_DOCS_PYTHON;
  if (env) return env;
  const venv = join(PY_DIR, ".venv/bin/python");
  return existsSync(venv) ? venv : null;
}

/** mypy's incremental cache, persistent across runs and shared by every docs test file: the SDK
 *  and its dependencies are checked once, then only a changed block is rechecked. */
const MYPY_CACHE = join(DOCS_PKG, "node_modules/.cache/pkey-mypy");

/**
 * Check several named groups of Python blocks in ONE mypy run (each block is its own module, so
 * the groups cannot see one another), against the persistent cache. The failures come back
 * partitioned by group.
 */
export function compilePythonGroups<K extends string>(
  groups: Record<K, Snippet[]>,
  python: string,
): Record<K, Failure[]> {
  const dir = mkdtempSync(join(tmpdir(), "pkey-docs-py-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "polaris_config.py"),
      readFileSync(join(PY_DIR, "tests/sdk_config_sample.py")),
    );
    const prelude = readFileSync(join(HERE, "prelude.py"), "utf8");
    writeFileSync(join(dir, "docs_prelude.py"), prelude);
    const byName = new Map<string, { snippet: Snippet; group: K }>();
    let i = 0;
    for (const group of Object.keys(groups) as K[])
      for (const s of groups[group]) {
        const name = `snip_${String(i++).padStart(4, "0")}.py`;
        byName.set(name, { snippet: s, group });
        writeFileSync(
          join(dir, name),
          `from docs_prelude import *  # noqa\n${s.code}\n`,
        );
      }
    mkdirSync(MYPY_CACHE, { recursive: true });
    const run = spawnSync(python, [join(HERE, "pylane.py"), "check", dir], {
      encoding: "utf8",
      cwd: dir,
      timeout: 240_000,
      env: { ...process.env, PKEY_DOCS_MYPY_CACHE: MYPY_CACHE },
    });
    const out = {} as Record<K, Failure[]>;
    for (const group of Object.keys(groups) as K[]) out[group] = [];
    const text = `${run.stdout}${run.stderr}`;
    let any = false;
    for (const line of text.split("\n")) {
      const m = /^(snip_\d+\.py):(\d+):(?:\d+:)? error: (.*)$/.exec(line);
      if (!m) continue;
      const own = byName.get(m[1] ?? "");
      if (own) {
        any = true;
        out[own.group].push({
          snippet: own.snippet,
          line: own.snippet.line + Number(m[2]) - 2,
          message: m[3] ?? "",
        });
      }
    }
    if (run.status !== 0 || (!any && /Traceback|No module named/.test(text))) {
      const failure = harnessFailure(
        `the Python lane did not run: ${text.slice(0, 600)}`,
        "python",
      );
      for (const group of Object.keys(groups) as K[]) out[group].push(failure);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function compilePython(snippets: Snippet[], python: string): Failure[] {
  return compilePythonGroups({ all: snippets }, python).all;
}

/** The lazy, per-process form of {@link compilePythonGroups}; see {@link sharedTs}. */
export function sharedPython<K extends string>(
  groups: Record<K, Snippet[]>,
  python: string,
) {
  let done: Record<K, Failure[]> | undefined;
  return (group: K): Failure[] =>
    (done ??= compilePythonGroups(groups, python))[group];
}

const symbolsMemo = new Map<string, Set<string>>();

/** Every name the SDK exports, from `pylane.py symbols`. Computed once per process, and cached on
 *  disk keyed by the interpreter and a hash of the SDK's source, so the next test file (or run)
 *  with the same SDK reads it back instead of importing every module again. */
export function pythonSymbols(python: string): Set<string> {
  const hit = symbolsMemo.get(python);
  if (hit) return hit;
  const hash = createHash("sha1").update(python);
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) =>
      x.name < y.name ? -1 : 1,
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__pycache__") walk(p);
      } else if (e.name.endsWith(".py")) hash.update(p).update(readFileSync(p));
    }
  };
  walk(join(PY_DIR, "src"));
  hash.update(readFileSync(join(HERE, "pylane.py")));
  const cache = join(
    DOCS_PKG,
    "node_modules/.cache/pkey-docs",
    `py-symbols-${hash.digest("hex").slice(0, 16)}.json`,
  );
  let names: string[];
  if (existsSync(cache))
    names = JSON.parse(readFileSync(cache, "utf8")) as string[];
  else {
    const run = spawnSync(python, [join(HERE, "pylane.py"), "symbols"], {
      encoding: "utf8",
    });
    if (run.status !== 0)
      throw new Error(`pylane symbols failed: ${run.stderr}`);
    names = JSON.parse(run.stdout) as string[];
    mkdirSync(dirname(cache), { recursive: true });
    const tmp = `${cache}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(names));
    renameSync(tmp, cache);
  }
  const set = new Set(names);
  symbolsMemo.set(python, set);
  return set;
}

// ── Execution (blocks tagged `run`) ───────────────────────────────────────────────────────────

export interface RunResult {
  snippet: Snippet;
  ok: boolean;
  output: string;
}

/** Run a block tagged `run` against the real SDK: it must exit 0. */
export function runSnippet(s: Snippet, python: string | null): RunResult {
  if (s.lang === "python") {
    if (!python)
      return { snippet: s, ok: false, output: "no Python interpreter" };
    const dir = mkdtempSync(join(tmpdir(), "pkey-docs-run-"));
    try {
      writeFileSync(
        join(dir, "polaris_config.py"),
        readFileSync(join(PY_DIR, "tests/sdk_config_sample.py")),
      );
      writeFileSync(
        join(dir, "docs_prelude.py"),
        readFileSync(join(HERE, "prelude.py")),
      );
      writeFileSync(
        join(dir, "run_block.py"),
        `from docs_prelude import *  # noqa\n${s.code}\n`,
      );
      const r = spawnSync(
        python,
        [
          "-I",
          "-c",
          `import sys; sys.path.insert(0, ${JSON.stringify(dir)}); import runpy; runpy.run_path("run_block.py", run_name="__main__")`,
        ],
        { cwd: dir, encoding: "utf8", timeout: 120_000 },
      );
      return {
        snippet: s,
        ok: r.status === 0,
        output: `${r.stdout}${r.stderr}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = join(DOCS_PKG, ".snippets-run");
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `run-${process.pid}-${Math.random().toString(36).slice(2)}.${s.lang === "js" ? "mjs" : "mts"}`,
  );
  try {
    writeFileSync(file, s.code);
    const r = spawnSync(process.execPath, ["--import", "tsx", file], {
      cwd: DOCS_PKG,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { snippet: s, ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(file, { force: true });
  }
}
