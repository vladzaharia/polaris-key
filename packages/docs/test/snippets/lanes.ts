/**
 * The compile lanes: a TypeScript lane (Node and React, against the built workspace packages) and a
 * Python lane (the SDK's own venv: ast at the 3.9 floor, then mypy against `polaris_key`).
 *
 * A block is compiled as its own module next to the real `pkey sdk` output, so a page's
 * `./polaris.config` import resolves exactly as it does for a reader.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  noEmit: true,
  skipLibCheck: true,
  allowJs: true,
  checkJs: true,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: ["node"],
  typeRoots: [join(DOCS_PKG, "node_modules/@types")],
  esModuleInterop: true,
  resolveJsonModule: true,
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

export function compileTs(snippets: Snippet[]): Failure[] {
  const files = new Map<string, string>();
  const owner = new Map<string, Snippet>();
  const ambient = join(DOCS_PKG, ".snippets", "ambient.d.ts");
  files.set(ambient, readFileSync(join(HERE, "ambient.d.ts"), "utf8"));
  for (const lane of ["node", "react"] as const)
    files.set(
      join(DOCS_PKG, ".snippets", lane, "polaris.config.ts"),
      readFileSync(SAMPLES[lane], "utf8"),
    );
  snippets.forEach((s, i) => {
    const lane = laneOf(s) === "react" ? "react" : "node";
    const path = virtualPath(i, s, lane);
    // A block with no import or export is a script; make it a module so top-level await and its
    // own `const client` stay local.
    const code = /^\s*(import|export)\s/m.test(s.code)
      ? s.code
      : `export {};\n${s.code}`;
    files.set(path, code);
    owner.set(path, s);
  });

  const host = ts.createCompilerHost(OPTIONS);
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
  const failures: Failure[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file?.fileName;
    const s = file ? owner.get(resolve(file)) : undefined;
    if (!s || !d.file || d.start === undefined) {
      // A diagnostic in the harness itself (ambient.d.ts, a sample) is the harness's, not a page's.
      if (file && file.includes(".snippets"))
        failures.push({
          snippet: {
            file: "(harness)",
            line: 0,
            lang: "ts",
            meta: "",
            optOut: false,
            code: "",
          },
          line: 0,
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        });
      continue;
    }
    const prefixed = !/^\s*(import|export)\s/m.test(s.code);
    const at =
      d.file.getLineAndCharacterOfPosition(d.start).line +
      1 -
      (prefixed ? 1 : 0);
    failures.push({
      snippet: s,
      line: s.line + Math.max(at, 1) - 1,
      message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    });
  }
  return failures;
}

/** Every export of the SDK entry points, by name. */
export function tsExports(): Set<string> {
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
  const host = ts.createCompilerHost(OPTIONS);
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

export function compilePython(snippets: Snippet[], python: string): Failure[] {
  const dir = mkdtempSync(join(tmpdir(), "pkey-docs-py-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "polaris_config.py"),
      readFileSync(join(PY_DIR, "tests/sdk_config_sample.py")),
    );
    const prelude = readFileSync(join(HERE, "prelude.py"), "utf8");
    writeFileSync(join(dir, "docs_prelude.py"), prelude);
    const byName = new Map<string, Snippet>();
    snippets.forEach((s, i) => {
      const name = `snip_${String(i).padStart(4, "0")}.py`;
      byName.set(name, s);
      writeFileSync(
        join(dir, name),
        `from docs_prelude import *  # noqa\n${s.code}\n`,
      );
    });
    const run = spawnSync(python, [join(HERE, "pylane.py"), "check", dir], {
      encoding: "utf8",
      cwd: dir,
      timeout: 240_000,
    });
    const failures: Failure[] = [];
    const out = `${run.stdout}${run.stderr}`;
    for (const line of out.split("\n")) {
      const m = /^(snip_\d+\.py):(\d+):(?:\d+:)? error: (.*)$/.exec(line);
      if (!m) continue;
      const s = byName.get(m[1] ?? "");
      if (s)
        failures.push({
          snippet: s,
          line: s.line + Number(m[2]) - 2,
          message: m[3] ?? "",
        });
    }
    if (
      run.status !== 0 ||
      (failures.length === 0 && /Traceback|No module named/.test(out))
    )
      failures.push({
        snippet: {
          file: "(harness)",
          line: 0,
          lang: "python",
          meta: "",
          optOut: false,
          code: "",
        },
        line: 0,
        message: `the Python lane did not run: ${out.slice(0, 600)}`,
      });
    return failures;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function pythonSymbols(python: string): Set<string> {
  const run = spawnSync(python, [join(HERE, "pylane.py"), "symbols"], {
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`pylane symbols failed: ${run.stderr}`);
  return new Set(JSON.parse(run.stdout) as string[]);
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
    if (!python) return { snippet: s, ok: false, output: "no Python interpreter" };
    const dir = mkdtempSync(join(tmpdir(), "pkey-docs-run-"));
    try {
      writeFileSync(join(dir, "polaris_config.py"), readFileSync(join(PY_DIR, "tests/sdk_config_sample.py")));
      writeFileSync(join(dir, "docs_prelude.py"), readFileSync(join(HERE, "prelude.py")));
      writeFileSync(join(dir, "run_block.py"), `from docs_prelude import *  # noqa\n${s.code}\n`);
      const r = spawnSync(python, ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(dir)}); import runpy; runpy.run_path("run_block.py", run_name="__main__")`], { cwd: dir, encoding: "utf8", timeout: 120_000 });
      return { snippet: s, ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = join(DOCS_PKG, ".snippets-run");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${process.pid}-${Math.random().toString(36).slice(2)}.${s.lang === "js" ? "mjs" : "mts"}`);
  try {
    writeFileSync(file, s.code);
    const r = spawnSync(process.execPath, ["--import", "tsx", file], { cwd: DOCS_PKG, encoding: "utf8", timeout: 120_000 });
    return { snippet: s, ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(file, { force: true });
  }
}
