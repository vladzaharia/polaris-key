// Keep the #fragment through a moved-page redirect. Astro writes a meta-refresh page at the old
// path, and a browser does not carry the old URL's fragment through a meta refresh, so an old
// link such as /docs/admin/activity/#the-platform-trail would land at the top of the new page.
// This adds one constant inline script to each redirect page: when the URL has a fragment it
// replaces the location with the target plus that fragment. The script text is the same on every
// page, so collect-csp-hashes.mjs adds exactly one hash for all of them.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

export const REDIRECT_SCRIPT =
  "if(location.hash){location.replace(document.querySelector('meta[http-equiv=refresh]').content.split('url=')[1]+location.hash)}";

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

/** True for the page Astro writes for a redirect. */
export const isRedirectPage = (html) =>
  /^<!doctype html><title>Redirecting to: /i.test(html) &&
  html.includes('http-equiv="refresh"');

/** The URL a redirect page forwards to, or null. */
export const redirectTarget = (html) =>
  /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1] ?? null;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let n = 0;
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, "utf8");
    if (!isRedirectPage(html) || html.includes(REDIRECT_SCRIPT)) continue;
    writeFileSync(
      file,
      html.replace(
        /(<meta http-equiv="refresh"[^>]*>)/,
        `$1<script>${REDIRECT_SCRIPT}</script>`,
      ),
    );
    n += 1;
  }
  console.log(`redirect-fragments: ${n} redirect pages keep their fragment`);
}
