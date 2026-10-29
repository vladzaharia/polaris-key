// Bundle size budget for @polaris-key/react (SP-47).
//
// Builds each case below with Vite (production, minified, like an integrator's app) against the
// built `dist/`, gzips the emitted JS and compares the delta over a bare React app with the
// budget. It also fails if any case emits a `.wasm` or inlines one (a `data:application/wasm`
// URI, or the wasm magic bytes in base64).
//
//   node scripts/size-budget.mjs            check against budgets (exit 1 over budget)
//   node scripts/size-budget.mjs --report   print the table only
//   node scripts/size-budget.mjs --budget provider+use-license=1000   override one budget (negative control)
//   node scripts/size-budget.mjs --json     print the measurements as JSON
//
// Run `pnpm build` first (the cases import the package by name, i.e. `dist/`).
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const KB = 1000;

/**
 * Budgets are gzip bytes of JS over the bare-React baseline. Ratchet down, never up.
 *
 * polaris-key-gate 71.5 -> 83.5 KB (v0.9.12): the gate now carries the Polaris Locker
 * "Powered by" badge (LK-01/LK-16: the badge templates and the label's outlined prefix, about
 * 9 KB) and P0-38's sign-in model and copy (about 3 KB). The first version of that art also pulled
 * the other fifteen badge labels' prefixes in (+12 KB); `LOCKER_POWERED_BY_PREFIX` keeps them out.
 *
 * polaris-key-gate 84.3 -> 70.8 KB (v0.9.13 growth taken back out): the badge artwork loads when an
 * About screen first shows it (`@polaris-key/brand/badge`, generated/locker-badge.ts: -6.6 KB),
 * and the English copy table the web kits bundle leaves out `core.codes.*` and the terminal's
 * `cli.*` (`kit-copy/lean`; they arrive as one lazy table, -6.9 KB). Left to reach 68.5: the
 * steps the gate does not show first (offline, paywall, settings) are still in the entry.
 *
 * polaris-key-gate 73.5 -> 68.1 KB (WEB-parity): the QR encoder (-2.0 KB) and the rows of the
 * screens the gate rarely shows first (OfflineActivation's steps, device rows, release notes,
 * settings rows, the account pane, the channel picker: -3.4 KB) load on demand (`kit/lazy.ts`,
 * `kit/rows.tsx`), as a copy pack does. The budget stays at 71.2: the headroom is for the
 * milestones' growth, not a licence to raise it.
 *
 * polaris-key-gate 71.2 -> 72.0 KB (v0.9.17): the desktop kit (UK-06) grew the gate to 77.6 KB;
 * its chrome stylesheet (`kit/desktopCss.js`) and the menu-opened Settings and update drivers
 * (`kit/openedViews.tsx`) now load on demand (-5.9 KB). What stays is web-path code every gate
 * runs (platform variant, desktop button order, the desktop-sheet hook): 71.67 KB. To take back
 * out: the offline, paywall and settings steps still in the entry.
 *
 * polaris-key-gate 72.0 -> 71.0 KB (ratchet; staging measured 71.8): the rows of the offline and
 * settings steps were already on demand; what still sat in the entry was ui-core's whole model
 * table (`MODELS`, reached through `ViewModel`/`viewOf`: sign-in, settings, devices, update,
 * paywall, offline). The kit now hands `useKit` the model of the component it draws
 * (`BareViewModel`), and the gate names only the six screens it draws, so the other models load
 * with the components that use them. No lazy chunk, so no second copy of shared state: 70.9 KB.
 *
 * polaris-key-gate 71.0 -> 71.2 KB and provider+use-license 88.0 -> 89.5 KB (STAB-2a, measured
 * 71.04 and 89.15): the identity v2 client the provider bundles grew with the activation outcomes
 * and account calls (I-10a.9), signIn.start for the device code and the web redirect (I-10a.10)
 * and identity.choice (I-10a.11). It is the engine every provider ships, not kit chrome; the
 * gate entry carries only what its sign-in step reaches. To take back out: the redirect and
 * choice steps, on demand.
 *
 * polaris-key-gate 71.2 -> 76.0 KB and provider+use-license 89.5 -> 94.0 KB (owner, 2026-10-28:
 * size matters, but not to the point of hard optimizations): measured about 70.7 and 89.5. The
 * budgets still catch a large regression; ordinary feature growth no longer needs a lazy split.
 */
export const BUDGETS = JSON.parse(
  readFileSync(join(here, "size-budget.json"), "utf8"),
);

const REACT = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
`;
export const CASES = {
  baseline: `${REACT}
createRoot(document.getElementById("root")).render(createElement("div", null, "hi"));
`,
  "polaris-key-gate": `${REACT}
import { PolarisKeyGate } from "@polaris-key/react/kit";
createRoot(document.getElementById("root")).render(
  createElement(PolarisKeyGate, { input: { gate: { status: "ok" } } }, "app"));
`,
  "provider+use-license": `${REACT}
import { PolarisKeyProvider, useLicense } from "@polaris-key/react";
const config = { productSlug: "p", baseUrl: "https://example.test", trust: { pinnedKeys: {} } };
function App() { return createElement("div", null, String(useLicense().state)); }
createRoot(document.getElementById("root")).render(
  createElement(PolarisKeyProvider, { config }, createElement(App)));
`,
};

async function measure(name, source) {
  const { build } = await import("vite");
  const dir = mkdtempSync(join(pkgRoot, ".size-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "index.html"),
      `<div id="root"></div><script type="module" src="/src/main.js"></script>`,
    );
    writeFileSync(join(dir, "src/main.js"), source);
    const out = await build({
      root: dir,
      logLevel: "silent",
      configFile: false,
      resolve: { dedupe: ["react", "react-dom"] },
      build: {
        outDir: "dist",
        write: false,
        minify: "esbuild",
        assetsInlineLimit: 0,
        target: "es2022",
      },
    });
    const files = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
    // Initial load = the entry chunk plus everything it imports statically. A dynamic import()
    // chunk is fetched later: reported apart and not budgeted. A .wasm file anywhere fails the check; an inlined wasm is looked for in the initial load only.
    const chunks = new Map(
      files.filter((f) => f.type === "chunk").map((f) => [f.fileName, f]),
    );
    const initial = new Set();
    const walk = (n) => {
      if (initial.has(n) || !chunks.has(n)) return;
      initial.add(n);
      for (const i of chunks.get(n).imports) walk(i);
    };
    for (const c of chunks.values()) if (c.isEntry) walk(c.fileName);
    let js = 0;
    let lazy = 0;
    const wasm = files
      .filter((f) => f.fileName.endsWith(".wasm"))
      .map((f) => f.fileName);
    for (const [fileName, c] of chunks) {
      const size = gzipSync(c.code).length;
      if (!initial.has(fileName)) {
        lazy += size;
        continue;
      }
      js += size;
      if (/data:application\/wasm|AGFzbQ/.test(c.code))
        wasm.push(`inlined in ${fileName}`);
    }
    return { name, gzipJs: js, lazyGzipJs: lazy, wasm };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function run() {
  const results = [];
  for (const [name, src] of Object.entries(CASES))
    results.push(await measure(name, src));
  const base = results.find((r) => r.name === "baseline").gzipJs;
  return results
    .filter((r) => r.name !== "baseline")
    .map((r) => ({
      ...r,
      deltaGzip: r.gzipJs - base,
      budget: BUDGETS[r.name],
    }));
}

/** The failures in `rows` (over budget, or any wasm emitted or inlined into the initial load). */
export function verdict(rows) {
  return rows.flatMap((r) => [
    ...(r.deltaGzip > r.budget
      ? [
          `${r.name}: +${r.deltaGzip} B gzip is over the budget of ${r.budget} B`,
        ]
      : []),
    ...(r.wasm.length
      ? [`${r.name}: wasm emitted (${r.wasm.join(", ")})`]
      : []),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // `--budget <case>=<bytes>` overrides a budget: the CI negative control uses it to prove the
  // check fails when a budget is exceeded.
  for (const [i, a] of args.entries())
    if (a === "--budget") {
      const [k, v] = args[i + 1].split("=");
      BUDGETS[k] = Number(v);
    }
  const rows = await run();
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else
    for (const r of rows)
      console.log(
        `${r.name.padEnd(24)} +${(r.deltaGzip / KB).toFixed(1)} KB gzip initial (budget ${(r.budget / KB).toFixed(1)} KB; +${(r.lazyGzipJs / KB).toFixed(1)} KB lazy), wasm: ${r.wasm.length ? r.wasm.join(", ") : "none"}`,
      );
  if (!args.includes("--report")) {
    const bad = verdict(rows);
    if (bad.length) {
      console.error(`size budget FAILED:\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
  }
}
