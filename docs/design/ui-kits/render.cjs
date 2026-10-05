// Renders the UI-kit mockups to PNG: every [data-shot] element on every board, dark and light.
//
//   NODE_PATH=packages/admin/node_modules node docs/design/ui-kits/render.cjs [board ...]
//
// Output: docs/design/ui-kits/shots/<board>-<shot>-<theme>.png at 2x device scale. The committed
// copies are then downscaled and quantised:
//   for f in docs/design/ui-kits/shots/*.png; do
//     magick "$f" -resize 60% -strip -dither FloydSteinberg -colors 256 "PNG8:$f"; done
//
// Boards: web, ios, android, desktop, godot, terminal.
const path = require("node:path");
const { chromium } = require("playwright");

const dir = __dirname;
const out = path.join(dir, "shots");
const boards = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["web", "ios", "android", "desktop", "godot", "terminal"];

(async () => {
  const browser = await chromium.launch();
  for (const board of boards) {
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({
        viewport: { width: 2400, height: 1600 },
        deviceScaleFactor: 2,
      });
      await page.goto(
        `file://${path.join(dir, `${board}.html`)}?theme=${theme}`,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
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
})();
