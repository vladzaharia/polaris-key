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
// GDScript (top-level `func` and `signal`) are read as text. Removed names and reserved spellings with .7.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  feature?: string;
  enum?: string;
  reserved?: string;
  sdks?: Record<string, SdkEntry>;
}
interface Removed {
  from: string;
  package: string;
  scan?: unknown;
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
  if (type === undefined)
    return lines
      .filter((l) => l.depth === 0)
      .map((l) => ({ text: l.text, declLine: "" }));
  const out: { text: string; declLine: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]!.text);
    if (!m || m[1] !== type) continue;
    const bodyDepth = lines[i]!.depth + 1;
    let opened = lines[i]!.text.includes("{");
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.depth >= bodyDepth) {
        opened = true;
        if (l.depth === bodyDepth)
          out.push({ text: l.text, declLine: lines[i]!.text });
      } else if (opened || l.text.trim() !== "{") break;
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

/** Public `fun`, `val` and `var` names of `type` (class, object or interface) in Kotlin source; with no `type`, top-level ones. `private`, `internal` and `protected` members are skipped; no modifier means public. */
export function scanKotlin(source: string, type?: string): string[] {
  const names = new Set<string>();
  const re =
    /^\s*((?:(?:@\w+(?:\([^)]*\))?|public|private|internal|protected|open|abstract|override|suspend|inline|operator|infix|final|const|lateinit|actual|expect|external|tailrec)\s+)*)(?:fun|val|var)\s+(?:<[^>]*>\s*)?(?:[\w<>?,. ]+\.)?(\w+)/;
  for (const { text } of memberLines(
    source,
    type,
    /\b(?:class|object|interface)\s+(\w+)/,
  )) {
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

/** Rule 1: public verbs on the recorded Node, React and Python surfaces that nothing accounts for. */
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
      for (const c of doc.concepts) {
        const e = c.sdks?.[sdk];
        if (!e || !(e.sdkOnly || c.id.startsWith(`${surf.ns}.`))) continue;
        const last = c.id.split(".").pop()!;
        accepted.add(casing === "snake" ? snake(last) : last);
        for (const sp of [e.spelling, e.path])
          if (sp) accepted.add(sp.split(".").pop()!.replace(/\(\)$/, ""));
      }
      for (const v of verbs) {
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

export interface CheckApiOptions {
  /** The parsed registry to check instead of reading api.json (tests mutate a copy). */
  api?: unknown;
}

function readJson(root: string, file: string): unknown {
  const abs = join(root, file);
  if (!existsSync(abs)) return undefined;
  return JSON.parse(readFileSync(abs, "utf8"));
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
  out.push(...checkSurfaces(root, doc));
  return out;
}
