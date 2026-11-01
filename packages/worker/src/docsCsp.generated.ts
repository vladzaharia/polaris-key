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
  "'sha256-G2mC5cR7/XhAM4cH/GAX+rcfI0qabK81PCFIFqkaNlE='",
  "'sha256-OizSKqsU+f0G4vojbxNt0Lao3kUpTmCLQSv3y6P7qhQ='",
  "'sha256-SwBaYHTbONGJpZpsvM40lJ8JneCm5m5xRdPkDorRD3k='",
  "'sha256-Sz5ftnccuw02CsY8roYnlAiVmqhfiiYAklEQCtc4kLY='",
  "'sha256-VBXjWD/njPiGpVaqYMUlMIHfdBZbA865+ZfgTH/zHa8='",
  "'sha256-VgrgcKBvIM3XpiLJ6fEv1Vy6YHBwlKLkYtFdfBMouTo='",
  "'sha256-abC4lxKzuPelqMjA4iLVxB0tgZiP5lgCLsdxWdHy34w='",
  "'sha256-cWzNk5BJWLj7tqXPbljaFnZW2niFgIdv0FiguIWpgg0='",
  "'sha256-hP48sUywTAXyg22qvpdOC/cYIA8MfPdKEbPC/mvGk4M='",
  "'sha256-pD4AFoLP/IdwBq22YJtB9ZSA58jK2KN4uK3N8Y/0N3o='",
  "'sha256-ucPfdYc9FPIvbmnn9ECv3eLKYLt8/heMPFQ+hNTn6jY='",
  "'sha256-wX2yOADeV+NMngflD5uYi3vl50SHC4sfM1EmylVjlX4='",
  "'sha256-xP4TLKzB6hcrCLQfQrTEg8qxfZ1b3HlE1OWO+7uZf1o='",
  "'sha256-z4VjyWovx2fTEyUoNKdS88ccs91xT2kE0PZDHNV3o6M='"
];

/** CSP source expressions for every inline <style> the docs build emits. */
export const DOCS_STYLE_HASHES: readonly string[] = [];

/** CSP source expressions for every `style="…"` attribute value the docs build emits (used with
 *  `'unsafe-hashes'` in `style-src-attr`, so Expressive Code's syntax colours render). */
export const DOCS_STYLE_ATTR_HASHES: readonly string[] = [
  "'sha256-+o0Ukw+pibd6OGgynNyobYZNy77EwLqaKT/4mYFmQeA='",
  "'sha256-4nwmP7y2Oqil2yoHYBvRn7OImAddhzMs7BiQ3EXY2ls='",
  "'sha256-5cnuIQsOOr/bKIFKV3C2LO/9TlM/6MYlA+jHAd3QbOc='",
  "'sha256-HrlacvunU0XCtjeoKE9RrJjWLwsita7cD37YrymQxAk='",
  "'sha256-N0U7UbX70ebuNVEQiGcI+KTCoqytKKf6vbasn4H+n3A='",
  "'sha256-UEI04Jk98QiFcCqWxULG0yTCUFDTIbf8u+yivy6emfE='",
  "'sha256-VYLa8fO3Sg6dJRXXw7VIjyTkcNLC4IuPCz1UPV1OKy0='",
  "'sha256-WC+3VdDge/gKpTxWn57Zbyji9VnuhcLa73qUVR+QPSg='",
  "'sha256-XlpZgcpFaLbPrgzm4PHCiD/OJXhR+DZxGuVpy2P4Cq0='",
  "'sha256-k1JtZHGJq1CTt/zE5v1aX5R76WxrfC0v4AliGTIZLvc='",
  "'sha256-mvtyTBHOu4i1b9sX0pXyGWACO3SZ5S7rVK6N32BUGWA='",
  "'sha256-r2WEacw89sPmp/OD8a8qTrigv6kSvYZXLpAnutU3xjQ='",
  "'sha256-w17pcUJEW1+cTAGsODagqct7bYhrM0l1sRwqjJvu5WU='",
  "'sha256-wrvMNywJ/dvSTFeuRqdBZPkNpA9KJjNVehBzjKFXP5A='",
  "'sha256-zo54ZOl/W/uxmwNBxK9trQ5kcwNwqUBM22szBupFuy0='"
];
