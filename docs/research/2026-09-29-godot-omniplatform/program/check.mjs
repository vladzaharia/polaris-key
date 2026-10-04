#!/usr/bin/env node
// Work-package graph tool for the Godot-on-Polaris-Key program. No dependencies; Node >= 22.
//
//   node check.mjs                      validate the graph and check INDEX.md is fresh (exit 1 on any problem)
//   node check.mjs --write-index        regenerate INDEX.md
//   node check.mjs --ready [--optional] list work packages whose dependencies are all done
//   node check.mjs --summary            counts and estimate totals per phase and status
//   node check.mjs --critical           the longest dependency chain by upper estimate
//   node check.mjs --show <id>          one work package, its dependencies and its dependants
//   node check.mjs --set <id> <status>  update one status in place (keeps the file's formatting)
//   node check.mjs --sync-briefs        rewrite each brief's Size / Depends on / Unblocks / Role rows from the graph

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = join(HERE, "workpackages.json");
const INDEX = join(HERE, "INDEX.md");
// A two-digit id, with an optional lower-case letter for packages split from one spike row
// (A-17a…g from notes/S-14 §10, A-18a…m from notes/S-15 §11).
const ID_RE = /^(P0|P1|P1b|P2|P2b|P3|P4|P5|P6|X|S|D|F|A|I)-\d{2}[a-z]?$/;
const DONE = new Set(["done", "dropped"]);

const raw = readFileSync(GRAPH, "utf8");
const doc = JSON.parse(raw);
const wps = doc.workPackages;
const byId = new Map(wps.map((w) => [w.id, w]));
const phaseIds = doc.phases.map((p) => p.id);

function validate() {
  const errors = [];
  const seen = new Set();
  for (const w of wps) {
    const at = `${w.id ?? "?"}:`;
    for (const k of [
      "id",
      "title",
      "phase",
      "lane",
      "role",
      "estimateWeeks",
      "deps",
      "planMode",
      "gates",
      "humanInputs",
      "repo",
      "optional",
      "refs",
      "brief",
      "status",
    ]) {
      if (!(k in w)) errors.push(`${at} missing field "${k}"`);
    }
    if (!ID_RE.test(w.id)) errors.push(`${at} id does not match ${ID_RE}`);
    if (seen.has(w.id)) errors.push(`${at} duplicate id`);
    seen.add(w.id);
    if (!w.id.startsWith(`${w.phase}-`))
      errors.push(`${at} id prefix does not match phase ${w.phase}`);
    if (!phaseIds.includes(w.phase))
      errors.push(`${at} unknown phase ${w.phase}`);
    if (!doc.roles.includes(w.role))
      errors.push(`${at} unknown role ${w.role}`);
    if (!doc.statuses.includes(w.status))
      errors.push(`${at} unknown status ${w.status}`);
    const [lo, hi] = w.estimateWeeks ?? [];
    if (
      !(typeof lo === "number" && typeof hi === "number" && lo > 0 && lo <= hi)
    )
      errors.push(`${at} estimateWeeks must be [min, max] with 0 < min <= max`);
    for (const d of w.deps ?? []) {
      if (d === w.id) errors.push(`${at} depends on itself`);
      else if (!byId.has(d)) errors.push(`${at} unknown dependency ${d}`);
      else if (byId.get(d).optional && !w.optional)
        errors.push(`${at} a required work package depends on optional ${d}`);
    }
    if (w.planMode && !w.gates.includes("plan-mode"))
      errors.push(
        `${at} planMode work packages must list the "plan-mode" gate`,
      );
    if (w.role === "pkey-wire-planner" && !w.planMode)
      errors.push(
        `${at} pkey-wire-planner packages are planning packages and must be planMode`,
      );
    if ("planRef" in w) {
      const ref = byId.get(w.planRef);
      if (!w.planMode)
        errors.push(`${at} planRef is only meaningful on a planMode package`);
      if (!ref) errors.push(`${at} planRef ${w.planRef} is not a work package`);
      else if (!ref.planMode)
        errors.push(`${at} planRef ${w.planRef} is not a planMode package`);
      else if (!w.deps.includes(w.planRef))
        errors.push(`${at} must depend on its planRef ${w.planRef}`);
    }
    const brief = join(HERE, w.brief ?? "");
    if (!existsSync(brief))
      errors.push(`${at} brief ${w.brief} does not exist`);
    else {
      const first = readFileSync(brief, "utf8").split("\n", 1)[0];
      if (!first.startsWith(`# ${w.id} `))
        errors.push(
          `${at} brief must start with "# ${w.id} " (found "${first.slice(0, 40)}")`,
        );
    }
  }
  // brief headers derived from the graph
  const deps2 = dependantsOf();
  for (const w of wps) {
    const brief = join(HERE, w.brief ?? "");
    if (!existsSync(brief) || !byId.has(w.id)) continue;
    const text = readFileSync(brief, "utf8");
    const want = headerRows(w, deps2);
    for (const label of ["Depends on", "Unblocks"]) {
      const got = rowValue(text, label);
      if (got === undefined) {
        errors.push(`${w.id}: brief has no "${label}" row`);
        continue;
      }
      const a = [...new Set([...got.matchAll(ID_IN_TEXT)].map((m) => m[0]))]
        .sort()
        .join(",");
      const b = [
        ...new Set([...want[label].matchAll(ID_IN_TEXT)].map((m) => m[0])),
      ]
        .sort()
        .join(",");
      if (a !== b)
        errors.push(
          `${w.id}: brief "${label}" row (${a || "none"}) differs from the graph (${b || "none"}); run --sync-briefs`,
        );
    }
  }
  // cycles
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`cycle: ${[...path, id].join(" -> ")}`);
      return;
    }
    state.set(id, 1);
    for (const d of byId.get(id)?.deps ?? [])
      if (byId.has(d)) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const w of wps) visit(w.id, []);
  return errors;
}

// Longest chain (by upper estimate) ending at each node.
function longest(filter = (w) => !w.optional) {
  const memo = new Map();
  const f = (id) => {
    if (memo.has(id)) return memo.get(id);
    const w = byId.get(id);
    let best = { weeks: 0, chain: [] };
    for (const d of w.deps) {
      const r = f(d);
      if (r.weeks > best.weeks) best = r;
    }
    const own = filter(w) && !DONE.has(w.status) ? w.estimateWeeks[1] : 0;
    const res = { weeks: best.weeks + own, chain: [...best.chain, id] };
    memo.set(id, res);
    return res;
  };
  return f;
}

// Longest chain (by upper estimate) that STARTS at each node: how much work waits on it.
function tail() {
  const dependants = new Map(wps.map((w) => [w.id, []]));
  for (const w of wps) for (const d of w.deps) dependants.get(d)?.push(w.id);
  const memo = new Map();
  const f = (id) => {
    if (memo.has(id)) return memo.get(id);
    const w = byId.get(id);
    let best = 0;
    for (const n of dependants.get(id))
      if (!byId.get(n).optional) best = Math.max(best, f(n));
    const res = best + (DONE.has(w.status) ? 0 : w.estimateWeeks[1]);
    memo.set(id, res);
    return res;
  };
  return { f, dependants };
}

const fmtEst = ([a, b]) => (a === b ? `${a}` : `${a}–${b}`);

// The header rows every brief carries that are derived from the graph (kept in sync by --sync-briefs).
const ID_IN_TEXT =
  /\b(?:P0|P1b|P1|P2b|P2|P3|P4|P5|P6|X|S|D|F|A|I)-\d{2}[a-z]?\b/g;
function dependantsOf() {
  const m = new Map(wps.map((w) => [w.id, []]));
  for (const w of wps) for (const d of w.deps) m.get(d)?.push(w.id);
  return m;
}
function headerRows(w, dependants) {
  const link = (id) => `[${id}](${byId.get(id).brief.replace(/^wp\//, "")})`;
  let role = `\`${w.role}\``;
  if (w.planMode && w.role !== "pkey-wire-planner")
    role += " (the plan is written first by `pkey-wire-planner`)";
  if (w.role === "pkey-wire-planner") role += " (planning only)";
  return {
    Size: `${fmtEst(w.estimateWeeks)} engineer-weeks`,
    "Depends on": w.deps.map(link).join(", ") || "none",
    Unblocks: dependants.get(w.id).map(link).join(", ") || "none",
    Role: role,
  };
}
function rowValue(text, label) {
  const m = text
    .split("\n", 40)
    .find((l) => new RegExp(`^\\|\\s*${label}\\s*\\|`).test(l));
  return m === undefined ? undefined : m.split("|")[2]?.trim();
}
const sum = (list, i) =>
  Math.round(list.reduce((s, w) => s + w.estimateWeeks[i], 0) * 100) / 100;

function renderIndex() {
  const lines = [
    "<!-- GENERATED by check.mjs --write-index from workpackages.json. Do not edit by hand. -->",
    "",
    "# Work-package index",
    "",
    "Generated from [`workpackages.json`](workpackages.json). Read [`README.md`](README.md) first.",
    "Estimates are focused engineer-weeks. ⚑ marks plan-mode work packages, whose plan needs human",
    "approval before implementation. ✋ marks work packages that need human-held inputs (accounts,",
    "keys, devices). _Optional_ work packages are off the required path.",
    "",
  ];
  for (const p of doc.phases) {
    const list = wps.filter((w) => w.phase === p.id);
    if (!list.length) continue;
    const req = list.filter((w) => !w.optional);
    const effort = req.length
      ? `, ${sum(req, 0)}–${sum(req, 1)} weeks${req.length < list.length ? " for the required ones" : ""}`
      : ", all optional";
    lines.push(
      `## ${p.id}: ${p.title}`,
      "",
      `${list.length} work packages${effort}.`,
      "",
    );
    lines.push(
      "| Id | Title | Depends on | Role | Weeks | Status |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const w of list) {
      const flags = `${w.planMode ? " ⚑" : ""}${w.humanInputs.length ? " ✋" : ""}${w.optional ? " _optional_" : ""}`;
      const title = w.title.replace(/\|/g, "\\|");
      lines.push(
        `| [${w.id}](${w.brief})${flags} | ${title} | ${w.deps.join(", ") || "—"} | ${w.role.replace("pkey-", "")} | ${fmtEst(w.estimateWeeks)} | ${w.status} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Plans",
    "",
    "Every ⚑ package needs an approved plan in [`plans/`](plans/) before implementation. The plan is written by `pkey-wire-planner`; after approval the package's own role implements it.",
    "",
  );
  lines.push("| Id | Plan file | Implemented by |", "| --- | --- | --- |");
  for (const w of wps.filter((x) => x.planMode)) {
    const plan = `plans/${w.planRef ?? w.id}.md`;
    lines.push(
      `| [${w.id}](${w.brief}) | \`${plan}\`${w.planRef ? ` (shared with ${w.planRef})` : ""} | ${w.role === "pkey-wire-planner" ? "planning only" : w.role.replace("pkey-", "")} |`,
    );
  }
  lines.push(
    "",
    "## Human inputs",
    "",
    "What a person must supply, per work package. Ask early: several sit on the critical path.",
    "",
  );
  lines.push("| Id | Needs |", "| --- | --- |");
  for (const w of wps.filter((x) => x.humanInputs.length)) {
    lines.push(
      `| [${w.id}](${w.brief}) | ${w.humanInputs.map((h) => h.replace(/\|/g, "\\|")).join("; ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function setStatus(id, status) {
  if (!byId.has(id)) throw new Error(`unknown work package ${id}`);
  if (!doc.statuses.includes(status))
    throw new Error(
      `unknown status ${status}; one of ${doc.statuses.join(", ")}`,
    );
  const start = raw.indexOf(`"id": "${id}"`);
  const next = raw.indexOf(`"id": "`, start + 1);
  const end = next === -1 ? raw.length : next;
  const seg = raw.slice(start, end);
  const updated = seg.replace(/"status": "[a-z-]+"/, `"status": "${status}"`);
  const out = raw.slice(0, start) + updated + raw.slice(end);
  // The edit is textual, so prove it changed this package's status and nothing else (a package
  // whose keys put "status" before "id" would otherwise have its neighbour edited instead).
  const after = new Map(
    JSON.parse(out).workPackages.map((w) => [w.id, w.status]),
  );
  for (const w of doc.workPackages) {
    const want = w.id === id ? status : w.status;
    if (after.get(w.id) !== want)
      throw new Error(
        `--set ${id} would leave ${w.id} at ${after.get(w.id)}, not ${want}; put "id" first in each package's keys`,
      );
  }
  writeFileSync(GRAPH, out);
  byId.get(id).status = status;
  writeFileSync(INDEX, renderIndex().replace(/\n*$/, "\n"));
  console.log(
    `${id} → ${status} (INDEX.md regenerated; run prettier on both files before committing)`,
  );
}

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);

if (flag("--set")) {
  const i = args.indexOf("--set");
  setStatus(args[i + 1], args[i + 2]);
  process.exit(0);
}

if (flag("--sync-briefs")) {
  const deps2 = dependantsOf();
  let n = 0;
  for (const w of wps) {
    const brief = join(HERE, w.brief);
    if (!existsSync(brief)) continue;
    const lines = readFileSync(brief, "utf8").split("\n");
    const want = headerRows(w, deps2);
    let touched = false;
    for (const [label, value] of Object.entries(want)) {
      const k = lines
        .slice(0, 40)
        .findIndex((l) => new RegExp(`^\\|\\s*${label}\\s*\\|`).test(l));
      if (k >= 0 && lines[k].split("|")[2]?.trim() !== value) {
        lines[k] = `| ${label} | ${value} |`;
        touched = true;
      }
    }
    if (touched) {
      writeFileSync(brief, lines.join("\n"));
      n++;
    }
  }
  console.log(
    `${n} brief header(s) updated from the graph; run prettier on wp/ before committing.`,
  );
  process.exit(0);
}

const errors = validate();
if (errors.length) {
  console.error(`workpackages.json: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (flag("--write-index")) {
  writeFileSync(INDEX, renderIndex().replace(/\n*$/, "\n"));
  console.log("INDEX.md written; run prettier on it before committing.");
} else if (flag("--ready")) {
  const { f } = tail();
  const ready = wps
    .filter((w) => w.status === "todo" && (flag("--optional") || !w.optional))
    .filter((w) => w.deps.every((d) => DONE.has(byId.get(d).status)))
    .sort((a, b) => f(b.id) - f(a.id));
  if (!ready.length) console.log("Nothing is ready.");
  for (const w of ready) {
    const tags = [
      w.planMode && "plan-mode",
      w.humanInputs.length && "needs-human",
      w.repo !== "polaris-key" && w.repo,
    ].filter(Boolean);
    console.log(
      `${w.id.padEnd(7)} ${String(f(w.id)).padStart(5)} wk waiting  ${w.role.padEnd(20)} ${w.title}${tags.length ? `  [${tags.join(", ")}]` : ""}`,
    );
  }
} else if (flag("--summary")) {
  const req = wps.filter((w) => !w.optional);
  console.log(
    `${wps.length} work packages (${req.length} required); required effort ${sum(req, 0)}–${sum(req, 1)} weeks`,
  );
  for (const p of doc.phases) {
    const l = wps.filter((w) => w.phase === p.id);
    const r = l.filter((w) => !w.optional);
    const st = Object.entries(
      l.reduce((m, w) => ((m[w.status] = (m[w.status] ?? 0) + 1), m), {}),
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    console.log(
      `  ${p.id.padEnd(4)} ${String(l.length).padStart(3)} wp  ${`${sum(r, 0)}–${sum(r, 1)}`.padStart(11)} wk  ${p.title}  (${st})`,
    );
  }
} else if (flag("--critical")) {
  const f = longest();
  let best = { weeks: 0, chain: [] };
  for (const w of wps)
    if (!w.optional) {
      const r = f(w.id);
      if (r.weeks > best.weeks) best = r;
    }
  console.log(
    `Critical path (upper estimates, remaining work only): ${best.weeks} weeks`,
  );
  for (const id of best.chain)
    console.log(
      `  ${id.padEnd(7)} ${fmtEst(byId.get(id).estimateWeeks).padStart(7)} wk  ${byId.get(id).title}`,
    );
} else if (flag("--show")) {
  const id = args[args.indexOf("--show") + 1];
  const w = byId.get(id);
  if (!w) throw new Error(`unknown work package ${id}`);
  const { dependants } = tail();
  console.log(JSON.stringify(w, null, 2));
  console.log(`dependants: ${dependants.get(id).join(", ") || "none"}`);
  console.log(`brief: ${join(HERE, w.brief)}`);
} else {
  const fresh = renderIndex().replace(/\n*$/, "\n");
  const current = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : "";
  // INDEX.md is prettier-formatted after generation, so compare ignoring table padding.
  const norm = (s) =>
    s
      .split("\n")
      .map((l) =>
        l
          .replace(/ *\| */g, "|")
          .replace(/-{3,}/g, "---")
          .trim(),
      )
      .join("\n")
      .trim();
  if (norm(fresh) !== norm(current)) {
    console.error(
      "INDEX.md is stale: run `node check.mjs --write-index` and prettier.",
    );
    process.exit(1);
  }
  console.log(`OK: ${wps.length} work packages, graph valid, INDEX.md fresh.`);
}
