// playwright-core 1.63.0 from content/npm (see README) unless PLAYWRIGHT_CORE names another entry point;
// Chromium from CHROMIUM, else the browser Playwright itself installed.
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE ||
    new URL("../../npm/node_modules/playwright-core/index.mjs", import.meta.url)
      .href
);
const base = process.argv[2] || "http://127.0.0.1:8123";
console.log("launching");
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  headless: true,
  timeout: 30000,
});
console.log("launched", b.version());
const p = await b.newPage();
p.on("console", (m) => console.log("[page]", m.text()));
await p.goto(base + "/runners/browser/index.html", { timeout: 15000 });
console.log("loaded", await p.title());
p.on("requestfailed", (r) => console.log("reqfail", r.url()));
p.on("response", (r) => {
  if (r.status() >= 400) console.log("resp", r.status(), r.url());
});
const v = await Promise.race([
  p.evaluate(() => call("caps")),
  new Promise((r) => setTimeout(() => r("TIMEOUT"), 10000)),
]);
console.log(JSON.stringify(v).slice(0, 2000));
console.log("workerError", await p.evaluate(() => window.__workerError));
await b.close();
