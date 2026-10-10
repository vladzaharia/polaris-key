// Emit the route manifest of the built site: every path the worker can serve as a page,
// written to dist/docs-slugs.json. The console's help-link registry
// (packages/admin/src/lib/docsLinks.ts) is tested against this file
// (packages/worker/test/docsLinks.test.ts), so a help link pointing at a page that stopped
// existing fails CI instead of 404ing an operator.
//
//   routes   every served path, sorted (the console's drift gate reads this)
//   pages    per route: the page's frontmatter that tests and the console read (type, status,
//            services, sdks, lanes, lastReviewed), the heading anchors in its HTML, and for a
//            moved page `redirect`, the route it forwards to
//
// It also takes the hidden stubs out of the sitemap: a stub is a placeholder that reserves a
// path, so it is hidden from the sidebar, from search (`pagefind: false`) and from here.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isRedirectPage, redirectTarget } from "./redirect-fragments.mjs";
import {
  allIds,
  contentRoot,
  fileFor,
  routeOf,
  splitFrontmatter,
} from "./site-map.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

/** Heading anchors: the ids of h1..h6 in the page. */
export const anchorsOf = (html) => [
  ...new Set(
    [...html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map((m) => m[1]),
  ),
];

const FRONTMATTER_KEYS = [
  "type",
  "status",
  "services",
  "sdks",
  "lanes",
  "lastReviewed",
];

// Frontmatter by route, from the sources (a built page does not carry it).
const frontmatter = new Map();
for (const id of allIds()) {
  const { data } = splitFrontmatter(
    readFileSync(fileFor(id, contentRoot), "utf8"),
  );
  const picked = Object.fromEntries(
    FRONTMATTER_KEYS.filter((k) => data[k] !== undefined).map((k) => [
      k,
      data[k],
    ]),
  );
  frontmatter.set(routeOf(id), picked);
}

const routes = new Set();
const pages = {};
for (const file of htmlFiles(dist)) {
  const rel = relative(dist, file).split(sep).join("/");
  if (rel === "404.html") continue;
  // format:"directory" emits <route>/index.html; the served URL is /docs/<route>/.
  const route = rel.endsWith("/index.html")
    ? rel.slice(0, -"index.html".length)
    : rel === "index.html"
      ? ""
      : rel;
  const path = `/docs/${route}`;
  routes.add(path);
  const html = readFileSync(file, "utf8");
  if (isRedirectPage(html)) {
    pages[path] = { redirect: redirectTarget(html) };
  } else {
    pages[path] = {
      ...(frontmatter.get(path) ?? {}),
      anchors: anchorsOf(html),
    };
  }
}

const sorted = [...routes].sort();
const sortedPages = Object.fromEntries(
  Object.entries(pages).sort(([a], [b]) => (a < b ? -1 : 1)),
);
writeFileSync(
  join(dist, "docs-slugs.json"),
  JSON.stringify({ routes: sorted, pages: sortedPages }, null, 2) + "\n",
);

// Stubs leave the sitemap.
const stubs = sorted.filter((r) => sortedPages[r]?.status === "stub");
const sitemap = join(dist, "sitemap-0.xml");
let dropped = 0;
if (existsSync(sitemap) && stubs.length > 0) {
  let xml = readFileSync(sitemap, "utf8");
  for (const route of stubs) {
    const entry = `<url><loc>https://key.plrs.im${route}</loc></url>`;
    if (xml.includes(entry)) {
      xml = xml.replace(entry, "");
      dropped += 1;
    }
  }
  writeFileSync(sitemap, xml);
}
console.log(
  `emit-slug-manifest: ${sorted.length} routes -> dist/docs-slugs.json (${stubs.length} stubs, ${dropped} dropped from the sitemap)`,
);
