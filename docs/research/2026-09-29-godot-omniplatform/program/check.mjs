#!/usr/bin/env node
// Work-package graph tool for the Godot-on-Polaris-Key program. No dependencies; Node >= 22.
//
//   node check.mjs                      validate the graph and check INDEX.md is fresh (exit 1 on any problem)
//   node check.mjs --write-index        regenerate INDEX.md
//   node check.mjs --ready [--optional] [--deferred]  list work packages whose dependencies are all done
//                                      (deferred packages, waiting for the owner's go, only with --deferred)
//   node check.mjs --summary            counts and estimate totals per phase and status
//   node check.mjs --critical           the longest dependency chain by upper estimate
//   node check.mjs --show <id>          one work package, its dependencies and its dependants
//   node check.mjs --set <id> <status>  update one status in place (keeps the file's formatting)
//   node check.mjs --sync-briefs        rewrite each brief's Size / Depends on / Unblocks / Role rows from the graph
//   node check.mjs --ux [filter] [--json]  UX coverage per area and platform (ux-coverage.json, ux-reviews.json):
//                                      screens covered, owner packages todo/in-progress/done, % of mockup screens
//                                      whose every owner is done AND UX-reviewed. The same data feeds the UX drift
//                                      gate that the default run applies (a mockup screen with no owner fails).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = join(HERE, "workpackages.json");
const INDEX = join(HERE, "INDEX.md");
// A two-digit id, with an optional lower-case letter for packages split from one spike row
// (A-17a…g from notes/S-14 §10, A-18a…m from notes/S-15 §11, I-10a/b from notes/S-16 §8,
// U-11a…c, U-15a…c and U-24a…b from notes/S-17 §6, ST-01a…c from notes/S-18 §6.2, I-24a/b from plans/I-24.md, LX-05b from
// notes/S-19 §9). Settings architecture (phase ST, notes/S-18) and the licensing model (phase LX,
// notes/S-19) use two-letter prefixes.
// The SDK parity pass (phase SP, notes/SDK-PARITY-PASS.md) also uses a two-letter prefix.
// Hosted assets (phase HA, notes/S-20) also use a two-letter prefix.
// The Polaris Key storefront (phase PS, notes/S-21) also uses a two-letter prefix.
// UI kits (phase UK, docs/design/UI-KITS.md §10) also use a two-letter prefix; UK-02a/b execute
// plans/UK-02.md.
// The motion system (phase MO, notes/S-23) also uses a two-letter prefix.
// Documentation (phase DOC, docs/research/2026-10-08-docs/ §6.1) uses the plan's own DOC-<nn>[a-z] ids.
// Agent experience (phase AX, docs/research/2026-10-08-llm-audit/ §8) uses the plan's own AX-<nn>[a-z] ids.
// Polaris Key commerce (phase CM, notes/S-22) also uses a two-letter prefix; every CM package is
// optional and carries `deferred` until the owner's go.
// The customer portal (phase PX, docs/design/PORTAL.md §11) keeps the spec's own ids: PX-01…PX-22
// for the front end and PX-W1…PX-W17 for the Worker additions; a follow-up split off a PX-W package
// takes a letter suffix like every other phase's (PX-W9b, the SDK half of PX-W9; PX-W13b).
const ID_RE =
  /^(?:(?:P0|P1|P1b|P2|P2b|P3|P4|P5|P6|X|S|D|F|A|I|U|ST|LX|SP|HA|UK|MO|PS|CM|DOC|AX)-\d{2}[a-z]?|PX-(?:\d{2}|W\d{1,2}[a-z]?))$/;
const DONE = new Set(["done", "dropped"]);

const UX_COVERAGE = join(HERE, "ux-coverage.json");
const UX_REVIEWS = join(HERE, "ux-reviews.json");
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const MOCKUP_SCREENS = join(REPO_ROOT, "docs", "design", "mockups", "screens");

const raw = readFileSync(GRAPH, "utf8");
const doc = JSON.parse(raw);
const wps = doc.workPackages;
const byId = new Map(wps.map((w) => [w.id, w]));
const phaseIds = doc.phases.map((p) => p.id);

// ---------------------------------------------------------------------------------------------
// UX coverage (ux-coverage.json): every design item -> owner work packages -> status.
// ---------------------------------------------------------------------------------------------
// Item kinds that must always carry an owner (or be explicitly exempt with a note).
const UX_KINDS = new Set([
  "screen",
  "hosted",
  "kit-board",
  "kit-framework",
  "doc-section",
  "decision",
  "owner-rule",
  "brand-change",
]);
const UX_OPEN = new Set([
  "todo",
  "planning",
  "awaiting-approval",
  "in-progress",
  "in-review",
  "blocked",
]);

const gateCache = new Map();
function hasUxGate(id) {
  if (gateCache.has(id)) return gateCache.get(id);
  const w = byId.get(id);
  let v = false;
  if (w) {
    const f = join(HERE, w.brief ?? "");
    v = existsSync(f) && readFileSync(f, "utf8").includes("pkey-ux-reviewer");
  }
  gateCache.set(id, v);
  return v;
}

function loadUx() {
  if (!existsSync(UX_COVERAGE)) return null;
  const cov = JSON.parse(readFileSync(UX_COVERAGE, "utf8"));
  const rev = existsSync(UX_REVIEWS)
    ? JSON.parse(readFileSync(UX_REVIEWS, "utf8"))
    : { reviews: {} };
  return { cov, reviews: rev.reviews ?? {} };
}

// Mockup screens present in this checkout (docs/design/mockups/screens/<area>/<id>.json).
function mockupScreensOnDisk() {
  if (!existsSync(MOCKUP_SCREENS)) return null;
  const out = [];
  for (const area of readdirSync(MOCKUP_SCREENS)) {
    const dir = join(MOCKUP_SCREENS, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        out.push({
          id: j.id ?? f.replace(/\.json$/, ""),
          area,
          packages: j.packages ?? [],
        });
      } catch {
        out.push({
          id: f.replace(/\.json$/, ""),
          area,
          packages: [],
          bad: true,
        });
      }
    }
  }
  return out;
}

function uxValidate() {
  const errors = [];
  const ux = loadUx();
  if (!ux) return errors; // coverage not introduced in this checkout
  const { cov, reviews } = ux;
  const ids = new Set();
  const screens = new Map();
  for (const it of cov.items ?? []) {
    const at = `ux-coverage ${it.id ?? "?"}:`;
    if (!it.id || !it.kind) {
      errors.push(`${at} item needs id and kind`);
      continue;
    }
    if (ids.has(it.id)) errors.push(`${at} duplicate item id`);
    ids.add(it.id);
    if (it.kind === "screen") screens.set(it.id, it);
    if (!Array.isArray(it.owners)) {
      errors.push(`${at} owners must be an array`);
      continue;
    }
    for (const o of it.owners)
      if (!byId.has(o)) errors.push(`${at} unknown owner ${o}`);
    const live = it.owners.filter(
      (o) => byId.get(o) && byId.get(o).status !== "dropped",
    );
    if (UX_KINDS.has(it.kind) && !it.exempt && live.length === 0)
      errors.push(
        `${at} no live owner (owners ${it.owners.join(", ") || "none"}): give it a work package, or exempt it with a reason`,
      );
    if (it.exempt && !(typeof it.exempt === "string" && it.exempt))
      errors.push(`${at} exempt must be a non-empty reason string`);
    // a UI item needs one builder that carries the UX gate (or every owner is already done)
    if (
      it.kind === "screen" ||
      it.kind === "hosted" ||
      it.kind === "kit-board"
    ) {
      const all = live.concat(
        (it.overlays ?? []).filter(
          (o) => byId.has(o) && byId.get(o).status !== "dropped",
        ),
      );
      if (
        live.length &&
        !live.every((o) => byId.get(o).status === "done") &&
        !live.some((o) => hasUxGate(o))
      )
        errors.push(
          `${at} no owner carries the pkey-ux-reviewer gate (owners ${all.join(", ")}): add the Screen acceptance block to the package that builds it`,
        );
    }
    for (const o of it.overlays ?? [])
      if (!byId.has(o)) errors.push(`${at} unknown overlay ${o}`);
    if (it.gap && !it.resolvedBy && !it.exempt)
      errors.push(`${at} gap "${it.gap}" has no resolvedBy`);
  }
  // drift gate: every mockup screen on disk has an item with at least one live owner
  const disk = mockupScreensOnDisk();
  if (disk)
    for (const s of disk) {
      const it = screens.get(s.id);
      if (!it)
        errors.push(
          `mockup screen ${s.id} has no entry in ux-coverage.json (add it with an owner)`,
        );
    }
  for (const [id, r] of Object.entries(reviews)) {
    if (!byId.has(id))
      errors.push(`ux-reviews.json: unknown work package ${id}`);
    else if (byId.get(id).status !== "done")
      errors.push(
        `ux-reviews.json: ${id} is ${byId.get(id).status}; only done packages carry a recorded UX review`,
      );
    if (!r.date || !r.evidence)
      errors.push(`ux-reviews.json: ${id} needs date and evidence`);
  }
  return errors;
}

// For --set <id> done: the screens a UX-gated package builds when no passing review is recorded.
function uxReviewMissing(id) {
  const ux = loadUx();
  if (!ux || !hasUxGate(id) || uxReviewed(ux.reviews, id)) return undefined;
  const mine = ux.cov.items.filter(
    (it) =>
      (it.kind === "screen" ||
        it.kind === "hosted" ||
        it.kind === "kit-board") &&
      (it.owners.includes(id) || (it.overlays ?? []).includes(id)),
  );
  if (!mine.length) return undefined;
  return `${mine.length} UX item(s) (${mine
    .slice(0, 3)
    .map((m) => m.id)
    .join(", ")}${mine.length > 3 ? ", ..." : ""})`;
}

function uxReviewed(reviews, id) {
  const r = reviews[id];
  return Boolean(r && r.verdict === "pass");
}

// An item is delivered when every non-dropped owner (and overlay) is done; reviewed when each of those that
// carries the UX gate also has a passing review in ux-reviews.json.
function uxStats(items, reviews) {
  const n = {
    total: items.length,
    exempt: 0,
    built: 0,
    partial: 0,
    mockupOnly: 0,
    gaps: 0,
    delivered: 0,
    reviewed: 0,
    pkgs: { todo: 0, wip: 0, done: 0 },
  };
  const seen = new Set();
  for (const it of items) {
    const live = it.owners.filter(
      (o) => byId.get(o) && byId.get(o).status !== "dropped",
    );
    const ovl = (it.overlays ?? []).filter(
      (o) => byId.get(o) && byId.get(o).status !== "dropped",
    );
    const everyone = live.concat(ovl);
    if (it.exempt && !live.length) n.exempt++;
    if (it.built === "built") n.built++;
    else if (it.built === "partial") n.partial++;
    else if (it.built === "mockup-only") n.mockupOnly++;
    if (it.gap && !it.resolvedBy) n.gaps++;
    for (const o of everyone) {
      if (seen.has(o)) continue;
      seen.add(o);
      const s = byId.get(o).status;
      if (s === "done") n.pkgs.done++;
      else if (
        ["in-progress", "in-review", "planning", "awaiting-approval"].includes(
          s,
        )
      )
        n.pkgs.wip++;
      else n.pkgs.todo++;
    }
    const allDone =
      everyone.length > 0 &&
      everyone.every((o) => byId.get(o).status === "done");
    if (allDone) n.delivered++;
    if (
      allDone &&
      everyone.every((o) => !hasUxGate(o) || uxReviewed(reviews, o))
    )
      n.reviewed++;
  }
  return n;
}

function uxReport(filter, asJson) {
  const ux = loadUx();
  if (!ux) {
    console.log("No ux-coverage.json.");
    return;
  }
  const { cov, reviews } = ux;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-").padStart(5);
  const groups = new Map();
  const add = (section, key, it) => {
    const label = `${section}|${key}`;
    if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(it);
  };
  for (const it of cov.items) {
    if (it.kind === "screen") add("Mockup screens by area", it.area, it);
    else if (it.kind === "hosted")
      add("Hosted sign-in, pages and emails", "hosted", it);
    else if (it.kind === "kit-board")
      add("Kit boards by platform", it.platform ?? "-", it);
    else if (it.kind === "kit-framework")
      add("Kit frameworks by platform", it.platform ?? "-", it);
    else if (it.kind === "doc-section") add("Design-doc sections", it.area, it);
    else if (it.kind === "decision")
      add("Brand decisions B1-B17", "B-rules", it);
    else if (it.kind === "owner-rule") add("Owner rules", "owner-rules", it);
    else if (it.kind === "brand-change")
      add("Brand-transition changes (372)", it.area, it);
  }
  const rows = [...groups.entries()].map(([label, items]) => {
    const [section, key] = label.split("|");
    return { section, key, ...uxStats(items, reviews) };
  });
  if (asJson) {
    console.log(JSON.stringify({ groups: rows }, null, 2));
    return;
  }
  console.log(
    `UX coverage: ${cov.items.length} items; mockups ${cov.mockupsRef ?? "?"}; ${Object.keys(reviews).length} package(s) with a recorded UX review`,
  );
  const sections = [...new Set(rows.map((r) => r.section))];
  for (const sec of sections) {
    console.log(`\n${sec}`);
    console.log(
      "  " +
        "group".padEnd(42) +
        "items built  part  mock  gap | pkgs todo  wip done | deliv  revwd",
    );
    for (const r of rows
      .filter((x) => x.section === sec)
      .sort((a, b) => a.key.localeCompare(b.key)))
      console.log(
        "  " +
          r.key.slice(0, 41).padEnd(42) +
          [r.total, r.built, r.partial, r.mockupOnly, r.gaps]
            .map((x) => String(x).padStart(5))
            .join("") +
          " |      " +
          [r.pkgs.todo, r.pkgs.wip, r.pkgs.done]
            .map((x) => String(x).padStart(4))
            .join("") +
          " |" +
          pct(r.delivered, r.total) +
          " " +
          pct(r.reviewed, r.total),
      );
  }
  const scr = cov.items.filter((i) => i.kind === "screen");
  const st = uxStats(scr, reviews);
  console.log("\nMockup screens, all areas");
  console.log(
    `  ${scr.length} screens: ${st.delivered} delivered (every owner done), ${st.reviewed} delivered and UX-reviewed (${pct(st.reviewed, scr.length).trim()})`,
  );
  console.log(
    `  in code today: ${st.built} built, ${st.partial} partial, ${st.mockupOnly} mockup-only; ${st.gaps} unresolved gap flag(s)`,
  );
  const owners = new Set(
    cov.items.flatMap((i) => i.owners.concat(i.overlays ?? [])),
  );
  const by = {};
  for (const o of owners) {
    const s = byId.get(o)?.status ?? "?";
    by[s] = (by[s] ?? 0) + 1;
  }
  console.log(
    `  owner packages (distinct): ${owners.size}: ${Object.entries(by)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  const disk = mockupScreensOnDisk();
  if (disk) {
    const inCov = new Set(scr.map((s) => s.id));
    const pending = scr.filter((s) => !disk.some((d) => d.id === s.id)).length;
    console.log(
      `  on disk in this checkout: ${disk.length} mockup screens, ${disk.filter((d) => inCov.has(d.id)).length} covered; ${pending} covered screens await the mockups branch`,
    );
  }
}

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
    if ("deferred" in w && !(typeof w.deferred === "string" && w.deferred))
      errors.push(
        `${at} deferred must be a non-empty string naming what it waits for`,
      );
    for (const d of w.deps ?? [])
      if (byId.get(d)?.deferred && !w.deferred)
        errors.push(
          `${at} a non-deferred work package depends on deferred ${d}`,
        );
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
  errors.push(...uxValidate());
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
  /\b(?:(?:P0|P1b|P1|P2b|P2|P3|P4|P5|P6|X|S|D|F|A|I|U|ST|LX|SP|HA|UK|MO|PS|CM|DOC|AX)-\d{2}[a-z]?|PX-(?:\d{2}|W\d{1,2}[a-z]?))\b/g;
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
    "keys, devices). _Optional_ work packages are off the required path. _Deferred_ work packages",
    "wait for the owner's go and are never listed by `--ready` (see `deferred` in workpackages.json).",
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
      const flags = `${w.planMode ? " ⚑" : ""}${w.humanInputs.length ? " ✋" : ""}${w.optional ? " _optional_" : ""}${w.deferred ? " _deferred_" : ""}`;
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
  if (status === "done" && !flag("--no-ux-gate")) {
    const miss = uxReviewMissing(id);
    if (miss)
      throw new Error(
        `${id} builds ${miss}; record the pkey-ux-reviewer BUILT-mode pass first: node check.mjs --ux-review ${id} pass "<evidence path or PR link>" (or pass --no-ux-gate with a reason in the PR)`,
      );
  }
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
function flag(f) {
  return args.includes(f);
}

if (flag("--ux-review")) {
  // node check.mjs --ux-review <id> <pass|fail> "<evidence>": append to the UX review ledger (ux-reviews.json)
  const i = args.indexOf("--ux-review");
  const [id, verdict, ...ev] = args.slice(i + 1);
  if (!byId.has(id)) throw new Error(`unknown work package ${id}`);
  if (!["pass", "fail"].includes(verdict))
    throw new Error("verdict must be pass or fail");
  if (!ev.length) throw new Error("evidence (a path or PR link) is required");
  const led = existsSync(UX_REVIEWS)
    ? JSON.parse(readFileSync(UX_REVIEWS, "utf8"))
    : { reviews: {} };
  led.reviews[id] = {
    verdict,
    date: new Date().toISOString().slice(0, 10),
    evidence: ev.join(" "),
  };
  writeFileSync(UX_REVIEWS, JSON.stringify(led, null, 2) + "\n");
  console.log(
    `${id}: UX review ${verdict} recorded in ux-reviews.json (run prettier on it)`,
  );
  process.exit(0);
}

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
    .filter((w) => flag("--deferred") || !w.deferred)
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
} else if (flag("--ux")) {
  const i = args.indexOf("--ux");
  const f =
    args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
  uxReport(f, flag("--json"));
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
