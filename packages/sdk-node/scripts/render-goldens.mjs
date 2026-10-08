#!/usr/bin/env node
// Rasterise the terminal kit's SVG goldens (test/cli/golden/svg/*.svg) into the PNGs the docs show
// (test/cli/golden/<state>-<theme>.png; packages/docs/src/lib/baselines.ts), at 1x and lossless,
// in Chromium with the kit mono (JetBrains Mono) and Rubik loaded from packages/brand. It also
// writes golden/png-sources.json, the SHA-256 of each PNG's source SVG, which
// test/cli/golden.test.ts checks: a changed SVG with a stale PNG fails.
//
//   node packages/sdk-node/scripts/render-goldens.mjs
//
// Playwright comes from packages/ui-qa (the visual QA package), so the SDK takes no browser
// dependency; install Chromium once with `pnpm --filter @polaris-key/ui-qa exec playwright
// install chromium`.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "..", "..");
const golden = join(pkg, "test", "cli", "golden");
const require = createRequire(join(repo, "packages", "ui-qa", "package.json"));
const { chromium } = require("playwright");

const font = (file) =>
  readFileSync(join(repo, "packages", "brand", "fonts", "ttf", file)).toString(
    "base64",
  );
const css = `
@font-face { font-family: "JetBrains Mono"; src: url(data:font/ttf;base64,${font("JetBrainsMono-Variable.ttf")}) format("truetype"); font-weight: 100 800; }
@font-face { font-family: "Rubik"; src: url(data:font/ttf;base64,${font("Rubik-Variable.ttf")}) format("truetype"); font-weight: 300 900; }
html, body { margin: 0; padding: 0; background: transparent; }
svg { display: block; }`;

const svgs = readdirSync(join(golden, "svg"))
  .filter((f) => f.endsWith(".svg"))
  .sort();
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const sources = {};
try {
  for (const file of svgs) {
    const svg = readFileSync(join(golden, "svg", file), "utf8");
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>${svg}</body></html>`,
    );
    await page.evaluate(() => document.fonts.ready);
    const png = file.replace(/\.svg$/, ".png");
    await page
      .locator("svg")
      .first()
      .screenshot({ path: join(golden, png), omitBackground: true });
    sources[png] = createHash("sha256").update(svg).digest("hex");
  }
} finally {
  await browser.close();
}
writeFileSync(
  join(golden, "png-sources.json"),
  `${JSON.stringify(sources, null, 2)}\n`,
);
console.log(`Rendered ${svgs.length} PNGs into ${golden}`);
