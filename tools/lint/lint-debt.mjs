#!/usr/bin/env node
/**
 * The one lint-debt ledger mechanism (P0-46.1). Plain Node ESM, no dependencies, so any CI lane
 * can run it before an install.
 *
 *   node tools/lint/lint-debt.mjs check|record --tool <id> --ledger <path> [--input <file>]
 *
 * A tool's adapter (`adapters/<id>.mjs`) turns the tool's raw output into findings. The ledger
 * holds today's findings per file and rule and only shrinks: a count above the ledger fails, and
 * so does an entry the tool no longer reports. Exit 0 ok, 1 debt drift, 2 usage/adapter error.
 * Contract and ledger format: tools/lint/README.md.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");
const DEFAULT_COMMENT =
  "Today's findings of the lane's linters, by file and rule. It only shrinks: a new finding fails the check, and so does an entry the tool no longer reports. Fix findings, then re-record with the lane's `tools/lint.sh record`.";

/** Always out of scope, whatever a tool reports. */
const ALWAYS_EXCLUDED = /(^|\/)(build|\.venv|node_modules|dist)\//;

/** A usage or adapter error: the CLI exits 2 on it. */
export class LintDebtError extends Error {}

// Same glob dialect as tools/generators.ts: `**` any depth, `*` within a segment, `{a,b}`, trailing `/`.
function esc(s) {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}
export function globToRegExp(glob) {
  const g = glob.endsWith("/") ? `${glob}**` : glob;
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      out += `(?:${g
        .slice(i + 1, end)
        .split(",")
        .map(esc)
        .join("|")})`;
      i = end;
    } else if (c === "?") out += "[^/]";
    else out += esc(c);
  }
  return new RegExp(`^${out}$`);
}

/** Read the registry snapshot (`generated.json`: `{globs: string[]}`) as a matcher. */
export function loadGenerated(path = join(HERE, "generated.json")) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LintDebtError(`cannot read ${path}: ${e.message}`);
  }
  if (!Array.isArray(raw.globs))
    throw new LintDebtError(`${path} has no "globs" array`);
  return raw.globs.map(globToRegExp);
}

/** True for a file no linter should hold us to: build output, vendored trees, generated files. */
export function excluded(file, generated = loadGenerated()) {
  return ALWAYS_EXCLUDED.test(file) || generated.some((re) => re.test(file));
}

export async function loadAdapter(tool) {
  if (!/^[a-z][a-z0-9-]*$/.test(tool))
    throw new LintDebtError(`bad tool id "${tool}"`);
  const path = join(HERE, "adapters", `${tool}.mjs`);
  if (!existsSync(path))
    throw new LintDebtError(`no adapter for "${tool}" (${path})`);
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.parse !== "function")
    throw new LintDebtError(`adapter "${tool}" does not export parse()`);
  return mod;
}

/** Run an adapter over raw output and validate what it returns. */
export function findingsOf(tool, adapter, text, root, generated) {
  let found;
  try {
    found = adapter.parse(text, { root });
  } catch (e) {
    throw new LintDebtError(`adapter "${tool}": ${e.message}`);
  }
  if (!Array.isArray(found))
    throw new LintDebtError(`adapter "${tool}": parse() must return an array`);
  const out = [];
  for (const f of found) {
    const { file, rule } = f ?? {};
    if (typeof file !== "string" || typeof rule !== "string")
      throw new LintDebtError(
        `adapter "${tool}": a finding needs string file and rule`,
      );
    if (!rule.startsWith(`${tool}:`))
      throw new LintDebtError(
        `adapter "${tool}": rule "${rule}" lacks the "${tool}:" prefix`,
      );
    if (
      file === "" ||
      file.startsWith("/") ||
      file.includes("\\") ||
      /(^|\/)\.\.(\/|$)/.test(file)
    )
      throw new LintDebtError(
        `adapter "${tool}": file "${file}" is not repo-relative with "/"`,
      );
    if (!excluded(file, generated)) out.push({ file, rule });
  }
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Count findings: `{file: {rule: n}}`, keys sorted. */
export function tally(findings) {
  const flat = new Map();
  for (const { file, rule } of findings) {
    const k = `${file}\0${rule}`;
    flat.set(k, (flat.get(k) ?? 0) + 1);
  }
  return nest([...flat].map(([k, n]) => [...k.split("\0"), n]));
}

function nest(rows) {
  const debt = {};
  for (const [file, rule, n] of [...rows].sort(
    (a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]),
  )) {
    (debt[file] ??= {})[rule] = n;
  }
  return debt;
}

const rowsOf = (debt, prefix) =>
  Object.entries(debt ?? {}).flatMap(([file, rules]) =>
    Object.entries(rules)
      .filter(([rule]) => rule.startsWith(prefix))
      .map(([rule, n]) => [file, rule, n]),
  );

export function readLedger(path) {
  if (!existsSync(path)) return { version: 1, debt: {} };
  let l;
  try {
    l = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LintDebtError(`cannot read ledger ${path}: ${e.message}`);
  }
  if (l.version !== 1 || typeof l.debt !== "object" || l.debt === null)
    throw new LintDebtError(`${path}: expected {"version": 1, "debt": {...}}`);
  return l;
}

/**
 * Compare today's findings with the ledger, for the rules of one tool only (a ledger may be shared
 * by a lane's tools). Returns sorted `added` (above ledger) and `cleared` (below ledger, incl. gone).
 */
export function diff(tool, findings, ledger) {
  const prefix = `${tool}:`;
  const have = new Map(
    rowsOf(tally(findings), prefix).map(([f, r, n]) => [`${f}\0${r}`, n]),
  );
  const want = new Map(
    rowsOf(ledger.debt, prefix).map(([f, r, n]) => [`${f}\0${r}`, n]),
  );
  const added = [];
  const cleared = [];
  for (const k of new Set([...have.keys(), ...want.keys()])) {
    const h = have.get(k) ?? 0;
    const w = want.get(k) ?? 0;
    const [file, rule] = k.split("\0");
    if (h > w) added.push({ file, rule, have: h, ledger: w });
    else if (h < w) cleared.push({ file, rule, have: h, ledger: w });
  }
  const order = (a, b) => cmp(a.file, b.file) || cmp(a.rule, b.rule);
  return { added: added.sort(order), cleared: cleared.sort(order) };
}

/** The ledger after `record`: this tool's rules replaced, other tools' kept. */
export function recorded(tool, findings, ledger) {
  const prefix = `${tool}:`;
  const rows = [
    ...rowsOf(ledger.debt, "").filter(([, rule]) => !rule.startsWith(prefix)),
    ...rowsOf(tally(findings), prefix),
  ];
  return {
    ...(ledger["$comment"] === undefined
      ? { $comment: DEFAULT_COMMENT }
      : { $comment: ledger["$comment"] }),
    version: 1,
    debt: nest(rows),
  };
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (
      !["--tool", "--ledger", "--input", "--root", "--generated"].includes(k) ||
      v === undefined
    )
      throw new LintDebtError(`unknown or incomplete option "${k}"`);
    opts[k.slice(2)] = v;
  }
  if (mode !== "check" && mode !== "record")
    throw new LintDebtError(
      "usage: lint-debt.mjs check|record --tool <id> --ledger <path> [--input <file>]",
    );
  if (!opts.tool || !opts.ledger)
    throw new LintDebtError("--tool and --ledger are required");
  return opts;
}

/** Run the CLI; returns `{code, out}` (the lines to print) instead of exiting, for tests. */
export async function run(argv, stdin = () => readFileSync(0, "utf8")) {
  const out = [];
  try {
    const o = parseArgs(argv);
    const root = resolve(o.root ?? DEFAULT_ROOT);
    const adapter = await loadAdapter(o.tool);
    const generated = loadGenerated(o.generated);
    const text = o.input ? readFileSync(o.input, "utf8") : stdin();
    const findings = findingsOf(o.tool, adapter, text, root, generated);
    const ledgerPath = resolve(o.ledger);
    const ledger = readLedger(ledgerPath);
    if (o.mode === "record") {
      writeFileSync(
        ledgerPath,
        `${JSON.stringify(recorded(o.tool, findings, ledger), null, 2)}\n`,
      );
      out.push(
        `recorded ${findings.length} ${o.tool} finding(s) in ${o.ledger}`,
      );
      return { code: 0, out };
    }
    const { added, cleared } = diff(o.tool, findings, ledger);
    for (const a of added)
      out.push(`new: ${a.file} ${a.rule} ${a.have} (ledger ${a.ledger})`);
    for (const c of cleared)
      out.push(
        `cleared (re-record): ${c.file} ${c.rule} ${c.have} (ledger ${c.ledger})`,
      );
    if (added.length + cleared.length === 0)
      out.push(
        `ok: ${findings.length} ${o.tool} finding(s), none beyond ${o.ledger}`,
      );
    return { code: added.length + cleared.length > 0 ? 1 : 0, out };
  } catch (e) {
    if (!(e instanceof LintDebtError)) throw e;
    out.push(`lint-debt: ${e.message}`);
    return { code: 2, out };
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const { code, out } = await run(process.argv.slice(2));
  for (const line of out) (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
