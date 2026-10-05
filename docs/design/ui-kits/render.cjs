// Renders the UI-kit mockups to PNG: every [data-shot] element on every board, dark and light.
//
//   NODE_PATH=packages/admin/node_modules node docs/design/ui-kits/render.cjs [--scale=2] [--out=dir] [board ...]
//
// Output: <out>/<board>-<shot>-<theme>.png (default out: docs/design/ui-kits/shots). The committed
// set is rendered at --scale=1 and kept lossless (no resizing, no palette quantisation, so
// hairlines and type stay honest); review at --scale=2 into a scratch folder. Shots are drawn at
// real window sizes: web 1440 × 900 and 390 × 844, iPhone 402 × 874 pt, Android 412 × 915 dp,
// Mac windows at their content size, Godot 1280 × 720 and 1280 × 800 (Steam Deck).
//
// The script fails if any page logs a console error or a font fails to load.
//
// Boards: web, ios, android, desktop (macOS), windows, linux, godot, terminal.
const path = require("node:path");
const { chromium } = require("playwright");

const dir = __dirname;
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
};
const scale = +opt("scale", 1);
const out = path.resolve(opt("out", path.join(dir, "shots")));
const named = args.filter((a) => !a.startsWith("--"));
const boards = named.length
  ? named
  : [
      "web",
      "ios",
      "android",
      "desktop",
      "windows",
      "linux",
      "godot",
      "terminal",
    ];

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  for (const board of boards) {
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({
        viewport: { width: 3200, height: 2000 },
        deviceScaleFactor: scale,
      });
      page.on("console", (m) => {
        if (m.type() === "error") {
          failed = true;
          console.error(`${board} ${theme}: ${m.text()}`);
        }
      });
      page.on("pageerror", (e) => {
        failed = true;
        console.error(`${board} ${theme}: ${e.message}`);
      });
      await page.goto(
        `file://${path.join(dir, `${board}.html`)}?theme=${theme}`,
      );
      await page.evaluate(() => document.fonts.ready);
      const bad = await page.evaluate(() =>
        [...document.fonts]
          .filter((f) => f.status === "error")
          .map((f) => f.family),
      );
      if (bad.length) {
        failed = true;
        console.error(`${board} ${theme}: fonts failed: ${bad.join(", ")}`);
      }
      await page.waitForTimeout(200);
      const shots = await page.$$("[data-shot]");
      for (const el of shots) {
        const name = await el.getAttribute("data-shot");
        await el.screenshot({
          path: path.join(out, `${board}-${name}-${theme}.png`),
          animations: "disabled",
        });
      }
      console.log(`${board} ${theme}: ${shots.length} shots`);
      await page.close();
    }
  }
  await browser.close();
  if (failed) process.exit(1);
})();
