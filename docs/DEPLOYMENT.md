# Polaris Key production deployment

This is the full production bootstrap for Polaris Key at `https://key.plrs.im`.
It is intentionally production-only: staging and dev routes exist in the Worker config for
future use, but the initial deployment, CI workflow, OIDC setup, email setup, and smoke
checks target prod.

Target account and fixed values:

| Item                 | Value                                           |
| -------------------- | ----------------------------------------------- |
| Cloudflare account   | `Polaris` / `07a2eb0d4916b220da1f9c1387b5f6d8`  |
| Production origin    | `https://key.plrs.im`                           |
| Cloudflare zone      | `plrs.im`                                       |
| Worker env           | `prod`                                          |
| D1 database          | `polaris_key_prod`                              |
| KV namespace         | `POLARIS_HOT_prod`                              |
| R2 blob bucket       | `polaris-key-blobs-prod` (bound as `BLOBS`)     |
| Bytes host           | `https://dl.plrs.im` (`BLOB_ORIGIN`)            |
| PocketID issuer      | `https://id.plrs.im`                            |
| Platform admin group | `admins`                                        |
| GitHub App           | `polaris-key`                                   |
| First product        | `djdl` (linked from its own product repository) |
| Portal email sender  | `Polaris Key <noreply@plrs.im>`                 |

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
      "members": { "role": "user", "tier": "standard" },
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
| Events               | Push, Release                         |
| Installation         | the first product's repository        |

Generate and download a private key (`.pem`). Record:

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

The webhook secret is an operator-chosen high-entropy value. It must exactly match the
Worker secret `GITHUB_WEBHOOK_SECRET`.

**Push** deliveries resync a product when its `.pkey/` manifest changes. **Release**
deliveries (published, edited, deleted, and the rest) refresh only the release truth store,
so the console's Releases view and the portal show a new build without a manifest push or a
manual resync. Release events are covered by the existing **Contents: read** permission, so
adding the subscription should not ask installations to re-approve; confirm on the App's
permissions page. Until the subscription is added, the Worker's release-event handling is
inert.

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

Each environment's `[env.<env>.vars]` also carries `PKEY_ENVIRONMENT` (`prod`, `staging` or
`dev`). `/manage/api/me` echoes it so the console shows a "Staging" or "Dev" badge in its top bar;
production shows none, and so does a Worker without the var (any other value reads as unset).
A new environment needs the line beside its `BLOB_ORIGIN`; `test/admin.test.ts` checks the three
committed ones.

Apply all D1 migrations:

```sh
npx wrangler d1 migrations apply polaris_key_prod --env prod --remote
```

### Blob store (R2) and the bytes host

The Core blob store (`packages/worker/src/core/blobs.ts`) keeps content-addressed release
bytes in one R2 bucket per environment, bound as `BLOBS`, and serves them through the Worker
on a second custom domain, the **bytes host**. Both are already declared in `wrangler.toml`:

| Env     | Bucket                      | Bytes host (`BLOB_ORIGIN`)   |
| ------- | --------------------------- | ---------------------------- |
| prod    | `polaris-key-blobs-prod`    | `https://dl.plrs.im`         |
| staging | `polaris-key-blobs-staging` | `https://dl-staging.plrs.im` |
| dev     | `polaris-key-blobs-dev`     | `https://dl-dev.plrs.im`     |

The three buckets already exist in the `Polaris` account with the rules below, so this is for
bootstrapping a fresh account or re-checking one. If a bucket is missing, `wrangler deploy
--env <env>` fails on the `BLOBS` binding; remove the `[[env.<env>.r2_buckets]]` block to
deploy without a store (the Worker then treats it as absent and every byte route answers
not-found). For each environment:

```sh
cd packages/worker
B=polaris-key-blobs-prod    # or -staging / -dev

npx wrangler r2 bucket create "$B"

# Age locks: nothing under a locked prefix can be deleted or overwritten for 180 days.
npx wrangler r2 bucket lock add "$B" lock-blobs   blobs/   --retention-days 180
npx wrangler r2 bucket lock add "$B" lock-bundles bundles/ --retention-days 180
npx wrangler r2 bucket lock add "$B" lock-deltas  deltas/  --retention-days 180
npx wrangler r2 bucket lock add "$B" lock-gated   gated/   --retention-days 180

# CI uploads land in staging/ and are promoted (verified, then copied) by the Worker.
# staging/ is NOT locked; anything left there expires after a day.
npx wrangler r2 bucket lifecycle add "$B" expire-staging staging/ --expire-days 1 \
  --abort-multipart-days 1

# Every read goes through the Worker. Never expose the bucket directly.
npx wrangler r2 bucket dev-url disable "$B"
npx wrangler r2 bucket lock list "$B"
npx wrangler r2 bucket lifecycle list "$B"
```

Rules for the bucket, each one load-bearing:

- **Age lock, not indefinite.** 180 days is long enough to roll back to any build a channel
  could still point at, and short enough that the garbage collector (P4-14) can eventually
  delete an unreferenced object. An indefinite lock would make that impossible; the trade-off
  is recorded in `docs/security/THREAT-MODEL.md` §3.
- **No R2 public domain and no `r2.dev`.** Do not attach a custom domain to the bucket in the
  R2 dashboard. A direct R2 domain cannot set the ETag to the SHA-256, add `Repr-Digest`, or
  check that the requesting product references the object.
- **The bytes host is a Worker custom domain.** `dl.plrs.im` (and the staging/dev siblings) is a
  `[[env.<env>.routes]]` entry with `custom_domain = true` on this Worker; `wrangler deploy`
  creates its DNS record and certificate. It is not an R2 custom domain.
- **The route and `BLOB_ORIGIN` go together.** A `dl*` route deployed without `BLOB_ORIGIN`
  serves the full console on the same-site sibling (host isolation fails open), and a
  `BLOB_ORIGIN` naming the console's own hostname makes every console path answer not-found.
  Add or remove the `[[env.<env>.routes]]` `dl*` entry and the `BLOB_ORIGIN` var in the same
  change; `test/bytesHost.test.ts` refuses a committed `wrangler.toml` that breaks either rule
  (P2-05).
- **`CONSOLE_ORIGIN` names the console host** (`https://key.plrs.im`, `key-staging`, `key-dev`)
  beside each `BLOB_ORIGIN` (P2b-06). The public download page renders on the bytes host and
  links the storefront feeds, which are served on the console host; without the var (or with it
  pointing at the bytes host) the page leaves the AltStore, SideStore, Obtainium, F-Droid and
  Scoop rows out. `test/downloadPage.test.ts` checks each committed environment.
- **Same-site with the console.** `dl.plrs.im` is a `plrs.im` sibling, so it is same-site with
  `key.plrs.im`. That is an owner decision; the Worker compensates (`sandbox` CSP, `nosniff`,
  no HTML/SVG/XML/script types, no cookies read or set on the host, host-only console
  cookies). The two HTML answers, the public download page (P2b-06) and the host's landing
  page at exactly `/` (static, BRAND §8), are script-free and leave under their own sandboxed
  policies, which the dispatcher checks. The landing page ("Polaris Key Delivery") links `CONSOLE_ORIGIN` (falling back
  to `https://key.plrs.im` when it is unset or unusable; an `http:` origin is used only when
  `BLOB_ORIGIN` is itself `http:`, for local development) and, on `dl-staging` and `dl-dev`, names
  the environment under its title and asks not to be indexed. Do not put anything else on `dl.plrs.im`, and never add a `Domain=plrs.im` cookie
  anywhere on the platform.

After the next deploy, check the isolation from outside:

```sh
curl -sI https://dl.plrs.im/manage | grep -iE '^(HTTP|content-security-policy|x-content-type-options)'
# HTTP/2 404, content-security-policy: sandbox; ..., x-content-type-options: nosniff
# The fully-qualified form (trailing dot) must answer the same, not the console:
curl -sI https://dl.plrs.im./manage | grep -iE '^(HTTP|content-security-policy|x-content-type-options)'
# HTTP/2 404, content-security-policy: sandbox; ..., x-content-type-options: nosniff
# The root is the static landing page, under its own inert policy, with no cookie:
curl -sI https://dl.plrs.im/ | grep -iE '^(HTTP|content-type|content-security-policy|set-cookie)'
# HTTP/2 200, content-type: text/html; charset=utf-8,
# content-security-policy: sandbox; default-src 'none'; style-src 'sha256-…'; img-src data:; …
# and no set-cookie line. Every other path (/favicon.ico included) is still the 404 above.
```

Since P2-05 the host serves Release's three byte routes (`/<p>/release/builds/…`,
`/<p>/release/files/…`, `/<p>/release/blobs/sha256/…`), the first real responses on it. After
the deploy that ships them, check them from outside too (`<slug>` is a product with Release on):

```sh
# An unreferenced or unknown hash is the plain JSON not-found, hardened:
curl -si https://dl.plrs.im/<slug>/release/blobs/sha256/$(printf '0%.0s' $(seq 64)) \
  | grep -iE '^(HTTP|content-type|content-security-policy|x-content-type-options)|not_found'
# HTTP/2 404, content-type: application/json, sandbox CSP, nosniff, {"error":"not_found"}
# A real file of a real release streams as an inert attachment, with no cookie:
curl -sI https://dl.plrs.im/<slug>/release/files/<tag>/<asset> \
  | grep -iE '^(HTTP|content-type|content-disposition|content-security-policy|set-cookie)'
# HTTP/2 200, content-type: application/octet-stream (or an allowlisted type),
# content-disposition: attachment; ..., sandbox CSP, and no set-cookie line
# A Range request is a 206 (and a second one costs no GitHub API call):
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' \
  https://dl.plrs.im/<slug>/release/files/<tag>/<asset>
# 206
# The legacy download path does NOT exist on the bytes host:
curl -sI https://dl.plrs.im/<slug>/release/dl/latest/<binary>-arm64 | head -1
# HTTP/2 404
# Discovery (on the console) advertises the bytes host:
curl -s https://key.plrs.im/<slug>/.well-known/polaris.json | grep -o '"builds":"[^"]*"'
# "builds":"https://dl.plrs.im/<slug>/release/builds/{selector}/{buildId}"
```

### Trusted publishing: the R2 parent token (P2-02)

CI never uploads through the Worker. `POST /<p>/release/publish/uploads` hands a CI job R2
**temporary credentials** that can only `PutObject` and `HeadObject` under
`staging/<product>/<ticketId>/`, and the Worker mints them **locally** — an HS256 JWT signed with
the secret of a parent R2 API token, per Cloudflare's "temporary credentials, local signing".
Nothing is fetched at mint time and the parent secret never leaves the Worker. Until the three
secrets below exist in an environment, the uploads route answers 404 there and nothing else
changes (`/publish/token` and `/publish/submit` still answer, but a submit needs a ticket).

For each environment, create one R2 API token (dashboard → R2 → Manage R2 API tokens):

- permission **Object Read & Write**, applied to **that environment's bucket only**
  (`polaris-key-blobs-<env>`), no account-wide scope and no admin permission — a temporary
  credential can never exceed its parent, so the parent's scope is the outer bound;
- no TTL, or a long one with a rotation reminder: revoking the parent instantly kills every
  temporary credential minted from it.

Then set three Worker secrets (the bucket name is already a `[vars]` entry, `BLOBS_BUCKET_NAME`):

```sh
cd packages/worker
npx wrangler secret put R2_ACCOUNT_ID --env prod                # the 32-hex account id
npx wrangler secret put R2_PARENT_ACCESS_KEY_ID --env prod      # the token's Access Key ID
npx wrangler secret put R2_PARENT_SECRET_ACCESS_KEY --env prod  # its Secret Access Key
```

Write all three in one `wrangler secret bulk` if you prefer; two `put`s deploy two versions, and
the intermediate one simply keeps answering 404 on the uploads route.

What the minted credential may do is fixed in code (`core/publisher.ts`,
`UPLOAD_CREDENTIAL_ACTIONS`): `PutObject` and `HeadObject` on one prefix. No `GetObject`, no
listing, no `CopyObject`/`UploadPartCopy` (a copy could carry another product's object, with its
stored checksum, into the ticket prefix) and no multipart (a multipart object's stored checksum is
not its SHA-256). CI must upload each object as **one** PUT with `x-amz-checksum-sha256`.

After the first deploy with the secrets, confirm against real R2 (the test suite models R2's
documented rules; it cannot reach an account):

```sh
# With a ticket's credentials exported as AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN
# and ENDPOINT=https://<account>.r2.cloudflarestorage.com, BUCKET=polaris-key-blobs-<env>:
aws s3api put-object --endpoint-url "$ENDPOINT" --bucket "$BUCKET"   --key "<prefix><sha256>" --body file.bin --checksum-algorithm SHA256       # 200
aws s3api get-object --endpoint-url "$ENDPOINT" --bucket "$BUCKET"   --key "<prefix><sha256>" /dev/null                                          # 403 AccessDenied
aws s3api copy-object --endpoint-url "$ENDPOINT" --bucket "$BUCKET"   --key "<prefix>x" --copy-source "$BUCKET/blobs/sha256/<any>"                # 403 AccessDenied
aws s3api put-object --endpoint-url "$ENDPOINT" --bucket "$BUCKET"   --key "staging/<other-product>/x/y" --body file.bin                         # 403 AccessDenied
aws s3api create-multipart-upload --endpoint-url "$ENDPOINT" --bucket "$BUCKET"   --key "<prefix>m"                                                           # 403 AccessDenied
```

The GitHub OIDC side needs nothing from the operator: the issuer and its JWKS are GitHub's and
fixed in code. A product opts in from its own `.pkey/release` (`publishing.trustedPublisher`).

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
3. Enter the product repository (`<owner>/<repo>`).
4. Confirm Polaris Key validates the `.pkey/` manifest.
5. Save the returned `kid -> publicKey` trust set for DJDL SDK/app pinning.

Set the required DJDL product secrets in the admin UI/API:

| Secret name                 | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| `EDGE_MINT__DJDL__<RECIPE>` | Signing key material for each edge-mint recipe declared |

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

1. Change a `.pkey/` file in the product repository on the default branch.
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
- R2 bucket `polaris-key-blobs-prod` is bound as `BLOBS`, with 180-day age locks on `blobs/`,
  `bundles/`, `deltas/` and `gated/`, a 1-day expiry on `staging/`, and `r2.dev` disabled.
- `https://dl.plrs.im/manage` and `https://dl.plrs.im./manage` (trailing dot) answer 404 with
  `content-security-policy: sandbox; …`.
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

- Install GitHub App `polaris-key` on the product repository, then retry.

Portal says email sign-in is disabled.

- Confirm DJDL portal settings enable magic links.
- Confirm the prod `EMAIL` binding deployed.
- Confirm Cloudflare Email Service permits `noreply@plrs.im`.

`wrangler deploy --env <env>` fails on D1/KV bindings.

- Only `env.prod` carries real IDs. For `staging`/`dev`, replace the `REPLACE_ME_*_D1_ID`
  and `REPLACE_ME_*_KV_ID` placeholders in `wrangler.toml` with IDs from the resource
  creation commands.

`wrangler deploy --env <env>` fails on the `BLOBS` R2 binding.

- The bucket `polaris-key-blobs-<env>` does not exist in the account. Create it with the lock,
  lifecycle and `dev-url disable` commands in §3 "Blob store (R2) and the bytes host".
