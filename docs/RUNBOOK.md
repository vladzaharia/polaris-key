# Polaris Key — operations runbook

How to stand up `key.plrs.im` and operate it. Cloudflare resources (D1, KV, the Worker
custom domain) are provisioned natively with wrangler — there is no separate
infrastructure layer. The Worker + admin are deployed by wrangler (CI). One-time external
setup (GitHub App, OIDC client, DNS) is manual. Product signing keys and product-scoped
secrets are managed through Polaris itself and stored sealed in D1 under `PLATFORM_KEK`.

## One-time prerequisites (manual)

1. **DNS / zone** — the `plrs.im` zone must be active in the Cloudflare account. The
   custom-domain bindings create `key.plrs.im` / `key-staging.plrs.im` / `key-dev.plrs.im`.
2. **GitHub App** `polaris-key` — permissions Contents:read + Actions:read; configure the
   webhook URL `https://key.plrs.im/webhooks/github` with content type `application/json`
   and a shared secret stored as `GITHUB_WEBHOOK_SECRET`; generate a private key (`.pem`),
   note the App ID; install it on each product's repo (e.g. `vladzaharia/djdl`).
3. **PocketID OIDC client** — register the admin client with redirect URI
   `https://key.plrs.im/admin/callback`; per product, register the loopback CLI callback +
   `https://key.plrs.im/<product>/auth/callback`. Ensure the `groups` claim is mapped.
4. **Product manifests** — each product should expose a `.pkey/` directory or an equivalent
   imported manifest. Polaris mints the product Ed25519 signing key during registration and
   returns the public trust key for SDK pinning.

## Infrastructure bootstrap (wrangler)

Each environment (`dev` / `staging` / `prod`) needs a D1 database and a KV namespace,
created once with wrangler. The custom domain (`key.plrs.im` and its dev/staging peers) is
bound declaratively by the `[[routes]] custom_domain = true` entries in
`packages/worker/wrangler.toml` and is created on the first `wrangler deploy`.

Create the resources for an environment (example: `prod`) and note the returned ids:

```sh
cd packages/worker
wrangler d1 create polaris_key_prod              # -> database_id
wrangler kv namespace create POLARIS_HOT_prod    # -> id
```

Paste the returned `database_id` and `id` over the `REPLACE_ME_PROD_*` placeholders in the
matching `[env.prod]` block of `packages/worker/wrangler.toml` (and likewise for
`dev`/`staging`). Then apply the D1 schema:

```sh
wrangler d1 migrations apply polaris_key_prod --remote   # applies every pending migration
```

## Secrets (Worker)

Platform-wide:

```sh
cd packages/worker
wrangler secret put KEY_HASH_PEPPER --env prod
wrangler secret put ADMIN_SESSION_SECRET --env prod
wrangler secret put GITHUB_APP_ID --env prod
wrangler secret put GITHUB_APP_PRIVATE_KEY --env prod
wrangler secret put GITHUB_WEBHOOK_SECRET --env prod
wrangler secret put PLATFORM_ADMIN_GROUP --env prod
wrangler secret put PLATFORM_KEK --env prod
```

Per-product secrets are no longer Worker secrets. The product manifest names required
secrets, and an admin sets their values through the Polaris admin UI/API. Values are sealed
into `product_secrets`; the admin UI can show configured/missing state but never reads the
plaintext back. Product signing keys are sealed in `product_keys`; SDKs pin the returned
`kid -> publicKey` trust set or read the product JWKS.

## Deploy

CI deploys on push to `main` (staging) and on a `vX.Y.Z` tag (prod) — see
`.github/workflows/deploy.yml`. Manual:

```sh
pnpm build && pnpm --filter @polaris-key/admin build
cd packages/worker && wrangler deploy --env prod
```

## Register a product

Use the admin portal to link a product repo containing `.pkey/`. For early experiments
before a repo exists, create a manual product with a schema document and add
release/OIDC/provisioning later. Registration validates the catalog/manifest, mints the
sealed product signing key, shows the public trust key, and lists missing per-product
secrets to set in the admin UI. After linking, GitHub push webhooks on the repo's default
branch re-parse `.pkey/` changes automatically; the Releases view also exposes manual
resync, last sync status, changed paths, manifest errors, and release health checks.

## CI gates

`.github/workflows/ci.yml` runs on every PR: JS/TS build + typecheck + test + the
**conformance corpus drift gate** (`gen:corpus --check`) + admin build; Python (pytest,
ubuntu+macOS); and Swift (`swift test`). A red conformance/drift job means a wire-contract
change wasn't reflected in the corpus — regenerate and commit it.
