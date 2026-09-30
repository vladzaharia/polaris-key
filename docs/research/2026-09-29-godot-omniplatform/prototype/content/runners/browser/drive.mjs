// Playwright driver: starts Chromium, runs the suite with several primitive combos, probes caps, benchmarks.
// playwright-core 1.63.0 from content/npm (see README) unless PLAYWRIGHT_CORE names another entry point;
// Chromium from CHROMIUM, else the browser Playwright itself installed.
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE ||
    new URL("../../npm/node_modules/playwright-core/index.mjs", import.meta.url)
      .href
);
import { writeFileSync } from "node:fs";
const base = process.argv[2] || "http://127.0.0.1:8123";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  headless: true,
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(base + "/runners/browser/index.html");
await page.waitForFunction(() => window.ready);
const out = { version: browser.version() };
out.pageCaps = await page.evaluate(() => pageCaps());
out.workerCaps = await page.evaluate(() => call("caps"));
console.log(JSON.stringify(out, null, 1));
const combos = (
  process.env.COMBOS ||
  "small:webcrypto:bokuweb:range,small:noble:bokuweb:range,small:hashwasm:bokuweb:norange"
).split(",");
out.suites = {};
for (const c of combos) {
  const [set, sha, z, rg] = c.split(":");
  const r = await page.evaluate((a) => call("suite", a), {
    set,
    sha,
    z,
    range: rg === "range",
  });
  out.suites[c] = { n: r.n, bad: r.bad, ms: r.ms, logs: r.logs };
  if (process.env.DUMP && c === combos[0])
    writeFileSync(process.env.DUMP, JSON.stringify(r.results, null, 1));
  console.log(
    `browser ${c}: ${r.n - r.bad}/${r.n} match, ${r.ms} ms`,
    r.logs.join("\n"),
  );
}
if (!process.env.NOBENCH) {
  out.bench = await page.evaluate(
    (z) => call("bench", { z }),
    process.env.BENCHZ || "bokuweb",
  );
  console.log(JSON.stringify(out.bench, null, 1));
}
if (!process.env.NOCDT) {
  out.cdt = await page.evaluate(() => cdt());
  out.cdtLog = (await (await fetch(base + "/log")).json()).filter((e) =>
    e.path.startsWith("/cdt/"),
  );
  console.log(JSON.stringify({ cdt: out.cdt, log: out.cdtLog }, null, 1));
}
writeFileSync(
  process.env.OUT || "browser-results.json",
  JSON.stringify(out, null, 1),
);
await browser.close();
