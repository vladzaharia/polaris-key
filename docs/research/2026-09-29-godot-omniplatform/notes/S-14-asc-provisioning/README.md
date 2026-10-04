# S-14 experiment scripts

Read-only helpers behind [`../S-14-asc-provisioning.md`](../S-14-asc-provisioning.md).

- `scan-spec.mjs`: summarises Apple's published App Store Connect OpenAPI document (methods per
  path, write-body attributes, enums). Download the spec into `spec/` first; the command is in the
  file header. `spec/` is git-ignored.
- `probe.mjs <name> <path>`: sends ONE `GET` to `https://api.appstoreconnect.apple.com<path>`
  with a team API key read from `~/.secrets/polaris-key/asc/asc-api-key.json` (`key_id`,
  `issuer_id`, `key_path`), writes the raw body to `out/<name>.json` and prints the status, the
  latency and the `X-Rate-Limit` header. It has no way to send any other method. `out/` is
  git-ignored, because bodies can carry personal data (users, testers, review contacts).

Run under Node 22 (`mise exec node@22 -- node probe.mjs apps /v1/apps`). Invalid filter values
(`/v1/bundleIds?filter[platform]=BOGUS`) return the live enum in a 400, which is how §5 of the
note lists live values without writing anything.
