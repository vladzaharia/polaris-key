/**
 * The docs lints (style guide, "What enforces it"): the mechanical writing rules, run site-wide.
 *
 *   tsx scripts/lint-docs.ts            fail on a hit the ledger does not know, and on a ledger
 *                                       entry that no longer hits (the ledger only shrinks)
 *   tsx scripts/lint-docs.ts --update   rewrite lint-debt.json from today's hits
 *
 * Rules: frontmatter (type, lastReviewed), type skeletons and budgets, banned words, time words,
 * future tense, programme ids, counts, Help's word list, `pkey` commands and HTTP paths. Stubs
 * (`status: "stub"`), generated pages and unpublished templates are not linted.
 *
 * A package that writes a page clears that page's entries from `lint-debt.json` in the same
 * change. A new hit on any page fails, so debt cannot grow.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { COMMANDS, COMMON_OPTIONS } from "../../cli/src/help";
import { allIds, contentRoot, fileFor, splitFrontmatter } from "./site-map.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
export const ledgerFile = join(docsRoot, "lint-debt.json");
const openapiFile = join(
  docsRoot,
  "..",
  "worker",
  "openapi",
  "polaris-key.v3.yaml",
);

export const RULES = [
  "frontmatter-type",
  "frontmatter-last-reviewed",
  "type-skeleton",
  "banned-word",
  "time-word",
  "future-tense",
  "programme-id",
  "count",
  "help-word",
  "pkey-command",
  "http-path",
] as const;
export type Rule = (typeof RULES)[number];

export interface Hit {
  id: string;
  rule: Rule;
  line: number;
  text: string;
}

export interface Facts {
  /** Command name -> every flag the CLI's help mentions for it. */
  commands: ReadonlyMap<string, ReadonlySet<string>>;
  /** Flags every command takes. */
  commonFlags: ReadonlySet<string>;
  /** OpenAPI operations: method and a matcher for the path. */
  routes: readonly { method: string; re: RegExp }[];
}

// ── facts ─────────────────────────────────────────────────────────────────────────────────────

const FLAG = /--[a-z][a-z0-9-]*/g;

export function loadFacts(): Facts {
  const commands = new Map<string, Set<string>>();
  for (const c of COMMANDS)
    commands.set(c.name, new Set(JSON.stringify(c).match(FLAG) ?? []));
  const commonFlags = new Set(
    COMMON_OPTIONS.flatMap(([term]) => term.match(FLAG) ?? []),
  );
  const spec = yaml.load(readFileSync(openapiFile, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const routes: { method: string; re: RegExp }[] = [];
  for (const [path, ops] of Object.entries(spec.paths))
    for (const method of Object.keys(ops))
      if (/^(get|post|put|patch|delete)$/.test(method))
        routes.push({ method: method.toUpperCase(), re: pathMatcher(path) });
  return { commands, commonFlags, routes };
}

/** `/{product}/x/{id}` matches `/acme/x/abc`, `/:product/x/<id>` and `/{slug}/x/{id}`. */
export function pathMatcher(template: string): RegExp {
  const source = template
    .split("/")
    .map((seg) =>
      /^\{.+\}$/.test(seg)
        ? "[^/]+"
        : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${source}/?$`);
}

// ── rules ─────────────────────────────────────────────────────────────────────────────────────

const BANNED =
  /\b(seamless(?:ly)?|powerful|robust|simply|just|easy|easily|effortless(?:ly)?|leverag(?:e|es|ed|ing)|utiliz(?:e|es|ed|ing)|out of the box|best-in-class)\b|!(?=\s|$)/gi;

const TIME =
  /\b(currently|recently|soon|coming soon|at the moment|for now|in the future|what's new|now supports)\b/gi;

const FUTURE = /\b(will|won't|going to)\b/gi;

/** Programme and plan ids a reader cannot resolve. */
const PROGRAMME_ID =
  /\b(?:(?:LX|ST|SP|CM|UK|DOC|AX|HA|PX|PS|WP|P[0-5]|[ADFIRTU])-\d{1,3}[a-z]?|P[0-5]-\d{2}[a-z]?)\b|\bplans\/[A-Za-z0-9-]+\.md|\bdocs\/research\//g;

const NUMBER_WORD =
  "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty";
const COUNT = new RegExp(
  `\\b(?:the |all |our |these |those )?(?:${NUMBER_WORD}) (?:opt-in |built-in |new )?(?:services|SDKs|surfaces|features|kits|platforms|outlets|channels|doors|sections|steps|pillars)\\b|\\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth) (?:SDK|service|kit|surface)\\b`,
  "gi",
);

/** Developer words Help does not use (style guide section 5.2). */
const HELP_WORDS =
  /\b(products?|tenants?|platform|operators?|console|customers?|end users?|tiers?|entitlements?|fingerprints?|attestation|hardware hash|OIDC|SSO|IdP|SDKs?|APIs?|endpoints?|tokens?|manifests?|webhooks?|JSON|CLI|sessions?|seats?|machines?)\b/gi;

/** The prose of a page: no code, no link targets, no comments, no imports. */
export interface Line {
  n: number;
  text: string;
  fence: boolean;
}

export function lines(body: string, firstLine: number): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  let comment = false;
  body.split("\n").forEach((raw, i) => {
    const n = firstLine + i;
    const m = /^\s*(```+|~~~+)/.exec(raw);
    if (m !== null) {
      if (fence === null) fence = m[1]!;
      else if (raw.trim().startsWith(fence)) fence = null;
      out.push({ n, text: raw, fence: true });
      return;
    }
    if (fence !== null) {
      out.push({ n, text: raw, fence: true });
      return;
    }
    let text = raw;
    if (comment || text.includes("{/*")) {
      const end = text.indexOf("*/}");
      if (end === -1) {
        comment = true;
        text = "";
      } else {
        text = text.slice(end + 3);
        comment = false;
      }
    }
    if (/^import\s/.test(text)) text = "";
    out.push({ n, text, fence: false });
  });
  return out;
}

/** A prose line with inline code, link targets and HTML tags removed. */
export function prose(text: string): string {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

const wordCount = (s: string): number =>
  (s.match(/[A-Za-z0-9'’-]+/g) ?? []).length;

export interface PageInfo {
  id: string;
  data: Record<string, unknown>;
  body: string;
  /** The first body line number in the file. */
  firstLine: number;
}

const GENERATED = /GENERATED PAGE/;

export function isLinted(page: PageInfo): boolean {
  const base = page.id.split("/").pop()!;
  return (
    page.data.status !== "stub" &&
    !base.startsWith("_") &&
    !GENERATED.test(page.body)
  );
}

export function lintPage(page: PageInfo, facts: Facts): Hit[] {
  if (!isLinted(page)) return [];
  const hits: Hit[] = [];
  const hit = (rule: Rule, line: number, text: string): void => {
    hits.push({ id: page.id, rule, line, text });
  };
  const type = page.data.type as string | undefined;
  if (type === undefined) hit("frontmatter-type", 1, "no type");
  if (page.data.lastReviewed === undefined)
    hit("frontmatter-last-reviewed", 1, "no lastReviewed");

  const all = lines(page.body, page.firstLine);
  const isHelp = page.id.startsWith("help/");

  for (const l of all) {
    if (l.fence) {
      commandHits(l, facts, hit);
      httpHits(l, facts, hit);
      continue;
    }
    for (const span of l.text.matchAll(/`([^`]+)`/g)) {
      const code = span[1]!;
      if (/^pkey\s/.test(code)) commandHits({ ...l, text: code }, facts, hit);
      if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(code))
        httpHits({ ...l, text: code }, facts, hit);
    }
    const p = prose(l.text);
    for (const m of p.matchAll(BANNED)) hit("banned-word", l.n, m[0]);
    for (const m of p.matchAll(TIME)) hit("time-word", l.n, m[0]);
    for (const m of p.matchAll(FUTURE)) hit("future-tense", l.n, m[0]);
    for (const m of l.text.replace(/\]\([^)]*\)/g, "]").matchAll(PROGRAMME_ID))
      hit("programme-id", l.n, m[0]);
    for (const m of p.matchAll(COUNT)) hit("count", l.n, m[0]);
    if (isHelp)
      for (const m of p.matchAll(HELP_WORDS)) hit("help-word", l.n, m[0]);
  }
  if (type !== undefined) skeletonHits(type, page, all, hit);
  return hits;
}

type HitFn = (rule: Rule, line: number, text: string) => void;

const PKEY_CMD = /(?<![\w./-])pkey\s+([a-z][a-z-]*)((?:\s+[^\n|]*)?)/;

function commandHits(l: Line, facts: Facts, hit: HitFn): void {
  const text = l.text.replace(/^\s*\$\s*/, "");
  const m = PKEY_CMD.exec(text);
  if (m === null || /<[a-z-]+>/.test(m[1]!)) return;
  if (!l.fence && !/^pkey\s/.test(text)) return;
  const name = m[1]!;
  const known = facts.commands.get(name);
  if (known === undefined) {
    if (name !== "help") hit("pkey-command", l.n, `pkey ${name}`);
    return;
  }
  for (const flag of m[2]!.match(FLAG) ?? [])
    if (!known.has(flag) && !facts.commonFlags.has(flag))
      hit("pkey-command", l.n, `pkey ${name} ${flag}`);
}

const HTTP = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-./{}:<>*]*)/g;

function httpHits(l: Line, facts: Facts, hit: HitFn): void {
  for (const m of l.text.matchAll(HTTP)) {
    const method = m[1]!;
    const path = m[2]!
      .replace(/\?.*$/, "")
      .split("/")
      .map((seg) => (/^(:.+|<.+>|\{.+\})$/.test(seg) ? "x" : seg))
      .join("/");
    // Product routes are often written without their `/{product}` mount ("POST /license/token").
    const forms = [path, `/x${path}`];
    if (
      !facts.routes.some(
        (r) => r.method === method && forms.some((f) => r.re.test(f)),
      )
    )
      hit("http-path", l.n, `${method} ${m[2]}`);
  }
}

// ── type skeletons (README section 2) ────────────────────────────────────────────────────────

const BUDGETS: Record<string, number> = {
  overview: 250,
  quickstart: 900,
  "how-to": 1200,
  concept: 1500,
  reference: 3000,
  help: 600,
  runbook: 1500,
};

function skeletonHits(
  type: string,
  page: PageInfo,
  all: readonly Line[],
  hit: HitFn,
): void {
  const proseLines = all.filter(
    (l) =>
      !l.fence && !/^\s*(\||<|import\s)/.test(l.text) && l.text.trim() !== "",
  );
  const words = proseLines.reduce((n, l) => n + wordCount(prose(l.text)), 0);
  const budget = BUDGETS[type];
  if (budget !== undefined && words > budget)
    hit("type-skeleton", 1, `${type}: ${words} words, budget ${budget}`);
  const fences = all.filter((l) => l.fence && /^\s*(```|~~~)/.test(l.text));
  const numbered = all.filter((l) => !l.fence && /^\s*\d+\.\s/.test(l.text));
  const h2s = all.filter((l) => !l.fence && /^## /.test(l.text));
  switch (type) {
    case "overview":
      if (fences.length > 0)
        hit("type-skeleton", fences[0]!.n, "overview: no code");
      break;
    case "quickstart": {
      const steps = h2s.filter((l) => /^## \d+\./.test(l.text));
      if (steps.length === 0)
        hit("type-skeleton", 1, "quickstart: no numbered H2 steps");
      if (steps.length > 8)
        hit("type-skeleton", 1, `quickstart: ${steps.length} steps, budget 8`);
      break;
    }
    case "how-to":
      if (numbered.length === 0)
        hit("type-skeleton", 1, "how-to: no numbered steps");
      break;
    case "troubleshooting":
      for (const l of h2s)
        if (l.text.length - 3 > 70)
          hit(
            "type-skeleton",
            l.n,
            "troubleshooting: heading over 70 characters",
          );
      break;
    case "help":
      if (fences.length > 0)
        hit("type-skeleton", fences[0]!.n, "help: no code blocks");
      break;
    case "runbook":
      if (!/\bVerify\b/.test(page.body))
        hit("type-skeleton", 1, "runbook: no Verify step");
      if (!/\bRoll back\b/.test(page.body))
        hit("type-skeleton", 1, "runbook: no Roll back step");
      break;
    default:
  }
}

// ── the site, and the ledger ──────────────────────────────────────────────────────────────────

export function readPage(id: string, root = contentRoot): PageInfo {
  const text = readFileSync(fileFor(id, root)!, "utf8");
  const { data, body } = splitFrontmatter(text);
  const firstLine = text.slice(0, text.length - body.length).split("\n").length;
  return { id, data, body, firstLine };
}

export function lintSite(facts: Facts = loadFacts()): Hit[] {
  return allIds().flatMap((id) => lintPage(readPage(id), facts));
}

export type Ledger = Record<string, Partial<Record<Rule, number>>>;

export function tally(hits: readonly Hit[]): Ledger {
  const out: Ledger = {};
  for (const h of hits) {
    const page = (out[h.id] ??= {});
    page[h.rule] = (page[h.rule] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

export interface LedgerDiff {
  /** Hits the ledger does not allow. */
  added: string[];
  /** Ledger allowances nothing hits any more: remove them. */
  stale: string[];
}

export function compare(actual: Ledger, ledger: Ledger): LedgerDiff {
  const added: string[] = [];
  const stale: string[] = [];
  const ids = new Set([...Object.keys(actual), ...Object.keys(ledger)]);
  for (const id of [...ids].sort()) {
    const rules = new Set([
      ...Object.keys(actual[id] ?? {}),
      ...Object.keys(ledger[id] ?? {}),
    ]) as Set<Rule>;
    for (const rule of rules) {
      const have = actual[id]?.[rule] ?? 0;
      const allowed = ledger[id]?.[rule] ?? 0;
      if (have > allowed)
        added.push(`${id}: ${rule} ${have} (ledger ${allowed})`);
      if (have < allowed)
        stale.push(`${id}: ${rule} ${have} (ledger ${allowed})`);
    }
  }
  return { added, stale };
}

export function readLedger(): Ledger {
  return (JSON.parse(readFileSync(ledgerFile, "utf8")) as { debt: Ledger })
    .debt;
}

export function writeLedger(debt: Ledger): void {
  writeFileSync(
    ledgerFile,
    JSON.stringify(
      {
        $comment:
          "Today's hits of scripts/lint-docs.ts, by page and rule. It only shrinks: a new hit fails the lint, and so does an entry nothing hits any more. A package that writes a page clears the page's entries in the same change; `tsx scripts/lint-docs.ts --update` rewrites the file.",
        version: 1,
        debt,
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = lintSite();
  const actual = tally(hits);
  if (process.argv.includes("--update")) {
    writeLedger(actual);
    console.log(
      `lint-docs: ledger written, ${hits.length} hits on ${Object.keys(actual).length} pages`,
    );
  } else {
    const { added, stale } = compare(actual, readLedger());
    if (added.length > 0 || stale.length > 0) {
      for (const a of added) console.error(`new: ${a}`);
      for (const s of stale)
        console.error(`cleared (remove from lint-debt.json): ${s}`);
      for (const h of hits.filter((h) =>
        added.some((a) => a.startsWith(`${h.id}: ${h.rule} `)),
      ))
        console.error(`  ${h.id}:${h.line} ${h.rule} "${h.text}"`);
      process.exit(1);
    }
    console.log(
      `lint-docs: ${hits.length} known hits on ${Object.keys(actual).length} pages, none new`,
    );
  }
}
