// Renders the S-24 licence-holder mockups: every NN-*.html at 1440 × 900 and 390 × 844, dark and light.
//
//   node docs/design/licenses/_src/build.mjs
//   NODE_PATH=packages/admin/node_modules node docs/design/licenses/render.cjs [prefix ...]
//
// Output: shots/<page>-<desktop|mobile>-<dark|light>.png. Pages are shot full height, except the
// ones with a fixed overlay (a dialog or drawer), which are shot at the viewport. The script fails
// on a console error, a font that did not load, or a page wider than its viewport. The committed
// set is then palette-quantised with sharp (png palette, quality 85) to keep the folder near 1 MB.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const dir = __dirname;
const only = process.argv.slice(2);
const pages = fs
  .readdirSync(dir)
  .filter((f) => /^\d\d[a-z]?-.*\.html$/.test(f))
  .filter((f) => !only.length || only.some((o) => f.startsWith(o)));
const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const VIEWPORT_ONLY = /new-license|portal-add-floating/;

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  for (const f of pages) {
    for (const [s, vp] of Object.entries(sizes)) {
      for (const theme of ["dark", "light"]) {
        const ctx = await browser.newContext({
          viewport: vp,
          deviceScaleFactor: 1,
          colorScheme: theme,
          isMobile: s === "mobile",
          hasTouch: s === "mobile",
        });
        const pg = await ctx.newPage();
        pg.on("console", (m) => {
          if (m.type() === "error") {
            failed = true;
            console.error(`${f} ${s} ${theme}: ${m.text()}`);
          }
        });
        await pg.goto(`file://${path.join(dir, f)}?theme=${theme}`);
        await pg.evaluate(() => document.fonts.ready);
        await pg.waitForTimeout(80);
        const wide = await pg.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        if (wide) {
          failed = true;
          console.error(`${f} ${s} ${theme}: wider than the viewport`);
        }
        if (!VIEWPORT_ONLY.test(f)) {
          const h = await pg.evaluate(
            () => document.documentElement.scrollHeight,
          );
          await pg.setViewportSize({
            width: vp.width,
            height: Math.max(h, vp.height),
          });
          await pg.waitForTimeout(60);
        }
        await pg.screenshot({
          path: path.join(
            dir,
            "shots",
            f.replace(".html", `-${s}-${theme}.png`),
          ),
          animations: "disabled",
        });
        await ctx.close();
      }
    }
    console.log(f);
  }
  await browser.close();
  if (failed) process.exit(1);
})();
