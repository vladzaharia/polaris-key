# Architecture review — multi-tenant blast radius

Reviewed at branch `lewd-owl`, tree at HEAD `bd26e0b`. Read-only review; no source files were
modified. All file:line references are against that tree.

**Lens:** what does one compromise cost _everyone else_? Not "is this bug exploitable" but
"when this credential leaks, how many tenants pay for it".

**Headline.** Polaris Key is a _single-trust-domain_ system wearing multi-tenant clothing. The
data-plane isolation is genuinely well-built — `product` really is column 1 of every PK, the
hot-path KV keys really are namespaced, the keyvault really does fail closed. But every
_control-plane_ credential is platform-wide and singular: one KEK, one webhook secret, one
GitHub App, one admin group, one session secret, one hash pepper. Six of the seven compromises
in the matrix below are total-platform events. The architecture is correct for the world it
actually lives in today (one first-party product, `djdl`) and would be negligent for the world
its documentation advertises ("every product is a tenant").

Overall grade: **C−**. Excellent per-request isolation, essentially no compromise
compartmentalisation.

| #   | Question                                        | Grade                                                          |
| --- | ----------------------------------------------- | -------------------------------------------------------------- |
| 1   | Tenant-compromise matrix / blast-radius posture | **D**                                                          |
| 2   | One KEK for all tenants                         | **D+**                                                         |
| 3   | Shared-Worker / shared-D1 model                 | **C** (first-party) · **F** (untrusted tenant)                 |
| 4   | Isolation invariants that DO exist              | **B+**                                                         |
| 5   | The two locked decisions                        | **B** (drop per-product admin) · **C+** (cross-product portal) |
| 6   | Ranked recommendations                          | see §6                                                         |

---

## 1. Tenant-compromise matrix

**Grade: D.**

Read the "crosses tenants?" column first. Only two rows are contained.

| #   | Compromised                                                            | What the attacker gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Crosses tenants?                                                                                                                                                               | Evidence                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **One product's Ed25519 signing key**                                  | Forge config docs / entitlements / license JWS for that product only. Every SDK trusts the product's JWKS. Contained by AAD binding `pkey:v2:<product>:signing-key:<kid>` — the blob is undecryptable in another product's context. Recoverable: stage→activate rotation exists.                                                                                                                                                                                                                                                      | **No.** One tenant.                                                                                                                                                            | `keyvault.ts:59-63`, `product.ts:88-113`, `migrations/0003_keyvault.sql:7-19`, `admin/handlers/products.ts:640-678`                                           |
| 2   | **One product's OIDC client secret**                                   | Impersonate that product's OIDC client at its IdP; mint licenses via `/‹product›/auth/*`. Sealed per-product with AAD `product-secret:<name>`.                                                                                                                                                                                                                                                                                                                                                                                        | **No.** One tenant — _unless_ the product uses `provider: platform`, in which case there is no per-product secret at all and the shared `PLATFORM_OIDC_CLIENT_SECRET` is used. | `oidc.ts:129-177`, `product.ts:118-133`, `env.ts:22-24`                                                                                                       |
| 3   | **One linked GitHub repo** (write access to `.pkey/`)                  | Push to the default branch → webhook → `resyncRepo` rewrites the product's tiers, profiles, provisioning hooks, edge-mint recipes, artifact policy, `admin_group`, **and the OIDC `issuer` + `client_id`**. Flipping `oidc.provider: custom` with an attacker-controlled issuer converts repo-write into unbounded license issuance for that product.                                                                                                                                                                                 | **No** by default (`listProductsByGithubRepo` scopes by owner/repo)… **but yes** if several products are linked to one repo, and yes in combination with row 7.                | `githubWebhook.ts:151-211`, `resync.ts:143-155` (incl. `admin_group` at :152), `resync.ts:221-237`, `resync.ts:202-215`, `oidc.ts:131-134`, `repo.ts:263-279` |
| 4   | **One "product operator's" credentials**                               | **There is no such principal.** `hasAnyAdminGrant` ignores the product list and `canAdminProduct` ignores its product argument — both reduce to `PLATFORM_ADMIN_GROUP` membership. Any operator who can sign in to `/manage` is a platform admin over every product: read/write licenses, tiers, devices, secrets (write-only), rotate signing keys, delete products, force resync.                                                                                                                                                   | **Yes — all tenants.**                                                                                                                                                         | `admin/authz.ts:21-27`, `admin/authz.ts:30-38`, `admin/api.ts:66-82`, `admin/handlers/products.ts:105`                                                        |
| 5   | **One admin session** (stolen cookie or forged `ADMIN_SESSION_SECRET`) | Same as row 4 for the 8-hour session lifetime. Sessions are stateless HMAC — there is **no revocation list**, so a stolen cookie is valid until `exp` and rotating `ADMIN_SESSION_SECRET` is the only kill switch (and it logs out every admin). CSRF + `SameSite=Strict` protect against cross-site abuse, not against theft.                                                                                                                                                                                                        | **Yes — all tenants.**                                                                                                                                                         | `admin/session.ts:29-30`, `admin/session.ts:1-19`, `admin/api.ts:154-166`                                                                                     |
| 6   | **`PLATFORM_KEK`**                                                     | Decrypt **every** tenant's Ed25519 private signing key and **every** product secret in one `SELECT * FROM product_keys` + `product_secrets`. AAD is metadata binding, not a second factor — the attacker knows `product`/`kind`/`id` from the same rows. Also un-rotatable without downtime (see §2).                                                                                                                                                                                                                                 | **Yes — total platform compromise.** Every product's config-signing forgeable simultaneously.                                                                                  | `keyvault.ts:3-7`, `keyvault.ts:67-83`, `keyvault.ts:135-138`, `env.ts:16-18`                                                                                 |
| 7   | **`GITHUB_WEBHOOK_SECRET`**                                            | Forge a `push` for **any** `owner/repo` and trigger `resyncRepo` on every product linked to it — i.e. row 3's full config-rewrite primitive against every tenant, not just one. Worse: the forged `after` is passed straight through as GitHub's `?ref=`, and **`resyncRepo` never checks that the ref is the default-branch head**. So the attacker can pin the resync to _any_ ref in the victim's repo — an unmerged PR branch, an old tag — meaning anyone who can push a branch (not merge one) becomes a config-rewrite gadget. | **Yes — all tenants with a linked repo.**                                                                                                                                      | `githubWebhook.ts:106-124`, `githubWebhook.ts:164-172`, `resync.ts:73-124`, `github.ts:168-180`, `docs/DEPLOYMENT.md:151-155`                                 |

### Two more platform-wide credentials the brief did not list

| Compromised                                           | Blast radius                                                                                                                                                                                                                                                                                   | Evidence                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **`KEY_HASH_PEPPER`**                                 | A single HMAC pepper for every product's license-key _and_ device-token hashes. With a D1/KV dump, one pepper lets an attacker confirm guessed credentials for all tenants at once — and license keys are self-identifying (`pkey_<product>_…`), so the dump is pre-sorted by tenant for them. | `crypto.ts:73-90`, `crypto.ts:31-33`, `env.ts:20`                      |
| **GitHub App private key** (`GITHUB_APP_PRIVATE_KEY`) | One App across all tenants. Installation tokens are minted with **no `repositories` / `permissions` body**, so an org-wide install yields a token good for every repo in that org, held in KV for 55 minutes.                                                                                  | `githubApp.ts:127-131`, `githubApp.ts:218-221`, `githubApp.ts:232-237` |

### New finding: the GitHub token cache key is product-confused

`getInstallationToken(env, product, installId, …)` builds its KV key with
`pk(product, "gh-token", String(installId))` (`githubApp.ts:210`). Two of the four call sites
pass a **GitHub repo name** where the parameter means **product slug**:

- `resync.ts:97` — `getInstallationToken(env, repo, installId, …)`
- `linkRepo.ts:123` — `getInstallationToken(env, repo, installId, …)`

versus the correct slug at `release/index.ts:269` and `health.ts:166`.

This is not cosmetic. Under an **org-wide install the installation id is constant for the whole
org**, so the first key segment is the only discriminator. A product with slug `foo` and a
_different_ product linked to a repo named `foo` therefore read and write the _same_ cache entry
`p:foo:gh-token:<installId>`. Repo names also permit `.`, `_` and uppercase
(`linkRepo.ts:77`) while slugs are `^[a-z0-9-]+$` (`admin/handlers/products.ts:251`), so the two
namespaces are not even the same alphabet — the `pk()` invariant that "the first argument is a
tenant" is silently violated. Today the leaked token is org-wide anyway (row 7 above), so the
_marginal_ damage is small; the moment installation tokens are correctly scoped per repo, this
becomes a live cross-tenant credential-confusion bug. Fix it before fixing the scoping, or the
scoping fix will be defeated by the cache.

### Availability blast radius

Rate-limit Durable Objects shard per product (`rateLimit.ts:23`), which is right. But `_admin`
and `_portal` are literal single global shards: `admin/auth.ts:152`, `admin/auth.ts:197`,
`portal/auth.ts:174`, `portal/auth.ts:311`, `portal/api.ts:275`. Every portal login, magic-link
request and authenticated portal action for **every tenant** serialises through one DO instance.
The buckets themselves are keyed by IP / account so an attacker cannot lock another user out,
but the throughput ceiling of one DO is now the throughput ceiling of every tenant's customer
portal simultaneously. That is a noisy-neighbour coupling, not a security bug — but it is a
blast-radius one.

---

## 2. Is one KEK for all tenants the right call?

**Grade: D+.** The single KEK is a defensible engineering call. The _un-rotatable_ single KEK is
not, and that is the part that earns the grade.

### What is actually good here

The envelope format is well designed. Fresh 12-byte nonce per seal (`keyvault.ts:93-94`), strict
32-byte KEK validation that refuses to silently derive a different key from malformed deployment
input (`keyvault.ts:72-75`), AAD binding every ciphertext to `product:kind:id` so a blob lifted
from one tenant's row cannot be decrypted in another tenant's context (`keyvault.ts:59-63`), and
a hard fail-closed contract — `open()` throws rather than ever returning a wrong or partial
plaintext (`keyvault.ts:139-150`), with `loadProduct` catching that into `null` so a product with
an unopenable key simply cannot sign (`product.ts:88-113`). That is better than most
implementations of this pattern.

### The problem is not confidentiality, it is rotation

```
const expected = env.PLATFORM_KEK_ID || "default";
if (sealed.kekId !== expected) {
  throw new Error(`sealed value uses unavailable KEK ${sealed.kekId}`);
}
```

— `keyvault.ts:135-138`

`kekId` is _recorded_ per blob, which looks like rotation support, but `open()` accepts exactly
one KEK id: the currently configured one. There is no keyring, no `PLATFORM_KEK_PREVIOUS`, no
`kekId → key` map, and no re-seal migration anywhere in the tree. Consequently:

- Changing `PLATFORM_KEK` makes **every** sealed blob for **every** tenant undecryptable at the
  same instant. `loadProduct` returns `null`, so every product stops signing config; every
  `openProductSecret` returns `undefined`, so custom OIDC and edge-mint fail closed
  (`oidc.ts:139-148`, `product.ts:118-133`).
- Therefore the only safe rotation is a full-platform maintenance window with an offline re-seal
  of the whole `product_keys` + `product_secrets` tables — and there is no environment to
  rehearse it in (§3).
- Which means, in practice, **the KEK will never be rotated**. A credential that cannot be
  rotated cannot be responded to. Discovering KEK exposure would leave you with no move except
  rotating every product signing key by hand and re-issuing every product secret.

The `kekId` field is worse than useless as it stands: it creates the _appearance_ of rotation
readiness. Anyone reading `keyvault.ts:106` reasonably concludes rotation is supported.

### Per-tenant KEKs: what would they actually buy?

Honestly? Less than it first appears — and I want to be candid rather than reflexively
prescriptive. Per-tenant KEKs only reduce blast radius if the per-tenant keys are protected by
something the Worker does not already hold. On Cloudflare Workers, every candidate for the root
of trust (a Worker secret, a Secrets Store binding, an external KMS credential) is available to
_every_ request handler in the isolate, because there is one isolate serving all tenants (§3).
An attacker with worker-code execution or a `wrangler secret list`-equivalent gets all of them.
Per-tenant _KEKs_ stored the same way as the platform KEK are theatre.

What is _not_ theatre is the middle option:

**Recommendation: keep one root KEK; add a per-tenant derived key layer and a keyring.**

1. **Keyring, not scalar** (highest value, lowest cost). Make `open()` resolve `sealed.kekId`
   against a map of available KEKs (`PLATFORM_KEK`, `PLATFORM_KEK_PREV`), while `seal()` always
   writes the current one. This alone converts "un-rotatable" into "rotate with a lazy re-seal
   and no downtime". ~40 lines in `keyvault.ts` plus a background re-seal job. Do this
   regardless of what you decide about per-tenant wrapping.
2. **Per-tenant derived DEKs.** `HKDF(PLATFORM_KEK, salt = product_slug || kekId)` → per-product
   AES key; seal under that. This does not defeat a full-KEK compromise, but it _does_ mean that
   a partial disclosure (a key accidentally logged, a single derived key extracted from a memory
   dump or a debug endpoint, a compromised one-off migration script) is confined to one tenant.
   It also makes per-tenant crypto-shredding real: forget the salt row, forget the tenant.
   Roughly a day of work; the AAD scheme already carries the right salt inputs.
3. **Only if you onboard a tenant you do not trust:** move the root to an external KMS
   (Cloudflare Secrets Store or an HSM-backed cloud KMS) with `Decrypt` as a _remote_ operation,
   so the Worker never holds the root key material at all and every unwrap is audited. That is
   the only change that genuinely shrinks the blast radius of a Worker compromise, and it costs a
   network round-trip on the cold config-signing path (mitigable: cache the unwrapped per-tenant
   DEK in the isolate for the request's lifetime).

Do **not** ship per-tenant KEKs as Worker secrets — that is operational cost (N secrets, N
rotation procedures, N ways to get a mismatch) with no real blast-radius reduction.

---

## 3. Is the shared-Worker / shared-D1 model appropriate?

**Grade: C for the world that exists. F for the world the docs describe.**

For one first-party product this is the right architecture and I would not change it. One
Worker, one D1, one KV, one DO class is cheap, operationally simple, keeps the hot path to a
single KV read, and the product-first schema means the isolation story is at least _legible_.
Splitting into per-tenant Workers today would be pure cost.

But the codebase repeatedly asserts the stronger claim — `migrations/0001_init.sql:1-4` "Every
table is product-scoped… a missing product predicate can never return another tenant's rows",
`kv.ts:1-2` "the ONLY way to build a KV key" — and those claims do not survive contact with a
tenant you do not trust. Some concrete problems:

- **D1 is one database with one connection identity.** There is no row-level security, no
  per-tenant credential, no way to express "this code path may only see product X". Isolation is
  100% convention: a `WHERE product = ?` that a future contributor must remember to write. The
  schema makes it _natural_ to get right (`product` is column 1 of every PK, so an unscoped query
  is also a slow query) but nothing _enforces_ it.
- **`pk()` is not the only KV key constructor**, despite `kv.ts:1-2`. Five hand-rolled
  constructors exist: `browserSession.ts:50` (`p:${product}:browser-session:${hash}`),
  `oidc.ts:190` and `oidc.ts:194` (`p:${product}:flow:` / `device-flow:`), plus the deliberately
  platform-global `admin/auth.ts:30` and `portal/auth.ts:24-25`. The three `p:`-prefixed ones
  happen to be correct today; they are three future bugs away from not being.
- **One isolate serves every tenant.** Any RCE, prototype-pollution or dependency compromise in
  the Worker is a total-platform event by construction. `nodejs_compat` is on
  (`wrangler.toml:5`), widening that surface.
- **No pre-production environment.** `wrangler.toml:72`, `:76`, `:87`, `:91` are all
  `REPLACE_ME_*`. Staging and dev do not exist. Every schema migration, every keyvault change,
  every resync-logic change is first executed against the environment holding every tenant's
  data. For a platform whose main risk is a control-plane mistake, this is the single most
  alarming line in the config.

### What must change before a third party is onboarded

Non-negotiable, in order:

1. **Stand up staging.** Real D1 + KV ids, and a deploy gate that refuses to promote to prod
   without a green staging deploy. Everything below needs somewhere to be rehearsed.
2. **Per-tenant webhook secrets.** Store an HMAC secret in `release_config` per product and
   verify the forged-`push` signature against the secret(s) for the products bound to that
   `owner/repo` — not against one global value (`githubWebhook.ts:106-124`). Otherwise every
   tenant's repo binding is as trustworthy as the least-careful holder of the shared secret.
3. **Pin resync to the default-branch head.** Do not accept an attacker-suppliable `?ref=`
   (`resync.ts:97-116` → `github.ts:176`). Resolve the default branch server-side and refuse any
   `after` that is not its current head.
4. **Take `oidc.issuer` / `oidc.clientId` / `admin_group` out of the manifest's write set**, or
   gate manifest changes to those fields behind an explicit platform-admin approval step.
   Repo-write must not equal "point this tenant's authentication at my IdP"
   (`resync.ts:152`, `resync.ts:221-237`, `oidc.ts:131-134`).
5. **Scope installation tokens.** Pass `repositories: [repo]` and a minimal `permissions` object
   in the `access_tokens` POST (`githubApp.ts:218-221`), and fix the product/repo cache-key
   confusion first (`resync.ts:97`, `linkRepo.ts:123`) so the scoping is not undone by a shared
   cache entry.
6. **Real per-product admin authority** — see §5; "platform-only" stops being tenable the moment
   a tenant wants to manage their own licenses.
7. **Per-tenant D1 quota / abuse controls.** Today one tenant's license volume, audit-log growth
   and device churn consume a shared D1 with shared limits. Add per-product row budgets and
   audit retention before anyone else's data lives in the same database.
8. **Enforce the KV invariant mechanically.** A lint rule banning `env.HOT.*` outside `kv.ts`,
   or a typed `ProductSlug` branded type as `pk()`'s first parameter, would have caught
   `resync.ts:97`.

Below roughly ten tenants I would keep the shared Worker and invest entirely in items 1-8. Above
that, or for any tenant with a materially different risk profile, split the _control plane_
(admin API, webhook receiver, release engine) into its own Worker and leave the data plane
shared — the control plane is where all seven matrix rows live.

---

## 4. The isolation invariants that DO exist

**Grade: B+.** This is the part of the design that is genuinely good, and the review should be
explicit that it must be preserved through any refactor.

**Keep, do not regress:**

1. **`product` as column 1 of every primary key and index.** `migrations/0001_init.sql:29-195`
   — `product_schema`, `profiles`, `tiers`, `licenses`, `keys_index`, `devices`,
   `provisioning_config`, `edge_mint_config`, `identity`, `audit` all lead with `product`, and the
   indices follow (`idx_licenses_sub` at :81, `idx_audit_time` at :195). This makes the _correct_
   query the _fast_ query, which is the best kind of guard rail. A sweep of every
   `SELECT`/`DELETE` in `src/**` found a `product = ?` predicate on every product-scoped table
   outside the two deliberate portal exceptions (§5) and one gap noted below.
2. **Fail-closed key custody with context binding.** `keyvault.ts:59-63` (AAD),
   `keyvault.ts:139-150` (propagate the auth-tag failure), `product.ts:88-113` and
   `product.ts:118-133` (a throw becomes "no product" / "no secret", never a fallback). The
   comments explain _why_, which is why the property has survived.
3. **Exactly-one-active-signing-key, enforced by the database.**
   `migrations/0006_hardening.sql:11-13` — a partial unique index, not application logic. Paired
   with a staged→activate flow that respects the 300s trust-cache window and requires an explicit
   `breakGlass` to bypass it (`admin/handlers/products.ts:697-712`), and an API that returns the
   public key only, never the private (`admin/handlers/products.ts:672-678`). Secrets are
   write-only and never echoed (`admin/handlers/products.ts:621-622`).
4. **Server-recomputed hwid.** `fingerprint.ts:56-64` documents the reasoning and
   `licenseCore.ts:382-388` / `enroll.ts:170` implement it: the client's self-reported `hwid` is
   discarded and recomputed from components. This is exactly right — a forged hwid would
   otherwise let a caller collide with another device's dedupe key, and the anonymous-enrol path
   (`enroll.ts:163-178`) makes that a farming primitive. Note this is _intra_-tenant isolation,
   not cross-tenant, but it is the same instinct applied consistently.
5. **Platform routes matched before product slugs, with a restrictive slug alphabet.**
   `router.ts:1-3` and `router.ts:89` (`^/([a-z0-9-]+)/(.+)$`) plus `admin/handlers/products.ts:251`
   (`^[a-z0-9-]+$`). Underscores are excluded, so `_admin` and `_portal` are unreachable as
   slugs, and there is no path-traversal or unicode-confusable surface. Simple and effective —
   keep the regex as the single source of truth and do not "relax" it for a tenant who wants a
   dot in their slug.
6. **`cf-connecting-ip` with a deliberate refusal to fall back to `x-forwarded-for`.**
   `rateLimit.ts:38-46`. The comment explains the attack it prevents. Small thing, correctly done.
7. **The isolation test drives the Worker, not the fixture.** `test/isolation.test.ts:19-23`
   explicitly calls out that the previous version asserted on the mock. It now proves a real
   bearer token from product A is rejected 401 at product B and vice versa (:79-84), that a
   license key from A cannot activate at B (:87-105), and keeps the KV-prefix check only as a
   secondary assert (:107-129). That is the right test-design instinct and should be the template.

**Where the invariants are thinner than advertised:**

- The `pk()`-is-the-only-constructor claim is aspirational, not enforced (§3).
- `portal/repo.ts:614` — `SELECT * FROM release_download_tokens WHERE token_hash = ?` has no
  `product` predicate, so the download-token namespace is platform-global even though the table's
  key is `(product, token_hash)`. The hash is a 256-bit peppered random so collision is not a
  practical risk, but it is the one product-scoped table read without its scope, and the caller
  then trusts `row.product` to decide what to serve.
- Test coverage of isolation is confined to the activate/config hot path. There is no test that a
  cross-tenant admin read is refused (it wouldn't be — §1 row 4), none for the portal join, none
  for the GitHub token cache key.
- **Documentation actively misstates the model.** `admin/api.ts:12-13` claims "product routes need
  the product's `admin_group` (platform admins pass too)" and `admin/session.ts:3-4` claims a
  session proves "either the platform-admin group or a product admin group". Neither is true
  (`admin/authz.ts:21-27`). Comments that describe a security control which does not exist are
  worse than no comments; a reviewer who trusts them will not look for the missing check. Fix
  these in the same change as §5.

---

## 5. The two locked decisions

### 5a. Remove `canAdminProduct`; document admin as platform-only — **agree. Grade B.**

This is the right call and I would not argue against it. The function is a lie with a
`_product` parameter (`admin/authz.ts:21-27`); so is `hasAnyAdminGrant`'s ignored `_products`
(`admin/authz.ts:30-38`). Keeping a _shape_ that implies per-product authority while
implementing none is strictly worse than not having it, because every call site
(`admin/api.ts:68`) reads as though a check happens. Deleting the concept and stating "admin is
platform-wide" makes the security posture honest, testable and reviewable. Half-implemented
authorization is the most dangerous kind.

Three conditions on my agreement:

1. **Fix the comments in the same commit.** `admin/api.ts:12-13` and `admin/session.ts:3-4` must
   stop describing a per-product gate. The `admin_group` _column_ stays (the manifest writes it,
   `resync.ts:152`) but must be documented as advisory metadata with no authorization meaning —
   otherwise the next reviewer re-derives the same false confidence from the schema
   (`migrations/0001_init.sql:21`).
2. **Keep the `access.denied` audit path.** `admin/api.ts:69-81` currently audits an
   authenticated-but-unauthorized product access with a good rationale for why the
   unauthenticated 401s are _not_ audited (D1-write DoS amplifier). If `canAdminProduct` always
   returns true, that branch becomes dead code and will be deleted. Preserve the mechanism — it
   is where per-product denials will be logged when RBAC arrives.
3. **Write down the tenant-onboarding tripwire.** "Platform-only admin" is a statement that
   Polaris Key cannot onboard a tenant who expects to manage their own licenses. That belongs in
   `docs/CONCEPTS.md` as an explicit limitation, not buried in an authz module, so the constraint
   surfaces during a sales conversation rather than during an incident.

The residual risk is unchanged and should be stated plainly: matrix rows 4 and 5 remain
total-platform compromises, and the mitigation is now entirely organisational — keep
`PLATFORM_ADMIN_GROUP` tiny, require phishing-resistant MFA on it at the IdP, and shorten the
8-hour session (`admin/session.ts:29-30`).

### 5b. Keep cross-product portal linking, harden with `email_verified` + verified-subject preference — **partially disagree. Grade C+.**

I agree with keeping it cross-product. A single customer identity across products is the entire
point of the portal, `portal_license_links` is a proper join table with `(account, product,
license)` granularity, and `listPortalLicenses` / `getPortalLicense`
(`portal/repo.ts:313-345`) both go through it rather than querying `licenses` directly. The
design is sound.

I disagree that `email_verified` hardening is sufficient, because **it hardens the wrong side of
the join**.

```sql
SELECT product, id FROM licenses WHERE lower(email) = ?   -- portal/repo.ts:276
SELECT product, id FROM licenses WHERE sub = ?            -- portal/repo.ts:297
```

The left side (the portal account's emails and subjects) is already reasonably trustworthy:
`portal/auth.ts:286` only links an OIDC email when `email_verified` is true
(`portal/auth.ts:115`), the magic-link flow proves email control, and the portal IdP is the
single platform IdP rather than a per-product one (`portal/auth.ts:284-288`). So the proposed
hardening largely codifies what `portal/auth.ts` already does.

The **right side is entirely tenant-controlled and completely unverified**. `licenses.email` and
`licenses.sub` are written by product admins and by manifest-driven provisioning. Nothing checks
that a product has any relationship to the email it claims. Concretely, a hostile or merely
sloppy tenant sets `licenses.email = 'victim@bigcorp.com'` on a license in _their_ product. The
victim later signs into the portal for a completely different product; `syncAccountLicenseLinks`
fires on **every** `/api/me` (`portal/api.ts:292`) and on every login
(`portal/auth.ts:292`), and silently links the attacker's license to the victim's account.
`listPortalLicenses` then renders it with the attacker's `products.name` and their arbitrary
`branding_json` (`portal/repo.ts:318`, `migrations/0001_init.sql:22`).

That is an **unauthenticated cross-tenant content-injection primitive into every other tenant's
customers' portal**, with attacker-controlled display name and branding, inside a first-party
trusted origin. It is a very good phishing surface and `email_verified` does not touch it. The
`sub` join is worse still: subjects are opaque strings under tenant control, so a tenant who
learns a victim's platform-IdP `sub` gets a silent, unconditional link.

There is no _read_ leak — the victim cannot see the attacker's other data, and the attacker
cannot see the victim's — so this is spoofing and privacy (existence of a license is disclosed),
not data exfiltration. It is still the sharpest cross-tenant edge in the portal.

**What I would do instead of / in addition to the locked hardening:**

1. **Make auto-linking opt-in per product.** Add `portal_product_settings.auto_link_by_email`
   defaulting to **off** for any product that is not first-party. `license-key` claim
   (`portal/api.ts:350-400`) is the safe universal path — it proves possession of a 128-bit
   secret and is already rate-limited to 10/min per (account, IP).
2. **Verify the tenant's claim to the domain.** Only auto-link by email when the license's email
   domain is one the product has verified (DNS TXT, the same way SaaS products verify domains
   before auto-joining users to a workspace). This is the actual fix: it makes the right side of
   the join trustworthy.
3. **Drop the bare `sub` join, or scope it.** `WHERE sub = ?` with no product predicate and no
   issuer predicate is too blunt. At minimum require that the license's product uses the platform
   IdP, so the subject namespaces genuinely coincide.
4. **Surface links as pending.** Auto-discovered links should render as "a product claims a
   license for this address — confirm?" rather than appearing as owned licenses. One UI change
   removes the entire spoofing value.
5. **Do not resync on every `/api/me`.** `portal/api.ts:292` runs two unindexed-ish scans of
   `licenses` per portal page load, across all tenants. Move it to login + explicit refresh.

If only one of these ships, ship (1). It converts "every tenant can inject into every other
tenant's portal" into "first-party products can, third parties must prove the key" — which is
exactly the trust boundary the rest of the system already assumes.

---

## 6. Ranked recommendations

Ranked by blast-radius reduction per unit of effort. Effort is engineer-days for one person
familiar with the codebase.

| #   | Recommendation                                                                                                                                                                                                                             | Effort  | Blast-radius reduction                                                                               | Evidence                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | **KEK keyring + lazy re-seal.** `open()` resolves `sealed.kekId` against `{PLATFORM_KEK, PLATFORM_KEK_PREV}`; `seal()` always writes current; background job re-seals. Converts an un-rotatable platform-wide secret into a rotatable one. | 1-2 d   | **Very high** — makes matrix row 6 _survivable_ instead of terminal.                                 | `keyvault.ts:106`, `keyvault.ts:135-138`                                      |
| 2   | **Per-tenant webhook secrets.** Verify the `push` HMAC against the secret(s) bound to the pushed `owner/repo`, not one global value.                                                                                                       | 2-3 d   | **Very high** — collapses matrix row 7 from "all tenants" to "one tenant".                           | `githubWebhook.ts:106-124`, `repo.ts:263-279`                                 |
| 3   | **Pin resync to the default-branch head.** Resolve the default branch server-side; reject any `after` that is not its current head. Removes the arbitrary-`?ref=` gadget.                                                                  | 0.5 d   | **High** — removes "branch-push ⇒ config rewrite" for every tenant.                                  | `resync.ts:97-116`, `github.ts:176`                                           |
| 4   | **Remove `oidc.issuer` / `oidc.clientId` / `admin_group` from the manifest write set** (or gate behind explicit platform-admin approval).                                                                                                  | 1-2 d   | **High** — breaks repo-write ⇒ authentication takeover.                                              | `resync.ts:152`, `resync.ts:221-237`, `oidc.ts:131-134`                       |
| 5   | **Fix the GitHub token cache key, then scope installation tokens** (`repositories` + minimal `permissions`). Order matters — scoping without the cache fix is defeated by the shared entry.                                                | 1 d     | **High** — one repo compromise stops yielding an org-wide token.                                     | `resync.ts:97`, `linkRepo.ts:123`, `githubApp.ts:210`, `githubApp.ts:218-221` |
| 6   | **Stand up staging** with real D1/KV ids and gate prod promotion on it.                                                                                                                                                                    | 2-3 d   | **High** (indirect) — the prerequisite for rehearsing 1, 2 and every migration.                      | `wrangler.toml:72`, `:76`, `:87`, `:91`                                       |
| 7   | **Make portal auto-linking opt-in per product**, default off for non-first-party; keep `license-key` claim as the universal path.                                                                                                          | 1-2 d   | **Medium-high** — removes cross-tenant portal injection/spoofing.                                    | `portal/repo.ts:265-311`, `portal/api.ts:350-400`                             |
| 8   | **Delete `canAdminProduct`; correct the comments that claim per-product gating**; document admin as platform-only in `docs/CONCEPTS.md`. Keep the `access.denied` audit hook.                                                              | 0.5 d   | **Low direct, high clarity** — no change to rows 4/5, large change to whether they are _understood_. | `admin/authz.ts:21-27`, `admin/api.ts:12-13`, `admin/session.ts:3-4`          |
| 9   | **Admin session hardening**: shorten TTL from 8h, add a server-side revocation epoch (a KV counter bumped per-admin) so a stolen cookie can be killed without rotating `ADMIN_SESSION_SECRET`.                                             | 1-2 d   | **Medium** — makes matrix row 5 recoverable.                                                         | `admin/session.ts:29-30`                                                      |
| 10  | **Enforce the KV invariant mechanically**: brand `pk()`'s first parameter as `ProductSlug`, lint-ban `env.HOT.*` outside `kv.ts`, and route `browserSession.ts:50` / `oidc.ts:190,194` through `pk()`.                                     | 1 d     | **Medium** — turns a convention into a compile error; would have caught #5.                          | `kv.ts:1-10`, `browserSession.ts:50`, `oidc.ts:190-196`                       |
| 11  | **Per-tenant derived DEKs** via `HKDF(PLATFORM_KEK, product‖kekId)`. Confines partial key disclosure and enables per-tenant crypto-shredding. Do after #1.                                                                                 | 1-2 d   | **Medium** — no help against full-KEK loss; real help against everything short of it.                | `keyvault.ts:59-83`                                                           |
| 12  | **Per-tenant hash pepper** (`KEY_HASH_PEPPER` → per-product, derived from the KEK). Requires a rehash migration of `keys_index` + KV token records.                                                                                        | 3-4 d   | **Medium** — confines offline credential-guessing after a D1/KV dump.                                | `crypto.ts:73-90`                                                             |
| 13  | **Add cross-tenant negative tests** for the admin API, the portal join and the GitHub token cache, in the style of `test/isolation.test.ts` (drive the worker, not the fixture).                                                           | 1-2 d   | **Medium** (regression insurance).                                                                   | `test/isolation.test.ts:19-23`                                                |
| 14  | **Shard `_admin` / `_portal` rate-limit DOs** (e.g. by IP prefix or account hash) to remove the single-DO throughput ceiling on every tenant's portal.                                                                                     | 0.5 d   | **Low** (availability only).                                                                         | `admin/auth.ts:152,197`, `portal/auth.ts:174,311`, `portal/api.ts:275`        |
| 15  | **Scope `release_download_tokens` lookups by product**, restoring the "every product-scoped read carries its scope" invariant.                                                                                                             | 0.5 d   | **Low** (hygiene).                                                                                   | `portal/repo.ts:614`                                                          |
| 16  | **Split the control plane** (admin API + webhook receiver + release engine) into its own Worker. Only worth it at >10 tenants or the first untrusted tenant.                                                                               | 10-15 d | **High, deferred** — all seven matrix rows live in the control plane.                                | `wrangler.toml:1-5`                                                           |

Items 1-6 are the ones I would insist on before the next tenant, first-party or not. Items 1-3
are, between them, about four days of work and remove two of the three total-platform compromise
paths.
