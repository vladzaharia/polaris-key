# 03 — Polaris Key as Diceroll's release / update / content-pack backend

Date: 2026-09-29. Scope: evaluate the in-house platform Polaris Key (read-only at
`/home/user/polaris-key`, HEAD `fde0c0e`) as the backend for Diceroll's binary releases,
self-updates and the planned per-platform content packs, and design what has to change, including
a Godot 4.7.2 SDK. Headless Godot experiments were run for the SDK question (§7).

Path conventions used below: `PK/` = `/home/user/polaris-key/`, `DR/` = `/home/user/diceroll/`,
`SP/` = `/tmp/claude-0/-home-user-diceroll/22f656e1-73cf-5899-b675-27fc372fc8a4/scratchpad/pk-godot/`.
Line numbers are `file:line` or `file:start-end`.

---

## 0. Executive summary

**What Polaris Key is today:** a single Cloudflare Worker (`key.plrs.im`) with KV + D1 + one
Durable Object class. There are **no R2 bindings, no Queues and a single daily cron**
(`PK/packages/worker/wrangler.toml:31-45, 62-63, 74-90`; `PK/packages/worker/src/env.ts:7-12`).
It is licensing + signed config + a **GitHub-Releases-backed** release/update front end for one
macOS/CLI-shaped product (djdl).

**Fit for Diceroll, service by service:**

| Need | Polaris today | Verdict |
|---|---|---|
| Signed, pinned-key trust with rotation, clock floor, anti-replay | Excellent, frozen wire contract + 81-case corpus | **Reuse the design and format** (and optionally the signer) |
| Content-pack catalog (ids, hashes, sizes, deltas, per-platform, caps) | Nothing | **Gap**: new document type + store |
| Byte hosting on R2 / CDN | GitHub Releases only, streamed through the Worker | **Gap** (and GitHub proxying is the wrong model for packs) |
| Channels | stable/beta/pr-N/manual regex, resolved live against GitHub | Partly reusable concept; tied to GitHub tags |
| Staged % rollouts, kill switches, min-version in feed | None (compat window only on the licence doc / `entitled` mode) | **Gap** |
| Signed feeds | `/update/version` and the appcast are **unsigned**; only the Sparkle item signature is checked server-side | **Gap** |
| Anonymous access | Yes (`public` access mode is the default) | OK |
| CI-driven publishing | **No machine credential at all** — admin API = browser session cookie only | **Gap** (GitHub OIDC recommended) |
| Web builds (cross-origin) | Worker emits **no CORS headers** anywhere | **Gap** for any Worker route consumed by a Web build |
| Paid DLC across stores | Licence keys/seats; no StoreKit/Play/Steam receipt validation | Not a fit; use store-native entitlements |
| Remote tuning / flags | Config document works for licence-less devices, but only catalog defaults + per-device overrides; per-device signed, uncacheable | Workable but the wrong shape; put live-ops flags in the signed catalog |

**Godot verification (measured on 4.7.2):** Godot's `Crypto` (mbedTLS) verifies RSA-PKCS#1 v1.5
and **ECDSA P-256**, but **cannot load Ed25519 keys** (mbedTLS `-0x3C80`, unknown PK algorithm)
and `HashingContext` has **no SHA-512**. A **pure-GDScript Ed25519 verifier + SHA-512** (553 lines,
written for this report) passes RFC 8032 vectors, 45 random/tampered/malleability vectors, and
**all 81 applicable Polaris conformance-corpus cases** (JWS, licence, config, trust manifest).
It costs **~14.5 ms per verify** (~16 ms for a full JWS, ~65 ms at the 64 KiB payload cap) on a
2.1 GHz Xeon with the editor binary, and runs fine on `WorkerThreadPool`. That makes a GDExtension,
WebCrypto bridge or dual-signing unnecessary.

**Recommendation (one-person team): a hybrid, phased.**

1. **Now:** static, CI-produced catalogs on R2 behind a custom domain; packs content-addressed and
   immutable; the catalog is a **Polaris-format compact JWS** (`typ: "pkey-catalog+jws"`, EdDSA),
   signed in CI with an Ed25519 key, re-signed daily for freshness, with `seq` + `expiresAt`. No
   Worker on the hot path, $0/month, works on every platform including Web (with R2 CORS).
2. **Later, if live-ops UX (rollout sliders, one-click kill switch, audit) is worth ~3–4 weeks:**
   add a small **Content service** to Polaris that *signs* the same document with the product key
   (KEK-custodied), authenticates CI with **GitHub Actions OIDC**, and *writes the signed catalog
   to R2*. Clients only change their pinned trust set. Serving stays static on R2, so game
   availability never depends on the Worker, D1 or the KEK.

Money is not the deciding factor: every variant costs $0–7/month at 100k installs × 4 checks/day
(§5). The deciding factors are availability coupling, privacy (no install identifier needed),
Web CORS, and implementation effort.

---

## 1. Release service

### 1.1 Sync with GitHub: GitHub App plus push webhooks

- **GitHub App auth:** an App JWT (RS256, 9-minute lifetime) is exchanged for an **installation
  token down-scoped to one repository** with read-only permissions. It is cached **sealed** in KV for
  55 minutes (`PK/packages/worker/src/services/release/githubApp.ts:26-27, 95-118`;
  docs `PK/packages/docs/src/content/docs/services/release/github-sync.md:61-76`).
  - Doc drift: the header comment says ES256 (`githubApp.ts:6`) but the code signs RS256 (`:95-101`).
  - Token scope is keyed by repo coordinates (`gateway.ts:302-319`; `PK/packages/worker/src/kv.ts:34-42`).
- **Linking:** an operator pastes a repo URL. The worker finds the installation, reads
  `.pkey/{schema,product,release}` and, for a new product, creates the product row, a sealed Ed25519
  signing key and `release_config` in one batch (`github-sync.md:16-35`; `services/release/linkRepo.ts`).
- **Webhooks:** `POST /webhooks/github` handles **push events only** (`githubWebhook.ts:154-155`).
  - Each delivery is HMAC-verified and deduped by `X-GitHub-Delivery` for 7 days (`githubWebhook.ts:15, 142-144`).
  - The delivery must match the linked installation id (`:206-213`).
  - Only pushes to branches that touch `.pkey/` trigger `resyncRepo`, which reads the manifest from
    the **default branch, never from the payload ref** (`github-sync.md:78-118`).
  - There is **no `release` event handler**: publishing a GitHub release doesn't notify Polaris.
    The truth store only refreshes on a resync (`sync.ts:73-116`). The live routes don't need it,
    because they query GitHub live.
- **Provider seam:** only GitHub is implemented. The manifest validator rejects other providers
  (`PK/packages/shared-manifest/src/index.ts:~885-897` `unsupported_release_provider`), and
  "non-GitHub release providers" are explicitly out of scope (design spec
  `PK/docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md:43`).

### 1.2 Data model (D1)

| Table | Migration | Contents |
|---|---|---|
| `release_config` | `PK/packages/worker/migrations/0001_init.sql:122-134`, + `metadata_access`/`artifacts_access` (`0007_backend_contracts.sql:144-145`), + `artifact_policy_json` (`0006_hardening.sql:21`) | one row per product: `gh_owner/gh_repo/gh_installation_id`, `channel_workflow`, `beta_branch`, `manual_channels_json`, `binary_name`, `install_template`, `sparkle_ed25519_pub`, `summary_marker` |
| `release_metadata` | `0007:46-67` | one row per published non-draft release (version, notes, `source_url`, access modes, `published_at`) |
| `release_artifacts` | `0007:69-93` | one row per asset: `kind`, `platform`, `arch`, `content_type`, `size_bytes`, **`sha256` (always NULL)**, `source_url` (GitHub's `browser_download_url`), **`storage_key` (always NULL)**, `sparkle_signature` (NULL) |
| `release_channels` | `0007:95-104` | moving pointer channel → release_id |
| `release_health` | `0007:106-118` | status per subject (release/channel) |
| `release_download_tokens` | `0007:120-141` (re-created in `0016`) | portal single-use download tokens |
| `product_sync_state` | `0005_product_sync_state.sql:5-16` | last manifest sync outcome |

- Row shapes and writers are in `services/release/store.ts:49-100, 205-317`.
- Rows are upserts only, never deleted (`store.ts:23-31`).
- Assets are classified from the filename only:
  - kind (`store.ts:172-181`);
  - platform, which recognises only macos, linux and windows (`:183-190`);
  - arch, which recognises only arm64 and x86_64 (`assets.ts:17-35`).
- `sha256` and `storage_key` are written as `null` (`store.ts:452, 456`). The columns exist but R2 was never wired.
- **The device-facing routes never read the truth store.** Only the portal and the console read it
  (`PK/packages/docs/src/content/docs/services/release/truth-store.md:15-21, 159-162`).

### 1.3 Channels

- `classifyChannel` recognises (`services/release/channels.ts:44-64`):
  - `stable`, `latest` or a pinned `X.Y.Z` (the stable channel);
  - `beta`;
  - `pr-<n>`;
  - manual `{name, regex}` channels from `.pkey/release`.
- Resolution against the GitHub release list (`channels.ts:130-159`):
  - stable picks the newest non-prerelease;
  - beta picks tags produced by a configured Actions workflow on `beta_branch`, or else the newest prerelease;
  - `pr-n` uses the PR head SHA's workflow runs (`gateway.ts:364-413`);
  - a manual channel picks the newest tag matching the anchored regex.
- One resolver is shared by download, appcast and version check (`gateway.ts:322-357`).
- **Diceroll gotcha:** Diceroll keeps a rolling non-version release tagged `channels`
  (`DR/docs/RELEASE.md:91`). If that release isn't a prerelease, "newest non-prerelease" can
  resolve to it. `versionFromTag` would then return `"channels"` (`channels.ts:168-170`). Mark it
  prerelease, or exclude it with manual-channel regexes.

### 1.4 Artifacts: stored where, and how they are served

- **Stored:** on **GitHub Releases** only. "Release is not a build server and not a CDN… nothing is
  uploaded here" (`PK/packages/docs/src/content/docs/services/release/index.md:139-146`).
- **Served:** **proxied (streamed) through the Worker**, not redirected.
  - `GET /<p>/release/dl/<version>/<binary>-<arch>[.dmg]` (`services/release/routes.ts:23, 38-50`)
    resolves the selector, then `streamAsset` fetches the GitHub asset with `redirect: "manual"`.
  - It host-checks the storage redirect and re-fetches, passing `Range` and `If-None-Match` through
    (`services/release/github.ts:182-245`).
  - It forces `Content-Type` and `Content-Disposition: attachment` (`github.ts:225-244`).
  - Artifacts are **not** edge-cached (`gateway.ts:92-106`) and are rate-limited at 120/min/IP
    (`gateway.ts:89-90`).
  - `?checksum=sha256` serves a published `<asset>.sha256` sidecar (`surfaces.ts:178-180, 206-235`).
- **Per-platform artifacts:** only `<binary>-<arch>` leaf names (bare CLI) and `.dmg` are routable
  (`routes.ts:23, 42-45`). Arch must be arm64 or x86_64.
  - **None of Diceroll's artifacts are servable by this route:** `.zip`, `.tar.gz`, `.pck`, `.apk`,
    `.aab`, `.ipa` and `web.zip` (`DR/tools/ci/update_manifest.py:35-40`; `DR/docs/RELEASE.md` table).
  - The curl installer is Darwin-only (`services/release/artifacts.md:164-166`).
- **Access modes:** `public` (default), `authenticated`, `licensed`, `entitled`. Metadata and
  artifacts are set independently (`services/release/access.ts:109-152`; `config.ts:62-147`).

### 1.5 Changelog

- `GET /<p>/release/changelog` lists releases live from GitHub (`surfaces.ts:112-140`).
- The summary comes from a `<!-- pkey:summary -->` block or the first paragraph, capped at 600
  characters (`services/release/changelog.ts`; `artifacts.md:140-152`).
- The response is edge-cached for 5 minutes when public.

### 1.6 Other Release characteristics relevant to Diceroll

- Every GitHub subrequest spends from a **5,000/hour installation quota** shared by all products on
  that installation (`gateway.ts:13-19, 69-90`). Quota exhaustion maps to 503 (`gateway.ts:271-285`).
- Sparkle signature verification reads the whole DMG into the isolate, with a cap of
  `MAX_VERIFY_BYTES = 256 MiB` (`services/release/sparkle.ts:24, 75-125`). Workers isolates have
  128 MB, so a DMG approaching ~100 MB will fail verification and the appcast will 404. Diceroll's
  DMG is ~60 MB compressed, so it is borderline-OK.

---

## 2. Update service

**Surfaces** (`services/update/routes.ts`):

- `GET /<p>/update/appcast.xml[?arch=]` — stable channel.
- `GET /<p>/update/<channel>/appcast.xml[?arch=]`.
- `GET /<p>/update/version[?channel=]`.
- Plus permanent aliases `/<p>/appcast.xml`, `/<p>/<channel>/appcast.xml` and `/<p>/version` (`router.ts:154-183`).
- Update owns **no tables**. It renders over Release (`services/update/index.ts:1-9`).
- It cannot be enabled without Release (`core/services.ts:259` `update_requires_release`).

**Feed formats:**

- **Sparkle appcast**, generated on the fly with a single `<item>` for the newest release on the
  channel, for one arch (`services/update/feed.ts:141-229`; renderer `appcast.ts:94-128`).
- **`/version`**: unsigned JSON `{version, tag, url}` (`feed.ts:93-116`).
- Nothing else: no JSON feed, no multi-platform manifest, no content catalog.

**Eligibility logic:**

- `updateParams` normalises channel and arch (`services/update/eligibility.ts:40-53`).
- Real eligibility exists only under the **`entitled`** access mode. Core's `entitledAccessCheck`
  (`core/entitledAccess.ts:145-189`) runs three checks:
  1. a device token plus a usable licence, else **401**;
  2. the requested channel is in the licence's `channels` entitlement (`stable` is always allowed), else **403 `channel_not_allowed`**;
  3. a pinned version lies in the intersection of the product `compat_min/max` window and the
     licence's `app.minVersion/maxVersion`, else **403 `version_blocked`** plus `allowedRange`.
- Moving selectors aren't version-checked (`access.ts:81-103`).
- Under `public`, everyone gets the same feed.

**Staged / percentage rollouts:** **none.** There is no rollout column, cohort, bucket or
percentage anywhere. Grep for rollout/percent/cohort in `PK/packages/worker/src`; the only
match is `release_channels.policy_json`, which is always written as `NULL` (`store.ts:407`).

**Min-version / kill switches:**

- The feed has no `minimumVersion`, `critical` or `blocked` field. Only
  `sparkle:minimumSystemVersion` (the OS version) exists, and it is operator-owned (`feed.ts:126-139`).
- The product compat window (`update/admin.ts:72-162`; `core/products.ts:176-193`) is enforced
  only on the **licence document** build gate (`core/gate.ts:111-159`, D-20) and on `entitled` feeds.
- "The version check only ever informs… neither one blocks an out-of-date client"
  (`services/update/index.md:132-142`).
- A de facto kill switch is to withdraw or unpublish the GitHub release.

**Channels:** each channel is its own appcast URL (`update/index.md:81-86`). Discovery lists
`stable`, `beta` and the manual channels (`update/index.ts:39-60`).

**Caching:**

- Appcast and changelog: `max-age=300`. Moving selectors: `max-age=120`. Pinned versions:
  `max-age=86400, immutable` (`gateway.ts:65-67`).
- The Cache API is used **only when the effective mode is `public`**. The key is synthesised from
  (product, kind, version, channel, arch), never the raw query (`gateway.ts:118-141, 188-203, 249-253`).
- **Important cost/latency detail:** the cache lookup runs *after* `loadProduct`. `src/index.ts:75-77`
  calls `core/products.ts:102-142` (3 D1 queries plus AES-GCM unsealing of the signing key) and
  then `getReleaseConfig` (`gateway.ts:182`) on *every* request, cache hit or not.

**Are feeds signed?**

- **No JWS on any Update surface.** The appcast is XML with `sparkle:edSignature` copied from a
  `<dmg>.sig` release asset.
- The Worker *verifies* that EdDSA signature over the DMG bytes against `sparkle_ed25519_pub` as a
  **publishing gate** and memoises the verdict in KV for 1 day (`feed.ts:166-202`; `sparkle.ts:75-125`).
- Signing is required by default. Only an operator can switch that off (`config.ts:89-120`).
- The trust anchor stays Sparkle's own `SUPublicEDKey` in the app bundle
  (`services/update/sparkle.md:54-75`).
- `/version` is plain unsigned JSON.

**Device principal required?** No. `public` (the default) allows anonymous access
(`access.ts:120`). `authenticated`/`licensed`/`entitled` require a `pkeyt_` bearer token backed
by a usable licence (`access.ts:143-151`; `core/entitledAccess.ts:62`).

---

## 3. Trust and signing

**Key hierarchy (flat, per product):**

- **`PLATFORM_KEK`** is an AES-256-GCM keyring held in Worker secrets (`PLATFORM_KEK_KEYS` +
  `PLATFORM_KEK_ACTIVE`, or the legacy single key) (`PK/packages/worker/src/env.ts:14-46`;
  `keyvault.ts:1-15, 20-31`).
  - It seals every product signing key and product secret in D1, with AAD
    `pkey:v2:<product>:<kind>:<id>` (`keyvault.ts` `aad()`).
  - KEK rotation is supported via the keyring and a re-seal sweep (`PK/docs/RUNBOOK.md:135+`).
    This makes `THREAT-MODEL.md:28` ("Cannot be rotated today") **stale**.
- **One Ed25519 key per product** (`product_keys`, `migrations/0003_keyvault.sql:24-36`).
  - Status is `staged | active | retired | revoked`, with at most one active key
    (`0006_hardening.sql:11`; `0012`).
  - The private key is generated server-side and **never exported** (`admin/handlers/products.ts:908-964`).
  - It is opened per request in `loadProduct` (`core/products.ts:102-142`).
- **The same product key signs everything:**
  - licence document, config document, trust manifest and offline bundle (`core/signing.ts:29-36`; `core/trust.ts:98-103`);
  - it would also sign any new catalog type.
- Domain separation is `typ` only (`PK/docs/security/WIRE-CONTRACT-V3.md:24-33`;
  `PK/packages/shared-jws/src/index.ts:31-35`).
- There is **no offline root key and no delegation**. The trust manifest is signed by the
  *currently active* product key (`core/trust.ts:58-104`).

**Wire format** (frozen; `WIRE-CONTRACT-V3.md:12-22`; `shared-jws/src/index.ts:275-379`):

- Compact JWS with header `{"alg":"EdDSA","typ":…,"kid":…}` in fixed key order.
- Header ≤ 1024 bytes; payload ≤ 64 KiB (the bundle is the one exception at 256 KiB).
- Strict base64url, duplicate-JSON-key rejection, verify before parse, and `kid` selects a key from
  the caller's trust set only.

**kid rotation** (`admin/handlers/products.ts:892-1040`; docs `admin/secrets-and-keys.md:44-86`):

1. `POST …/keys/rotate` (prepare) mints a **staged** key. Staged keys are published in JWKS and the
   trust manifest (`repo.ts:347-374`).
2. `activate` is refused until `TRUST_CACHE_SECONDS=300` has passed since staging (unless
   `breakGlass`). It retires the old active key and promotes the staged one in one batch (`:966-999`).
3. `retire` / `revoke` apply to non-active keys only (`:1001-1037`).
4. Revoked keys stay listed with `status:"revoked"` for 2 × cacheSeconds (`core/trust.ts:64-72`;
   `repo.ts:347-374`).
   - Doc drift: `services/core/trust.md:91` still says revoked keys are never emitted.

**Trust manifest (`pkey-trust+jws`):**

- Payload `{schemaVersion:1, aud, iss, issuedAt, expiresAt=issuedAt+300, jwksUrl, cacheSeconds:300,
  keys[{kid,alg,kty,crv,publicKey,status}]}`, served at `GET /<p>/.well-known/polaris-trust.jws`,
  `max-age=300` (`core/trust.ts:22, 58-120`).
- Clients verify it **against pinned keys only**. Pins are spread last. The discovered set is
  **replaced wholesale** (absence means revocation). A pinned kid with different bytes rejects the
  whole manifest. Non-EdDSA entries are skipped (`WIRE-CONTRACT-V3.md:16-19`;
  `PK/packages/client-core/src/trust.ts:26-28, 68-116`).
- Discovery also publishes `trust.pinnedKeys` **unsigned** (`core/discovery.ts:49-…`). That is
  informational and never a trust root.

**Consequence for a game:**

- After `activate`, new trust manifests are signed by a kid that old builds may not have pinned.
  The corpus case `trust-signed-by-non-pinned-key` pins this behaviour as a rejection.
- Such builds keep their last discovered set, so documents signed by the new key still verify if
  the client saw it while it was staged. But their trust refresh and clock-floor advancement stop
  until a build with the new pin ships.
- **Pin the active key plus a pre-staged next key in every build.** Rotate no faster than your
  slowest store-update cohort.

**Expiry and `graceUntil`** (`WIRE-CONTRACT-V3.md:35-48, 86-97`; `core/documents.ts:71-151`):

- Documents: `expiresAt = issuedAt + 3600`; `graceUntil = issuedAt + maxOfflineDays × 86400`, capped
  at 365 days at verify time; `CLOCK_SKEW_SECONDS = 300`; `REFRESH_MARGIN_SECONDS = 1800`.
- Network path: reject when `now > expiresAt + skew` or `issuedAt > now + skew`.
- Reload path: only `graceUntil` bounds it (`client-core/src/verify.ts:102-135`).

**Clock floor:** `effectiveNow = max(systemClock, max(issuedAt of verified licence, config and
trust manifest))` (`WIRE-CONTRACT-V3.md:127-136`; `client-core/src/clock.ts:26-41`). Core
refreshes trust on its own cadence so the floor keeps moving for any service mix.

**Replay and rollback protection:**

- Per-type anti-replay floors: `issuedAt` must be strictly newer than the accepted document of the
  same type (`verify.ts:119-124`).
- Trust manifests use `lastTrustIssuedAt` (`client-core/src/trust.ts:85-90`).
- Bundle import is all-or-nothing (`WIRE-CONTRACT-V3.md:178-186`).
- Server side: GitHub delivery-GUID dedupe (§1.1).
- None of this exists in Diceroll's current updater:
  - `DR/game/update/update_manifest.gd:115-154` has no expiry and no sequence number;
  - no-downgrade (`update_policy.gd:209-224`) stops version rollback but not freeze or
    kill-switch suppression.

**Can CI request signing?**

- **No.** The admin API's only credential is the console's OIDC browser session plus a CSRF
  double-submit. The CLI tells you to copy the `__Host-pkey_admin` cookie out of devtools
  (`PK/packages/cli/README.md:151-169`; `PK/packages/docs/src/content/docs/admin/bundles.md:53`;
  `agents/recipes.md:117`).
- There is no API token, no GitHub Actions OIDC trust, and no generic "sign this document"
  endpoint. The only on-demand signing is the admin-only, device-bound **offline bundle mint**
  (`core/bundles.ts:171-368`).
- `jose` is already a dependency, used for IdP ID tokens (`R7-supply-chain.md:609`), so verifying
  GitHub OIDC tokens is cheap to add.

---

## 4. Device principal, License and Config

**Can an anonymous install register cheaply?**

- Yes, if the product's registration policy is `open`. The default is derived: `requires-license`
  if License is on, else `requires-identity`, else `open` (`WIRE-CONTRACT-V3.md:150-157`;
  `core/register.ts:19-27`).
- `POST /<p>/devices/register` is keyless and reads `X-PKey-Device`, which must be a 32-character
  base64url id (`register.ts:73, 142-147`).
- It returns a `pkeyt_` token (`register.ts:179`).
- Cost per registration:
  - 1 Durable Object call (the rate limiter);
  - ~2 D1 reads and 1–2 D1 upserts (`core/devices.ts:494-557`);
  - 1 KV write with a 30-day TTL (`kv.ts:69-80`).
- Re-registering rotates the token. Licensed ids can't be re-registered (`register.ts:149-160`).

**Rate limits:**

- `register` allows **10/min per IP, fail-closed** (`register.ts:112-121`; `core/rateLimit.ts:62-108`).
  - This is a real risk for mobile carriers behind CGNAT and for launch-day bursts.
- Release metadata allows 30/min/IP and artifacts 120/min/IP, on cache misses only, fail-open (`gateway.ts:89-90, 217-236`).
- All limits run through **one Durable Object per product** (`rateLimit.ts:118`; `rateLimitDo.ts:4-24`).
  - The file itself calls this sharding an unfixed chokepoint (R10-04a).

**Other costs of the device model:**

- Every device-authenticated document fetch writes the device row (`touchDeviceMetadata`,
  `core/devices.ts:653-669`; called from `services/config/document.ts:84`).
- Unlicensed device rows are **never pruned**. The daily sweep only clears licensed seats
  (`repo.ts:1070-1087`; `scheduled.ts`).
- Registration also creates an app-scoped identifier that has to be disclosed in App Store privacy
  labels and the Play Data Safety form. A static catalog needs none.

**Could Config deliver balance tuning, feature flags or live events?**

- **Mechanically yes, but it's a poor fit.** The config document (`pkey-config+jws`) is per device,
  `no-store`, expires after 1 hour, and is built for each device on each fetch
  (`services/config/document.ts:71-128`).
- For licence-less devices only two layers apply: **catalog defaults and per-device overrides.**
  Tier and profile layers need a licence (`core/payload.ts:111-140`).
  - So a global change means publishing a new catalog (`.pkey/schema` push or `PUT catalog`).
  - There are no cohorts, no percentage targeting, no platform or version targeting, and no time windows.
- `flag`-kind entries ride the **licence** document and are unavailable without License
  (`services/config/catalog.md:20-30`).
- Values are typed and validated against JSON-Schema fragments (`core/payload.ts:157-189`), and
  `enforced`/`default`/`hidden` states exist (`shared-protocol/src/core.ts:26-40`).
- **Recommendation:** put live-ops flags, event windows and tuning overrides into the public signed
  content catalog (`flags` block, §6.4). Evaluate them client-side against `effectiveNow`. Keep
  per-device Config for true per-device secrets, of which Diceroll has none.

**Could License gate paid DLC or supporter packs across platforms?**

- **Not realistically.** Licences are licence-key or identity-provisioned, device-seat-bound
  grants. Seat limits and hardware fingerprints are built for desktop software
  (`services/license/*`; `core/devices.ts:356+`).
- There is no store receipt validation: no StoreKit/App Store Server API, no Play Billing, no Steam
  ownership check.
- Diceroll has no user accounts, so a purchase made on one platform can't follow the player.
- Store policies also apply: iOS digital unlocks must use IAP (3.1.1), with the multiplatform
  exception 3.1.3(b) only if IAP is also offered. Play requires Play Billing. Steam DLC is
  owned through Steam.
- **Recommendation:**
  - Use store-native entitlements per platform. The catalog marks a pack `entitlement: "supporter"`
    and the client checks StoreKit, Play or Steam before mounting.
  - For direct/sideload builds, an optional Polaris licence key could gate a *presigned* download (§6.5).
  - The packs are cosmetic, CC0-derived data, so DRM beyond that isn't worth building.

---

## 5. Cloudflare costs and limits

Load: 100k installs × a check every 6 h = 400k checks/day ≈ **12.0M/month**.

**Prices (current Cloudflare docs, fetched 2026-09-29):**

- Workers Paid: $5/month, 10M requests included then $0.30/M; 30M CPU-ms included then $0.02/M CPU-ms.
- Workers Free: 100k requests/day and 10 ms CPU per invocation.
- KV (Paid): 10M reads/month then $0.50/M; 1M writes then $5/M.
- D1 (Paid): 25B rows read/month then $0.001/M; 50M rows written/month then $1/M; 5 GB then $0.75/GB-month.
  - Since **2026-09-01, D1 on the Free plan hard-fails** past 5M rows read/day or 100k rows written/day.
- R2 Standard: $0.015/GB-month (10 GB free); Class A $4.50/M (1M free); Class B $0.36/M (10M free); **egress free**.
- An R2 public bucket on a custom domain can use the Cloudflare cache ("Cache Everything"; Smart Tiered Cache recommended).
- Static assets are free.

| Scenario | Monthly requests hitting Worker | Other metered | Est. cost |
|---|---|---|---|
| **A. Static signed catalog + packs on R2 custom domain, CDN-cached** (TTL 60–300 s for catalogs, `immutable` for packs, tiered cache) | 0 | R2 Class B only on upper-tier misses: ≈ 10 catalog objects × 12/h × 720 h ≈ 86k (free tier); pack egress free | **$0** (works on the Free plan) |
| **B. Polaris Worker serves a public, edge-cached signed catalog** (current Update-style pipeline) | 12M (cache lookup happens *inside* the Worker, after `loadProduct`) | ~3–4 D1 rows read/request ≈ 45M rows (≪ 25B); CPU ~1–3 ms/request ≈ 12–36M CPU-ms | **≈ $5.6–6.2** (the Free plan's 100k/day is exceeded 4×) |
| **C. Per-device signed docs** (register + `GET /config/document` every 6 h) | 12M | KV 12M token reads (+$1); D1 ≈ 84M rows read, ~12–24M rows written (within included); Ed25519 sign + unseal CPU ≈ 24–48M CPU-ms; DO 100k register calls | **≈ $7–8**, plus a privacy disclosure and CGNAT rate-limit risk |

- Pack egress at, say, 100k installs × 30 MB/month = 3 TB costs **$0** on R2/CDN.
- Storage for ~3–5 GB of versioned packs and deltas is inside the 10 GB free tier.

**Limits that matter:**

- **Workers:** 128 MB memory per isolate (see the Sparkle 256 MiB read, §1.6); subrequests capped
  per request (the audit cites 50 on Free, 1000 on Paid, `R10-dos.md:298`); request body limits on
  uploads through a Worker. Use presigned or direct R2 uploads instead.
- **D1:** 10 GB per database; single primary (latency from far regions unless read replication is used).
- **The single rate-limit Durable Object per product** (§4).
- **The GitHub 5,000/h installation quota** for any GitHub-backed surface (§1.6).

**Conclusion:** cost is negligible in every design. The static design is the only one that is
free, needs no Worker plan and has no single-region dependency on the hot path.

---

## 6. Gap analysis and design

### 6.1 Gaps, concretely

1. **No content catalog document type.** `JwsTyp` is closed to licence, config, trust and bundle
   (`shared-jws/src/index.ts:31-35`). AGENTS rule 2 makes any wire change an all-languages event
   with a corpus regeneration (`PK/AGENTS.md:113-118`).
2. **No R2** binding or code path; `release_artifacts.storage_key` is unused (§1.2).
3. **No rollout, kill-switch or min-client fields** in any feed (§2).
4. **Feeds are unsigned** (§2).
5. **No CI credential** (§3).
6. **No CORS** anywhere in the Worker. `grep -ri access-control-allow-origin
   PK/packages/worker/src` returns nothing. A Godot Web build on itch.io or GitHub Pages can't
   call discovery, trust, register or any feed.
7. **Artifact naming and platform model is macOS/CLI-centric** (arm64/x86_64; DMG or bare binary).
8. **The hot path touches D1 and the KEK before the cache check** (`src/index.ts:75-77`).
9. **No Godot SDK.** The existing SDKs rely on WebCrypto, `cryptography` or CryptoKit for Ed25519
   (`sdks/python/src/polaris_key/core/jws.py:49-53`; `sdks/swift/Sources/PolarisKeyCore/JWSVerifier.swift:29, 144-156`).

### 6.2 Architecture options

| | **S. Standalone static** (CI signs, R2 serves, no Worker) | **P. Polaris Content service** (Worker stores + signs + serves) | **H. Hybrid** (CI builds and uploads; Polaris *signs*; R2 serves static JWS) |
|---|---|---|---|
| Hot-path availability | CDN + R2 only | Worker + D1 + KEK + DO (a KEK misconfiguration 404s every product route; `RUNBOOK.md:336`) | CDN + R2 only |
| Signing key custody | GitHub Actions secret (same as today's RSA `UPDATE_SIGNING_KEY`) | KEK-sealed in D1, never exported, rotation tooling, audit | KEK-sealed; CI never holds a signing key |
| Freshness re-signing | Scheduled GH Action (daily) | Worker cron | Worker cron re-signs and writes to R2 |
| Kill switch / rollout UX | `gh workflow run content-policy -f …` (≈ 2–5 min to live) | Console buttons, immediate | Console/CLI, immediate |
| Web CORS | R2 bucket CORS policy | Must add CORS to the Worker | R2 bucket CORS policy |
| Privacy | No identifiers | No identifiers if catalog is public | No identifiers |
| Polaris governance cost | none | new service + wire type + corpus + CLI + admin UI | same as P, minus the serving path |
| Effort (one person) | **~1.5–2.5 weeks** incl. Godot SDK core | ~4–6 weeks | ~3–4 weeks on top of S |
| Monthly cost | $0 | ~$6 | ~$0–5 |

**Recommendation: S now, H later, never P's "Worker serves the catalog".**

- Design the static catalog **byte-compatible with Polaris** from day one: EdDSA compact JWS,
  Polaris header order, `iss: "key.plrs.im"`, `aud: "diceroll"`, the new `typ`.
- Moving from S to H is then only a trust-set change in the client (pin the CI key and the Polaris
  kid during the transition build) plus a publishing change in CI.
- Why S first for a solo maintainer:
  - it removes a runtime dependency on a multi-tenant control plane that is still evolving;
  - it keeps the game playable and updatable if Polaris is down;
  - it needs no Workers Paid plan;
  - it solves Web CORS with one bucket setting;
  - it can ship alongside the content-pack phases already planned in
    `DR/docs/design/2026-09-29-content-streaming.md:51-59, 444-457`.
- H becomes worth it once staged rollouts and one-click kill switches are used weekly, or once a
  second game or product wants the same pipeline.

### 6.3 R2 layout and serving

- Bucket `diceroll-content`, custom domain `cdn.<domain>`. Enable Smart Tiered Cache and a Cache
  Rule "Cache Everything" (only some extensions are cached by default).
- **Immutable, content-addressed objects:**
  - `p/<sha256>.pck` for packs; the path carries only the hash, so identical bytes dedupe across packs and versions;
  - `d/<from_sha256>-<to_sha256>.<algo>` for deltas.
  - Headers: `Cache-Control: public, max-age=31536000, immutable`. Upload with
    `x-amz-checksum-sha256` so R2 records the SHA-256 and a later HEAD can confirm it.
- **Mutable catalog objects:** `c/<channel>/<platform>.jws` with `max-age=60–300` (and
  `stale-if-error`). Optionally also `c/<channel>/<platform>/<seq>.jws` as an immutable history copy.
- **Proxy or redirect?**
  - **Neither for public content.** Serve straight from the R2 custom domain: no Worker invocation,
    no CPU, CDN-cached, `Range`-capable for Godot's resumable `HTTPRequest.download_file`.
  - For **gated** packs, the Worker returns a **302 to an R2 presigned URL** (S3 SigV4, TTL ≤ 1 h).
    It doesn't stream the bytes itself. Godot `HTTPRequest` follows redirects
    (`DR/game/update/update_fetcher.gd:91-96`).
  - Worker streaming, as Release does from GitHub, is only justified when every request must be
    authorised *and* edge-cached. Diceroll doesn't need that.
- **CORS:** allow `GET, HEAD` from the Web origins (itch.io HTML5 zones, GitHub Pages, the game's
  own domain), and expose `Content-Length`, `Content-Range`, `ETag`.
- **Integrity:**
  - The signed catalog carries each pack's `sha256` and size, so a compromised bucket or CDN can
    only cause denial of service, never code or content substitution.
  - Packs remain **data-only** and are mounted with `replace_files=false`, as the design doc
    already requires (`content-streaming.md:271-276, 339-348`).
- **Platform-native sources:** the catalog lists the pack for governance (enable, disable, rollout,
  hash) with `source: "embedded" | "platform" | "cdn"` and platform-native identifiers:
  - Apple Background Assets pack id;
  - Play asset-pack name;
  - Steam depot or DLC app id.
  The bytes then come from the platform. The client still checks the hash after the platform
  delivers the pack (cheap, native SHA-256).

### 6.4 The signed catalog document: `pkey-catalog+jws`

**Header:** `{"alg":"EdDSA","typ":"pkey-catalog+jws","kid":"<kid>"}`, in the frozen key order.

**Payload:** ≤ 64 KiB, so publish one catalog per (channel, platform) to stay small. About 40 packs × 400 bytes ≈ 16 KB.

```jsonc
{
  "iss": "key.plrs.im",            // fixed; same rule as WIRE-CONTRACT-V3 §8
  "aud": "diceroll",               // product slug
  "schemaVersion": 1,              // catalog format version (fail closed on unknown)
  "channel": "stable",             // must equal the client's requested channel
  "platform": "web",               // macos|windows|linux|android|ios|web|any
  "seq": 1842,                     // monotonic per (aud, channel, platform): content version
  "issuedAt": 1790640000,
  "expiresAt": 1791244800,         // issuedAt + 7 d; freshness (re-signed daily)
  "graceUntil": 1793232000,        // issuedAt + 30 d; how long a cached catalog may drive enforcement offline
  "cdn": "https://cdn.example/",   // base for relative object keys (never trusted for integrity)

  "client": {                      // kill switches / forced update (replaces min_binary/min_supported)
    "minBinary": "0.5.0",
    "blockedBinaries": ["0.4.2"],
    "stores": {"ios": "https://apps.apple.com/…", "android": "https://play.google.com/…"},
    "binaries": {"linux.x86_64": {"version": "0.6.1", "url": "…", "sha256": "…", "size": 91234567}}
  },

  "code": {                        // desktop/sideload only; same as today's `pack`, pinned to exact data packs
    "version": "0.6.1", "key": "p/<sha256>.pck", "sha256": "…", "size": 4900000,
    "engine": "4.7", "requiresPacks": {"core3d": "<sha256>", "foes": "<sha256>"}
  },

  "packs": [
    {
      "id": "weapons-2026-10",     // [a-z0-9-]{1,64}
      "version": 3,
      "sha256": "…", "size": 1843200, "key": "p/<sha256>.pck",
      "source": "cdn",             // embedded | platform | cdn
      "platformRef": null,         // {"appleAssetPack":"…"} | {"playAssetPack":"…"} | {"steamDepot":1234}
      "engine": "4.7", "format": 1,                       // never mount on mismatch
      "requires": {"binary": ">=0.5.0", "caps": ["tex:astc"]}, // capability requirements
      "stage": 5, "required": false,
      "entitlement": null,         // or "supporter": client checks the store before mounting
      "deltas": [
        {"from": "<sha256 of v2>", "algo": "godot-pck-delta", "key": "d/<from>-<to>.pd", "sha256": "…", "size": 120000}
      ],
      "rollout": {                 // staged rollout, bucketed client-side
        "pct": 25, "salt": "wpn-2026-10-v3",
        "fallback": {"version": 2, "sha256": "…", "key": "p/<sha256>.pck", "size": 1790000}
      },
      "disabled": false            // kill switch for this pack: unmount, use fallback/embedded
    }
  ],

  "flags": {                       // small live-ops block, evaluated against effectiveNow
    "event.halloween": {"from": 1792800000, "to": 1793500000, "value": true},
    "balance.overrides": {"crit_mult": 1.5}
  }
}
```

**Client verification rules** (the `pkey-catalog+jws` section to add to the wire contract):

1. Run the ordinary JWS verification pipeline with `typ == "pkey-catalog+jws"` and the default
   64 KiB cap (`WIRE-CONTRACT-V3 §1`).
2. Check `iss`, `aud`, `channel`, `platform` and `schemaVersion ∈ {1}`.
3. `issuedAt`, `expiresAt`, `graceUntil` and `seq` must be numbers; `graceUntil ≥ expiresAt`;
   `graceUntil ≤ issuedAt + 365 d`.
4. Network path: reject when `issuedAt > now + 300` or `expiresAt ≤ now − 300`. Reload path: skip
   the freshness check (a cached catalog is expected to be stale).
5. **Anti-rollback:**
   - reject when `seq < lastSeq`;
   - reject when `seq == lastSeq` but the payload differs from the stored one (same content version
     must mean the same content);
   - reject when `issuedAt < lastIssuedAt`.
   - A byte-identical re-fetch is a no-op.
6. Fold `issuedAt` into the monotonic clock floor, next to the trust manifest (§3).
7. Per pack: `sha256` must be 64 hex characters and `size > 0`. A malformed entry rejects the
   **whole** catalog, which is fail-closed and matches the Polaris style.
8. **Enforcement:**
   - past `expiresAt` but before `graceUntil`: keep using verified content, honour kill switches,
     and install **no new** bytes;
   - past `graceUntil`: the catalog is "unverified". Keep playing embedded and cached content but
     enforce nothing new.
   - Never block offline play; the game is offline-friendly.
9. **Rollout bucket:** `bucket = u32(SHA-256(salt ‖ install_id)[0..4]) mod 10000`. Use the
   candidate when `bucket < pct × 100`. `install_id` is a local random value and is **never
   transmitted**. Players who force themselves into a rollout gain nothing harmful.

A **Polaris trust manifest** is optional in the static phase. The client pins the catalog key(s)
directly. In the H phase, the SDK refreshes `/.well-known/polaris-trust.jws` on its own cadence,
exactly as Core does (`WIRE-CONTRACT-V3 §4.2`). The trust manifest needs no CORS if it is mirrored
to R2 by the Worker cron.

### 6.5 Polaris "Content" service (phase H) — concrete changes

**Composition.** Add a `services/content/` directory with a descriptor.

- Registration touches:
  - `mount.ts:25-31`;
  - `router.ts:41-47` (`SERVICE_NAMESPACES`);
  - `core/services.ts:20-35` (`ServiceSlug`, `SERVICE_SLUGS`);
  - `shared-manifest` `MODULE_SERVICES` (`shared-manifest/src/index.ts:268-280`), plus a schema
    and mutation-table entries (AGENTS rule 9, `AGENTS.md:160-166`).
- Content must not import Release. It needs nothing from Release (AGENTS rule 6, `AGENTS.md:142-145`).
- Keep it product-agnostic: products are data (AGENTS rule 5).

**Wrangler / env:**

```toml
[[env.prod.r2_buckets]]
binding = "CONTENT"
bucket_name = "diceroll-content"   # or one bucket per product: "pk-content-<slug>" (config data, not code)
[triggers]
crons = ["17 3 * * *", "*/30 * * * *"]   # add: re-sign catalogs nearing expiry
# secrets: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (only if presigned URLs are issued)
```

**D1 migration draft** (`0022_content.sql`; one `ALTER` per file where needed, per the repo convention):

```sql
CREATE TABLE IF NOT EXISTS content_packs (
  product      TEXT NOT NULL REFERENCES products(slug),
  pack_id      TEXT NOT NULL,                  -- [a-z0-9-]{1,64}
  title        TEXT,
  stage        INTEGER NOT NULL DEFAULT 0,
  required     INTEGER NOT NULL DEFAULT 0,
  entitlement  TEXT,                           -- NULL = free
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (product, pack_id)
);
CREATE TABLE IF NOT EXISTS content_pack_versions (
  product      TEXT NOT NULL,
  pack_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  r2_key       TEXT NOT NULL,                  -- 'p/<sha256>.pck'
  engine       TEXT NOT NULL,                  -- '4.7'
  format       INTEGER NOT NULL,
  platforms_json TEXT NOT NULL DEFAULT '["any"]',
  requires_json  TEXT,                         -- {"binary":">=0.5.0","caps":[...]}
  platform_refs_json TEXT,                     -- appleAssetPack / playAssetPack / steamDepot
  provenance_json TEXT NOT NULL,               -- {repo, sha, run_id, workflow} from the OIDC token
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (product, pack_id, version),
  UNIQUE (product, sha256),
  FOREIGN KEY (product, pack_id) REFERENCES content_packs(product, pack_id)
);
CREATE TABLE IF NOT EXISTS content_deltas (
  product TEXT NOT NULL, pack_id TEXT NOT NULL,
  from_sha256 TEXT NOT NULL, to_sha256 TEXT NOT NULL, algo TEXT NOT NULL,
  sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, from_sha256, to_sha256, algo)
);
-- Moving pointers + rollout + kill switch, per (channel, platform, pack).
CREATE TABLE IF NOT EXISTS content_channel_packs (
  product TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL, pack_id TEXT NOT NULL,
  version INTEGER NOT NULL,                    -- current (the rollout fallback)
  candidate_version INTEGER,                   -- NULL = no rollout in progress
  rollout_pct INTEGER NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  rollout_salt TEXT,
  source TEXT NOT NULL DEFAULT 'cdn' CHECK (source IN ('cdn','embedded','platform')),
  disabled INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT,
  modified_at INTEGER NOT NULL, modified_by TEXT,
  PRIMARY KEY (product, channel, platform, pack_id)
);
CREATE TABLE IF NOT EXISTS content_policy (   -- client kill switches + flags per (channel, platform)
  product TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL,
  min_binary TEXT, blocked_binaries_json TEXT, binaries_json TEXT, stores_json TEXT,
  code_json TEXT, flags_json TEXT,
  ttl_seconds INTEGER NOT NULL DEFAULT 604800, grace_seconds INTEGER NOT NULL DEFAULT 2592000,
  PRIMARY KEY (product, channel, platform)
);
CREATE TABLE IF NOT EXISTS content_catalogs (  -- append-only publish log (the audit trail + rollback source)
  product TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL, seq INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, kid TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, jws TEXT NOT NULL, reason TEXT NOT NULL, -- publish|rollout|kill|resign
  actor TEXT NOT NULL,
  PRIMARY KEY (product, channel, platform, seq, issued_at)
);
CREATE TABLE IF NOT EXISTS ci_publishers (     -- GitHub OIDC trust policy (manifest-owned via .pkey/content)
  product TEXT NOT NULL, repository TEXT NOT NULL,          -- 'vladzaharia/diceroll'
  ref_pattern TEXT NOT NULL,                                -- 'refs/tags/v*'
  environment TEXT,                                         -- 'production'
  workflow_ref TEXT,                                        -- '.github/workflows/release.yml@refs/tags/*'
  scopes_json TEXT NOT NULL,                                -- ["content:publish","content:resign"]
  PRIMARY KEY (product, repository, ref_pattern)
);
```

**Routes** (each needs an OpenAPI entry plus a `routeCoverage` row, AGENTS rule 10, `AGENTS.md:168-173`):

| Route | Auth | Purpose |
|---|---|---|
| `GET /<p>/content/catalog/<channel>/<platform>.jws` | public | Fallback/debug. Canonical delivery is the R2 object. Set `application/jose` and CORS; move the cache check before `loadProduct` |
| `POST /<p>/content/grant` | `pkeyt_` + usable licence (or a store-receipt adapter later) | returns 302 or JSON presigned R2 URLs for `entitlement` packs |
| `POST /manage/api/products/<p>/content/versions` | **GitHub OIDC** (`content:publish`) or admin session | register uploaded pack versions: HEAD R2 → size + `checksums.sha256` must match → insert |
| `POST /manage/api/products/<p>/content/publish` | OIDC or admin | atomically set channel pointers/policy → `seq+1` → sign → `CONTENT.put("c/<ch>/<platform>.jws")` → log |
| `PATCH /manage/api/products/<p>/content/channels/<ch>/<platform>/<pack>` | admin (or OIDC with scope) | rollout %, candidate, disable (kill), source |
| `PATCH /manage/api/products/<p>/content/policy/<ch>/<platform>` | admin | minBinary, blockedBinaries, flags |
| `POST /manage/api/products/<p>/content/resign` | admin/cron | refresh `issuedAt/expiresAt` without a `seq` change |
| `GET /manage/api/products/<p>/content/{packs,catalogs,health}` | admin | console views and R2 object health |

Discovery fragment (`services.content`): `{enabled, configured, cdnBase, catalog:
"{cdnBase}c/{channel}/{platform}.jws", channels, platforms}`.

**CI authentication with GitHub Actions OIDC.** Recommended, because Polaris already knows the repository via `release_config`.

1. The job declares `permissions: id-token: write` and requests
   `ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://key.plrs.im`.
2. The Worker verifies the token against GitHub's JWKS using `jose`:
   - `iss = https://token.actions.githubusercontent.com`;
   - `aud` matches;
   - `repository` and `repository_owner_id` equal the product's linked repo;
   - `ref` or `environment` or `job_workflow_ref` match `ci_publishers`;
   - `exp` and `nbf` are valid.
3. Grant only the scoped content actions. Audit with `actor = "gha:<repo>@<run_id>"`.
4. Provide an API-token fallback (`pkeyapi_…`, hashed like licence keys, product- and
   scope-limited) for local CLI use.

**Hot-path fix, if the Worker ever serves public GETs:** check a product-scoped Cache API key
**before** `loadProduct`. Today every request costs 3–4 D1 queries plus a KEK unseal (§2).

**`pkey` CLI additions** (`PK/packages/cli/src/index.ts:66-90`):

```
pkey content upload   --product diceroll --dir build/packs         # S3 PUT to R2 (CI creds), content-addressed, skips existing
pkey content register --product diceroll --packs build/packs.json   # POST versions (OIDC in CI, cookie locally)
pkey content publish  --product diceroll --channel beta --platform web --set weapons-2026-10@3 [--rollout 25]
pkey content rollout  --product diceroll --channel stable --platform all --pack weapons-2026-10 --pct 50
pkey content kill     --product diceroll --channel stable --platform all --pack weapons-2026-10 [--version 3] --reason "crash on load"
pkey content policy   --product diceroll --channel stable --platform ios --min-binary 0.6.0
pkey content verify   --catalog https://cdn…/c/stable/web.jws --pin kid=<b64url>   # CI smoke check after publish
```

**Admin UI additions:**

- A **Content** section filtered by `services_json` (the nav seam is in `packages/admin/src/route.ts:166-190`).
- Channel × platform matrix of catalogs: current `seq`, `issuedAt`, expiry countdown, "re-sign now".
- Pack table: versions, hash, size, source, deltas; a rollout slider; a **kill switch** with a reason; a candidate → promote flow.
- Client policy: `minBinary`, blocked binaries, flags JSON editor validated against a schema.
- Publish log (from `content_catalogs`) with diff and "republish previous seq as a new seq" (rollback).
- R2 health: object present, size and checksum match.

**Conformance vectors** (corpus, regenerated with `pnpm gen:corpus`; AGENTS rule 1):

- A `catalogCases` section:
  - `catalog-valid`, `catalog-expired` (network), `catalog-expired-reload-accepted`;
  - `catalog-past-grace-unverified`, `catalog-seq-rollback-rejected`;
  - `catalog-same-seq-different-payload-rejected`, `catalog-same-seq-newer-issuedAt-accepted`;
  - `catalog-aud-mismatch`, `catalog-channel-mismatch`, `catalog-platform-mismatch`;
  - `catalog-as-trust-manifest` and `trust-manifest-as-catalog` (typ confusion);
  - `catalog-bad-sha256-rejects-all`, `catalog-unknown-fields-tolerated`, `catalog-over-cap`;
  - `floor-catalog-raises-clock`.
- A `rolloutBucketCases` section (salt, install_id → bucket) so every SDK buckets identically.
- Add a Godot mirror to `tools/gen-mirrors.ts`, like the Swift mirror, and a Godot runner
  (`run_corpus.gd` prototype, §7).

**Governance note:** AGENTS rule 2 (`AGENTS.md:113-118`) says a new document type is a wire change
that every SDK must implement. Declare `pkey-catalog+jws` as a Core artifact verified by
`client-core` (Node) and the Godot SDK, and mark the Python and Swift SDKs as "not applicable", or
the cost doubles.

### 6.6 CI publish flow (both phases)

1. `tools/ci/build_packs.gd` (already planned in `content-streaming.md:458-462`) writes
   `build/packs/*.pck` and `packs.json` (id, version, sha256, size, engine, format, units).
2. Deltas (optional, packs are 1–20 MB): generate diffs against the last two published versions of
   each changed pack. Use Godot's own 4.6+ PCK delta format if the pack pipeline allows it,
   otherwise HDiffPatch or `zstd --patch-from`. Keep the `algo` field opaque.
3. Upload new hashes to R2. `aws s3 cp` / `rclone` / `wrangler r2 object put` with
   `--checksum-algorithm SHA256`. Existing keys are skipped (immutable).
4. **Phase S:** `tools/ci/catalog.py` merges `packs.json` with `content/policy/<channel>.json`
   (committed; holds rollout, kill, minBinary and flags), bumps `seq` (taken from the currently
   published catalog + 1) and signs.
   - Signing is Ed25519 compact JWS with `openssl pkeyutl -sign -rawin`, the key coming from
     `CATALOG_SIGNING_KEY`. In CI, use the `cryptography` Python package: the local system copy is
     broken, so the scratch tests used OpenSSL.
   - Upload `c/<channel>/<platform>.jws`.
   - A scheduled workflow (daily) re-signs with a fresh `issuedAt`/`expiresAt` and the same `seq`.
   - `workflow_dispatch` inputs cover the kill switch and rollout percentage.
   - **Phase H:** replace the signing step with `pkey content register` + `publish`, authenticated
     by OIDC.
5. **Transition:** keep writing the old RSA `update-<channel>.json(.sig)` for already-shipped
   binaries (`DR/tools/ci/update_manifest.py:95-104`) until their `min_supported` drops them.

### 6.7 Effort estimates (one person, familiar with both repos)

| Work item | Phase | Estimate |
|---|---|---|
| Catalog JSON schema + `catalog.py` signer + R2 upload + daily re-sign + policy workflows | S | 2–3 d |
| Godot SDK core (Ed25519/SHA-512, JWS, catalog verify, floor, cache) from the prototype | S | 3–4 d |
| Godot pack manager (plan, Range resume, SHA-256, stage, mount, evict, rollout bucket), reusing `update_fetcher`/`update_store` | S | 3–5 d (overlaps content-streaming Phase 1/3) |
| Godot conformance runner + vectors | S | 1 d |
| **Phase S total** | | **≈ 1.5–2.5 weeks** |
| Polaris `content` service (routes, D1, R2 binding, signing, cron re-sign, discovery, OpenAPI/routeCoverage, tests incl. attack tests) | H | 6–9 d |
| GitHub OIDC CI auth (+ API-token fallback) | H | 2–3 d |
| `pkey content …` CLI | H | 1–2 d |
| Admin console Content section | H | 3–4 d |
| Wire: shared-protocol types, client-core `verifyCatalog`, corpus `catalogCases`, WIRE-CONTRACT addendum, mirrors | H | 2–3 d (+2–3 d if Python/Swift must follow) |
| **Phase H total** | | **≈ 3–4.5 weeks** |
| Optional: store-receipt → licence adapters (App Store Server API, Play Developer API, Steam) | later | 1–2 weeks each |

---

## 7. Godot SDK

### 7.1 Can Godot 4.7.2 verify Ed25519 natively? No (measured)

Probe `SP/probe/probe.gd`, keys and signatures made with OpenSSL 3.0.13, run with
`godot --headless --path SP/probe -s probe.gd`:

| Algorithm | `CryptoKey.load(pub)` | `Crypto.verify` valid / tampered |
|---|---|---|
| RSA PKCS#1 v1.5 SHA-256 | OK | true / false |
| RSA-PSS | OK | false (not supported by `Crypto.verify`) |
| **ECDSA P-256 (DER sig)** | OK | **true / false** |
| **Ed25519** | **Failed**: `Error parsing key '-15488'` (`-0x3C80`, mbedTLS `PK_UNKNOWN_PK_ALG`) | — |

- `HashingContext` offers only `HASH_MD5`, `HASH_SHA1` and `HASH_SHA256`. **There is no SHA-512**,
  which Ed25519 requires.
- No engine class mentions ed25519, eddsa, curve25519 or sodium.
- `JavaScriptBridge` exists (Web).
- **GDScript integer semantics** (`SP/probe/intsem.gd`): runtime ints wrap on overflow and `>>` is
  arithmetic. `<<` of a negative operand is refused only in parse-time constant folding and works
  at runtime. Both properties are needed for a GDScript field implementation.

### 7.2 Pure-GDScript Ed25519: implemented and measured

**Files:**

- `SP/proj/addons/polaris_key/crypto/ed25519.gd` (553 lines):
  - ref10-layout GF(2^255−19) in ten 25.5-bit limbs on int64;
  - fully unrolled `fe_mul`/`fe_sq`, generated by `SP/gen_fe.py` so every term is a single multiply;
  - RFC 8032 §5.1.4 extended-coordinate add and double;
  - Straus joint double-and-add over `[S]B + [k](−A)`;
  - TweetNaCl `modL`;
  - rejects non-canonical `y`, rejects `S ≥ L`;
  - a pure-GDScript SHA-512.
- `SP/proj/addons/polaris_key/core/jws.gd` (242 lines): a port of `@polaris-key/jws` `verifyJws`
  plus client-core `verifyDoc` / `verifyTrustManifest` / `mergeTrust` — strict base64url,
  duplicate-key scanner, verify-before-parse, envelope rules.

**Results** (Godot 4.7.2 editor binary, headless, Intel Xeon 2.1 GHz):

| Test | Result |
|---|---|
| SHA-512 vs Python `hashlib` (9 lengths across block boundaries) | 9/9 |
| Ed25519 (`SP/proj/test_ed25519.gd`): RFC 8032 TEST 1–3, random keys and messages of 0…16384 bytes, tampered msg / R / S, `S+L` malleability, wrong key | **48/48** |
| **Polaris corpus v2** (`SP/proj/run_corpus.gd`): `jwsCases` 36, `licenseDocCases` 16, `configDocCases` 18, `trustCases` 11 | **81/81** |
| Ed25519 verify, short message | **14.5 ms** avg |
| `verify_jws` on a typical doc (953 chars) | **15.8 ms** |
| `verify_jws` at the 64 KiB payload cap (87,561 chars) | **65.0 ms** |
| SHA-512 of 16 KiB | 6.3 ms |
| `fe_mul` / `fe_sq` / point decode | 2.68 µs / 2.18 µs / 0.66 ms |
| 48 verifies on `WorkerThreadPool` (4 cores) | 0 wrong, 878 ms wall |
| Native ES256 (raw r‖s → DER in GDScript) / RSA-2048, for comparison | 1.06 ms / 0.09 ms |

**Caveats:**

- Timings come from the **editor** binary; no export templates were installed. Release templates
  usually run GDScript somewhat faster.
- Expect roughly 2–4× slower on mid-range phones and in Web/wasm, so **30–60 ms per verify**.
  That's fine for a handful of verifies per session if run off the main thread.
- Known optimisation headroom of about 20–30%: wNAF windows, and skipping `T` between consecutive doublings.
- `valid-nul-byte-in-string` passes only because Godot's `String` can't hold U+0000, so both the
  expected and the decoded value get the same U+FFFD replacement. Signature checking works on raw
  bytes and is unaffected. Document this as a known representational divergence.
- JSON numbers come back as floats. Timestamps are below 2^53, so this is exact.
- Verification is not constant-time and doesn't need to be: every input is public.

### 7.3 Options compared

| Option | Works on | Effort / risk | Verdict |
|---|---|---|---|
| **Pure-GDScript Ed25519 + SHA-512** | all (iOS, Android, Web, desktop), same code | done (prototype); 14–60 ms per verify; auditable, corpus-tested | **Recommended** |
| GDExtension (Monocypher/libsodium) | needs per-platform binaries: macOS universal, Windows, Linux x64/arm64, Android arm64/x86_64, iOS xcframework, Web (dlink templates + wasm side module) | 1–2 weeks initially plus CI for 7–8 targets on every engine bump; Web GDExtension constraints | Not worth it for a few verifies per session |
| WebCrypto via `JavaScriptBridge` (Web only) | Web (Ed25519 in all evergreen browsers) | async Promise bridging; a second code path only for Web | Unnecessary; pure GDScript runs on Web |
| **Dual-sign** (EdDSA + ES256 or RSA the engine can verify) | all | wire contract is EdDSA-only and frozen (`WIRE-CONTRACT-V3.md:21`); adding `alg` = all-languages break | Only for a *standalone* catalog key if pure GDScript were too slow; it isn't. ES256 verify is proven to work (1.06 ms) as a fallback |

### 7.4 SDK shape and API

A GDScript addon, `addons/polaris_key/`, with no native code:

```
plugin.cfg, polaris_key.gd            # autoload "PolarisKey" (Node): config, signals, scheduling
crypto/ed25519.gd                     # verify + sha512 (prototype, done)
core/b64url.gd, core/json_strict.gd   # strict base64url; duplicate-key scanner (in core/jws.gd today)
core/jws.gd                           # verify_jws / verify_doc / verify_trust_manifest / merge_trust (done)
core/clock.gd                         # high-water-mark floor (licence, config, trust, catalog issuedAt)
core/store.gd                         # user://polaris_key/<product>/cache.json — signed JWS strings only (+ floors)
net/http.gd                           # HTTPRequest wrapper: timeouts, ETag/If-None-Match, backoff, Range
content/catalog.gd                    # verify_catalog(); pick(platform, caps, binary, rollout bucket)
content/packs.gd                      # plan → download (Range resume *.part) → SHA-256 → stage → mount
devices/device.gd                     # OPTIONAL: install id, register (policy "open"), token in user://
config/config.gd                      # OPTIONAL: pkey-config+jws fetch/verify/resolve (precedence chain)
tests/run_corpus.gd                   # drives the corpus mirror (done for 4 sections)
```

```gdscript
# Setup (autoload)
PolarisKey.configure({
    "product": "diceroll",
    "catalog_url": "https://cdn.example/c/{channel}/{platform}.jws",   # static R2 (phase S/H)
    "base_url": "https://key.plrs.im",                                  # only for trust/register/config
    "pinned_keys": {"diceroll-cat-2026a": "<b64url>", "diceroll-cat-2026b": "<b64url>"},  # active + next
    "channel": "stable", "platform": "web", "binary_version": "0.6.1",
    "engine": "4.7", "caps": PackedStringArray(["tex:s3tc"]),
    "check_interval_sec": 21600, "trust_refresh": false,                # phase H: true
})

signal catalog_updated(catalog: Dictionary)          # verified, anti-rollback-checked
signal client_blocked(reason: String, min_binary: String, store_url: String)  # kill switch
signal pack_progress(pack_id: String, done: int, total: int)
signal pack_ready(pack_id: String, path: String)
signal state_changed(state: String)                  # fresh | stale | unverified | offline

func check_updates(force := false) -> Dictionary     # await → {catalog_changed, actions[], blocked}
func fetch_catalog() -> Dictionary                   # await → verified catalog or {} (keeps last-known-good)
func verify_jws(jws: String, typ: String, trust := {}) -> Dictionary
func plan(catalog: Dictionary, installed: Dictionary) -> Array   # pure: download/delta/evict/mount actions
func ensure_packs(ids: PackedStringArray, allow_cellular := false) -> Error   # await
func mount_ready_packs() -> void                     # load_resource_pack(path, false), one per frame
func flag(key: String, default: Variant = null) -> Variant       # catalog.flags against effective_now()
func effective_now() -> int                          # max(system clock, verified issuedAt floor)
func rollout_bucket(salt: String) -> int             # SHA-256(salt ‖ install_id) → 0..9999
func register_device() -> String                     # optional (registration: "open")
```

**Behaviour:**

- **Caching and offline grace:** store only signed JWS strings and re-verify on every load using
  the reload profile. Discard the cache on a format change, never migrate it. Fold `issuedAt` into
  the clock floor.
- **States:**
  - `fresh` (before `expiresAt`);
  - `stale` (between `expiresAt` and `graceUntil`): enforce kill switches, install nothing new;
  - `unverified` (past `graceUntil`): play installed content only.
- **Never block** offline play of embedded or verified packs.
- **Threading:** run `verify_jws` on `WorkerThreadPool`. Initialise the static tables on the main
  thread first, e.g. `Ed25519.sha512(PackedByteArray())`.
- **Integrity:** pack SHA-256 uses native `HashingContext` streaming, which is fast. Only the
  catalog signature uses GDScript SHA-512.
- **Platform policy:** no scripts in packs, mount with `replace_files=false`, and gate downloads by
  `build_info.json` distribution. Store builds never download code (`content-streaming.md:39-42, 201-212`).
- **Conformance:** the Godot runner consumes the same corpus. Add `catalogCases` and
  `rolloutBucketCases` in phase H, or earlier as a local vector file in phase S.

---

## 8. Other findings worth passing on

- **Doc drift in Polaris Key:**
  - `services/core/trust.md:91` (revoked keys "never" emitted) contradicts `core/trust.ts:64-72`.
  - `githubApp.ts:6` says ES256 but the code uses RS256.
  - `THREAT-MODEL.md:28-29` still says the KEK can't be rotated and that keys are unrevocable; both
    were fixed later (keyring; replace-not-merge trust).
- `serveReleaseSurface` recomputes `now` from `Date.now()` instead of using the context's `now`
  (`gateway.ts:185`). This is harmless but inconsistent with the "one clock per request" rule
  (`core/registry.ts:27-39`).
- Diceroll's current updater has no freshness or anti-rollback on its manifest (§3). Moving to the
  signed catalog fixes that and replaces RSA with Ed25519.
- Polaris is multi-tenant and djdl-first. Adding Diceroll as a second product is data-only for
  the product itself, but every change listed in §6.5 is platform code subject to the repo's
  drift gates (corpus, OpenAPI coverage, service boundaries, manifest mutation table).

## Appendix: reproducing the experiments

```sh
SP=/tmp/claude-0/-home-user-diceroll/22f656e1-73cf-5899-b675-27fc372fc8a4/scratchpad/pk-godot
godot --headless --path $SP/probe -s probe.gd          # native Crypto capabilities
godot --headless --path $SP/proj  -s test_ed25519.gd   # SHA-512 + Ed25519 vectors + timings
godot --headless --path $SP/proj  -s run_corpus.gd     # Polaris corpus v2: 81/81
godot --headless --path $SP/proj  -s time_jws.gd       # full JWS verify timings
godot --headless --path $SP/proj  -s test_es256.gd     # ES256 raw→DER via Crypto (dual-sign option)
godot --headless --path $SP/proj  -s test_thread.gd    # WorkerThreadPool
python3 $SP/gen_fe.py                                  # regenerates the unrolled field mul/sq
```

Vectors: `SP/proj/vectors.json`, made with OpenSSL plus an RFC 8032 reference signer for the
empty-message case. The RFC TEST 1 public key and signature were reproduced exactly. The corpus
copy is `SP/proj/cases.json`, from `PK/conformance/corpus/v2/cases.json`.
