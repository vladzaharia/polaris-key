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
export const DOCS_SCRIPT_HASHES: readonly string[] = [
  "'sha256-7eCV4jtsr4t4knb3c4FCRPeu7GGZeOUGE3XvWix0XOQ='",
  "'sha256-GkZBRnvSuhtx/cvzvukVkX2JJZW+DdPlVr7BX8Tefqo='",
  "'sha256-VWo5Wp4aqSj6nSgMpeAp9cKieaoIfwFUAunAVugI5gA='",
  "'sha256-VgrgcKBvIM3XpiLJ6fEv1Vy6YHBwlKLkYtFdfBMouTo='",
  "'sha256-f/zAUE74ucc3JYp4r4QQvkJofoQdkOIhHYK+jeZ6eko='",
  "'sha256-hP48sUywTAXyg22qvpdOC/cYIA8MfPdKEbPC/mvGk4M='",
  "'sha256-nVO98WGdJA5yup1/MAdukGqUlS6Psuf7JJFF5ikWqbQ='",
  "'sha256-ucPfdYc9FPIvbmnn9ECv3eLKYLt8/heMPFQ+hNTn6jY='",
  "'sha256-wX2yOADeV+NMngflD5uYi3vl50SHC4sfM1EmylVjlX4='"
];

/** CSP source expressions for every inline <style> the docs build emits. */
export const DOCS_STYLE_HASHES: readonly string[] = [];
