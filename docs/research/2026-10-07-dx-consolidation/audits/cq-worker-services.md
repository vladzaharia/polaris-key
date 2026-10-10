# Code-quality audit: Worker services (license, config, identity, release, distribution, update, sync)

_DX consolidation, 2026-10-07. Read against `main` at v0.8.31 plus batch 5 (`/Users/vlad/Repos/pk-wt/dx-plan`),
with the in-flight branches LX-08 (`wp/LX-08-licensing-expand`) and HA-12 checked where they touch the
same files. UK-13 and UK-14 do not touch the Worker. Paths below are relative to
`packages/worker/src/` unless they start with `packages/`, `docs/` or `test/`._

---

## 1. Summary

The service split works. `test/boundaries.test.ts` keeps services from importing each other, every
service has a descriptor (`core/registry.ts`), and the descriptor hooks (`core/hooks.ts`) give clean
"null when the providing service is off" degradation. The feed adapters (`services/distribution/registry/adapter.ts`)
and the storefront declarations (`core/storefront/adapter.ts`) are good extensible designs worth copying.

The rule has a cost nobody has accounted for. Services cannot import each other and no other shared
seam is allowed, so anything two services need has moved into `core/`. Core is now 56,144 lines in
170 files, 112 of them in one flat directory. It also imports `admin/` and the top-level `repo.ts`,
which inverts the layering. It reaches services through four re-export facades (`core/data.ts`,
`core/ingest.ts`, `core/adminApi.ts`, `core/platform.ts`). Code that does not fit through those doors
was copied instead:

- 14 base64url encoders, 12 `sha256Hex` functions, 28 safe-JSON-parse helpers and 12 request-body readers.
- 3 PKCE implementations and 6 OIDC relying-party code sites.
- 3 error-body shapes, plus 13 hand-written `INSERT INTO audit` statements with 4 conventions for the system actor.

The import rule also says nothing about tables:

- Identity's portal reads and writes Release's tables directly (`release_metadata`, `release_artifacts`, `release_builds`, `release_download_tokens`).
- Release's resync deletes and rewrites Identity's, Config's and License's tables.
- 17 such crossings exist today. The table-ownership map that would catch them lives only in a docs generator (`packages/docs/scripts/gen-reference.mjs:320`).

Old paths are still running alongside their replacements:

- Four legacy `portal_*` account tables are still deleted from, and re-copied on every request for an unknown account, though nothing writes them any more.
- Every portal OIDC sign-in still runs two "rekey legacy" statements.
- Appcast, version and legacy downloads still resolve releases live from GitHub for record-less products, beside the records-based resolver.
- The portal SPA keeps a `/api/releases` fallback for a Worker skew that cannot happen, because the SPA ships inside the Worker.
- The License service keeps a dead "compat surface" export block and four re-export shim modules.

**The single most important change** is **CQW-04 plus CQW-11: give the boundary teeth at both levels.**

- Move `TABLE_OWNERS` into the Worker and test table access, not just imports.
- Give every service a public `api.ts` façade.
- Let the composing surfaces (`admin/`, `scheduled.ts`, `dispatch.ts`, the portal) import only that façade.

With those in place, the remaining consolidations stop drifting back:

- one licence-issue engine
- one OIDC client
- core notifications
- a core ingest pipeline
- per-store adapters
- a carved-out commerce service

Without them, every new work package (LX-27's key email, CM-02's Stripe provider, U-05's Cloud Sync
routes, HA-12's presentation ingest) adds another copy or another table crossing. Each of those is
already planned.

Three findings are urgent regardless of the consolidation:

1. **The console Licenses list does not scale** (`services/license/admin/licenses.ts:299`). It is an unbounded `SELECT * FROM licenses` followed by more than 10 sequential D1 queries per licence, including a full payload layer walk (`core/authz.ts:257`). It reaches the Worker's default per-invocation subrequest limit (10,000 on the paid plan) at roughly 800 licences, and is slow long before that.
2. **LX-27 would break rule 6.** It plans to send the licence key email from License through `services/identity/portal/email.ts`. CM-13 and ST-27 need the same capability. Email rendering must move to core first.
3. **Commerce cannot run without Release.** It lives inside Distribution (`services/distribution/commerce/`), and Distribution requires Release (`tools/services.json`), so a product cannot sell a licence or a subscription without turning Release on. That directly contradicts the owner's "subscriptions without Commerce" and "graceful degradation" principles, and CM-02 is about to build the Stripe provider in the same place.

---

## 2. Current state (with file references)

### 2.1 Size and shape

| Area                    | Lines (non-test) |                Files | Largest modules                                                                                                                                                                            |
| ----------------------- | ---------------: | -------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/distribution` |           55,867 |                  153 | `availability.ts` 1,731 · `connectors/asc/distribute.ts` 1,492 · `connectors/play/storefront.ts` 1,444 · `connectors/asc/provision.ts` 1,276 · `commerce/appleCatalog.ts` 1,178            |
| `services/release`      |           36,627 |                   83 | `resync.ts` 1,431 · `descriptor.ts` 1,307 · `store.ts` 1,265 · `packs/resolve.ts` 1,257 · `packages/ociPush.ts` 1,246 · `publish.ts` 1,200 · `linkRepo.ts` 1,117                           |
| `services/identity`     |           31,333 |                   75 | **`oidc.ts` 3,258** · `portal/api.ts` 1,772 · `accounts/productUsers.ts` 1,647 · `portal/repo.ts` 1,618 · `card/gate.ts` 1,071                                                             |
| `services/update`       |            6,243 |                   15 | `updaterFeeds.ts` 1,183 · `simulate.ts` 829                                                                                                                                                |
| `services/license`      |            4,416 |                   23 | `admin/licenses.ts` 837                                                                                                                                                                    |
| `services/config`       |            2,077 |                   11 | `admin/mint.ts` 442                                                                                                                                                                        |
| `services/sync`         |              204 |                    2 | descriptor and settings only (U-04); routes are U-05's                                                                                                                                     |
| `core/`                 |           56,144 |       170 (112 flat) | `hostedAssets.ts` 1,655 · `settingsBackfill.ts` 1,442 · `hooks.ts` 1,433 · `overrideMigration.ts` 1,387 · `blobs.ts` 1,351 · `blobGc.ts` 1,291 · `devices.ts` 1,260 · `publisher.ts` 1,237 |
| `admin/`                |           14,467 |                   43 | `handlers/products.ts` 1,685 · `handlers/feeds.ts` 1,373 · `handlers/platformStoreConnections.ts` 962                                                                                      |
| top level               |                — |                    — | `repo.ts` 2,173 · `scheduled.ts` 682 · `githubWebhook.ts` 434 · `platformDeploy.ts` 371                                                                                                    |
| `test/`                 |          212,344 | 295 test files, flat | `attack/R8-oidc.test.ts` 3,066 · `packs.test.ts` 2,070 · `linkRepo.test.ts` 2,037                                                                                                          |

### 2.2 How a request flows

- `index.ts` → `dispatch.ts` → `router.ts` `matchRoute` produces a `Route` kind.
- Product routes go to `core/registry.ts` `dispatchService`, then to each descriptor's `handle(ctx)`. That handle is a hand-written sub-router: `switch (rest[0])` (`services/license/routes.ts:23`) or an `if` chain (`services/distribution/routes.ts:91-180`).
- Admin requests go to `admin/api.ts`, which either dispatches to `ServiceDescriptor.adminHandle` or to a top-level handler under `admin/handlers/`.
- The customer portal is a platform surface implemented inside Identity. `dispatch.ts:36` imports `handlePortal` from `services/identity/index.js`, and the portal runs even when Identity is off (`services/identity/index.ts` header).

### 2.3 How services are composed

- **Descriptor members** (`core/registry.ts` `ServiceDescriptor`): `handle`, `settings`, `discoveryFragment`, `adminHandle`, `manifestIngest`, `manifestIngestAlways`, `authorizeRegistration`, `applyStoreGrant`, `licenseMerge`, `licenseDelete`, `scheduled`, `registryMaterialiser`. On top of those come the four `core/hooks.ts` hooks: `releaseCatalog`, `delivery`, `outletCapabilities` and `licenseProvenance`.
- **Side-effect registries**, which work differently. Modules register themselves at load time:
  - `services/config/accountOverrideStore.ts:208` calls `registerSubjectStore`, made active by a bare `import "./accountOverrideStore.js"` in `services/config/index.ts`.
  - `services/identity/portal/store/analytics.ts:221` calls `registerAuthorizationListener`.
- **Periodic work** has two mechanisms:
  - the descriptor `scheduled` hook (`core/registry.ts:524-550`, run on the 15-minute cron);
  - a hand-maintained list in `scheduled.ts` `runScheduledMaintenance` (lines 314–451), which imports 8 service internals directly (`scheduled.ts:53-69`).

### 2.4 Where licence logic lives

`services/license` is a 4.4k-line shell: routes, admin and settings. The domain logic is in core, because Identity also mints licences:

- `core/authz.ts` (521) and `core/gate.ts` (136)
- `core/devices.ts` (1,260) and `core/entitlements.ts` (234)
- `core/licenseHolders.ts`, `core/licenseMerge.ts`, `core/licenseDelete.ts`
- `core/keyEntries.ts`, `core/storeGrants.ts`, `core/graceClamp.ts`, `core/entitledAccess.ts`
- `core/payload.ts` (the 7-layer walk)
- LX-08 adds `core/grants.ts` (845 lines)

The issuance engine itself (`activateFromIdentity`, `identityIssuePolicy`, `previewIdentityIssue`, `identityTier`) lives in `services/identity/oidc.ts:612-1300`. `portal/discover.ts:85`, `portal/store/obtain.ts:84` and `portal/store/panelStatus.ts:37` all import it from that 3,258-line module.

License still carries compatibility leftovers:

- **Pure re-export shims:** `services/license/{auth,authz,gate,entitlements}.ts`, each documented "Nothing may be defined here".
- **Dead exports:** the "Compat surface for the not-yet-carved modules" block at `services/license/index.ts:65-69`. The only importers of `license/index.ts` are `mount.ts:31` and `test/serviceRoutes.test.ts:30`, and both take only `licenseService`.

### 2.5 Shared plumbing, as found

**Response and error builders.** Four families:

| Family       | Body shape                                | Where                                                                                                                                  |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Flat v2      | `{error: "code", message?}`               | `core/errors.ts` `errorResponse`: 175 call sites in services                                                                           |
| Nested v3    | `{error: {code}}`                         | `core/errors.ts` `wireError`: 25 sites                                                                                                 |
| Admin hybrid | `{error: {code, message}, code, message}` | `admin/lib/respond.ts:29` `err`                                                                                                        |
| Portal flat  | `{error: code}`                           | `services/identity/portal/api.ts:152`, plus its own `json`/`err` copies in `portal/deviceLogin.ts:137-151` and `providers/flow.ts:206` |

`ErrorCode` lists only 18 codes. The literal codes passed to the builders include `method_not_allowed` (46), `rate_limited` (35), `body_too_large` and `misconfigured`.

**Body readers.** There are 12:

- `admin/lib/respond.ts:95` (64 KiB cap, refuses bad JSON)
- `services/identity/portal/api.ts:172` (**no cap; returns `{}` on malformed JSON**)
- `card/http.ts:88`, `passkeys/routes.ts:94`, `core/ciScope.ts:96`, `core/devices.ts:799`, `release/routes.ts:85`, `release/packages/native/body.ts:21`, `commerce/index.ts:150`, `connectors/asc/webhook.ts:116`, `sentry.ts:220`, `core/attestation.ts:227`

Three routes call `req.json()` with no cap at all: `services/identity/browserSession.ts:399`, `services/identity/oidc.ts:3179` and `core/devices.ts:928`.

**Codec helpers.**

- `crypto.ts:6,12,25` keeps `b64url`, `randomBytes` and `hex` private. That has produced 10 more `b64url` copies (in `core/jwt.ts`, `core/downloadTicket.ts`, `admin/auth.ts`, `identity/oidc.ts`, `portal/deviceLogin.ts`, `portal/auth.ts`, `providers/flow.ts`, `passthrough/request.ts` and `update/simulate.ts`) and 3 `b64urlEncode` copies (`keyvault.ts`, `core/registryTokens.ts`, `distribution/ciSecretCheck.ts`). Meanwhile `@polaris-key/jws` already exports `base64UrlEncodeBytes` (`packages/shared-jws/src/index.ts:687`).
- `sha256Hex`: 11 local copies besides `crypto.ts:112`.
- Safe JSON parse: 28 local helpers (`parseJson`, `parseJsonColumn`, `parseObject`, `parseArray`, `jsonOr`, `parseStored` and others).
- `escapeHtml`: 5 copies (`core/brandHtml.ts:29`, `core/bytesLanding.ts:66`, `identity/oidc.ts:1526`, `portal/email.ts:34`, `registry/godot/documents.ts:279`).
- `safeReturnTo`: 3 copies (`oidc.ts:527`, `portal/auth.ts:213`, `card/http.ts:112`).
- `normalizeEmail`: 2 copies (`portal/repo.ts:154`, `accounts/repo.ts:57`).

**OIDC relying party.** The same jobs are done in several places: PKCE, state, code exchange and ID-token verification against JWKS.

- PKCE: `admin/auth.ts:130`, `identity/oidc.ts:252` and `identity/portal/auth.ts:204`.
- Code exchange and token verification: also in `providers/flow.ts`, `providers/google.ts` and `providers/apple.ts`.
- S-16 already noted that three of them hard-code `/api/oidc/token`.

**Audit.** The tables are `audit`, `platform_audit`, `portal_audit`, `subject_events`, `dist_connector_events` and the store-operation projection (`core/storefront/audit.ts`).

- Writers: `repo.ts:1910-2100` and `admin/audit.ts`.
- 13 hand-written `INSERT INTO audit` statements sit elsewhere: `core/rowSettings.ts:240,288`, `core/hostedAssets.ts:1096,1501`, `core/hostedAssetUploads.ts:468,903`, `core/edgeMintApproval.ts:316`, `core/settingsClaims.ts:377`, `core/settingsBackfill.ts:1427`, `core/settings/write.ts:316`, `services/release/resync.ts:1164`, `services/release/mirror.ts:740`, plus `core/settings/write.ts:1003` into `platform_audit`.
- The system actor is spelled four different ways:
  - `NULL` (`edgeMintApproval.ts:316`)
  - `'Polaris Key'` as the name with a `NULL` sub (`mirror.ts:742`)
  - `'Manifest resync'` (`resync.ts:1167`)
  - 9 different `system:*` constants (`system:trust`, `system:blob-gc`, `system:commerce`, `system:update-feed`, `system:pack-sets`, `system:feed-retention`, `system:distribution`, `system:account-merge`, plus `manifest`).

**Pagination.**

- Several cursor encoders: `admin/handlers/devices.ts:85`, `identity/accounts/productUsers.ts:142`, `license/batches.ts:225`, `admin/handlers/users.ts:139`, and offset-as-cursor in `admin/handlers/github.ts:236`.
- `limit` is parsed 7 different ways (`Number(...) || 50`, `Math.trunc`, raw).
- The licence list is not paginated at all.

**Rate limiting is centralised and good.** One Durable Object-backed limiter with a per-bucket `FAIL_MODE` (`core/rateLimit.ts:60-200`). The only duplication is roughly 32 local `429` response builders.

**Email.**

- The transport choke point is in core (`core/emailDelivery.ts`, `core/emailSender.ts`, `core/emailLimits.ts`).
- The renderer and every template are in Identity: `services/identity/portal/email.ts:111` `renderEmail`, `:295` `sendNotice` and `:323` `sendSecurityNotice`, plus 17 notice builders in `portal/notices.ts`.
- All 21 send call sites outside `portal/email.ts` itself are in Identity.

### 2.6 Crossings the import test cannot see

These were found by scanning service SQL against the `TABLE_OWNERS` map (`packages/docs/scripts/gen-reference.mjs:320`):

| From         | Owner's table                                                                                | Files                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| identity     | `license.licenses`                                                                           | `oidc.ts`, `licenseChoice.ts`, `accounts/{deletion,legacy,mergeUndo,platformMigration,productUsers}.ts`, `portal/{discover,link,repo}.ts` |
| identity     | `license.keys_index`                                                                         | `portal/repo.ts`                                                                                                                          |
| identity     | `release.release_metadata`, `release_artifacts`, `release_builds`, `release_download_tokens` | `portal/repo.ts:1014-1240` (`listPortalReleases`, `listPortalArtifacts`, `getPortalReleaseFacts`, `create/get/purgePortalDownloadToken`)  |
| release      | `identity.oidc_config`, `identity.provisioning_config`                                       | `resync.ts:703,769,1327`, `linkExisting.ts:846,914`                                                                                       |
| release      | `config.edge_mint_config`, `edge_mint_approvals`, `product_schema`                           | `resync.ts:597,777`, `linkRepo.ts:1011`, `linkExisting.ts:897`                                                                            |
| release      | `license.license_profiles`                                                                   | `resync.ts:1018`                                                                                                                          |
| distribution | `license.license_store_grants`                                                               | `commerce/state.ts:518`                                                                                                                   |
| update       | `release.release_pins`, `release_holds`, `release_pack_floors`, `release_channel_policy`     | `packParts.ts` (inside the sanctioned edge, but raw SQL rather than Release's functions)                                                  |

Identity writing `licenses` is a declared seam (`core/data.ts` header). The rest are undeclared.

### 2.7 Superseded paths still live

- **Legacy portal account tables.** `portal_accounts`, `portal_account_emails`, `portal_account_identities` and `portal_license_links` have **no INSERT anywhere**. They are still:
  - read by `services/identity/accounts/legacy.ts` (303 lines), from `scheduled.ts:403` daily and from `portal/repo.ts:183` on every request for an account the new tables do not know;
  - deleted from in `accounts/deletion.ts:211-277`, `accounts/merge.ts:292-303`, `accounts/links.ts:295,303`, `admin/repo.ts:102` and `services/identity/index.ts:75`.
- **Per-sign-in rekeys.** `rekeyLegacyPortalIdentities` and `rekeyLegacyAccountLinks` run before **every** portal OIDC sign-in (`portal/auth.ts:497-498`).
- **Two resolvers for appcast, version and legacy downloads.** Products without release records still use live GitHub resolution, as `services/update/routes.ts:14-19` and `updaterFeeds.ts:28-29` both state. The path runs through `release/gateway.ts` (767), `release/github.ts` (747), `update/feed.ts`, `update/appcast.ts`, `release/surfaces.ts` and the legacy download in `release/source.ts:288`. The records path sits beside it.
- **Two portal release listings.**
  - `GET /api/releases` uses the direct table reads.
  - `GET /api/products/<p>/downloads` uses the PX-W2 `customerDownloads` hook.
  - `portal/downloads.ts:226-231` admits the two "can drift".
  - The SPA falls back to the first when the second 404s (`packages/admin/src/portal/data.ts:323`), but the SPA is assembled into the same Worker (`pnpm --filter @polaris-key/worker assemble`), so that skew cannot occur.
- **Fused v2 payload.** `resolveEffective` (`core/authz.ts:173`) is still used by `/identity/session` (`browserSession.ts:254`) and the React cookie mode. It is wire-tied and goes with SP-10.
- **One-shot migrations running permanently.**
  - `core/overrideMigration.ts` (1,387; U-03), run nightly from `scheduled.ts:410`.
  - The settings backfill: `core/settingsBackfill.ts` (1,442) plus `admin/settingsBackfill.ts` (644), from ST-01c.
  - The platform-IdP migration (`accounts/platformMigration.ts`, I-17, with its `PLATFORM_OIDC_MIGRATION` and `PLATFORM_OIDC_SUNSET` switches).
  - LX-08 adds a fourth (`core/licensingCatchUp.ts`).
  - None of them has a written exit criterion.
- **Dead configuration.** The setting `core.adminGroup` (`core/settings/core.ts:65`, manifest `product.adminGroup`, column `products.admin_group`) is ingested and stored, yet "grants nothing" (`admin/api.ts:27`, `admin/authz.ts:1-12`).

### 2.8 Per-store code is in pieces

Apple code is spread over 25 files and 12,656 lines in 7 directories:

- `services/distribution/connectors/asc/*` (14 files)
- `storefronts/appStore.ts`
- `commerce/{apple,appleCatalog,appleRoot}.ts`
- `listing/apple.ts`
- `core/asc/*`, `core/ascProvisioning.ts`
- `core/storefront/{stores/appStore,rules/appStore,rules/appStoreDenied}.ts`
- `services/identity/providers/apple.ts`

Google Play (7,816 lines), the Microsoft Store (5,363) and Steam (2,630) follow the same pattern.

Each store implements three interfaces that do not know about each other:

- `DistributionConnector` (`connectors/index.ts`)
- `StorefrontAdapter` plus `StorefrontRuntime` (`core/storefront/adapter.ts`)
- an ad hoc per-store commerce module, which reaches into `connectors/` (`commerce/play.ts`, `commerce/steam.ts` → `connectors/platformFallback.ts`; `commerce/appleCatalog.ts` → `connectors/asc/{controls,flow}.ts`).

### 2.9 Tests

- 295 test files in a flat `test/`. About 145 map to exactly one service, 89 import no service, and about 60 span several.
- `makeTestDb()` (`test/helpers.ts`) replays all 133 migrations on every call, from 643 call sites.
- 51 test files define their own seed helpers: `seedRelease` ×5, `seedOidc` ×4, `seedReleaseConfig` ×4, `seedLicense` ×3 and others.
- 20 test files deep-import internals of `identity/oidc.ts`.
- The boundary test's own comment is stale. "`identity/` is the only service with a sub-directory" (`test/boundaries.test.ts:200`) is no longer true: five services have sub-directories.

---

## 3. Problems (ranked)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                  | Impact |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | **The service boundary covers imports, not tables, and not the composing surfaces.** Seventeen table crossings (§2.6); only Identity → `licenses` is a declared seam and `update → release.*` a sanctioned edge. `admin/` (about 40 deep imports, such as `admin/handlers/feeds.ts` → `release/packages/prune.js`), `scheduled.ts` (8) and `dispatch.ts` reach into service internals. `TABLE_OWNERS` exists only in a docs generator.                                                                                                                                                                                                   | `packages/docs/scripts/gen-reference.mjs:320`; `test/boundaries.test.ts` scans only `src/services/`; §2.6 table                                                           | high   |
| P2  | **Core is a grab-bag that inverts the layering.** 112 flat files. It imports `admin/` (`core/adminApi.ts:19-98`, `core/bundles.ts:65-67`, `core/ingest.ts:58-67`, `core/payload.ts:269`, `core/accountOverrides.ts:38`) and the top-level `repo.ts` (25 core files). Four re-export facades are imported by 213, 50, 36 and 4 service files respectively. "Splitting that file per service is a later phase" (`core/data.ts:6`) never happened.                                                                                                                                                                                          | §2.1, §2.4                                                                                                                                                                | high   |
| P3  | **The console Licenses list is unbounded and N+1.** `listLicenses` has no `LIMIT` (`admin/repo.ts:268`). Each row costs 4 reads in `licenseSummary` (`admin/lib/shape.ts:161-180`, which also calls `Date.now()` itself), a `resolveMergedPayload` walk of 6–8 reads (`core/authz.ts:257` → `core/payload.ts:162-193`), and the deletion blockers. That is more than 10 sequential D1 subrequests per licence.                                                                                                                                                                                                                           | `services/license/admin/licenses.ts:299-314`                                                                                                                              | high   |
| P4  | **Licence issuance is buried in Identity's sign-in module.** `oidc.ts` (3,258 lines; 3,285 on LX-08) mixes nine concerns: OIDC config, PKCE, RFC 8628 user codes, claim mapping and provisioning, licence issuance policy, the HTTP handlers, HTML pages, the I-26 chooser and polling. Discover, the store obtain paths and the panel status import the issuance engine from it, and commerce cannot reach it at all. LX-10, I-08, I-15, LX-25 and CM-05 will all edit or need this engine.                                                                                                                                             | §2.4; `oidc.ts` outline 235/447/612/1091/1310/2384/3002                                                                                                                   | high   |
| P5  | **Commerce sits under Distribution**, so it needs Release on. CM-01 and CM-02 plan the Stripe provider in `services/distribution/commerce/` too. That breaks graceful degradation and the owner's split between channels and storefronts.                                                                                                                                                                                                                                                                                                                                                                                                | `distribution/commerce/index.ts` header; `tools/services.json` (`distribution.requires: ["release"]`); `wp/CM-01-commerce-plan.md:39`, `wp/CM-02-provider-webhooks.md:43` | high   |
| P6  | **Email rendering and notices live in Identity.** LX-27 (key email from License), CM-13 (commerce emails) and ST-27 (alerts) would each have to import `identity/portal/email.ts`, which is a rule-6 violation, or copy the renderer.                                                                                                                                                                                                                                                                                                                                                                                                    | `wp/LX-27-create-limit-delivery.md:58-59`; §2.5                                                                                                                           | high   |
| P7  | **Product-wide manifest ingest is run by Release.** `linkRepo.ts`, `resync.ts` and `linkExisting.ts` (3,477 lines) write products, keys, tiers, profiles, schema, OIDC, provisioning and edge-mint, through the `core/ingest.ts` facade and through raw SQL (§2.6). Meanwhile `manifestIngest` and `manifestIngestAlways` exist for exactly this purpose and are used only by Distribution and License. Every core manifest field is therefore an edit to Release (HA-12 changes `release/resync.ts` by +74 for `core.presentation`), and a product cannot be ingested without the GitHub path, which blocks a repo-less product wizard. | `core/ingest.ts:1-22`; `services/release/resync.ts:843`                                                                                                                   | high   |
| P8  | **Six OIDC relying-party code sites.** Three PKCE copies, three token-endpoint hard-codes, JWKS verification repeated. I-13, I-22 (bring-your-own JWKS) and I-21 would add more.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §2.5                                                                                                                                                                      | medium |
| P9  | **Two release resolvers.** Live GitHub resolution (one installation quota) is kept for record-less products, beside the records-based resolver. Appcast, version and download behaviour depends on which path a product falls into.                                                                                                                                                                                                                                                                                                                                                                                                      | §2.7                                                                                                                                                                      | medium |
| P10 | **Superseded paths and permanent migrations add per-request work and code.** Legacy portal tables and the per-request catch-up, two rekey writes on every sign-in, a dead SPA fallback, dead License exports and shims, four one-shot migrations with no exit criteria.                                                                                                                                                                                                                                                                                                                                                                  | §2.7                                                                                                                                                                      | medium |
| P11 | **Three store interfaces and code in pieces.** A store's credentials, apps, listing, availability and commerce are spread over 4–7 directories (§2.8). The owner's "common base, per-channel supplements" has no single code home.                                                                                                                                                                                                                                                                                                                                                                                                       | §2.8                                                                                                                                                                      | medium |
| P12 | **Plumbing copied many times.** Error shapes ×4, body readers ×12 (one silent and uncapped), codec helpers ×50+, audit SQL ×13 with four actor conventions, cursor encoders ×5.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §2.5                                                                                                                                                                      | medium |
| P13 | **Two extension mechanisms and two scheduling mechanisms.** Descriptor fields versus side-effect registries, and the descriptor `scheduled` hook versus the `scheduled.ts` list. Side-effect registration ignores enablement and depends on import order.                                                                                                                                                                                                                                                                                                                                                                                | §2.3                                                                                                                                                                      | medium |
| P14 | **Routing is imperative and inconsistent.** `switch` or `if` chains in every service, `portal/api.ts` and `admin/api.ts`. 162 handlers take positional `(req, env, db, …)` arguments and 90 take `ctx`. Method checks and the 405 are written by hand (`method_not_allowed` ×46). Auth is called ad hoc per handler. The `routeCoverage` mapping is maintained by hand (`test/routeCoverage.test.ts`, 869 lines).                                                                                                                                                                                                                        | §2.2                                                                                                                                                                      | medium |
| P15 | **Test layout and speed.** A flat 295-file `test/`, 133 migrations replayed per `makeTestDb` ×643, 51 local seeders. "Run only the tests for what you changed" (CLAUDE.md test budget) has no per-service path to run.                                                                                                                                                                                                                                                                                                                                                                                                                   | §2.9                                                                                                                                                                      | medium |
| P16 | **Dead or duplicated configuration found in code.** `core.adminGroup` grants nothing. The portal gates downloads on both `portal_product_settings.releases_enabled` and `services_json.release` (`portal/api.ts:1002-1004`); whether that is a real per-surface toggle is the settings audit's call.                                                                                                                                                                                                                                                                                                                                     | §2.7                                                                                                                                                                      | low    |
| P17 | **Comment rot.** Stale structural claims: `test/boundaries.test.ts:200`, `services/license/index.ts:6-11,65`, `core/data.ts:6`. 4,535 work-package ids in comments narrate moves that belong in git history.                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                         | low    |

---

## 4. Owner brief: item-by-item stance

Read through a code-quality lens. Product decisions belong to the domain audits; this column says
what the Worker's code needs in order to deliver each item cleanly.

| Owner item                                                                                                      | Stance                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _General:_ "Similar features and services should be consolidated"                                               | **adopt**                  | One each of: OIDC client (CQW-07), issuance engine (CQW-06), notification substrate (CQW-08), audit writer (CQW-02), response, body and codec toolkit (CQW-01), release resolver (CQW-15), store adapter (CQW-13), ingest pipeline (CQW-05).                                                                                                                                                           |
| _General:_ flexibility within limits; reduce configuration surface                                              | **adapt**                  | In code, "surface" means mechanisms as much as settings. Collapse 2 extension mechanisms, 2 scheduling paths and 3 store interfaces into one each. Drop dead `core.adminGroup` or turn it into RBAC, not both. Leave per-setting cuts to the settings audit.                                                                                                                                           |
| _General:_ onboarding (wizards, example code, auto-configuration)                                               | **adapt**                  | The code needs two enablers. First, a core ingest pipeline that works without GitHub (CQW-05), so a wizard-created product goes through the same writers as a linked one. Second, a descriptor `setup(ctx)` contribution point returning each service's setup steps and status, so the console's Integration section is generated rather than hand-written per service.                                |
| _General:_ "If something can be automated … do it"                                                              | **adopt**                  | Code needs to know when requirements are met. CQW-13's `StoreAdapter.requirements()` is what "enable Homebrew on the spot" queries. CQW-11's `maintenance` hook makes retention and cleanup service-owned and automatic.                                                                                                                                                                               |
| _General:_ graceful degradation                                                                                 | **adopt**                  | The `core/hooks.ts` null-when-off pattern is right; keep it. The one structural violation is commerce under Distribution (P5), fixed by CQW-14.                                                                                                                                                                                                                                                        |
| Products: wizard, Integration section, dismiss after an end-to-end handshake                                    | **adapt**                  | Not this domain's UI. The code enablers are CQW-05 (repo-less ingest), the descriptor `setup()` above, and a per-service first-contact signal: the first device registered, licence document served, config document served or release published. That signal can be derived from existing rows (`devices.created_at`, the audit log) with no new table.                                               |
| Licenses: "lots of abstraction layers and comingling"                                                           | **adopt**                  | The code shows it exactly (§2.4). Licence logic is in about 15 core files, a shell service, re-export shims and Identity's sign-in module. CQW-03 gathers the core half into `core/licensing/`, CQW-06 extracts the issuance engine, and CQW-10 deletes the shims.                                                                                                                                     |
| Licenses: automatic minting (everyone, by OIDC group, reject); Discover self-mint "identical" to minting on use | **adopt**                  | Today sign-in and Discover share `activateFromIdentity` only because both import Identity's `oidc.ts`. CQW-06 makes it `core/licensing/issue.ts`, the one engine for sign-in, Discover, store obtain, redeem codes (LX-25) and commerce fulfilment (CM-05). The policy itself is the licensing audit's.                                                                                                |
| Entitlements: explicit, with sub-licences, counts and redemption                                                | **defer**                  | LX-08 to LX-19 own it. Code note: `core/payload.ts` walks one fused stack of 7 layers for both config and entitlements (`payload.ts:11-13`). After LX-16 the walk should split into a config walk and an entitlement walk. That is added to LX-16 below.                                                                                                                                               |
| Tiers and config profiles (user > licence > profile > defaults; licence > tier > defaults)                      | **defer**                  | The licensing and config audits decide. Code fact: the current walk has 7 layers, and the owner's model has 4 for config and 3 for licensing metadata. The split above is the code consequence.                                                                                                                                                                                                        |
| Subscriptions available without Commerce                                                                        | **adopt**                  | That requires lifecycle in `core/licensing/` (CQW-06, LX-12, LX-23) and commerce not under Distribution (CQW-14).                                                                                                                                                                                                                                                                                      |
| Managed config: three types and visibility levels                                                               | **defer**                  | The config audit's. No code-quality blocker: config, secret, flag and edge-mint already flow through `services/config` and `core/payload.ts`.                                                                                                                                                                                                                                                          |
| Cloud Sync                                                                                                      | **defer**                  | U-05 builds it. It should be born on CQW-12 route tables and CQW-01 helpers, and register its subject store through the descriptor (CQW-11) instead of a module-load side effect.                                                                                                                                                                                                                      |
| Release content types and OS/arch gating                                                                        | **defer**                  | The release audit's. CQW-15 (one resolver) makes "gate by what we actually build" a single query.                                                                                                                                                                                                                                                                                                      |
| Distribution channels separate from storefronts; a common base plus per-channel supplements; parity             | **adopt**                  | CQW-13 gives one `StoreAdapter` per store with facets (credentials, apps, listing, distribution, commerce) in one directory per store, replacing three interfaces. CQW-14 moves commerce into its own service and leaves the channel facets in Distribution.                                                                                                                                           |
| Feeds: tokens, cleanup of `-main` builds, pushing to central registries                                         | **defer, with a pushback** | The feeds audit owns the behaviour. Pushback: do **not** merge `release/packages/*` (publish) into `distribution/registry/*` (serve). The truth-versus-serving split is right, and the feed adapter (`registry/adapter.ts`) already unifies the serving side. Retention moves under CQW-11's `maintenance` hook.                                                                                       |
| Managed updates: stable, beta and dev channels; promote and demote                                              | **defer**                  | The release and update audit's. CQW-15 is the code prerequisite for "a promotion applies to every feed at once".                                                                                                                                                                                                                                                                                       |
| Commerce: parity across storefronts; automatic provisioning and refunds                                         | **adopt**                  | CM-02's provider abstraction should be the commerce facet of CQW-13's `StoreAdapter`, covering Apple, Play and Steam as well as Stripe, and should land in `services/commerce/` (CQW-14).                                                                                                                                                                                                              |
| Identity: multiple SSO providers, a semi-federated IdP, per-application providers                               | **adopt**                  | One relying-party client in core (CQW-07) is the precondition for many providers plus BYO auth (I-22) without a fourth and fifth copy. The provider side (I-21) reuses the same key and JWKS utilities.                                                                                                                                                                                                |
| Identity: console accounts through the same account system                                                      | **defer**                  | The identity and RBAC audits'. Code fact: `admin/auth.ts` keeps its own relying party and cookie session (`admin/session.ts`), separate from `account_sessions`. CQW-07 makes the switch cheaper.                                                                                                                                                                                                      |
| Access tokens per user for feeds                                                                                | **defer**                  | `core/registryTokens.ts` (1,006 lines) exists. The feeds and identity audits decide.                                                                                                                                                                                                                                                                                                                   |
| Administration: platform settings, sidebars                                                                     | **defer**                  | Not this domain.                                                                                                                                                                                                                                                                                                                                                                                       |
| RBAC: Superadmin, Platform Admin, {Product} Admin, Console Access; OIDC mapping                                 | **adapt**                  | Today there is one group, `PLATFORM_ADMIN_GROUP` (`admin/authz.ts`), and a dead per-product `admin_group`. Pushback on adding permission checks handler by handler: CQW-12's route tables declare a `permission` per route, so RBAC and ST-21's `can()` are enforced once, at dispatch. `core.adminGroup` either becomes the seed of the "{Product} Admin" OIDC mapping (ST-22) or is removed (ST-25). |
| "Code quality audits: duplicated code, code smells, consistency, extensibility, modularity"                     | **adopt**                  | This audit.                                                                                                                                                                                                                                                                                                                                                                                            |
| "A lot of layers and abstractions that might not really be needed anymore"                                      | **adopt**                  | Re-export facades, compatibility shims, permanent migrations and dual paths (§2.7) are retired by CQW-03, CQW-09, CQW-10 and CQW-15.                                                                                                                                                                                                                                                                   |
| Minor portal and console fixes                                                                                  | **defer**                  | Not this domain.                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 5. Target design

### 5.1 Layers and the boundary rule

```
surfaces/            admin/ · portal (carved from identity) · scheduled.ts · dispatch.ts · webhooks
   │  may import: core/**, services/<slug>/api.ts (public façade) — never service internals
services/<slug>/     license · config · identity · release · distribution · update · sync · commerce (new)
   │  may import: core/**, own dir; update → release only (unchanged)
   │  may touch tables: its own (TABLE_OWNERS) + declared seams (core/tableOwners.ts SEAMS)
core/<domain>/       http · db · codec · audit · notify · oidc · licensing · accounts · trust ·
                     stores · storefront · assets · registry · settings · ops
   │  may import: core/**, @polaris-key/*, env/db types — never admin/, services/, top-level repo.ts
```

**Two enforced tests replace "trust the comment".**

1. `test/boundaries.test.ts`, extended to cover three cases:
   - surfaces may import only `services/<slug>/{index,api}.ts`;
   - core may not import `admin/` or `repo.ts`;
   - the existing service rule stays.
2. A new `test/tableBoundaries.test.ts`. It reads `core/tableOwners.ts` (moved out of the docs generator, which then imports it), scans SQL in each service for tables owned by another service, and allows only declared `SEAMS`. The list starts as the 17 crossings in §2.6, each with an owning work package, and must shrink to the permanent seams: Identity → `licenses` and `update → release.*`.

### 5.2 One toolkit in core, used everywhere (CQW-01, CQW-02)

**`core/http/`**

- `respond.ts`: `deviceError` (flat v2), `wireError` (nested v3), `adminError` (hybrid), `portalError` (flat) and `json`. Each route family has its own builder, so bodies stay byte-identical.
- `body.ts`: `readJson(req, {max})` returns a parsed value or a ready-made response for 400 or 413. It replaces all 12 readers and the 3 uncapped `req.json()` calls.
- `input.ts`: small field validators (`str`, `int`, `bool`, `oneOf`, `email`) that return `{fields:[…]}` refusals uniformly.
- `paging.ts`: `parseLimit` and an opaque keyset cursor `encode/decode`.

**`core/codec.ts`**

- `b64url` (delegating to `@polaris-key/jws`), `sha256Hex`, `hex`, `randomBytes`.
- `jsonColumn.object/array/parse`.
- Exported, so the 50-plus copies go.

**`core/html.ts`:** one `escapeHtml`.

**`core/audit.ts`**

- `audit(...)`, `auditStatement(..., {when})` and `platformAudit(...)` built from one row builder.
- `SYSTEM_ACTORS` covers every `system:*` actor plus one platform display name.
- `admin/audit.ts` becomes a thin session adapter, and the 13 raw INSERTs go.
- The audit tables stay as they are. Merging `portal_audit` into `audit` or `platform_audit` is out of scope (see §8).

### 5.3 Core by domain (CQW-03)

- Split `repo.ts` along `TABLE_OWNERS` into `core/db/{products,keys,licences,devices,fingerprints,profiles,audit,platform}.ts`.
- Move `admin/lib/{managedSecrets,redact,overrides,writeChecks,shape,deviceShape}.ts` and the `AdminSession` type into core.
- Group core files into domain directories: `licensing/`, `accounts/`, `notify/`, `trust/`, `assets/`, `registry/`, `ops/`.
- Keep `core/platform.ts` as the one convenience facade and remove `core/data.ts`, `core/ingest.ts` and `core/adminApi.ts`. These are mechanical moves; a codemod keeps re-exports for one release and then deletes them.

### 5.4 Domain engines in core

- **`core/licensing/issue.ts` (CQW-06).** Moved out of Identity, this is the issuance policy: auto-issue for everyone, by OIDC group or reject; tier choice by rank (LX-08); provisioning overlay; device limit after activation; preview mode. Its callers are sign-in, Discover, store obtain, redeem codes (LX-25), commerce fulfilment (CM-05) and the developer backend (LX-13).
- **The rest of `oidc.ts`** splits into `services/identity/productOidc/{config,browserFlow,deviceFlow,callback,chooser,poll,pages}.ts`. A barrel keeps today's exports so the 20 test files keep compiling.
- **`core/oidc/client.ts` (CQW-07).** Discovery, PKCE, state and nonce, code exchange, RFC 9207 `iss`, and ID-token verification with a JWKS cache. It is used by the admin console, product OIDC, portal sign-in and the Google and Apple providers, and later by I-13 and I-22.
- **`core/notify/` (CQW-08).**
  - `render.ts`, moved from `portal/email.ts`.
  - `templates/`: a registry of message builders with snapshot tests. The 17 portal notices move here; LX-27, CM-13 and ST-27 add theirs.
  - `recipients.ts` and `send.ts` over `core/emailDelivery.ts`.
  - `destinations.ts` for ST-27 webhook alerts.

### 5.5 Contribution points instead of side effects (CQW-11)

`ServiceDescriptor` gains four optional members:

- `maintenance(ctx)`: the daily job; `scheduled.ts` iterates descriptors instead of importing internals.
- `subjectStore`, replacing `registerSubjectStore`.
- `onAuthorization`, replacing `registerAuthorizationListener`.
- `setup(ctx)`: setup steps and status for the console's Integration section.

Each service also exports an `api.ts`, the typed façade the surfaces use. For example, `admin/handlers/feeds.ts` calls `releaseApi.prunePackages()` instead of `release/packages/prune.js`.

### 5.6 Declarative routes (CQW-12)

`core/http/routes.ts` provides `route(method, pattern, {auth, body, errors, permission}, handler)`.

- The `auth` modes are `public`, `device`, `ci:<scope>`, `admin`, `portal` and `none`.
- The table answers 405 and caps the body, and handlers receive `ctx` (no more positional arguments).
- `routeCoverage` reads the tables.
- RBAC (ST-21, ST-22) checks `permission` once.

Migrate service by service, starting with license, config and update; U-05 is written on it from the start.

### 5.7 Store adapters and commerce (CQW-13, CQW-14)

**Stores.**

- `core/stores/<store>/{client,credentials,events}.ts` holds the shared store infrastructure.
- `services/distribution/stores/<store>/{availability,rollouts,listing,poll,webhook,setup}.ts` holds the channel facets.
- `services/commerce/stores/<store>/{purchases,catalog,notifications}.ts` holds the storefront facets.
- One `StoreAdapter` declaration per store (an extension of `core/storefront/adapter.ts`) lists the facets and `requirements()`.
- `DistributionConnector` and the ad hoc commerce modules fold into it.

**Commerce service.**

- A new `commerce` service (a `tools/services.json` row, as U-04 did for `sync`) that requires only `license`.
- `/<p>/distribution/commerce/*` and `/distribution/hooks/{app-store,play-rtdn}` become permanent router aliases (`router.ts`, as P2b-04 did for bytes).
- CM-02's provider abstraction is the commerce facet.

### 5.8 One release resolver (CQW-15)

Every surface (appcast, version, downloads, the portal) resolves from `release_metadata`, `release_builds` and `release_artifacts`, kept current by the webhook, sync and HA-08 mirror ingest. GitHub's API is used only at ingest. The output must stay byte-identical: the transcripts gate (`pnpm gen transcripts --check`) proves it, and compiled-in `SUFeedURL`s keep working through the existing aliases.

### 5.9 Portal off Release's tables (CQW-09)

- Downloads go through `delivery.customerDownloads`, and the token mint and redemption through a new `delivery.downloadToken` hook (Distribution owns delivery).
- `GET /api/releases` (the listing) and the SPA fallback are deleted.
- The `/api/releases/<p>/<r>/artifacts/<a>/token` path stays as an alias of the hook-backed mint.

### 5.10 Tests (CQW-17)

- Layout: `test/{core,services/<slug>,surfaces/{admin,portal},attack,transcripts,storefront,registry}/`.
- `makeTestDb()` clones a migrated template (`sqlite.serialize()` once per worker).
- `test/support/seed.ts` holds the canonical seeders.
- `pnpm --filter @polaris-key/worker test:service <slug>` runs one service's suite.

---

## 6. Surface-area reduction

| Before                                                                                                                                                                                | After                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 4 re-export facades (`core/data.ts`, `core/ingest.ts`, `core/adminApi.ts`, `core/platform.ts`) plus 4 License shims (`auth`, `authz`, `gate`, `entitlements`) and a dead compat block | 1 facade (`core/platform.ts`), 0 shims                                          |
| `repo.ts` (2,173) + `admin/repo.ts` (686) + scattered SQL helpers                                                                                                                     | `core/db/<owner>.ts`, one per owned table group                                 |
| 4 error builders × local copies; 12 body readers; 28 JSON helpers; 14 b64url; 12 sha256Hex; 5 escapeHtml; 3 safeReturnTo; 2 normalizeEmail                                            | `core/http/{respond,body,input,paging}`, `core/codec`, `core/html`              |
| 13 raw audit INSERTs, 4 system-actor conventions                                                                                                                                      | `core/audit.ts` + `SYSTEM_ACTORS`                                               |
| 6 OIDC relying-party code sites, 3 PKCE copies                                                                                                                                        | `core/oidc/client.ts`                                                           |
| Issuance engine in `identity/oidc.ts`, imported by the portal; commerce cannot reach it                                                                                               | `core/licensing/issue.ts`                                                       |
| Email renderer and templates in Identity; 3 planned work packages needing a copy                                                                                                      | `core/notify/`                                                                  |
| 2 ingest mechanisms (Release-run resync vs descriptor `manifestIngest`)                                                                                                               | 1 (core pipeline plus descriptor contributions)                                 |
| 2 periodic mechanisms; 2 extension mechanisms (descriptor vs side-effect registries)                                                                                                  | descriptor only (`scheduled`, `maintenance`, `subjectStore`, `onAuthorization`) |
| 3 store interfaces (`DistributionConnector`, `StorefrontRuntime`, ad hoc commerce) in 4–7 directories per store                                                                       | 1 `StoreAdapter`, 1 directory per store per side                                |
| Commerce gated on Release and Distribution                                                                                                                                            | Commerce gated on License only                                                  |
| 2 release resolvers (GitHub-live, records)                                                                                                                                            | 1                                                                               |
| 2 portal release listings + SPA fallback                                                                                                                                              | 1 (hook-backed)                                                                 |
| Tables: `portal_accounts`, `portal_account_emails`, `portal_account_identities`, `portal_license_links`                                                                               | dropped                                                                         |
| Per-request and per-sign-in legacy work: `catchUpLegacyAccount`, `rekeyLegacyPortalIdentities`, `rekeyLegacyAccountLinks`                                                             | gone after one contract migration                                               |
| Setting `core.adminGroup` / manifest `product.adminGroup` / column `products.admin_group` (grants nothing)                                                                            | removed, or repurposed as the RBAC product-admin mapping (ST-22), never both    |
| Hand-maintained `routeCoverage` map and 46 hand-written 405s                                                                                                                          | generated from route tables                                                     |
| One-shot migrations with no exit criteria (override migration, settings backfill apply, platform-IdP migration, LX catch-up)                                                          | a migration ledger with exit criteria; code deleted on exit                     |

Measured order of magnitude: about 4–6k lines deleted outright (legacy paths, shims and copies) and about 12k lines moved to new homes. No wire format changes except in the CQW-14 and CQW-15 plans.

---

## 7. Automation and onboarding

- **`ServiceDescriptor.setup(ctx)`** returns `{steps: [{id, label, done, action?, docs}], status}` from each service's own tables. The console's Integration section and product wizard render it with no service-specific console code. The handshake-complete signal is derived per service: first `devices` row, first licence or config document served (the audit or refusal log), first release record, first feed render.
- **`ServiceDescriptor.maintenance(ctx)`** makes cleanup automatic and service-owned: retention, prune, catch-up and GC. `scheduled.ts` becomes a loop over descriptors with the existing `step()` fault isolation.
- **`StoreAdapter.requirements()`** (CQW-13) answers "can this channel or storefront be enabled now, from credentials already held at product or platform level?". That is the query behind the owner's "enable it on the spot after confirmation" and "a channel that brings its storefront activates both".
- **A core ingest pipeline (CQW-05)** lets the wizard create a product from a form or from a `.pkey/` upload through the same writers as a linked repo, with a dry-run plan (ST-17) for both.
- **For developers:** per-service test commands (CQW-17) and the route tables (CQW-12) make "add a route" a single declaration. Rule 10's spec entry stays manual but is checked against the table. The checklists in `/docs/contribute/layout/` shrink to match.

---

## 8. Migration, data and risk

**Wire impact.**

- **Byte-identical, so not wire events:** CQW-01, 02, 03, 04, 06, 07, 08, 09, 10, 11, 12, 16 and 17. Each must pass the transcripts gate (`pnpm gen transcripts --check`) and the corpus gate unchanged. CQW-01 in particular keeps four error-body families; it does not unify shapes on the wire.
- **CQW-14 (commerce service) is plan-mode.** It adds a `tools/services.json` row, which means `pnpm gen services` regenerates slug constants in every SDK language, plus a discovery fragment (the corpus mirror, as U-04 did). App Store and Play notification URLs that store consoles have already registered must keep resolving through permanent aliases.
- **CQW-15 (one resolver) is plan-mode.** Appcast, version and legacy-download bytes are in the HTTP transcripts; compiled-in `SUFeedURL` and `curl | sh` lines must keep working. A product whose `release_metadata` lacks artifacts needs a backfill from GitHub (HA-08's mirror backfill is the precedent) before the switch. Risk: an operator with an unsynced repository loses the appcast until sync runs, so ship behind a per-product readiness check that falls back to the live path until the rows exist, then remove the fallback in a later contract step.

**Data migrations.** The lead assigns numbers; builders name files `00XX_<name>.sql`.

- **CQW-10, contract:**
  - Precondition query on every environment: `SELECT COUNT(*) FROM portal_accounts p WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.id)` must be 0, and likewise for emails, identities and links.
  - Then one final rekey (`UPDATE … SET issuer = <platform issuer> WHERE issuer = 'oidc'` for links and identities).
  - Then `DROP TABLE` for the four `portal_*` tables. `TABLE_OWNERS` is updated and the D1 data-model page regenerated.
  - Rollback is a restore from D1 Time Travel. These tables have had no writer since I-05.
- **CQW-03:** no schema change.
- **CQW-04:** no schema change; `TABLE_OWNERS` moves from `packages/docs/scripts/gen-reference.mjs` to `packages/worker/src/core/tableOwners.ts` (the docs generator imports it, and its freshness gate still runs).
- **CQW-09:** `release_download_tokens` ownership moves to `distribution` in `TABLE_OWNERS` (logical only); no DDL.

**Sequencing risks.**

- LX-08 is in review and touches `oidc.ts` (+295), `repo.ts`, `core/payload.ts`, `core/authz.ts` and `commerce/state.ts`; HA-12 touches `release/resync.ts` and `repo.ts`. Do **not** start CQW-03, CQW-05 or CQW-06 until both have merged.
- After that, do CQW-06 **before** LX-10, I-08 and I-15 start, so they edit the split modules rather than a 3.3k-line file.
- Do CQW-08 before LX-27, CM-13 and ST-27.
- Do CQW-14 before CM-02 (CM is deferred anyway).

**Test churn.**

- CQW-06 keeps a barrel so the 20 test files that import `oidc.ts` internals compile unchanged.
- CQW-17 moves files with `git mv` only, after the codemods, in one integration batch to avoid conflicts with live branches. The lead schedules it between waves.

**Audit-table merge is deferred.** Merging `portal_audit`, `platform_audit` and `audit` would simplify readers. But `portal_audit` is account-scoped with privacy deletion (`accounts/deletion.ts:274`) and `platform_audit` stores before and after JSON, so a merge is a data-retention decision for the identity and privacy owners, not a code-quality one.

---

## 9. Backlog changes

| id    | action  | target                                                               | note                                                                                                                                                                                           |
| ----- | ------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LX-27 | edit    | deps += CQW-08                                                       | The key email must be sent through `core/notify/`. The brief points at `services/identity/portal/email.ts`, which License may not import (rule 6).                                             |
| CM-13 | edit    | deps += CQW-08                                                       | Commerce templates are registered in `core/notify/templates/`, with snapshot tests there.                                                                                                      |
| ST-27 | edit    | deps += CQW-08                                                       | Alert destinations (email and webhook) are `core/notify/destinations.ts`; no new email path.                                                                                                   |
| CM-01 | edit    | adopt CQW-14                                                         | The plan places code in `services/commerce/` with its own slug requiring only License; it lists the `/distribution/commerce/*` aliases and the corpus-mirror consequence.                      |
| CM-02 | edit    | deps += CQW-14, CQW-13                                               | The provider abstraction is the commerce facet of `StoreAdapter`, covering Apple, Play, Steam and Stripe. Files go under `services/commerce/`, not `services/distribution/commerce/checkout/`. |
| ST-17 | edit    | deps += CQW-05                                                       | The shared dry-run plan is produced by the core ingest pipeline; resync, link and the deploy hook all call it. Merge if the lead prefers one package.                                          |
| ST-05 | edit    | build on CQW-12, CQW-01                                              | The generic settings admin API is written as route-table entries; its compatibility aliases are listed in the CQW-10 ledger for ST-25.                                                         |
| ST-21 | edit    | deps += CQW-12                                                       | `can()` is enforced from the route table's `permission`, not per handler.                                                                                                                      |
| ST-22 | edit    | absorb the `core.adminGroup` decision                                | Either per-product roles consume `products.admin_group` as the OIDC group mapping, or ST-25 drops it.                                                                                          |
| ST-25 | edit    | scope += `core.adminGroup` (if ST-22 does not use it), ST-05 aliases | Driven by the CQW-10 migration ledger.                                                                                                                                                         |
| LX-10 | reorder | after CQW-06                                                         | Anchor choice edits the issuance engine; do it in `core/licensing/issue.ts`, not in `identity/oidc.ts`.                                                                                        |
| LX-16 | edit    | scope += split `core/payload.ts`                                     | After the contract step, separate the config walk (user > licence > profile > defaults) from the entitlement walk; record the end of dual-write in the CQW-10 ledger.                          |
| LX-25 | edit    | deps += CQW-06                                                       | Redeem and gift codes call `core/licensing/issue.ts`.                                                                                                                                          |
| CM-05 | edit    | deps += CQW-06                                                       | Fulfilment mints through the same engine as sign-in and Discover.                                                                                                                              |
| I-08  | edit    | soft deps += CQW-06, CQW-07                                          | The passthrough token route builds on the split `productOidc/` modules and the core OIDC client.                                                                                               |
| I-13  | edit    | deps += CQW-07                                                       | Exchange-endpoint verification reuses the core client's JWKS and ID-token verification.                                                                                                        |
| I-22  | edit    | deps += CQW-07                                                       | Bring-your-own-auth `oidc` (JWKS) is the same verifier.                                                                                                                                        |
| I-15  | keep    | coordinate with CQW-06                                               | Retiring `/auth/poll` deletes `pollAuthFlow` (`oidc.ts:3002-3165`); land it in `productOidc/poll.ts`.                                                                                          |
| U-05  | edit    | build on CQW-12, CQW-01, CQW-11                                      | Cloud Sync routes use route tables; the subject store is registered through the descriptor.                                                                                                    |
| HA-09 | edit    | deps += CQW-09                                                       | The mirrored-copy download mint goes through the `delivery.downloadToken` hook, not `portal/repo.ts` SQL.                                                                                      |
| PX-09 | edit    | coordinate with CQW-09                                               | "Get it, complete" reads only `customerDownloads`; the SPA's `/api/releases` fallback goes.                                                                                                    |
| PS-11 | edit    | record in the CQW-10 ledger                                          | The retirement of `discover_enabled` readers is a ledger row.                                                                                                                                  |
| SP-10 | edit    | scope += retire `resolveEffective`                                   | When the signed browser-session document lands, delete the v2 fused shim (`core/authz.ts:173`, `browserSession.ts:254`). This is already plan-mode (wire).                                     |
| LX-08 | keep    | in flight                                                            | No change to the branch. CQW-03 later moves `core/grants.ts` and `core/licensingCatchUp.ts` into `core/licensing/`, and the ledger records the catch-up's exit criterion.                      |
| HA-12 | keep    | in flight                                                            | Its `release/resync.ts` change for `core.presentation` moves into the core ingest pipeline in CQW-05.                                                                                          |
| LX-13 | edit    | soft dep CQW-12                                                      | The developer-backend entitlement routes are written as route-table entries.                                                                                                                   |

---

## 10. New work packages

| id         | title                                                 | scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | deps                                                  | plan mode                             |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| **CQW-01** | Core HTTP and codec toolkit                           | `core/http/{respond,body,input,paging}.ts`, `core/codec.ts`, `core/html.ts`. Replace the 12 body readers (cap the 3 uncapped `req.json()` calls and the portal's silent uncapped `readBody`), 28 JSON helpers, 14 b64url, 12 sha256Hex, 5 escapeHtml, 3 safeReturnTo, 2 normalizeEmail and local 429/405 builders. Four named error families, bodies byte-identical (transcripts gate).                                                                                                        | —                                                     | no                                    |
| **CQW-02** | One audit writer                                      | `core/audit.ts` (row builder, statement with `when`, platform variant), `SYSTEM_ACTORS`; replace 13 raw `INSERT INTO audit` statements; `admin/audit.ts` becomes a session adapter; document the six audit sinks and which surface writes which.                                                                                                                                                                                                                                               | CQW-01                                                | no                                    |
| **CQW-03** | Core layering and domain directories                  | Core never imports `admin/` or `repo.ts`: move `admin/lib/{managedSecrets,redact,overrides,writeChecks,shape,deviceShape}` and `AdminSession` into core; split `repo.ts` and `admin/repo.ts` into `core/db/<owner>.ts`; retire `core/data.ts`, `core/ingest.ts` and `core/adminApi.ts`; group core into `licensing/`, `accounts/`, `notify/`, `trust/`, `assets/`, `registry/` and `ops/`; extend `boundaries.test.ts` for core. A codemod plus one release of re-exports.                     | LX-08, HA-12 merged; CQW-01                           | no                                    |
| **CQW-04** | Table-ownership boundary test                         | Move `TABLE_OWNERS` into `core/tableOwners.ts` (the docs generator imports it); add `SEAMS`; add `test/tableBoundaries.test.ts` scanning service SQL; seed the allow-list with the 17 crossings of §2.6, each tagged with the work package that removes it; amend AGENTS.md rule 6 to cover tables and surfaces.                                                                                                                                                                               | —                                                     | no                                    |
| **CQW-05** | Core manifest ingest pipeline                         | Move product-wide link and resync orchestration from `release/{linkRepo,resync,linkExisting}.ts` into `core/ingest/`; Identity (OIDC, provisioning), Config (schema, profiles, edge-mint), License (tiers, licence profiles, licensing settings) and core (product, keys, presentation) contribute through `manifestIngest`; Release keeps the GitHub fetch and `release_config`. Golden "statements produced" tests before and after; enables repo-less wizard ingest; feeds ST-17.           | CQW-03, CQW-04                                        | yes (cross-cutting ingest semantics)  |
| **CQW-06** | Split `identity/oidc.ts`; extract the issuance engine | `core/licensing/issue.ts` (`activateFromIdentity`, `identityIssuePolicy`, `previewIdentityIssue`, `identityTier`, provisioning overlay, post-activation device limit); `services/identity/productOidc/{config,browserFlow,deviceFlow,callback,chooser,poll,pages}.ts`; RFC 8628 user codes in `deviceFlow.ts`, shared with `portal/deviceLogin.ts`; a barrel keeps test imports.                                                                                                               | LX-08 merged, CQW-03                                  | no                                    |
| **CQW-07** | One OIDC relying-party client                         | `core/oidc/client.ts`: discovery, PKCE, state and nonce, code exchange, RFC 9207 `iss`, ID-token verification with a JWKS cache, token endpoint from discovery. Adopted by `admin/auth.ts`, `productOidc/`, `portal/auth.ts` and `providers/{google,apple}.ts`; Steam (OpenID 2.0) stays separate.                                                                                                                                                                                             | CQW-06                                                | no                                    |
| **CQW-08** | Core notification substrate                           | `core/notify/{render,templates,recipients,send,destinations}.ts`; move `renderEmail`, `sendNotice`, `sendSecurityNotice` and the 17 notices from `identity/portal/{email,notices}.ts`; snapshot test per template; ready for LX-27, CM-13 and ST-27.                                                                                                                                                                                                                                           | CQW-01                                                | no                                    |
| **CQW-09** | Portal off Release's tables                           | `delivery.downloadToken` hook (mint, read, spend, purge) implemented by Distribution; portal downloads only through `customerDownloads`; delete `listPortalReleases`, `listPortalArtifacts`, `getPortalReleaseFacts` and the token SQL in `portal/repo.ts:1014-1240`; delete the `GET /api/releases` listing and the SPA fallback (`packages/admin/src/portal/{api,data,library}.ts`); OpenAPI and `routeCoverage` update.                                                                     | CQW-04                                                | no                                    |
| **CQW-10** | Contract sweep and migration ledger                   | `docs/research/…/migration-ledger.md` (or a RUNBOOK section) with every expand/contract and its exit criterion: U-03 override migration, ST-01c backfill apply, I-17 platform-IdP, LX-08 catch-up, LX-16, PS-11, ST-25. Now: a contract migration dropping the 4 `portal_*` tables after the precondition query; delete `accounts/legacy.ts`, `catchUpLegacyAccount(s)`, both rekey functions, the legacy DELETEs, the License compat block and the four shim modules; fix the stale comments. | CQW-04                                                | no                                    |
| **CQW-11** | Service public API and surface boundary               | `services/<slug>/api.ts` façades; `admin/`, `scheduled.ts`, `dispatch.ts`, `githubWebhook.ts` and `platformDeploy.ts` import only `index` or `api`; descriptor `maintenance`, `subjectStore`, `onAuthorization` and `setup`; `scheduled.ts` iterates descriptors; side-effect registries removed.                                                                                                                                                                                              | CQW-03, CQW-04                                        | no                                    |
| **CQW-12** | Declarative route tables                              | `core/http/routes.ts` (method, pattern, auth, body cap, error family, permission); automatic 405 and body cap; handlers take `ctx`; `routeCoverage` derived from the tables. Migrate in this order: license, config, update, sync, release, distribution, identity, then the portal and admin APIs.                                                                                                                                                                                            | CQW-01                                                | no                                    |
| **CQW-13** | Unified store adapters                                | `core/stores/<store>/{client,credentials,events}`, `services/distribution/stores/<store>/…` channel facets, `StoreAdapter` facets plus `requirements()`; fold `DistributionConnector`, `StorefrontRuntime` and the per-store commerce modules into it; Apple, Play, Microsoft Store and Steam.                                                                                                                                                                                                 | CQW-03; distribution and commerce audit decisions     | yes                                   |
| **CQW-14** | Commerce service carve-out                            | A `commerce` row in `tools/services.json` (requires `license`), descriptor, discovery fragment, console accent; move `services/distribution/commerce/`; permanent aliases for `/distribution/commerce/*` and the two store hooks; coherence code `commerce_requires_license`; corpus mirror and constants regeneration.                                                                                                                                                                        | CQW-13 (or the store-client move alone), before CM-02 | yes (new service, discovery, aliases) |
| **CQW-15** | One release resolver                                  | Appcast, version and legacy downloads resolve from release rows; GitHub API only at ingest; a backfill of artifacts for linked products without rows; per-product fallback until rows exist, then a contract step; transcripts byte-identical.                                                                                                                                                                                                                                                 | CQW-05; HA-08 backfill                                | yes (transcript-affecting surfaces)   |
| **CQW-16** | Licence list: pagination and set queries              | `GET …/license/licenses?cursor&limit` (keyset on `activated_at DESC, id DESC`); batch the keys, devices, profiles, subjects and device-limit reads into per-page `IN (…)` queries; a device-limit view without a payload walk per row; pass `now` from `ctx` into `licenseSummary`; console paging (a coordinated console change); OpenAPI.                                                                                                                                                    | CQW-01                                                | no                                    |
| **CQW-17** | Worker test layout and speed                          | `test/{core,services/<slug>,surfaces,…}`; `makeTestDb()` from a serialized migrated template; `test/support/seed.ts` replacing 51 local seeders; `test:service <slug>` scripts; the lead schedules it between waves.                                                                                                                                                                                                                                                                           | CQW-03, CQW-11                                        | no                                    |

**Suggested order.**

1. **Now, parallel and small:** CQW-04, CQW-16 and CQW-01.
2. **Then:** CQW-02, CQW-08 and CQW-10.
3. **After LX-08 and HA-12 merge:** CQW-03, then CQW-06, then CQW-07 and CQW-11.
4. **Then:** CQW-05, CQW-09 and CQW-12, with CQW-17 between waves.
5. **Plan-mode track:** CQW-13 → CQW-14 → CQW-15.

---

## 11. Quick wins (a day or less each)

1. **Delete the dead compat block** in `services/license/index.ts:65-69`; nothing imports it. Point License's own files straight at core and delete `services/license/{auth,authz,gate,entitlements}.ts`.
2. **Remove the codec copies.** Replace the 14 b64url copies with `base64UrlEncodeBytes` from `@polaris-key/jws`, export `sha256Hex`, `hex` and `randomBytes` from `crypto.ts` through `core/platform.ts`, and delete the local copies.
3. **Cap the request readers.** Cap the portal `readBody` (`portal/api.ts:172`) at 64 KiB and the three bare `req.json()` calls (`browserSession.ts:399`, `oidc.ts:3179`, `core/devices.ts:928`) with the admin reader's limit.
4. **Fix the licence list** (`services/license/admin/licenses.ts:299`): add a `LIMIT`, batch the per-row reads and stop the per-row `resolveMergedPayload`. This is the first slice of CQW-16.
5. **Snapshot the test database.** `makeTestDb()` serializes the migrated database once per worker and clones it, replacing 133 migrations × 643 calls with one migration run per worker.
6. **Fix stale comments:** `test/boundaries.test.ts:200`, `services/license/index.ts:6-11`, `core/data.ts:6`.
7. **Add `SYSTEM_ACTORS`** in `core/audit.ts` and use it at the 13 raw-INSERT sites; changing the actor text is a stored-data cosmetic, so keep the values.
8. **Use one `escapeHtml`** (`core/brandHtml.ts`) for the 4 copies.
9. **Ship CQW-04's test** with the current allow-list. It costs nothing and stops new crossings from today, including the ones LX-27 and CM-02 would add.

---

## 12. Cross-domain dependencies

- **Licensing audit (LX, owner's licence simplification).** CQW-06's `core/licensing/issue.ts` is the code home for automatic minting and Discover self-mint; the policy is theirs. LX-16 takes the `payload.ts` split.
- **Commerce and distribution-channel audits.** CQW-13 and CQW-14 encode the owner's separation of channels from storefronts; they must agree on the facet split and the `commerce` slug before CM-01's plan is approved.
- **Identity audit.** CQW-07 underpins multi-SSO, BYO auth (I-22), the exchange endpoint (I-13) and console sign-in through accounts. Retention of `portal_audit` decides whether audit tables ever merge.
- **RBAC and administration audit.** Route-table `permission` (CQW-12) is the enforcement point. Whether `core.adminGroup` lives on is decided between ST-22 and ST-25.
- **Settings audit (ST).** `releases_enabled` versus `services_json.release`, the ST-05 aliases, ST-17 depending on CQW-05, and the 24 settings modules (about 8k lines) across `core/settings`, service `settings.ts` and `*Settings.ts` files.
- **Products and onboarding audit.** CQW-05 (repo-less ingest) and the descriptor `setup()` are prerequisites for the wizard and the Integration section.
- **Notifications and email (I-18, ST-27, CM-13, LX-27).** CQW-08 first.
- **Portal audit.** CQW-09 removes the `/api/releases` fallback in `packages/admin/src/portal/`; PX-09 and HA-09 build on the hook.
- **Console audit.** CQW-16 needs the Licenses table to page (cursor-based).
- **Release and update audit.** CQW-15 is a prerequisite for channel promotion across every feed and for gating on actual builds.
- **Cloud Sync (U-05).** Adopt CQW-11 and CQW-12 conventions from the start.
- **Test and CI (gate time).** CQW-17 directly cuts worker-suite time; coordinate with `/Users/vlad/Repos/pk-wt/_lead/gate.sh` scoping so the gate can run `test:service <slug>` for branches touching one service.
- **Wire, corpus and SDKs.** Only CQW-14 (the services table and discovery fragment, regenerating slug constants in every language) and CQW-15 (transcripts) touch generated cross-language artefacts. SP-10 retires the v2 fused shim.
