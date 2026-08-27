# Products

Each product that adopts Polaris is registered as **data**. The preferred shape is a
`.polaris/` manifest in the product repo: `schema.{json,yaml,yml}` for config/secret/flag
catalog entries, `product.{json,yaml,yml}` for metadata/licensing/OIDC/provisioning, and
`release.{json,yaml,yml}` for release-provider settings. No Worker redeploy is needed to
add a product.

`.pkey/` remains a permanent fallback, resolved **per file**: each document is looked for in
`.polaris/` first and in `.pkey/` second, so a repo can be migrated one file at a time.

`product.{json,yaml,yml}` also carries the two suite-level switches:

- `modules.<service>.enabled` — which of `license`, `config`, `release`, `update`, `identity`
  this product runs. Undeclared means license + config, which is the pre-suite behaviour. The
  legacy names (`licensing`, `releases`, `oidc`, `edgeMint`) still work.
- `devices.registration` — `open` | `requires-identity` | `requires-license`, who may mint a
  device token at `POST /<product>/devices/register`. Undeclared derives it from the enabled
  services: `requires-license` if License is on, else `requires-identity` if Identity is on,
  else `open`.

Both land in the `products.services_json` column, manifest-owned until an operator claims them
through `PATCH /manage/api/products/<slug>/services`.

## Register a product

1. Create the product manifest. Repo-link is preferred because the manifest stays with the
   product source. Manual schema creation is useful before a repo exists.
2. Register the product through the admin portal. Polaris validates the
   manifest, discovers the release provider where possible, mints a sealed Ed25519 signing
   key in `product_keys`, and returns the `kid -> publicKey` trust set for SDKs.
3. Configure the GitHub App webhook so default-branch `.polaris/` (or `.pkey/`) changes auto-sync; the admin
   Releases view shows last sync, changed paths, manifest errors, and release health.
4. Set any required product secrets from the admin UI/API. Manifest secret names are stable
   references; secret values are sealed into `product_secrets` and are never echoed back.

The seed generator is only for local fixture regeneration. It does not mint sealed
`product_keys`; live product onboarding goes through the admin GitHub-link flow:

```sh
pnpm --silent --filter @plrs/products gen-seed djdl > products/djdl/seed.sql
```

`--silent` is load-bearing: without it pnpm's lifecycle banner lands on stdout and ends up as
the first two lines of the generated SQL.

Do not create per-product Worker signing secrets. Product signing keys are sealed in D1, and
the public key is exposed in the onboarding bundle and at `/<product>/.well-known/jwks.json`.

## djdl

`djdl/` is the first product and the migration fixture. Its catalog is the verbatim port of
the engine's former `src/core/configSchema.ts` (28 entries: 17 config, 6 secret, 5 flag),
with the Remnawave provisioning hooks and the Apple MusicKit edge-mint recipe carried over
as data.
