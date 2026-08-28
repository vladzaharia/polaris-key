// GENERATED FILE — do not edit by hand.
//
// Written by `packages/docs/scripts/collect-csp-hashes.mjs` after every docs-site build. It
// scans each emitted HTML file for inline <script> and <style> elements and records their
// SHA-256 CSP source expressions, so `docsSecurityHeaders()` (src/docs.ts) can keep the
// origin's strict no-`unsafe-inline` policy while Starlight's theme-init script still runs.
//
// A Starlight upgrade that introduces a NEW inline script shows up here as a diff (and the
// docs CSP test fails if the built HTML contains an inline script whose hash is absent), so
// the policy can never silently drift into blocking the site or allowing unhashed script.

/** CSP source expressions (e.g. `'sha256-…'`) for every inline <script> the docs build emits. */
export const DOCS_SCRIPT_HASHES: readonly string[] = [];

/** CSP source expressions for every inline <style> the docs build emits. */
export const DOCS_STYLE_HASHES: readonly string[] = [];
