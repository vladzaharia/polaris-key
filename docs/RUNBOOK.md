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
  the version: a package version is never published again.
- **Publish:** CI runs `pkey release publish --deliverable <package id>`, which always dry-runs
  first; a Worker older than F-03 is reported as such and nothing is uploaded.

### Do not roll back past 0056_b with package rows

`0056_b_release_deliverables_kind.sql` rebuilds `release_deliverables` to admit `kind = 'package'`
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

## The blob collector (P4-14)

The nightly maintenance cron (`17 3 * * *`) runs Core's blob collector after the retention steps:
per live product it drops the refs no live pack release needs (and restores ones a live release
lacks), marks objects no product references, and deletes at most 1,000 objects a night that have
been unreferenced for the grace period **and** are older than the 180-day bucket lock. Failures
surface in the cron's aggregate error (`blobRefs:<slug>`, `blobMark`, `blobSweep`,
`blobGcLog`).

- **Stop it:** set `BLOB_GC_MODE = "off"` under the environment's `[vars]` and deploy. Nothing is
  deleted while it is off; turning it back on resumes where it stopped.
- **Grace period:** `BLOB_GC_GRACE_DAYS` (default 30, never under 1). The lock age, not the grace,
  bounds how soon anything goes.
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

- **Turn it on.** `LAZY_DELTAS = "on"` in both `wrangler.toml` and `wrangler.deltas.toml` for the
  environment, deploy both, then opt a product in:

  ```sh
  npx wrangler d1 execute polaris_key_<env> --env <env> --remote --command \
    "INSERT INTO lazy_delta_settings (product, enabled, updated_at) VALUES ('<slug>', 1, unixepoch())
     ON CONFLICT(product) DO UPDATE SET enabled = 1, updated_at = unixepoch()"
  ```

  `hot_devices` (default 25) and `daily_cap` (default 20 deltas a day) are optional columns of the
  same row.

- **Turn it off.** `enabled = 0` for one product (counting and generation stop at once), or
  `LAZY_DELTAS = "off"` and deploy for everything. Stored deltas stay until they go cold.
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
