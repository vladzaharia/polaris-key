// Screenshots the console product card boards, and lints the Home boards with the console's own
// layout probe (packages/admin/e2e/layoutProbe.ts: equal-height rows, pill-right, overflow).
//
//   mise exec node@22 -- node docs/design/console-product-card/_src/build.mjs
//   mise exec node@22 -- node_modules/.bin/tsx docs/design/console-product-card/_src/render.mts [id ...]
//
// Output: shots/<id>-<desktop|phone|states>-<dark|light>.png at device scale 2, full height:
// desktop 1280 wide (the 3-column grid), phone 390 wide (one column), states 1280 wide. The PNGs
// are then palette-quantised with sharp (lossless dimensions, quality 90) to keep the folder small.
// The script fails on a console error, a font that did not load, a page wider than its viewport, or
// any layout-probe violation on a Home board.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeLayout } from "../../../../packages/admin/e2e/layoutProbe.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..");
const repo = join(here, "../../../..");
const { chromium } = createRequire(join(repo, "packages/admin/package.json"))(
  "playwright",
) as typeof import("playwright");
const sharp = createRequire(join(repo, "packages/brand/package.json"))(
  "sharp",
) as typeof import("sharp");

const only = process.argv.slice(2);
const IDS = ["a-rail", "b-ledger", "c-spectrum"].filter(
  (id) => !only.length || only.includes(id),
);
const BOARDS = [
  {
    kind: "desktop",
    file: (id: string) => `${id}.html`,
    vp: { width: 1280, height: 800 },
    probe: true,
  },
  {
    kind: "phone",
    file: (id: string) => `${id}.html`,
    vp: { width: 390, height: 844 },
    probe: true,
    mobile: true,
  },
  {
    kind: "states",
    file: (id: string) => `${id}-states.html`,
    vp: { width: 1280, height: 800 },
    probe: false,
  },
] as const;

const browser = await chromium.launch();
let failed = false;
const shots: string[] = [];
try {
  for (const id of IDS) {
    for (const b of BOARDS) {
      for (const theme of ["dark", "light"] as const) {
        const tag = `${id} ${b.kind} ${theme}`;
        const ctx = await browser.newContext({
          viewport: b.vp,
          deviceScaleFactor: 2,
          colorScheme: theme,
          reducedMotion: "reduce",
          isMobile: "mobile" in b,
          hasTouch: "mobile" in b,
        });
        // tsx compiles with esbuild's keepNames, so the serialised probe calls `__name(fn, "…")`;
        // the page needs that helper as a no-op.
        await ctx.addInitScript("window.__name = (fn) => fn;");
        const pg = await ctx.newPage();
        pg.on("console", (m) => {
          if (m.type() === "error") {
            failed = true;
            console.error(`${tag}: ${m.text()}`);
          }
        });
        pg.on("pageerror", (e) => {
          failed = true;
          console.error(`${tag}: ${e.message}`);
        });
        await pg.goto(`file://${join(dir, b.file(id))}?theme=${theme}`);
        await pg.evaluate(() => document.fonts.ready);
        const fonts = await pg.evaluate(() =>
          ["14px Rubik", "12px 'JetBrains Mono'"].map((f) =>
            document.fonts.check(f),
          ),
        );
        if (fonts.includes(false)) {
          failed = true;
          console.error(`${tag}: a brand font did not load`);
        }
        const wide = await pg.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        if (wide) {
          failed = true;
          console.error(`${tag}: wider than the viewport`);
        }
        if (b.probe) {
          const res = await pg.evaluate(probeLayout, {
            trailingSlack: 48,
            rows: b.kind === "desktop",
          });
          for (const v of res.violations) {
            failed = true;
            console.error(
              `${tag}: [${v.rule}/${v.kind}] ${v.detail}\n    at ${v.where}`,
            );
          }
          const heights = await pg.$$eval("ul.grid > li > article", (els) =>
            els.map((e) => Math.round(e.getBoundingClientRect().height)),
          );
          console.log(
            `${tag}: cards ${heights.join("/")} px, ${res.violations.length} layout violations`,
          );
        }
        await pg.evaluate(() => {
          document.documentElement.dataset.shot = "1";
        });
        const h = await pg.evaluate(
          () => document.documentElement.scrollHeight,
        );
        await pg.setViewportSize({
          width: b.vp.width,
          height: Math.max(h, b.vp.height),
        });
        const path = join(dir, "shots", `${id}-${b.kind}-${theme}.png`);
        await pg.screenshot({ path, animations: "disabled" });
        shots.push(path);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
for (const path of shots) {
  const buf = await sharp(path)
    .png({ palette: true, quality: 90, effort: 10 })
    .toBuffer();
  await sharp(buf).toFile(path);
}
console.log(`${shots.length} shots`);
if (failed) process.exit(1);
