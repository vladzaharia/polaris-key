#!/usr/bin/env node
/**
 * The worker test-layout codemod (P0-30.5; plans/P0-30-AX-07-slices.md D-P5, D-P6).
 *
 *   node scripts/test-layout.mjs plan  [--root <repo>] [--out <file.tsv>]
 *   node scripts/test-layout.mjs apply [--root <repo>] --tsv <file.tsv> [--no-format]
 *
 * `plan` classifies every flat `packages/worker/test/*.test.ts` and prints `old\tnew\treason`
 * rows (paths relative to the repo root) plus bucket counts on stderr. A human reviews the
 * file. `apply` performs the reviewed rows: `git mv` (with `__snapshots__/<file>.snap`),
 * specifier rewrite by resolved target, `HERE` swapped for `TEST_ROOT` from `test/paths.ts`,
 * then every live reference to an old path in tracked text. Rows whose new path equals the old
 * one (the GUARDS) stay. Only `*.test.ts` move; helpers stay at `test/` (D-P5).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = "packages/worker";
const TEST = `${WORKER}/test`;

/**
 * Tests that stay flat at `test/`: the rule enforcers and anything tooling names by path. Each
 * has a reason; layout.test.ts reads this list, so a guard added here is a reviewed decision.
 * No builder additions (P0-30.5): every other test that names a path in a workflow, doc or
 * generator does so in a comment, which `apply` rewrites.
 */
export const GUARDS = {
  boundaries:
    "rule 6 enforcer; root AGENTS.md and packages/worker/AGENTS.md name its path",
  tableCrossings:
    "rule 6 enforcer (table ownership); root AGENTS.md names its path",
  auditWriter:
    "rule 6 enforcer (single audit writer); root AGENTS.md names its path",
  routeCoverage: "rule 10 enforcer; root AGENTS.md names its path",
  platformInventory:
    "generated-file freshness (platform inventory); AGENTS.md rule 3",
  "settings-generated": "generated-file freshness (settings); AGENTS.md rule 3",
  ciPlaneGenerated:
    "generated-file freshness (storefront CI plane); AGENTS.md rule 3",
  adminCspParity: "CSP parity gate; AGENTS.md green gate runs it by name",
  docsCspParity: "CSP parity gate for the docs site",
  docsLinks: "docs link integrity gate",
  portalHelpLinks: "help-link drift gate",
  transcripts:
    "tools/generators.ts and tools/gen-transcripts.mjs run it by path (T9)",
  docsSearchBrowser: ".github/workflows/ci.yml runs it by path (T9)",
  helpers:
    "name kept for the shared helper's sibling test; helpers stay at test/ (T8)",
};

const PREFIXES = [
  [/^cloudSync/, "services/sync", "prefix cloudSync*"],
  [
    /^(asc|play|msstore|storefront)/,
    "services/distribution",
    "prefix asc*/play*/msstore*/storefront*",
  ],
  [/^portal/, "services/identity", "prefix portal*"],
  [/^commerce/, "services/commerce", "prefix commerce*"],
  [/Migration\.test\.ts$/, "core/migrations", "suffix *Migration.test.ts"],
];

const COMPOSITION = new Set([
  "index",
  "router",
  "scheduled",
  "dispatch",
  "docs",
]);

/** Specifier contexts a test uses to reach a module. Group 2 is the specifier. */
const SPEC_RE =
  /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual|importMock|unmock)\s*\(\s*|\bimportActual\s*(?:<[^>]*>)?\s*\(\s*|\brequire\s*\(\s*)["'])([^"']+)(["'])/g;

/** Direct `../src/...` imports of a test source, as the first path segments after `src/`. */
export function srcImports(source) {
  const out = new Set();
  for (const m of source.matchAll(SPEC_RE)) {
    const mm = /^\.\.\/src\/(.+)$/.exec(m[2]);
    if (mm) out.add(mm[1]);
  }
  return out;
}

export function classify(file, source, slugs) {
  const base = file.replace(/\.test\.ts$/, "");
  if (Object.hasOwn(GUARDS, base))
    return { dir: "", reason: `guard: ${GUARDS[base]}` };
  for (const [re, dir, why] of PREFIXES) {
    if (re.test(file)) return { dir, reason: why };
  }
  const services = new Set();
  let core = false;
  let consoleUse = false;
  const composition = [];
  for (const imp of srcImports(source)) {
    const seg = imp.split("/");
    const first = seg[0].replace(/\.(js|ts)$/, "");
    if (first === "services") {
      if (slugs.includes(seg[1])) services.add(seg[1]);
      else composition.push(`services/${seg[1]}`);
    } else if (first === "console") consoleUse = true;
    else if (["core", "platform", "db"].includes(first)) core = true;
    else if (COMPOSITION.has(first)) composition.push(first);
    else core = true; // other top-level src modules (mount, limits, ...) are core-level
  }
  if (composition.length)
    return {
      dir: "surfaces",
      reason: `composition module: ${[...new Set(composition)].join(", ")}`,
    };
  if (consoleUse && services.size <= 1)
    return {
      dir: "surfaces/console",
      reason: `console${services.size ? ` + ${[...services][0]}` : ""}`,
    };
  if (consoleUse)
    return { dir: "surfaces", reason: `console + ${[...services].join(", ")}` };
  if (services.size === 1)
    return {
      dir: `services/${[...services][0]}`,
      reason: `one service: ${[...services][0]}`,
    };
  if (services.size > 1)
    return {
      dir: "surfaces",
      reason: `services: ${[...services].sort().join(", ")}`,
    };
  return {
    dir: "core",
    reason: core ? "core, platform or db only" : "no src import",
  };
}

export function serviceSlugs(root) {
  const j = JSON.parse(
    readFileSync(path.join(root, "tools/services.json"), "utf8"),
  );
  return (j.services ?? j.rows ?? []).map((s) => s.slug ?? s.id);
}

export function plan(root) {
  const slugs = serviceSlugs(root);
  const dir = path.join(root, TEST);
  const rows = [];
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".test.ts"))
    .sort()) {
    const { dir: sub, reason } = classify(
      f,
      readFileSync(path.join(dir, f), "utf8"),
      slugs,
    );
    rows.push({
      old: `${TEST}/${f}`,
      new: sub ? `${TEST}/${sub}/${f}` : `${TEST}/${f}`,
      reason,
    });
  }
  return rows;
}

export function bucketOf(row) {
  const rel = row.new.slice(TEST.length + 1);
  const parts = rel.split("/");
  if (parts.length === 1) return "guard";
  if (parts[0] === "services") return `services/${parts[1]}`;
  if (parts[0] === "surfaces" && parts[1] === "console")
    return "surfaces/console";
  if (parts[0] === "core" && parts[1] === "migrations")
    return "core/migrations";
  return parts[0];
}

export function tsv(rows) {
  return rows.map((r) => `${r.old}\t${r.new}\t${r.reason}`).join("\n") + "\n";
}

export function parseTsv(text) {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [o, n, ...rest] = l.split("\t");
      return { old: o, new: n, reason: rest.join("\t") };
    });
}

function rel(from, to) {
  const r = path.posix.relative(from, to) || ".";
  return r.startsWith(".") ? r : `./${r}`;
}

function stripSuffix(spec) {
  return spec.replace(/\.(js|ts|mjs)$/, "");
}

/** Rewrite one moved file's text. `moves` maps old repo paths to new ones. */
export function rewriteSource(text, oldPath, newPath, moves) {
  const oldDir = path.posix.dirname(oldPath);
  const newDir = path.posix.dirname(newPath);
  const pathsRel = rel(newDir, `${TEST}/paths`).replace(/$/, ".js");
  let usesTestRoot = false;

  const retarget = (spec) => {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
    const target = path.posix.normalize(path.posix.join(oldDir, spec));
    const asTs = target.replace(/\.js$/, ".ts");
    const moved = moves.get(asTs);
    if (moved) return rel(newDir, moved).replace(/\.ts$/, ".js");
    return rel(newDir, target);
  };

  let out = text.replace(
    SPEC_RE,
    (_m, pre, spec, post) => `${pre}${retarget(spec)}${post}`,
  );

  // new URL("<rel>", import.meta.url): keep pointing at the same file.
  out = out.replace(
    /new URL\(\s*(["'])([^"']*)\1\s*,\s*import\.meta\.url\s*\)/g,
    (_m, q, spec) => {
      if (spec !== "." && !spec.startsWith("./") && !spec.startsWith("../"))
        return _m;
      return `new URL(${q}${retarget(spec)}${q}, import.meta.url)`;
    },
  );

  // const HERE = dirname(fileURLToPath(import.meta.url));  ->  imported TEST_ROOT alias.
  const dirExpr = String.raw`(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)`;
  out = out.replace(
    new RegExp(
      String.raw`^[ \t]*const (HERE|here|__dirname|dir|DIR_NAME) = ${dirExpr};\n`,
      "gm",
    ),
    (_m, name) => {
      usesTestRoot = name;
      return "";
    },
  );
  const alias = typeof usesTestRoot === "string" ? usesTestRoot : null;
  let inline = false;
  out = out.replace(
    new RegExp(dirExpr, "g"),
    () => ((inline = true), "TEST_ROOT"),
  );
  out = out.replace(
    /import\.meta\.dirname/g,
    () => ((inline = true), "TEST_ROOT"),
  );

  const names = [];
  if (alias) names.push(`TEST_ROOT as ${alias}`);
  if (inline) names.push("TEST_ROOT");
  if (names.length) {
    const stmt = `import { ${names.join(", ")} } from "${pathsRel}";\n`;
    const lines = out.split("\n");
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(import\b.*;|\} from ".*";|import\b.*from ".*";)$/.test(lines[i]))
        last = i;
    }
    lines.splice(last + 1, 0, stmt.trimEnd());
    out = lines.join("\n");
    out = dropUnusedImports(out, ["dirname", "fileURLToPath"]);
  }
  return out;
}

function dropUnusedImports(text, names) {
  let out = text;
  for (const n of names) {
    const body = out.replace(/^import\b[\s\S]*?;\n/gm, "");
    if (new RegExp(`\\b${n}\\b`).test(body)) continue;
    out = out.replace(
      /^import\s*\{([^}]*)\}\s*from\s*"(node:path|node:url|path|url)";\n/gm,
      (m, list) => {
        const kept = list
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s.split(/\s+as\s+/)[0] !== n);
        if (
          kept.length ===
          list
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean).length
        )
          return m;
        if (!kept.length) return "";
        return m.replace(/\{[^}]*\}/, `{ ${kept.join(", ")} }`);
      },
    );
  }
  return out;
}

const SKIP_REF_PREFIXES = [
  "docs/research/",
  "docs/superpowers/",
  "tools/lint/debt/",
  "node_modules/",
];

function git(root, args, opts = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    ...opts,
  });
}

/** Rewrite references to moved tests in tracked text. Returns { changed, ambiguous }. */
export function rewriteReferences(root, moves) {
  const byName = new Map();
  for (const [o, n] of moves) byName.set(path.posix.basename(o), n);
  const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  // Names that exist as test files elsewhere: a bare `test/<name>` there is ambiguous.
  const elsewhere = new Set();
  for (const f of tracked) {
    const b = path.posix.basename(f);
    if (byName.has(b) && !f.startsWith(`${TEST}/`) && /\/test\/[^/]+$/.test(f))
      elsewhere.add(b);
  }
  const names = [...byName.keys()].map((n) => n.replace(/\./g, "\\."));
  if (!names.length) return { changed: [], ambiguous: [] };
  const re = new RegExp(
    `(^|[^\\w./-]|worker/)(test/)(${names.join("|")})(?![\\w-])`,
    "g",
  );
  const changed = [];
  const ambiguous = [];
  for (const f of tracked) {
    if (SKIP_REF_PREFIXES.some((p) => f.startsWith(p))) continue;
    if (/\.(png|jpg|ico|woff2?|zst|gz|zip|snap|pdf|wasm)$/.test(f)) continue;
    const abs = path.join(root, f);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    if (/GENERATED|DO NOT EDIT/.test(text.slice(0, 600))) continue;
    const inWorker = f.startsWith(`${WORKER}/`);
    const next = text.replace(re, (m, pre, t, name, off) => {
      const qualified =
        pre === "worker/" ||
        (off >= 0 &&
          /packages\/worker\/$/.test(
            text.slice(Math.max(0, off - 16), off + pre.length),
          ));
      if (!qualified && !inWorker && elsewhere.has(name)) {
        ambiguous.push(`${f}: ${t}${name}`);
        return m;
      }
      if (!qualified && f.startsWith("packages/") && !inWorker) {
        ambiguous.push(`${f}: ${t}${name}`);
        return m;
      }
      const target = byName.get(name).slice(TEST.length + 1);
      return `${pre}${t}${target}`;
    });
    if (next !== text) {
      writeFileSync(abs, next);
      changed.push(f);
    }
  }
  return { changed, ambiguous };
}

export function apply(root, rows, { format = true } = {}) {
  const todo = rows.filter((r) => r.old !== r.new);
  const moves = new Map(todo.map((r) => [r.old, r.new]));
  for (const r of todo) {
    if (
      !r.old.startsWith(`${TEST}/`) ||
      !r.new.startsWith(`${TEST}/`) ||
      !r.old.endsWith(".test.ts")
    )
      throw new Error(`refusing row: ${r.old} -> ${r.new}`);
    if (!existsSync(path.join(root, r.old)))
      throw new Error(`missing: ${r.old}`);
  }
  const sources = new Map(
    todo.map((r) => [r.old, readFileSync(path.join(root, r.old), "utf8")]),
  );
  const moved = [];
  for (const r of todo) {
    mkdirSync(path.dirname(path.join(root, r.new)), { recursive: true });
    git(root, ["mv", r.old, r.new]);
    const snapOld = path.posix.join(
      TEST,
      "__snapshots__",
      `${path.posix.basename(r.old)}.snap`,
    );
    if (existsSync(path.join(root, snapOld))) {
      const snapNew = path.posix.join(
        path.posix.dirname(r.new),
        "__snapshots__",
        `${path.posix.basename(r.new)}.snap`,
      );
      mkdirSync(path.dirname(path.join(root, snapNew)), { recursive: true });
      git(root, ["mv", snapOld, snapNew]);
    }
    writeFileSync(
      path.join(root, r.new),
      rewriteSource(sources.get(r.old), r.old, r.new, moves),
    );
    moved.push(r.new);
  }
  if (format && moved.length)
    execFileSync("pnpm", ["exec", "prettier", "--write", ...moved], {
      cwd: root,
      stdio: "ignore",
    });
  const refs = rewriteReferences(root, moves);
  return { moved, ...refs };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const [cmd] = argv;
  const root = path.resolve(
    arg(argv, "--root") ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  );
  if (cmd === "plan") {
    const rows = plan(root);
    const out = arg(argv, "--out");
    if (out) writeFileSync(out, tsv(rows));
    else process.stdout.write(tsv(rows));
    const counts = {};
    for (const r of rows) counts[bucketOf(r)] = (counts[bucketOf(r)] ?? 0) + 1;
    process.stderr.write(
      `${rows.length} flat tests\n` +
        Object.entries(counts)
          .sort()
          .map(([k, v]) => `  ${k}\t${v}`)
          .join("\n") +
        "\n",
    );
  } else if (cmd === "apply") {
    const file = arg(argv, "--tsv");
    if (!file) throw new Error("apply needs --tsv <reviewed file>");
    const res = apply(root, parseTsv(readFileSync(file, "utf8")), {
      format: !argv.includes("--no-format"),
    });
    process.stderr.write(
      `moved ${res.moved.length}; references rewritten in ${res.changed.length} files\n` +
        (res.ambiguous.length
          ? `ambiguous (left alone):\n  ${res.ambiguous.join("\n  ")}\n`
          : ""),
    );
  } else {
    process.stderr.write(
      "usage: test-layout.mjs plan|apply [--root R] [--out F | --tsv F] [--no-format]\n",
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2));
