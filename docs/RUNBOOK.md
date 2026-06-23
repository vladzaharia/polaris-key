# Polaris Key — operations runbook

How to stand up `key.plrs.im` and operate it. Cloudflare resources are Terraform-managed
(`infra/`); the Worker + admin are deployed by wrangler (CI). One-time external setup
(GitHub App, OIDC client, DNS, signing keys) is manual.

## One-time prerequisites (manual)

1. **DNS / zone** — the `plrs.im` zone must be active in the Cloudflare account. The
   custom-domain bindings create `key.plrs.im` / `key-staging.plrs.im` / `key-dev.plrs.im`.
2. **GitHub App** `polaris-key` — permissions Contents:read + Actions:read, no webhook;
   generate a private key (`.pem`), note the App ID; install it on each product's repo
   (e.g. `vladzaharia/djdl`).
3. **PocketID OIDC client** — register the admin client with redirect URI
   `https://key.plrs.im/admin/callback`; per product, register the loopback CLI callback +
   `https://key.plrs.im/<product>/auth/callback`. Ensure the `groups` claim is mapped.
4. **Signing keypairs** — per product, generate an Ed25519 keypair (see
   `docs/DJDL-MIGRATION.md` §2); the private PEM is a Worker secret, the public base64url
   goes in `products/<product>/product.json#signingPub`.

## Infrastructure (Terraform)

```sh
cd infra
export TF_VAR_cloudflare_api_token="<token>"
terraform init
terraform apply -var-file=envs/prod.tfvars     # or dev/staging
terraform output -json                          # -> d1_database_id, kv_namespace_id
```

Wire the output ids into the matching `[env.<env>]` block of
`packages/worker/wrangler.toml` (the `REPLACE_ME_*` placeholders), then create the D1
schema:

```sh
cd packages/worker
wrangler d1 migrations apply polaris_key_prod --remote   # applies migrations/0001_init.sql
```

## Secrets (Worker)

Platform-wide:

```sh
cd packages/worker
wrangler secret put KEY_HASH_PEPPER --env prod
wrangler secret put ADMIN_SESSION_SECRET --env prod
wrangler secret put GITHUB_APP_ID --env prod
wrangler secret put GITHUB_APP_PRIVATE_KEY --env prod
wrangler secret put PLATFORM_ADMIN_GROUP --env prod
```

Per product (names referenced from `product.json`): `SIGNING_KEY__<SLUG>`,
`OIDC_CLIENT_SECRET__<SLUG>`, `EDGE_MINT__<SLUG>__<ID>`. Record names (not values) in
`docs/secrets.lock.md`.

## Deploy

CI deploys on push to `main` (staging) and on a `vX.Y.Z` tag (prod) — see
`.github/workflows/deploy.yml`. Manual:

```sh
pnpm build && pnpm --filter @polaris-key/admin build
cd packages/worker && wrangler deploy --env prod
```

## Register a product

See `products/README.md` — generate + apply the seed SQL (or use the admin portal), then
set the product's secrets.

## CI gates

`.github/workflows/ci.yml` runs on every PR: JS/TS build + typecheck + test + the
**conformance corpus drift gate** (`gen:corpus --check`) + admin build; Python (pytest,
ubuntu+macOS); Swift (`swift test`); and `terraform validate`. A red conformance/drift job
means a wire-contract change wasn't reflected in the corpus — regenerate and commit it.
