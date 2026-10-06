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

/** CSP source expressions for every `style="…"` attribute value the docs build emits (used with
 *  `'unsafe-hashes'` in `style-src-attr`, so Expressive Code's syntax colours render). */
export const DOCS_STYLE_ATTR_HASHES: readonly string[] = [
  "'sha256-+o0Ukw+pibd6OGgynNyobYZNy77EwLqaKT/4mYFmQeA='",
  "'sha256-09emt0AM8cu4pVPoOVYREJUWs/OKgOMm28qyzJU8zA4='",
  "'sha256-2QjlDbgU+vfwd8W42SEfsec9jrC4sN9nUiqXKYzWvew='",
  "'sha256-4nwmP7y2Oqil2yoHYBvRn7OImAddhzMs7BiQ3EXY2ls='",
  "'sha256-5jZpKhI9YoJBtUEq0xaOKCc/xXRXhoCa6AYgVRSWNxY='",
  "'sha256-6nMfbKS/o6UE7IL2dXanZfUl/TzW8iXpX+IRI95CqZ0='",
  "'sha256-9lgIlXS6aCy9X3yOyzwzLu/rRNlYqn2Uo3bU8FSUrbg='",
  "'sha256-DyY1C/h/HQncqhG9s62WZnSQr+hHW7psMw8Y8dIEsks='",
  "'sha256-EOZ7IwL6g2pUr/BQpb9n6VhOtvHLk6UMtjwgNikSHTw='",
  "'sha256-FTF2N+3bpJ2s5KLQm6BYjndA+xwkQl0jvNA6HjuIP/g='",
  "'sha256-Fza7MgLUvyLJf2fEP/IN2o/Luqsp25OKKFC1ItV+QS0='",
  "'sha256-GivJoaD3L7kH1CP7yHGoxUQfM61tHouUC+8eoBgoKls='",
  "'sha256-MwrC9AsJD9XIqOPCJEKEhI9jsqFZ5nY0FziiggsLD+g='",
  "'sha256-N0U7UbX70ebuNVEQiGcI+KTCoqytKKf6vbasn4H+n3A='",
  "'sha256-NSGV/iOuf9SBm4bAL3B0+6qgt/yhrnDLVGdzFwm0kwU='",
  "'sha256-Ne7PPoMRWtUeyrgxzeR14e4YIa52zkeYCm/kHcjzUGI='",
  "'sha256-PUOgV+QKPDKsAJBrbzT7lkqleafwCIxXs9fYH3I8aHo='",
  "'sha256-QZTW/Zckid8YTtrt3wl5hW+Xn4Ha2SvYSamtDLxtKIo='",
  "'sha256-Qku+nbd7sSP3F5uKNYpMZqPy/8/ggBa6sChS/IC0FrA='",
  "'sha256-QtT9qkG6MVfyweRssRJcAxb1rsanf1kHaJCMJcJJbfk='",
  "'sha256-T0xDF+2lLqoRDi8GMlUbp4bGFHDreJl/vbya0FnaPzE='",
  "'sha256-TV66d0GvuJXnS3M27DVojSqa+S3FRZz5mp3qIYktoO8='",
  "'sha256-UyKscHj5P23B6qYfANvZimF3D9vL/9v1uMMgrs8sKjg='",
  "'sha256-VDS9JsBcHEvKAqh1+vGJG5uPLxcsW/sJ2J4e7EA9KlI='",
  "'sha256-VYLa8fO3Sg6dJRXXw7VIjyTkcNLC4IuPCz1UPV1OKy0='",
  "'sha256-WbVTGWZ8bynHJ0PBgEyjtKVS5azG85Q7gbRj579aAak='",
  "'sha256-XlpZgcpFaLbPrgzm4PHCiD/OJXhR+DZxGuVpy2P4Cq0='",
  "'sha256-Xy9ArWcnb3l7jM591rbimAYKRkeRj92UzdDlMo9UXfs='",
  "'sha256-Y1PJzKeq2Doxi5zg9peh933pjOCV6GK1Cb4DL2WGfHU='",
  "'sha256-Y5oqzC/HbXV0qnd2wayhvx6U8OteLmS/E2obFRZ9iX0='",
  "'sha256-Zj7sV3OXaoMQcuQ0W05HjRhdguLYdNaD7wU0wihN31g='",
  "'sha256-bTX90Rze/Gxd+eUe8T6MlY8oUkijZkXZSm1HvVVTp3o='",
  "'sha256-biLFinpqYMtWHmXfkA1BPeCY0/fNt46SAZ+BBk5YUog='",
  "'sha256-dWke8cYuiFE4iSU2aiEyCsR4OasLvsx+Lkayt57+5ag='",
  "'sha256-eMJb958ngWsoxJyIKwrsXy1cQHUK96fPhpmkJg1HuGY='",
  "'sha256-fH1akGPdRx9NC8AcH5uPnDbEqtXVDZ6ViI8Pc/aHrts='",
  "'sha256-fHV69Pq3KIpmdgLa8t1GVyYz7zaEt5UJpNgGBkIgqYo='",
  "'sha256-gl2O4vAszgIVEeQB26B/2Jg4NPOJh51wl5QN9a8q+AQ='",
  "'sha256-gxkqQHmZPgNubMGUm/FSZU0DNgubKiCcWcyxDbtaFKs='",
  "'sha256-hjISLbUi0I4OCOnrQBRn+DIdpjLNtWbI3zaBp6mlutw='",
  "'sha256-jz1JD/K32BjiMwmzrkgobSyupHsxrDv8pCZRcIf8JZU='",
  "'sha256-lGjq5Nz/1A4R2g9jy3/z8WvyCEY2xGy07NhEbn5Q+jY='",
  "'sha256-mQ4zP9/esMkuFaRHyhWGWtlCV5IKla1cSXKfmIoflNY='",
  "'sha256-nYsGWuUFcgk5UuvioRDNe1ZrWC5N5o+jFBu8nNCqDpo='",
  "'sha256-pab2Rrm8yWWS4v5KrCoecEefWxFI1/oLe6b7aA1DL+0='",
  "'sha256-r2WEacw89sPmp/OD8a8qTrigv6kSvYZXLpAnutU3xjQ='",
  "'sha256-vlkspJIFpRcmCSbJj2fDpq2No723L6tYEjmUTLiwGHU='",
  "'sha256-wAyhcC6cFkLt3FHmK1jH9Mk+lKfxI7pHFHE691KNUsM='",
  "'sha256-wRDC1t/wUewtzOkZv7yDowHb56pEO/GSutZ+x8apnjE='",
  "'sha256-wrvMNywJ/dvSTFeuRqdBZPkNpA9KJjNVehBzjKFXP5A='",
  "'sha256-ynzLCZXSiPPeMvZFFeIT7mO5jMlydpnz3LhDcCeMVZ8='",
  "'sha256-zEtg72Q9sLNe7349ysqwfQEby8yVaRgwbFVPIDzWpZE='"
];
