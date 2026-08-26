# R5 — Multi-tenant isolation & IDOR

Lane: a legitimate customer or product operator reaching another tenant's data, licenses,
devices, secrets, or config.

Tree: branch `lewd-owl` at HEAD `bd26e0b`. All line numbers are against that tree.

PoC file: `packages/worker/test/attack/R5-isolation.test.ts` — **16 tests, all green**
(`npx vitest run test/attack/R5-isolation.test.ts` under Node 22). No source file was
modified. Typecheck (`npx tsc --noEmit`) is clean.

## Summary

| ID    | Severity | Title                                                                                        | PoC            |
| ----- | -------- | -------------------------------------------------------------------------------------------- | -------------- |
| R5-01 | High     | Cross-tenant license injection into any portal account via an unverified OIDC email          | ✅ proven      |
| R5-02 | High     | The portal↔license `sub` join is qualified by neither product nor issuer                     | ✅ proven      |
| R5-03 | High     | GitHub App installation tokens are minted un-scoped; the cache scope is inconsistent         | ⚠️ code-proven |
| R5-04 | High     | One `PLATFORM_KEK` unwraps every tenant's signing keys and secrets; no per-tenant derivation | ⚠️ code-proven |
| R5-05 | Medium   | Portal rate-limit buckets have no product dimension and share one global DO shard            | ✅ proven      |
| R5-06 | Medium   | `portalAuthCapabilities` aggregates every tenant, so one tenant overrides another's opt-out  | ✅ proven      |
| R5-07 | Medium   | No tenant-scoped admin role exists; the only admin role owns every tenant                    | ✅ proven      |
| R5-08 | Medium   | Edge-mint recipes are not entitlement-gated (intra-tenant IDOR)                              | ✅ proven      |
| R5-09 | Medium   | A single global `GITHUB_WEBHOOK_SECRET` authenticates all tenants' repo webhooks             | ⚠️ code-proven |
| R5-10 | Low      | `getPortalDownloadToken` is not product-scoped and `row.product` is trusted as scope         | ✅ proven      |
| R5-11 | Low      | The rate-limit DO never reclaims storage, contradicting its own comment                      | ⚠️ code-proven |

"code-proven" = established by reading the code and its call sites; not reproduced as a
runtime test because it needs live GitHub/KEK infrastructure.

Six seeded hypotheses were **partly or wholly refuted** — see the REFUTED section.

---

## R5-01 — Cross-tenant license injection into any portal account via an unverified email

**Severity: High.** Cross-tenant integrity violation. A single tenant (or any user of a
tenant whose IdP it controls) writes an arbitrary row into any other user's portal account
platform-wide, with attacker-controlled display strings rendered in a trusted surface.

**Files**

- `packages/worker/src/oidc.ts:674-681` — `mapClaims` returns
  `email: typeof payload.email === "string" ? payload.email : undefined`. There is **no
  `email_verified` check**. Contrast `packages/worker/src/portal/auth.ts:113-128`, which
  computes `emailVerified` and at `:286` passes `email: identity.emailVerified ? identity.email : undefined`.
- `packages/worker/src/oidc.ts:426`, `:449` — `activateFromIdentity` writes
  `email: identity.email ?? null` into `licenses.email`.
- `packages/worker/src/portal/repo.ts:275-278` — the join, with **no `product` predicate**:
  ```sql
  SELECT product, id FROM licenses WHERE lower(email) = ?
  ```
- `packages/worker/src/portal/api.ts:294`, `:330`, `:609`; `portal/auth.ts:292`, `:389` —
  `syncAccountLicenseLinks` runs on **every authenticated portal request** and on every login.

**Preconditions.** One product configured with `oidc_config.provider = 'custom'` (migration
`0009_oidc_provider.sql`) pointing at an issuer the attacker influences — a tenant's own
Keycloak/Authentik/Okta, or any IdP that permits self-service profile-email editing or omits
`email_verified`. That issuer is outside the platform's trust boundary, but the email it
asserts becomes a **platform-wide join key**.

**Exploit steps**

1. Attacker signs in at `GET /evilco/auth/start` → their own IdP.
2. The IdP returns an ID token with `email: ceo@victim-corp.example` and no (or false)
   `email_verified`. `mapClaims` accepts it; `activateFromIdentity` persists it.
3. The victim, who has never heard of `evilco`, signs in to the **root** portal with their own
   genuinely-owned inbox.
4. `syncAccountLicenseLinks` scans **all tenants'** `licenses` for `lower(email)` and writes a
   `portal_license_links` row for the attacker's license into the victim's account.
5. `GET /api/licenses` returns it, including the attacker-controlled `name` (`"ACME Billing
Support"` in the PoC) and product branding.

**Impact.** Phishing inside an authenticated, branded, trusted surface; unconsented mutation
of the victim's account state; the victim's account gains `hasLinkedProductLicense` for the
attacker's product (`portal/api.ts:562`, `:663`), unlocking that product's release listing and
download-token minting for them. Because the query has no `product` predicate and `licenses`
carries **no email index at all** (only `idx_customers_email`, a different table), it is also a
full cross-tenant table scan on every portal request — an O(all tenants' licenses) cost paid
per request.

**PoC** — `R5-01 cross-tenant license injection by unverified email` (2 tests). Asserts the
unverified claim is persisted verbatim, and that `GET /api/licenses` for the victim returns
`[acme, evilco]` when the victim only ever transacted with `acme`.

**Fix direction.** Three independent fixes, all worth doing:

1. Gate on `email_verified` in `oidc.ts:mapClaims`, exactly as `portal/auth.ts` already does.
2. Never join on a bare email. Link a license to a portal account only through an explicit,
   auditable claim (the existing `license-key` claim flow, `portal/api.ts:350`), or require the
   license's product to have opted into email linking AND the email to be verified on **both**
   sides.
3. If email linking is kept, scope the query by product and drive it from
   `portal_license_links` intent rather than a platform-wide scan.

---

## R5-02 — The portal↔license `sub` join is qualified by neither product nor issuer

**Severity: High.** Subjects minted by N mutually-untrusted identity providers are compared in
one flat global namespace.

**Files**

- `packages/worker/src/portal/repo.ts:296-299`:
  ```sql
  SELECT product, id FROM licenses WHERE sub = ?
  ```
- Left side: `portal_account_identities.subject`, always minted by the **platform** IdP
  (`portal/auth.ts:281-290` hardcodes `provider: "oidc"`, issuer from `platformOidcConfig(env)`).
- Right side: `licenses.sub`, written by the **per-product** flow (`oidc.ts:350`, `:447`), where
  the issuer may be tenant-controlled.
- Schema: `migrations/0008_portal.sql:24-33` — `portal_account_identities` PK is
  `(provider, subject)`; `provider` is the literal `"oidc"` for every row, so the issuer is not
  recorded anywhere. `migrations/0001_init.sql:81` scopes `idx_licenses_sub` to
  `(product, sub)` — that index cannot even serve this query.

**Preconditions.** Any tenant running a custom OIDC issuer. That tenant chooses its own subject
namespace with no constraint.

**Exploit steps**

1. Victim signs in to the root portal; the platform IdP assigns subject `1000`.
2. `evilco` runs its own issuer and mints a license with `sub = "1000"` — a value it picks
   freely, with a completely unrelated email.
3. On the victim's next portal request, `syncAccountLicenseLinks` links `evilco`'s license into
   the victim's account with `source = 'oidc'`.

**Impact.** Same as R5-01, but it bypasses the email fix entirely and is not mitigated by
`email_verified`. Severity is driven by the _structure_: there is no issuer dimension, so the
only thing preventing collisions is luck about subject formats across independent IdPs. Note
`migrations/0001_init.sql:173-178` defines an `identity (product, sub)` table that would have
carried the tenant dimension — it has **zero references** in `src/`.

**PoC** — `R5-02 cross-issuer OIDC subject collision`. Asserts `listPortalLicenses` for the
victim returns the attacker's license, linked by subject alone, with `source = 'oidc'`.

**Fix direction.** Record the issuer with the subject on both sides
(`licenses.sub_issuer`, `portal_account_identities.provider` = the real issuer URL) and join on
`(issuer, subject)` plus `product`. Or drop the implicit sub-join entirely in favour of the
explicit claim flow.

---

## R5-03 — GitHub App installation tokens are minted un-scoped; the cache scope is inconsistent

**Severity: High.** One tenant's release pipeline holds a credential valid for every other
tenant's repository in the same installation.

**Files**

- `packages/worker/src/release/githubApp.ts:218-228` — the mint:
  ```ts
  const url = `${GITHUB_API}/app/installations/${installId}/access_tokens`;
  const post = (): Promise<Response> =>
    fetchImpl(url, { method: "POST", headers: githubHeaders(`Bearer ${jwt}`) });
  ```
  **No request body at all** — no `repositories`, no `repository_ids`, no `permissions`. GitHub
  therefore returns a token with the installation's _full_ scope.
- `packages/worker/src/release/githubApp.ts:210` — the cache key:
  `pk(product, "gh-token", String(installId))`, TTL 3300s (`:21`, `:232`, `:236`).
- Callers disagree about what `product` means:
  | Call site | 2nd argument | Actual value |
  | --- | --- | --- |
  | `release/linkRepo.ts:123` | `repo` | **GitHub repo name** |
  | `release/resync.ts:97` | `repo` | **GitHub repo name** |
  | `release/index.ts:269-275` | `product` | product slug |
  | `release/health.ts:166-172` | `product` | product slug |
- App credentials are platform-global: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`
  (`release/githubApp.ts:127-132`), and `discoverInstallation` (`:140-161`) resolves an
  installation for any `owner/repo` the App can see. The per-product
  `release_config.gh_installation_id` (`migrations/0001_init.sql:126`) is a data pointer, not a
  cryptographic boundary.

**Impact.** If the App is installed org-wide (the common case), product A's resync/appcast path
holds a token that reads _and writes_ product B's repository. The docstring at `:198-202`
asserts the cache key "is product-scoped so two products that share a GitHub App … never
collide" — in fact `installId` is what prevents collision, `product` contributes nothing to
correctness, and it is **not even consistently a product**. Two products whose repos share a
bare name (`owner1/app`, `owner2/app`) both write to `p:app:gh-token:*`; nothing validates that
the argument is a real slug.

**PoC status.** Code-proven (needs a live GitHub App to demonstrate at runtime).

**Fix direction.** Send `{"repositories": [repo], "permissions": {...}}` on the token mint —
GitHub down-scopes to exactly that. Change `getInstallationToken`'s second parameter to a typed
`ProductSlug` and fix `linkRepo.ts:123` / `resync.ts:97`. Include the down-scope in the cache
key so a narrow and a broad token can never alias.

---

## R5-04 — One `PLATFORM_KEK` unwraps every tenant's signing keys and secrets

**Severity: High** (Critical if you weight blast radius over exploitability). Single point of
total cryptographic failure across all tenants.

**Files**

- `packages/worker/src/keyvault.ts:67-83` — `importKek` takes `env.PLATFORM_KEK`, requires
  exactly 32 bytes, and imports them **directly** as the AES-256-GCM key. `grep -rn
"HKDF\|deriveKey\|deriveBits" packages/worker/src/` returns **zero hits** — there is no
  per-tenant key derivation anywhere.
- `packages/worker/src/keyvault.ts:59-63` — the product slug appears only in the AAD:
  `pkey:v2:${ctx.product}:${ctx.kind}:${ctx.id}`. AAD is authentication context, not key
  separation: a KEK holder simply supplies the matching AAD, every component of which is
  readable from the D1 row.
- Sealed material: `product_keys.enc_private_json` (per-product Ed25519 signing key, PKCS#8) and
  `product_secrets.enc_value_json` (`migrations/0003_keyvault.sql:7-30`). The latter backs
  **OIDC client secrets** (`oidc_config.client_secret_secret` → `oidc.ts:143-148`) and
  **edge-mint signing keys** (`edge_mint_config.signing_key_secret` → `edgeMint.ts:198`).

**Blast radius of one KEK + one D1 dump:** every product's Ed25519 private signing key (active,
staged and retired) → forge signed config docs and trust manifests for **every tenant**
indefinitely; every custom OIDC client secret; every edge-mint private key; every operator-stored
per-product secret.

**Aggravating factor.** `packages/worker/src/env.ts:17-30` shows the KEK sits in the same flat
env blob as eight other platform-global secrets, each independently sufficient for a different
total compromise: `KEY_HASH_PEPPER` (HMAC key for _every_ license key and device token),
`ADMIN_SESSION_SECRET`, `PORTAL_SESSION_SECRET` (which **falls back to `ADMIN_SESSION_SECRET`**,
`portal/session.ts:62`), `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`PLATFORM_OIDC_CLIENT_SECRET`. None has a tenant dimension. `PLATFORM_KEK_ID`
(`keyvault.ts:106`, `:135`) is a bare equality tag, not a KDF input, so there is no dual-KEK
rotation window — rotation requires re-sealing every row.

**PoC status.** Code-proven. Note the test fixture itself illustrates the property:
`test/seed.ts:31` uses one constant `TEST_KEK` to seal every product's key.

**Fix direction.** Derive a per-tenant DEK: `HKDF(PLATFORM_KEK, salt = product, info =
kind||id)`, keeping the AAD as-is. This bounds a single-tenant key leak to that tenant and makes
per-tenant rotation possible. Longer term, move the KEK to an external KMS so the Worker never
holds raw key bytes, and split `KEY_HASH_PEPPER` per tenant.

---

## R5-05 — Portal rate-limit buckets have no product dimension and share one global DO shard

**Severity: Medium.** Cross-tenant denial of service, plus a platform-wide availability
chokepoint.

**Files**

- `packages/worker/src/rateLimit.ts:23` — `env.RL.get(env.RL.idFromName(product))`.
- `packages/worker/src/portal/api.ts:264-285` — `requireActionRateLimit` builds
  `id: \`${session.accountId}:${clientIp(req)}\``and passes the literal`"\_portal"`as the
shard. **No product anywhere.** Buckets:`portalClaimKey` (`:358`, limit 10),
`portalDeviceDisconnect` (`:431`, limit 20), `portalDownloadToken` (`:545`, limit 60).
- The limiter fires **before** authorization: in `handleDeviceDelete` the check is at `:431`
  while `getPortalProductSettings`/`getPortalLicense` are at `:440-448`; in `handleReleases` the
  check is at `:545` while `getProduct` is at `:555`.
- `"_admin"` (`admin/auth.ts:152`, `:197`) and `"_portal"` (`portal/auth.ts:174`, `:311`,
  `portal/api.ts:275`) are literal constants → **exactly one Durable Object instance each,
  platform-wide**, serializing a storage read+write for every admin sign-in, portal sign-in,
  magic-link request and portal action across all tenants.
- `portalLogin` / `portalMagic` / `adminLogin` / `adminCallback` key on bare `clientIp`, so every
  tenant's operators behind one NAT egress share a single 20/min (or 8/min) budget.

**Impact.** An account's budget spent on tenant A 429s tenants B, C, D — and it is spent by
requests that never pass authorization, so a user who does not own _any_ license can burn it.
The two global shards are a hard availability bottleneck and the most attractive DoS target
because reaching them needs no valid tenant.

**PoC** — `R5-03 cross-tenant rate-limit bucket sharing`. Twenty unauthorized `DELETE`s against
`acme` (each 404) exhaust the budget; the 21st `acme` call **and** a first call against `evilco`
both return 429.

**Fix direction.** Put the product in the bucket id (`${product}:${accountId}:${ip}`) and shard
the DO by product for product-scoped actions. Move the limiter _after_ the ownership check, or
add a separate much-cheaper pre-auth limiter. Sub-shard `_admin`/`_portal`
(`_portal:${hash(ip) % N}`).

---

## R5-06 — `portalAuthCapabilities` aggregates every tenant

**Severity: Medium.** A tenant-scoped setting is evaluated globally, so one tenant overrides
another's explicit opt-out.

**File.** `packages/worker/src/portal/repo.ts:496-516` — `SUM(CASE …)` over
`products LEFT JOIN portal_product_settings` with **no product predicate**; callers treat
`> 0` as "enabled". Reached **pre-authentication** at `portal/auth.ts:179`, `:230`, `:316`,
`:379` and `portal/api.ts:306`.

**Impact.** A tenant that deliberately sets `portal_enabled = 0` and `magic_enabled = 0` still
has portal login and magic-link start enabled platform-wide as long as _any other_ tenant leaves
them on. Conversely the last tenant to disable a feature turns it off for everyone. It is a
tenant-configuration integrity failure and a (small) cross-tenant information leak: the
unauthenticated `/api/capabilities` response reveals whether _any_ tenant has each feature on.
Per-product filtering does still happen downstream (`portal/api.ts:336`, `:345`, `:440`,
`:556`), which is what keeps this Medium rather than High.

**PoC** — `R5-04 cross-tenant portal capability coupling`. `acme` disables portal + magic +
oidc; `portalAuthCapabilities` still reports all three enabled, and `handleMagicStart` proceeds
past the gate (503 `email_not_configured`, not 404 `auth_method_disabled`).

**Fix direction.** These are per-product settings; evaluate them per product. Where a
platform-wide answer is genuinely needed (the root login page), make it an explicit platform
setting rather than an implicit OR over tenants.

---

## R5-07 — No tenant-scoped admin role exists

**Severity: Medium.** The only way to grant a product operator admin access is to make them a
platform administrator of **every** tenant — and the module docstring says otherwise.

**Files**

- `packages/worker/src/admin/authz.ts:21-27`:
  ```ts
  export function canAdminProduct(env, session, _product: ProductRow): boolean {
    return isPlatformAdmin(env, session);
  }
  ```
  The product argument is discarded. `hasAnyAdminGrant` (`:30-38`) likewise ignores `_products`.
- `packages/worker/src/admin/api.ts:12-13` documents the opposite: _"Group-gated: platform
  routes need `PLATFORM_ADMIN_GROUP`; product routes need the product's `admin_group` (platform
  admins pass too)."_
- `products.admin_group` exists in the schema (`migrations/0001_init.sql:21`), is loaded into
  the `Product` type (`product.ts:34`, `:113`) and is settable from the admin API — but is never
  consulted for authorization.

**Impact.** The gate itself is fail-closed (a product-group holder is denied, not over-granted),
so this is not a privilege-escalation bug. The multi-tenancy problem is the _shape_: an operator
who adds a third-party product owner to `PLATFORM_ADMIN_GROUP` — the only group that works —
silently hands them read/write over every tenant's licenses, devices, keys, secrets and release
config. The docstring actively encourages believing the grant is scoped.

**PoC** — `R5-05 no tenant-scoped admin role exists`. A session holding exactly `acme`'s declared
`admin_group` gets 403 on its **own** product; a `PLATFORM_ADMIN_GROUP` session gets 200 on both
`acme` and `evilco`.

**Fix direction.** Either implement the documented behaviour (`canAdminProduct` returns
`isPlatformAdmin(...) || session.groups.includes(product.admin_group)`) with tests, or delete
`admin_group` and correct `admin/api.ts:12-13` so nobody deploys believing in a boundary that
does not exist. Do not ship the current mismatch.

---

## R5-08 — Edge-mint recipes are not entitlement-gated

**Severity: Medium.** Intra-tenant IDOR: any licensed device may mint **any** recipe belonging
to its product, regardless of tier or entitlement.

**File.** `packages/worker/src/edgeMint.ts:185-192` — the only authorization is
`validateDeviceToken`, i.e. "is this a valid device token _for this product_". The subsequent
`getEdgeMintConfig(db, product.slug, mintId)` is correctly product-scoped, but `mintId` comes
straight from the URL (`router.ts:162-167`) and is never checked against the caller's tier,
profile, or entitlements.

**Impact.** A free-tier or auto-issued (`origin = 'enroll'`, keyless — `enroll.ts`) license can
mint any recipe the product declares. Recipes wrap real third-party credentials (the Apple
MusicKit ES256 developer token is the first instance), so this converts a free seat into
unbounded use of a paid downstream API on the tenant's account. Recipe ids are short lowercase
slugs (`/^[a-z0-9-]+$/`) and therefore enumerable.

**Does not cross tenants.** Verified: `getEdgeMintConfig` carries `product.slug` from the route,
so another product's recipe id 404s.

**PoC** — `R5-06 edge-mint recipes are not entitlement-gated` (2 tests): a `free`-tier device
mints `premium-partner-api` (200); an `evilco` device requesting `acme`'s recipe gets 404.

**Fix direction.** Add a `required_entitlement` (or `required_tier`) column to
`edge_mint_config` and check it against `resolveEffective(...)` before opening the key. Default
to deny for recipes with no declared requirement.

---

## R5-09 — A single global `GITHUB_WEBHOOK_SECRET` authenticates all tenants' repo webhooks

**Severity: Medium.**

**Files**

- `packages/worker/src/githubWebhook.ts:106-124` — one `env.GITHUB_WEBHOOK_SECRET` verifies
  every inbound webhook. There is no per-product secret.
- `:148-172` — `owner`/`repo` are read from the **attacker-supplied JSON body**
  (`repoCoordinates`, `:83-94`), then `listProductsByGithubRepo` fans out and `resyncRepo` runs
  for every matching product.

**Impact.** The secret is necessarily shared with every tenant repo that is configured to send
webhooks. Any one of those tenants (or anyone who obtains the secret from any one repo's
settings) can forge a payload naming **another tenant's** `owner/repo` and force a `.pkey/`
resync of that product — which re-applies manifest-controlled config, tiers and policy. It also
writes `product_sync_state` rows for products the caller has nothing to do with.

**PoC status.** Code-proven.

**Fix direction.** Per-product webhook secrets (a `release_config.webhook_secret_secret` name
into the existing sealed `product_secrets`), selected by the `(owner, repo)` in the payload and
verified against that product's secret only. Failing that, cross-check the delivery against the
GitHub App installation id rather than a shared HMAC.

---

## R5-10 — `getPortalDownloadToken` is not product-scoped and `row.product` is trusted as scope

**Severity: Low.** Not practically exploitable (256-bit token, HMAC'd), but it is the exact
pattern the rest of the codebase avoids, and the read/write halves disagree.

**Files**

- `packages/worker/src/portal/repo.ts:613-616` — `SELECT * FROM release_download_tokens WHERE
token_hash = ?`, **no product predicate**.
- `packages/worker/src/portal/repo.ts:625-630` — `markPortalDownloadUsed` **is** scoped
  (`WHERE product = ? AND token_hash = ?`). The write and the read use different key shapes.
- `packages/worker/src/portal/api.ts:648-678` — `row.product` is then the authorization scope
  for `getPortalArtifact` (`:651`), `getPortalProductSettings` (`:654`),
  `hasLinkedProductLicense` (`:663`), `hasUsableProductLicense` (`:669`) and
  `markPortalDownloadUsed` (`:678`).
- `migrations/0007_backend_contracts.sql:130` — PK is `(product, token_hash)`, so `token_hash`
  alone is **not** unique; `db.first` silently picks an arbitrary row on collision.

Compare `repo.ts:895` `getDeviceByTokenHash` and `repo.ts:830` `getKey`, which both use
`product = ? AND <hash> = ?` — the pattern this call should follow.

**PoC** — `R5-07 download-token lookup is not product-scoped`. Two tenants hold the same
`token_hash` (accepted by the PK); `getPortalDownloadToken` returns one of them, and the caller
has no way to know which.

**Fix direction.** Add a `UNIQUE` index on `token_hash`, or (better) carry the product in the
token itself and pass it to the lookup.

---

## R5-11 — The rate-limit Durable Object never reclaims storage

**Severity: Low** (availability/cost).

**File.** `packages/worker/src/rateLimitDo.ts` — 50 lines, no `alarm()`, no `storage.delete`, no
`deleteAll`. Counters are only ever overwritten in place per `(bucket, id)`. The header comment
at `:5-7` claims storage _"stays bounded by the active client set"_. It is bounded by the
**cumulative lifetime** set of distinct `(bucket, id)` pairs. Every source IP that ever touches
`/login` permanently adds a key. `wrangler.toml` declares `new_classes` (KV-backed), not
`new_sqlite_classes`, so there is no per-object ceiling to fail fast against. The two global
`_admin`/`_portal` shards (see R5-05) are the natural target since they need no valid tenant.

Also unvalidated: `windowSec` is used as a divisor at `rateLimitDo.ts:31`
(`Math.floor(now / windowSec)`); a `0` would produce `Infinity` and a permanently-pinned window.
`enroll.ts:135` passes a product-configured `policy.rateLimitPerHour` as `limit` with a
hardcoded `windowSec: 3600`, so this is not reachable today — but the DO validates nothing.

**Fix direction.** Set an `alarm()` to sweep counters whose `window` is older than the current
one; validate `limit > 0 && windowSec > 0` in the DO.

---

# REFUTED

Each of these was tested and did **not** hold as hypothesised. The PoC file pins them so a
regression fails loudly.

**RF-1 — "Proving control of one inbox inherits licenses platform-wide."** Refuted in the
_extraction_ direction. The root portal **does** check `email_verified`
(`portal/auth.ts:113-128`, `:286`), and an `(email → account)` binding is **sticky**:
`linkEmail` (`portal/repo.ts:219-228`) does `ON CONFLICT(email) DO UPDATE SET verified_at = …`
and never reassigns `account_id`. So an attacker's verified inbox yields only licenses bearing
_that_ address. R5-01/R5-02 are injection primitives, not extraction primitives.
_Caveat worth tracking separately:_ stickiness is a pre-hijack primitive — whoever binds an
address first keeps it forever, and every later sign-in for that address resolves into the
first account (`getOrCreateAccountByEmail`, `portal/repo.ts:132-139`). Tests:
`REFUTED: portal email binding is sticky …` (2 tests).

**RF-2 — "`portal/repo.ts:276` and `:297` are the only `licenses` queries without a `product`
predicate."** Confirmed for `licenses` specifically — an exhaustive sweep of all 128 `db.*` call
sites in `packages/worker/src` found no others (`repo.ts` 53/53 scoped; `admin/repo.ts` all
scoped; the two interpolated `SET` clauses at `admin/repo.ts:46` and `:163` build column names
from hardcoded object keys only). **But the claim understates the problem:** two further
unscoped reads of tenant tables exist, both in the same file — `release_download_tokens`
(R5-10) and the `portal_product_settings` aggregate (R5-06). The only string interpolation into
SQL anywhere in `src/` is generated `?` placeholders at `portal/repo.ts:536`.

**RF-3 — KV key-namespace confusion.** Refuted. `pk()` (`kv.ts:8-10`), `flowKey`/`deviceFlowKey`
(`oidc.ts:190-196`) and `sessionKey` (`browserSession.ts:50-52`) all place a **constant `kind`
segment between the tenant slug and the attacker-controlled id**, so user input can only extend
its own namespace — it can never shift into another. A `state`/`device_code`/`token` containing
`:`, `../`, or a full forged key path cannot make `p:<slug>:flow:<x>` equal `p:<slug>:token:<h>`,
and the `p:` / `admin:` / `portal:` roots are disjoint. Tests: `REFUTED: KV namespace confusion
…` (2 tests), including driving `handleAuthPoll` with three crafted states against a live KV
containing a real token record — all return `{status:"timeout"}`.

**RF-4 — `route.deviceId` is `decodeURIComponent`'d (`router.ts:173-179`).** Refuted as a
vector. It reaches only parameterised SQL (`setDeviceLabel`/`setDeviceStatus`, both
`product = ? AND device_id = ?`) and never a KV key — the KV delete uses `target.token_hash`
read back from the row (`licensing.ts:465-466`). `handleDevices` resolves the target from
`listDevicesByLicense(product.slug, valid.license.id)` and 404s if absent
(`licensing.ts:442-443`). Test: `route.deviceId … cannot touch another license's device`.

**RF-5 — IDOR sweep at `devices.ts:62`, `keys.ts:88`, `portal/api.ts:442-450`,
`portal/repo.ts:329-345`.** All four hold. `device.license_id !== licenseId` → 404;
`existing.license_id !== licenseId` → 404; `getPortalLicense` requires a matching
`portal_license_links` row on `(account_id, product, license_id)`. Tests: `REFUTED: IDOR sweep
— ownership predicates hold` (3 tests). _These checks are only as good as the link table, whose
rows R5-01/R5-02 can forge — that is the actual weakness, not the predicate._

**RF-6 — "A repo name colliding with another product's slug shares a KV entry"
(`githubApp.ts:210`).** Half-refuted. The scope argument **is** inconsistent (repo name vs slug
— see R5-03), so the same token really is written under two different key families. But the
`installId` in the final key segment is what actually prevents a _wrong-token_ read, so a bare
name collision alone does not leak a token across installations. The genuine finding is the
missing token down-scoping, not the cache key.

**RF-7 — "One tenant can exhaust or observe another's rate-limit bucket via
`idFromName(product)`."** Refuted **for product-scoped buckets**: distinct slugs give distinct
DOs, every bucket literal is unique per endpoint, and an attacker cannot spawn DOs for
non-existent products because `index.ts:82-84` runs `loadProduct` (which requires the row, an
active key, and a successful KEK decrypt) and 404s before any limiter runs. Shard hijack via a
product named `_admin`/`_portal` is also impossible — `/^[a-z0-9-]+$/`
(`admin/handlers/products.ts:251`) and the router capture (`router.ts:89`) both exclude
underscore. _That separation is real but entirely implicit_ — no comment or test ties those two
regexes to the `"_admin"`/`"_portal"` literals, and nothing validates `rateLimitOk`'s `product`
argument. The confirmed problem is the _portal_ buckets, which have no product dimension at all
(R5-05).

**RF-8 — Browser-session cookie-name collision across tenants.** Refuted.
`cookieName` (`browserSession.ts:46-48`) maps `-` → `_`, which is injective over the slug
alphabet `[a-z0-9-]` (no slug can contain `_`), and `Path=/<product>` (`:65`) does not
path-match a sibling slug under RFC 6265. KV keys and `validateDeviceToken`'s
`rec.product !== product.slug` check (`licenseCore.ts:453`) provide two further layers.

**RF-9 — Schema-level scoping / unique constraints.** Refuted as a weakness. Every tenant table
has `product` as column 1 of its primary key, and the partial unique indexes are correctly
tenant-scoped: `idx_licenses_sub` on `(product, sub)` (`0001_init.sql:81`),
`idx_licenses_enroll_hwid` on `(product, enroll_hwid)` (`0011_auto_issue.sql`),
`idx_product_keys_one_active` on `(product)` (`0006_hardening.sql`),
`idx_customers_external`/`idx_customers_sub` on `(product, …)` (`0007`). The genuinely global
tables (`products`, `portal_accounts`, `portal_account_emails`, `portal_account_identities`,
`portal_audit`) are global by design. The one place the schema is _weaker_ than the code assumes
is `release_download_tokens` (R5-10).

**RF-10 — Cross-tenant license keys and device tokens.** Already covered by
`test/isolation.test.ts` and re-confirmed: keys are `pkey_<product>_…` hashed whole, tokens are
looked up under `pk(product, "token", hash)` with a redundant `rec.product` check
(`licenseCore.ts:453`). Not re-tested here.

---

## Coverage gap in the existing `test/isolation.test.ts`

The existing suite proves exactly one thing: a per-device bearer token and a license key are
rejected cross-product on the licensing hot path, plus a secondary KV-prefix assertion. It does
**not** cover any of: the portal linking layer (R5-01, R5-02, R5-06, R5-10), the admin
authorization model (R5-07), rate-limit shard sharing (R5-05), edge-mint recipe scope (R5-08),
or key-custody blast radius (R5-04). The hot path — the one part that was tested — is also the
one part that held up.
