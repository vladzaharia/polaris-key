# Products

Each product that adopts Polaris Key is registered as **data**. The preferred shape is a
`.pkey/` manifest in the product repo: `schema.{json,yaml,yml}` for config/secret/flag
catalog entries, `product.{json,yaml,yml}` for metadata/licensing/OIDC/provisioning, and
`release.{json,yaml,yml}` for release-provider settings. No Worker redeploy is needed to
add a product.

## Register a product

1. Create or import the product manifest. Repo-link is preferred because the manifest stays
   with the product source. Direct import is useful before a repo exists.
2. Register the product through the admin portal or platform CLI. Polaris validates the
   manifest, discovers the release provider where possible, mints a sealed Ed25519 signing
   key in `product_keys`, and returns the `kid -> publicKey` trust set for SDKs.
3. Set any required product secrets from the admin UI/API. Manifest secret names are stable
   references; secret values are sealed into `product_secrets` and are never echoed back.

The legacy seed path remains only for local/bootstrap fixtures:

```sh
pnpm --filter @polaris-key/products gen-seed products/djdl > products/djdl/seed.sql
wrangler d1 execute polaris_key_prod --remote --file products/djdl/seed.sql
```

Do not create per-product Worker signing secrets. Product signing keys are sealed in D1, and
the public key is exposed in the onboarding bundle and at `/<product>/.well-known/jwks.json`.

## djdl

`djdl/` is the first product and the migration fixture. Its catalog is the verbatim port of
the engine's former `src/core/configSchema.ts` (28 entries: 17 config, 6 secret, 5 flag),
with the Remnawave provisioning hooks and the Apple MusicKit edge-mint recipe carried over
as data.
