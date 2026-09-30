// Playwright driver for the S-04 browser matrix (index.html) and the Godot web export.
// usage: node drive.mjs <chromium|webkit|firefox> <base-url> [tag]
//   CPU=<n>       Chromium only: CDP Emulation.setCPUThrottlingRate (4 = Lighthouse's mid-tier mobile)
//   LARGE=1       also bench the 37 MB set
//   SKIP=<steps>  comma list passed to index.html (e.g. Ed25519 to isolate a crash)
//   EDMAX=<bytes> skip WebCrypto Ed25519 inputs larger than this (65000 for WebKitGTK)
//   GODOT=1       load /lowend/build/web/index.html instead and wait for the wrapper's POST
//   TIMEOUT_S=<n> default 900
// playwright-core comes from ../../content/npm (see ../../content/README.md step 4).
import { writeFileSync, mkdirSync } from "node:fs";
const pw = await import(
  new URL(
    "../../content/npm/node_modules/playwright-core/index.mjs",
    import.meta.url,
  ).href
);
const [engine = "chromium", base = "http://127.0.0.1:8123", tagArg] =
  process.argv.slice(2);
const cpu = +(process.env.CPU || 0);
const tag =
  tagArg ||
  `${process.env.GODOT ? "godot-web" : "browser"}-${engine}${cpu ? "-cpu" + cpu : ""}`;
// Headless Firefox in a GPU-less container has no WebGL2 (Godot refuses to start); force software GL.
const browser = await pw[engine].launch({
  headless: true,
  ...(engine === "firefox"
    ? {
        firefoxUserPrefs: {
          "webgl.force-enabled": true,
          "webgl.disabled": false,
        },
      }
    : {}),
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on(
  "console",
  (m) =>
    /\[s04\]|posted|error/i.test(m.text()) &&
    console.log(`[${engine}]`, m.text().slice(0, 300)),
);
page.on("pageerror", (e) => console.log(`[${engine}] pageerror`, e.message));
if (cpu && engine === "chromium") {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
}
const timeout = (+process.env.TIMEOUT_S || 900) * 1000;
const t0 = Date.now();
let result;
if (process.env.GODOT) {
  const posted = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().includes("/results/"),
    { timeout },
  );
  await page.goto(`${base}/lowend/build/web/index.html`);
  result = JSON.parse((await posted).postData());
} else {
  await page.goto(
    `${base}/lowend/browser/index.html?tag=${encodeURIComponent(tag)}${process.env.LARGE ? "&large=1" : ""}${process.env.SKIP ? "&skip=" + process.env.SKIP : ""}${process.env.EDMAX ? "&edmax=" + process.env.EDMAX : ""}`,
  );
  await page.waitForFunction(() => window.__done === true, null, {
    timeout,
    polling: 1000,
  });
  result = await page.evaluate(() => window.__result);
}
result.driver = {
  engine,
  version: browser.version(),
  cpuThrottle: cpu || null,
  wallS: (Date.now() - t0) / 1000,
};
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const f = new URL(`../results/${tag}.json`, import.meta.url);
writeFileSync(f, JSON.stringify(result));
console.log(
  `wrote ${f.pathname} (${browser.version()}, ${result.driver.wallS}s)`,
);
await browser.close();
