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

/** Budgets are gzip bytes of JS over the bare-React baseline. Ratchet down, never up. */
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
  "provider+license-gate": `${REACT}
import { PolarisKeyProvider, LicenseGate } from "@polaris-key/react";
createRoot(document.getElementById("root")).render(
  createElement(PolarisKeyProvider, { baseUrl: "https://example.test", productId: "p" },
    createElement(LicenseGate, null, "app")));
`,
  "provider+use-license": `${REACT}
import { PolarisKeyProvider, useLicense } from "@polaris-key/react";
function App() { return createElement("div", null, String(useLicense().state)); }
createRoot(document.getElementById("root")).render(
  createElement(PolarisKeyProvider, { baseUrl: "https://example.test", productId: "p" },
    createElement(App)));
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
    // chunk is fetched later: reported apart, not budgeted, and the wasm check skips it.
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
