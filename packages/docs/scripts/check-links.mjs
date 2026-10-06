// Internal link checker for the built site: every `/docs/...` href in the emitted HTML must
// resolve — page links against the route set, asset links against real dist files, and
// `#fragment` targets against actual element ids in the target page. Every `/docs/...` src
// (images, such as the UI-kit baselines the build/ui/ component pages embed, and scripts) must
// be a real dist file too. Runs after `astro build` via `pnpm check:links` (CI runs it on every
// PR); exits 1 with a per-page report on breakage.
//
// External links (http…) are deliberately not fetched — this origin is auth-gated and CI
// should not depend on the outside world; the reviewer wave owns external-link hygiene.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** dist file for a /docs/... path: directory routes -> index.html, files -> themselves. */
function distFileFor(path) {
  const rel = path
    .replace(/^\/docs\//, "")
    .split("/")
    .join(sep);
  if (path.endsWith("/")) return join(dist, rel, "index.html");
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last.includes(".")) return join(dist, rel, "index.html");
  return join(dist, rel);
}

const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const html = readFileSync(file, "utf8");
    idCache.set(
      file,
      new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
    );
  }
  return idCache.get(file);
}

const failures = [];
let checked = 0;

for (const file of htmlFiles(dist)) {
  const page = "/" + relative(dist, file).split(sep).join("/");
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(/href="(\/docs\/[^"]*)"/g)) {
    checked += 1;
    const href = match[1];
    const [path, fragment] = href.split("#");
    const target = distFileFor(path);
    if (!existsSync(target)) {
      failures.push(
        `${page}: broken link ${href} (no ${relative(dist, target)})`,
      );
      continue;
    }
    if (fragment && target.endsWith(".html") && !idsOf(target).has(fragment)) {
      failures.push(`${page}: dead anchor ${href} (no id "${fragment}")`);
    }
  }
  for (const match of html.matchAll(/\ssrc="(\/docs\/[^"#?]*)"/g)) {
    checked += 1;
    const src = match[1];
    const target = distFileFor(src);
    if (!existsSync(target)) {
      failures.push(
        `${page}: missing asset ${src} (no ${relative(dist, target)})`,
      );
    }
  }
}

if (failures.length) {
  console.error(
    `check-links: ${failures.length} broken of ${checked} internal links and assets:`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `check-links: ${checked} internal links and assets OK across the built site`,
);
