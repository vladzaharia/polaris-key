// Internal link checker for the built site: every `/docs/...` href in the emitted HTML must
// resolve — page links against the route set, asset links against real dist files, and
// `#fragment` targets against actual element ids in the target page (a bare `#fragment` link against the page it is on). Every `/docs/...` src
// (images, such as the UI-kit baselines the build/ui/ component pages embed, and scripts) must
// be a real dist file too. Runs after `astro build` via `pnpm check:links` (CI runs it on every
// PR); exits 1 with a per-page report on breakage.
//
// External links (http…) are deliberately not fetched — this origin is auth-gated and CI
// should not depend on the outside world; the reviewer wave owns external-link hygiene.

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

/**
 * Follows a moved-page redirect to the page it forwards to. A link to an old path with a
 * fragment is valid when the fragment exists on the new page (redirect-fragments.mjs carries it
 * across), so the fragment is checked there. Stops at 5 hops.
 */
function resolveRedirects(file) {
  let current = file;
  for (let hops = 0; hops < 5; hops += 1) {
    const html = readFileSync(current, "utf8");
    if (!isRedirectPage(html)) return current;
    const next = redirectTarget(html);
    if (next === null || !next.startsWith("/docs/")) return current;
    const target = distFileFor(next.split("#")[0]);
    if (!existsSync(target)) return current;
    current = target;
  }
  return current;
}

/** The route a /docs/ path ends at once redirect stubs are followed (the path itself if none). */
function redirectedRoute(path) {
  const file = distFileFor(path);
  if (!existsSync(file) || !file.endsWith(".html")) return path;
  const end = resolveRedirects(file);
  if (end === file) return path;
  const rel = relative(dist, end).split(sep).join("/");
  return "/docs/" + rel.replace(/(^|\/)index\.html$/, "$1");
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

// The tier rule (docs plan §3.1): a page anyone can read links only to pages anyone can read,
// so a public reader is never sent to a page that answers with a sign-in, and a member page never
// links to an admin page. The one exception is
// the landing page's Operate card, labelled "For console members". The rule covers the page's
// own content (`<main>`): the sidebar lists every door until DOC-02b scopes it to the page's
// door, and the rule then extends to the chrome. Tiers come from the
// docs-access.json the build wrote from src/lib/doors.ts.
const access = JSON.parse(readFileSync(join(dist, "docs-access.json"), "utf8"));
function tierOf(route) {
  const id = route.replace(/^\/docs\//, "").replace(/\/$/, "") || "index";
  let best = null;
  for (const [prefix, tier] of access.pages) {
    const hit = prefix.endsWith("/")
      ? `${id}/`.startsWith(prefix)
      : id === prefix;
    if (hit && (best === null || prefix.length > best[0].length))
      best = [prefix, tier];
  }
  return best === null ? "admin" : best[1];
}
// Existing public pages that still link to a gated page, as { "<page>": ["<target>", …] }. Like
// lint-debt.json it only shrinks: a new link fails, and so does a row whose link is gone. Each
// is a content fix for the page's owner (the link names a gated page; reword it or drop it).
const DEBT_FILE = join(here, "..", "link-tier-debt.json");
const debt = existsSync(DEBT_FILE)
  ? JSON.parse(readFileSync(DEBT_FILE, "utf8"))
  : {};
const seenDebt = new Set();
const RANK = { public: 0, member: 1, admin: 2 };
const CHROME_EXCEPTION = { page: "/index.html", target: "/docs/operate/" };

for (const file of htmlFiles(dist)) {
  const page = "/" + relative(dist, file).split(sep).join("/");
  const html = readFileSync(file, "utf8");
  // The tier rule, over the page's own content. A redirect page has no `<main>`.
  const pageRoute =
    page === "/index.html" ? "/docs/" : "/docs" + dirname(page) + "/";
  const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
  const pageTier = tierOf(pageRoute);
  if (pageTier !== "admin") {
    for (const match of main.matchAll(/href="(\/docs\/[^"#]*)/g)) {
      const path = match[1];
      // A redirect stub is judged by the page it forwards to: a member page that links a moved
      // page whose new home is admin-only is a tier jump too.
      const targetTier = tierOf(redirectedRoute(path));
      if (/\.[a-z0-9]+$/i.test(path) || RANK[targetTier] <= RANK[pageTier])
        continue;
      if (page === CHROME_EXCEPTION.page && path === CHROME_EXCEPTION.target)
        continue;
      if (debt[page]?.includes(path)) {
        seenDebt.add(`${page} ${path}`);
        continue;
      }
      failures.push(
        `${page}: ${pageTier} page links to a ${targetTier} page ${path}`,
      );
    }
  }
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
    if (
      fragment &&
      target.endsWith(".html") &&
      !idsOf(resolveRedirects(target)).has(fragment)
    ) {
      failures.push(`${page}: dead anchor ${href} (no id "${fragment}")`);
    }
  }
  // A bare #fragment link points into the page it sits on.
  for (const match of html.matchAll(/\shref="#([^"]+)"/g)) {
    checked += 1;
    if (!idsOf(file).has(match[1]))
      failures.push(
        `${page}: dead anchor #${match[1]} (no such id on the page)`,
      );
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

if (process.env.WRITE_LINK_TIER_DEBT) {
  // Regeneration helper for a human: records the current violations as debt.
  const next = {};
  for (const f of failures) {
    const m = /^(\S+): \w+ page links to a \w+ page (\S+)$/.exec(f);
    if (m) (next[m[1]] ??= []).includes(m[2]) || next[m[1]].push(m[2]);
  }
  writeFileSync(DEBT_FILE, JSON.stringify(next, null, 2) + "\n");
  process.exit(0);
}
for (const [page, targets] of Object.entries(debt))
  for (const target of targets)
    if (!seenDebt.has(`${page} ${target}`))
      failures.push(
        `${page}: link-tier-debt.json lists ${target}, which is gone`,
      );

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
