// The SDK API registry gate (SP-35), rule 4 of its checker; `tools/parity-check.ts` runs it as
// rule 8 of `pnpm gen --check`'s `parity` family and prints each violation as `[rule 8]`.
//
//   conformance/parity/api.json          the registry (+ api.schema.json)
//   conformance/parity/features.json     the feature ids a concept may name
//   conformance/parity/enums.json        the enum names a concept may name
//   docs/research/…/program/workpackages.json   which work packages exist and are open
//
// It fails when:
//
//   - api.json does not match api.schema.json;
//   - a `planned` or `reserved` package, or a `removed` row's `package`, is not a work package;
//     a `planned` or `removed` package is already `done` (the entry or row is stale);
//   - a concept names a `feature` or `enum` the registries lack;
//   - a `removed` row whose `from` is a common word has no `scan`.
//
// Rule 1 (SP-35.5, .6): every public verb in a file listed under `surfaces.<sdk>`
// is a concept's spelling for that SDK, a `sdkOnly` entry, or covered by `ignore`. TypeScript is
// read with the compiler API (class or interface members, or a file's exported functions and
// consts); Python with `def` at class depth (or module level), `_names` skipped.
// Swift, Kotlin (regex over brace depth; `private`/`fileprivate`/`internal`, `_names` skipped) and
// GDScript (top-level `func` and `signal`) are read as text. A concept also counts for a surface
// whose namespace its per-SDK `spelling` or `path` names (`entitlements.has` spelled
// `license.isEntitled` on the `license` surface).
//
// Rule 2 (SP-35.7): a `removed` row's name appears in an SDK's own source or a consumer (examples,
// the CLI and integration emitters and goldens, the `pkey sdk` samples, docs and README fences,
// skills). The row's `sdk` picks the languages (node and react: ts/js; python: py/rpy; ...); a
// Markdown file is read inside fences of those languages only, so wire JSON in a protocol page is
// not a hit. The default match is `<ns>.<name>` (+ `(` when the row's `to` is a method) for a
// dotted `from`, and `<name>:` / `<name>=` for a bare one or an option. `scan.pattern` replaces
// it; `scan.files` (globs on the repo-relative path, or `fence:<lang>`) replaces the default
// file set. Never scanned: the corpus, tools/corpus, client-core and @polaris-key/server.
// A line carrying `api-allow: <reason>` (or following one that does) is skipped; an empty reason
// is itself a violation.
//
// Rule 3 (SP-35.7): a reserved concept (no SDK lists it yet) is spelled another way on a recorded
// surface: the same name modulo case, `_` and a `get` prefix, in another namespace or with other
// spelling. Rule 1 still reports the verb when nothing accounts for it.
//
// `--notes <WP>` prints that package's `removed` rows as Markdown for the release notes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import Ajv2020Module from "ajv/dist/2020.js";

export const API_PATH = "conformance/parity/api.json";
export const API_SCHEMA_PATH = "conformance/parity/api.schema.json";
const FEATURES_PATH = "conformance/parity/features.json";
const ENUMS_PATH = "conformance/parity/enums.json";
const PROGRAM_PATH =
  "docs/research/2026-09-29-godot-omniplatform/program/workpackages.json";

/** Words a bare `from` name shares with unrelated code, so the row has to say where to look. */
export const COMMON_WORDS = [
  "trust",
  "product",
  "secret",
  "config",
  "activate",
  "changes",
];

interface SdkEntry {
  planned?: string;
  spelling?: string;
  path?: string;
  sdkOnly?: boolean;
}
interface Concept {
  id: string;
  kind?: string;
  feature?: string;
  enum?: string;
  reserved?: string;
  layer?: string;
  sdks?: Record<string, SdkEntry>;
}
interface Removed {
  sdk: string;
  from: string;
  to?: string;
  note?: string;
  package: string;
  scan?: { pattern?: string; files?: string[] };
}
interface Api {
  casing?: Record<string, "camel" | "snake">;
  surfaces?: Record<string, { ns: string; type?: string; file: string }[]>;
  ignore?: { sdk?: string; path: string }[];
  concepts: Concept[];
  removed: Removed[];
}

const snake = (n: string): string =>
  n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Public member names of `type` (class or interface) in TypeScript source; with no `type`, the file's exported functions and consts. */
export function scanTs(source: string, type?: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const nameOf = (n: ts.PropertyName | undefined): string | undefined =>
    n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;
  const hidden = (n: ts.Node): boolean =>
    (ts.getCombinedModifierFlags(n as ts.Declaration) &
      (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
    0;
  const add = (n: string | undefined): void => {
    if (n && !n.startsWith("_") && n !== "constructor") names.add(n);
  };
  for (const st of sf.statements) {
    const exported =
      (ts.getCombinedModifierFlags(st as unknown as ts.Declaration) &
        ts.ModifierFlags.Export) !==
      0;
    if (type === undefined) {
      if (!exported) continue;
      if (ts.isFunctionDeclaration(st)) add(st.name?.text);
      else if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name)) add(d.name.text);
      continue;
    }
    if (
      (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) &&
      st.name?.text === type
    )
      for (const m of st.members) {
        if (hidden(m) || (m as { name?: ts.Node }).name === undefined) continue;
        if (
          ts.isMethodDeclaration(m) ||
          ts.isMethodSignature(m) ||
          ts.isPropertyDeclaration(m) ||
          ts.isPropertySignature(m) ||
          ts.isGetAccessor(m) ||
          ts.isSetAccessor(m)
        )
          add(nameOf(m.name));
      }
  }
  return [...names];
}

/** Public `def` names of `type` (class depth) in Python source; with no `type`, module-level defs. `_names` are skipped. */
export function scanPython(source: string, type?: string): string[] {
  const names = new Set<string>();
  let inClass = type === undefined;
  let bodyIndent = 0;
  for (const line of source.split("\n")) {
    if (type !== undefined) {
      const cls = /^(\s*)class\s+(\w+)/.exec(line);
      if (cls) {
        inClass = cls[2] === type;
        bodyIndent = (cls[1] ?? "").length + 4;
        continue;
      }
      if (inClass && /^\S/.test(line)) inClass = false;
    }
    if (!inClass) continue;
    const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(line);
    if (m && (m[1] ?? "").length === (type === undefined ? 0 : bodyIndent))
      if (!m[2]!.startsWith("_")) names.add(m[2]!);
  }
  return [...names];
}

/** Source with comments and string contents blanked, one entry per line, plus each line's brace depth at its start. */
function braceLines(source: string): { text: string; depth: number }[] {
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\/.*$/gm, "");
  let depth = 0;
  return clean.split("\n").map((text) => {
    const d = depth;
    for (const ch of text) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    return { text, depth: d };
  });
}

/** Lines at member depth: inside every declaration of `type` (matched by `decl`), or at top level with no `type`. */
function memberLines(
  source: string,
  type: string | undefined,
  decl: RegExp,
): { text: string; declLine: string }[] {
  const lines = braceLines(source);
  if (type === undefined) {
    // Top level only, and not inside a multi-line parameter list (a data class's `val`s).
    let paren = 0;
    const top: { text: string; declLine: string }[] = [];
    for (const l of lines) {
      if (l.depth === 0 && paren === 0)
        top.push({ text: l.text, declLine: "" });
      paren +=
        (l.text.match(/\(/g)?.length ?? 0) - (l.text.match(/\)/g)?.length ?? 0);
    }
    return top;
  }
  const out: { text: string; declLine: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]!.text);
    if (!m || m[1] !== type) continue;
    const bodyDepth = lines[i]!.depth + 1;
    let opened = lines[i]!.text.includes("{");
    // A declaration whose parameter list spans lines (`class A(` ... `) : B {`) has not opened yet.
    const parens = (t: string): number =>
      (t.match(/\(/g)?.length ?? 0) - (t.match(/\)/g)?.length ?? 0);
    let bal = parens(lines[i]!.text);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.depth >= bodyDepth) {
        opened = true;
        if (l.depth === bodyDepth)
          out.push({ text: l.text, declLine: lines[i]!.text });
      } else if (opened) break;
      else if (bal > 0 || l.text.trim() === "{" || /^\s*[):{]/.test(l.text)) {
        bal += parens(l.text);
        if (
          (l.text.match(/\{/g)?.length ?? 0) >
          (l.text.match(/\}/g)?.length ?? 0)
        )
          opened = true;
      } else break;
    }
  }
  return out;
}

const SWIFT_DECL =
  /\b(?:class|struct|enum|actor|extension)\s+(\w+)|\bprotocol\s+(\w+)/;
const swiftDecl = {
  exec: (t: string): RegExpExecArray | null => {
    const m = SWIFT_DECL.exec(t);
    if (!m) return null;
    const r = [m[0], m[1] ?? m[2]] as unknown as RegExpExecArray;
    return r;
  },
} as RegExp;

/** Public `func`, `var` and `let` names of `type` (struct, class, enum, actor, protocol or extension) in Swift source; with no `type`, top-level ones. `private`, `fileprivate` and `internal` members (the default) are skipped. */
export function scanSwift(source: string, type?: string): string[] {
  const names = new Set<string>();
  const re =
    /^\s*((?:(?:@\w+(?:\([^)]*\))?|\w+(?:\(set\))?)\s+)*?)(?:func|var|let)\s+`?(\w+)/;
  for (const { text, declLine } of memberLines(source, type, swiftDecl)) {
    const m = re.exec(text);
    if (!m) continue;
    const mods = m[1] ?? "";
    const inProtocol = /\bprotocol\b/.test(declLine);
    const pub =
      /\b(?:public|open)\b/.test(mods) ||
      inProtocol ||
      /\b(?:public|open)\b[^{]*\bextension\b/.test(declLine);
    if (!pub || /\b(?:private|fileprivate|internal)\b/.test(mods)) continue;
    if (!m[2]!.startsWith("_")) names.add(m[2]!);
  }
  return [...names];
}

const KOTLIN_DECL =
  /\bcompanion\s+object(?:\s+(\w+))?|\b(?:class|object|interface)\s+(\w+)/;
/** A class, object or interface declaration; an unnamed `companion object` is `Companion`. */
const kotlinDecl = {
  exec: (t: string): RegExpExecArray | null => {
    const m = KOTLIN_DECL.exec(t);
    if (!m) return null;
    const name = m[0].startsWith("companion") ? (m[1] ?? "Companion") : m[2];
    return [m[0], name] as unknown as RegExpExecArray;
  },
} as RegExp;

/** Public `fun`, `val` and `var` names of `type` (class, object or interface) in Kotlin source; with no `type`, top-level ones. `private`, `internal` and `protected` members are skipped; no modifier means public. */
export function scanKotlin(source: string, type?: string): string[] {
  const names = new Set<string>();
  const re =
    /^\s*((?:(?:@\w+(?:\([^)]*\))?|public|private|internal|protected|open|abstract|override|suspend|inline|operator|infix|final|const|lateinit|actual|expect|external|tailrec)\s+)*)(?:fun|val|var)\s+(?:<[^>]*>\s*)?(?:[\w<>?,. ]+\.)?(\w+)/;
  for (const { text } of memberLines(source, type, kotlinDecl)) {
    const m = re.exec(text);
    if (!m || /\b(?:private|internal|protected)\b/.test(m[1] ?? "")) continue;
    if (!m[2]!.startsWith("_")) names.add(m[2]!);
  }
  return [...names];
}

/** Top-level `func` and `signal` names of a GDScript file (a script is one class); `_names` are skipped. */
export function scanGodot(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const m = /^(?:static\s+)?(?:func|signal)\s+(\w+)/.exec(line);
    if (m && !m[1]!.startsWith("_")) names.add(m[1]!);
  }
  return [...names];
}

/** A verb with case, `_` and a leading `get` removed, so `getQuantity` and `get_quantity` meet `quantity`. */
const normVerb = (n: string): string =>
  n
    .replace(/_/g, "")
    .toLowerCase()
    .replace(/^get(?=.)/, "");

/** Rules 1 and 3: public verbs on the recorded Node, React and Python surfaces that nothing accounts for. */
function checkSurfaces(root: string, doc: Api): string[] {
  const out: string[] = [];
  for (const sdk of ["node", "react", "python", "swift", "kotlin", "godot"]) {
    const casing = doc.casing?.[sdk] ?? "camel";
    for (const surf of doc.surfaces?.[sdk] ?? []) {
      const abs = join(root, surf.file);
      if (!existsSync(abs)) {
        out.push(`[rule 8] ${surf.file}: surface file not found`);
        continue;
      }
      const src = readFileSync(abs, "utf8");
      const verbs =
        sdk === "python"
          ? scanPython(src, surf.type)
          : sdk === "swift"
            ? scanSwift(src, surf.type)
            : sdk === "kotlin"
              ? scanKotlin(src, surf.type)
              : sdk === "godot"
                ? scanGodot(src)
                : scanTs(src, surf.type);
      const accepted = new Set<string>();
      const nsDot = `${surf.ns}.`;
      for (const c of doc.concepts) {
        const e = c.sdks?.[sdk];
        if (!e) continue;
        const spellings = [e.spelling, e.path].filter(
          (x): x is string => x !== undefined,
        );
        const idHere = e.sdkOnly || c.id.startsWith(nsDot);
        if (!idHere && !spellings.some((sp) => sp.startsWith(nsDot))) continue;
        if (idHere) {
          const last = c.id.split(".").pop()!;
          accepted.add(casing === "snake" ? snake(last) : last);
        }
        for (const sp of spellings)
          if (idHere || sp.startsWith(nsDot))
            accepted.add(sp.split(".").pop()!.replace(/\(\)$/, ""));
      }
      const reserved = doc.concepts.filter(
        (c) => c.reserved !== undefined && !c.sdks?.[sdk],
      );
      for (const v of verbs) {
        if (!accepted.has(v))
          for (const c of reserved) {
            const last = c.id.split(".").pop()!;
            const canon = casing === "snake" ? snake(last) : last;
            if (normVerb(v) !== normVerb(last)) continue;
            if (c.id.startsWith(nsDot) && v === canon) continue;
            out.push(
              `[rule 8] ${surf.file}: ${surf.ns}.${v} spells the reserved name ${c.id} (${c.reserved}); the only spelling is ${c.id.split(".")[0]}.${canon}`,
            );
          }
        if (accepted.has(v)) continue;
        const covered = (doc.ignore ?? []).some(
          (i) =>
            (i.sdk === undefined || i.sdk === sdk) &&
            [v, `${surf.ns}.${v}`, `${surf.type}.${v}`].includes(i.path),
        );
        if (!covered)
          out.push(
            `[rule 8] ${surf.file}: ${surf.ns}.${v} is not a registry row, an sdks entry or an ignore entry`,
          );
      }
    }
  }
  return out;
}

type Family = "js" | "python" | "swift" | "kotlin" | "godot";
const FAMILY: Record<string, Family> = {
  node: "js",
  react: "js",
  python: "python",
  swift: "swift",
  kotlin: "kotlin",
  godot: "godot",
};
const EXTS: Record<Family, string[]> = {
  js: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi", ".rpy"],
  swift: [".swift"],
  kotlin: [".kt", ".kts"],
  godot: [".gd", ".tres", ".tscn"],
};
const FENCES: Record<Family, string[]> = {
  js: ["ts", "typescript", "tsx", "js", "javascript", "jsx", "mjs"],
  python: ["python", "py"],
  swift: ["swift"],
  kotlin: ["kotlin", "kt"],
  godot: ["gdscript", "gd"],
};
const TEXT_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rpy", ".swift", ".kt",
  ".kts", ".gd", ".tres", ".tscn", ".json", ".md", ".mdx", ".yaml", ".yml", ".txt",
]; // prettier-ignore
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".build", ".venv", ".git", "__pycache__", ".gradle",
  ".godot", ".pytest_cache", ".mypy_cache", ".turbo", ".astro",
]); // prettier-ignore

/** Where a removed name is looked for. `own` scopes are an SDK family's sources; `any` ones are emitters and goldens of every language. */
const SCOPES: { path: string; own?: Family; any?: boolean; main?: boolean }[] =
  [
    ...["packages/sdk-node/src", "packages/sdk-react/src", "packages/ui-core/src/browser/sdk", "packages/elements/src"].map((path) => ({ path, own: "js" as Family })), // prettier-ignore
    { path: "sdks/python/src", own: "python" },
    { path: "sdks/swift/Sources", own: "swift" },
    { path: "sdks/kotlin", own: "kotlin", main: true },
    { path: "sdks/godot/addons", own: "godot" },
    { path: "examples" },
    { path: "sdks/python/examples" },
    { path: "sdks/swift/examples" },
    { path: "sdks/swift/Examples" },
    { path: "sdks/godot/examples" },
    { path: "sdks/kotlin/samples" },
    { path: ".claude/skills" },
    { path: "packages/agent-kit/skills" },
    { path: "packages/docs/src/content/docs" },
    { path: "packages/cli/src", any: true },
    { path: "packages/shared-manifest/src/integration", any: true },
    { path: "packages/shared-manifest/test/fixtures/integration", any: true },
    ...["conformance/runners/node/sdkConfigSample.ts", "packages/sdk-react/test/sdkConfigSample.ts", "sdks/python/tests/sdk_config_sample.py", "sdks/swift/Tests/PolarisKeyTests/SdkConfigSample.swift", "sdks/kotlin/sdk/src/test/kotlin/polaris/generated/PolarisConfig.kt", "sdks/godot/tests/sdk_config/polaris_key.tres"].map((path) => ({ path, any: true })), // prettier-ignore
    ...["packages/sdk-node", "packages/sdk-react", "sdks/python", "sdks/swift", "sdks/kotlin", "sdks/godot"].map((path) => ({ path: `${path}/README.md` })), // prettier-ignore
  ];

function walk(abs: string, out: string[]): void {
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isFile()) {
    out.push(abs);
    return;
  }
  for (const name of readdirSync(abs))
    if (
      !SKIP_DIRS.has(name) &&
      (name !== "build" || abs.includes("/content/docs")) // a docs section, else a build output
    )
      walk(join(abs, name), out);
}

const globRe = (g: string): RegExp =>
  new RegExp(
    "^" +
      (g.includes("/") ? "" : "(?:.*/)?") +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\/?/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, "(?:.*/)?") +
      "$",
  );

/** The regex for a removed row: its own `scan.pattern`, else the receiver-qualified default. */
export function removedPattern(r: Removed, doc: Api): RegExp {
  if (r.scan?.pattern) return new RegExp(r.scan.pattern);
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = r.from.split(".");
  const name = esc(parts.pop()!);
  const to = doc.concepts.find((c) => c.id === r.to);
  if (parts.length === 0 || to?.kind === "option")
    return new RegExp(`(?<![\\w.])${name}\\s*(?::(?!:)|=(?!=))`);
  const ns = esc(parts.join("."));
  return new RegExp(
    `\\b${ns}\\.${name}${to?.kind === "method" ? "\\s*\\(" : "\\b"}`,
  );
}

/** One line of a scanned file that a removed-name row can still report on (or that reports an
 *  empty `api-allow`). `fence` is `undefined` outside Markdown, else the open fence's language
 *  (`null` outside any fence). */
interface ScanLine {
  line: string;
  n: number;
  fence: string | null | undefined;
  /** An `api-allow:` with no reason. */
  bad: boolean;
  /** Neither this line nor the one before carries an `api-allow:` with a reason. */
  live: boolean;
}

/** Walk a file's lines once: Markdown fences, `api-allow` markers and the line before it. Fence
 *  marker lines are dropped (they are never scanned and reset the allow marker). */
function prepareLines(text: string, md: boolean): ScanLine[] {
  const out: ScanLine[] = [];
  let fence: string | null = null; // lang of the open fence
  let prevAllowed = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (md) {
      const f = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
      if (f) {
        fence = fence === null ? f[2]!.toLowerCase() : null;
        prevAllowed = false;
        continue;
      }
    }
    const allow = /api-allow:(.*)$/.exec(line);
    const allowed = allow !== null && allow[1]!.trim() !== "";
    const bad = allow !== null && !allowed;
    const live = !allowed && !prevAllowed;
    prevAllowed = allowed;
    if (bad || live)
      out.push({ line, n: i + 1, fence: md ? fence : undefined, bad, live });
  }
  return out;
}

/** Rule 2: removed names in SDK sources and consumers. */
function checkRemoved(root: string, doc: Api): string[] {
  const out: string[] = [];
  if (doc.removed.length === 0) return out;
  const files: { rel: string; scope: (typeof SCOPES)[number] }[] = [];
  const seen = new Set<string>();
  for (const scope of SCOPES) {
    const abs: string[] = [];
    walk(join(root, scope.path), abs);
    for (const a of abs) {
      const rel = relative(root, a).split("\\").join("/");
      if (seen.has(rel)) continue;
      if (scope.main && !rel.includes("/src/main/")) continue;
      seen.add(rel);
      files.push({ rel, scope });
    }
  }
  const extOf = (rel: string): string => {
    const i = rel.lastIndexOf(".");
    return i < 0 ? "" : rel.slice(i);
  };
  // Everything about a line that does not depend on the removed row, computed once per file
  // (a row used to re-read, re-split and re-match every file).
  const linesOf = new Map<string, ScanLine[]>();
  for (const r of doc.removed) {
    const fam = FAMILY[r.sdk]!;
    const re = removedPattern(r, doc);
    const globs = (r.scan?.files ?? []).filter((f) => !f.startsWith("fence:"));
    const fenceLangs = r.scan?.files
      ? r.scan.files
          .filter((f) => f.startsWith("fence:"))
          .map((f) => f.slice(6))
      : FENCES[fam];
    const globRes = globs.map(globRe);
    const to = r.to ?? r.note ?? "";
    for (const { rel, scope } of files) {
      const ext = extOf(rel);
      const md = ext === ".md" || ext === ".mdx";
      if (scope.own !== undefined && scope.own !== fam) continue;
      if (!md) {
        if (r.scan?.files) {
          if (!globRes.some((g) => g.test(rel))) continue;
        } else if (
          scope.any ? !TEXT_EXTS.includes(ext) : !EXTS[fam].includes(ext)
        )
          continue;
      }
      let prepared = linesOf.get(rel);
      if (prepared === undefined) {
        prepared = prepareLines(readFileSync(join(root, rel), "utf8"), md);
        linesOf.set(rel, prepared);
      }
      for (const c of prepared) {
        if (c.bad) out.push(`[rule 8] ${rel}:${c.n}: api-allow needs a reason`);
        if (
          c.live &&
          (c.fence === undefined ||
            (c.fence !== null && fenceLangs.includes(c.fence))) &&
          re.test(c.line)
        )
          out.push(
            `[rule 8] ${rel}:${c.n}: removed ${r.sdk} name "${r.from}" (${r.package})${to ? `; use ${to}` : ""}`,
          );
      }
    }
  }
  return [...new Set(out)];
}

/** `api-check --notes <package>`: that package's `removed` rows as a Markdown table. */
export function renderNotes(api: unknown, pkg: string): string {
  const doc = api as Api;
  const rows = doc.removed.filter((r) => r.package === pkg);
  const cell = (x: string): string => `\`${x}\``;
  const lines = [
    `### Removed in ${pkg}`,
    "",
    "| SDK | Old name | Replacement |",
    "| --- | --- | --- |",
  ];
  for (const r of rows) {
    const c = doc.concepts.find((k) => k.id === r.to);
    const sp = c?.sdks?.[r.sdk];
    const to = c
      ? cell(sp && !sp.planned ? (sp.spelling ?? sp.path ?? c.id) : c.id)
      : (r.note ?? (r.to ? cell(r.to) : "")).replace(/\|/g, "\\|");
    lines.push(`| ${r.sdk} | ${cell(r.from)} | ${to} |`);
  }
  if (rows.length === 0) lines.push("| none | | |");
  return lines.join("\n") + "\n";
}

export interface CheckApiOptions {
  /** The parsed registry to check instead of reading api.json (tests mutate a copy). */
  api?: unknown;
  /** The tree rule 2 scans instead of `root` (tests point it at a fixture tree). */
  scanRoot?: string;
}

function readJson(root: string, file: string): unknown {
  const abs = join(root, file);
  if (!existsSync(abs)) return undefined;
  return JSON.parse(readFileSync(abs, "utf8"));
}

const PARITY_MANIFESTS: Record<string, string> = {
  node: "packages/sdk-node/parity.json",
  react: "packages/sdk-react/parity.json",
  python: "sdks/python/parity.json",
  swift: "sdks/swift/parity.json",
  kotlin: "sdks/kotlin/parity.json",
  godot: "sdks/godot/parity.json",
};

/** L11: an SDK whose manifest implements a concept's feature is listed on the concept (a `planned` entry counts). */
function checkCoverage(root: string, doc: Api): string[] {
  const out: string[] = [];
  for (const [sdk, file] of Object.entries(PARITY_MANIFESTS)) {
    const m = readJson(root, file) as
      | { features?: Record<string, { status?: string }> }
      | undefined;
    if (!m?.features) continue;
    for (const c of doc.concepts) {
      if (c.feature === undefined || c.reserved !== undefined) continue;
      // `layer: "server"` rows document Node's verdict objects (L4); the other SDKs' server
      // drop-ins are not an inventoried surface, so the feature does not imply the row.
      if (c.layer === "server") continue;
      if (m.features[c.feature]?.status !== "implemented") continue;
      if (c.sdks?.[sdk] === undefined)
        out.push(
          `[rule 8] ${c.id}: ${sdk} implements "${c.feature}" (${file}) but is not listed on the concept`,
        );
    }
  }
  return out;
}

/** Returns one `[rule 8]` line per violation; empty when the registry is sound. */
export function checkApi(
  root: string,
  options: CheckApiOptions = {},
): string[] {
  const out: string[] = [];
  const api = options.api ?? readJson(root, API_PATH);
  const schema = readJson(root, API_SCHEMA_PATH);
  if (api === undefined) return [`[rule 8] ${API_PATH}: file not found`];
  if (schema === undefined)
    return [`[rule 8] ${API_SCHEMA_PATH}: file not found`];

  const Ajv2020 =
    (Ajv2020Module as unknown as { default?: unknown }).default ??
    Ajv2020Module;
  const ajv = new (Ajv2020 as new (opts: object) => {
    compile(s: object): {
      (d: unknown): boolean;
      errors?: { instancePath: string; message?: string }[] | null;
    };
  })({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  if (!validate(api)) {
    for (const e of validate.errors ?? [])
      out.push(
        `[rule 8] ${API_PATH}${e.instancePath}: ${e.message ?? "schema violation"}`,
      );
    return out;
  }
  const doc = api as Api;

  const features = new Set(
    (
      (readJson(root, FEATURES_PATH) as { features?: { id: string }[] })
        ?.features ?? []
    ).map((f) => f.id),
  );
  const enums = new Set(
    (
      (readJson(root, ENUMS_PATH) as { enums?: { name: string }[] })?.enums ??
      []
    ).map((e) => e.name),
  );
  const program = readJson(root, PROGRAM_PATH) as
    | { workPackages?: { id: string; status: string }[] }
    | undefined;
  const wps = program
    ? new Map((program.workPackages ?? []).map((p) => [p.id, p.status]))
    : null;

  /** A package must exist; `open` also requires that it is not done. */
  const checkPackage = (where: string, pkg: string, open: boolean): void => {
    if (!wps) return;
    const status = wps.get(pkg);
    if (status === undefined)
      out.push(`[rule 8] ${where}: ${pkg} is not a work package`);
    else if (open && status === "done")
      out.push(`[rule 8] ${where}: ${pkg} is done; drop the entry or row`);
  };

  const seen = new Set<string>();
  for (const c of doc.concepts) {
    if (seen.has(c.id)) out.push(`[rule 8] ${c.id}: duplicate concept id`);
    seen.add(c.id);
    if (c.feature !== undefined && !features.has(c.feature))
      out.push(`[rule 8] ${c.id}: unknown feature "${c.feature}"`);
    if (c.enum !== undefined && !enums.has(c.enum))
      out.push(`[rule 8] ${c.id}: unknown enum "${c.enum}"`);
    if (c.reserved !== undefined)
      checkPackage(`${c.id} (reserved)`, c.reserved, false);
    for (const [sdk, entry] of Object.entries(c.sdks ?? {}))
      if (entry.planned !== undefined)
        checkPackage(`${c.id} (${sdk} planned)`, entry.planned, true);
  }
  for (const r of doc.removed) {
    checkPackage(`removed ${r.from}`, r.package, true);
    const last = r.from.split(".").pop() ?? r.from;
    if (COMMON_WORDS.includes(last.toLowerCase()) && !r.scan)
      out.push(
        `[rule 8] removed ${r.from}: a common word needs its own "scan" (pattern or files)`,
      );
  }
  out.push(...checkCoverage(root, doc));
  out.push(...checkSurfaces(root, doc));
  out.push(...checkRemoved(options.scanRoot ?? root, doc));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const i = process.argv.indexOf("--notes");
  if (i >= 0 && process.argv[i + 1]) {
    process.stdout.write(
      renderNotes(readJson(root, API_PATH), process.argv[i + 1]!),
    );
  } else {
    const v = checkApi(root);
    for (const l of v) console.error(l);
    process.exitCode = v.length ? 1 : 0;
  }
}
