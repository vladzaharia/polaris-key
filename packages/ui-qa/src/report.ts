// `pnpm ui:report`: every kit's baselines side by side per fixture state and theme (UI-KITS.md
// §7.1), from whichever kits have baselines today. The mockup shots are always present, so the
// report starts as the boards and grows a column per kit as each kit lands its baselines.
//
// Also: the components.json states that no source renders yet (§4.6: a fixture without a kit
// render fails visual QA once its kit exists), and the React/elements cross-renderer diff when
// both baseline sets exist.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  BASELINE_DIRS,
  BOARDS,
  CROSS_RENDERER,
  REPO_ROOT,
  SHOTS_DIR,
} from "./config.ts";
import { compareDirs, type PairResult } from "./pixeldiff.ts";
import { stateOf } from "./strings.ts";

export interface Shot {
  /** "mockup:web", "react", "swiftui", … */
  source: string;
  state: string;
  /** The shot's own name within its source ("device-limit-390"). */
  variant: string;
  theme: "dark" | "light" | "";
  file: string;
}

export interface Report {
  shots: Shot[];
  states: string[];
  sources: string[];
  unrendered: Array<{ component: string; state: string }>;
  crossRenderer: PairResult[] | null;
}

function walkPngs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      // The terminal kits' baselines are SVGs drawn from their golden ANSI text (UI-KITS §7.1),
      // one per state at the top of the directory; their boards/ are not state baselines.
      else if (name.endsWith(".png") || (name.endsWith(".svg") && d === dir))
        out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** A baseline's name without its image extension. */
function stem(file: string): string {
  return basename(file).replace(/\.(png|svg)$/, "");
}

function splitTheme(name: string): { rest: string; theme: Shot["theme"] } {
  const m = name.match(/(^|[-_.])(dark|light)(?=$|[-_.])/);
  if (!m) return { rest: name, theme: "" };
  const rest = (
    name.slice(0, m.index) + name.slice(m.index! + m[0].length)
  ).replace(/^[-_.]|[-_.]$/g, "");
  return { rest, theme: m[2] as "dark" | "light" };
}

/** A state id with every separator and the case gone: "Welcome.default", "welcome-default" and
 *  "accountAndLicense-key-only" meet at the same key. */
function squash(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The registry's states by squashed id, each as the shared `component-state` form (kebab
 *  component, then the state), the one Swift, Qt and the terminals already write. */
export function canonicalStates(root = REPO_ROOT): Map<string, string> {
  const comps = JSON.parse(
    readFileSync(
      resolve(root, "packages/brand/kit-copy/components.json"),
      "utf8",
    ),
  ) as { components: Record<string, { states: Record<string, unknown> }> };
  const out = new Map<string, string>();
  for (const [component, c] of Object.entries(comps.components))
    for (const state of Object.keys(c.states)) {
      const id = `${kebab(component)}-${state}`;
      out.set(squash(id), id);
    }
  return out;
}

/** The registry's id for a kit's state name: the name itself, or the longest registry id it
 *  starts with (a variant follows it: Qt's ".narrow", the terminal's "-platform-npm"); null when
 *  no registry state is named. */
export function canonicalOf(
  canon: Map<string, string>,
  raw: string,
): string | null {
  const key = squash(raw);
  const exact = canon.get(key);
  if (exact) return exact;
  let best: string | null = null;
  let bestLen = 0;
  for (const [k, id] of canon)
    if (key.startsWith(k) && k.length > bestLen) {
      best = id;
      bestLen = k.length;
    }
  return best;
}

export function collect(
  root = REPO_ROOT,
  opts: { crossRenderer?: boolean } = {},
): Report {
  const canon = canonicalStates(root);
  const shots: Shot[] = [];
  const boardNames = BOARDS.map((b) => b.name).sort(
    (a, b) => b.length - a.length,
  );
  for (const file of walkPngs(resolve(root, SHOTS_DIR))) {
    const { rest, theme } = splitTheme(basename(file, ".png"));
    const board = boardNames.find((b) => rest.startsWith(`${b}-`));
    if (!board) continue;
    const variant = rest.slice(board.length + 1);
    shots.push({
      source: `mockup:${board}`,
      state: stateOf(variant),
      variant,
      theme,
      file,
    });
  }
  for (const { kit, dir } of BASELINE_DIRS) {
    const base = resolve(root, dir);
    for (const file of walkPngs(base)) {
      const { rest, theme } = splitTheme(stem(file));
      // Either <state>-<theme>.png, or <state>/<variant>-<theme>.png (Roborazzi's layout).
      const parts = relative(base, file).split(/[\\/]/);
      // Compose keeps the registry's states one level down, under matrix/.
      if (parts[0] === "matrix" && parts.length > 2) parts.shift();
      const raw = parts.length > 1 ? parts[0]! : stateOf(rest);
      // React writes Component.state, Qt lowercases the component, Compose uses camelCase: all
      // meet the registry's id. A state no registry row names stays as the kit wrote it.
      const state = canonicalOf(canon, raw) ?? raw;
      const variant = parts.length > 1 ? `${parts[0]} ${rest}` : rest;
      shots.push({ source: kit, state, variant, theme, file });
    }
  }
  const states = [...new Set(shots.map((s) => s.state))].sort();
  const sources = [...new Set(shots.map((s) => s.source))];

  const unrendered: Report["unrendered"] = [];
  const comps = JSON.parse(
    readFileSync(
      resolve(root, "packages/brand/kit-copy/components.json"),
      "utf8",
    ),
  ) as { components: Record<string, { states: Record<string, unknown> }> };
  const kitShots = shots.filter((s) => !s.source.startsWith("mockup:"));
  for (const [component, c] of Object.entries(comps.components))
    for (const state of Object.keys(c.states)) {
      const id = `${kebab(component)}-${state}`;
      if (!kitShots.some((s) => s.state === id || s.variant.startsWith(id)))
        unrendered.push({ component, state });
    }

  const crossRenderer =
    opts.crossRenderer === false
      ? null
      : applyAllow(
          compareDirs(
            resolve(root, CROSS_RENDERER.a),
            resolve(root, CROSS_RENDERER.b),
            {
              outDir: resolve(root, "packages/ui-qa/.out/cross-renderer"),
            },
          ),
          root,
        );
  return { shots, states, sources, unrendered, crossRenderer };
}

/** The states whose React/elements difference is a recorded finding (cross-renderer-allow.json).
 *  An allowed state's mismatches become `allowed`; an entry whose state now matches in full is
 *  `stale-allow` and fails, so the list only shrinks. An entry's own `maxRatio` loosens its
 *  threshold (a looping animation) and is never stale. */
export function applyAllow(
  results: PairResult[] | null,
  root = REPO_ROOT,
): PairResult[] | null {
  if (!results) return null;
  const file = resolve(root, "packages/ui-qa/cross-renderer-allow.json");
  if (!existsSync(file)) return results;
  const allow = (
    JSON.parse(readFileSync(file, "utf8")) as {
      states: Record<string, { reason: string; maxRatio?: number }>;
    }
  ).states;
  const stateOfName = (n: string) => n.split("/")[0]!;
  const out = results.map((p): PairResult => {
    const entry = allow[stateOfName(p.name)];
    if (!entry || p.status === "match") return p;
    if (entry.maxRatio !== undefined && p.ratio !== undefined)
      return p.ratio <= entry.maxRatio
        ? { ...p, status: "allowed", detail: `${p.detail} (tolerated)` }
        : p;
    return {
      ...p,
      status: "allowed",
      detail: `${p.detail} (allowed: ${entry.reason})`,
    };
  });
  for (const [state, entry] of Object.entries(allow)) {
    if (entry.maxRatio !== undefined) continue;
    const mine = out.filter((p) => stateOfName(p.name) === state);
    if (mine.length === 0 || mine.some((p) => p.status === "allowed")) continue;
    out.push({
      name: `${state}/`,
      status: "stale-allow",
      detail: `${state}: now matches in React and elements; remove it from cross-renderer-allow.json`,
    });
  }
  return out;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

export function renderHtml(r: Report, outFile: string): string {
  const rel = (f: string) =>
    relative(dirname(outFile), f).split("\\").join("/");
  const rows = r.states
    .map((state) => {
      const cells = (["dark", "light"] as const)
        .map((theme) => {
          const here = r.shots.filter(
            (s) => s.state === state && (s.theme === theme || s.theme === ""),
          );
          if (!here.length) return "";
          const figs = here
            .map(
              (s) =>
                `<figure><img loading="lazy" src="${esc(rel(s.file))}" alt="${esc(`${s.source} ${s.variant} ${theme}`)}"><figcaption>${esc(s.source)} · ${esc(s.variant)}</figcaption></figure>`,
            )
            .join("");
          return `<div class="theme ${theme}"><h3>${theme}</h3><div class="row">${figs}</div></div>`;
        })
        .join("");
      const srcs = [
        ...new Set(
          r.shots.filter((s) => s.state === state).map((s) => s.source),
        ),
      ];
      return `<section id="${esc(state)}"><h2>${esc(state)} <small>${srcs.length} source${srcs.length === 1 ? "" : "s"}: ${esc(srcs.join(", "))}</small></h2>${cells}</section>`;
    })
    .join("\n");
  const cross = r.crossRenderer
    ? `<ul>${r.crossRenderer.map((p) => `<li class="${p.status}">${esc(p.detail)}</li>`).join("")}</ul>`
    : `<p>Inactive: it runs once both <code>${esc(CROSS_RENDERER.a)}</code> and <code>${esc(CROSS_RENDERER.b)}</code> exist.</p>`;
  const missing = r.unrendered.length
    ? `<details><summary>${r.unrendered.length} component states with no kit render yet</summary><ul>${r.unrendered
        .map((u) => `<li>${esc(u.component)} · ${esc(u.state)}</li>`)
        .join("")}</ul></details>`
    : "<p>Every component state has a kit render.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>UI kits · side by side</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif;background:#0b0d12;color:#e6e8ee}
body{margin:0;padding:32px 40px 80px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:40px 0 12px}h2 small{font-weight:400;color:#8b93a3;font-size:13px}
h3{font-size:12px;font-weight:500;color:#8b93a3;margin:12px 0 8px}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:16px 0 8px}nav a{color:#9fc7ff;text-decoration:none}
.row{display:flex;gap:20px;overflow-x:auto;align-items:flex-start;padding-bottom:8px}
figure{margin:0;flex:none}figure img{display:block;max-height:420px;width:auto;border-radius:8px;outline:1px solid #ffffff14}
figcaption{font-size:12px;color:#8b93a3;margin-top:6px}
.light figure img{outline-color:#0000001a}.mismatch,.size,.only-a,.only-b{color:#ff8a7a}
</style></head><body>
<h1>UI kits · side by side</h1>
<p>${r.shots.length} renders from ${r.sources.length} sources (${esc(r.sources.join(", "))}) across ${r.states.length} states. Generated by <code>pnpm ui:report</code>; UI-KITS.md §7.1.</p>
<nav>${r.states.map((s) => `<a href="#${esc(s)}">${esc(s)}</a>`).join("")}</nav>
<h2>Cross-renderer diff (React vs elements)</h2>${cross}
<h2>Coverage</h2>${missing}
${rows}
</body></html>
`;
}

export function writeReport(outFile: string, root = REPO_ROOT): Report {
  const r = collect(root);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderHtml(r, outFile));
  return r;
}
