# Polaris Key operations runbook

This runbook is for operating an already deployed Polaris Key production service at
`https://key.plrs.im`.

For first-time production bootstrap, external provider setup, secret loading, CI setup, and
DJDL onboarding, use [DEPLOYMENT.md](./DEPLOYMENT.md).

## Production shape

| Item                 | Value                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| Cloudflare account   | `Polaris` / `07a2eb0d4916b220da1f9c1387b5f6d8`                                       |
| Worker env           | `prod`                                                                               |
| Public origin        | `https://key.plrs.im`                                                                |
| Admin                | `https://key.plrs.im/manage`                                                         |
| Customer portal      | `https://key.plrs.im`                                                                |
| D1 database          | `polaris_key_prod`                                                                   |
| KV namespace         | `POLARIS_HOT_prod`                                                                   |
| PocketID issuer      | `https://id.plrs.im`                                                                 |
| Platform admin group | `admins`                                                                             |
| GitHub App           | `polaris-key`                                                                        |
| Email sender         | `Polaris Key <noreply@auth.plrs.im>` (I-18; `noreply@plrs.im` until the switch-over) |

Reserved platform routes:

- `/manage/*` - admin SPA, admin OIDC, and admin JSON API.
- `/api/*`, `/login`, `/callback`, `/logout`, `/magic/verify`, `/download/*` - customer
  portal.
- `/webhooks/github` - signed GitHub App push webhooks.
- `/<product>/*` - product-scoped licensing, config, OIDC activation, releases, and JWKS.

## Deploy

Manual deploy:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
cd packages/worker
npx wrangler d1 migrations apply polaris_key_prod --env prod --remote
pnpm check:representable          # see "Representability check" below; must report clean
npx wrangler deploy --env prod
```

### Representability check

The Worker refuses to sign a document a wire-v4 verifier would refuse (a lone surrogate,
U+0000 in a member name, two member names equal after NFC normalization, a number outside
1e-307 to 1e308, more than 32 levels of nesting, or an integer claim that is not a safe
integer), and its write paths refuse such values at write. Values stored before those checks
existed are still in D1. One that trips the signer is pruned from the config document or
turns that product's licence documents into `500 document_not_representable`, for v3 clients
too (docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md §2.2).

**Before the first production deploy of a Worker that contains P3-12** (manual, or the `v*`
tag that CI deploys, which does not run the check), and again after any manual D1 edit, run the check against production D1 from `packages/worker` (it needs the
operator's Cloudflare credentials, as `wrangler d1 migrations apply` does):

```sh
cd packages/worker
pnpm check:representable                 # --env prod --remote polaris_key_prod (the default)
pnpm check:representable -- --json       # the same, machine-readable
```

It reads 21 columns (8 JSON, 12 text, `tiers.policy_device_limit`; the active catalog's entry
keys are checked as the member names they become) and the two offline-day counts
(`licenses.max_offline_days`, `products.default_max_offline_days`). It prints one `FLAGGED`
line per value, naming the table, column, row key and JSON pointer, then exits 1. An
offline-day count is `FLAGGED` when it makes `graceUntil` unsignable (about 1.04e11 days or
more, below about −20 000 days, or not a number), because every licence and config document
that uses it then answers `500 document_not_representable`. Fix every flagged value in the
console (licence, tier, profile or product editors) or in the product's `.pkey/` manifest and
resync, then run the check again until it exits 0. Do not deploy while it flags anything.
`warning` lines do not block a deploy. They are any other offline-day count that is not an
integer from 1 to 365, which the builders floor and sign, and a JSON column that does not
parse, which the Worker ignores. Sealed secrets cannot be opened by the check; a flagged one
is dropped from the config document at signing.

The manifest validator does not yet bound `licensing.defaultMaxOfflineDays` (plans/P3-01.md
§8 risk 13), so a resync can still store a product default the check flags. Until that rule
lands, run the check again after a resync that changes the default.

`--local [--persist-to DIR]` runs the same check against a local D1 (miniflare), which is how
`packages/worker/test/checkRepresentable.test.ts` exercises it.

CI deploy:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Only semver-like `v*` tags deploy production. Pushes to `main` run CI but do not deploy.

Smoke checks:

```sh
curl -fsS https://key.plrs.im/manage >/dev/null
curl -fsS https://key.plrs.im/api/capabilities | jq .
```

## Secrets

Required prod Worker secrets:

```text
KEY_HASH_PEPPER
ADMIN_SESSION_SECRET
PORTAL_SESSION_SECRET
PLATFORM_KEK                 # or the keyring pair below, never both
PLATFORM_ADMIN_GROUP=admins
PLATFORM_OIDC_ISSUER=https://id.plrs.im
PLATFORM_OIDC_CLIENT_ID
PLATFORM_OIDC_CLIENT_SECRET
ADMIN_OIDC_ISSUER=https://id.plrs.im   # the console's own client (I-03)
ADMIN_OIDC_CLIENT_ID
ADMIN_OIDC_CLIENT_SECRET
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
REGISTRY_TOKEN_KEY           # F-21: the OCI pull-token HMAC key (32 random bytes, base64)
DOWNLOAD_TICKET_KEY          # PX-W3: the portal's download-ticket HMAC key (32 random bytes, base64)
SIGNIN_*                     # I-06, optional: the login card's providers ("Login-card providers")
```

Rotate or set a Worker secret:

```sh
cd packages/worker
npx wrangler secret put <NAME> --env prod
```

`PLATFORM_KEK` protects sealed product signing keys and product secrets in D1. It is the only
secret whose misconfiguration is **silent**: every `open()` throws, `loadProduct` returns
`null`, and every product route serves **404 with no log line** — an outage indistinguishable
from "someone deleted all the products". Read the rotation procedure below before touching it.

Product secrets are not Worker secrets. Set them through the admin UI/API so they are sealed
into `product_secrets`; values are write-only and never echoed back.

### The console's Pocket ID client (I-03)

The console signs operators in through its own Pocket ID client, separate from the platform
client that the customer portal and `provider: platform` products use.

| Who reads it                          | Secrets           | Pocket ID callback URL                |
| ------------------------------------- | ----------------- | ------------------------------------- |
| Console (`/manage/login`)             | `ADMIN_OIDC_*`    | `https://key.plrs.im/manage/callback` |
| Portal and `provider: platform` users | `PLATFORM_OIDC_*` | `/callback`, `/<slug>/identity/...`   |

- **Precedence.** The console uses `ADMIN_OIDC_*` when both `ADMIN_OIDC_ISSUER` and
  `ADMIN_OIDC_CLIENT_ID` are set, with `ADMIN_OIDC_CLIENT_SECRET` (never the platform secret).
  Otherwise it falls back to the whole `PLATFORM_OIDC_*` trio. The portal and products read
  `PLATFORM_OIDC_*` only and never fall back to `ADMIN_OIDC_*`.
- **While it falls back,** Platform → Settings shows the warning _The console shares the
  customer sign-in client_ (`console_oidc_shared`), naming the admin variables still unset.
- **Setting it up.** Create one console client per environment in Pocket ID (DEPLOYMENT.md §2,
  PocketID), then set all three secrets in one `wrangler secret bulk` call per environment
  (DEPLOYMENT.md §4). Sign in at `/manage` in a private window before closing your current
  session, then remove `/manage/callback` from the platform client.
- **Rotating the console secret.** Regenerate the secret on the console client in Pocket ID and
  `wrangler secret put ADMIN_OIDC_CLIENT_SECRET --env <env>` at once: sign-ins fail with
  _Sign-in could not be verified_ between the two steps. Existing console sessions are not
  affected (they are signed with `ADMIN_SESSION_SECRET`).
- **Rolling back.** `wrangler secret delete ADMIN_OIDC_CLIENT_ID --env <env>` returns the console
  to the platform client, which then needs `/manage/callback` back in its callback URLs.

### Platform store connections (A-16)

The team-level store credentials (App Store Connect API key, In-App Purchase key, Google Play
service account, Partner Center app, Steam publisher key) and the shared store settings (Apple
Team ID, Play RTDN push identity, Play Integrity project number) live under
`/manage/api/platform/store-connections` (platform admins only). DEPLOYMENT.md §4 has the Worker
secret names and JSON shapes.

- **Which source is in use.** `GET /manage/api/platform/store-connections` → each credential's
  `source` (`console` or `secret`) and `secret.valid`. A console credential always wins; the
  Worker secret is read only while none is stored.
- **Set or rotate a Worker secret without handling the key.** From the machine that holds the
  file: `gh secret set <NAME> --env production < key.json`, then
  `gh workflow run sync-worker-secrets.yml -f target=prod`. The workflow pushes every set name
  through wrangler's stdin and logs names only (DEPLOYMENT.md §4). Never paste a key into a
  terminal command line or an agent conversation.
- **Rotate.** Store the new key in the console (`PUT …/<store>` or
  `…/<store>/credentials/<slot>` with `{"value": …}`). Cached tokens and the apps list are keyed by
  the credential's version marker, so the old key's tokens stop being served at once. To rotate a
  secret-only setup: `wrangler secret put` the new JSON (a deploy), then revoke the old key at the
  store.
- **Revoke in a hurry.** Revoke the key at the store first (that is what stops an attacker), then
  `DELETE …/<store>` and `wrangler secret delete <NAME> --env prod`. Every product falling back to
  it goes inert (`no_credential`) — its own credentials, if any, keep working.
- **Assign or move an app.** Assign from the list (`GET …/<store>/apps`, then
  `PUT …/<store>/apps/<appId>/product` with `{"product": "<slug>"}`). An app held by another
  product — by its platform pin or its own credential's pin — is refused with
  `app_assigned_elsewhere`; release it first (`DELETE …/<store>/apps/<appId>/product`). A product's
  own credential pin is not released by that: re-pin or delete it on the product.
- **A product's connector says `pin_missing` / `pin_mismatch` with `credentialSource:
"platform"`.** The product has no key of its own and either no app is assigned to it, or the
  manifest names another app than the assigned one. Check that the manifest's app is the product's
  before assigning it — the team key reaches every app of the team.
- **Audit.** Product opens are `platform_credential.use` rows in the product's activity; writes,
  assignments and team-wide opens are rows of `platform_audit`.
- **KEK rotation.** The re-seal sweep counts console credentials under `platformCredentials` and
  re-seals them with the rest; a Worker secret is outside the KEK.

### The platform KEK keyring

The KEK is configured in one of two shapes. They are equivalent for a single key; only the
second one can be rotated.

| Variable              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_KEK`        | Legacy single KEK: base64 of exactly 32 random bytes. Ignored when `PLATFORM_KEK_KEYS` is set.                                                                                                                                                                                                                                                                                                                                                |
| `PLATFORM_KEK_ID`     | **Optional, and a loaded gun.** The kid stamped into blobs sealed under `PLATFORM_KEK`. Defaults to `default`, which is the kid every existing production blob carries. Setting or changing it on its own renames both the kid new writes use **and** the only kid that can be read — i.e. it instantly makes every stored blob unopenable. It exists for continuity with deployments that already set it; **do not use it to rotate a KEK.** |
| `PLATFORM_KEK_KEYS`   | The keyring: a JSON object of `kid -> base64 KEK`, e.g. `{"k1":"…","k2":"…"}`. **Every** kid listed can be decrypted.                                                                                                                                                                                                                                                                                                                         |
| `PLATFORM_KEK_ACTIVE` | The kid within `PLATFORM_KEK_KEYS` that **new** seals are written under. Must be a key of that map.                                                                                                                                                                                                                                                                                                                                           |

Rules the Worker enforces (all fail closed — a bad keyring never falls back to a good one):

- Every KEK must decode to exactly 32 bytes.
- `PLATFORM_KEK_ACTIVE` must name an entry of `PLATFORM_KEK_KEYS`.
- When `PLATFORM_KEK_KEYS` is set, `PLATFORM_KEK` is **not** consulted — a kid you leave out of
  the map is a kid you can no longer read.
- A sealed blob is opened with the KEK its own `kekId` names. An unknown `kekId` is refused; no
  other key is ever tried.

Check the live state at any time (platform admin):

```sh
curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" | jq .
# { "active": "k2", "kids": ["k1","k2"],
#   "counts": { "keys": {"k1":3,"k2":12}, "secrets": {"k1":1}, "outletCredentials": {"k2":1},
#               "managed": {"k1":2} },
#   "remaining": 6,        ← sealed values not yet re-sealed under the active kid
#   "unopenable": 0 }      ← values under a kid the ring does NOT hold: these are DARK right now
```

Four classes of value are covered, and all four are counted and swept together:

| `counts` bucket     | Where it lives                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `keys`              | `product_keys.enc_private_json` — per-product signing keys                                                      |
| `secrets`           | `product_secrets.enc_value_json` — per-product secrets                                                          |
| `outletCredentials` | `outlet_credentials.enc_value_json` — store credentials (App Store Connect, Google Play, Partner Center; P5-01) |
| `managed`           | catalog-declared managed secrets sealed inside `profiles.payload_json` and `licenses.overrides_json` (R12-02)   |

### Rotating PLATFORM_KEK

Supported, with the platform serving throughout. There is a two-KEK read window, and the
re-encryption pass is an admin endpoint (SQLite cannot do AES-GCM, so it cannot be a `.sql`
migration). Do not skip step 6.

1. Generate the new KEK and confirm it decodes to exactly 32 bytes:

   ```sh
   NEW_KEK=$(openssl rand -base64 32)
   echo -n "$NEW_KEK" | base64 -d | wc -c    # must print 32
   ```

2. Record the current active kid and row counts:

   ```sh
   curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" | jq .
   ```

   On a deployment that never set `PLATFORM_KEK_KEYS`, this reports `active: "default"` — that
   is the kid every existing blob carries, and the kid to keep in the ring as `k1` below.

3. **Add the new key WITHOUT making it active.** Use `wrangler secret bulk`, not two
   `secret put` calls: each `put` deploys a new Worker version, and the intermediate version —
   where `PLATFORM_KEK_ACTIVE` names a kid `PLATFORM_KEK_KEYS` does not yet contain — fails
   closed platform-wide for as long as it is live.

   ```jsonc
   // /tmp/kek.json — delete immediately afterwards
   {
     "PLATFORM_KEK_KEYS": "{\"default\":\"<current PLATFORM_KEK>\",\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "default",
   }
   ```

   ```sh
   cd packages/worker
   npx wrangler secret bulk /tmp/kek.json --env prod && rm -f /tmp/kek.json
   ```

4. Verify nothing broke. Every blob still carries the old kid and still opens:

   ```sh
   curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
   curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" | jq .
   # expect: remaining 0, unopenable 0
   ```

   A 404 from a product route here means the ring did not parse. Re-run step 3 with the old key
   only, and stop.

5. **Promote the new key.** New seals use `k2`; every existing blob still opens under the old
   kid, which is still in the ring.

   ```jsonc
   {
     "PLATFORM_KEK_KEYS": "{\"default\":\"<old>\",\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "k2",
   }
   ```

6. **Re-encrypt everything.** The sweep is bounded, idempotent and resumable — repeat until
   `remaining` is 0:

   ```sh
   curl -fsS -X POST https://key.plrs.im/manage/api/products/kek \
     -H "cookie: __Host-pkey_admin=…" -H "X-PKey-CSRF: …" \
     -H "content-type: application/json" -d '{"limit":50}' | jq .
   # { "resealed": 50, "skipped": 0, "failed": 0, "remaining": 27, … }
   ```

   - `limit` bounds the work per call: one unit per `product_keys` / `product_secrets` row, and
     one per `profiles` / `licenses` row (a payload row may carry several managed secrets, all
     re-sealed together under one compare-and-swap).
   - `skipped` — a concurrent admin write (key rotation, `secret.set`) won the compare-and-swap
     for that row. It is already sealed under the active kid or will be picked up next pass.
   - `failed` — the value could not be opened or did not round-trip. **Nothing was written.**
     The `failures` array names the table, product and id. If `resealed` is 0 and `failed` is
     not, the sweep is stuck: that kid is missing from `PLATFORM_KEK_KEYS` (put it back) or the
     blob is corrupt (restore it — see the D1 backup procedure — or re-issue that key/secret).

   Then confirm completion; this is the gate for step 8:

   ```sh
   curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" | jq .
   # counts must show ZERO rows under any kid other than the active one
   ```

7. Soak for **24 hours** with both keys in the ring. Nothing should reference the old kid.

8. **Drop the old key.** Only after `remaining` is 0.

   ```jsonc
   {
     "PLATFORM_KEK_KEYS": "{\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "k2",
   }
   ```

   Re-check `unopenable` is 0 immediately afterwards, and delete the now-unused `PLATFORM_KEK`
   secret so it cannot be silently re-adopted by a later rollback:
   `npx wrangler secret delete PLATFORM_KEK --env prod`.

9. Update the escrowed copy of the KEK and destroy the old key material.

**Rollback:** at any point before step 8, set `PLATFORM_KEK_ACTIVE` back to the previous kid
while keeping **both** keys in `PLATFORM_KEK_KEYS`. Rows already re-sealed under the new kid
still open, because the ring still holds it. After step 8 there is no rollback — that is what
step 7 is for.

**`wrangler rollback` un-rotates secrets.** A Worker version captures its bindings, and classic
secrets are bindings, so rolling back to a pre-rotation version also restores the pre-rotation
keyring. If rows have already been re-sealed under the new kid, that version cannot open them
and every affected product 404s. After any KEK change, prefer a forward fix over
`wrangler rollback`.

**KEK compromise (containment).** The leak is exploited offline against a D1 dump, so there is
nothing to block at the edge; the only response is to re-key. Run steps 1-8 immediately — the
platform stays up throughout, which is the whole point of the keyring. Rotating the KEK does
not invalidate anything an attacker already decrypted: treat every product signing key that was
sealed under the leaked KEK as compromised and rotate those too (Product operations → keys
prepare/activate/revoke), and re-enter every product secret.

## Product operations

Register products through the admin portal repo-link flow when a product repo has `.pkey/`
files. Manual product creation is only for early experiments before release/OIDC/provisioning
exists.

For DJDL, confirm:

- `.pkey/product` uses `oidc.provider: platform`.
- Redirect URI is `https://key.plrs.im/djdl/identity/auth/callback`.
- Admin group is `admins`.
- Required product secrets are configured:
  - one `EDGE_MINT__DJDL__<RECIPE>` signing key per declared edge-mint recipe

Product validation:

```sh
curl -fsS https://key.plrs.im/djdl/.well-known/polaris.json | jq .
curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
curl -fsS https://key.plrs.im/djdl/config/schema | jq .
curl -fsS https://key.plrs.im/djdl/appcast.xml >/dev/null
```

Use the Releases view to inspect GitHub sync status, changed `.pkey/` paths, manifest
validation errors, and release health. Use manual resync there when a webhook was missed.

### Package feeds (F-02)

The feeds answer on the registry host, `pkg.plrs.im` (`pkg-staging`, `pkg-dev`), the same
Worker on a third custom domain (DEPLOYMENT §3, "Registry host and feeds"). Check the host after
a deploy:

```sh
curl -sI https://pkg.plrs.im/v2/ | grep -iE '^(HTTP|docker-distribution-api-version|www-authenticate)'
# HTTP/2 401, registry/2.0, Bearer realm=".../v2/token" (200 if REGISTRY_TOKEN_KEY is unset)
curl -s 'https://pkg.plrs.im/v2/token?service=pkg.plrs.im' | head -c 60      # {"token":"v1.…
curl -sI https://pkg.plrs.im/manage | head -1                                 # 404
```

**Kill switches**, loosest scope last; each answers the plain not-found (the same as a feed that
does not exist) and takes effect within the 30-second per-isolate settings window, even for
bytes the edge has cached for a year, because the access check runs before the cache:

1. the platform policy per ecosystem (`dist_registry_policy.enabled`);
2. the owner's `packageFeeds` (Core → Services, under Distribution);
3. the feed's `enabled`;
4. Distribution itself for the owner.

Tightening a feed's or a deliverable's access mode away from `public` answers clients without a
registry token `401` with their native challenge within the same window (see "Registry tokens
(F-21)" below).

**A missing or stale index object** heals itself: a read that misses renders the package from
D1, writes it back under `registry/` and counts `registry.render_miss`. The cron's self-check
re-renders up to 50 packages per run whose stored render stamp differs from D1. Never put an R2
lock or lifecycle rule on `registry/`.

Bootstrapping the system product, turning an owner's feeds on, yanks and deprecations, feed
rebuilds, the Swift signing-certificate rotation and the forward-only migration note follow with
F-03, F-06 and F-11.

### Registry tokens (F-21)

Clients of a non-public feed present a registry token (`pkeyr_…`): minted in the console
(**Distribution → Package feeds → Tokens**, or a licence's **Keys** tab) or by a licensee in the
portal. Every token expires (at most 365 days). The store is `registry_tokens` (Core's).

**Switching a feed's mode.** In the feed's **Settings → Access**. Leaving `public` answers every
client without a token `401` within 30 seconds, so mint the tokens and hand out the authenticated
setup (the Tokens page's shown-once dialog, or `/docs/build/install-from-feeds/#private-feeds`)
first. Switching back to `public` reopens the feed within 30 seconds. A rollback to a Worker older
than F-21 with a non-public feed refuses every read of that feed (it fails closed); switch the
feed back to `public` to reopen it. The platform's own feeds stay `public`.

**A leaked token.** Revoke it on the Tokens page (or the licence's panel); it stops within 30
seconds on every isolate. If you cannot tell which token leaked, **Revoke all** on the Tokens page
revokes every active token of the product, including licensee-minted ones; tell licensees to mint
new ones in the portal. Revocations are audited (`registry_token.revoke`,
`registry_token.revoke_all`; `portal.registry_token.revoke` for a licensee's own).

**Rotating `REGISTRY_TOKEN_KEY`** (the OCI pull-token HMAC key). Pull tokens live five minutes, so
a rotation is two deploys apart by at least that long:

```sh
cd packages/worker
openssl rand -base64 32 > /tmp/new-key
npx wrangler secret bulk --env prod <<EOF
{"REGISTRY_TOKEN_KEY_PREVIOUS": "<the current key>", "REGISTRY_TOKEN_KEY": "$(cat /tmp/new-key)"}
EOF
# wait at least 5 minutes, then:
npx wrangler secret delete REGISTRY_TOKEN_KEY_PREVIOUS --env prod
rm /tmp/new-key
```

Without `REGISTRY_TOKEN_KEY`, `/v2/token` answers 503 and `/v2/` stays a plain 200, so OCI clients
can pull public images but no non-public OCI feed can be reached.

### Download tickets (PX-W3)

The customer portal's licensed bytes-host downloads (files on R2 or in a private GitHub
repository) go through a 120 s **download ticket** signed with
`DOWNLOAD_TICKET_KEY` (docs/DEPLOYMENT.md, "Licensed portal downloads"). Without the key, those
files read `not_hosted` in the portal and nothing else changes.

**Rotating `DOWNLOAD_TICKET_KEY`.** A ticket names its key by a fingerprint (`kid`), so tickets
minted just before the rotation keep verifying under `DOWNLOAD_TICKET_KEY_PREVIOUS` until they
expire, two minutes at most:

```sh
cd packages/worker
openssl rand -base64 32 > /tmp/new-key
npx wrangler secret bulk --env prod <<EOF
{"DOWNLOAD_TICKET_KEY_PREVIOUS": "<the current key>", "DOWNLOAD_TICKET_KEY": "$(cat /tmp/new-key)"}
EOF
# wait until every Worker instance serves the new key (a fresh deploy or a few minutes after
# the bulk put), then at least 120 seconds more, then:
npx wrangler secret delete DOWNLOAD_TICKET_KEY_PREVIOUS --env prod
rm /tmp/new-key
```

**A leaked key, or switching the feature off.** Delete `DOWNLOAD_TICKET_KEY` (and
`DOWNLOAD_TICKET_KEY_PREVIOUS` if set): every live ticket stops verifying at once and licensed
ticketed files go back to `not_hosted`. Put a fresh key to turn it back on. A leaked single ticket
needs nothing: it opens one file for at most 120 s.

### Recovering the update feeds after a signer compromise

The signed update feed (`pkey-feed+jws`, `GET /<p>/update/<channel>/feed.jws`) carries a `seq`
that every install refuses to see go down. Anyone who held the product's signing key — a
compromised Worker deploy, a leaked KEK — can sign a feed at the maximum `seq`
(9007199254740991) for any channel name, and installs that fetch it then refuse the honest
Worker's lower `seq` and freeze (they keep running, but stop updating) once that feed expires.
Run this after **any** suspected product-key or Worker compromise, without waiting for evidence:

1. Rotate the product key (console → product → keys) and redeploy from a trusted commit.
2. For every affected product:

   ```sh
   pnpm --filter @polaris-key/worker feed:seq-ceiling --product <slug>            # --env prod by default
   pnpm --filter @polaris-key/worker feed:seq-ceiling --product <slug> --env staging
   ```

   In one D1 batch it sets the product's ceiling flag (`update_feed_ceiling`, never cleared),
   raises every channel's `update_feed_state.seq` to the ceiling, and deletes the stored feed
   documents. It always covers the whole product: a channel nobody has requested yet starts at
   the ceiling too. It is idempotent.

3. Check one channel: `GET /<slug>/update/stable/feed.jws?platform=macos` must decode to
   `"seq": 9007199254740991`. Every later feed of the product is signed at the ceiling with a
   newer `issuedAt`, which installs accept; no client release is needed.

Release records are not affected: they are signed in CI with release keys the Worker never
holds. If a **release** key leaked, rotate it in CI, add the new key to `.pkey/release`
`releaseKeys`, and ship an app build that pins it.

A stolen release key can also sign revocations (below). Devices that verified a revocation of a
required pack stay stopped until an app build that pins the rotated key ships; on load, an SDK
forgets every stored revocation whose key is no longer pinned.

### Revoke a pack

A revocation tells devices to stop using a pack release they already hold (a yank only stops
new serving). It is a `kind: revocation` release record signed in CI with the release key
(`PKEY_RELEASE_KEY`), never by the Worker:

```sh
pkey release revoke <packId>@<version> --reason "<text>" [--replacement <version>] [--dry-run]
```

- `--reason` is 1–512 bytes, shown to operators (display only).
- `--replacement` names a newer release of the **same** pack. It must be stored, not yanked, not
  revoked, and cover the target (every variant key with an equal `requires.engine`; for a
  compatible pack, every live or pinned level the target admitted). Devices swap it in.
- `--dry-run` resolves both records through the uploads preflight and self-checks the signed
  record without submitting.
- The Worker refuses the command unless discovery advertises `revocations: true`.

On ingest the Worker also writes a `release_yanks` row for the target (reason `revoked`, by
`ci:<kid>`), re-resolves the product's sets, and lists the revocation in every feed whose
channel still has a stored app release that pins, holds or embeds the target.

**Revocations are permanent.** There is no un-revoke; a wrong revocation is fixed by publishing a
newer release. To add or change the replacement later, run `revoke` again for the same target
with `--replacement`: the newer revocation (newest `issuedAt`) supersedes the stored one, which
is updated in place. An older submit is refused (`revocation-stale`).

**Effect on devices.** A revoked optional pack is unmounted and play continues. A revoked
**required** pack with no usable replacement stops the boot (`blocked {revoked-content}`, boot
`required`) until a replacement or an app update arrives. SDKs older than P4-13 ignore
revocations and keep mounting the revoked release until the host upgrades its SDK; the yank only
stops new installs.

### Do not roll back past P4-13 without the yank

A Worker rolled back to a build older than P4-13 does not read `release_revocations` and does not
list revocations in feeds. The `release_yanks` row that ingest writes is what keeps a revoked
target out of an old Worker's sets: never delete those rows (reason `revoked`) during a rollback,
and never roll back the migration. Devices that already learned a revocation keep refusing the
target. Every SDK release note must state that SDKs older than P4-13 keep using revoked content
until upgraded.

### Package feeds (F-03)

Package feeds serve versions of `kind: package` deliverables (our SDKs among them) on
`pkg.plrs.im`. F-03 ships the data side; the registry host (F-02), the ecosystem renderers (F-04
to F-09) and the console pages (F-11) follow.

- **Bootstrap the system product** after deploying F-03, in each environment (dev, staging,
  production), as a platform admin:
  `POST /manage/api/platform/feeds/bootstrap` (idempotent; audited `feed.bootstrap` in the
  platform trail). It creates `polaris-key`, turns Release, Distribution and its package feeds on
  and seeds one feed per ecosystem with the platform namespaces. Registering the monorepo's
  trusted publisher for it is F-10's step.
- **Turn a product's feeds on or off:** `PUT /manage/api/products/<slug>/distribution/package-feeds
{"enabled": true|false, "expectedVersion": <n>}`. Off stops every read for the owner at once.
- **Yank or deprecate a version:** the release's yank (`…/release/releases/<id>/yank`) is its feed
  state; deprecate is `POST|DELETE …/release/releases/<id>/deprecate {"message"}`. Neither frees
  the version: a package version is never published again. Only feed retention deletes a version
  (a build of main below a stable release; "Feed retention" below), and it leaves a tombstone so
  the version is still never published again.
- **Publish:** CI runs `pkey release publish --deliverable <package id>`, which always dry-runs
  first; a Worker older than F-03 is reported as such and nothing is uploaded.

### Releasing our SDKs to the feeds (F-10)

Every SDK this repository ships is a package deliverable of the system product, declared in the
root `.pkey/release`, and is published only to its feed on `pkg.plrs.im` (owner decision
2026-10-04: no npmjs, GitHub Packages, PyPI, Maven Central, Swift Package Index, Docker Hub,
Godot store or GitHub Release). Publishing is automatic and in lockstep with the server; there is
nothing to bump and no per-SDK tag:

| Trigger          | Workflow                                       | Every SDK is published at                                 | Channel                 |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------- | ----------------------- |
| a push to `main` | `publish-sdks.yml`                             | `<next>-main.<N>` (PyPI `<next>.dev<N>`)                  | `main` (npm dist-tag)   |
| a `v*` tag       | `deploy.yml` → `publish-sdks.yml` after deploy | exactly the tag's version (`v0.9.0` → `0.9.0` everywhere) | `stable`, `beta` if pre |

- **The version** comes from git (`tools/sdk-version.mjs derive`): `<next>` is the patch after the
  newest `v*` tag, `<N>` the commits since it. CI stamps it into every SDK's version file after
  the tests (`tools/sdk-version.mjs stamp`) and never commits it. A prerelease tag must be
  `-alpha.N`, `-beta.N` or `-rc.N` (PyPI has to spell it too); anything else fails the run.
- **To release:** tag a commit on `main` `vX.Y.Z` and push the tag. `deploy.yml` deploys the
  Worker, registers the platform packages (below), then publishes every SDK at `X.Y.Z`.
- **Registration** (`deploy.yml`, "Register the platform packages"): the deploy hook bootstraps the
  system product, links it to this repository and applies the root `.pkey/` of the tag: the
  package deliverables, the `main` channel and the trusted publisher (DEPLOYMENT §2). It is
  idempotent and leaves an operator's switches and claimed publisher alone. If it fails, the
  deploy fails after the Worker is live: fix the cause (its `::error::` names the Worker's reason:
  `policy_mismatch` with the claim, `invalid_manifest` with the validator's errors,
  `wrong_manifest`) and rerun the job. A new deliverable in `.pkey/release` is registered by the
  next deploy, so the first tag that adds one publishes it; a push to `main` before that deploy
  is refused for that one package (`invalid_descriptor`) and the drift check names it.
- **Publishing:** each package goes through `publish-package.yml`, the one trusted publisher, in
  the `package-registry` environment (DEPLOYMENT §2), from `main` or a `v*` tag only. A version
  is unique forever: a failed publish of a version that never landed can be re-run, a landed one
  cannot be replaced (yank it; the next push publishes the next version).
- **Drift:** the last job (`tools/feed-drift.mjs`) reads every package's listing back from its
  feed and fails unless its newest version of the build's kind is the build's version (npm's
  dist-tag and the image's tag included), naming each package that is behind. A failed publish
  shows up here too; rerun the failed jobs, then the drift job. npm's `latest` must be a stable
  release: a prerelease there (no stable release yet) fails a `main` or `beta` build's check.
- **Expected red, until the next `v*` deploy:** registration runs only from `deploy.yml` on a
  tag (staging and dev have no deploy hook). So `main` pushes publish nothing that depends on a
  registration no deploy has made yet: before the first deploy that registers the platform
  packages every package publish is refused and the drift job is red, and after a `main` commit
  adds a deliverable that one package is. Both go green with the next tag's deploy; nothing to
  fix by hand.
- **Swift signing:** the Swift job refuses to run without the three `SWIFT_REGISTRY_*` secrets
  and never publishes unsigned. To rotate the certificate, replace the secrets: new releases are
  signed with the new certificate, old releases keep their signatures, and adopters who trust
  the root see no change.
- **Dry runs:** locally, `pnpm --filter @polaris-key/worker registry:self-publish` runs the whole
  pipeline (derive, stamp, build, register, publish, drift, install with each real client)
  against a local Worker. `pkey release publish --product polaris-key --deliverable <id> --dir
<packed files> --dry-run` without a CI credential extracts and validates one package and stops
  before the server.

### Feed retention: pruning builds of main

Owner request 2026-10-06. These decisions were made by the lead under delegated owner authority.

- **What is pruned.** When version V of a package is published on `stable`, the package's
  `main`-channel prereleases that sort below V are deleted. That means semver `X-main.N` and PEP 440
  `X.devN` with X ≤ V (`services/release/packages/prune.ts`). Stable and beta versions are never
  touched, prereleases of versions newer than V are never touched, and other packages are never
  touched. A `beta` publish (a prerelease tag) prunes nothing. Only a live stable release sets
  the ceiling: a yanked or deprecated one never does. A candidate that a channel policy points
  at (a promote or pin) is kept. So is any candidate another row names (a revocation, a pack pin
  or hold, a download token). Both show as `kept` in the report. A candidate that became held
  between the plan and its deletion is kept too and listed as `skipped`, never dropped silently.
- **When.** Once the product opted in (below), the prune runs automatically in the Worker, right
  after the stable version is committed, for that package only. A failure never fails the publish. It is recorded
  in the product's audit as `package.prune.failed`, with the error. The Worker never logs to the
  console (R12), so the audit is the log. The next stable
  publish retries it, because each run prunes every remaining candidate. The backfill below also
  retries it. Every statement is idempotent, so running it twice is harmless.
- **The setting.** `release.packages.prunePrereleases` (settings registry; table
  `release_package_retention`) is OFF by default for a tenant product, which opts in with
  `PUT /manage/api/products/<slug>/distribution/feeds/retention {"expectedVersion": <n>,
"prunePrereleases": true}` (audited `feed.retention.update`; `false` turns it off again). The
  system product (`polaris-key`) is on by default and locked on: a write is refused.
- **What a prune does.** Versions go in atomic D1 batches of up to 20. For each version, the batch deletes its
  `release_packages`, `release_artifacts`, `release_yanks` and `release_metadata` rows and drops
  its `artifact` blob refs. It writes a tombstone to `release_package_prunes`: ingest refuses to
  republish the version (`package-version-taken`), so versions stay unique forever. It also
  audits `package.version.prune` with the package, version, actor and bytes, its `parent_id` the
  stable release that set the ceiling (`<deliverable>@<stable>`), and enqueues the package's
  render. The feeds render from D1 and every read is stamp-checked, so a pruned version
  is a not-found on every feed before the drain runs. A render also deletes the per-version
  documents a pruned version left under `registry/`.
- **Space.** A prune never deletes blob-store bytes. The prune drops the refs, and the blob
  collector (below) reclaims an object only once **no** ref from any product holds it. A blob
  that a remaining version, another package or another product shares (content-addressed)
  stays. The report's `freedBytes` is what the collector will reclaim. It does so after the
  grace period and the bucket lock's age (180 days), so the bucket shrinks months later, not
  at once. An applied run counts it per batch against the refs that remain, so a run the
  200-version cap or a failed batch cuts short records only what its own deletions freed.
- **Caches.** Index documents expire from the edge within two minutes (`max-age=60`,
  `stale-while-revalidate=60`). The immutable byte URLs of a pruned version (a tarball, a
  manifest by digest) can still be answered by a data centre whose Cache API already holds them,
  until that copy is evicted. The Worker cannot purge other data centres. A zone purge by URL
  would need a Cloudflare API token, which is a follow-up and not wired.
- **Backfill (dry run first).** For versions released before this existed, prune each package's
  builds of main below its newest stable release:

  ```sh
  # Dry run: prints, per package, what would go, with counts and bytes. Deletes nothing.
  PKEY_CI_TOKEN=<pkeyci_ token with release:yank> pkey feeds prune --product polaris-key
  # Then delete (audited per version under ci:<subject>):
  PKEY_CI_TOKEN=... pkey feeds prune --product polaris-key --apply
  ```

  Issue the token as a platform admin: `POST /manage/api/products/polaris-key/ci-tokens
{"scopes": ["release:yank"], "expiresInDays": 1}`. The token is shown once. Revoke it
  afterwards (`DELETE …/ci-tokens/<tokenId>`). The
  same backfill is in the console's Feeds API without a token: `POST
/manage/api/platform/feeds/prune {}` for a dry run, or `{"apply": true}` to delete (audited
  under `admin:<sub>`). One request deletes at most 200 versions and answers `"more": true` when
  some are left. `pkey feeds prune --apply` repeats the request on its own, lists any version it
  skipped, and exits non-zero when any version failed (run it again: a failed batch is left whole
  and retried); with the admin route, send it again. Use `/manage/api/products/<slug>/distribution/feeds/prune` for another
  product. `--deliverable <id>` (`"deliverable"`) limits it to one package.

- **Drift.** On a stable build the drift job also warns about builds of main at or below the
  release that a feed still lists (`::warning::`). It never fails the job. A warning means the
  automatic prune did not run or failed: check the audit for `package.prune.failed`, then run the
  backfill.

### Do not roll back across feed retention (0090)

A Worker older than feed retention (`0090_release_package_prune.sql`) has no tombstone check: its
ingest looks only at `release_packages` and `release_metadata`, which a prune deleted, so it would
accept a republish of a pruned version, possibly with different bytes under the same coordinates.
The schema change is additive, so the old code runs, but versions would stop being unique forever.
Do not roll the CODE back across it without re-checking: if you must, first confirm no publish
can reach the old Worker (pause the publish workflows), or check `release_package_prunes` for
every version published while it ran and yank any that reappeared. Rolling forward again restores
the check; the tombstones were never removed.

### Do not roll back past 0058_b with package rows

`0058_b_release_deliverables_kind.sql` rebuilds `release_deliverables` to admit `kind = 'package'`
(forward-only, like 0016). An older Worker reads and writes the table unchanged, so rolling the
CODE back is safe. Rolling the SCHEMA back past it (recreating the old `CHECK (kind IN ('app',
'pack'))`) needs the package rows gone first: `release_packages`, then the `release_metadata`,
`release_artifacts` and `blob_refs` rows of package releases, then the `release_deliverables` rows
of kind `package`. Package versions are meant to be unique forever, so do this only for an
environment that is being abandoned.

### Content keys (delegation, P4-19)

A content key may sign data-only pack releases (`files.tree`, `data.json`, `l10n.table`) of
compatible or standalone packs under one pack-id scope, inside a window of at most 366 days. The
grant is a CI-signed delegation; the Worker never holds either key. See
`/docs/services/release/packs/` for the full flow.

**Adoption rule.** Delegate only once every live app build you care about embeds a P4-19 SDK.
Older builds refuse delegated releases (safely: they keep what they run), so a required pack
whose only release is delegated stays missing on them.

**Delegate a content key.**

```sh
pkey release keys generate --content --out content.pem   # mode 0600; prints the public key
pkey release delegate --prefix <packId> --types files.tree,data.json \
  --public-key <b64url> [--expires-in <days>] [--notes "<team, year>"] [--dry-run]
```

Run `delegate` with `PKEY_RELEASE_KEY`, from the release workflow. Store the PEM as the content
team's GitHub Environment secret `PKEY_CONTENT_KEY`, and nowhere else; the content workflow then
publishes with `--delegation <sha256>`. If the submit fails after signing, the signed delegation
is in `./pkey-delegation-<sha256>.jws`: keep it, because it is what lets you revoke a delegation
the Worker never stored.

**Rotate or renew a content key.** One key maps to one delegation, so both are the same flow:
generate a new key, delegate it, re-publish what must survive under the new delegation, then
revoke the old delegation. Releases already installed under a delegation stay valid after its
window closes, so a renewal needs no re-publish of installed content; only new publishes need
the new window. The CLI warns within 14 days of a window's end.

**Revoke a delegation (re-publish first).**

```sh
pkey release revoke --delegation <sha256 | ./pkey-delegation-<sha256>.jws> --reason "<text>"
```

Revoking a delegation refuses every release signed under it on every device that learns it
(`pack-revoked`, detail `delegation`), and ingest yanks them. A **required** pack served by such
a release then blocks the boot (`revoked-content`) until a release under a new delegation
arrives, so re-publish first, then revoke — unless the key is actively abused, in which case
revoke at once. A revocation is permanent and takes no replacement. A delegation minted outside
CI (for example with a stolen release key) can be revoked only if you hold its JWS (pass the
file); otherwise rotate the pinned release keys.

**Revoke a leaked content key.** Treat a content key that leaked as actively abused: revoke its
delegation at once, from the release workflow (it needs `PKEY_RELEASE_KEY` and the publisher
token), then mint a new key and delegation and re-publish.

```sh
pkey release revoke --delegation <sha256> --reason "Content key leaked"
```

You need only the delegation's hash (`pkey release delegate` printed it; the console's Content
keys table and `POST …/release/publish/delegations` list every stored one). The CLI reads the
delegation's JWS from that authenticated route, so this works on a product whose release metadata
is not public. A delegation the Worker never stored needs its JWS file instead (see above).

**The tail sniff's chance match.** The data-only rule refuses a file whose last 65,557 bytes
contain `PK\x05\x06` (a zip end record). Compressed media (PNG, OGG, MP3) can hold those four
bytes by chance, about 1.5e-5 per file (65,557 positions × 2^-32). It fails closed: the CLI lint
reports the file by path before anything is signed. The remedy is to re-encode the file (any
change of the compressed bytes moves the match).

## Sign-in email (I-18)

Every sign-in and account email leaves ONE shared sender, `noreply@auth.plrs.im`, on the
dedicated auth sending subdomain `auth.plrs.im`, so its reputation is every product's (S-16 §9
risk 9). Platform mail is sent as `Polaris Key`; mail for sign-in started through a product as
`<App> via Polaris Key`, where `<App>` is the product's display name after the reserved-name
validator (`src/core/emailSender.ts`; a refused name falls back to the slug). Every send goes
through `deliverEmail` (`src/core/emailDelivery.ts`): binding, sender, Apple private relay, the
hashed suppression list, the per-product daily cap (passthrough mail only), then the send.
Throttling, quota, an unverified sender and provider outages answer `email_unavailable`; the
login card then offers another sign-in method.

Until the owner steps below are done the Worker keeps sending from `noreply@plrs.im`
(`EMAIL_SENDER_ADDRESS` unset in prod) and staging answers `email_unavailable`.

### Owner setup (DNS and Apple; agents never touch either)

1. **Onboard the subdomain on Email Sending.** Cloudflare dashboard → Compute → Email Service →
   Email Sending → Onboard Domain → `auth.plrs.im` → Add records and onboard (or
   `npx wrangler email sending enable auth.plrs.im`). Onboarding publishes, and locks:

   | Type | Name                                | Value                                                                                                             |
   | ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
   | MX   | `cf-bounce.auth.plrs.im`            | `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, `route3.mx.cloudflare.net` (priorities set by Cloudflare) |
   | TXT  | `cf-bounce.auth.plrs.im`            | `v=spf1 include:_spf.mx.cloudflare.net ~all`                                                                      |
   | TXT  | `cf-bounce._domainkey.auth.plrs.im` | `v=DKIM1; h=sha256; k=rsa; p=<public key Cloudflare generates>`                                                   |
   | TXT  | `_dmarc.auth.plrs.im`               | `v=DMARC1; p=reject;`                                                                                             |

   `npx wrangler email sending dns get auth.plrs.im` prints the exact values. Leave
   **Drop suppressed recipients** (Email Sending → `auth.plrs.im` → Settings) **off**, the
   default: with it on, Cloudflare drops a suppressed recipient silently and the Worker never
   learns to stop trying.

2. **Add one SPF record on the subdomain itself** (for Apple's sender check, step 4):

   | Type | Name           | Value                                        |
   | ---- | -------------- | -------------------------------------------- |
   | TXT  | `auth.plrs.im` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |

3. **Check the records:** `pnpm --filter @polaris-key/worker email:dns-check` must print
   `auth.plrs.im: aligned` (bounce MX, SPF on `cf-bounce.auth.plrs.im` with Cloudflare's include,
   the `cf-bounce` DKIM key, an enforcing DMARC policy that allows relaxed SPF alignment).
   `-- plrs.im` checks the apex the same way.
4. **Register the sender with Apple's private email relay.** developer.apple.com → Certificates,
   Identifiers & Profiles → Services → Sign in with Apple for Email Communication → Configure →
   add the domains `auth.plrs.im` and `cf-bounce.auth.plrs.im` and the address
   `noreply@auth.plrs.im`, then confirm Apple shows each domain as SPF-verified.
5. **Switch the Worker over** (one reviewed commit to `packages/worker/wrangler.toml`): in
   `[env.prod.vars]` uncomment `EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im"` and
   `EMAIL_APPLE_RELAY = "registered"`, add `EMAIL_APPLE_RELAY = "registered"` to
   `[env.staging.vars]`, and deploy staging first.
6. **Staging deliverability check.** On `key-staging.plrs.im` request a portal magic link to a
   Gmail address you control, then Gmail → Show original: `SPF: PASS` (domain
   `cf-bounce.auth.plrs.im`), `DKIM: PASS` (domain `auth.plrs.im`), `DMARC: PASS`, `From:
Polaris Key <noreply@auth.plrs.im>`. Repeat to a Hide-My-Email (`@privaterelay.appleid.com`)
   address of a test Apple account and confirm it arrives. Paste both Authentication-Results
   headers into the I-18 PR, then deploy prod.
7. **Quota.** `GET /accounts/<id>/email/sending/limits` gives the account's daily quota. The
   per-product default cap is 500 a day (`EMAIL_SEND_PRODUCT_DAILY_DEFAULT`); raise or lower it
   for the deployment with `EMAIL_PRODUCT_DAILY_CAP`, or per product (below).

### Operating it

- **A product is capped** (its users see "We can't send email right now"): its own cap is a row,
  `wrangler d1 execute polaris_key_prod --remote --command "INSERT INTO email_product_caps (product, daily_cap, modified_at) VALUES ('<slug>', <n>, unixepoch()) ON CONFLICT(product) DO UPDATE SET daily_cap = excluded.daily_cap, modified_at = excluded.modified_at"`.
  Delete the row to return to the deployment value. The day is a sliding 24 hours.
- **Suppression list** (`email_suppressions`): keyed by the peppered hash of the address, never
  the address. A hard bounce suppresses for 90 days, a complaint, a Cloudflare suppression
  (`E_RECIPIENT_SUPPRESSED`) or an operator entry permanently. A suppressed recipient is answered
  exactly like a sent one. To clear one, remove it from Cloudflare's list too (Email Sending →
  Suppressions) or the next send re-adds it.
- **Bounce and complaint events:** Cloudflare pushes none to a Worker. The Worker learns of them
  through `E_RECIPIENT_SUPPRESSED` on a later send; the dashboard's Analytics tab and the GraphQL
  `emailSendingAdaptive` dataset show the rest (delivery rate over 95 %, hard bounces under 2 %,
  complaints under 0.1 %).

## Login card (I-07)

The login card's Worker half needs two owner inputs per environment. Until they are set the card
works without them: no Turnstile token is asked for, and copied avatars use the `BLOBS` bucket
that already exists.

1. **Turnstile.** Cloudflare dashboard → Turnstile → Add widget, one per environment, hostname
   `key.plrs.im` (`key-staging.plrs.im`, `key-dev.plrs.im` for the others), mode Managed. Put the
   site key in `wrangler.toml` as the `TURNSTILE_SITE_KEY` var of that environment (it is public;
   the portal reads it from `GET /api/capabilities`), and the secret with
   `npx wrangler secret put TURNSTILE_SECRET_KEY --env <env>`. With the secret set, the email start
   refuses a missing or failing token (`403 turnstile_failed`), and an unreachable Cloudflare
   refuses too. The widget itself is rendered by the card's UI, which also needs Cloudflare's
   challenge origin in the portal's CSP (PX-12).

   > **Warning: do not set `TURNSTILE_SECRET_KEY` yet.** The secret, not the site key, is what
   > switches the check on, and the portal does not render the Turnstile widget until PX-12/PX-21
   > ship it. With the secret set today, the portal sends no token and **every email sign-in fails
   > with `403 turnstile_failed`**. Set the site key var if you like; put the secret only once the
   > widget is live in the portal.

   **Done (2026-10-06, by the lead through the Cloudflare API).** The three widgets exist, named
   `Polaris Key login card (prod|staging|dev)`, mode Managed, one hostname each, and their site keys
   are the `TURNSTILE_SITE_KEY` vars in `wrangler.toml`. No secret is set. To switch the check on
   once PX-12/PX-21 render the widget, copy each widget's secret straight into the Worker without it
   passing through a terminal or a file: one Cloudflare API call per environment that reads
   `GET /accounts/{account}/challenges/widgets/{sitekey}` and writes the returned `secret` with
   `PUT /accounts/{account}/workers/scripts/{script}/secrets` as `TURNSTILE_SECRET_KEY`
   (`type: secret_text`), returning nothing. Then test email sign-in on staging before prod.

2. **Avatars.** Copied provider pictures live in the environment's `BLOBS` bucket under the
   `avatars/` prefix; no extra binding or bucket is needed. To use a separate bucket instead, it
   would need a binding and a code change.

**Sessions after the deploy.** Account sessions became server-side rows (`account_sessions`); a
portal cookie signed before this deploy names no row and is refused, so every portal visitor signs
in once afterwards. There is nothing to migrate.

**A person locked out by the email limits** (10 wrong codes in an hour) gets no new code for 15
minutes and sees nothing different; waiting is the fix. The limits are in
`src/core/emailLimits.ts`.

## Login-card providers (I-06)

The login card offers Sign in with Google, Apple and Steam through Polaris's own clients, one set
per environment (`src/services/identity/providers/`). They are account sign-in methods for every
product; nothing is configured per product. A provider appears only once **all** of its values
are set and its sealed secret opens; until then `/login/<provider>` answers _Sign in with … is
not available_ and the rest of the card works as before.

| Environment | Origin                        | Google redirect URI / Apple return URL / Steam return   |
| ----------- | ----------------------------- | ------------------------------------------------------- |
| prod        | `https://key.plrs.im`         | `https://key.plrs.im/login/<provider>/callback`         |
| staging     | `https://key-staging.plrs.im` | `https://key-staging.plrs.im/login/<provider>/callback` |
| dev         | `https://key-dev.plrs.im`     | `https://key-dev.plrs.im/login/<provider>/callback`     |

### Owner setup (consoles and secrets; agents never touch either)

1. **Google OAuth client.** Google Cloud console → a Polaris Key project → Google Auth Platform:
   - **Branding:** app name `Polaris Key`, a support email, the logo, home page
     `https://key.plrs.im`, privacy policy URL, and the authorised domain `plrs.im`.
   - **Audience:** External, then **Publish app** (in testing, only listed test users can sign in).
   - **Data access:** the scopes `openid`, `.../auth/userinfo.email` and
     `.../auth/userinfo.profile` only (all non-sensitive; no verification review).
   - **Clients → Create client:** type _Web application_, name `Polaris Key login card (<env>)`,
     no JavaScript origins, **Authorised redirect URI** `https://<origin>/login/google/callback`
     (one client per environment, or one client listing every environment's URI). Copy the
     client id and the client secret (the secret is shown once).
2. **Apple Services ID and key** (developer.apple.com → Certificates, Identifiers & Profiles; the
   Account Holder or an Admin):
   - **Team ID:** Membership details, ten characters.
   - **Primary App ID:** Identifiers → + → App IDs → App, e.g. `im.plrs.key`, with the
     **Sign in with Apple** capability (_Enable as a primary App ID_). In its Sign in with Apple
     configuration set the **Server-to-Server Notification Endpoint** to
     `https://key.plrs.im/login/apple/notifications` (Apple allows one endpoint per App ID; use
     prod's).
   - **Services ID:** Identifiers → + → Services IDs, e.g. `im.plrs.key.signin` (this is
     `SIGNIN_APPLE_SERVICES_ID`, the card's `client_id`). Enable **Sign in with Apple** →
     Configure: primary App ID as above, **Domains and Subdomains** `key.plrs.im`,
     `key-staging.plrs.im`, `key-dev.plrs.im`, **Return URLs**
     `https://<origin>/login/apple/callback` for each. Save, then Continue → Register.
   - **Key:** Keys → + → name `Polaris Key Sign in with Apple`, tick **Sign in with Apple** →
     Configure → the primary App ID → Register. Download `AuthKey_<KEYID>.p8` (Apple offers it
     **once**) and note the Key ID (ten characters).
   - Apple's private relay delivers sign-in email only from registered senders: that is step 4 of
     "Sign-in email (I-18)" above.
3. **Steam Web API key.** Signed in to the Polaris Steam account (it needs Steam Guard and a
   purchase history), open `https://steamcommunity.com/dev/apikey`, enter the domain
   `key.plrs.im`, agree and register. One account holds one key; the domain is informational, so
   every environment may use the same key. Steam needs nothing else registered: the realm is the
   origin the card runs on.
4. **Seal the three secrets** with the TARGET environment's KEK in your shell (the same variable
   names the Worker reads: `PLATFORM_KEK`, or `PLATFORM_KEK_KEYS` + `PLATFORM_KEK_ACTIVE`). The
   script reads the plaintext from stdin, prints the blob, writes nothing and calls nothing:

   ```sh
   cd packages/worker
   PLATFORM_KEK=… pnpm signin:seal -- google < google-client-secret.txt
   PLATFORM_KEK=… pnpm signin:seal -- apple  < AuthKey_ABCDE12345.p8
   PLATFORM_KEK=… pnpm signin:seal -- steam  < steam-web-api-key.txt
   ```

   A blob sealed under another environment's KEK, or for another provider's slot, does not open,
   and that provider simply stays off.

5. **Set each provider in one bulk call** (a JSON object of name → value, deleted afterwards):

   ```json
   {
     "SIGNIN_GOOGLE_CLIENT_ID": "<id>.apps.googleusercontent.com",
     "SIGNIN_GOOGLE_CLIENT_SECRET": "<sealed blob>",
     "SIGNIN_APPLE_SERVICES_ID": "im.plrs.key.signin",
     "SIGNIN_APPLE_TEAM_ID": "<TEAMID>",
     "SIGNIN_APPLE_KEY_ID": "<KEYID>",
     "SIGNIN_APPLE_PRIVATE_KEY": "<sealed blob>",
     "SIGNIN_STEAM_WEB_API_KEY": "<sealed blob>"
   }
   ```

   `npx wrangler secret bulk signin.json --env staging`, then sign in with each provider on
   staging in a private window before doing the same for prod.

### Operating it

- **Rotating.** Google: add a second secret on the client, seal and set it, then disable the old
  one. Apple: create a new key, seal its `.p8`, set `SIGNIN_APPLE_KEY_ID` and
  `SIGNIN_APPLE_PRIVATE_KEY` together in one bulk call, then revoke the old key. Steam: revoke and
  re-register at the same page, then seal and set. Rotating `PLATFORM_KEK` means re-sealing these
  three as well as the D1 blobs.
- **Turning one off.** `wrangler secret delete SIGNIN_<…>_CLIENT_ID` (or Steam's key); people who
  signed in with it keep their account and use another method.
- **Apple notifications** (`consent-revoked`, `account-delete`, `email-disabled`,
  `email-enabled`) set or clear `account_links.provider_flag` and are audited on the account; they
  never delete a link. A 401 from the endpoint in the logs is a JWT that was not Apple's or not
  addressed to the Services ID.
- **Discovery.** Google's and Apple's discovery documents and keys are cached for an hour per
  isolate. A sign-in that answers _… sign-in is unavailable right now_ is the provider's endpoint
  failing, or answering with a host outside the allowlist (`providers/net.ts`).

## The blob collector (P4-14)

The nightly maintenance cron (`17 3 * * *`) runs Core's blob collector after the retention steps:
per live product it drops the refs no live pack release needs (and restores ones a live release
lacks), marks objects no product references, and deletes at most 1,000 objects a night that have
been unreferenced for the grace period **and** are older than the 180-day bucket lock. Failures
surface in the cron's aggregate error (`blobRefs:<slug>`, `blobMark`, `blobSweep`,
`blobGcLog`).

- **Stop it:** in the console, Platform → Settings → Blob collector → off
  (`PATCH /manage/api/platform/settings/BLOB_GC_MODE` with `{"value":"off","expectedVersion":N}`).
  No deploy: every isolate picks it up within 30 seconds, and the nightly tick reads it fresh.
  Nothing is deleted while it is off; turning it back on resumes where it stopped. For a stop no
  console session can undo, set `BLOB_GC_MODE = "off"` under the environment's `[vars]` and
  deploy: a deploy-time `off` is a hard off (A-13 `ceiling` precedence).
- **Grace period:** Platform → Settings → Blob collector grace period (`BLOB_GC_GRACE_DAYS`;
  default 30, a console value from 1 to 365 days). A console value wins over the `[vars]` value;
  "Revert" (`DELETE …/settings/BLOB_GC_GRACE_DAYS`) returns to it. The lock age, not the grace,
  bounds how soon anything goes.
- **Who changed it:** every console change is a `platform.setting.set` or
  `platform.setting.revert` row in Platform activity, with the value before and after.
- **Before trusting it on a product:** read the dry run, `GET /manage/api/products/<slug>/blob-gc`
  (the live pack releases, the refs the next tick drops, the earliest deletion date).
- **What happened:** `blob_gc_log` (one row per dropped or restored ref and per deleted object;
  `delete-failed` rows carry R2's refusal) and the product's audit (`core.blob_gc.refs_dropped`,
  `core.blob_gc.refs_restored`).
- **An R2 lock refusal** (`blobSweep: … object is locked`) means an object was attempted before
  its lock age: stop the collector and escalate. Never shorten or remove the bucket lock to make
  it pass.

## Lazy deltas (P4-17)

When install telemetry shows at least 25 devices (per product, configurable) moving between the
same two payloads of a container pack within 7 days without a delta, and the pack's record has no
CI delta from that base, the consumer Worker `polaris-key-deltas-<env>` encodes a level-9
`zstd-patch-from` delta in WebAssembly, verifies it, and stores it at
`deltas/<from>/<to>.zstd-patch-from` (or under `gated/`) with a `ready` row in
`release_lazy_deltas`. Pairs with a side over 32 MiB are refused as `over-worker-cap` (the
evidence for a Container tier, P4-17b). Setup is DEPLOYMENT §3 "Lazy deltas".

- **Turn it on.** In the console, Platform → Settings → Lazy deltas → on
  (`PATCH /manage/api/platform/settings/LAZY_DELTAS` with `{"value":"on","expectedVersion":N}`).
  No deploy: both scripts read the same `platform_settings` row (the request Worker within 30
  seconds, the consumer on its next message). It only takes effect while both TOML files carry
  `LAZY_DELTAS = "runtime"` (the committed value); `"off"` there is a deploy-time hard off. Then
  opt a product in:

  ```sh
  npx wrangler d1 execute polaris_key_<env> --env <env> --remote --command \
    "INSERT INTO lazy_delta_settings (product, enabled, updated_at) VALUES ('<slug>', 1, unixepoch())
     ON CONFLICT(product) DO UPDATE SET enabled = 1, updated_at = unixepoch()"
  ```

  `hot_devices` (default 25) and `daily_cap` (default 20 deltas a day) are optional columns of the
  same row.

- **Turn it off.** `enabled = 0` for one product (counting and generation stop at once), or the
  console's Lazy deltas switch for everything (within 30 seconds). For an off no console session
  can undo, set `LAZY_DELTAS = "off"` in both TOML files and deploy both. Stored deltas stay until
  they go cold.
- **The size cap.** `LAZY_DELTA_MAX_BYTES` in `wrangler.deltas.toml` (32 MiB) is the deploy-time
  value; Platform → Settings → Lazy delta size cap may only lower it (1 MiB to 32 MiB, the
  measured ceiling).
- **Withdraw the menu (P4-29).** The channel feed lists a product's `ready` lazy deltas in its
  `deltas` member, and the blob route and the payload URL serve them, only while both switches
  are on. Either switch withdraws the menu at the next feed request (the feed's `seq` moves) and
  stops serving the frames at once; a device holding an older feed gets a 404 for a listed delta
  and falls back to another strategy. No deploy is needed for the per-product switch. The audit
  log records `update.feed.deltas_trimmed` (the menu did not fully fit under the feed's
  65,536-byte cap) and `update.feed.deltas_omitted` (none fitted, or the menu read was unusable);
  both are informational.
- **What it did.** `release_lazy_deltas` (`ready`, `refused` with a reason, `cold`), the nightly
  aggregate in `delta_demand`, and the maintenance cron's `lazyDeltas:<slug>` step (failures
  surface in the cron's aggregate error). Refusals worth acting on: `over-worker-cap` (a pack
  above 32 MiB is hot: the case for P4-17b), `verify` (escalate: the encoder disagreed with
  itself).
- **Cold deltas.** A ready delta no device reported for 30 days is marked `cold` and loses its
  `lazy-delta` ref; the blob collector then reclaims it under its usual grace and lock rules. If
  devices come back to the pair, the sweep re-queues it.
- **The DLQ.** `pkey-deltas-dlq-<env>` has no consumer: messages that failed 3 times wait there
  and expire after 4 days. Alert on its depth (`npx wrangler queues info pkey-deltas-dlq-<env>`);
  a growing DLQ means the consumer is throwing (read its logs: `npx wrangler tail
polaris-key-deltas-<env>`).
- **Live checks after the first deploy** (notes/S-08 §8.6): one pair at the 32 MiB cap, watching
  the consumer's logs for Error 1102 or "exceeded resource limits"; the consumer's reported CPU
  ms; the R2 event-to-consumer latency; and a re-PUT of the same object producing one delta.

## CI gates

`.github/workflows/ci.yml` runs on PRs and `main` pushes:

- JS/TS build, typecheck, tests, lint.
- Conformance corpus drift check with `pnpm gen:corpus -- --check`.
- Admin build.
- Python SDK tests on Ubuntu and macOS.
- Swift SDK tests on macOS.

A red conformance job means the wire contract changed without regenerating and committing
the corpus.

`.github/workflows/registry-clients.yml` runs on PRs that touch the registry host, the
Distribution registry module, the harness, `wrangler.toml` or the CLI's package publishing,
and on demand. Each job stands up a seeded local Worker (`wrangler dev --env test`) and runs one
real client against the registry host; run the same locally with
`pnpm --filter @polaris-key/worker registry:clients -- --client curl`. Make it a required check
for those paths in branch protection.

## Troubleshooting

Admin login fails before redirect:

- Check `ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_CLIENT_ID` and `ADMIN_OIDC_CLIENT_SECRET`, or, while
  they are unset (Platform → Settings warns), the `PLATFORM_OIDC_*` trio.
- Confirm the PocketID client the console is using allows `https://key.plrs.im/manage/callback`.

Admin login succeeds but access is denied:

- Confirm the ID token includes a string-array `groups` claim.
- Confirm your PocketID user belongs to `admins`.
- Confirm `PLATFORM_ADMIN_GROUP=admins`.

Portal magic links are hidden:

- Confirm at least one product has portal and magic links enabled.
- Confirm prod deployed with the `EMAIL` send binding.
- Confirm Cloudflare Email Service allows the sender (`EMAIL_SENDER_ADDRESS`, else
  `noreply@plrs.im`); "Sign-in email (I-18)" above has the setup and the DNS check.

DJDL OIDC activation fails with `platform oidc is not configured`:

- Check `PLATFORM_OIDC_ISSUER` and `PLATFORM_OIDC_CLIENT_ID`.

Custom-product OIDC activation fails with `oidc client secret unavailable`:

- Set the product secret named by that product's `oidc.clientSecretSecret`.

Repo-link or release sync cannot access GitHub:

- Confirm GitHub App `polaris-key` is installed on the product repo.
- Confirm Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
  `GITHUB_WEBHOOK_SECRET`.
- Confirm the app has Contents: read and Actions: read.

Every product route 404s at once (JWKS, `/config`, `/activate`, appcast), with nothing in the
admin broken:

- This is the KEK failure signature. `loadProduct` swallows a sealed-value error and returns
  `null`, so a product whose signing key cannot be opened looks exactly like a product that
  does not exist.
- `curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…"`:
  - `503` — the keyring itself does not parse; the message names the offending variable.
  - `unopenable > 0` — a KEK was removed from `PLATFORM_KEK_KEYS` while rows were still sealed
    under it. Put that kid back, then run the sweep (Secrets → Rotating PLATFORM_KEK, step 6).
- Check whether `PLATFORM_KEK_ID` was set or changed. It renames the kid, which orphans every
  existing blob; unset it, or add the old kid to `PLATFORM_KEK_KEYS` instead.
- Check whether a `wrangler rollback` restored a pre-rotation keyring.

Deploy fails on bindings:

- Confirm `REPLACE_ME_PROD_D1_ID` and `REPLACE_ME_PROD_KV_ID` in
  `packages/worker/wrangler.toml` have been replaced with real Cloudflare IDs.
