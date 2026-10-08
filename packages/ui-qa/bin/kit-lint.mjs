#!/usr/bin/env node
// The per-kit equivalents of the modernity lint (UI-KITS.md §7.3) as source rules over each native
// kit (SwiftUI, Compose, Godot, Qt) and the Node terminal kit (terminal-node). Zero dependencies, so each kit's CI lane runs it with plain
// Node and no install:
//
//   node packages/ui-qa/bin/kit-lint.mjs [--kit=swiftui,compose,godot,qt,terminal-node] [--record] [--json]
//
// Rules: packages/ui-qa/rules/kit-rules.json. Debt: packages/ui-qa/rules/kit-debt.json counts, per
// rule and file, the hits that existed when the lint landed; each kit's modernisation work package
// clears its own. The run fails on a hit beyond the recorded count (new debt) and on a recorded
// count above today's (stale debt: re-record with --record so the ledger only shrinks).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path, { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, "../../..");
const RULES = "packages/ui-qa/rules/kit-rules.json";
const DEBT = "packages/ui-qa/rules/kit-debt.json";

const DEBT_COMMENT =
  "Per-kit source-lint debt (bin/kit-lint.mjs): hits per rule and file that existed when the lint landed (UK-15), owned by each kit's modernisation work package (swiftui UK-07, compose UK-09, godot UK-11, qt UK-12). The lint fails on any hit beyond these counts and on a count above today's. Shrink it with: node packages/ui-qa/bin/kit-lint.mjs --record.";

function walk(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.includes(extname(name))) out.push(p);
  }
  return out;
}

/**
 * A repo-relative path with forward slashes on every OS, so rule excludes ("/ui/theme/") and debt
 * keys match on Windows too. `p` is injectable so the test can drive the win32 flavour.
 */
export function relPosix(root, file, p = path) {
  return p.relative(root, file).split(p.sep).join("/");
}

/** Scan the kits; returns every hit (before the debt ledger is applied). */
export function scan(root = DEFAULT_ROOT, kits = null, rulesFile = RULES) {
  const cfg = JSON.parse(readFileSync(resolve(root, rulesFile), "utf8"));
  const hits = [];
  for (const [kit, k] of Object.entries(cfg.kits)) {
    if (kits && !kits.includes(kit)) continue;
    const rules = cfg.rules
      .filter((r) => r.kit === kit)
      .map((r) => ({
        ...r,
        re: new RegExp(r.pattern),
        skip: (r.exclude ?? []).map((x) => new RegExp(x)),
      }));
    for (const rootDir of k.roots) {
      for (const file of walk(resolve(root, rootDir), k.extensions, [])) {
        const text = readFileSync(file, "utf8");
        if (/GENERATED/.test(text.slice(0, 400))) continue;
        const rel = relPosix(root, file);
        text.split("\n").forEach((line, i) => {
          for (const r of rules) {
            if (r.skip.some((x) => x.test(rel))) continue;
            if (!r.re.test(line)) continue;
            if (new RegExp(`ui-lint: allow ${r.id}\\b.{8,}`).test(line))
              continue;
            hits.push({
              kit,
              rule: r.id,
              file: rel,
              line: i + 1,
              text: line.trim(),
              detail: r.says,
            });
          }
        });
      }
    }
  }
  return hits;
}

const key = (h) => `${h.rule}\u0000${h.file}`;

/** Apply the debt ledger: findings are hits beyond the recorded counts, plus stale entries. */
export function lintKits(root = DEFAULT_ROOT, kits = null, opts = {}) {
  const hits = scan(root, kits, opts.rulesFile);
  let debt = { debt: [] };
  try {
    debt = JSON.parse(
      readFileSync(resolve(root, opts.debtFile ?? DEBT), "utf8"),
    );
  } catch {
    /* no ledger: every hit is new */
  }
  const allowedCount = new Map(debt.debt.map((d) => [key(d), d.count]));
  const counts = new Map();
  for (const h of hits) counts.set(key(h), (counts.get(key(h)) ?? 0) + 1);
  const findings = [];
  const seen = new Map();
  for (const h of hits) {
    const k = key(h);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const allowed = allowedCount.get(k) ?? 0;
    // Report every hit of a rule/file pair that grew, so the new one is in the list.
    if ((counts.get(k) ?? 0) > allowed) findings.push(h);
  }
  const stale = debt.debt
    .filter(
      (d) =>
        (!kits || kits.includes(d.kit)) && (counts.get(key(d)) ?? 0) < d.count,
    )
    .map((d) => ({
      kit: d.kit,
      rule: d.rule,
      file: d.file,
      line: 0,
      text: "",
      detail: `stale debt: ${counts.get(key(d)) ?? 0} hits now, ${d.count} recorded; re-record with --record`,
    }));
  return { hits, findings: [...findings, ...stale] };
}

export function record(root = DEFAULT_ROOT, opts = {}) {
  const hits = scan(root, null, opts.rulesFile);
  const counts = new Map();
  for (const h of hits) {
    const k = key(h);
    const cur = counts.get(k) ?? {
      kit: h.kit,
      rule: h.rule,
      file: h.file,
      count: 0,
    };
    cur.count++;
    counts.set(k, cur);
  }
  const debt = [...counts.values()].sort((a, b) =>
    `${a.kit}${a.rule}${a.file}`.localeCompare(`${b.kit}${b.rule}${b.file}`),
  );
  writeFileSync(
    resolve(root, opts.debtFile ?? DEBT),
    JSON.stringify({ $comment: DEBT_COMMENT, debt }, null, 2) + "\n",
  );
  return debt;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const kitArg = args.find((a) => a.startsWith("--kit="));
  const kits = kitArg ? kitArg.slice(6).split(",") : null;
  if (args.includes("--record")) {
    const debt = record();
    console.log(`kit-lint: recorded ${debt.length} debt entries in ${DEBT}`);
  } else {
    const { hits, findings } = lintKits(DEFAULT_ROOT, kits);
    if (args.includes("--json")) console.log(JSON.stringify(findings, null, 2));
    else {
      for (const f of findings)
        console.log(
          `✗ ${f.kit} · ${f.file}${f.line ? `:${f.line}` : ""} · ${f.rule}\n    ${f.text ? f.text + "\n    " : ""}${f.detail}`,
        );
      console.log(
        findings.length
          ? `kit-lint: ${findings.length} finding(s)`
          : `kit-lint: clean (${hits.length} hit(s), all recorded debt)`,
      );
    }
    process.exitCode = findings.length ? 1 : 0;
  }
}
