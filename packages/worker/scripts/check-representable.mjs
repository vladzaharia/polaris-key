#!/usr/bin/env node
// check:representable — list every stored value in D1 that would trip the Worker's signer guard
// (plans/P3-01.md §2.2, "The D1 check"; P3-12).
//
// From P3-12 on, the Worker refuses to sign a document a wire-v4 verifier would refuse, and its
// write paths refuse such values at write. Values stored BEFORE that still exist. One that
// trips the guard becomes a pruned config value or a `500 document_not_representable` on that
// product's licence documents, for v3 clients too. So an operator runs this ONCE against
// production D1 before the first deploy of a Worker that contains P3-12, and fixes every value
// it flags in the console or the manifest (docs/RUNBOOK.md, "Deploy").
//
// It reads, through `wrangler d1 execute --json`:
//
//   - with `representabilityIssue`, the 8 JSON columns and the 12 text columns of COLUMNS;
//   - with rule 8's range, `tiers.policy_device_limit`;
//   - as warnings that do not block a deploy, `licenses.max_offline_days` and
//     `products.default_max_offline_days` when not an integer from 1 to 365.
//
// Text and JSON columns are read as `hex()`, so a lone surrogate the storage layer kept as
// WTF-8 bytes is seen as the ill-formed UTF-8 it is rather than as the U+FFFD a JSON
// renderer would print. Sealed secrets cannot be opened here; the config document's prune
// drops a flagged one at signing.
//
// Usage (from packages/worker):
//
//   pnpm check:representable                     production: --env prod --remote (the default)
//   pnpm check:representable -- --local [--persist-to DIR]   a local D1 (miniflare)
//   options: --env NAME, --database NAME, --config PATH, --json
//
// Exit status: 0 when nothing blocks a deploy (warnings may be listed), 1 when a value is
// flagged, 2 when the check could not run.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { numberInWireRange, representabilityIssue } from "@polaris-key/catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = 500;

/**
 * Every column the check reads, by table. `json` columns are parsed and walked, `text` columns
 * are one string each, `number` columns take rule 8's range, `warn` columns the 1–365 rule.
 * `key` names the row in a report.
 */
export const TABLES = [
  {
    table: "licenses",
    key: ["product", "id"],
    json: ["overrides_json", "channels_json"],
    text: ["name", "email", "tier_id", "min_version", "max_version"],
    warn: [{ column: "max_offline_days", nullable: true }],
  },
  { table: "devices", key: ["product", "device_id"], json: ["overrides_json"] },
  { table: "profiles", key: ["product", "id"], json: ["payload_json"] },
  {
    // Only the active catalog's defaults reach a document.
    table: "product_schema",
    key: ["product", "catalog_version"],
    json: ["catalog_json"],
    where: "active = 1",
  },
  {
    table: "provisioning_config",
    key: ["product", "claim"],
    json: ["entitlement_value_json"],
  },
  {
    table: "edge_mint_config",
    key: ["product", "id"],
    json: ["claims_template_json"],
    text: ["audience"],
  },
  {
    table: "tiers",
    key: ["product", "id"],
    json: ["channels_json"],
    text: ["id", "label", "min_version", "max_version"],
    number: ["policy_device_limit"],
  },
  {
    table: "products",
    key: ["slug"],
    text: ["signing_kid"],
    warn: [{ column: "default_max_offline_days", nullable: false }],
  },
  { table: "product_keys", key: ["product", "kid"], text: ["kid"] },
];

/** The 21 checked columns and the 2 warning columns, as `table.column`. */
export const CHECKED_COLUMNS = TABLES.flatMap((t) =>
  [...(t.json ?? []), ...(t.text ?? []), ...(t.number ?? [])].map(
    (c) => `${t.table}.${c}`,
  ),
);
export const WARNING_COLUMNS = TABLES.flatMap((t) =>
  (t.warn ?? []).map((w) => `${t.table}.${w.column}`),
);

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Decode a `hex()` column; `null` when the bytes are not well-formed UTF-8. */
export function decodeHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    return fatalUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** The flagged rule and pointer for one stored value, or null. */
export function inspectValue(kind, raw) {
  if (raw === null || raw === undefined) return null;
  if (kind === "number") {
    return typeof raw === "number" && !numberInWireRange(raw)
      ? { rule: "number-out-of-range", path: "" }
      : null;
  }
  const text = decodeHex(String(raw));
  // Ill-formed UTF-8 in a text column is a lone surrogate the storage layer kept as bytes.
  if (text === null) return { rule: "lone-surrogate", path: "" };
  if (kind === "text") return representabilityIssue(text);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { rule: "invalid-json", path: "" };
  }
  return representabilityIssue(value);
}

function offlineDaysOk(raw, nullable) {
  if (raw === null || raw === undefined) return nullable;
  return Number.isInteger(raw) && raw >= 1 && raw <= 365;
}

const quote = (name) => `"${name}"`;

/** One page's SELECT for a table: key columns raw, checked text/JSON columns as hex. */
export function pageSql(spec, afterRowid) {
  const cols = [
    "rowid AS __rowid",
    ...spec.key.map((k) => `${quote(k)} AS ${quote(`key:${k}`)}`),
    ...[...(spec.json ?? []), ...(spec.text ?? [])].map(
      (c) =>
        `CASE WHEN ${quote(c)} IS NULL THEN NULL ELSE hex(${quote(c)}) END AS ${quote(`hex:${c}`)}`,
    ),
    ...(spec.number ?? []).map((c) => `${quote(c)} AS ${quote(`num:${c}`)}`),
    ...(spec.warn ?? []).map(
      (w) => `${quote(w.column)} AS ${quote(`warn:${w.column}`)}`,
    ),
  ];
  const where = [`rowid > ${Number(afterRowid)}`, spec.where]
    .filter(Boolean)
    .join(" AND ");
  return `SELECT ${cols.join(", ")} FROM ${quote(spec.table)} WHERE ${where} ORDER BY rowid LIMIT ${PAGE}`;
}

/** Inspect one table's rows; pushes into `issues` and `warnings`. */
export function inspectRows(spec, rows, issues, warnings) {
  for (const row of rows) {
    const key = Object.fromEntries(spec.key.map((k) => [k, row[`key:${k}`]]));
    for (const [kind, columns] of [
      ["json", spec.json ?? []],
      ["text", spec.text ?? []],
    ]) {
      for (const column of columns) {
        const issue = inspectValue(kind, row[`hex:${column}`]);
        // A column that is not JSON at all is read defensively by the Worker (it is ignored,
        // never signed), so it is a warning worth fixing, not a deploy blocker.
        if (issue?.rule === "invalid-json")
          warnings.push({ table: spec.table, column, key, rule: issue.rule });
        else if (issue)
          issues.push({ table: spec.table, column, key, ...issue });
      }
    }
    for (const column of spec.number ?? []) {
      const issue = inspectValue("number", row[`num:${column}`]);
      if (issue) issues.push({ table: spec.table, column, key, ...issue });
    }
    for (const w of spec.warn ?? []) {
      const raw = row[`warn:${w.column}`];
      if (!offlineDaysOk(raw, w.nullable))
        warnings.push({
          table: spec.table,
          column: w.column,
          key,
          value: raw,
          rule: "offline-days-not-integer-1-365",
        });
    }
  }
}

/**
 * Run the whole check. `query(sql)` executes one or more `;`-separated statements and returns
 * one result-row array per statement. Tables page by rowid, one round of statements per page.
 */
export function runCheck(query) {
  const issues = [];
  const warnings = [];
  let pending = TABLES.map((spec) => ({ spec, after: 0 }));
  while (pending.length > 0) {
    const results = query(pending.map((p) => pageSql(p.spec, p.after)));
    const next = [];
    pending.forEach((p, i) => {
      const rows = results[i] ?? [];
      inspectRows(p.spec, rows, issues, warnings);
      if (rows.length === PAGE)
        next.push({ spec: p.spec, after: rows[rows.length - 1].__rowid });
    });
    pending = next;
  }
  return { issues, warnings };
}

/** A `query` that shells out to `wrangler d1 execute --json`. */
export function wranglerQuery(opts) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("wrangler/package.json");
  const bin = join(dirname(pkg), "bin", "wrangler.js");
  return (statements) => {
    const args = [
      bin,
      "d1",
      "execute",
      opts.database,
      "--json",
      "--command",
      statements.join(";\n"),
    ];
    if (opts.env) args.push("--env", opts.env);
    if (opts.config) args.push("--config", opts.config);
    if (opts.local) {
      args.push("--local");
      if (opts.persistTo) args.push("--persist-to", opts.persistTo);
    } else {
      args.push("--remote");
    }
    const run = spawnSync(process.execPath, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    if (run.status !== 0) {
      throw new Error(
        `wrangler d1 execute failed (exit ${run.status}):\n${run.stderr || run.stdout}`,
      );
    }
    const parsed = JSON.parse(run.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(
      (r) => r.results ?? [],
    );
  };
}

function parseArgs(argv) {
  const opts = {
    database: "polaris_key_prod",
    env: "prod",
    local: false,
    persistTo: undefined,
    config: undefined,
    json: false,
    cwd: join(HERE, ".."),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    else if (a === "--local") opts.local = true;
    else if (a === "--remote") opts.local = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--persist-to") opts.persistTo = argv[++i];
    else if (a === "--database") opts.database = argv[++i];
    else if (a === "--env") opts.env = argv[++i] || undefined;
    else if (a === "--config") opts.config = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const describeKey = (key) =>
  Object.entries(key)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
  let result;
  try {
    result = runCheck(wranglerQuery(opts));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
  const { issues, warnings } = result;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ issues, warnings }, null, 2)}\n`);
  } else {
    const target = opts.local ? "local D1" : `${opts.database} (remote)`;
    for (const i of issues)
      console.log(
        `FLAGGED  ${i.table}.${i.column} [${describeKey(i.key)}] ${i.path || "/"}: ${i.rule}`,
      );
    for (const w of warnings)
      console.log(
        w.rule === "invalid-json"
          ? `warning  ${w.table}.${w.column} [${describeKey(w.key)}]: not JSON (the Worker ignores it; fix it when convenient)`
          : `warning  ${w.table}.${w.column} [${describeKey(w.key)}]: ${JSON.stringify(w.value)} is not an integer from 1 to 365 (the builders floor it; fix it when convenient)`,
      );
    console.log(
      issues.length === 0
        ? `check:representable: ${target} is clean (${CHECKED_COLUMNS.length} columns checked, ${warnings.length} warning(s)).`
        : `check:representable: ${issues.length} flagged value(s) in ${target}. Fix each in the console or the manifest before deploying.`,
    );
  }
  process.exit(issues.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
