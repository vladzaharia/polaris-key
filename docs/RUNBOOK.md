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
| Email sender         | `Polaris Key <noreply@auth.plrs.im>`           |

Reserved platform routes:

- `/manage/*` - admin SPA, admin OIDC, and admin JSON API.
- `/docs/*` - the documentation site, gated by tier (public, console member or platform admin,
  by directory).
- `/api/*`, `/login`, `/callback`, `/logout`, `/magic/verify`, `/download/*` - customer
  portal.
- `/assets/*` - the customer portal SPA's static assets.
- `/webhooks/github` - signed GitHub App push webhooks.
- `/<product>/*` - product-scoped licensing, config, OIDC activation, releases, and JWKS.

## Deploy

Manual deploy:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
# The Worker's [assets] root (packages/worker/assets) is gitignored: it is assembled from the
# built admin and docs sites, and `wrangler deploy` aborts without it.
pnpm --filter @polaris-key/worker assemble
cd packages/worker
npx wrangler d1 migrations apply polaris_key_prod --env prod --remote
# Re-assert the required indexes. The assertion migration runs once per database, so this is
# what turns a vanished index into a failed deploy. Always the NEWEST *_index_assertion.sql:
# each one replaces the full list, so an older file would shorten what is checked.
ASSERTION="$(ls migrations/*_index_assertion.sql | sort | tail -1)"
npx wrangler d1 execute polaris_key_prod --env prod --remote --file "$ASSERTION"
pnpm check:representable          # see "Representability check" below; must report clean
npx wrangler deploy --env prod
```

### Representability check

The Worker refuses to sign a document a wire-v4 verifier would refuse (a lone surrogate,
U+0000 in a member name, two member names equal after NFC normalization, a number outside
1e-307 to 1e308, more than 32 levels of nesting, or an integer claim that is not a safe
integer), and its write paths refuse such values at write. Values stored before those checks
existed are still in D1. One that trips the signer is pruned from the config document or
turns that product's license documents into `500 document_not_representable`, for v3 clients
too.

**Before the first production deploy of a Worker that includes the representability check** (manual, or the `v*`
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
more, below about −20 000 days, or not a number), because every license and config document
that uses it then answers `500 document_not_representable`. Fix every flagged value in the
console (license, tier, profile or product editors) or in the product's `.pkey/` manifest and
resync, then run the check again until it exits 0. Do not deploy while it flags anything.
`warning` lines do not block a deploy. They are any other offline-day count that is not an
integer from 1 to 365, which the builders floor and sign, and a JSON column that does not
parse, which the Worker ignores. Sealed secrets cannot be opened by the check; a flagged one
is dropped from the config document at signing.

The manifest validator does not yet bound `licensing.defaultMaxOfflineDays`, so a resync can still store a product default the check flags. Until that rule
lands, run the check again after a resync that changes the default.

`--local [--persist-to DIR]` runs the same check against a local D1 (miniflare), which is how
`packages/worker/test/core/checkRepresentable.test.ts` exercises it.

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

Launch gates: each v0.10.0 feature has a platform setting (`launch.identityExchange`,
`launch.connect`, `launch.syncE2e`, `launch.relay`; Platform → Settings) that ships off. A gate is
on in staging and dev through `[vars]`. Turn one on in production only after the feature's
security sign-off. An off gate answers as the build did before the feature existed.

## Secrets

Required prod Worker secrets:

```text
KEY_HASH_PEPPER
ADMIN_SESSION_SECRET
PORTAL_SESSION_SECRET
PLATFORM_KEK                 # or the keyring pair below; both only mid-rotation ("Rotating when the old KEK is unknown")
PLATFORM_ADMIN_GROUP=admins
PLATFORM_OIDC_ISSUER=https://id.plrs.im
PLATFORM_OIDC_CLIENT_ID
PLATFORM_OIDC_CLIENT_SECRET
ADMIN_OIDC_ISSUER=https://id.plrs.im   # the console's own client
ADMIN_OIDC_CLIENT_ID
ADMIN_OIDC_CLIENT_SECRET
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
REGISTRY_TOKEN_KEY           # the OCI pull-token HMAC key (32 random bytes, base64)
DOWNLOAD_TICKET_KEY          # the portal's download-ticket HMAC key (32 random bytes, base64)
SIGNIN_*                     # optional: the login card's providers ("Login-card providers")
```

Rotate or set a Worker secret:

```sh
cd packages/worker
npx wrangler secret put <NAME> --env prod
```

`KEY_HASH_PEPPER` is not rotated with that command. A new pepper cannot find any console sign-out
mark, so signed-out admin cookies work again until they expire. It changes only together with a
new `ADMIN_SESSION_SECRET`, in one `wrangler secret bulk` ("Compromised `KEY_HASH_PEPPER`").

`PLATFORM_KEK` protects sealed product signing keys and product secrets in D1. It is the only
secret whose misconfiguration is **silent**: every `open()` throws, `loadProduct` returns
`null`, and every product route serves **404 with no log line** — an outage indistinguishable
from "someone deleted all the products". Read the rotation procedure below before touching it.

Product secrets are not Worker secrets. Set them through the admin UI/API so they are sealed
into `product_secrets`; values are write-only and never echoed back.

### The console's Pocket ID client

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

### Who can use the console, and lockout recovery

Every console route checks one rule, `can()`, against the member's roles (Superadmin, Platform
admin, Product admin, Console access). A role comes from a binding someone with the Members area
gave, from an **SSO rule**, or from the **root rule**: membership of `PLATFORM_ADMIN_GROUP` at the
console's identity provider makes the person a Superadmin. The root rule is read from the session on every request and stored nowhere, so it
cannot be revoked from the console or lost to a bad write. SSO rules (**Platform → Members → SSO
rules**, the `console.access` setting) are written by a Superadmin only, with a step-up, and grant
at most Product admin or Console access, never Superadmin or Platform admin.

- **The sign-in card.** `GET /manage/login` serves the Polaris Key Console card and starts no
  flow; the redirect to the IdP starts when the person presses Continue (`?go=1`), with the typed
  email as the IdP's `login_hint`. `?signedOut=1`, `?ended=1` and `?stepUp=1` pick the card's
  copy only. Scripts and tests that need the redirect request `/manage/login?go=1`.
- **Locked out.** Add the person to `PLATFORM_ADMIN_GROUP` in Pocket ID (the console client's
  provider, above) and have them sign in again at `/manage`. Their next sign-in carries the group.
  Nothing in D1 needs to change.
- **Locked out through an SSO rule.** A rule that admits the wrong people, or stops admitting the
  right ones, is a Superadmin's edit in **Members → SSO rules** (a step-up, the typed
  `console.access` and a reason). If no Superadmin can sign in, use the root rule above: it does not
  depend on any rule. A rule's grant is checked on every request and ends at the person's next
  sign-in, or after 8 hours, once the IdP drops the group or the connection is disabled. To end
  every rule at once, a Superadmin clears the list. The rules sit in `platform_settings`
  (`console.access`); no migration or manual SQL is needed.
- **Removing someone.** Take them out of the group. Their console session keeps its role until it
  ends (8 hours at most) unless they sign out; `wrangler secret put ADMIN_SESSION_SECRET --env
<env>` ends every console session at once.
- **Revoking admin tokens.** A person may also hold `admin`-scope personal tokens (from `pkey login`).
  Taking them out of the group does not end those tokens; their roles are re-read on each use, but
  until then they work. Revoke the person's admin tokens: in the console, **Platform → Members**, the
  row menu, **Sign out everywhere**, which ends them at once with the person's sessions.
- **Checking.** `GET /manage/api/me` answers `permissions`: the roles and the areas the session
  holds. A session without the group is refused every route with
  `{"error":{"code":"forbidden","reason":"no_access","area":"console"}}`.
- **If `PLATFORM_ADMIN_GROUP` is unset or empty,** no one is a Superadmin and no one can sign in to
  the console (it fails closed). Set it and redeploy.

### Moving end users off the platform IdP

End users of `provider: platform` products, and customers who use **Continue with single sign-on**
on the portal, still sign in through Pocket ID. They move to their Polaris Key account by **claim
at next sign-in**: each sign-in through the platform client lands the Pocket ID subject on an
account and keeps it there as a temporary sign-in method (`oidc:https://id.plrs.im`). Pocket ID
then holds operators only (THREAT-MODEL "Moving end users off the platform IdP"). There is no bulk
export: Pocket ID's users endpoint needs an admin API key, and none is needed for this.

Two deploy-time vars control it. Neither is a console setting, so each step below is a reviewed
change to `packages/worker/wrangler.toml` (`[env.<env>.vars]`) and a deploy.

| Var                       | Values                                   | Unset means                                          |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `PLATFORM_OIDC_MIGRATION` | `off`, `claim`, `operators-only`         | `off`: every sign-in exactly as before the migration |
| `PLATFORM_OIDC_SUNSET`    | a UTC day, `YYYY-MM-DD` (from 00:00 UTC) | no sunset: the temporary method keeps working        |

- **`claim`.** A subject that already has a method signs in to its account. Otherwise, if no
  account uses the address Pocket ID verified (`email_verified`), a new account gets it as its
  primary email and an email sign-in method. If one account uses it, nothing is written: the
  portal opens the email step's join offer (its gate), which joins only after the person signs
  in to that account in the same browser and confirms. An app's sign-in page links to the portal
  for it. If two or more accounts use it, nothing is written or offered. A subject with no
  verified email gets an account whose only method is the temporary one. The licenses its
  sign-ins created attach to the account (platform products only, first attach only).
- **One browser.** `/login` binds the single sign-on flow to the browser that started it
  (`__Host-pkey_sso`, ten minutes); a `/callback` opened anywhere else is refused with _We couldn't
  confirm that sign-in_, in every mode. Someone who switches browsers mid-sign-in starts again.
- **`operators-only`.** Only subjects that already moved still sign in through Pocket ID. Anyone
  else sees _This way of signing in has ended_. Until `provider: platform` apps move to the
  login card, that includes new users of those apps, so turn it on only after they have moved, or
  accept that.
- **The sunset.** In `claim` or `operators-only`, from 00:00 UTC on that day nobody signs in
  through the platform client: the portal hides **Continue with single sign-on**, `/login`
  refuses, and both callbacks refuse before exchanging the code. While the mode is `off` it is
  ignored. A value that is not a real day reads as unset (the report shows `sunsetInvalid`); so
  does an unrecognised mode as `off` (`modeUnrecognised`).
- **The count.** `GET https://key.plrs.im/manage/api/platform/identity-migration`, opened in a
  browser signed in to the console (platform admins only). It answers counts only:

  ```text
  mode, sunset, ended, modeUnrecognised, sunsetInvalid, consoleClientDedicated
  linked.subjects          moved subjects (the temporary method on an active account)
  linked.withOtherMethod   ... with another way in: they keep access after the sunset
  linked.onlyMethod        ... whose only way in is the temporary method
  linked.onlyMethodRecent  ... of those, signed in through Pocket ID in the last 90 days
  unlinked.subjects        subjects seen only on licenses (licenses.sub) and not moved yet
  unlinked.onAccount       ... with a license already on an account (that account is the way in)
  unlinked.withEmail       ... whose floating license names an email (it attaches when that
                               address signs up)
  unlinked.emailLess       ... with nothing to go on
  emailLess                linked.onlyMethod + unlinked.emailLess: who loses sign-in at the sunset
  ```

**Before the owner's go.**

1. Deploy a build that has the migration and both vars unset. Read the count once; it works with the mode off.
2. In Pocket ID, confirm that users cannot change their own email address, or that a changed
   address is not reported as verified until it is. The move trusts `email_verified`.
3. Prefer to wait for the email step's UI in the portal. Until it ships, a person whose address another
   account already uses is sent to the sign-in card and signs in to that account as before; the
   join itself needs that UI.

**The rollout (owner go/no-go at each step; record it in the table below).**

1. **Staging.** Set `PLATFORM_OIDC_MIGRATION = "claim"` in `[env.staging.vars]`, deploy, sign in
   to a `provider: platform` product with a test Pocket ID user, and check the report shows
   `mode: "claim"` and one more `linked.subjects`.
2. **Production, `claim`.** The same change in `[env.prod.vars]`. Read the report weekly:
   `linked` grows as people sign in, `unlinked` shrinks.
3. **The sunset date.** Set only after the owner has read `emailLess` (the date follows the count). Give the people in `linked.onlyMethod` time to add an email address in the
   portal (Account → Sign-in methods; a passkey needs a verified email first); announce
   the date. Then set `PLATFORM_OIDC_SUNSET`.
4. **`operators-only`.** Once new people should no longer arrive through Pocket ID (after every `provider: platform` app has moved to the login card).
5. **After the sunset.** In Pocket ID, remove the end-user accounts, keeping the operators in the
   `admins` group. Once `consoleClientDedicated` is `true` (the console's own client is set) and every `provider: platform` app has moved to the login card, the platform client can be
   deleted in Pocket ID and the `PLATFORM_OIDC_*` secrets removed. Pocket ID is then
   operator-only.

**Rolling back.** Set `PLATFORM_OIDC_MIGRATION = "off"` (or remove it) and deploy: every sign-in
behaves as before the migration. Accounts and methods the claim made stay; they are ordinary accounts, and
like every account one with no sign-in and no license for 36 months gets the warning email and is
then deleted. Removing `PLATFORM_OIDC_SUNSET`, or moving it later, reopens the platform
client to the people it had ended.

The owner signs off each step; the lead records the date and value here in the change that makes it.

| Owner decision                                    | Date    | Value   |
| ------------------------------------------------- | ------- | ------- |
| Pocket ID `email_verified` precondition confirmed | pending | pending |
| Go for `claim` on staging                         | pending | pending |
| Go for `claim` on production                      | pending | pending |
| Email-less count read (`emailLess`)               | pending | pending |
| Sunset date (`PLATFORM_OIDC_SUNSET`)              | pending | pending |
| Go for `operators-only`                           | pending | pending |
| End users removed from Pocket ID                  | pending | pending |

### Platform store connections

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
second one can be rotated. Both at once is the rotation path for a key nobody holds: the
legacy `PLATFORM_KEK` stays in the ring for opening only ("Rotating when the old KEK is
unknown", below).

| Variable              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PLATFORM_KEK`        | Legacy single KEK: base64 of exactly 32 random bytes. On its own it is the whole ring. Beside `PLATFORM_KEK_KEYS` it is the **legacy key**: open-only, under the kid `PLATFORM_KEK_ID` names (default `default`), never sealed under, and deleted once nothing is sealed under it.                                                                                                                                                                                       |
| `PLATFORM_KEK_ID`     | **Optional, and a loaded gun.** The kid stamped into blobs sealed under `PLATFORM_KEK`. Defaults to `default`, which is the kid every existing production blob carries. Setting or changing it on its own renames both the kid new writes use **and** the only kid that can be read — i.e. it instantly makes every stored blob unopenable. Beside `PLATFORM_KEK_KEYS` it still names the legacy key's kid. It exists for continuity; **do not use it to rotate a KEK.** |
| `PLATFORM_KEK_KEYS`   | The keyring: a JSON object of `kid -> base64 KEK`, e.g. `{"k1":"…","k2":"…"}`. **Every** kid listed can be decrypted.                                                                                                                                                                                                                                                                                                                                                    |
| `PLATFORM_KEK_ACTIVE` | The kid within `PLATFORM_KEK_KEYS` that **new** seals are written under. Must be a key of that map.                                                                                                                                                                                                                                                                                                                                                                      |

Rules the Worker enforces (all fail closed — a bad keyring never falls back to a good one):

- Every KEK must decode to exactly 32 bytes.
- `PLATFORM_KEK_ACTIVE` must name an entry of `PLATFORM_KEK_KEYS`.
- When `PLATFORM_KEK_KEYS` is set, a `PLATFORM_KEK` still set beside it joins the ring as the
  legacy key, **open-only**, under its legacy kid (`PLATFORM_KEK_ID`, else `default`). It is
  imported without the right to encrypt, so nothing is ever sealed with it. While
  `PLATFORM_KEK_KEYS` has no entry under that kid, `PLATFORM_KEK_ACTIVE` naming it fails closed.
  When `PLATFORM_KEK_KEYS` does hold it with the same bytes (next rule), `PLATFORM_KEK` is a
  redundant copy, and that entry can be active like any other.
- A kid you leave out of the map is a kid you can no longer read, **except** the legacy kid while
  `PLATFORM_KEK` is still set: it stays open-only through `PLATFORM_KEK`. So retiring the legacy
  kid from `PLATFORM_KEK_KEYS` and deleting `PLATFORM_KEK` happen in one call (step 8 below).
- If `PLATFORM_KEK_KEYS` and `PLATFORM_KEK` define the **same kid with different bytes**, the
  keyring refuses to load rather than pick one. The same bytes under the same kid are fine.
- A sealed blob is opened with the KEK its own `kekId` names. An unknown `kekId` is refused; no
  other key is ever tried.

Check the live state at any time (platform admin):

```sh
curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" | jq .
# { "active": "k2", "kids": ["k1","k2"],
#   "counts": { "keys": {"k1":3,"k2":12}, "secrets": {"k1":1}, "outletCredentials": {"k2":1},
#               "managed": {"k1":2} },
#   "remaining": 6,          ← sealed values not yet re-sealed under the active kid
#   "unopenable": 0,         ← values under a kid the ring does NOT hold: these are DARK right now
#   "countsComplete": true,  ← false ⇒ the numbers above are FLOORS, not totals (see below)
#   "countsTruncated": [] }  ← the tables whose scan was cut short
```

`countsComplete` is the one field to read before acting on `remaining`. The `managed` bucket is
counted by parsing payload rows, so that pass reads at most 500 rows per table
(`MANAGED_SCAN_ROWS` in `console/handlers/products.ts`). A row counts toward the cap whenever it
carries an envelope, already re-sealed or not, so sweeping never shrinks it. If a deployment ever
exceeds the cap, `countsComplete` goes `false`, `countsTruncated` names the tables (`profiles`,
`licenses`, `account_overrides`), and `remaining` is reported as a floor that can never be 0 (the
same floor keeps `legacy.safeToDelete` `false`). **A `false` here means the rotation gate in step
8 cannot be evaluated from this endpoint at all.** Do not drop the old key on it: keep the old
key in the ring and raise `MANAGED_SCAN_ROWS` (a deploy) so one scan covers the table.

While `PLATFORM_KEK` sits beside `PLATFORM_KEK_KEYS`, the answer also carries `legacy` (it is
absent in either single shape):

```jsonc
"legacy": {
  "kid": "default",         // the legacy key's kid
  "openOnly": true,         // false: PLATFORM_KEK_KEYS holds the same key under this kid
  "remaining": 4,           // stored values still sealed under it (every bucket below)
  "workerSecrets": [],      // sealed Worker secrets (SIGNIN_*) still under it: the sweep cannot move these
  "safeToDelete": false     // true once remaining is 0 and workerSecrets is empty, and always true
                            // while openOnly is false (PLATFORM_KEK is a same-bytes copy of a
                            // PLATFORM_KEK_KEYS entry)
}
```

Platform → Settings → Keyring shows the same: the legacy kid marked _Legacy, open only_, what
is still under it, and _Safe to delete PLATFORM_KEK_ once nothing is.

Five classes of value are covered, and all five are counted and swept together:

| `counts` bucket       | Where it lives                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `keys`                | `product_keys.enc_private_json` — per-product signing keys                                                                             |
| `secrets`             | `product_secrets.enc_value_json` — per-product secrets                                                                                 |
| `outletCredentials`   | `outlet_credentials.enc_value_json` — store credentials (App Store Connect, Google Play, Partner Center)                               |
| `managed`             | catalog-declared managed secrets sealed inside `profiles.payload_json`, `licenses.overrides_json` and `account_overrides.payload_json` |
| `platformCredentials` | `platform_credentials.enc_value_json` — team store credentials stored in the console                                                   |

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
   # expect: remaining 0, unopenable 0, countsComplete true
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
     one per `profiles` / `licenses` / `account_overrides` row (a payload row may carry several managed secrets, all
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
   # counts must show ZERO rows under any kid other than the active one,
   # AND "countsComplete": true — otherwise the count stopped early and proves nothing
   ```

7. Soak for **24 hours** with both keys in the ring. Nothing should reference the old kid.

8. **Drop the old key and delete `PLATFORM_KEK` in the same call.** Only after `remaining` is 0
   **and** `countsComplete` is `true`. Both, not either: `remaining: 0` from a truncated scan
   would be a count that stopped rather than a rotation that finished, and a key dropped while
   values are still sealed under it is unrecoverable data. (The endpoint will not emit that
   combination, because `remaining` is floored above 0 whenever `countsComplete` is `false`, but
   check the flag, not the absence of a bug.)
   `"PLATFORM_KEK": null` makes `wrangler secret bulk` delete that secret in the same new
   version. It must not be left for later: while `PLATFORM_KEK` is set, the Worker keeps the key
   it holds in the ring as the legacy key, open-only, under its legacy kid (`PLATFORM_KEK_ID`,
   else `default`), even after that kid leaves `PLATFORM_KEK_KEYS`. A drop made too early would then still read
   `unopenable: 0`, and the later delete would turn off everything still under the old kid. Leave
   out the `PLATFORM_KEK` line only if Platform → Settings → Secrets shows `PLATFORM_KEK` as not
   set.

   ```jsonc
   // /tmp/kek.json — delete immediately afterwards
   {
     "PLATFORM_KEK_KEYS": "{\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "k2",
     "PLATFORM_KEK": null,
   }
   ```

   ```sh
   curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" \
     | jq -e '.remaining == 0 and .unopenable == 0 and .countsComplete == true' \
     && npx wrangler secret bulk /tmp/kek.json --env prod; rm -f /tmp/kek.json
   ```

   The bulk call runs only if the check prints `true`; a failed request, any value still under
   the old kid, or a count that stopped early (`countsComplete` false) stops it. Then re-check at
   once:

   ```sh
   curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" \
     | jq '{active, kids, remaining, unopenable, countsComplete, legacy}'
   # "kids": ["k2"], "remaining": 0, "unopenable": 0, "countsComplete": true, and no "legacy"
   ```

   - `unopenable` above 0: the old key left too early. Put it back at once (step 5's call, which
     needs only the escrowed old key), then return to step 6.
   - `legacy` present: `PLATFORM_KEK` is still set, and the `kek_legacy_open_only` warning is on
     Platform → Settings. Delete it only once `legacy.safeToDelete` is `true`, then re-check
     `unopenable`:

     ```sh
     curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…" \
       | jq -e '.legacy.safeToDelete == true' \
       && npx wrangler secret delete PLATFORM_KEK --env prod
     ```

     If it is `false`, run step 6's sweep until it is `true`: the legacy key still opens what is
     under it, so the sweep can move those values.

9. Update the escrowed copy of the KEK and destroy the old key material.

**Rollback:** at any point before step 8, set `PLATFORM_KEK_ACTIVE` back to the previous kid
while keeping **both** keys in `PLATFORM_KEK_KEYS`. Rows already re-sealed under the new kid
still open, because the ring still holds it. After step 8 only the escrowed old key can bring
back a value it left dark (step 8's first bullet). After step 9 there is no rollback at all.
Step 7 is there so you never need one.

**Do not use `wrangler rollback` as a secret rollback.** A Worker version captures its
bindings, and secrets are bindings; treat a rollback to a pre-rotation version as restoring the
secret values that version held. That conclusion follows Cloudflare's version model, so re-apply
every secret rotated after the target version immediately after any rollback and verify the
behavior below. A forward fix (deploying the known-good code as a new version) is safer because
it retains the current secrets. For this KEK specifically, an old keyring cannot open rows already
re-sealed under the new kid, so affected product routes return 404. See "Key compromise" below.

**KEK compromise (containment).** The leak is exploited offline against a D1 dump, so there is
nothing to block at the edge; the only response is to re-key. Run steps 1-8 immediately — the
platform stays up throughout, which is the whole point of the keyring. Rotating the KEK does
not invalidate anything an attacker already decrypted: treat every product signing key that was
sealed under the leaked KEK as compromised and rotate those too (Product operations → keys
prepare/activate/revoke), and re-enter every product secret.

Containment is not complete until `PLATFORM_KEK` is deleted. If `PLATFORM_KEK` holds the leaked
key, it stays in the ring for opening under its legacy kid even after step 8 drops that kid from
`PLATFORM_KEK_KEYS`, so anyone who holds the leaked key and can write to D1 could plant a value
the Worker still opens. Step 8's `"PLATFORM_KEK": null` deletes it. Confirm `legacy` is absent
from `GET /manage/api/products/kek` afterwards; while it is present, the leaked key still opens.
If you do not hold the leaked key yourself (it was never escrowed), contain with "Rotating when
the old KEK is unknown" below instead: containment ends at its step 6, which deletes
`PLATFORM_KEK`, so run its steps without pause.

### Rotating when the old KEK is unknown

Worker secrets are write-only, so an environment whose current `PLATFORM_KEK` was never copied
off-platform cannot follow the procedure above: its step 3 needs the current key's bytes. This
one does not. Set a new ring and leave `PLATFORM_KEK` where it is. With both set, the Worker
keeps `PLATFORM_KEK` in the ring as the **legacy key**, open-only, under its legacy kid
(`PLATFORM_KEK_ID`, else `default`). Every blob sealed under it keeps opening, every new seal
uses the new active key, and the sweep moves the old blobs across. Nobody handles the old key.

Three rules. The Worker enforces the first two and fails closed; the third is yours to keep,
because nothing can tell a changed `PLATFORM_KEK_ID` from a meant one:

- `PLATFORM_KEK_ACTIVE` must name a `PLATFORM_KEK_KEYS` entry. The legacy key never seals.
- Give the new key a kid of its own. If `PLATFORM_KEK_KEYS` holds the legacy kid with
  **different** bytes, the ring refuses to load: every product route 404s and
  `GET /manage/api/products/kek` answers `503` with _PLATFORM_KEK and PLATFORM_KEK_KEYS both
  define kid default with different keys; refusing to choose_. Step 2 checks this before the
  call.
- Leave `PLATFORM_KEK_ID` exactly as it is, set or unset. It names the legacy kid; changing it
  orphans every legacy blob.

Throughout, `<host>` is `key.plrs.im`, `key-staging.plrs.im` or `key-dev.plrs.im`, and the
calls are a platform admin's: the console session cookie, plus the CSRF token from
`GET /manage/api/me` on the `POST`. Every command that changes something runs only after the
request it depends on succeeded; a `STOP` line means do not go on.

```sh
BASE=https://<host>/manage/api
COOKIE="cookie: __Host-pkey_admin=…"           # from a signed-in console tab
CSRF=$(curl -fsS "$BASE/me" -H "$COOKIE" | jq -er .csrf) || echo "STOP: no CSRF token; sign in again"
```

0. **Preconditions.** The running Worker must support the legacy key: on an older build,
   `PLATFORM_KEK` is ignored once `PLATFORM_KEK_KEYS` is set, and step 2 would make every
   existing blob unopenable at once. Check that the live commit descends from the commit that
   added the legacy key. The commit is found by its content on `main`, so the check holds
   however the change was merged. Run it from a clone of this repository:

   ```sh
   git fetch origin
   SHA=$(curl -fsS "$BASE/platform/version" -H "$COOKIE" | jq -er .gitSha) &&
   FIX=$(git log origin/main --reverse --format=%H -S'export interface LegacyKey' \
           -- packages/worker/src/platform/keyvault.ts | head -1) &&
   git merge-base --is-ancestor "$FIX" "$SHA" &&
   echo "OK: the live build has the legacy key" ||
   echo "STOP: the live build predates the legacy key, or its commit is unknown"
   ```

   Platform → Status shows the same commit. If `gitSha` is `null`, take the live commit from
   the deploy log and run the `git merge-base` line on it. Then record the legacy kid and the
   counts:

   ```sh
   curl -fsS "$BASE/products/kek" -H "$COOKIE" | jq '{active, kids, remaining, unopenable}'
   # { "active": "default", "kids": ["default"], "remaining": 0, "unopenable": 0 }
   LEGACY_KID=$(curl -fsS "$BASE/products/kek" -H "$COOKIE" \
                  | jq -er 'select(.kids == [.active]) | .active') &&
   echo "legacy kid: $LEGACY_KID" ||
   echo "STOP: the request failed, or the keyring is not the single PLATFORM_KEK shape"
   ```

   `active` is the legacy kid. Take a D1 Time Travel bookmark of the environment's database.

1. **Generate the new key** into a file only you can read, check it decodes to 32 bytes, and
   escrow it (password manager plus an offline copy) before going on. That copy is the one that
   was missing.

   ```sh
   umask 077; mkdir -p ~/.secrets/polaris-key/kek
   openssl rand -base64 32 > ~/.secrets/polaris-key/kek/<env>.key
   base64 -d < ~/.secrets/polaris-key/kek/<env>.key | wc -c    # must print 32
   ```

2. **Set the new ring, leaving `PLATFORM_KEK` in place.** One `wrangler secret bulk` call (two
   `secret put`s would deploy a version where `PLATFORM_KEK_ACTIVE` names a kid that is not in
   the ring). The kid must differ from the legacy kid, and from `default`; the guard refuses
   either before anything is sent. The key travels file → `jq` → wrangler's stdin and never
   appears on a command line:

   ```sh
   cd packages/worker
   NEW_KID=k2026-10                                   # any kid other than the legacy one
   if [ -z "$NEW_KID" ] || [ -z "$LEGACY_KID" ] || [ "$NEW_KID" = "$LEGACY_KID" ] ||
      [ "$NEW_KID" = default ]; then
     echo "STOP: NEW_KID must differ from the legacy kid (${LEGACY_KID:-not recorded: step 0}) and from default"
   else
     jq -n --arg kid "$NEW_KID" --rawfile key ~/.secrets/polaris-key/kek/<env>.key \
       '{PLATFORM_KEK_KEYS: ({($kid): ($key | rtrimstr("\n"))} | tojson), PLATFORM_KEK_ACTIVE: $kid}' \
       | npx wrangler secret bulk --env <env>
   fi
   ```

3. **Deploy and verify.** The bulk call itself deploys a new version with the new secrets; there
   is no code change to deploy. Confirm the ring loaded and the legacy key is in it:

   ```sh
   curl -fsS "$BASE/products/kek" -H "$COOKIE" | jq '{active, kids, remaining, unopenable, legacy}'
   # "active": "k2026-10", "kids": ["k2026-10","default"], "unopenable": 0,
   # "legacy": { "kid": "default", "openOnly": true, "remaining": <every stored value>, … }
   curl -fsS https://<host>/<product>/.well-known/jwks.json | jq .   # a product still serves
   ```

   - `503` naming a kid conflict: re-run step 2 with another `NEW_KID`.
   - No `legacy` in the answer while `PLATFORM_KEK` is set, or product routes 404: the build
     predates this change. Deploy forward at once: `npx wrangler deploy --env <env>` from a
     checkout that passes step 0's check. Leave the secrets as they are. On the right build the
     legacy blobs open again, and so does anything sealed under `$NEW_KID` meanwhile. Do not undo
     by deleting the new ring: any admin write since step 2 is sealed under `$NEW_KID` and would
     go dark (see Rollback below). Only if no forward deploy is possible, and `counts` shows
     nothing under `$NEW_KID`, return to the single-key shape with
     `echo '{"PLATFORM_KEK_KEYS":null,"PLATFORM_KEK_ACTIVE":null}' | npx wrangler secret bulk --env <env>`.

4. **Rewrap.** The sweep is the same `POST` as above: bounded, idempotent and resumable, so it
   can be stopped and re-run at any time. Repeat until `legacy.remaining` is 0:

   ```sh
   while :; do
     R=$(curl -fsS -X POST "$BASE/products/kek" -H "$COOKIE" -H "X-PKey-CSRF: $CSRF" \
           -H "content-type: application/json" -d '{"limit":200}') ||
       { echo "STOP: request failed"; break; }
     echo "$R" | jq -c '{resealed, skipped, failed, remaining, legacy: .legacy.remaining}' ||
       { echo "STOP: not a sweep answer"; break; }
     echo "$R" | jq -e '.legacy.remaining == 0' >/dev/null && { echo "done"; break; }
     echo "$R" | jq -e '.resealed + .skipped == 0' >/dev/null &&
       { echo "STOP: stuck"; echo "$R" | jq .failures; break; }
     sleep 1
   done
   ```

   The loop stops on the first failed request (an expired session, a lost CSRF token, a `503`
   from the keyring): fix that, then run it again. A pass that re-seals nothing while values
   remain is stuck: `failures` names each row (see step 6 of the procedure above for what
   `failed` means). Each pass is one `kek.reseal` row on the platform activity log.

5. **Verify zero legacy blobs.**

   ```sh
   curl -fsS "$BASE/products/kek" -H "$COOKIE" | jq '{remaining, unopenable, countsComplete, legacy}'
   # "remaining": 0, "unopenable": 0, "countsComplete": true,
   # "legacy": { "kid": "default", "openOnly": true, "remaining": 0, "workerSecrets": [], "safeToDelete": true }
   ```

   Platform → Settings → Keyring says _Safe to delete PLATFORM_KEK_. If `workerSecrets` names a
   `SIGNIN_*` secret, it is still sealed under the legacy key and the sweep cannot move it:
   re-seal its plaintext with `signin:seal`, exporting only the new `PLATFORM_KEK_KEYS` and
   `PLATFORM_KEK_ACTIVE` (the script seals under the active kid, as the Worker does), set it
   ("Login-card providers"), and check again. Nothing can add a value under the legacy kid any
   more, so once this reads 0 it stays 0.

6. **Delete the old key.** The delete runs only if the check prints `true`; a failed request
   stops it too.

   ```sh
   curl -fsS "$BASE/products/kek" -H "$COOKIE" \
     | jq -e '.unopenable == 0 and .countsComplete == true and .legacy.safeToDelete == true' &&
   npx wrangler secret delete PLATFORM_KEK --env <env>
   curl -fsS "$BASE/products/kek" -H "$COOKIE" | jq '{active, kids, remaining, unopenable, legacy}'
   # "kids": ["k2026-10"], "remaining": 0, "unopenable": 0, and no "legacy"
   ```

   The `kek_legacy_open_only` warning leaves Platform → Settings, and the environment is in the
   plain keyring shape: the next rotation is the procedure above.

**Rollback.** Until step 6 nothing is lost: `PLATFORM_KEK` is untouched, and keeping both shapes
set is always safe. Do not go back to `PLATFORM_KEK` alone once anything has been sealed under
the new kid (the sweep, or any admin write after step 2): those values would go dark. After step
6 the old key is gone for good, and so is every D1 backup, bookmark or `wrangler rollback` target
from before step 4: restored, their blobs carry the legacy kid and cannot be opened.

## Key compromise

Treat a suspected compromise as an incident: record the first plausible exposure time, preserve
the affected GitHub and Cloudflare audit evidence, and rotate the compromised credential from a
trusted workstation. Do not use a Worker rollback as containment. Cloudflare documents that a
Worker version captures its bindings, secrets are bindings, and `wrangler secret put` creates and
deploys a new version. A rollback to an older version can therefore restore a leaked secret
value while leaving D1 and KV data unchanged.

Prefer a forward deployment of trusted code. If a rollback is unavoidable, identify every secret
rotated after its target version, immediately re-apply each from escrow with `wrangler secret
put` or `wrangler secret bulk`, then perform the secret-specific verification below. Keep a
pre-rotation cookie or webhook delivery only as a verification fixture; never keep compromised
secret material. Two secrets are exceptions. Never re-apply an earlier `ADMIN_SESSION_SECRET`:
generate another. Re-apply `KEY_HASH_PEPPER` only together with that new value, in one
`wrangler secret bulk` ("Compromised `KEY_HASH_PEPPER`").

### Compromised session secret

`ADMIN_SESSION_SECRET` is the only signing key for the stateless
`__Host-pkey_admin` cookie (`packages/worker/src/core/console/session.ts`). A holder can forge
the cookie's subject, groups and step-up timestamp; the root rule grants Superadmin when those
groups include `PLATFORM_ADMIN_GROUP` (`core/rbac/principal.ts`). Per-subject logout revocation is
useful for a stolen cookie, but it cannot contain a leaked signing secret: the attacker can mint a
new subject and expiry. Removing an operator from the IdP group also does not end an existing
cookie; groups are copied into the cookie for its eight-hour lifetime.

1. Generate a new value (64 hex characters exceeds the deployed-environment minimum):

   ```sh
   openssl rand -hex 32 | npx wrangler secret put ADMIN_SESSION_SECRET --env <env>
   ```

2. Keep `PORTAL_SESSION_SECRET` separate. The portal has no fallback to the admin secret
   (`services/identity/portal/session.ts`), so this rotation does **not** sign portal visitors
   out.
3. Verify a saved old admin cookie is rejected:

   ```sh
   curl -i https://<host>/manage/api/me \
     -H 'cookie: __Host-pkey_admin=<old-cookie>'
   # 401
   ```

   Then sign in afresh at `/manage` and confirm `GET /manage/api/me` returns 200.

4. Review the exposure window in Platform → Activity and every affected product's activity log.
   A genuine console callback writes `admin.signin` to `platform_audit`
   (`console/auth.ts`); a forged cookie does not. An action whose `actor_sub` has no recent
   corresponding sign-in is a lead, not proof—security-event writes are best-effort. Treat
   `key.*`, `secret.set`, `ci.token.*`, repo-link/resync, exports and deletes as possible
   Superadmin actions, and rotate or revoke anything unrecognised.

For a leaked `PORTAL_SESSION_SECRET`, rotate it the same way. A portal cookie also needs a live,
unrevoked `account_sessions` row named by its random `sid`
(`services/identity/portal/accountSessions.ts`), so the secret alone is not a usable forged
portal session. Rotation nevertheless signs every portal visitor out; use the account's existing
“sign out everywhere” path first when the incident is limited to one account.

### Compromised `KEY_HASH_PEPPER`

`hashKey` is HMAC-SHA-256 when the pepper exists and falls back to plain SHA-256 when it does not
(`packages/worker/src/platform/crypto.ts`). On prod, staging and dev, `core/configGuard.ts`
refuses every request if the pepper is missing or shorter than 32 characters; that avoids a
silent production fallback, but it does **not** provide versioning or a dual-read window.

Do **not** rotate this secret merely because its value leaked. It is useful to an attacker only
with the corresponding D1/KV hashes. License keys have 128 random bits and device tokens 256, so
the pepper does not make either practical to brute-force; the meaningful offline risk is
low-entropy values such as email-derived limit keys and short-lived sign-in codes. Contain the
data-access incident first: rotate Cloudflare credentials, audit D1/KV access, and let
short-lived flows expire.

There is no safe in-place rotation. Changing the pepper invalidates device-token,
license-key, CI-token, registry-token, admin-API-token, portal-session and single-use-flow hashes. License-key
plaintext is shown once and is not stored, so old keys cannot be re-hashed. A forced rotation is a
planned, owner-approved platform-wide credential reissue, and it **replaces `ADMIN_SESSION_SECRET`
in the same update**. Do not begin without a customer communication and recovery plan.
`KEY_HASH_PEPPER` versioning and dual-read remain open work.

**Why the session secret changes with the pepper.** The console cookie is verified with
`ADMIN_SESSION_SECRET` alone and stays valid for eight hours (`core/console/session.ts`). Signing
out does not change the cookie: it writes a per-operator "revoked at" mark to the single-use store,
at an address that is an HMAC of the operator's subject under `KEY_HASH_PEPPER`, and a mark the
check cannot find, because it is missing or the store is unreachable, reads as "not revoked"
(`core/console/sessionRevocation.ts`). A new pepper addresses different records, so every existing
mark is lost. With the session secret unchanged, each cookie that was signed out, or revoked as
stolen, and has not yet expired verifies again, with the groups it carries (Superadmin, for an
operator in `PLATFORM_ADMIN_GROUP`), for the rest of its eight hours. A new session secret removes
the dependency on any mark: an older cookie fails its signature check before the store is read.
Portal cookies need no such step. Each names an `account_sessions` row by an HMAC of its random id
under the pepper (`services/identity/portal/accountSessions.ts`), so a new pepper finds no row and
they fail closed.

Forced reissue, in this order:

1. **Prepare.** Have the owner's approval and the customer communication in place, take a D1 Time
   Travel bookmark, and escrow the current pepper. Tell every console operator that step 4 signs
   them out.

2. **Generate both values** into a file outside the repository. Worker secrets are write-only, so
   copy `KEY_HASH_PEPPER` into the escrow (a password manager plus an offline copy) and confirm you
   can read it back before applying anything. The session secret needs no escrow; if it is ever
   lost, generate another.

   ```sh
   cd packages/worker
   F=$(mktemp)    # created mode 0600
   printf '{"KEY_HASH_PEPPER":"%s","ADMIN_SESSION_SECRET":"%s"}\n' \
     "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$F"
   ```

3. **Make a signed-out cookie to test with**, immediately before applying: sign in at `/manage`,
   copy the `__Host-pkey_admin` cookie from the browser's developer tools, and sign out in the
   console.

   ```sh
   BASE=https://<host>/manage/api
   STALE="cookie: __Host-pkey_admin=…"      # the cookie you copied before signing out
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/me" -H "$STALE"
   # 401
   ```

   Anything but 401 means the sign-out did not register: stop. The cookie proves something only
   until its eight hours end.

4. **Apply both in one request.**

   ```sh
   npx wrangler secret bulk "${F:?}" --env <env> && rm -f "$F"
   ```

   Wrangler must report both `KEY_HASH_PEPPER` and `ADMIN_SESSION_SECRET` as successfully created.
   One `bulk` call sends both in a single request, so no deployed version holds one new secret and
   one old (DEPLOYMENT.md §4 relies on the same property for the console client's secrets). Two
   `wrangler secret put` calls deploy two versions and leave that gap: with the pepper first, every
   signed-out cookie works again; with the session secret first, so does any cookie that was signed
   in and out before the pepper followed. If the call fails, fix the cause and run the same command
   again, and delete the file if you stop. Do not split the call.

5. **Verify.** Nothing from before may return, and the new pair must work:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/me" -H "$STALE"
   # 401 (a pepper-only change would give 200)
   curl -fsS https://<host>/api/capabilities >/dev/null && echo up
   # up, not 500 server_misconfigured
   ```

   If `STALE` answers 200, the session secret did not change: before anything else, run
   `openssl rand -hex 32 | npx wrangler secret put ADMIN_SESSION_SECRET --env <env>` and check
   again. Then sign in afresh at `/manage`, copy the new cookie, and check that a sign-out holds
   under the new pepper:

   ```sh
   NEW="cookie: __Host-pkey_admin=…"
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/me" -H "$NEW"
   # 200
   CSRF=$(curl -fsS "$BASE/me" -H "$NEW" | jq -er .csrf)
   curl -fsS -X POST "$BASE/logout" -H "$NEW" -H "X-PKey-CSRF: $CSRF"
   # {"ok":true,"revoked":true}
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/me" -H "$NEW"
   # 401
   ```

   `"revoked":false` means the store could not record the sign-out and the cookie still works:
   treat the environment as unverified and do not continue.

6. **Reissue.** Sign in again, then mint and distribute replacement keys through each license's
   Keys API, have devices re-activate or sign in again, and reissue CI and registry tokens. Do this
   only now: a key minted earlier was hashed under the old pepper and would not match.

**Going back.** Returning to the old pepper, whether by abandoning the reissue or by restoring the
D1 bookmark (its rows hold the old pepper's hashes), is also a pepper change. Write the escrowed
old `KEY_HASH_PEPPER` and a newly generated `ADMIN_SESSION_SECRET` to a new file, as in step 2, and
repeat steps 3 to 5. Set back alone, the old pepper cannot find the marks written under the new
one, so cookies signed out in between work again.

**Never set an earlier `ADMIN_SESSION_SECRET` by hand.** Next to the new pepper it revives every
unexpired cookie it signed, signed-out ones included, and a leaked one lets its holder forge
sessions again. A `wrangler rollback` past this change restores the old pepper and the old session
secret together ("Key compromise" above). The marks written under the old pepper are reachable
again, so nothing signed out before the change comes back, but both secrets are un-rotated. If the
reissue should stand, apply the new `KEY_HASH_PEPPER` from escrow and a freshly generated
`ADMIN_SESSION_SECRET` in one `wrangler secret bulk` and verify again. Eight hours after the
change, every cookie signed before it has expired on its own.

### Compromised GitHub webhook secret

`GITHUB_WEBHOOK_SECRET` is one global HMAC secret. The handler accepts
`GITHUB_WEBHOOK_SECRET_PREVIOUS` only for a planned overlap
(`packages/worker/src/githubWebhook.ts`); it also binds a delivery to the installation recorded
for the linked repository and re-syncs the GitHub-resolved default-branch head, never
`payload.after` (`services/release/resync.ts`, `services/release/manifestFetch.ts`). A forged
delivery can therefore force a resync or poison webhook metadata, but cannot choose arbitrary
repository content. Per-tenant webhook secrets remain an open control-plane gap.

For a suspected leak, **do not** retain the old value in `_PREVIOUS`:

1. Generate a new secret and set it on the Worker first, clearing `_PREVIOUS` if present.
2. Change the GitHub App webhook secret immediately afterwards.
3. GitHub does not automatically redeliver failed deliveries. Redeliver failures from the App's
   Recent Deliveries view, or run `POST /manage/api/products/<slug>/release/resync` for each
   linked product after the App and Worker agree on the new secret.
4. Compare webhook-sourced `product_sync_state` rows with GitHub's delivery history and the
   GitHub-resolved `product_manifest_snapshot.applied_sha`; inspect `setting.resync` audit rows
   for unexpected changes. Signature failures themselves are not audited.

For routine rotation, set the old value as `_PREVIOUS` and the new value as the current secret in
one bulk update, change GitHub, verify a new delivery, then delete `_PREVIOUS`.

### Compromised product signing key

This is the product Ed25519 key held under `PLATFORM_KEK`, not a CI release key. It signs the
product's license, config, feed, trust and bundle documents; release records remain separately
signed by CI. First determine whether one product key leaked or whether a Worker/KEK compromise
requires the KEK procedure and rotation across every product.

1. In the product's Keys page (or `POST /manage/api/products/<slug>/keys/prepare`), prepare a
   replacement. The key is `staged` and published before it signs; wait its 300-second
   `activateAfter` trust-cache window. During active forgery, `activate` may use
   `breakGlass: true`, which requires a fresh console step-up.
2. Activate the staged key. This atomically retires the previous active key. Retirement alone is
   **not containment**: retired keys remain verification keys.
3. Revoke the leaked, now-retired kid with
   `POST /manage/api/products/<slug>/keys/revoke`. An active key cannot be revoked; replacement
   activation is required first. Revocation removes it from JWKS and keeps a positive
   `status: "revoked"` listing in the trust manifest for 400 days.
4. Verify the Keys listing, `/<slug>/.well-known/jwks.json`, and
   `/<slug>/.well-known/polaris-trust.jws`. Check the product audit trail for
   `key.prepare`, `key.activate` (or `key.activate.break_glass`) and `key.revoke`.
5. Run "Recovering the update feeds after a signer compromise" below for the affected product.

Clients with the leaked kid as their **only** compiled trust pin cannot be repaired remotely once
it is revoked: a tombstone must be signed by another already-usable pin. Ship new app builds
pinning a clean standby key. Keep a standby pin in future builds; the trust-manifest tombstone
rule can then remove a compromised pin. The `product_keys.status` column has no declarative
CHECK in `0003_keyvault.sql`, but `0015_data_integrity.sql` triggers reject values outside
`active`, `staged`, `retired` and `revoked`; use the Keys API, never an ad-hoc status update.

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

### Settings backfill

A one-off per product, run once the build that carries it is deployed. It moves each repository-
linked product onto the settings claim model by the owner's rule **"Revert all
console values"**: every field and tier/profile row the product's `.pkey/` declares takes its
manifest value and loses any console claim; tiers and profiles the manifest does not declare stay,
marked as console rows, so no later resync deletes them. There is no per-value review and no
"preserve" option. **To keep a console value, commit it to the product's `.pkey/` before the
apply**; the dry run lists every value the apply would revert. Kept as they are: a live
break-glass claim (it ends as any apply ends one: once expired, or when the manifest changes its
field from the last applied one), the existing `*_source` markers (services, the
compatibility window, the fingerprint and auto-issue policies, access) and the system product's
name. Manual products have no manifest and are only reported as `unlinked`.

Every run stores a report (`settings_backfill_reports`, kept for the record): each field and row
as `equal`, `differs` or `not-declared`, what the apply does with it, the values it reverts
(secrets read `[redacted]`), the console audit rows that explain a difference
(`evidence.verdict` `console-edit`, or `no-console-edit` for a manifest change or a missed
webhook since the last apply), and a compare-only check of the last recorded push
(`corroboration.matches`). An apply also writes one `setting.backfill` audit row listing every
changed value with before and after, and the manifest snapshot (origin `backfill`).

**An apply applies one dry run.** It needs the dry run's `reportId` (`expectReport`) and refuses
with 409 `backfill_stale` if the product's manifest commit or any of its settings changed since
that dry run, and with 409 `backfill_conflict` if a console edit lands while it runs; nothing is
written either way. Then run the dry run again and read it again.

The calls are a platform admin's (the session cookie and the CSRF token, as in "Rotating
PLATFORM_KEK"). Go one product at a time, **`polaris-key` first, then `djdl`**:

```sh
BASE=https://key.plrs.im/manage/api
COOKIE="cookie: __Host-pkey_admin=…"           # from a signed-in console tab
CSRF=$(curl -fsS "$BASE/me" -H "$COOKIE" | jq -er .csrf) || echo "STOP: no CSRF token; sign in again"
P=polaris-key                                   # then djdl
```

1. **Dry run.** It classifies the product and stores the report, and writes nothing else.

   ```sh
   curl -sS --fail-with-body -X POST "$BASE/products/$P/settings/backfill?dryRun=1" \
     -H "$COOKIE" -H "X-PKey-CSRF: $CSRF" > "backfill-$P-dry.json" || echo "STOP: the dry run failed"
   jq '{reportId, outcome, commit, changes}' "backfill-$P-dry.json"
   jq '.report.items[] | select(.action != "none")
         | {kind, key, class, owner, action, before, manifest, changed, values, note, evidence: .evidence.verdict}' \
     "backfill-$P-dry.json"
   ```

2. **Read the dry run.** `outcome` must be `planned`. `unreadable` (`cannot read .pkey/…`: the
   App lost access, the repository moved, the manifest no longer validates; for `polaris-key`, no
   deploy has run the hook yet) and `refused` (the manifest's catalog does not compile) write
   nothing: fix the cause and run the dry run again. For every item with `action: "revert"`,
   decide whether the console value is the one you want; if it is, commit it to `.pkey/`, wait
   for the push's resync, and start again at step 1. `mark-console` rows are console-only tiers
   or profiles that stay. Save the dry-run file with the change record.
3. **Apply that dry run.**

   ```sh
   R=$(jq -er .reportId "backfill-$P-dry.json") || echo "STOP: no reportId"
   curl -sS --fail-with-body -X POST "$BASE/products/$P/settings/backfill?dryRun=0&expectReport=$R" \
     -H "$COOKIE" -H "X-PKey-CSRF: $CSRF" > "backfill-$P-apply.json" || { cat "backfill-$P-apply.json"; echo "STOP: the apply failed"; }
   jq '{outcome, changes}' "backfill-$P-apply.json"     # applied (or unchanged)
   ```

   A `backfill_stale` or `backfill_conflict` answer wrote nothing: go back to step 1.

4. **Verify.** A fresh dry run must list no `revert`, `release-claim` or `mark-console` item
   (`changes: 0`), and its apply must answer `outcome: "unchanged"`. The product's Activity shows
   one `setting.backfill` row; both reports stay readable: `GET $BASE/products/$P/settings/backfill`
   (newest first) and `GET $BASE/products/$P/settings/backfill/<reportId>`.

**`polaris-key` (the system product).** Its manifest is the root `.pkey/` as the last deploy
applied it (its deploy-hook snapshot); the backfill never reads the monorepo's default branch for
it and never writes its snapshot, so deploy first (`unreadable` until a deploy has run the hook).
A deploy without `PKEY_GIT_SHA` records no commit (`commit: null`); that is fine, because the apply
is pinned to the dry run's report, not to a commit. Expect: the admin group `null` → `admin` (the
parser's default; it grants nothing) and the `services` marker. The bootstrap turned on the
default services (License and Config) beside Release and Distribution, while the root `.pkey/`
turns License and Config off, so the marker is reported `differs` and **kept**
(`services_source = 'admin'`). To hand services to the manifest, switch License and Config off in
the console (Services) and run the dry run and apply again: with equal services it resets the
marker to `manifest`. Its name is never written.

**`djdl`.** Expect no differences, or a few with `console-edit` evidence. Commit any value to keep
to `vladzaharia/djdl`'s `.pkey/` first, then apply.

**Every other product** (none): `POST $BASE/platform/settings/backfill?dryRun=1` runs the
dry run for every product (20 per call; pass `after=<next>` while `next` is not null; each call
answers its own `batchId`) and `GET $BASE/platform/settings/backfill` lists each product's newest
report. Read every report in the batch, then
`POST $BASE/platform/settings/backfill?dryRun=0&expectBatch=<batchId>` applies exactly the
products that dry run covered, each pinned to its own report; a product that moved since answers
`stale` and is not written.

### Package feeds: the registry host

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
registry token `401` with their native challenge within the same window (see "Registry tokens" below).

**A missing or stale index object** heals itself: a read that misses renders the package from
D1, writes it back under `registry/` and counts `registry.render_miss`. The cron's self-check
re-renders up to 50 packages per run whose stored render stamp differs from D1. Never put an R2
lock or lifecycle rule on `registry/`.

Bootstrapping the system product, turning an owner's feeds on, yanks and deprecations, feed
rebuilds, the Swift signing-certificate rotation and the forward-only migration note follow.

### Registry tokens

Clients of a non-public feed present a registry token (`pkeyr_…`): minted in the console
(**Ship builds → Package feeds → Tokens**, or a license's **Keys** tab) or by a licensee in the
portal. Every token expires (at most 365 days). The store is `registry_tokens` (Core's).

**Switching a feed's mode.** In the feed's **Settings → Access**. Leaving `public` answers every
client without a token `401` within 30 seconds, so mint the tokens and hand out the authenticated
setup (the Tokens page's shown-once dialog, or `/docs/build/install-from-feeds/#private-feeds`)
first. Switching back to `public` reopens the feed within 30 seconds. A rollback to a Worker older
than the one that added registry tokens, with a non-public feed refuses every read of that feed (it fails closed); switch the
feed back to `public` to reopen it. The platform's own feeds stay `public`.

**A leaked token.** Revoke it on the Tokens page (or the license's panel); it stops within 30
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
`required`) until a replacement or an app update arrives. SDKs older than the revocation build ignore
revocations and keep mounting the revoked release until the host upgrades its SDK; the yank only
stops new installs.

### Do not roll back past the revocation build without the yank

A Worker rolled back to a build older than the revocation build does not read `release_revocations` and does not
list revocations in feeds. The `release_yanks` row that ingest writes is what keeps a revoked
target out of an old Worker's sets: never delete those rows (reason `revoked`) during a rollback,
and never roll back the migration. Devices that already learned a revocation keep refusing the
target. Every SDK release note must state that SDKs older than the revocation build keep using revoked content
until upgraded.

### Package feeds: bootstrap and day-to-day

Package feeds serve versions of `kind: package` deliverables (the SDKs among them) on
`pkg.plrs.im`. The registry host, the ecosystem renderers and the console pages sit on top of it.

- **Bootstrap the system product** after deploying a Worker with package feeds, in each environment (dev, staging,
  production), as a platform admin:
  `POST /manage/api/platform/feeds/bootstrap` (idempotent; audited `feed.bootstrap` in the
  platform trail). It creates `polaris-key`, turns Release, Distribution and its package feeds on
  and seeds one feed per ecosystem with the platform namespaces. Registering the monorepo's
  trusted publisher for it is a separate step.
- **Turn a product's feeds on or off:** `PUT /manage/api/products/<slug>/distribution/package-feeds
{"enabled": true|false, "expectedVersion": <n>}`. Off stops every read for the owner at once.
- **Yank or deprecate a version:** the release's yank (`…/release/releases/<id>/yank`) is its feed
  state; deprecate is `POST|DELETE …/release/releases/<id>/deprecate {"message"}`. Neither frees
  the version: a package version is never published again. Only feed retention deletes a version
  (a build of main below a stable release; "Feed retention" below), and it leaves a tombstone so
  the version is still never published again.
- **Publish:** CI runs `pkey release publish --deliverable <package id>`, which always dry-runs
  first; a Worker without package feeds is reported as such and nothing is uploaded.

### Releasing the SDKs to the feeds

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
- **npm order and closure:** the npm packages pin each other exactly, so they publish in
  six tiers (`npm-tier-0` … `npm-tier-5`), each needing the one below, and `publish-package.yml`
  publishes an npm package only once the feed lists every `@polaris-key` version it pins
  (`tools/feed-closure.mjs requires`, waiting up to ten minutes for the render queue). The drift
  job then checks every pin of the build's version, and `npm-install` installs from the feed in
  empty directories: `pnpm add @polaris-key/node` with pnpm 11's defaults (its one-day age gate
  picks the newest version a day old), `npm install @polaris-key/react react react-dom`, and the
  build's exact set.
- **The first release after `@polaris-key/ui-core` lands must be a tag deploy.** A package publishes
  only to a deliverable the system product declares, and the deploy hook (`POST /webhooks/deploy`,
  `linkSystemProduct`) is what applies the root `.pkey/release.yaml`, `npm.ui-core` and `npm.server` included. Until
  a production deploy has run it, a publish of ui-core or server is refused (`invalid_descriptor`) and tier 3
  stops `node`, `react` and `cli` with it, so `main`-channel publishes fail until the tag deploy
  has registered `npm.ui-core` and `npm.server`.
- **A leg stuck in `waiting`:** GitHub occasionally never advances one deployment to
  `package-registry` (no reviewer or timer can release it). Nothing above its tier publishes.
  Cancel the run, then **Re-run failed jobs**: the stuck leg and every tier above it run again.
- **Closure red:** `feed-closure.yml` checks every version on the npm and PyPI feeds daily (and on
  demand) and lists each broken pin as `<package>@<version> -> <dependency>@<version>` in its job
  summary; the drift job lists them as warnings on every publish. `node tools/feed-closure.mjs`
  prints the same list locally, and `--assume <name@version>,…` shows what a backfill would leave.
  Two repairs: publish the missing version from its tag (`npm-repair.yml`, below), or deprecate
  the dependents (installers then prefer another version; the check reports a deprecated
  dependent as a warning).
- **Backfill (`npm-repair.yml`):** Actions → **Repair the npm feed** → **Run workflow** on `main`,
  with `tag` (the release tag, `v0.8.28`) and `packages` (short names, space-separated, `jws`);
  `dry-run` stops after the checks. The run refuses a tag that is not a release tag on `main`, a
  version the feed already lists, and a package whose pins the feed lacks (name dependent packages
  in separate runs, the dependency first). It builds and tests the packages at the tag, publishes
  each through `publish-package.yml` in `package-registry` on the tag's channel (`latest` does not
  move: a channel's head is its newest version), then checks every pin of that version. Owner
  decision 2026-10-08: two runs, `v0.8.28` with `jws` and `v0.8.29` with `protocol`, which close
  the nine versions v0.8.28 and v0.8.29 left broken.
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
  prereleases on the ephemeral channels (`main`, and the built-in `dev`) that sort below
  V are deleted. That means semver `X-main.N` (on `main`), `X-dev.N` (on `dev`) and PEP 440
  `X.devN` (on either) with X ≤ V (`services/release/packages/prune.ts`). A public registry's copy
  is never reached. Stable and beta versions are never
  touched, prereleases of versions newer than V are never touched, and other packages are never
  touched. A `beta` publish (a prerelease tag) prunes nothing. Only a live stable release sets
  the ceiling: a yanked or deprecated one never does. A candidate that a channel policy points
  at (a promote or pin) is kept. So is any candidate another row names (a revocation, a pack pin
  or hold, a download token). Both show as `kept` in the report. A candidate that became held
  between the plan and its deletion is kept too and listed as `skipped`, never dropped silently.
- **When.** Once retention is on for the product (below), the prune runs automatically in the Worker, right
  after the stable version is committed, for that package only. A failure never fails the publish. It is recorded
  in the product's audit as `package.prune.failed`, with the error. The Worker never logs to the
  console (R12), so the audit is the log. The next stable
  publish retries it, because each run prunes every remaining candidate. The backfill below also
  retries it. Every statement is idempotent, so running it twice is harmless.
- **The setting.** `release.packages.prunePrereleases` (settings registry; table
  `release_package_retention`) is ON by default for every product, after a one-time
  dry-run notice. The Release cron (every 15 minutes), or the product's first stable publish,
  records the notice (`release_package_retention_notices`: what a dry run found, and
  `starts_at`, a week later; one `package.prune.notice` audit row). Nothing is deleted before
  `starts_at`. An operator's own value wins at once: `PUT
/manage/api/products/<slug>/distribution/feeds/retention {"expectedVersion": <n>,
"prunePrereleases": false}` keeps the builds (audited `feed.retention.update`; `true` opts in
  without waiting). `GET` on the same path shows `source` and the `notice`. The system product
  (`polaris-key`) is on by default and locked on: a write is refused. Rolling the CODE back across
  The change leaves cleanup off for a product that never chose (`scripts/rollback/0115_release_package_retention_notices.down.sql`).
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
  manifest by digest) can still be answered by a data center whose Cache API already holds them,
  until that copy is evicted. The Worker cannot purge other data centers. A zone purge by URL
  would need a Cloudflare API token, which is a follow-up and not wired.
- **Backfill (dry run first).** For versions released before this existed, prune each package's
  builds of main below its newest stable release:

  ```sh
  # Dry run: prints, per package, what would go, with counts and bytes. Deletes nothing.
  PKEY_CI_TOKEN=<pkeyci_ token with release:yank> pkey feeds prune --product polaris-key
  # Then delete (audited per version under ci:<subject>):
  PKEY_CI_TOKEN=... pkey feeds prune --product polaris-key --apply
  ```

  For a one-off run by hand, issue a short-lived token as a platform admin:
  `POST /manage/api/products/polaris-key/ci-tokens {"scopes": ["release:yank"], "expiresInDays": 1}`.
  The token is shown once. Revoke it afterwards (`DELETE …/ci-tokens/<tokenId>`). This is not
  the standing `PKEY_FEED_PRUNE_TOKEN` of the backstop job below, which lives 90 days. The
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
- **The backstop after each stable tag.** `publish-sdks.yml`'s `prune` job runs the same
  backfill for `polaris-key` once a stable `vX.Y.Z` tag's publish jobs and drift check have all
  passed. It dry-runs first (the output goes to the log and the job summary), refuses to go on if
  the plan holds anything but builds of main (`X-main.N`, `X.devN`), and only then runs
  `pkey feeds prune --product polaris-key --apply`. Its token is `PKEY_FEED_PRUNE_TOKEN`, a static
  `pkeyci_` token of `polaris-key` with `release:yank` only, stored as a secret of the
  `package-registry` environment. Issue it like the one-off token with `"expiresInDays": 90`
  (the longest a static token lives), and do not revoke it after a run. Rotate it before it
  expires: issue a new one, replace the secret, then revoke the old one. The scope also allows a
  yank of any polaris-key release, so revoke it at once if it may have leaked (THREAT-MODEL
  "Feed retention"). Without the secret the job warns and stops. A failure in the job never fails the release run (`continue-on-error`): look for the
  job's annotation, then run the backfill by hand.

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

### Content keys (delegation)

A content key may sign data-only pack releases (`files.tree`, `data.json`, `l10n.table`) of
compatible or standalone packs under one pack-id scope, inside a window of at most 366 days. The
grant is a CI-signed delegation; the Worker never holds either key. See
`/docs/services/release/packs/` for the full flow.

**Adoption rule.** Delegate only once every live app build you care about embeds an SDK that supports delegated releases.
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

## Sign-in email

Every sign-in and account email leaves ONE shared sender, `noreply@auth.plrs.im`, on the
dedicated auth sending subdomain `auth.plrs.im`, so its reputation is every product's. Platform mail is sent as `Polaris Key`; mail for sign-in started through a product as
`<App> via Polaris Key`, where `<App>` is the product's display name after the reserved-name
validator (`src/core/notify/emailSender.ts`; a refused name falls back to the slug). Every send goes
through `deliverEmail` (`src/core/notify/emailDelivery.ts`): binding, sender, Apple private relay, the
hashed suppression list, the per-product daily cap (passthrough mail only), then the send.
Throttling, quota, an unverified sender and provider outages answer `email_unavailable`; the
login card then offers another sign-in method.

Until the owner steps below are done the Worker keeps sending from `noreply@plrs.im`
(`EMAIL_SENDER_ADDRESS` unset in prod) and staging answers `email_unavailable`.

### Owner setup (DNS and Apple)

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
   headers into the change that sets up sign-in email, then deploy prod.
7. **Quota.** `GET /accounts/<id>/email/sending/limits` gives the account's daily quota. The
   per-product default cap is 500 a day (`EMAIL_SEND_PRODUCT_DAILY_DEFAULT`); raise or lower it
   for the deployment in Platform → Settings → Daily sign-in mail cap (or `EMAIL_PRODUCT_DAILY_CAP`),
   or per product (below).

### Operating it

- **A product is capped** (its users see "We can't send email right now"): set its own cap in the
  product's Settings → Daily sign-in mail cap (`email.dailyCap`). Reset it to return to the
  deployment value. The day is a sliding 24 hours. (It used to be a row in
  `email_product_caps`; migration 0124 copied each row once; migration 0140 dropped the table.)
- **Suppression list** (`email_suppressions`): keyed by the peppered hash of the address, never
  the address. A hard bounce suppresses for 90 days, a complaint, a Cloudflare suppression
  (`E_RECIPIENT_SUPPRESSED`) or an operator entry permanently. A suppressed recipient is answered
  exactly like a sent one. To clear one, remove it from Cloudflare's list too (Email Sending →
  Suppressions) or the next send re-adds it.
- **Bounce and complaint events:** Cloudflare pushes none to a Worker. The Worker learns of them
  through `E_RECIPIENT_SUPPRESSED` on a later send; the dashboard's Analytics tab and the GraphQL
  `emailSendingAdaptive` dataset show the rest (delivery rate over 95 %, hard bounces under 2 %,
  complaints under 0.1 %).

## Login card

The login card's Worker half needs two owner inputs per environment. Until they are set the card
works without them: no Turnstile token is asked for, and avatars use the `BLOBS` bucket and the
`IMAGES` binding that already exist.

1. **Turnstile.** Cloudflare dashboard → Turnstile → Add widget, one per environment, hostname
   `key.plrs.im` (`key-staging.plrs.im`, `key-dev.plrs.im` for the others), mode Managed. Put the
   site key in `wrangler.toml` as the `TURNSTILE_SITE_KEY` var of that environment (it is public;
   the portal reads it from `GET /api/capabilities`), and the secret with
   `npx wrangler secret put TURNSTILE_SECRET_KEY --env <env>`. With the secret set, the email start
   refuses a missing or failing token (`403 turnstile_failed`), and an unreachable Cloudflare
   refuses too. The widget itself is rendered by the card's UI, which also needs Cloudflare's
   challenge origin in the portal's CSP.

   > **Warning: do not set `TURNSTILE_SECRET_KEY` yet.** The secret, not the site key, is what
   > switches the check on, and the portal does not render the Turnstile widget until a later
   > release ships it. With the secret set today, the portal sends no token and **every email sign-in fails
   > with `403 turnstile_failed`**. Set the site key var if you like; put the secret only once the
   > widget is live in the portal.

   **Done (2026-10-06, by the lead through the Cloudflare API).** The three widgets exist, named
   `Polaris Key login card (prod|staging|dev)`, mode Managed, one hostname each, and their site keys
   are the `TURNSTILE_SITE_KEY` vars in `wrangler.toml`. No secret is set. To switch the check on
   once the portal renders the widget, copy each widget's secret straight into the Worker without it
   passing through a terminal or a file: one Cloudflare API call per environment that reads
   `GET /accounts/{account}/challenges/widgets/{sitekey}` and writes the returned `secret` with
   `PUT /accounts/{account}/workers/scripts/{script}/secrets` as `TURNSTILE_SECRET_KEY`
   (`type: secret_text`), returning nothing. Then test email sign-in on staging before prod.

2. **Avatars.** Account pictures (provider copies and uploads) live in the environment's
   `BLOBS` bucket under the `avatars/` prefix; no extra bucket is needed. Never add `avatars/` to
   the bucket's lock rules: a deleted account's pictures must go at once. They are re-encoded by
   the `IMAGES` binding that `wrangler.toml` already declares for prod, staging and dev (four
   transformations per new picture; Images must stay enabled on the account). Without it no
   picture is copied, uploads answer `503 unavailable`, and accounts show initials. The nightly
   cron's `avatars` step deletes pictures nothing has used for a day; a failure there shows in the
   maintenance report like any other step.

**Sessions after the deploy.** Account sessions became server-side rows (`account_sessions`); a
portal cookie signed before this deploy names no row and is refused, so every portal visitor signs
in once afterwards. There is nothing to migrate.

**A person locked out by the email limits** (10 wrong codes in an hour) gets no new code for 15
minutes and sees nothing different; waiting is the fix. The limits are in
`src/core/notify/emailLimits.ts`.

### Publish Polaris Key's terms

`identity.platformTerms` is unset, so no new account is asked to accept Polaris Key's terms and
nothing is recorded (`docs/legal/` holds drafts that must not be published). It
is an owner step, and it waits for four things:

1. the owner's legal review of the terms and the privacy notice, and both published at https URLs;
2. the portal's finish step, which renders the terms step (until it does, the card cannot
   show it, and a new email address would stop at a step it cannot draw);
3. the platform IdP's `/callback` going through the gate;
4. the legacy product callback being retired. Until 3 and 4 are done, those two paths create
   accounts without the step.

Then, per environment (staging first), one row; `version` is a short label such as `2026-10`:

```sh
npx wrangler d1 execute <DATABASE> --env <env> --remote --command \
  "INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
   VALUES ('identity.platformTerms',
           '{\"version\":\"2026-10\",\"termsUrl\":\"https://…/terms\",\"privacyUrl\":\"https://…/privacy\"}',
           1, unixepoch(), 'owner')
   ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, version = version + 1,
     updated_at = excluded.updated_at, updated_by = excluded.updated_by"
```

It applies at once (read fresh, no cache). A value that is not exactly `{version, termsUrl,
privacyUrl}` with https URLs reads as unset, so check the step on a new account in staging. New
accounts then accept that version; the acceptance is a `_platform` row in
`account_terms_acceptances`. A new version is the same statement with a new `version`; accounts
created before it are not asked again (existing accounts accepting a new version is a later
decision). Deleting the row turns the step off again; the acceptances already recorded stay.

## Login-card providers

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

### Owner setup (consoles and secrets)

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
     "Sign-in email" above.
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
  three as well as the D1 blobs: `GET /manage/api/products/kek` names any still under a legacy
  `PLATFORM_KEK` in `legacy.workerSecrets`.
- **Turning one off.** `wrangler secret delete SIGNIN_<…>_CLIENT_ID` (or Steam's key); people who
  signed in with it keep their account and use another method.
- **Apple notifications** (`consent-revoked`, `account-delete`, `email-disabled`,
  `email-enabled`) set or clear `account_links.provider_flag` and are audited on the account; they
  never delete a link. A 401 from the endpoint in the logs is a JWT that was not Apple's or not
  addressed to the Services ID.
- **Discovery.** Google's and Apple's discovery documents and keys are cached for an hour per
  isolate. A sign-in that answers _… sign-in is unavailable right now_ is the provider's endpoint
  failing, or answering with a host outside the allowlist (`providers/net.ts`).

## Offline grace clamp

A license's offline grace no longer outlasts the license. While a product's
`licensing.clampGraceToExpiry` is on (the default), every document a license grants (the license
document, the config document of a device bound to it, an offline bundle's inner documents, the
browser-session document) has `graceUntil = min(issuedAt + maxOfflineDays × 86 400,
max(expires_at, expiresAt))`. A perpetual license, and one whose expiry lies past its window, is
unchanged; a grant's own expiry never shortens the window. The opt-out is per product: License →
Settings → **Clamp offline grace to expiry** off (a reason is required), or
`clampGraceToExpiry: false` under `licensing:` in `.pkey/product`.

**Owner steps (production), before the release that carries the grace clamp.** The clamp is on for every
product the moment that release is deployed, so read the affected-license report first. Agents
never run any of this against staging or production, and never run `wrangler` against a remote.

1. **Report on a production-shaped copy**, offline, with no Worker and no KEK:

   ```sh
   npx wrangler d1 export polaris_key_prod --env prod --remote --output prod.sql   # owner only
   pnpm --filter @polaris-key/worker grace-clamp:report -- --sql prod.sql --out grace-report
   # optional: --now <epoch seconds of the planned deploy> (default: now); --product <slug>
   # a dump over ~500 MiB: sqlite3 prod.sqlite < prod.sql, then pass --sqlite prod.sqlite instead
   ```

   `grace-report/` then holds `report.json` and `report.csv`: per product, whether License is on,
   the clamp's state and where it comes from (`default`, `manifest` or `console`), and every
   usable license that expires inside its offline window, with its expiry, its window, the window
   it gets instead, the days removed and how many devices are authorised on it. License ids and
   counts only: no name, email or key. The tool loads the copy into memory and fails if the report
   changed anything. Delete `prod.sql` afterwards: it holds customer data.

2. **Opt out where the full window must stay** (a product whose licenses are routinely renewed
   after they lapse, say). The setting already exists and does nothing until this release, so
   the opt-out can be set before the deploy. If the setting ships in the same release, set it right after
   the deploy: an online device picks up the clamped window at its next document fetch (within the
   hour), an offline one only when it next reconnects.
3. **Deploy.** Nothing else to do; there is no migration.

**After the deploy.** A license that is renewed (its `expires_at` moved later) gets its full window
back at the next full fetch (within the hour while online; a `304` keeps the copy it has). A license that expires within the hour gets documents that end with their
ordinary hour of validity, which every verifier requires. An offline bundle minted for a license
that expires inside `graceDays` is clamped the same way, and its `bundle.minted` audit row says so.

**Rolling back.** Turn the setting off per product (no deploy; devices get the full window at their
next fetch), or redeploy the previous Worker.

## Licensing model expand

The licensing model adds **grants**: reasons a holder (a license,
an account or a store identity) has entitlements. This release is the expand step only (steps
1–4). Every license and device document stays **byte-identical**, ETag included, and every read
stays on the old objects until a later release. Three things change underneath:

- **Store grants are dual-written.** Every store purchase in `license_store_grants` also has one
  license-held grant, `grt_s_<store>_<purchase key hash>` (`grants`, `grant_entitlements`,
  `dist_purchases.grant_id`), and every store mapping has its entitlement rows
  (`dist_store_product_entitlements`). The new rows are a projection of the old ones and are
  written in the same batch, so they cannot drift.
- **OIDC-provisioned entitlement keys move** out of `licenses.overrides_json` into the license's
  `oidc` grant, `grt_oidc_<license id>` (djdl's `polarisVpn`). Each entry's state, value and
  `updatedAt` is copied, and the license document reads the grant where the keys used to sit. A
  sign-in moves its own license. Provisioned **secrets** are not touched by this job: a sign-in
  by an identity linked to the license's owner puts them on the owner's account overrides row, and
  `core.provisioned-secrets-to-account` moves the ones already on the license.
- **Tiers gain `rank` and `policyOfflineGraceDays`** (default 0 and none). A sign-in whose
  groups map to several tiers picks the highest-ranked one. While every rank is 0 that is still
  the first match, so nothing changes until a rank is set. `oidc.syncTierOnSignIn: upgradeOnly`
  (off by default) moves an existing license to a higher-ranked tier at sign-in.

**Owner steps (production).** Agents never run any of this against staging or production.

1. **Deploy.** The release that carries the licensing model applies its migrations through the normal deploy
   (`wrangler d1 migrations apply`). Each migration file is a bare `ADD COLUMN`, an
   `IF NOT EXISTS` table, or the backfill (`…_m_licensing_backfill.sql`). The backfill projects
   every existing store grant and mapping. It is an upsert that changes nothing on a replay, so a
   migration run that is interrupted and started again converges. The Worker that is still live
   until the deploy reads none of the new objects, so the window is safe.
2. **The catch-up runs by itself after the deploy.** The deploy hook (`POST /webhooks/deploy`)
   runs one bounded pass, and the nightly maintenance (`licensingCatchUp`) runs one every night
   until nothing is left (`src/core/licensing/licensingCatchUp.ts`). Each pass does two things:
   - it re-projects the store grants and mappings, which picks up what the old Worker wrote
     between the migration and the deploy;
   - it moves the provisioned keys of licenses that have not signed in since. That is the job
     `licensing.migrateProvisioned`.

   The hook runs its pass after it has answered (its answer says `licensing: {scheduled: true}`),
   so a pass cut short never fails or replays the deploy. Check the outcome in the console under
   Platform → Activity: the row "ran the licensing catch-up" (`licensing.catch_up`) carries
   `{products, failed, provisioned: {moved, deferred, raced, more}}`. `failed` should be empty.
   `more: true` means the nightly pass finishes the work. Only OIDC licenses move: on any other
   license a provisioned key is an operator's override and stays in the column.

   A license is **deferred** when moving it would reorder the keys in its document. That happens
   when an operator added an override key after the license's last sign-in. A deferred license is
   left exactly as it is, and its next sign-in moves it, as every sign-in rewrites the document
   anyway.

3. **Nothing else is needed.** There is no switch and no flag. Reads move in a later release, which then stops the
   dual-write and retires the old objects after a zero-drift report (`storeGrantDrift` in
   `src/core/licensing/grants.ts`).

**Rolling back.** Store grants and mappings never left their old tables, so a Worker built before
the licensing model keeps serving them. The provisioned keys **did** leave the overrides column. After rolling
the Worker back, run the down script once to copy them back:

```sh
# owner only, after deploying the build from before the licensing model:
npx wrangler d1 execute polaris_key_prod --env prod --remote \
  --file packages/worker/scripts/rollback/0105_licensing.down.sql
```

It appends each grant's keys after the license's other keys, where the old writer kept them, so
the old Worker's documents are the new Worker's byte for byte. It then deletes the copied keys
from the `oidc` grants, and the grants they empty, so the column is their only source again. Without
that step, a key the old Worker revoked (its claim disappeared at a sign-in) would come back when
the new Worker is rolled forward. The script is idempotent: a second run copies and deletes
nothing.

It leaves the licensing model's tables, columns and store-grant rows in place. A roll forward starts the move
over, as the first deploy did: each sign-in and the catch-up move the keys out of the column again,
and the catch-up re-projects the store grants the old Worker wrote in between.

## Migration ledger

Every change that runs in two steps (an expand, then a contract), every compatibility window and
every data-migration job report has a row here. A row names its owner and ends on a **production
fact**: something the lead reads in production, never a release number. The lead records the fact
under _Entries_ in the change that closes the row. A row with no entry is open.

**Rules** (owner, 2026-10-07).

- No compatibility window exists except break-glass, paths that installed native binaries call, and
  the two-release database contracts. There is none for an SDK, the CLI, the publish Action,
  cookie mode or the Pocket ID env override: each goes in the release that
  replaces it, and a removed manifest field is a validator error that names its replacement.
- A drop takes two steps. The first stops every read and write. The second drops the object, after
  a production check that nothing read or wrote it and **14 days** after the Worker that stopped
  using it went live, so the previous deploy is always a rollback target that still has it. The
  second step ships its own down script in `scripts/rollback/`.
- A value change runs through a data-migration job: release N writes the explicit values under the
  old meaning, and the next release switches once a fresh dry run reports no changes.

### Expand and contract pairs

| Pair                        | Owner     | Exit fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License override migration  | The lead  | Deleted with the override-migration release. A later release drops `override_migration`, `override_migration_report` and `provisioned_secret_moves`.                                                                                                                                                                                                                                                                                                                                                                                      |
| Settings backfill           | The owner | The backfill ran on `djdl` and `polaris-key` and its report is kept. Then the runner, routes and page are deleted.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Platform-IdP claim          | The owner | The count of end users with no email, read on the sunset date `PLATFORM_OIDC_SUNSET`. Closed when the legacy callbacks are retired.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Licensing catch-up          | The lead  | A later release retires `licensingCatchUp` and the store-grant dual-write once offers are the writer.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Standalone licensing tables | The lead  | A second release drops the six standalone licensing tables after the check. Columns of `licenses` and `grants` stay.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Portal tables               | The lead  | Release N: `scripts/portal-contract-check.sql` reads four zeros before the release, and the guarded purge (`0141_a_portal_contract_purge`) empties the four `portal_*` tables. A second release drops them once all four are still empty in production and **14 days** after release N is live.                                                                                                                                                                                                                                           |
| Credential tables           | The lead  | A second release drops `product_secrets`, `outlet_credentials` and `platform_credentials` after a check that none was opened.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Distribution listing        | The lead  | Phase 1: the model is the truth and `dist_listing` the fallback. A production dry run of `distribution.listing-truth` reports no missing and no refused field (or each listed one is accepted), and it is applied. A second release (phase 2) stops reading and writing `dist_listing` and drops it after the check. Then prune the ledger `dist_listing_truth_moves` (it holds listing text and contact emails until then).                                                                                                              |
| Storefront close-out        | The lead  | No code reads `discover_enabled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Product admin group         | The lead  | Nothing reads `products.admin_group` and every `adminGroup` offer has an outcome. A second release drops it once the previous deploy is the one that stopped the reads or later.                                                                                                                                                                                                                                                                                                                                                          |
| Legacy settings stores      | The lead  | Contract done (migration `0140_retire_legacy_settings`): drops `lazy_delta_settings`, `email_product_caps`, `products.branding_json` and the five retired `portal_product_settings` switch columns. Fact: production's rollback targets v0.9.15 and v0.9.16 both contain the settings moves (`f8a95bd96`, `b8c69e523`), so neither reads the dropped objects. Down script `scripts/rollback/0140_retire_legacy_settings.down.sql` recreates them empty. `portal_enabled`, `key_reissue_enabled` and `claim_by_key` stay one more release. |
| Portal-to-account catch-up  | The lead  | Closed in release N: `services/identity/accounts/legacy.ts`, its nightly step and the `LICENSE_WRITE_SEAMS` row are gone. The lead records the Entry at merge.                                                                                                                                                                                                                                                                                                                                                                            |
| Durations and subscriptions | The lead  | None. It has no contract step, and its down script only reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Rollback ladder (licensing)

`scripts/rollback/0105_licensing.down.sql` is valid only before the licensing-model migration. Each later
licensing migration ships its own down script. After that migration ships, run the newest script that
applies, never `0105`.

### Windows

| Window                                                                            | Owner     | Length                                         | Exit fact                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | --------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Break-glass (`/manage/login?breakGlass=1`)                                        | The owner | At least 30 days from the deploy that added it | 14 consecutive days with no `rbac.breakglass` audit row, and two accounts with a Superadmin binding and a strong passkey. Then the branch goes; `ADMIN_OIDC_*` stays as `console-idp`. |
| Native-binary paths (the permanent aliases and routes DJDL's desktop builds call) | The owner | Until DJDL ships a build on 0.9                | Production request logs show no native client calling the route. Each release that removes a route records this first.                                                                 |
| `admin_group` column                                                              | The lead  | 14 days after the reads stopped                | See Product admin group above.                                                                                                                                                         |
| `PLATFORM_OIDC_MIGRATION` and `PLATFORM_OIDC_SUNSET`                              | The owner | To the owner-set date `YYYY-MM-DD`             | The seeded platform connection's audience is written once from its last value, recorded here. A later release then removes both names.                                                 |
| `licenses.sub`                                                                    | The lead  | To the owner-set date                          | The `legacy-sub-sunset` dry run reports the email-less count again. Then a later release stops every read; the column stays dormant.                                                   |

### Job reports

The data-migration runner (`core/migrate/`) keeps every run: `data_migration_runs` holds the mode,
status, who ran it, the changes and the report; `data_migration_units` holds each unit. Rows are
never pruned and hold no secret material. Read them with `pkey migrate list` and
`pkey migrate report <run>`, or `GET /manage/api/platform/migrations/runs/<id>`. An apply is pinned
to the dry-run report the lead read, so the run id is the record.

When a row's exit depends on a job, the entry names the run id and its totals. Jobs the ledger
tracks:

| Job                                   | Owner    | Exit fact                                                                                                                                                                                                                  |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.licence-override-migration`     | The lead | Deleted with the override-migration release. A later release drops the tables.                                                                                                                                             |
| `core.provisioned-secrets-to-account` | The lead | A dry run after the apply reports changes 0, and its conflicts and otherSubject counts are resolved or accepted by the lead. Both run ids are recorded under Entries. The release after drops the job and its ledger.      |
| `identity.seed-platform-connection`   | The lead | An apply report exists. Its seeded audience is recorded here as above.                                                                                                                                                     |
| `distribution.listing-truth`          | The lead | A dry run reports no `missing` and no `refused` field, the apply is recorded here with its run id, and a fresh dry run reports 0 changes. After phase 2, prune `dist_listing_truth_moves`; down is only valid before then. |
| `license.limits-materialise`          | The lead | A dry run after the apply reports changes 0 and docDiffs 0, and no license has a tier of NULL. Its run ids are recorded under Entries.                                                                                     |
| Resolver comparison                   | The lead | Zero blocking rows, every expected row acknowledged below by class and count, and no `workflow-channel` row's old answer newer than the latest `materialise-workflow-beta` run.                                            |
| Resolver switch                       | The lead | The dry run after the switch shows zero blocking rows and nothing was rolled back. A later release then deletes the old resolver.                                                                                          |

**Resolver deviation.** The two-release rule says the switch waits for a dry run with no changes. The
resolver comparison accepts six expected classes instead (`beta-includes-stable`,
`workflow-channel`, `beyond-page-cap`, `duplicate-version`, `descriptor-channel`,
`descriptor-files`), because they are the deliberate move to one meaning per track and cannot reach
zero. The lead acknowledges each class and its count here before the switch.

**Owner steps for DJDL** (the resolver switch). First, change the channel workflow so that beta publishes as a
GitHub prerelease or with descriptor `channel: beta`, before the switch deploys. Second, drop
`channelWorkflow` and `betaBranch` from its `.pkey/` manifest right after the switch deploys, not
earlier: a resync writes `channel_workflow` as NULL when the field is absent.

### Resolver jobs

Three jobs carry the resolver switch. Run each as a dry run first, then apply it from the console
(Platform → Migrations), then dry-run again. Read a run with `pkey migrate report <run>`. An apply
is pinned to the dry-run report you read; a unit whose product changed since is refused and needs
a new dry run.

| Job                                 | Dry run shows                                                                                                                                                           | Apply                                                                                                                | Down                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `update.resolver-compare`           | Per product: class counts and the worst 50 rows. `changes` is the blocking rows, the retry rows and the probes a pause left unrun. Writes nothing to D1.                | Delegated to the switch rule below. There is no apply.                                                               | Delegated. There is no down.                                                                                                                 |
| `release.backfill-store`            | Per linked product: `appRows` and `unlisted` (listed releases without `listedAssets`). `changes` is 1 for an empty store, else `unlisted`.                              | Syncs the store from GitHub, audited. A current store reports `skipped`.                                             | Does nothing: the rows are what any sync writes.                                                                                             |
| `release.materialise-workflow-beta` | Per product with a `channel_workflow`: the workflow, the beta branch, the tags the `beta` selector resolves among today, and `wouldSet` (the ids it would mark `beta`). | Sets `channel = 'beta'` on those undescribed prerelease rows whose channel is unset, audited. Re-applying changes 0. | Clears `channel` on the ids the apply recorded, only where it is still `beta` and the row is still undescribed. Rows changed since are kept. |

**The comparison run.** It probes the appcast (no `arch`, `arm64`, `x86_64`), `/version` on every
selector, and `/dl` for each file kind, architecture and checksum, plus `pr-<n>` for the pull requests
of a workflow product's last 10 successful runs. It costs GitHub calls against the product's hourly budget.
When GitHub answers 403 or 429, or reports fewer than 500 calls left, the run stops and the report
says `paused` with the time to resume. Run it again after that time: it resumes from a checkpoint
kept for an hour. Rows are `{product, surface, probe, old, new, class}`.

- **Blocking:** `stale-store` (run `release.backfill-store`, or wait for the 15-minute pass, and
  dry-run again) and `unexpected` (send it to the lead).
- **Retry:** `upstream-error`.
- **Expected** (acknowledged by count in the entries below): `beta-includes-stable`,
  `workflow-channel`, `beyond-page-cap`, `duplicate-version`, `descriptor-channel`,
  `descriptor-files`, `beta-workflow-floor`, `beta-yanked-floor-fallback`.

**The order for a workflow product.** Dry-run `release.materialise-workflow-beta`, read `wouldSet`,
and apply. Change the product's workflow to publish beta as a prerelease or with descriptor
`channel: beta`, re-run the apply, then dry-run `update.resolver-compare` until the switch rule
holds.

**The switch rule.** The resolver switches when the latest comparison report has:

1. zero blocking rows;
2. every expected row acknowledged in the entries below, by class and count;
3. for every product the job lists with a `channel_workflow`, no `workflow-channel` row whose old
   answer is a build published after the latest `release.materialise-workflow-beta` apply.

**The 15-minute pass.** The connector cron keeps each linked product's store current without a
webhook (see the GitHub sync page). Its cron report shows `freshness: synced | fresh | deferred`.
`deferred` means the tick's cap was spent (25 syncs, 8 per GitHub App installation, oldest check
first) or the product is backing off after a failed sync (`backoff`); it is synced on a later
tick. `rateLimited` and `failed` mark a sync that GitHub refused or that wrote nothing.

### License limits (`license.limits-materialise`)

Gives every license a tier and copies onto it the limits its documents get from elsewhere. Run it
after the Worker that carries it is live, before the release that switches the resolver. A dry run
writes nothing.

1. `pkey migrate dry-run license.limits-materialise`, then `pkey migrate report <run>`. Per product
   it lists `seed`, `assigned`, `writes` per field, `dangling`, `devOnlyTiers` and `docDiffs`, with
   up to 20 ids each.
2. `docDiffs` or `dangling` above 0: stop. Send the report to the lead; a document would change.
3. Apply from the console (Platform, Migrations), pinned to the run id. A killed apply resumes with
   the same call.
4. Dry-run again. It must show changes 0 and docDiffs 0. A license edited while the apply ran is
   skipped, and shows here as one change: apply that run.
5. Record both run ids under Entries.

Freeze edits to product license defaults, tier limits and license limits from step 1 until the
switch deploys; otherwise repeat steps 1 to 5.

**Roll back.** Run `down` on the apply before rolling the Worker back. It puts each column back to
its recorded value only while the column still holds the value the job wrote, and removes the
seeded Default tier once no license uses it. A later edit stays.

### Provisioned secrets (`core.provisioned-secrets-to-account`)

Moves an owned license's provisioned secrets (the keys a product's provisioning hooks declare) from
the license to the owner's account overrides row, one layer up, with every document's keys and values unchanged (the order of keys inside a document's
secrets may change once; see the SDK note below). Run it
after the Worker that carries it is live. A dry run writes nothing.

1. `pkey migrate dry-run core.provisioned-secrets-to-account`, then `pkey migrate report <run>`. Per
   product it lists `moves`, `shadowed`, `conflicts`, `otherSubject`, `unowned` and `malformed`, with
   up to 20 license ids each. No value is in the report.
2. `conflicts` or `otherSubject` above 0: send the report to the lead. Those licenses are skipped and
   keep their copy; nothing is lost by skipping them.
3. Apply from the console (Platform, Migrations), pinned to the run id. A sign-in or an edit between
   the report and the apply skips that move; the next dry run shows it.
4. Dry-run again. It must show changes 0. Record both run ids under Entries.

Why keys can reorder: a document's secrets are ordered by the layer each key first appears in, so
a moved key can change place among the others (a product with several secrets). The config ETag
covers that order, so a device sees one full config response instead of a 304, and the Node, Swift
and Kotlin `onChange` callbacks, which key on the ETag, fire once: devices may see one config
change event with identical values. The per-key `onConfigChange` compares values and stays silent.

The dry run shows the D1 query budget first: it reads the licenses, devices and owner rows per
product, so run it on a product with many licenses before the apply.

The ledger `provisioned_secret_moves` holds license ids, keys, the owner's subject and a SHA-256 of
each moved entry, never a value. Erasing an account, merging accounts, deleting a license and
deleting a product all remove or re-key its rows; the table is dropped with the job.

**Roll back.** Run `down` on the apply before rolling the Worker back. It puts each entry back on
its license, in place, only while the account row still holds the entry the job moved and the
license is still owned by the same account, and removes it from the row when the job added it and
every license of that entry has its copy back. A copy that an apply removed as hidden under the
account entry is restored from that entry. An account entry edited since stays, and so does one
whose hidden copy differed from it. If the account row could not be updated after three tries,
`down` reports a counted retry; run it again.

### Portal tables purge (`0141_a_portal_contract_purge`)

Before the release that carries the purge deploys, run the check on the environment. It is
read-only:

```sh
npx wrangler d1 execute <DATABASE> --env <ENV> --remote --file packages/worker/scripts/portal-contract-check.sql
```

1. Read the row: `unmigrated_accounts`, `identities_without_link`, `emails_without_link` and
   `unsettled_license_links` must all be 0. Record the result under Entries.
2. Any value above 0: the purge deletes nothing (its DELETEs are guarded by the sum of the same four
   counts) and the migration still succeeds. Send the leftovers to the lead before the release.
3. Note a D1 Time Travel bookmark of the environment's database before the release deploys.
4. After the deploy, required check: the four tables read 0 rows (`SELECT COUNT(*)` on each). Any row means the purge was held back; do not start the 14 days. The release that drops the tables may ship no earlier than 14 days after the zero reading.

The Time Travel bookmark from step 3 keeps the purged end-user data (emails, identities, links) for its retention window. An erasure request received in that window is still held there: do not restore to that bookmark without re-running the erasure afterwards (see Account erasure ledger and D1 restore).

**The zero reading is a hard gate.** The release that carries the purge does not deploy until the check
reads 0 on all four counts. The Worker of that release has no portal-to-account catch-up and no
settlement of a pre-existing unsettled license link (the revoke, email and audit it ran are gone);
the zero reading is what guarantees there is nothing left for either to do.

If the purge was skipped (a non-zero count at deploy), erasure no longer clears
`portal_account_emails` or `portal_account_identities`: an erased person's email and OIDC subject
stay in those two tables until the purge empties them or the drop release removes them. Do not leave it so:
re-run the check, send the leftovers to the lead to settle, then redeploy so the guarded purge
runs, and read the four tables at 0 again (step 4). Until then the 14 days do not start.

**Roll back.** Roll the Worker back, then run `scripts/rollback/0068_accounts.down.sql`: with the
tables empty it rebuilds all four exactly from the account model.

### Entries

| Date       | Row                 | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Recorded by |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 2026-10-17 | Commerce pre-check  | 0 rows in `dist_connector_settings` (`commerce`), `dist_store_products`, `dist_purchases` and `dist_purchase_bindings`. The old device paths are retired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The lead    |
| 2026-10-26 | Portal tables purge | Before v0.9.19 deployed (v0.9.18 was tagged but never deployed): `portal-contract-check.sql` on `polaris_key_prod` read 0, 0, 0, 0 (`unmigrated_accounts`, `identities_without_link`, `emails_without_link`, `unsettled_license_links`; no rows written). D1 Time Travel bookmark before the deploy: `00000e1a-00000000-00005110-2f8e912e2d1af247d03e2762822a2780`. After v0.9.19 deployed (2026-10-26 23:03 UTC; both `0141` migrations applied), `portal_accounts`, `portal_account_identities`, `portal_account_emails` and `portal_license_links` read 0 rows each. The 14 days start here: the release that drops the tables ships no earlier than 2026-11-09. | The lead    |

### Not yet removed

The settings backfill code (`core/ops/settingsBackfill.ts`, its routes and the console page) stays
until the owner confirms the production run. Its row is above.

## The blob collector

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
  deploy: a deploy-time `off` is a hard off (`ceiling` precedence).
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

## Account erasure ledger and D1 restore

A D1 Time Travel restore rewinds the whole database, so an account erased after the restore point
comes back with nothing in D1 to say it was erased. The erasure ledger is the record a restore
does not touch: one object per erased account in the existing `BLOBS` R2 bucket, key
`erasures/<account id>`, holding the opaque `acct_…` id, a version and a timestamp (no email, name
or product). It is written create-only, **before** the erasure closes the account, so a write that
fails (R2 down, `BLOBS` unbound) stops the erasure with D1 untouched and the due request is claimed
again after its 10-minute lease. No code deletes a ledger object; do not delete one by hand, and
never put a lifecycle or expiry rule on `erasures/` (DEPLOYMENT §3). A deletion that is only
scheduled (the 14-day grace period, still cancellable) is **not** on the ledger: a restore to a
point before the request was made forgets it, and the person has to schedule it again.

**When the ledger is applied.** The replay, which is the cleanup, runs only from the cron: never
synchronously with a restore and never from a request. No route, console action or restore hook
runs it, so an operator waits for the next tick. (Requests only read the ledger, see "The
request-time fence" below; none applies it.) The ticks are:

- every 15 minutes, on the connector tick (`*/15 * * * *`), as the first of the erasure steps,
  before the due-deletion and retry sweeps;
- nightly at 03:17 UTC (`17 3 * * *`), after the registry-token purge, in the early slot of the
  services' maintenance.

One pass reads the ledger in key order, in pages of 1,000 keys, at most 5 pages (5,000 ids) a
pass; a longer ledger is continued from where the last pass stopped (a KV resume marker that
expires on its own; losing it only restarts the walk). For each page, in this order:

1. **Tombstones.** An id-only `account_tombstones` row is created for every listed id that has none
   (`INSERT OR IGNORE`: an existing row is never rewritten), so nothing can recreate the account
   under that id. (The portal-to-account catch-up that once copied accounts back is gone since the purge release.)
2. **Re-erasure.** Every listed account that is live again (`status <> 'deleted'`) is handed to the
   erasure state machine, at most **25 accounts per pass**; the rest are counted as deferred, and a
   pass that stopped at its page bound with accounts deferred resumes from the same point, so they
   are read first. The state machine closes the account in one batch (status `deleted`, sessions
   deleted, package-registry tokens revoked; another Worker isolate may keep a cached registry
   token for up to 30 seconds), then runs the stores' per-person deletes and the final erasure
   again. Developers receive `subject.deleted` again. An account already at `deleted` is left to
   the retry sweeper and its back-off (15 minutes, 1 hour, 4 hours, 12 hours, then 24 hours).
3. **Mirror.** D1 erasure tombstones (never merge tombstones) that the ledger lacks, from erasures
   that finished before the ledger shipped, are copied into it, at most **100 per pass**, over the
   key range the pages covered.

Every step is idempotent: a pass over a consistent state changes nothing. A single account that
fails is recorded and the pass goes on; an unreachable R2 or D1 fails the step.

**The request-time fence.** Every request that acts as an account reads the ledger first: one HEAD
of `erasures/<account id>` in the `BLOBS` bucket, remembered per Worker isolate (an erased answer for
the isolate's life, a not-erased answer for 30 seconds). It needs no new binding, queue or secret.
An account on the ledger is refused from the moment a restore lands, before the replay runs:

- sign-in through every front door (email code or link, providers and the email gate, passkeys,
  single sign-on, product sign-in through the platform IdP) is refused with the same answer as a
  disabled account, and so is a join offer to it;
- the portal API answers `401` to its session cookies; a product browser session reads signed out
  and its record is ended; an approved sign-in on another device is refused; licensed download
  links answer `404`;
- package-registry tokens a person minted from the portal resolve to nothing, as a revoked token
  does;
- devices bound to the account cannot attach a license or read its subject; joining, linking,
  undoing a join and relinking a license to it are refused.

**It fails closed.** With `BLOBS` unbound or R2 failing, nothing is let through for an account: the
portal API answers `503 unavailable` (the browser keeps its cookie and retries), sign-in is refused,
a product browser session reads signed out but its record is kept, an approved device sign-in or a
download answers `503` without being spent, and a portal-minted package token resolves to nothing.
Public feeds keep working; tokens no account owns (console and operator tokens) and CI tokens are
not asked.

**The replay is still the cleanup.** It closes the restored account in D1 and erases what the
restore brought back (tombstone, data, tokens). Its timing no longer decides whether a restored
account can be used; it decides how long its rows sit in the restored database. That is up to one
connector tick (15 minutes), and longer when:

- more than 25 accounts came back: each pass re-erases 25, so _n_ accounts need ⌈_n_ ÷ 25⌉ passes
  (1,000 accounts: 40 passes, about 10 hours of 15-minute ticks);
- the ledger holds more than 5,000 ids and the account is past the pages a pass reads (the walk
  needs ⌈ids ÷ 5,000⌉ passes to reach every id);
- re-erasing an account failed (it is retried on the next pass).

**What stays open after a restore.** The fence is the in-repo control; there is still no maintenance
mode, read-only switch or traffic switch, and none should be assumed.

- The console's Users page, per-user detail and export are staff-only reads and are **not**
  fenced: until the replay erases the rows they can still list a restored erased account's contact
  address and activity. Staff should not act on those rows.
- Cloud Sync and account overrides identify a device by its token and its subject binding, not by
  the account (`syncAccess`, `accountOverrides`), so they are **not** fenced: a device still bound
  to a restored erased account's subject keeps that access until the replay clears the binding.
- The not-erased answer is remembered for 30 seconds per isolate, so an erasure recorded by another
  isolate in the last 30 seconds is unseen by this one for up to that long. The isolate that
  recorded the erasure knows at once.
- A `503` from the fence is not a signal that a restore happened. The evidence of the replay is the
  `platform_job_runs` rows of step `erasureLedger` (below).

### Restoring D1

1. Follow the Time Travel commands in `docs/security/arch/operational-resilience.md` §5
   ("Point-in-time restore"): capture the current bookmark first (the restore is in place and
   destructive), find the target bookmark, then
   `npx wrangler d1 time-travel restore polaris_key_prod --env prod --bookmark <bookmark>`.
   Time Travel reaches back 30 days. Restoring to the undo bookmark afterwards is safe for erasures
   too: the ledger lives outside D1, and the replay applies it again whichever state D1 is in.
2. Leave R2 alone. The restore does not touch `BLOBS`; do not empty, replace or re-point the
   bucket, and keep the `BLOBS` binding in `wrangler.toml` for the environment. With no binding the
   fence refuses account sign-in and portal API calls with `503`, the replay does nothing and every
   account erasure refuses to start.
3. Note the restore time (UTC). Accounts on the ledger are refused from the moment the restore
   lands; the replay then erases what came back, on the next connector tick (the nightly tick is
   the second chance). Nothing here can be forced or sped up, and the console Users rows stay
   visible until it has run (see "What stays open").
4. Verify **after** that time. `platform_job_runs` is in D1, so the restore rewound it too: only
   ticks that ran after the restore appear.

   ```sh
   cd packages/worker
   npx wrangler d1 execute polaris_key_prod --env prod --remote --command \
     "SELECT job, cron, datetime(started_at/1000,'unixepoch') AS started_utc, outcome, rows_affected, error_summary FROM platform_job_runs WHERE step = 'erasureLedger' ORDER BY started_at DESC LIMIT 12"
   ```

   (`started_at` is epoch milliseconds.) The same rows are on the console's Status page
   (`GET /manage/api/platform/operations`, `jobs`). `rows_affected` is the sum of tombstones
   created, accounts re-erased and ledger copies made in that pass: expect it above 0 on the first
   tick after a restore that brought erased accounts back, then 0 once D1 and the ledger agree.
   **A `connectorPoll` row never shows a failure**: the 15-minute tick keeps only the count, so a
   replay that threw is recorded there as `ok` with `rows_affected` 0. Only the nightly
   (`maintenance`) row can be `failed`; its `error_summary` names up to ten opaque account ids with
   the failing step (`reapply` or `mirror`). Read a 0 on the poll tick together with the nightly
   result, never alone. Likewise only the nightly run records a failed `accountDeletions` step
   (due scheduled deletions) or `erasures` step (an erasure that failed 5 times, named by id and
   step).

5. For a specific account id (from the ledger, or from the person's report), check D1 directly:
   `SELECT id FROM account_tombstones WHERE id = '<id>'` should return the row;
   `SELECT id, status FROM accounts WHERE id = '<id>'` should return nothing once the erasure has
   finished, or `status = 'deleted'` while it is being resumed; `SELECT attempts, failed_step,
last_error FROM account_erasures WHERE account_id = '<id>'` shows a resumed erasure's progress.
   The repo has no command that lists the ledger itself; the R2 dashboard's object browser shows
   the `erasures/` prefix.

**Limits to know before relying on it.**

- Erasures that finished **before** the ledger shipped are protected only once the mirror has copied
  them (100 per pass). A restore to a point before such an account's tombstone existed, made before
  that copy, brings the account back usable, with nothing to refuse or re-erase it. After the first
  deploy that has the erasure ledger, do not restore D1 to a point earlier than the deploy until the `erasureLedger`
  count on the connector ticks has stayed at 0 for a day. No recorded signal says the mirror is
  complete, only that a pass did nothing.
- The ledger is one bucket with no other copy. R2 is outside Time Travel and the repo configures
  no backup of it; a lost or emptied bucket loses the ledger. So does a ledger object deleted by
  hand or by a lifecycle rule: the fence and the replay both read it, and both lose that account.

**Troubleshooting.** A wave of `503 unavailable` on the portal API, sign-in refusals or signed-out
product sessions while R2 is degraded or `BLOBS` is unbound is the fence failing closed, not an
account problem: restore R2 or the binding and signed-in clients carry on. An unreadable ledger
clears no portal cookie and ends no product browser session; it only refuses until it can be read.

## Release-file mirroring

Polaris Key keeps its own copy of every app-release file whose bytes live only on GitHub or at an
external URL, so downloads are served from R2 and GitHub stays the fallback.
A truth-store sync (the GitHub `release` webhook), a resync and a descriptor ingest queue the
files that owe a copy to `pkey-assets-<env>`; the request Worker consumes them
(`services/release/mirror.ts`). A copy is promoted only when its bytes are GitHub's `digest` and
the descriptor's `sha256`; then an `r2` location is appended to the file's `locations_json`. No
signed document, byte URL or client changes, so nothing here needs a client release. Filling a synced file's missing `sha256` (from the verified hash) does change unsigned feeds: a release whose file had no recorded hash becomes eligible for the feeds that need one (Scoop, Flathub, winget, AltStore), which then list it.

A release file's pull may take up to 10 minutes (30 s plus a second per 10 MiB). The consumer runs
hosted-asset pulls first and starts no mirror once 4 minutes of a batch are spent, so a batch stays
inside the 15-minute wall clock; a mirror not started is retried a minute later.

- **Backfill:** the nightly maintenance sweep's `releaseMirrors` step queues at most 100 owed
  files a night, across products, oldest-due first and newest releases first. On the first deploy
  that is the backfill of every existing release (DJDL: 72 files, 2.67 GiB); afterwards it only
  retries failed files once their back-off elapses (15 minutes doubling to a day).
- **Mirror a product now:** `POST /manage/api/products/<slug>/assets/mirror` queues every file the
  product still owes at once, a failed file's back-off or not (a file whose message is still in
  flight is skipped, so repeating the request never downloads twice), at most 200 per request, and answers
  `{queued, owed}`. Repeat until `owed` reaches 0 (`owed` counts the files just queued until their
  messages are delivered). Audited as `assets.mirror`.
- **What happened to a file:** `release_mirrors` (one row per queued file: `status` `queued`,
  `ready` or `failed`, `error`, `attempts`, `next_attempt_at`), the product's audit
  (`release.mirror` per appended location, `assets.ingest` per pull, refused or not), and
  `GET /manage/api/products/<slug>/assets`, which lists each copy as a `release-file:<sha256>` slot.
- **Reason codes:** `digest-mismatch` (the descriptor's `sha256` and GitHub's `digest` disagree:
  fix the release, never the mirror), `no-digest` (nothing to verify against), `size-mismatch`,
  `too-large` (over R2's 4.995 GiB single put), `github:404` (the asset is gone), `github:lookup`,
  `github:rate-limited`, `no-access` (no installation token), `no-source`, and every ingest reason
  (`sha256-mismatch` for corrupted bytes, `status:<n>`, `timeout`, `network`, `guard:<reason>`).
  A failed file keeps serving from GitHub.
- **Stop it:** until the console registers `assets.releases.mirror` (per product) and
  `assets.hosting.enabled` (platform), mirroring is on for every product that runs Release. Copies
  already made stay valid either way: their locations are hash-pinned, and both refs that hold a
  copy (`hosted-asset` for the copy, `release-artifact` for the location) are never dropped by the
  blob collector.

## Lazy deltas

When install telemetry shows at least 25 devices (per product, configurable) moving between the
same two payloads of a container pack within 7 days without a delta, and the pack's record has no
CI delta from that base, the consumer Worker `polaris-key-deltas-<env>` encodes a level-9
`zstd-patch-from` delta in WebAssembly, verifies it, and stores it at
`deltas/<from>/<to>.zstd-patch-from` (or under `gated/`) with a `ready` row in
`release_lazy_deltas`. Pairs with a side over 32 MiB are refused as `over-worker-cap` (the
evidence for a Container tier). Setup is DEPLOYMENT §3 "Lazy deltas".

- **Turn it on.** In the console, Platform → Settings → Lazy deltas → on
  (`PATCH /manage/api/platform/settings/LAZY_DELTAS` with `{"value":"on","expectedVersion":N}`).
  No deploy: both scripts read the same `platform_settings` row (the request Worker within 30
  seconds, the consumer on its next message). It only takes effect while both TOML files carry
  `LAZY_DELTAS = "runtime"` (the committed value); `"off"` there is a deploy-time hard off. Then
  opt a product in: its Settings → Lazy deltas (`deltas.lazy.enabled`). Devices that make a
  pair hot (`deltas.lazy.hotDevices`, default 25) and deltas built a day (`deltas.lazy.dailyCap`,
  default 20) are beside it. No SQL: the console writes and audits each change. (It used to
  be a row in `lazy_delta_settings`; migration 0124 copied each row once; migration 0140
  dropped the table.)

- **Turn it off.** Lazy deltas off for one product (counting and generation stop at once), or the
  console's Lazy deltas switch for everything (within 30 seconds). For an off no console session
  can undo, set `LAZY_DELTAS = "off"` in both TOML files and deploy both. Stored deltas stay until
  they go cold.
- **The size cap.** `LAZY_DELTA_MAX_BYTES` in `wrangler.deltas.toml` (32 MiB) is the deploy-time
  value; Platform → Settings → Lazy delta size cap may only lower it (1 MiB to 32 MiB, the
  measured ceiling).
- **Withdraw the menu.** The channel feed lists a product's `ready` lazy deltas in its
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
  above 32 MiB is hot: the case for a Container tier), `verify` (escalate: the encoder disagreed with
  itself).
- **Cold deltas.** A ready delta no device reported for 30 days is marked `cold` and loses its
  `lazy-delta` ref; the blob collector then reclaims it under its usual grace and lock rules. If
  devices come back to the pair, the sweep re-queues it.
- **The DLQ.** `pkey-deltas-dlq-<env>` has no consumer: messages that failed 3 times wait there
  and expire after 4 days. Alert on its depth (`npx wrangler queues info pkey-deltas-dlq-<env>`);
  a growing DLQ means the consumer is throwing (read its logs: `npx wrangler tail
polaris-key-deltas-<env>`).
- **Live checks after the first deploy**: one pair at the 32 MiB cap, watching
  the consumer's logs for Error 1102 or "exceeded resource limits"; the consumer's reported CPU
  ms; the R2 event-to-consumer latency; and a re-PUT of the same object producing one delta.

## Device-code approval deploy window

The release that added device-code approval adds an approval step to every device-code sign-in. There is no flag, migration or
backfill, and nothing in flight is grandfathered. A flow that was already past the IdP callback
holds an identity but no `approvedAt`: its device's poll answers `pending` until the flow expires
(at most 600 seconds), then `timeout`, and the person gets a new code. A flow that has not reached
the callback gets the approval page as normal. Deployed SDKs need no release: they see one more
browser press, and Deny ends in their generic failure. Roll back only in an availability emergency:
an older Worker ignores `approvedAt`, so flows waiting at the approval page would complete at their
next poll. Count approved, denied and expired-unapproved flows from the audit rows
`identity.signin.device_approved` and `identity.signin.device_denied`.

## Customer host (Polaris Locker)

The customer site (Polaris Locker) is a second host on this Worker, `CUSTOMER_ORIGIN`; the console
(`key.plrs.im`) is the backend side. There is no switch: the host is on exactly when
`CUSTOMER_ORIGIN` is a usable origin, so the cutover is the deploy that sets it. The deploy smoke
check covers it.

**Cut over.** Before the deploy: the customer host's callbacks are registered with each sign-in
provider, and `polaris.locker` is active in the account. Deploy. Customer links, discovery's
`accountPortal` and the device code page move together, and the old customer pages on `key.plrs.im`
redirect to the same path on the customer host (`301` for pages, `302` with `no-store` for a path
that carries a token or code). `/signin?request=` stays on the API host (the sign-in bind hop). Watch
sign-in after the deploy.

**Roll back.** Remove `CUSTOMER_ORIGIN` from `[vars]` (and the customer routes) and redeploy. Links
return to the console origin and the redirects stop. A browser that has seen a `301` keeps it until
its cache is cleared, so a rolled-back customer page can still land on the customer host: keep the
host attached (or let it serve) until that has aged out. Rolling the Worker back below the release that added the customer host while
the custom domain is attached leaves the host serving the console's routes.

**Rollback floor.** The floor is the first release with the customer routes in `wrangler.toml`.
Never roll the Worker back below the release that added the customer host while `polaris.locker` is attached: the older
code does not know the host and would serve it the console and every product route.

**Emergency detach.** After removing `CUSTOMER_ORIGIN`, delete the Worker custom domain `polaris.locker` in
the dashboard (Worker → Settings → Domains & Routes), or remove the customer
`[[env.<env>.routes]]` entry and redeploy. The host then stops resolving to the Worker; the API
host is untouched. Detach before rolling back below that release.

## CI gates

`.github/workflows/ci.yml` runs on PRs and `main` pushes. **`CI OK` is the one required check**
(branch protection: require it and nothing else); it passes when every job passed or was skipped
by scope.

- `js` always runs: JS/TS build, typecheck, tests (the adapter conformance suites included),
  lint, the production-dependency audit, `pnpm gen --check` (the conformance corpus among the drift
  gates), the admin build and the docs link check.
- The other lanes (workerd smoke, Node floor, browsers, console, UI kits, React kit, Python, the
  Swift SDK and Apple plugin (four macOS jobs: `apple`, `apple-hosted`, `apple-footprint`,
  `apple-plugin`, one lane because they read the same paths), the Swift floor, Kotlin, Android, Godot) run when a
  changed path is one of the lane's `paths` in `tools/ci-scope.json`, or one of its `shared` inputs
  (the contract, the shared packages, `tools/`, `.github/`, the lockfile). A lane's `paths` list
  what its job reads, not only its own tree: the Python lane names the Python samples under
  `examples/` and the two cross-SDK fixtures its tests open (`sdks/godot/tests/qr/fixtures.json`,
  `docs/design/ui-kits/terminal-parity.json`), and a rename counts at its old path and its new one.
  The `changes` job decides this through `tools/ci-scope.mjs`. `pnpm gate` (`tools/gate.mjs`) asks the
  same script, so a local run picks the same lanes as CI for the same files.
  A new lane or matrix is one entry in that file and one job in `ci.yml`
  (`tools/ci-scope.test.ts` fails when the two disagree).
- A pull request runs the floor and the latest of each matrix (Python 3.9 and 3.14 on Linux, Godot
  4.7.2 and 4.4.1, Kotlin desktop on Linux, emulator API 24 and 36); `main` pushes run every lane
  and the full matrix (Python on macOS too, all four Linux Godot engines and the Windows and macOS
  smokes, Kotlin desktop on macOS and Windows, emulator API 34). So does a pull request whose
  changed files `git` cannot list: every lane, every matrix in full.
- `swift-floor` keeps the Swift SDK building on the oldest toolchain it supports, Xcode 16.4 (Swift
  6.1) on macos-15. `PolarisKeyPlatform`'s Xcode 26+ code is behind `#if compiler(>=6.3)`, so
  `apple` (Xcode 26.6) compiles only the guarded branch and this job compiles the other. It builds
  the package and the iOS schemes; the package's tests run once, on `apple`. Its lane is the
  package alone (`sdks/swift/`), where `apple`'s also takes the Godot addon, the CLI and the kit
  lint. `sdks/swift/tools/select-xcode-16.sh` fails it unless the compiler is Swift 6.0 to 6.2.
- `ci.yml`, `native-desktop.yml` and `feed-closure.yml` set up pnpm, Node and the install through the
  composite action `.github/actions/setup-js`. `native-desktop.yml` runs only for its own paths, and
  its filter lists the composite action too: a change to it changes those jobs
  (`tools/ci-scope.test.ts` fails when a workflow's path filter leaves out a local action its jobs
  use). The release and secret-holding workflows (`deploy.yml`, `publish-sdks.yml`,
  `npm-repair.yml`, `sync-worker-secrets.yml`) keep their steps inline: `npm-repair.yml` checks out
  an old tag that has no local action, and `syncWorkerSecretsWorkflow.test.ts` and
  `releaseWorkflows.test.ts` pin those steps to commit SHAs.

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
  `noreply@plrs.im`); "Sign-in email" above has the setup and the DNS check.

DJDL OIDC activation fails with `platform oidc is not configured`:

- Check `PLATFORM_OIDC_ISSUER` and `PLATFORM_OIDC_CLIENT_ID`.

Custom-product OIDC activation fails with `oidc client secret unavailable`:

- Set the product secret named by that product's `oidc.clientSecretSecret`.

Repo-link or release sync cannot access GitHub:

- Confirm GitHub App `polaris-key` is installed on the product repo.
- Confirm Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
  `GITHUB_WEBHOOK_SECRET`.
- Confirm the app has Contents: read and Actions: read.

Every product route 404s at once (JWKS, `/config/document`, `/license/activate`, appcast), with nothing in the
admin broken:

- This is the KEK failure signature. `loadProduct` swallows a sealed-value error and returns
  `null`, so a product whose signing key cannot be opened looks exactly like a product that
  does not exist.
- `curl -fsS https://key.plrs.im/manage/api/products/kek -H "cookie: __Host-pkey_admin=…"`:
  - `503` — the keyring itself does not parse; the message names the offending variable. _both
    define kid … with different keys_ means `PLATFORM_KEK` and `PLATFORM_KEK_KEYS` disagree on
    one kid: give the new key another kid in `PLATFORM_KEK_KEYS` (Secrets → Rotating when the old
    KEK is unknown).
  - `unopenable > 0` — a KEK was removed from `PLATFORM_KEK_KEYS` while rows were still sealed
    under it. Put that kid back, then run the sweep (Secrets → Rotating PLATFORM_KEK, step 6).
  - `countsComplete: false` — a managed-payload table holds more envelope-carrying rows than one
    scan reads (`countsTruncated` names it), so `remaining` is a floor, not a total. The old key
    is not provably unused: leave it in the ring (Secrets → Rotating PLATFORM_KEK, step 8).
- Check whether `PLATFORM_KEK_ID` was set or changed. It renames the kid, which orphans every
  existing blob; unset it, or add the old kid to `PLATFORM_KEK_KEYS` instead.
- Check whether a `wrangler rollback` restored a pre-rotation keyring.

Deploy fails on bindings:

- Production's D1 and KV ids in `packages/worker/wrangler.toml` are real. Only staging and dev
  carry `REPLACE_ME_*` placeholders (`REPLACE_ME_STAGING_D1_ID`, `REPLACE_ME_STAGING_KV_ID`,
  `REPLACE_ME_DEV_D1_ID`, `REPLACE_ME_DEV_KV_ID`). A staging or dev deploy fails until those are
  replaced with the ids `wrangler d1 create` and `wrangler kv namespace create` print for that
  environment.
