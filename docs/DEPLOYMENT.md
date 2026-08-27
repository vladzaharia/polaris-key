# Polaris Key production deployment

This is the full production bootstrap for Polaris Key at `https://key.plrs.im`.
It is intentionally production-only: staging and dev routes exist in the Worker config for
future use, but the initial deployment, CI workflow, OIDC setup, email setup, and smoke
checks target prod.

Target account and fixed values:

| Item                 | Value                                          |
| -------------------- | ---------------------------------------------- |
| Cloudflare account   | `Polaris` / `07a2eb0d4916b220da1f9c1387b5f6d8` |
| Production origin    | `https://key.plrs.im`                          |
| Cloudflare zone      | `plrs.im`                                      |
| Worker env           | `prod`                                         |
| D1 database          | `polaris_key_prod`                             |
| KV namespace         | `POLARIS_HOT_prod`                             |
| PocketID issuer      | `https://id.plrs.im`                           |
| Platform admin group | `admins`                                       |
| GitHub App           | `polaris-key`                                  |
| First product        | `djdl` from `vladzaharia/djdl`                 |
| Portal email sender  | `Polaris Key <noreply@plrs.im>`                |

Do not change the production hostname as a deployment-time tweak. The SDK defaults,
signed-config issuer, tests, docs, and product examples assume `key.plrs.im`; using a
different host is a product migration.

## 1. Local prerequisites

Run from the repo root:

```sh
node --version   # must be >= 22
pnpm --version   # repo pins pnpm 10.x
pnpm install --frozen-lockfile
```

Confirm Wrangler is authenticated to the `Polaris` account:

```sh
cd packages/worker
npx wrangler whoami
```

Expected account:

```text
Account Name: Polaris
Account ID: 07a2eb0d4916b220da1f9c1387b5f6d8
```

If Wrangler is not logged in or is pointed at the wrong account:

```sh
npx wrangler login
npx wrangler whoami
```

## 2. Manual external setup

These steps are browser/provider tasks. Complete them before deploying.

### Cloudflare zone, domain, and email

1. Confirm the `plrs.im` zone is active in the `Polaris` Cloudflare account.
2. Confirm `key.plrs.im` is available for a Worker custom domain.
3. Onboard `plrs.im` to Cloudflare Email Service for outbound sending.
4. Verify or allow the sender address `noreply@plrs.im`.
5. The Worker binds Email Service as `EMAIL` in prod and restricts senders to
   `noreply@plrs.im`:

   ```toml
   [[env.prod.send_email]]
   name = "EMAIL"
   allowed_sender_addresses = ["noreply@plrs.im"]
   ```

Cloudflare documents the `send_email` binding and `allowed_sender_addresses` restriction at
https://developers.cloudflare.com/email-service/configuration/send-bindings/.

### PocketID

Use the PocketID instance at `https://id.plrs.im`.

Create or confirm the `admins` group, and add every operator who needs Polaris Key admin
access. PocketID ID tokens must include a `groups` claim containing group names as strings.

Create a platform OIDC client for Polaris Key admin, the root customer portal, and every
product that uses platform OIDC (the default):

| Field        | Value                                             |
| ------------ | ------------------------------------------------- |
| Issuer       | `https://id.plrs.im`                              |
| Redirect URI | `https://key.plrs.im/manage/callback`             |
| Redirect URI | `https://key.plrs.im/callback`                    |
| Redirect URI | `https://key.plrs.im/djdl/identity/auth/callback` |
| Scopes       | `openid email profile groups`                     |

Each additional product using platform OIDC adds its own `/<slug>/identity/auth/callback` to
this client. Products with `oidc.provider: custom` use a separate client and do not need an
entry here.

Record the platform client ID and client secret. They become Worker secrets:

```text
PLATFORM_OIDC_CLIENT_ID
PLATFORM_OIDC_CLIENT_SECRET
```

Products use platform OIDC by default. DJDL's `.pkey/product` should set the platform
provider and keep only product-scoped policy (redirect allowlist and group-to-tier
mapping):

```json
{
  "oidc": {
    "provider": "platform",
    "redirectUris": ["https://key.plrs.im/djdl/identity/auth/callback"],
    "groupRoleMap": {
      "family": { "role": "user", "tier": "standard" },
      "friends": { "role": "user", "tier": "standard" },
      "admins": { "role": "admin" }
    }
  }
}
```

If a product needs its own OIDC client, set `oidc.provider` to `custom` and add
`issuer`, `clientId`, and optional `clientSecretSecret` to that product manifest. Custom
client secrets are product secrets, not Worker secrets.

### GitHub App

Create or confirm the GitHub App named `polaris-key`.

Required settings:

| Setting              | Value                                 |
| -------------------- | ------------------------------------- |
| Webhook URL          | `https://key.plrs.im/webhooks/github` |
| Webhook content type | `application/json`                    |
| Permissions          | Contents: read, Actions: read         |
| Events               | Push                                  |
| Installation         | `vladzaharia/djdl`                    |

Generate and download a private key (`.pem`). Record:

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

The webhook secret is an operator-chosen high-entropy value. It must exactly match the
Worker secret `GITHUB_WEBHOOK_SECRET`.

### GitHub Actions secret

In `vladzaharia/polaris-key`, create the repository secret:

```text
CLOUDFLARE_API_TOKEN
```

The token must be able to apply D1 migrations and deploy Workers in the `Polaris`
Cloudflare account. The local OAuth login already has the needed account access, but CI
needs its own token.

## 3. Cloudflare resources

Create the prod D1 database and KV namespace:

```sh
cd packages/worker
npx wrangler d1 create polaris_key_prod
npx wrangler kv namespace create POLARIS_HOT_prod
```

Copy the returned IDs into `packages/worker/wrangler.toml`:

```toml
[env.prod]
[[env.prod.kv_namespaces]]
binding = "HOT"
id = "<POLARIS_HOT_prod id>"

[[env.prod.d1_databases]]
binding = "DB"
database_name = "polaris_key_prod"
database_id = "<polaris_key_prod database_id>"
```

The prod IDs are already committed — this private repo is the source of truth for deployment
config — so this step only applies when bootstrapping a fresh account or a new environment.
If placeholders remain for the target env, `wrangler deploy --env <env>` cannot bind D1/KV.

Apply all D1 migrations:

```sh
npx wrangler d1 migrations apply polaris_key_prod --env prod --remote
```

## 4. Worker secrets

Generate local secret material:

```sh
openssl rand -hex 32      # KEY_HASH_PEPPER
openssl rand -hex 32      # ADMIN_SESSION_SECRET
openssl rand -hex 32      # PORTAL_SESSION_SECRET
openssl rand -base64 32   # PLATFORM_KEK, must decode to exactly 32 bytes
openssl rand -hex 32      # GITHUB_WEBHOOK_SECRET, if not already chosen
```

Set the prod Worker secrets:

```sh
cd packages/worker
npx wrangler secret put KEY_HASH_PEPPER --env prod
npx wrangler secret put ADMIN_SESSION_SECRET --env prod
npx wrangler secret put PORTAL_SESSION_SECRET --env prod
npx wrangler secret put PLATFORM_KEK --env prod
npx wrangler secret put PLATFORM_ADMIN_GROUP --env prod
npx wrangler secret put PLATFORM_OIDC_ISSUER --env prod
npx wrangler secret put PLATFORM_OIDC_CLIENT_ID --env prod
npx wrangler secret put PLATFORM_OIDC_CLIENT_SECRET --env prod
npx wrangler secret put GITHUB_APP_ID --env prod
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env prod
npx wrangler secret put GITHUB_WEBHOOK_SECRET --env prod
```

Use these literal values where applicable:

```text
PLATFORM_ADMIN_GROUP=admins
PLATFORM_OIDC_ISSUER=https://id.plrs.im
```

Paste the complete GitHub App private key PEM for `GITHUB_APP_PRIVATE_KEY`, including the
`BEGIN` and `END` lines.

`PORTAL_EMAIL_FROM` does not need to be set when using the default sender
`Polaris Key <noreply@plrs.im>`.

## 5. Verify before deploy

Run local verification from the repo root:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
```

Validate the Worker bundle and Wrangler config:

```sh
cd packages/worker
npx wrangler deploy --dry-run --env prod
```

The dry run validates the bundle and config shape, including bindings. It does not prove the
D1/KV IDs in `wrangler.toml` exist remotely. The prod IDs are committed; `staging` and `dev`
still carry `REPLACE_ME_*` placeholders and cannot deploy until those are filled in.

## 6. Deploy manually

Manual deployment is the fastest first deploy path:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
cd packages/worker
npx wrangler d1 migrations apply polaris_key_prod --env prod --remote
npx wrangler deploy --env prod
```

Smoke-check the platform:

```sh
curl -fsS https://key.plrs.im/manage >/dev/null
curl -fsS https://key.plrs.im/api/capabilities | jq .
```

Expected `/api/capabilities` before product onboarding:

```json
{
  "auth": { "oidc": false, "magic": false },
  "modules": { "licensing": false, "claim": false, "releases": false }
}
```

After at least one portal-enabled product exists, `auth.oidc` and `auth.magic` should become
`true` when OIDC and Email Service are configured.

## 7. Deploy through CI

CI deploys production only from semver tags that match:

```text
vMAJOR.MINOR.PATCH
vMAJOR.MINOR.PATCH-prerelease
```

The workflow applies D1 migrations, deploys the Worker/admin assets, and smoke-checks
`https://key.plrs.im/djdl/.well-known/jwks.json`, asserting a non-empty key set. That is a
data-plane endpoint on purpose: `/manage` is a static asset and returns 200 with D1, KV and
the signing path all down.

Create a production release tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

If a tag is malformed, the workflow exits before applying migrations or deploying.

CI does not deploy on `main` pushes. PRs and `main` still run `.github/workflows/ci.yml`.

## 8. First admin login

Open:

```text
https://key.plrs.im/manage
```

Sign in through PocketID. If login fails:

- Confirm `PLATFORM_OIDC_ISSUER=https://id.plrs.im`.
- Confirm the platform client allows `https://key.plrs.im/manage/callback`.
- Confirm your ID token has `groups` and includes `admins`.
- Confirm `PLATFORM_ADMIN_GROUP=admins`.
- Confirm D1 migrations were applied before deploy.

## 9. Onboard DJDL

DJDL should be linked through the admin portal, not seeded directly. The seed SQL fixtures
do not mint sealed product signing keys and are not a live onboarding path.

Before linking, confirm the DJDL repo contains `.pkey/schema`, `.pkey/product`, and
`.pkey/release`, and that `.pkey/product` uses:

```text
provider: platform
redirectUris: https://key.plrs.im/djdl/identity/auth/callback
adminGroup: admins
```

Link the repo:

1. Open `https://key.plrs.im/manage`.
2. Choose the product repo-link flow.
3. Enter `vladzaharia/djdl`.
4. Confirm Polaris Key validates the `.pkey/` manifest.
5. Save the returned `kid -> publicKey` trust set for DJDL SDK/app pinning.

Set the required DJDL product secrets in the admin UI/API:

| Secret name                   | Value                               |
| ----------------------------- | ----------------------------------- |
| `EDGE_MINT__DJDL__APPLEMUSIC` | Apple MusicKit private key material |

These are product secrets sealed into D1. They are not Worker secrets and are never echoed
back after being set.

## 10. DJDL validation

Run public product checks:

```sh
curl -fsS https://key.plrs.im/djdl/.well-known/polaris.json | jq .
curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
curl -fsS https://key.plrs.im/djdl/config/schema | jq .
curl -fsS https://key.plrs.im/djdl/appcast.xml >/dev/null
```

Expected checks:

- Discovery shows `baseUrl: "https://key.plrs.im"`.
- Discovery shows `services.identity.enabled: true`. Every service the product has not
  enabled appears as `{"enabled": false}` and nothing else.
- JWKS contains the active product `kid`.
- Schema returns DJDL catalog version 1.
- Appcast responds once release config and release assets are available. `/djdl/appcast.xml`
  is a permanent alias for `/djdl/update/appcast.xml`, kept because it is compiled into
  shipped `SUFeedURL` values.

Validate product auth:

1. Start DJDL OIDC activation from the SDK/app or `/<product>/identity/auth/start`.
2. Sign in as a PocketID user in an entitled group.
3. Confirm a license is created or found in `/manage`.
4. Confirm a device token can fetch `https://key.plrs.im/djdl/config/document`.
5. Verify the signed config JWS against the captured DJDL trust key.

Validate release/webhook sync:

1. Change a `.pkey/` file in `vladzaharia/djdl` on the default branch.
2. Confirm GitHub sends a signed `push` webhook to
   `https://key.plrs.im/webhooks/github`.
3. Confirm the admin Releases view shows changed paths, sync status, and any validation
   errors.
4. Run manual resync from the Releases view if the webhook was missed.

Validate portal email:

1. Ensure DJDL portal settings are enabled in product settings.
2. Open `https://key.plrs.im`.
3. Request a magic link for a test email address.
4. Confirm the message is sent from `Polaris Key <noreply@plrs.im>`.
5. Open the link and confirm the portal session is created.

## 11. Acceptance checklist

- `https://key.plrs.im` serves the customer portal SPA.
- `https://key.plrs.im/manage` serves the admin SPA.
- `https://key.plrs.im/manage/login` redirects to PocketID.
- Admin callback returns to `https://key.plrs.im/manage/callback`.
- `https://key.plrs.im/api/capabilities` reports OIDC and magic links enabled after DJDL
  portal settings are active.
- D1 migrations are applied to `polaris_key_prod`.
- KV namespace `POLARIS_HOT_prod` is bound as `HOT`.
- Durable Object namespace `RL` is bound in prod.
- Email Service binding `EMAIL` is present in prod and can send as `noreply@plrs.im`.
- GitHub App webhooks validate with `GITHUB_WEBHOOK_SECRET`.
- DJDL is linked through `.pkey/`, not seeded.
- DJDL product secrets are configured.
- DJDL SDK/app has the returned trust key pinned.
- CI deploys production from semver tags only.

## 12. Common failure modes

`Admin sign-in is not configured.`

- `PLATFORM_OIDC_ISSUER` or `PLATFORM_OIDC_CLIENT_ID` is missing.

`Your account is not an administrator of any product.`

- Your PocketID token is missing `groups`, or your groups do not include `admins`.

`platform oidc is not configured` for product activation.

- `PLATFORM_OIDC_ISSUER` or `PLATFORM_OIDC_CLIENT_ID` is missing.

`oidc client secret unavailable` for a custom-OIDC product.

- The product's `clientSecretSecret` was declared but not set in product secrets.

`PLATFORM_KEK must decode to exactly 32 bytes`.

- Regenerate with `openssl rand -base64 32` and set `PLATFORM_KEK` again.

GitHub repo-link says the app is not installed.

- Install GitHub App `polaris-key` on `vladzaharia/djdl`, then retry.

Portal says email sign-in is disabled.

- Confirm DJDL portal settings enable magic links.
- Confirm the prod `EMAIL` binding deployed.
- Confirm Cloudflare Email Service permits `noreply@plrs.im`.

`wrangler deploy --env <env>` fails on D1/KV bindings.

- Only `env.prod` carries real IDs. For `staging`/`dev`, replace the `REPLACE_ME_*_D1_ID`
  and `REPLACE_ME_*_KV_ID` placeholders in `wrangler.toml` with IDs from the resource
  creation commands.
