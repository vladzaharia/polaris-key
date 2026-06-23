# Products

Each product that adopts Polaris Key is registered as **data** — a `catalog.json` (its
config/secret/flag catalog) and a `product.json` (signing kid, OIDC, tiers, provisioning
hooks, edge-mint recipes, release config). No worker redeploy is needed to add a product.

## Register a product

1. Fill in the `REPLACE_WITH_*` placeholders in `<product>/product.json` (signing public
   key, Apple key/team ids, GitHub App installation id, Sparkle public key).
2. Generate + apply the seed SQL:

   ```sh
   pnpm --filter @polaris-key/products gen-seed products/djdl > products/djdl/seed.sql
   wrangler d1 execute polaris_key_prod --remote --file products/djdl/seed.sql
   ```

   (Or register interactively through the admin portal once deployed.)
3. Set the product's Worker secrets (names referenced in `product.json`):

   ```sh
   wrangler secret put SIGNING_KEY__DJDL --env prod                # Ed25519 PKCS#8 PEM
   wrangler secret put OIDC_CLIENT_SECRET__DJDL --env prod
   wrangler secret put EDGE_MINT__DJDL__APPLEMUSIC --env prod      # Apple MusicKit .p8 PEM
   ```

The `signingPub` in `product.json` is the base64url raw Ed25519 public key whose private
half is `SIGNING_KEY__<SLUG>`; clients pin it in their trust set (and it is also served at
`/<product>/.well-known/jwks.json`).

## djdl

`djdl/` is the first product — its catalog is the verbatim port of the engine's former
`src/core/configSchema.ts` (28 entries: 17 config, 6 secret, 5 flag), with the Remnawave
provisioning hooks and the Apple MusicKit edge-mint recipe carried over as data. See
`docs/DJDL-MIGRATION.md` for the engine/app cutover.
