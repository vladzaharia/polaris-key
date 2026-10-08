import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The console copy lint (ST-37): the console copy rules on the concepts page
 * (packages/docs/src/content/docs/start/concepts.md, "Console copy rules"; AGENTS.md rule 4).
 *
 * One word per concept. Four words leave every console string, because the UI names each of those
 * things with another word:
 *
 *   outlet            → Channel (a distribution channel)
 *   storefront feed   → Install source
 *   grant             → Add-on, or a plain verb (give, add); "Automatic grant" is the kept label
 *   capability        → name the feature, the switch, or what the channel allows
 *
 * Identifiers keep them (`outlet`, `grants`, `outletCapabilities`), so this reads only copy: JSX
 * text, and string or template literals that read as prose. Imports, types, object keys,
 * comparisons, `className` and the like, paths, and code-shaped tokens inside a sentence
 * (`dist_outlets`, `outletId`, `…/outlets`) are not copy.
 *
 * It scans the console: `src/` without `portal/` (the customer portal; its copy moves to the kit
 * copy catalog, P0-36) and `kit/` (the component gallery's fixtures).
 *
 * The strings that predate the lint are recorded in copy.debt.json; the packages that rebuild
 * those pages clear them. The test fails on a string the ledger does not hold (new debt) and on a
 * recorded string that has gone or appears fewer times (stale debt), so the ledger only shrinks.
 * After a rename, shrink it with
 *
 *   PKEY_RECORD_COPY_DEBT=1 mise exec node@22 -- pnpm --filter @polaris-key/admin exec vitest run test/copyLint.test.ts
 *
 * which only removes entries or lowers counts: it never adds one, and with no ledger it fails
 * rather than writing one. Then run prettier on the file.
 * The repo has no ESLint (AGENTS.md rule 6), so, like the motion lint, this is a test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const LEDGER = join(here, "copy.debt.json");
const CONCEPTS = join(
  here,
  "..",
  "..",
  "docs",
  "src",
  "content",
  "docs",
  "start",
  "concepts.md",
);

/** Directories under `src/` that are not the console. */
const NOT_CONSOLE = ["portal/", "kit/"];

/** Console files whose strings never reach the UI, each with its reason. */
const NOT_COPY_FILES: Record<string, string> = {
  "console/data/mutations.ts":
    "a mutation's label names the write for the invalidation table and its test, never the UI",
};

export type CopyRuleId = "outlet" | "storefront-feed" | "grant" | "capability";

interface CopyRule {
  id: CopyRuleId;
  /** The word as it appears on the concepts page. */
  word: string;
  pattern: RegExp;
  /** What the UI says instead. */
  use: string;
  /** Kept UI words that contain the banned one; removed before matching. */
  allow?: RegExp[];
}

export const COPY_RULES: readonly CopyRule[] = [
  {
    id: "outlet",
    word: "outlet",
    pattern: /\boutlets?\b/i,
    use: "Channel (a distribution channel)",
  },
  {
    id: "storefront-feed",
    word: "storefront feed",
    pattern: /\bstorefront[\s-]+feeds?\b/i,
    use: "Install source",
  },
  {
    id: "grant",
    word: "grant",
    pattern: /\bgrant(?:s|ed|ing)?\b/i,
    use: "Add-on, or a plain verb (give, add)",
    allow: [/\bautomatic grants?\b/gi],
  },
  {
    id: "capability",
    word: "capability",
    pattern: /\bcapabilit(?:y|ies)\b/i,
    use: "the feature, the switch, or what the channel allows",
  },
];

export interface CopyString {
  /** The copy, whitespace collapsed; a template's `${…}` reads `{…}`. */
  text: string;
  line: number;
}

export interface CopyFinding extends CopyString {
  rule: CopyRuleId;
}

/** JSX attributes whose string is never copy. */
const NOT_COPY_ATTRIBUTES = new Set([
  "accept",
  "autoComplete",
  "class",
  "className",
  "defaultValue",
  "dir",
  "form",
  "href",
  "htmlFor",
  "id",
  "inputMode",
  "key",
  "lang",
  "method",
  "name",
  "pattern",
  "rel",
  "role",
  "src",
  "target",
  "to",
  "type",
  "value",
]);

/** Calls whose string arguments are never copy. */
const NOT_COPY_CALLEES = new Set([
  "cn",
  "clsx",
  "cva",
  "twMerge",
  "RegExp",
  "require",
  "fetch",
  "matchMedia",
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "addEventListener",
  "removeEventListener",
  "getItem",
  "setItem",
  "removeItem",
  "startsWith",
  "endsWith",
  "includes",
  "split",
  "replace",
  "replaceAll",
]);

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * A literal reads as copy: words with spaces, or one capitalised word ("Outlets"). A JSX child's
 * value is rendered as it stands, so there any word is copy (`{n === 1 ? "outlet" : "outlets"}`).
 */
function readsAsCopy(text: string, jsxChild = false): boolean {
  const t = text.replace(/\{…\}/g, "X").trim();
  if (!/[A-Za-z]/.test(t)) return false;
  if (/\s/.test(t)) return true;
  if (jsxChild) return /^[A-Za-z][a-z]*(?:[-'’][a-z]+)*[.:!?…]?$/.test(t);
  return /^[A-Z][a-z]+(?:[-'’][a-z]+)*[.:!?…]?$/.test(t);
}

/**
 * Whether a literal is the value a JSX child expression renders: `{"…"}` itself, or a branch of a
 * conditional (`a ? "…" : "…"`), the right side of `&&`, `||` or `??`, or a parenthesised one.
 */
function isJsxChildValue(node: ts.Node): boolean {
  let cur: ts.Node = node;
  for (;;) {
    const parent: ts.Node = cur.parent;
    if (ts.isParenthesizedExpression(parent)) cur = parent;
    else if (
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === cur || parent.whenFalse === cur)
    )
      cur = parent;
    else if (
      ts.isBinaryExpression(parent) &&
      parent.right === cur &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind)
    )
      cur = parent;
    else
      return (
        ts.isJsxExpression(parent) &&
        (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
      );
  }
}

/**
 * The words of a copy string with its code-shaped tokens removed: a path or URL, an identifier
 * with `_`, a dotted name, camelCase, a backticked span, a `<placeholder>`, a `--flag`, `{…}`.
 */
export function proseOf(text: string): string {
  return text
    .replace(/`[^`]*`/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        !/[/_=<>{}\\@#]|:\/\/|^--?\w|\w\.\w|[a-z][A-Z]/.test(
          w.replace(/[.,;:!?…)"'’]+$/, ""),
        ),
    )
    .join(" ");
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression) && e.expression.text === "console")
      return "console";
    return e.name.text;
  }
  return "";
}

/** Whether a literal sits where a string is an identifier or a value, never copy. */
function isNotCopyPosition(node: ts.Node): boolean {
  let parent = node.parent;
  // `attr={"…"}` and `attr={`…`}` reach the attribute through a JSX expression.
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent))
    parent = parent.parent;
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent) ||
    ts.isCaseClause(parent)
  )
    return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  )
    return true;
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node
  )
    return true;
  if (
    ts.isBinaryExpression(parent) &&
    COMPARISONS.has(parent.operatorToken.kind)
  )
    return true;
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    return NOT_COPY_ATTRIBUTES.has(name) || name.startsWith("data-");
  }
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression !== node
  ) {
    if (parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    const callee = calleeName(parent);
    return callee === "console" || NOT_COPY_CALLEES.has(callee);
  }
  return false;
}

/** Every copy string in one file's source. */
export function copyStrings(source: string, fileName = "x.tsx"): CopyString[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: CopyString[] = [];
  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = collapse(node.text);
      if (/[A-Za-z]/.test(text)) out.push({ text, line: lineOf(node) });
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      const text = collapse(node.text);
      if (!isNotCopyPosition(node) && readsAsCopy(text, isJsxChildValue(node)))
        out.push({ text, line: lineOf(node) });
    } else if (ts.isTemplateExpression(node)) {
      const text = collapse(
        node.head.text +
          node.templateSpans.map((s) => `{…}${s.literal.text}`).join(""),
      );
      if (!isNotCopyPosition(node) && readsAsCopy(text))
        out.push({ text, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The copy in one file's source that breaks a console copy rule. */
export function lintCopy(source: string, fileName = "x.tsx"): CopyFinding[] {
  const findings: CopyFinding[] = [];
  for (const s of copyStrings(source, fileName)) {
    const prose = proseOf(s.text);
    for (const rule of COPY_RULES) {
      let words = prose;
      for (const a of rule.allow ?? []) words = words.replace(a, " ");
      if (rule.pattern.test(words)) findings.push({ ...s, rule: rule.id });
    }
  }
  return findings;
}

function consoleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...consoleFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name))
      out.push(p);
  }
  return out;
}

interface DebtEntry {
  rule: CopyRuleId;
  file: string;
  text: string;
  count: number;
}

const debtKey = (d: { rule: string; file: string; text: string }): string =>
  `${d.rule}\u0000${d.file}\u0000${d.text}`;

const LEDGER_COMMENT =
  "Console copy debt (test/copyLint.test.ts, ST-37): strings that broke the console copy rules on the concepts page (packages/docs/src/content/docs/start/concepts.md, 'Console copy rules') when the lint landed. 'outlet', 'storefront feed', 'grant' and 'capability' leave the UI; the packages that rebuild these pages rename them: the Distribution, Commerce and release pages (A-21, A-22, CM-23), the catalog's user grant (LX-34), the licensing settings (LX-40), the admin group (ST-32), release tracks (P2-08), access and feed vocabulary (P2-10, P2-11) and the service table (ST-38). The test fails on any string not listed here and on an entry that no longer appears as often, so the list only shrinks. Shrink it with PKEY_RECORD_COPY_DEBT=1 (it never adds an entry), then run prettier on this file.";

function scanConsole(): {
  files: string[];
  findings: Array<CopyFinding & { file: string }>;
} {
  const files: string[] = [];
  const findings: Array<CopyFinding & { file: string }> = [];
  for (const p of consoleFiles(SRC)) {
    const rel = relative(SRC, p).split(sep).join("/");
    if (NOT_CONSOLE.some((d) => rel.startsWith(d)) || rel in NOT_COPY_FILES)
      continue;
    files.push(rel);
    for (const f of lintCopy(readFileSync(p, "utf8"), p))
      findings.push({ ...f, file: rel });
  }
  return { files, findings };
}

function countFindings(
  findings: Array<CopyFinding & { file: string }>,
): Map<string, DebtEntry> {
  const counts = new Map<string, DebtEntry>();
  for (const f of findings) {
    const k = debtKey(f);
    const cur = counts.get(k) ?? {
      rule: f.rule,
      file: f.file,
      text: f.text,
      count: 0,
    };
    cur.count++;
    counts.set(k, cur);
  }
  return counts;
}

const MISSING_LEDGER =
  "test/copy.debt.json is missing: restore it from git. Record mode only shrinks it and never writes a new one.";

function readLedger(): DebtEntry[] {
  if (!existsSync(LEDGER)) return [];
  return (JSON.parse(readFileSync(LEDGER, "utf8")) as { debt: DebtEntry[] })
    .debt;
}

/** PKEY_RECORD_COPY_DEBT=1: shrink the ledger to today's counts. It never adds an entry. */
function recordLedger(current: Map<string, DebtEntry>): void {
  if (!existsSync(LEDGER)) throw new Error(MISSING_LEDGER);
  const debt = readLedger()
    .map((d) => ({
      ...d,
      count: Math.min(d.count, current.get(debtKey(d))?.count ?? 0),
    }))
    .filter((d) => d.count > 0);
  debt.sort((a, b) => debtKey(a).localeCompare(debtKey(b)));
  writeFileSync(
    LEDGER,
    JSON.stringify({ $comment: LEDGER_COMMENT, debt }, null, 2) + "\n",
  );
}

describe("the console copy lint", () => {
  const { files, findings } = scanConsole();
  const current = countFindings(findings);
  if (process.env.PKEY_RECORD_COPY_DEBT === "1") recordLedger(current);
  const ledger = readLedger();
  const allowed = new Map(ledger.map((d) => [debtKey(d), d.count]));

  it("has its debt ledger", () => {
    expect(existsSync(LEDGER), MISSING_LEDGER).toBe(true);
  });

  it("scans the console's source and not the portal's", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("console/nav.ts");
    expect(files.some((f) => f.startsWith("portal/"))).toBe(false);
    for (const f of Object.keys(NOT_COPY_FILES))
      expect(existsSync(join(SRC, f)), `${f} is still in src/`).toBe(true);
  });

  it("finds no copy that breaks a console copy rule beyond the recorded debt", () => {
    const use = new Map(COPY_RULES.map((r) => [r.id, r.use]));
    const fresh = findings
      .filter(
        (f) =>
          (current.get(debtKey(f))?.count ?? 0) >
          (allowed.get(debtKey(f)) ?? 0),
      )
      .map(
        (f) =>
          `${f.file}:${f.line} ${f.rule}: "${f.text}" (the UI says: ${use.get(f.rule)})`,
      );
    expect(fresh).toEqual([]);
  });

  it("records no debt that has gone (the ledger only shrinks)", () => {
    const stale = ledger
      .filter((d) => (current.get(debtKey(d))?.count ?? 0) < d.count)
      .map(
        (d) =>
          `${d.file} ${d.rule}: "${d.text}" recorded ${d.count}, found ${current.get(debtKey(d))?.count ?? 0}; shrink the ledger with PKEY_RECORD_COPY_DEBT=1`,
      );
    expect(stale).toEqual([]);
  });

  it("keeps the ledger sorted, unique and limited to the rules", () => {
    const keys = ledger.map(debtKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual(keys);
    const ids = new Set(COPY_RULES.map((r) => r.id));
    expect(ledger.filter((d) => !ids.has(d.rule) || d.count < 1)).toEqual([]);
  });

  it("enforces the words the concepts page lists", () => {
    const page = readFileSync(CONCEPTS, "utf8");
    const at = page.indexOf("### Console copy rules");
    expect(
      at,
      "concepts.md has a 'Console copy rules' section",
    ).toBeGreaterThan(-1);
    const section = page.slice(at, page.indexOf("\n## ", at));
    for (const rule of COPY_RULES)
      expect(section, `concepts.md lists "${rule.word}"`).toContain(
        `"${rule.word}"`,
      );
  });
});

describe("the console copy lint's fixture", () => {
  const fixture = [
    `export const A = () => <h1>Outlets</h1>;`,
    `export const B = () => <p>Each outlet has its own credentials.</p>;`,
    `export const C = () => <Button title="Revoke grant" />;`,
    `export const D = () => <Input placeholder={"Search storefront feeds"} />;`,
    `const E = { label: "Outlet capabilities", to: "/outlets" };`,
    `const F = (n: number) => \`\${n} grants on this license\`;`,
    `toast.success("Grant revoked");`,
    `export const G = () => <Badge aria-label="Store capability" />;`,
    `const H = "Granted by the access policy";`,
    `const I = <p>Install from the storefront-feed page</p>;`,
  ].join("\n");

  it("flags each banned word in JSX text, attributes, values and templates", () => {
    const found = lintCopy(fixture);
    const byLine = (line: number) =>
      found.filter((f) => f.line === line).map((f) => f.rule);
    expect(byLine(1)).toEqual(["outlet"]);
    expect(byLine(2)).toEqual(["outlet"]);
    expect(byLine(3)).toEqual(["grant"]);
    expect(byLine(4)).toEqual(["storefront-feed"]);
    expect(byLine(5)).toEqual(["outlet", "capability"]);
    expect(byLine(6)).toEqual(["grant"]);
    expect(found.find((f) => f.line === 6)?.text).toBe(
      "{…} grants on this license",
    );
    expect(byLine(7)).toEqual(["grant"]);
    expect(byLine(8)).toEqual(["capability"]);
    expect(byLine(9)).toEqual(["grant"]);
    expect(byLine(10)).toEqual(["storefront-feed"]);
  });

  it("reads a lowercase word a JSX child renders as copy, directly or through a branch", () => {
    const children = [
      `const A = <p>{n} {n === 1 ? "outlet" : "outlets"}</p>;`,
      `const B = <p>{ready && "grants"}</p>;`,
      `const C = <>{label ?? ("capability")}</>;`,
      `const D = <p>{"outlet"}</p>;`,
    ].join("\n");
    const found = lintCopy(children).map(
      (f) => `${f.line} ${f.rule} ${f.text}`,
    );
    expect(found).toEqual([
      "1 outlet outlet",
      "1 outlet outlets",
      "2 grant grants",
      "3 capability capability",
      "4 outlet outlet",
    ]);
    const notChildren = [
      `const E = <p>{kind === "outlet" ? a : b}</p>;`,
      `const F = <p className={wide ? "outlet" : "grant"} />;`,
      `const G = <Row id={x ?? "outlet"} />;`,
      `const H = <p>{label(kind ?? "outlet")}</p>;`,
      `const I = n === 1 ? "outlet" : "outlets";`,
    ].join("\n");
    expect(lintCopy(notChildren)).toEqual([]);
  });

  it("passes identifiers, paths, types, keys, comparisons, class names and comments", () => {
    const ok = [
      `import { OutletsPage } from "./areas/distribution/outlets";`,
      `import type { Grant } from "../api";`,
      `type Kind = "outlet" | "grant";`,
      `const a = { outlet: 1, "grants": 2 };`,
      `if (row.kind === "Outlet") go();`,
      `const b = <div className="outlet grant" data-testid="Outlets" />;`,
      `const c = \`/manage/api/products/\${slug}/distribution/outlets\`;`,
      `const d = qk.outlets(slug);`,
      `// Outlets and grants in a comment`,
      `/* the outlet capability */`,
      `const e = row["outlet"];`,
      `const f = "outlet";`,
      `const g = "outlet_not_found";`,
      `const h = <Link to="/p/x/distribution/outlets">Channels</Link>;`,
      `const i = <p>{"The \`outlet\` id stays direct."}</p>;`,
      `const j = "Set dist_outlets.platforms or outletCapabilities.binaryUpdates";`,
      `const k = <Origin label="Automatic grant" />;`,
      `switch (kind) { case "Outlet": break; }`,
      `console.warn("Outlet missing");`,
      `const l = new RegExp("grant (\\\\w+)");`,
      `const m = s.startsWith("Grants ");`,
    ].join("\n");
    expect(lintCopy(ok)).toEqual([]);
  });

  it("reads code-shaped tokens out of a sentence before matching", () => {
    expect(proseOf("Run `pkey outlets` then open …/outlets/<id>")).toBe(
      "Run then open",
    );
    expect(proseOf("outletId and dist_outlets.kind")).toBe("and");
    expect(proseOf("The outlet stays.")).toBe("The outlet stays.");
  });
});
