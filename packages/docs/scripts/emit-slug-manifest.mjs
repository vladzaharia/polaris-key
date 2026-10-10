// Emit the route manifest of the built site: every path the worker can serve as a page,
// written to dist/docs-slugs.json. The console's help-link registry
// (packages/admin/src/lib/docsLinks.ts) is tested against this file
// (packages/worker/test/docsLinks.test.ts), so a help link pointing at a page that stopped
// existing fails CI instead of 404ing an operator.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

const routes = new Set();
/** Heading ids per route: the fragments a help link may name. */
const anchors = {};
for (const file of htmlFiles(dist)) {
  const rel = relative(dist, file).split(sep).join("/");
  if (rel === "404.html") continue;
  // format:"directory" emits <route>/index.html; the served URL is /docs/<route>/.
  const route = rel.endsWith("/index.html")
    ? rel.slice(0, -"index.html".length)
    : rel === "index.html"
      ? ""
      : rel;
  routes.add(`/docs/${route}`);
  const html = readFileSync(file, "utf8");
  const ids = [...html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map(
    (m) => m[1],
  );
  if (ids.length) anchors[`/docs/${route}`] = [...new Set(ids)].sort();
}

const sorted = [...routes].sort();
writeFileSync(
  join(dist, "docs-slugs.json"),
  JSON.stringify({ routes: sorted, anchors }, null, 2) + "\n",
);
console.log(
  `emit-slug-manifest: ${sorted.length} routes -> dist/docs-slugs.json`,
);
