// The tier pass over the built site (DOC-03b), run last by `pnpm build`:
//   - dist/docs-access.json: the path prefixes and their tiers, from src/lib/doors.ts;
//   - one Pagefind bundle per tier, so a search never returns text its reader may not open:
//     dist/pagefind (public), dist/pagefind-member (public + member), dist/pagefind-admin (all);
//   - the sitemap keeps public pages only; Help moves to dist/sitemap-help.xml (polaris.locker).
// The worker serves each bundle at its own tier (SEARCH_BUNDLES in packages/worker/src/docs.ts);
// packages/docs/test/searchBundles.test.ts pins the two.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as pagefind from "pagefind";
import {
  SEARCH_BUNDLES as BUNDLES,
  TIER_PREFIXES,
  doorOf,
  type Tier,
} from "../src/lib/doors";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

const RANK: Record<Tier, number> = { public: 0, member: 1, admin: 2 };

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

/** The content id of a built page: `help/activate/index.html` is `help/activate`. */
function idOf(file: string): string {
  const rel = relative(dist, file).split(sep).join("/");
  const id = rel.replace(/(^|\/)index\.html$/, "");
  return id === "" ? "index" : id;
}

/** The tier of a built page; a page no door owns is admin, as in the worker. */
function tierOfPage(file: string): Tier {
  return doorOf(idOf(file))?.tier ?? "admin";
}

if (!existsSync(dist)) {
  console.error("build-search-bundles: no dist; run astro build first");
  process.exit(1);
}

writeFileSync(
  join(dist, "docs-access.json"),
  JSON.stringify(
    {
      version: 1,
      pages: TIER_PREFIXES.map(([prefix, , tier]) => [prefix, tier]),
      search: BUNDLES.map(([dir, tier]) => [`${dir}/`, tier]),
    },
    null,
    2,
  ) + "\n",
);

const pages = [...htmlFiles(dist)].filter(
  (f) => !relative(dist, f).startsWith("pagefind"),
);
const counts: string[] = [];
for (const [dir, tier] of BUNDLES) {
  const out = join(dist, dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { index, errors } = await pagefind.createIndex({});
  if (!index) throw new Error(`pagefind: ${errors.join("; ")}`);
  let n = 0;
  for (const file of pages) {
    if (RANK[tierOfPage(file)] > RANK[tier]) continue;
    const res = await index.addHTMLFile({
      // Starlight's own index keys a page by its path without the /docs base.
      url: "/" + relative(dist, dirname(file)).split(sep).join("/") + "/",
      content: readFileSync(file, "utf8"),
    });
    if (res.errors.length) throw new Error(res.errors.join("; "));
    n += res.file ? 1 : 0;
  }
  const written = await index.writeFiles({ outputPath: out });
  if (written.errors.length) throw new Error(written.errors.join("; "));
  counts.push(`${dir}=${n}`);
}
await pagefind.close();

// The sitemap lists public pages only (gated pages are also noindex, via src/routeData.ts).
let dropped = 0;
const sitemap = join(dist, "sitemap-0.xml");
// Help's canonical host is polaris.locker (src/lib/helpHost.ts), so its pages leave key.plrs.im's
// sitemap and list in the customer host's own `sitemap-help.xml` instead: a sitemap may only list
// URLs of its own host, and the customer host serves nothing but Help.
const CUSTOMER_SITE = "https://polaris.locker";
const helpUrls: string[] = [];
if (existsSync(sitemap)) {
  // Whole <url> blocks, whatever children they carry (<lastmod>, <xhtml:link>, …).
  const xml = readFileSync(sitemap, "utf8").replace(
    /<url>[\s\S]*?<\/url>/g,
    (block) => {
      const loc = /<loc>\s*https?:\/\/[^/<]+\/docs\/([^<]*?)\s*<\/loc>/.exec(
        block,
      );
      // A block whose address is not under /docs is not ours to judge: gated by default.
      const tier = loc
        ? (doorOf(loc[1]!.replace(/\/$/, "") || "index")?.tier ?? "admin")
        : "admin";
      if (tier !== "public") {
        dropped += 1;
        return "";
      }
      if (loc && /^help(\/|$)/.test(loc[1]!)) {
        helpUrls.push(`${CUSTOMER_SITE}/docs/${loc[1]!.trim()}`);
        return "";
      }
      return block;
    },
  );
  writeFileSync(sitemap, xml);
  writeFileSync(
    join(dist, "sitemap-help.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${helpUrls
      .map((u) => `<url><loc>${u}</loc></url>`)
      .join("")}</urlset>`,
  );
}
console.log(
  `build-search-bundles: ${counts.join(" ")}; ${dropped} gated pages out of the sitemap`,
);
