// Renders the SIGN-IN.md key frames to PNG: every [data-shot] in card.html, dark and light.
//
//   NODE_PATH=packages/admin/node_modules node docs/design/sign-in/render.cjs [--scale=1] [--out=dir] [--only=05]
//
// Output: <out>/<frame>-<size>-<theme>.png (default out: docs/design/sign-in/shots). Desktop
// frames are 1440 wide (min 900 tall), phone frames 390 wide (min 844 tall). Fails on any
// console error or a font that does not load, like the UI-kit renderer.
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const dir = __dirname;
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
};
const scale = +opt("scale", 1);
const out = path.resolve(opt("out", path.join(dir, "shots")));
const only = opt("only", "");
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: scale,
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        failed = true;
        console.error(`${theme}: ${m.text()}`);
      }
    });
    page.on("pageerror", (e) => {
      failed = true;
      console.error(`${theme}: ${e.message}`);
    });
    const q = `?theme=${theme}${only ? `&only=${only}` : ""}`;
    await page.goto(`file://${path.join(dir, "card.html")}${q}`);
    await page.evaluate(() => document.fonts.ready);
    const bad = await page.evaluate(() =>
      [...document.fonts]
        .filter((f) => f.status === "error")
        .map((f) => f.family),
    );
    if (bad.length) {
      failed = true;
      console.error(`${theme}: fonts failed: ${bad.join(", ")}`);
    }
    // No horizontal overflow inside a phone frame (EXPERIENCE §7.1: no sideways scroll at 360+).
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll(".screen.phone")]
        .filter((s) => s.scrollWidth > s.clientWidth + 1)
        .map((s) => s.dataset.shot),
    );
    if (wide.length) {
      failed = true;
      console.error(`${theme}: horizontal overflow in ${wide.join(", ")}`);
    }
    const shots = await page.$$("[data-shot]");
    for (const el of shots) {
      const name = await el.getAttribute("data-shot");
      await el.screenshot({
        path: path.join(out, `${name}-${theme}.png`),
        animations: "disabled",
      });
    }
    console.log(`${theme}: ${shots.length} shots`);
    await page.close();
  }
  await browser.close();
  if (failed) process.exit(1);
})();
