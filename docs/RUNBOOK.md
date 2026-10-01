# Polaris Key operations runbook

This runbook is for operating an already deployed Polaris Key production service at
`https://key.plrs.im`.

For first-time production bootstrap, external provider setup, secret loading, CI setup, and
DJDL onboarding, use [DEPLOYMENT.md](./DEPLOYMENT.md).

## Production shape

| Item                 | Value                                          |
| -------------------- | ---------------------------------------------- |
| Cloudflare account   | `Polaris` / `07a2eb0d4916b220da1f9c1387b5f6d8` |
| Worker env           | `prod`                                         |
| Public origin        | `https://key.plrs.im`                          |
| Admin                | `https://key.plrs.im/manage`                   |
| Customer portal      | `https://key.plrs.im`                          |
| D1 database          | `polaris_key_prod`                             |
| KV namespace         | `POLARIS_HOT_prod`                             |
| PocketID issuer      | `https://id.plrs.im`                           |
| Platform admin group | `admins`                                       |
| GitHub App           | `polaris-key`                                  |
| Email sender         | `Polaris Key <noreply@plrs.im>`                |

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
npx wrangler deploy --env prod
```

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
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
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
  - `EDGE_MINT__DJDL__APPLEMUSIC`

Product validation:

```sh
curl -fsS https://key.plrs.im/djdl/.well-known/polaris.json | jq .
curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
curl -fsS https://key.plrs.im/djdl/config/schema | jq .
curl -fsS https://key.plrs.im/djdl/appcast.xml >/dev/null
```

Use the Releases view to inspect GitHub sync status, changed `.pkey/` paths, manifest
validation errors, and release health. Use manual resync there when a webhook was missed.

## CI gates

`.github/workflows/ci.yml` runs on PRs and `main` pushes:

- JS/TS build, typecheck, tests, lint.
- Conformance corpus drift check with `pnpm gen:corpus -- --check`.
- Admin build.
- Python SDK tests on Ubuntu and macOS.
- Swift SDK tests on macOS.

A red conformance job means the wire contract changed without regenerating and committing
the corpus.

## Troubleshooting

Admin login fails before redirect:

- Check `PLATFORM_OIDC_ISSUER`, `PLATFORM_OIDC_CLIENT_ID`, and
  `PLATFORM_OIDC_CLIENT_SECRET`.
- Confirm the PocketID platform client allows `https://key.plrs.im/manage/callback`.

Admin login succeeds but access is denied:

- Confirm the ID token includes a string-array `groups` claim.
- Confirm your PocketID user belongs to `admins`.
- Confirm `PLATFORM_ADMIN_GROUP=admins`.

Portal magic links are hidden:

- Confirm at least one product has portal and magic links enabled.
- Confirm prod deployed with the `EMAIL` send binding.
- Confirm Cloudflare Email Service allows `noreply@plrs.im`.

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
