// Browser pass over the built site (docs plan 6.3, 8.5): serves dist/ under /docs, then in
// Chromium clicks Copy and expects "Copied" in the live region, and runs axe on the pages the UX
// review used at 1440, 390 and 320 px, in dark, light and forced colours.
//
//   pnpm --filter @polaris-key/docs build && pnpm --filter @polaris-key/docs test:browser
//
// Needs a Chromium: `pnpm exec playwright install chromium`. Not part of `pnpm test`.
// Environment: PKEY_SHOTS=<dir> writes a full-page screenshot per page, size and mode.

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const axeSource = (await import("node:fs")).readFileSync(
  require.resolve("axe-core/axe.min.js"),
  "utf8",
);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(
    /^\/docs/,
    "",
  );
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory())
    file = join(file, "index.html");
  if (!existsSync(file)) return void res.writeHead(404).end("not found");
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const PAGES = {
  components: "/docs/contribute/docs-components/",
  product: "/docs/start/first-product/",
  settings: "/docs/reference/settings/",
  "help-device-limit": "/docs/help/device-limit/",
};
const SIZES = [
  [1440, 900],
  [390, 800],
  [320, 700],
  [320, 700, "text200"],
];
const MODES = [
  ["dark", "none"],
  ["light", "none"],
  ["dark", "active"],
];
const RULES = [
  "color-contrast",
  "scrollable-region-focusable",
  "aria-allowed-attr",
  "aria-valid-attr-value",
  "button-name",
  "region",
  "link-name",
  "nested-interactive",
];
const shots = process.env.PKEY_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const report = [];
try {
  for (const [w, h, zoom] of SIZES)
    for (const [scheme, forced] of MODES) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: scheme,
        forcedColors: forced,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await ctx.newPage();
      await page.addInitScript(
        (s) => localStorage.setItem("pk-admin-theme", s),
        scheme,
      );
      for (const [name, path] of Object.entries(PAGES)) {
        await page.goto(base + path, { waitUntil: "networkidle" });
        if (zoom)
          await page.addStyleTag({
            content: "html { font-size: 200% !important; }",
          });
        const tag = `${name}-${w}${zoom ? "-" + zoom : ""}-${scheme}${forced === "active" ? "-forced" : ""}`;
        if (shots)
          await page.screenshot({
            path: join(shots, `${tag}.png`),
            fullPage: true,
          });
        const sideways = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        if (sideways) failures.push(`${tag}: the page scrolls sideways`);
        await page.addScriptTag({ content: axeSource });
        const axe = await page.evaluate(
          async (rules) => {
            const r = await window.axe.run(document, {
              runOnly: { type: "rule", values: rules },
            });
            return r.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              nodes: v.nodes.length,
              first: v.nodes[0]?.target?.join(" "),
            }));
          },
          RULES.filter((r) => r !== "region"),
        );
        // Forced colours measure no author colour, so axe's contrast rule has no meaning there.
        const bad = axe.filter(
          (v) => !(forced === "active" && v.id === "color-contrast"),
        );
        report.push(
          `${tag}: ${bad.length ? JSON.stringify(bad) : "axe clean"}`,
        );
        for (const v of bad)
          failures.push(`${tag}: axe ${v.id} (${v.nodes}) ${v.first}`);
      }
      // Copy: click the first button, expect "Copied" in its live region.
      if (forced === "none" && scheme === "dark" && !zoom) {
        await page.goto(base + PAGES.product, { waitUntil: "networkidle" });
        const button = page.locator(".expressive-code .copy button").first();
        const name = await button.getAttribute("aria-label");
        if (!/^Copy .+/.test(name ?? "") || name === "Copy to clipboard")
          failures.push(`copy: button name is ${name}`);
        await button.click();
        const live = button.locator("xpath=..").locator("[aria-live]");
        await live
          .locator(".feedback")
          .first()
          .waitFor({ timeout: 3000 })
          .catch(() => {});
        const said = (await live.textContent())?.trim();
        if (said !== "Copied")
          failures.push(`copy: live region says "${said}" at ${w}px`);
        report.push(`copy ${w}px: "${said}" (${name})`);
      }
      await ctx.close();
    }
} finally {
  await browser.close();
  server.close();
}
console.log(report.join("\n"));
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nbrowser pass ok");
