#!/usr/bin/env node
// Re-run the S-07 policy checklist against the live primary sources.
//
//   node recheck.mjs                 all 18 rows
//   node recheck.mjs --rows 1-5,12,14   only those rows; ranges allowed (what a connector package re-runs)
//   node recheck.mjs --json          machine-readable result on stdout
//   node recheck.mjs --out DIR       where snapshots go (default ./out, git-ignored)
//
// Exit code 0: every quote still present (and no guarded changelog has grown). 1: at least one row needs a
// human re-read. 2: bad usage (unparseable or unknown --rows), nothing was checked.
// Node 22+ (global fetch). No dependencies. The harness never authenticates and never writes to any site.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rows } from "./checks.mjs";
import {
  doccToText,
  firstMatch,
  hasQuote,
  htmlToText,
  mdToText,
  norm,
  parseRows,
  sha256,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
let wanted = null;
if (args.includes("--rows")) {
  try {
    wanted = new Set(parseRows(opt("--rows", "")));
  } catch (e) {
    console.error(`recheck: ${e.message}`);
    process.exit(2);
  }
  const known = new Set(rows.map((r) => r.row));
  const unknown = [...wanted].filter((n) => !known.has(n));
  if (unknown.length) {
    console.error(
      `recheck: --rows names row(s) not in checks.mjs: ${unknown.join(", ")} (rows ${Math.min(...known)}-${Math.max(...known)})`,
    );
    process.exit(2);
  }
}
const outDir = opt("--out", join(here, "out"));
const UA = "Mozilla/5.0 (compatible; polaris-key-policy-recheck/1.0)";

async function get(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  return { status: res.status, finalUrl: res.url, body: await res.text() };
}

function extract(kind, body) {
  if (kind === "html") return { text: htmlToText(body), json: null };
  if (kind === "md") return { text: mdToText(body), json: null };
  if (kind === "docc")
    return { text: doccToText(JSON.parse(body)), json: JSON.parse(body) };
  const json = JSON.parse(body);
  return { text: JSON.stringify(json), json };
}

async function checkSource(s) {
  const r = {
    id: s.id,
    url: s.url,
    retrievedAt: new Date().toISOString(),
    ok: false,
    failures: [],
    passed: 0,
  };
  let res;
  try {
    res = await get(s.url);
  } catch (e) {
    r.failures.push(`fetch failed: ${e.message}`);
    return r;
  }
  r.status = res.status;
  r.bytes = res.body.length;
  if (s.canary) {
    const title = firstMatch(res.body, /<title>([^<]*)/i) ?? "";
    r.pageTitle = title;
    if (title.includes(s.canary.title)) r.passed++;
    else
      r.failures.push(
        `canary: expected a "${s.canary.title}" page, got "${title}"; the moved page is back, re-read it`,
      );
    r.ok = r.failures.length === 0;
    return r;
  }
  if (res.status !== 200) {
    r.failures.push(`HTTP ${res.status} at ${res.finalUrl}`);
    return r;
  }
  let text, json;
  try {
    ({ text, json } = extract(s.kind, res.body));
  } catch (e) {
    r.failures.push(`could not parse as ${s.kind}: ${e.message}`);
    return r;
  }
  r.textSha256 = sha256(norm(text));
  r.pageDate = s.date ? firstMatch(res.body, s.date) : null;
  for (const q of s.quotes ?? []) {
    if (hasQuote(text, q)) r.passed++;
    else
      r.failures.push(
        `quote missing: ${q.length > 110 ? q.slice(0, 107) + "..." : q}`,
      );
  }
  for (const [re, label] of s.regexes ?? []) {
    if (re.test(norm(text))) r.passed++;
    else r.failures.push(`pattern missing: ${label}`);
  }
  if (s.expect) {
    const f = s.expect({ text, json, raw: res.body });
    if (f.length === 0) r.passed++;
    r.failures.push(...f);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `row${String(s.row).padStart(2, "0")}-${s.id}.txt`),
    text,
  );
  r.ok = r.failures.length === 0;
  return r;
}

const results = [];
for (const row of rows) {
  if (wanted && !wanted.has(row.row)) continue;
  const sources = [];
  for (const s of row.sources)
    sources.push(await checkSource({ ...s, row: row.row }));
  const ok = sources.every((s) => s.ok);
  results.push({ row: row.row, ok, dependsOn: row.dependsOn ?? [], sources });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "results.json"),
  JSON.stringify(
    { ranAt: new Date().toISOString(), node: process.version, results },
    null,
    2,
  ),
);

if (flag("--json")) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) {
    console.log(
      `row ${String(r.row).padStart(2)}  ${r.ok ? "PASS" : "CHECK"}${r.dependsOn.length ? `  (also read rows ${r.dependsOn.join(", ")})` : ""}`,
    );
    for (const s of r.sources) {
      const meta = [
        s.status ? `HTTP ${s.status}` : "no response",
        s.pageDate ? `page date ${s.pageDate}` : null,
        `${s.passed} ok`,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`   ${s.ok ? "ok   " : "FAIL "} ${s.id.padEnd(22)} ${meta}`);
      for (const f of s.failures) console.log(`          - ${f}`);
    }
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - bad}/${results.length} rows pass; snapshots in ${outDir}`,
  );
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
