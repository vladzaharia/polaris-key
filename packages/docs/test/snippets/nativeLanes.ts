/**
 * The native compile lanes (SP-45b): Swift, Kotlin and GDScript blocks, each compiled against the
 * real SDK next to the real `pkey sdk` output (the generated config samples the drift gate keeps
 * current), exactly as a reader's project would.
 *
 * - Swift: `swift build` of `sdks/swift`, then one `swiftc -typecheck` per block (a block is a
 *   `main.swift`, so it may have top-level code and `await`; a block with `@main` is a library file).
 * - Kotlin: blocks are written to the `:docs-snippets` Gradle module (JVM) or, with `android` in the
 *   info string, to `:docs-snippets-android`; one `compileKotlin` reports every block.
 * - GDScript: a throwaway Godot project with the addon linked in and the `unsafe_*` warnings raised
 *   to errors (an unknown method on a typed value is a warning by default); one headless run loads
 *   every block.
 *
 * A lane whose toolchain is missing reports why (`skipReason`); CI lists the lanes it requires in
 * `PKEY_DOCS_LANES`, and a required lane that cannot run fails.
 */

import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, type Snippet, type SnippetLang } from "./extract";
import type { Failure } from "./lanes";
import { IGNORED } from "./nativeIgnore";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWIFT_DIR = join(REPO, "sdks/swift");
const KOTLIN_DIR = join(REPO, "sdks/kotlin");
const GODOT_DIR = join(REPO, "sdks/godot");

export type NativeLang = "swift" | "kotlin" | "gdscript";
export const NATIVE_LANGS: NativeLang[] = ["swift", "kotlin", "gdscript"];

export const isNative = (lang: SnippetLang): lang is NativeLang =>
  (NATIVE_LANGS as string[]).includes(lang);

/** The lanes this run must be able to execute: `PKEY_DOCS_LANES=swift,kotlin,gdscript`. */
export function requiredLanes(): NativeLang[] {
  return (process.env.PKEY_DOCS_LANES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is NativeLang => (NATIVE_LANGS as string[]).includes(s));
}

const harnessFailure = (message: string): Failure => ({
  snippet: {
    file: "(harness)",
    line: 0,
    lang: "ts",
    meta: "",
    optOut: false,
    code: "",
  },
  line: 0,
  message,
});

interface Run {
  code: number;
  out: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeout ?? 600_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code ?? 1)
            : err
              ? 1
              : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

async function pool<T, R>(
  items: T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, () =>
    (async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T, i);
      }
    })(),
  );
  await Promise.all(workers);
  return out;
}

// ── Swift ──────────────────────────────────────────────────────────────────────────────────────

const SWIFT_SAMPLE = join(
  SWIFT_DIR,
  "Tests/PolarisKeyTests/SdkConfigSample.swift",
);

/** Names a docs Swift block may use without declaring them. */
const SWIFT_PLACEHOLDERS = `import Foundation
let userEnteredKey = ""
`;

export function swiftSkipReason(): string | null {
  if (process.platform !== "darwin") return "Swift lane needs macOS";
  const v = spawnSync("swift", ["--version"], { encoding: "utf8" });
  return v.status === 0 ? null : "no swift toolchain on PATH";
}

export async function compileSwift(snippets: Snippet[]): Promise<Failure[]> {
  if (snippets.length === 0) return [];
  const build = await run("swift", ["build"], { cwd: SWIFT_DIR });
  if (build.code !== 0)
    return [harnessFailure(`swift build failed: ${build.out.slice(-800)}`)];
  const bin = (
    await run("swift", ["build", "--show-bin-path"], { cwd: SWIFT_DIR })
  ).out.trim();
  const zstd = join(SWIFT_DIR, ".build/checkouts/zstd/lib");
  const dir = mkdtempSync(join(tmpdir(), "pkey-docs-swift-"));
  try {
    writeFileSync(join(dir, "Config.swift"), readFileSync(SWIFT_SAMPLE));
    writeFileSync(join(dir, "Placeholders.swift"), SWIFT_PLACEHOLDERS);
    const results = await pool(snippets, 4, async (s, i) => {
      const d = join(dir, `b${i}`);
      mkdirSync(d);
      const lib = /^\s*@main\b/m.test(s.code);
      const file = join(d, lib ? "Block.swift" : "main.swift");
      writeFileSync(file, s.code);
      const r = await run(
        "swiftc",
        [
          "-typecheck",
          "-swift-version",
          "6",
          ...(lib ? ["-parse-as-library"] : []),
          "-I",
          bin,
          "-F",
          bin,
          "-Xcc",
          `-fmodule-map-file=${join(zstd, "module.modulemap")}`,
          "-I",
          zstd,
          file,
          join(dir, "Config.swift"),
          join(dir, "Placeholders.swift"),
        ],
        { cwd: d, timeout: 240_000 },
      );
      const found: Failure[] = [];
      for (const line of r.out.split("\n")) {
        const m = /(?:main|Block)\.swift:(\d+):\d+: error: (.*)$/.exec(line);
        if (m)
          found.push({
            snippet: s,
            line: s.line + Number(m[1]) - 1,
            message: m[2] ?? "",
          });
      }
      if (r.code !== 0 && found.length === 0)
        found.push({
          snippet: s,
          line: s.line,
          message: `swiftc failed: ${r.out.slice(0, 500)}`,
        });
      return found;
    });
    return results.flat();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Kotlin ─────────────────────────────────────────────────────────────────────────────────────

const KOTLIN_SAMPLE = join(
  KOTLIN_DIR,
  "sdk/src/test/kotlin/polaris/generated/PolarisConfig.kt",
);
const JDK = "temurin-17.0.20+8";

function androidSdk(): boolean {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (home && existsSync(home)) return true;
  return existsSync(join(KOTLIN_DIR, "local.properties"));
}

function androidHome(): string | null {
  const env = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (env && existsSync(env)) return env;
  const guess = join(homedir(), "Library/Android/sdk");
  return existsSync(guess) ? guess : null;
}

export function kotlinSkipReason(): string | null {
  if (process.env.JAVA_HOME || spawnSync("java", ["-version"]).status === 0)
    return null;
  return spawnSync("mise", ["exec", `java@${JDK}`, "--", "java", "-version"])
    .status === 0
    ? null
    : "no JDK 17 (put one on PATH, or mise install java@temurin-17)";
}

/** Whether `android` blocks can compile here. */
export const kotlinAndroidAvailable = (): boolean =>
  androidSdk() || androidHome() !== null;

function gradleCommand(): { cmd: string; args: string[] } {
  const wrapper = join(KOTLIN_DIR, "gradlew");
  const javaOk =
    spawnSync("java", ["-version"], { encoding: "utf8" }).stderr.includes(
      '"17.',
    ) || process.env.JAVA_HOME?.includes("17");
  return javaOk
    ? { cmd: wrapper, args: [] }
    : { cmd: "mise", args: ["exec", `java@${JDK}`, "--", wrapper] };
}

/** A Kotlin block as a file: statements-only fragments are wrapped in a suspend function. */
export function kotlinFile(code: string, pkg: string): string {
  const lines = code.split("\n");
  const isHeader = (l: string): boolean => /^\s*(import|package)\s/.test(l);
  const hasDecl = lines.some((l) =>
    /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|suspend|inline|data|sealed|abstract|open|enum|override|const|lateinit)\s+)*(?:fun|class|object|interface|typealias|val|var)\s/.test(
      l,
    ),
  );
  const imports = lines.filter(isHeader).filter((l) => !/^\s*package\s/.test(l));
  const rest = lines.filter((l) => !isHeader(l));
  const body = hasDecl
    ? rest.join("\n")
    : `suspend fun docsBlock() {\n${rest.map((l) => `    ${l}`).join("\n")}\n}`;
  return `package ${pkg}\n\n${imports.join("\n")}\n\n${body}\n`;
}

async function gradleKotlin(
  snippets: Snippet[],
  module: string,
  task: string,
): Promise<Failure[]> {
  if (snippets.length === 0) return [];
  const root = join(KOTLIN_DIR, module, "build/snippets/src");
  rmSync(root, { recursive: true, force: true });
  const sample = readFileSync(KOTLIN_SAMPLE, "utf8").replace(
    /^package polaris\.generated$/m,
    "package com.acme.polaris",
  );
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/PolarisConfig.kt"), sample);
  const byFile = new Map<string, { s: Snippet; offset: number }>();
  snippets.forEach((s, i) => {
    const pkg = `docs.block${String(i).padStart(4, "0")}`;
    const text = kotlinFile(s.code, pkg);
    const d = join(root, `block${String(i).padStart(4, "0")}`);
    mkdirSync(d, { recursive: true });
    const path = join(d, "Block.kt");
    writeFileSync(path, text);
    // The block's lines keep their order; the header lines moved, so map by content below.
    byFile.set(path, { s, offset: 0 });
  });
  const g = gradleCommand();
  const env = { ...process.env };
  const home = androidHome();
  if (home && !env.ANDROID_HOME) env.ANDROID_HOME = home;
  const r = await run(
    g.cmd,
    [...g.args, "--console=plain", "--continue", `:${module}:${task}`],
    { cwd: KOTLIN_DIR, env, timeout: 1_200_000 },
  );
  const failures: Failure[] = [];
  for (const line of r.out.split("\n")) {
    const m = /^e: file:\/\/(.+Block\.kt):(\d+):\d+ (.*)$/.exec(line);
    if (!m) continue;
    const hit = byFile.get(m[1] ?? "");
    if (!hit) continue;
    // Map the generated line back to the block: find the generated line's text in the block.
    const text = readFileSync(m[1] ?? "", "utf8").split("\n");
    const src = hit.s.code.split("\n");
    const generated = (text[Number(m[2]) - 1] ?? "").trim();
    const at = src.findIndex((l) => l.trim() === generated);
    failures.push({
      snippet: hit.s,
      line: hit.s.line + Math.max(at, 0),
      message: m[3] ?? "",
    });
  }
  if (r.code !== 0 && failures.length === 0)
    failures.push(
      harnessFailure(
        `gradle :${module}:${task} failed: ${r.out.slice(-1200)}`,
      ),
    );
  return failures;
}

export async function compileKotlin(snippets: Snippet[]): Promise<Failure[]> {
  const android = snippets.filter((s) => /(^|\s)android(\s|$)/.test(s.meta));
  const jvm = snippets.filter((s) => !android.includes(s));
  const out = await gradleKotlin(jvm, "docs-snippets", "compileKotlin");
  if (android.length > 0) {
    if (!kotlinAndroidAvailable())
      out.push(
        harnessFailure(
          "blocks tagged android need the Android SDK (ANDROID_HOME)",
        ),
      );
    else
      out.push(
        ...(await gradleKotlin(
          android,
          "docs-snippets-android",
          "compileDebugKotlin",
        )),
      );
  }
  return out;
}

// ── GDScript ───────────────────────────────────────────────────────────────────────────────────

const GODOT_SAMPLE = join(GODOT_DIR, "tests/sdk_config/polaris_key_config.gd");

export function godotBin(): string | null {
  const env = process.env.GODOT_BIN;
  if (env) return env;
  return spawnSync("godot", ["--version"]).status === 0 ? "godot" : null;
}

export const godotSkipReason = (): string | null =>
  godotBin() ? null : "no godot on PATH (set GODOT_BIN)";

const GD_DECL =
  /^(?:static\s+)?(?:func|extends|class_name|signal|enum|const|var|class|@)\b/;

/** A GDScript block as a script: statement-only fragments become the body of a function. */
export function gdFile(code: string): { text: string; offset: number } {
  const lines = code.split("\n");
  const declared = lines.some((l) => GD_DECL.test(l));
  if (!declared) {
    const body = lines.map((l) => (l.length ? `\t${l}` : l)).join("\n");
    return {
      text: `extends Node\n\nfunc _docs_block() -> void:\n${body}\n`,
      offset: -3,
    };
  }
  if (lines.some((l) => /^extends\b/.test(l)))
    return { text: `${code}\n`, offset: 0 };
  return { text: `extends Node\n${code}\n`, offset: 1 };
}

const GODOT_PROJECT = `config_version=5

[application]
config/name="docs snippets"

[autoload]
PolarisKey="*res://addons/polaris_key/polaris_key.gd"

[debug]
gdscript/warnings/unsafe_property_access=2
gdscript/warnings/unsafe_method_access=2
gdscript/warnings/unsafe_call_argument=1
gdscript/warnings/unsafe_cast=0
gdscript/warnings/untyped_declaration=0
gdscript/warnings/inferred_declaration=0
`;

const GODOT_HARNESS = `extends SceneTree

func _initialize() -> void:
	for f in DirAccess.get_files_at("res://snippets"):
		if f.ends_with(".gd"):
			ResourceLoader.load("res://snippets/" + f, "", ResourceLoader.CACHE_MODE_IGNORE)
	quit(0)
`;

export async function compileGodot(snippets: Snippet[]): Promise<Failure[]> {
  if (snippets.length === 0) return [];
  const bin = godotBin();
  if (!bin) return [harnessFailure("no godot binary")];
  const dir = mkdtempSync(join(tmpdir(), "pkey-docs-godot-"));
  try {
    mkdirSync(join(dir, "snippets"));
    symlinkSync(join(GODOT_DIR, "addons"), join(dir, "addons"));
    writeFileSync(join(dir, "project.godot"), GODOT_PROJECT);
    writeFileSync(join(dir, "harness.gd"), GODOT_HARNESS);
    writeFileSync(join(dir, "polaris_key_config.gd"), readFileSync(GODOT_SAMPLE));
    const owner = new Map<string, { s: Snippet; offset: number }>();
    snippets.forEach((s, i) => {
      const name = `b${String(i).padStart(4, "0")}.gd`;
      const f = gdFile(s.code);
      writeFileSync(join(dir, "snippets", name), f.text);
      owner.set(name, { s, offset: f.offset });
    });
    const env = { ...process.env, HOME: dir };
    const imp = await run(bin, ["--headless", "--path", dir, "--import"], {
      cwd: dir,
      env,
      timeout: 240_000,
    });
    const r = await run(
      bin,
      ["--headless", "--path", dir, "--script", "res://harness.gd"],
      { cwd: dir, env, timeout: 240_000 },
    );
    const text = `${imp.out}\n${r.out}`;
    const failures: Failure[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const head = /^SCRIPT ERROR: (?:Parse|Compile) Error: (.*)$/.exec(
        lines[i] ?? "",
      );
      if (!head) continue;
      const at = /res:\/\/snippets\/(b\d+\.gd):(\d+)/.exec(lines[i + 1] ?? "");
      const hit = at ? owner.get(at[1] ?? "") : undefined;
      if (hit && at)
        failures.push({
          snippet: hit.s,
          line: hit.s.line + Number(at[2]) - 1 + hit.offset,
          message: head[1] ?? "",
        });
    }
    // Several lines report one error twice (the parser and the analyzer); keep the first.
    const seen = new Set<string>();
    const unique = failures.filter((f) => {
      const k = `${f.snippet.file}:${f.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (unique.length === 0 && /Traceback|Could not find|Failed to load/.test(r.out))
      unique.push(harnessFailure(`the Godot lane did not run: ${r.out.slice(0, 600)}`));
    return unique;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Exports and the symbol check ───────────────────────────────────────────────────────────────

function* walkFiles(dir: string, ext: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".build", "build", ".git", ".gradle"].includes(name))
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkFiles(full, ext);
    else if (name.endsWith(ext)) yield full;
  }
}

/** Every public name the Swift sources declare (a superset: enum cases of any access count). */
export function swiftExports(): Set<string> {
  const names = new Set<string>();
  const decl =
    /\bpublic\s+(?:[\w@()]+\s+)*?(?:struct|class|enum|protocol|actor|func|var|let|typealias|case|macro)\s+`?(\w+)/g;
  for (const f of walkFiles(join(SWIFT_DIR, "Sources"), ".swift")) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(decl)) names.add(m[1] ?? "");
    for (const m of src.matchAll(/^\s*case\s+([\w, ]+?)(?:\(|\s*=|\s*$)/gm))
      for (const n of (m[1] ?? "").split(",")) names.add(n.trim());
  }
  return names;
}

/** Every name the Kotlin main sources declare (a superset: access is not checked). */
export function kotlinExports(): Set<string> {
  const names = new Set<string>();
  const decl =
    /\b(?:class|object|interface|fun|val|var|typealias)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?`?(\w+)/g;
  for (const f of walkFiles(KOTLIN_DIR, ".kt")) {
    const rel = relative(KOTLIN_DIR, f);
    if (/(^|\/)(src\/(test|androidTest|testFixtures)|samples|docs-snippets)/.test(rel))
      continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(decl)) names.add(m[1] ?? "");
    for (const m of src.matchAll(/^\s+([A-Z][A-Za-z0-9_]*)\s*(?:[,;(]|$)/gm))
      names.add(m[1] ?? "");
  }
  return names;
}

/** Every class, function, signal and constant the addon declares. */
export function godotExports(): Set<string> {
  const names = new Set<string>(["PolarisKey"]);
  for (const f of walkFiles(join(GODOT_DIR, "addons/polaris_key"), ".gd")) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^class_name\s+(\w+)/gm)) names.add(m[1] ?? "");
    for (const m of src.matchAll(/^\s*(?:static\s+)?func\s+(\w+)/gm))
      names.add(m[1] ?? "");
    for (const m of src.matchAll(/^\s*signal\s+(\w+)/gm)) names.add(m[1] ?? "");
    for (const m of src.matchAll(/^\s*(?:const|var|enum)\s+(\w+)/gm))
      names.add(m[1] ?? "");
    for (const m of src.matchAll(/^\s*class\s+(\w+)/gm)) names.add(m[1] ?? "");
  }
  return names;
}

/** The global class names the addon registers (`class_name`), for the Godot drift check. */
export function godotClassNames(): Set<string> {
  const names = new Set<string>();
  for (const f of walkFiles(join(GODOT_DIR, "addons/polaris_key"), ".gd"))
    for (const m of readFileSync(f, "utf8").matchAll(/^class_name\s+(\w+)/gm))
      names.add(m[1] ?? "");
  return names;
}

export interface NativeMention {
  name: string;
  line: number;
  text: string;
}

const PASCAL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;
const PLANNED = /planned|coming in/i;

/** The names a page's prose claims for one language, minus the lines that label them planned. */
export function nativeMentions(
  prose: { line: number; text: string }[],
  lang: NativeLang,
): NativeMention[] {
  const out: NativeMention[] = [];
  for (const { line, text } of prose) {
    if (PLANNED.test(text)) continue;
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const raw = (m[1] ?? "").trim();
      const call = /^((?:[.\w]+\.)?)(\w+)\(/.exec(raw);
      const dotted = raw.replace(/\(.*$/s, "").split(".");
      const last = (dotted[dotted.length - 1] ?? "").trim();
      let name: string | null = null;
      if (lang === "swift") {
        if (PASCAL.test(last) || /^polarisKey[A-Z]\w*$/.test(last)) name = last;
        else if (call && /^[a-z]+[A-Z]\w*$/.test(call[2] ?? "")) name = call[2] ?? null;
      } else if (lang === "kotlin") {
        if (PASCAL.test(last)) name = last;
        else if (call && /^[a-z]+[A-Z]\w*$/.test(call[2] ?? "")) name = call[2] ?? null;
      } else {
        if (/^PKey[A-Z]\w*$/.test(last) || last === "PolarisKey") name = last;
        else if (call && (call[2] ?? "").includes("_")) name = call[2] ?? null;
        else if (call && /^(PolarisKey|PKey\w+)\.$/.test(call[1] ?? "")) name = call[2] ?? null;
      }
      if (name && !IGNORED[lang].has(name))
        out.push({ name, line, text: raw });
    }
  }
  return out;
}

export function exportsOf(lang: NativeLang): Set<string> {
  return lang === "swift"
    ? swiftExports()
    : lang === "kotlin"
      ? kotlinExports()
      : godotExports();
}

export function skipReasonOf(lang: NativeLang): string | null {
  return lang === "swift"
    ? swiftSkipReason()
    : lang === "kotlin"
      ? kotlinSkipReason()
      : godotSkipReason();
}

export function compileOf(lang: NativeLang, snippets: Snippet[]): Promise<Failure[]> {
  return lang === "swift"
    ? compileSwift(snippets)
    : lang === "kotlin"
      ? compileKotlin(snippets)
      : compileGodot(snippets);
}

export { HERE as NATIVE_HERE };
