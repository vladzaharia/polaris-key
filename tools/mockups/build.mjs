#!/usr/bin/env node
/**
 * Builds the single-page mockups artifact from docs/design/mockups/.
 *
 *   node tools/mockups/build.mjs <out.html>
 *
 * Reads areas.json, kit/mockup.css and every screens/<area>/<id>.{html,json}, and writes one
 * self-contained page (tools/mockups/page.html with the data inlined). Status, built screenshots,
 * built-screen reviews and notes are not baked in: the published page reads them from its own
 * database, so the lead updates them without republishing.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dir = join(root, "docs", "design", "mockups");
const out = process.argv[2];
if (!out) {
  console.error("usage: node tools/mockups/build.mjs <out.html>");
  process.exit(2);
}

const areas = JSON.parse(readFileSync(join(dir, "areas.json"), "utf8"));
const kitCss = readFileSync(join(dir, "kit", "mockup.css"), "utf8");
const screens = [];
const problems = [];
for (const area of areas) {
  const adir = join(dir, "screens", area.key);
  if (!existsSync(adir)) continue;
  for (const f of readdirSync(adir).filter((n) => n.endsWith(".json")).sort()) {
    const meta = JSON.parse(readFileSync(join(adir, f), "utf8"));
    const htmlPath = join(adir, f.replace(/\.json$/, ".html"));
    if (!existsSync(htmlPath)) {
      problems.push(`${meta.id}: no .html beside ${f}`);
      continue;
    }
    if (meta.area !== area.key) problems.push(`${meta.id}: area "${meta.area}" but lives in ${area.key}/`);
    screens.push({ ...meta, area: area.key, html: readFileSync(htmlPath, "utf8") });
  }
}
// Keep each area's screens in a stable, deliberate order: an explicit "order" field first, then id.
screens.sort((a, b) => {
  const ai = areas.findIndex((x) => x.key === a.area), bi = areas.findIndex((x) => x.key === b.area);
  return ai - bi || (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id);
});

const data = JSON.stringify({ areas, kitCss, screens }).replace(/<\//g, "<\\/").replace(/<!--/g, "\\u003c!--");
const page = readFileSync(join(here, "page.html"), "utf8").replace("/*__DATA__*/", () => data);
writeFileSync(out, page);
const kb = Math.round(statSync(out).size / 1024);
console.log(`wrote ${out}: ${screens.length} screens in ${areas.length} areas, ${kb} KB`);
for (const p of problems) console.warn("warning:", p);
if (kb > 15 * 1024) {
  console.error("the page is over 15 MB; the artifact limit is 16 MB");
  process.exit(1);
}
