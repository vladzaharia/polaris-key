// Collect CSP hashes for every inline <script>/<style> the built site contains, and write
// them into the worker's docsCsp.generated.ts. This is what lets the worker keep serving
// /docs under a strict no-'unsafe-inline' policy: an inline script is either hashed here or
// blocked by the browser — and because the generated file is committed, a Starlight upgrade
// that introduces a NEW inline script shows up as a reviewable diff (and as a failing
// docs-CSP check if someone skips this step; the worker test suite pins the wiring).
//
// Hash semantics per CSP3: SHA-256 over the EXACT text between the tags, base64 (not url).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const dist = join(docsRoot, "dist");
const outFile = join(docsRoot, "..", "worker", "src", "docsCsp.generated.ts");

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

// Inline elements only: a <script> with a `src` attribute is loaded from 'self' and needs no
// hash. The regexes are adequate for build output (Astro emits well-formed HTML); they are
// not a general HTML parser and do not need to be.
const SCRIPT_RE = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style[^>]*>(?<body>[\s\S]*?)<\/style>/gi;

// `style="…"` attributes (Expressive Code's per-token colours, Starlight's `--sl-icon-size` and
// `--depth`) are covered by `style-src-attr 'unsafe-hashes'` with the hash of each attribute's
// value, not by `'unsafe-inline'`. The value is hashed as the browser sees it, entities decoded.
const STYLE_ATTR_RE = /<[a-z][^>]*?\sstyle="(?<value>[^"]*)"/gi;
const ENTITIES = {
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&#x27;": "'",
};
const decode = (v) =>
  v.replace(/&(?:quot|amp|lt|gt|#39|#x27);/g, (m) => ENTITIES[m]);

const scriptHashes = new Set();
const styleHashes = new Set();
const styleAttrHashes = new Set();
let pages = 0;

for (const file of htmlFiles(dist)) {
  pages += 1;
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attrs = match.groups?.attrs ?? "";
    const body = match.groups?.body ?? "";
    if (/\ssrc\s*=/i.test(attrs) || body.length === 0) continue;
    scriptHashes.add(cspHash(body));
  }
  for (const match of html.matchAll(STYLE_ATTR_RE)) {
    const value = decode(match.groups?.value ?? "");
    if (value.length > 0) styleAttrHashes.add(cspHash(value));
  }
  for (const match of html.matchAll(STYLE_RE)) {
    const body = match.groups?.body ?? "";
    if (body.length === 0) continue;
    styleHashes.add(cspHash(body));
  }
}

function cspHash(body) {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

const sorted = (set) => [...set].sort();
const banner = `// GENERATED FILE — do not edit by hand.
//
// Written by \`packages/docs/scripts/collect-csp-hashes.mjs\` after every docs-site build. It
// scans each emitted HTML file for inline <script> and <style> elements and records their
// SHA-256 CSP source expressions, so \`docsSecurityHeaders()\` (src/docs.ts) can keep the
// origin's strict no-\`unsafe-inline\` policy while Starlight's theme-init script still runs.
//
// A Starlight upgrade that introduces a NEW inline script shows up here as a diff (and the
// docs CSP test fails if the built HTML contains an inline script whose hash is absent), so
// the policy can never silently drift into blocking the site or allowing unhashed script.

/** CSP source expressions (e.g. \`'sha256-…'\`) for every inline <script> the docs build emits. */
export const DOCS_SCRIPT_HASHES: readonly string[] = ${JSON.stringify(sorted(scriptHashes), null, 2)};

/** CSP source expressions for every inline <style> the docs build emits. */
export const DOCS_STYLE_HASHES: readonly string[] = ${JSON.stringify(sorted(styleHashes), null, 2)};

/** CSP source expressions for every \`style="…"\` attribute value the docs build emits (used with
 *  \`'unsafe-hashes'\` in \`style-src-attr\`, so Expressive Code's syntax colours render). */
export const DOCS_STYLE_ATTR_HASHES: readonly string[] = ${JSON.stringify(sorted(styleAttrHashes), null, 2)};
`;

writeFileSync(outFile, banner);
console.log(
  `collect-csp-hashes: ${pages} pages -> ${scriptHashes.size} script + ${styleHashes.size} style + ${styleAttrHashes.size} style-attribute hashes -> ${relative(process.cwd(), outFile)}`,
);
