# Code-quality audit: Worker core, admin handlers, db layer, dispatch, settings

> DX consolidation, 2026-10-07. Domain: `packages/worker/src/{core,admin,db}`, `repo.ts`,
> `dispatch.ts` / `router.ts` / `mount.ts`, the settings registry and resolver
> (`core/settings/`), and the platform settings store (`core/platformSettings.ts`). Tree read:
> `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 + batch 5, head `38d3acc68`). In-flight branches
> read where they touch this domain: LX-08 (`core/grants.ts`, `repo.ts`, `identity/oidc.ts`),
> HA-12 (`core/products.ts`, `repo.ts`, `core/settings/*`). UK-13 and UK-14 do not touch it.
> All counts are measured with `rg` over `src/` unless stated; paths below are relative to
> `packages/worker/src/` unless they start with `packages/`, `docs/` or `test/`.

## 1. Summary

The Worker is well documented and carefully defended, but its structure has drifted away from
the "modular monolith, split-ready" design it describes. Six things stand out:

1. **The service boundary holds only for direct imports.** `core/adminApi.ts` re-exports
   `admin/lib/shape.ts`, which imports Release, Distribution, Identity and Config internals. As a
   result every service except Sync transitively imports every other service at runtime, and so
   do `core/blobGc.ts`, `core/deviceAdmin.ts` and `core/storefront/{ledger,audit}.ts` (measured
   with an import-graph walk; §3 P1). `test/boundaries.test.ts` checks one hop only.
2. **There are three ways to do almost everything.** Three error-body shapes plus a plain-text 405.
   Three platform-settings read paths and three write paths. Two HMAC cookie-session modules that
   are near copies. Around 24 base64url, 20 `sha256Hex`, 6 constant-time-compare and 3 PKCE copies.
   Two parallel sealed-credential stores. Seven extension mechanisms for services. Four ways to
   build a service context.
3. **The facade layer is permanent scaffolding.** `core/platform.ts`, `core/data.ts`,
   `core/adminApi.ts` and ten other re-export shims exist because a planned physical move never
   happened. They are also the _cause_ of much of the duplication: `core/platform.ts` does not
   re-export `sha256Hex` or base64url, and services may import only `core/`, so each service
   writes its own.
4. **"Core" is now the largest component and a dumping ground.** It has 56k lines in 170 files,
   112 of them flat in one directory. It holds ~4.9k lines of licensing logic, more than the License
   service itself (4.4k). Whatever two services share lands in `core/`, whatever the domain.
5. **The settings machinery outweighs the settings.** About 12.2k lines of source and about 11k
   lines of tests serve 79 registry entries, 15 of them still `pending`. The A-13 platform store
   keeps its own type system, resolver, validator, confirm logic and write path beside the ST-04
   registry. One registered platform setting (`storefront.polarisKey.enabled`) has no writer at
   all.
6. **There is no declarative route table outside the two auxiliary hosts.** The admin surface
   has about 231 hand-written method checks and 24 positional handlers next to 56
   context-object handlers. Its authorisation is one predicate re-checked in 10 handlers. That is
   the opposite of what the owner's RBAC request needs.

**The single most important change** is to finish the layering the code already describes, as
one lead-run move at a batch boundary (CQW-03). Physically move the top-level platform modules
and the shared admin helpers into their layers, delete the 13 shims, and turn
`test/boundaries.test.ts` into a transitive check. Then put the admin surface on one declarative
route table with a capability per route (CQW-04). Every other consolidation in this audit gets
cheaper after those two steps: RBAC, settings, audit, error shapes and the product-status
contributor. None of the recommended work touches the wire.

## 2. Current state (with file references)

### 2.1 Size and shape

| Component                                         | Lines                       | Files | Notes                                                                    |
| ------------------------------------------------- | --------------------------- | ----- | ------------------------------------------------------------------------ |
| `core/`                                           | 56,144                      | 170   | 112 files flat in `core/`; subdirs `settings/`, `storefront/`, `asc/`, … |
| `admin/`                                          | 14,467                      | ~45   | `handlers/products.ts` 1,685, `handlers/feeds.ts` 1,373                  |
| `repo.ts` + `admin/repo.ts`                       | 2,859                       | 2     | 110 exports in `repo.ts`; holds 101 of the Worker's 1,651 SQL statements |
| `db/`                                             | 178                         | 3     | `Db` interface, D1 and better-sqlite3 adapters (good, small)             |
| `services/distribution`                           | 55,867                      | 153   |                                                                          |
| `services/release`                                | 36,627                      | 83    |                                                                          |
| `services/identity`                               | 31,333                      | 75    | `oidc.ts` 3,258, `portal/api.ts` 1,772                                   |
| `services/update` / `license` / `config` / `sync` | 6,243 / 4,416 / 2,077 / 204 |       |                                                                          |

God files in this domain (over 1,000 lines): `repo.ts` 2,173, `admin/handlers/products.ts` 1,685
(including a ~580-line platform KEK re-seal sweep at `:654-1237` filed under "products"),
`core/hostedAssets.ts` 1,655, `core/settingsBackfill.ts` 1,442, `core/hooks.ts` 1,433 (contract
types), `core/overrideMigration.ts` 1,387, `admin/handlers/feeds.ts` 1,373, `core/blobs.ts`
1,351, `core/blobGc.ts` 1,291, `core/devices.ts` 1,260, `core/publisher.ts` 1,237,
`core/outletCredentials.ts` 1,118, `core/settings/write.ts` 1,101, `core/hostedAssetPulls.ts`
1,026, `core/registryTokens.ts` 1,006.

### 2.2 Dispatch

- `index.ts:33-51` → `dispatch.ts:74` `dispatch()` → `dispatchWith()` (`:105`). It routes the
  three auxiliary hosts first (`:116-134`: bytes, registry, image). Each has its own
  `isXHost`/`dispatchX` pair and a near-identical hostname module (`core/bytesHostname.ts:27-44`,
  `core/registryHostname.ts:18-45`, `core/imgHostname.ts:24-47`).
- Main host: `router.ts:112` `matchRoute()` is a hand-written matcher with 25 route kinds.
  Product routes then call `loadProduct()` (`dispatch.ts:144`). `loadProduct` **unseals the
  product's private signing key** for every product request (`core/products.ts:151-179`: three D1
  reads plus a KEK unwrap), although only 7 files use `signingKeyPem`. The bytes host already uses
  the key-free `loadProductPublic` (`core/bytesHost.ts:399-400`).
- Services: `core/registry.ts:371` `dispatchService` builds a `ServiceContext` with `ingest`,
  `hooks`, `storeGrants`, `licenseMerge` and `settings`. The admin dispatcher builds a different
  one (`admin/api.ts:187-209`: `ingest`, `licenseDelete`, `settings`, `hooks`, `session`, but no
  `storeGrants` or `licenseMerge`). `runScheduledServices` (`core/registry.ts:528`) builds a third,
  with `hooks` and `storeGrants` only. `buildHooks(SERVICES, product.services, {env, db, product,
now})` is spelled out at 15 sites.
- Admin: `admin/index.ts:75` → `admin/api.ts:382` `handleAdminApi`. This function owns the
  session, a per-subject rate limit, CSRF, and a long `if (head === …)` / `if (resource === …)`
  chain (`admin/api.ts:99-376`). Product-scoped requests call `getProduct` (`:108`), sometimes
  `getProduct` again (`:169`), then `loadProduct` (`:185`, `:303`), which unseals the key again.
  Core resources use positional handlers, e.g. `(req, env, db, session, slug, id, now)`
  (24 such handlers). Service `adminHandle`s use a context object (56 handlers).
- Declarative tables already exist for the auxiliary hosts: `ByteRoute` (`core/bytesHost.ts:97`)
  and `RegistryRoute` (`core/registryHost.ts:279`) carry `name`, `service`, `methods`, `match` and
  `handle`, and `routeCoverage` reads them. The main host and the admin API have nothing similar.

### 2.3 Layers and boundaries

- The rule, per `test/boundaries.test.ts:1-45`: a service may import `core/`, itself and packages,
  plus the single exception `update → release`. Core must not import services (`mount.ts:9-11`).
  Nothing states or tests whether Core may import `admin/`.
- In practice: `core/` → `admin/` has 19 runtime import edges (`core/adminApi.ts`, `core/bundles.ts`,
  `core/servicesAdmin.ts`, `core/ingest.ts`, `core/accountOverrides.ts`, `core/overrideMigration.ts`,
  `core/settingsBackfill.ts`, `core/payload.ts`, `core/registry.ts`). `core/` → top-level legacy
  modules has 73 edges (`env`, `repo`, `crypto`, `kv`, `keyvault`, `http`, `fingerprint`, …).
- The facades: `core/platform.ts` re-exports Env, Db, http, crypto, kv, keyvault, platformOidc and
  securityHeaders (`:1-82`: "the day the implementations physically move under `core/`, this file
  changes"). `core/data.ts` re-exports `repo.ts` ("Splitting that file per service is a later
  phase"). `core/adminApi.ts` re-exports `admin/*`, including `admin/lib/shape.ts` (`:91-98`).
  `shape.ts:20-44` imports `services/identity/portal/repo`, `services/release/{config,store,
descriptor,artifactMap}`, `services/distribution/registryFeeds` and `services/config/mint`.
- Measured transitive reach at runtime (import graph over `src/`):
  `license → {config, distribution, identity, release}`, `identity → {config, distribution,
release}`, `release → {config, distribution, identity}`, `config → {distribution, identity,
release}`. Example path: `services/license/admin/deletion.ts → core/adminApi.ts →
admin/lib/shape.ts → services/release/store.ts`.
- `admin/` itself may import anything. It imports about 30 internal service modules directly
  (`admin/handlers/feeds.ts:82-96`, `admin/lib/shape.ts:20-44`, `admin/lib/summary.ts:25`,
  `admin/handlers/polarisKeyStorefront.ts:55-62`, …), which bypasses the hooks' enablement gate.

### 2.4 Data access

- `repo.ts:1-3` claims to be "the repository layer". It actually holds 101 of 1,651 SQL statements.
  The rest live in 189 files: `core` 471, `identity` 361, `release` 354, `distribution` 211,
  `admin` 94, `license` 28.
- Table ownership (`TABLE_OWNERS`) exists only in the docs generator
  (`packages/docs/scripts/gen-reference.mjs:320`). It is documentation, never enforced. For
  example, `licenses` (License-owned) is written from `admin/`, `core/` (2 files), `repo.ts`,
  `services/identity` (4 files) and `services/license` (3 files). `audit` is inserted directly by
  10 files.
- `products` grows one JSON column plus one `*_source` marker per feature. Migrations add 14
  columns: `services_json`, `web_origins_json`, `trust_policy_json`, `fingerprint_policy_json`,
  `auto_issue_json` and their `_source` columns, `access_source` elsewhere. HA-12 adds
  `presentation_json` with a dynamic-column insert hack "so an insert still works against a
  database migrated only up to an older schema" (HA-12 `repo.ts` `presentationInsert`).
- About 25 local JSON-column parse helpers (`parseJson`, `parseObject`, `parseArray`,
  `parseJsonColumn`, `jsonOr`, …), two of them named `parseJsonColumn` with different signatures.

### 2.5 Errors and responses

- `core/errors.ts:67` `errorResponse` gives the flat `{"error":"code"}`. `:93` `wireError` gives
  the nested `{"error":{"code"}}`. `:105` `methodNotAllowed()` gives a **plain-text** 405.
  `admin/lib/respond.ts:29-44` `err` gives a hybrid that writes both the nested object _and_
  top-level `code`/`message`/`extra`. Portal (`services/identity/portal/api.ts:135-168`) and
  device login (`services/identity/portal/deviceLogin.ts:137-151`) carry their own `json`/`err`
  copies (flat). `core/attestation.ts:139-145` and `core/bundles.ts:148` carry local
  `badRequest`/`unauthorized`.
- 405 has three spellings: `err(405, ErrorCode.BadRequest, …)` ×122, `err(405,
"method_not_allowed", …)` ×45, and `methodNotAllowed()` (plain text) in 12 files. `422` and
  `409` usually ride on code `bad_request`, with the real reason in `extra.reason`. The console
  client has to parse every variant (`packages/admin/src/api.ts:4209-4245`).
- The device-facing shapes are part of the wire contract (`docs/security/WIRE-CONTRACT-V4.md:648,
1109, 1234`) and are **frozen**. The console and portal shapes are narrative-only (rule 10) and
  free to change.
- Body readers: `admin/lib/respond.ts:95` caps at 64 KiB and answers 400/413. The portal's
  `services/identity/portal/api.ts:172-184` has no cap and silently turns malformed JSON into `{}`.
  The `AdminBodyError` try/catch appears 5 times (`admin/api.ts:471`,
  `admin/handlers/platform.ts:225,242,270`, `admin/handlers/platformStoreConnections.ts:182`).
- Success envelopes: about 100 of the 255 `adminJson(…)` calls wrap `{ ok: true, … }`; the rest
  are bare.

### 2.6 Authorisation

- `admin/authz.ts:18-44` defines three functions with one predicate: `isPlatformAdmin`,
  `canAdminProduct` and `hasAnyAdminGrant` (all `groups.includes(PLATFORM_ADMIN_GROUP)`). The
  dispatcher checks it for product scope (`admin/api.ts:110`, _after_ the product lookup, so a 404
  comes before a 403). Ten handlers re-check it themselves (`products.ts:169`, `platform.ts:205`,
  `summary.ts:32`, `github.ts:171`, `ciPublishing.ts:122,153`, `trustPolicy.ts:62`,
  `outletCredentials.ts:80`, `platformStoreConnections.ts:178`, `me.ts:36`). Top-level routes
  (`/me`, `/summary`, `/github`, `/platform/*`, `/products`) rely only on their own check.
- `core.adminGroup` / `products.admin_group` is **dead configuration**. It is registered as a
  critical, security-widening, manifest-only setting (`core/settings/core.ts:64-85`, whose
  `readers` claims `admin/api.ts`), validated, resynced, backfilled, shown, and written across 10
  files (`admin/handlers/products.ts:296-424`, `services/release/resync.ts:492`,
  `core/settingsBackfill.ts:280-733`, …). Nothing ever reads it for authorisation
  (`admin/api.ts:27-28` says so).
- Every settings entry carries a `capability` (`core/settings/define.ts:16`, default
  `settings.<scope>.<owner>.write`), and nothing reads it yet (ST-21).
- Sessions: `admin/session.ts:85-283` and `services/identity/portal/session.ts:35-234` are the
  same HMAC-cookie implementation. Each has its own `base64UrlEncode`, `safeEqual`,
  `randomToken`, key import and domain tag (R1-02).

### 2.7 Settings

- **Registry** (ST-03): `core/settings/{types,registry,define,rules,platform,core,columns}.ts`.
  `SettingDef` has about 35 fields (`types.ts:149-299`). There are 79 entries (16 platform, 63
  product), 15 `pending`. Ownership: 31 claimable, 30 operator, 17 manifest. Storage: 30 scalar,
  18 column, 12 rich, 2 none.
- **Resolver and write path** (ST-04): `core/settings/resolve.ts` and `write.ts`.
  `resolveProductSettings` re-reads `SELECT * FROM products` (`resolve.ts:580-583`) even when the
  caller already has the row.
- **A-13 platform store, still a parallel system**: `core/platformSettings.ts` keeps its own
  `PlatformSettingDef` union (`:96-139`), `ConfirmLevel` (`:87`, duplicating `types.ts:87`),
  `validateSettingValue` (`:268`, vs `rules.ts:212` `fitsValueSpec`), `settingConfirmLevel`
  (`:296`, vs `write.ts:229` `confirmLevelFor`), `isHardOffVar` (`:462`, vs `resolve.ts:118`
  `isHardOffDeploy`), `resolveSetting` (`:485`, vs `resolve.ts:198` `resolvePlatformValue`, with
  a different source vocabulary: `runtime/failsafe` vs `platform`) and `writePlatformSetting`
  (`:612`). `admin/handlers/platformSettings.ts:330-452` re-implements expectedVersion, confirm and
  audit outside `writeSetting()`. Eight readers still use the A-13 `platformSetting()`;
  `core/keyEntries.ts` uses **both** paths (`:116` the resolver, `:170` A-13).
- **`core/rowSettings.ts`** (LX-06) wraps `writeSetting()` with its own `preflight`,
  `checkReason`, `checkVersion` and `MAX_SETTING_REASON = 500` (`:78-494`). These duplicate
  strict mode and `BREAK_GLASS_REASON_MAX = 500` (`settings/authority.ts:21`).
- **Platform store settings** (`core/platformStoreSettings.ts`, A-16) form a fourth store with its
  own spec type and precedence (console, then env), outside the registry (ST-12 plans to move it).
- **Ownership markers**: three mechanisms. Legacy `*_source` columns (6 on `products`, mapped by
  column adapters' `marker()`), `product_settings.source` claims, and `tiers.source` /
  `profiles.source`.
- **One-time migration machinery**: settings backfill (ST-01c: `core/settingsBackfill.ts`,
  `admin/settingsBackfill.ts`, `admin/handlers/settingsBackfill.ts`, about 2.3k lines) and the
  licence-override migration (U-03: `core/overrideMigration.ts` plus handler, about 1.7k lines,
  with a 30-day notice state machine). Both serve a deployment with two real products and both are
  still owner steps (`docs/RUNBOOK.md:742-830`).
- `legacyDefault` is a general mechanism (types, resolver, rules) with exactly one user
  (`services/license/licensingSettings.ts:81`).
- Write paths that call `writeSetting(…, strict: false)`: 12 sites in bespoke routes.

### 2.8 Extension mechanisms for services (seven)

1. Descriptor members (`core/registry.ts`: `handle`, `adminHandle`, `discoveryFragment`,
   `manifestIngest`, `manifestIngestAlways`, `authorizeRegistration`, `applyStoreGrant`,
   `scheduled`, `registryMaterialiser`, `settings`).
2. Descriptor hooks (`core/hooks.ts`: `releaseCatalog`, `delivery`, `outletCapabilities`,
   `licenseProvenance`).
3. Statement contributors (`licenseMerge`, `licenseDelete`).
4. Module-load registries filled by side-effect imports: `core/authorizationListeners.ts:47`,
   `core/subjectHooks.ts:73` and `core/licenseHolders.ts:280`, wired by
   `services/identity/index.ts:49` and `services/config/index.ts:22`. LX-08 adds
   `import "./entitlementEvents.js"` from Core. These run whatever the product's enablement,
   against `core/registry.ts:1-12`'s "a disabled service's code never runs".
5. Direct imports from `admin/` (the escape hatch for cross-service writes, e.g.
   `admin/handlers/feeds.ts`).
6. Composition-root route lists (`mount.ts:84-115`).
7. Hard-wired cron steps in `scheduled.ts:53-69,314-449`. Only Distribution uses
   `descriptor.scheduled`; Identity's and Release's sweeps are imported by name.

### 2.9 Tests and guardrails

- The repo has no ESLint (`pnpm lint` is Prettier only) and no `noUnusedLocals` /
  `noUnusedParameters` (`tsconfig.base.json`). Of 364 exports in this domain unused outside their
  own file, 169 are used only by tests and **14 are fully dead**: `moveLicenseAccount`,
  `breakGlassClaims`, `enqueuePackageRender`, `isRefusalReason`, `TRUST_LEVELS`,
  `CONSOLE_ICON_WIDTHS`, `authorizationListenerNames`, `unregisterAuthorizationListener`,
  `ciParamValue`, `LISTING_SOURCES`, `LISTING_ASSET_SOURCES`, `PR_VERDICTS`, `findAllowRule`,
  `PLAY_PREFLIGHT`.
- The admin harness is repeated: 86 test files mint admin sessions by hand and 56 hard-code the
  admin group. There is no shared `adminWorld()`, and `test/seed.ts:54` `makeEnv(kv, _slugs)`
  takes an unused parameter.
- There is no authorisation-matrix test (route × role). The route tables of the six service
  routers are hand-copied into `test/routeCoverage.test.ts`.

## 3. Problems (ranked)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                      | Impact                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P1  | **The service boundary is nominal at runtime.** Via `core/adminApi.ts → admin/lib/shape.ts`, every service except Sync transitively imports every other, and so do four Core modules. The boundary test checks one hop.                                                                                                                                                                                                                                                        | §2.3; `core/adminApi.ts:91-98`; `admin/lib/shape.ts:20-44`; `test/boundaries.test.ts`                                                                                                                                                                                                                                         | High: "split-ready" is false; cycles; any refactor of a service internal ripples.                      |
| P2  | **Facade and shim layer, and the duplication it causes.** 13 re-export-only modules. The narrow `core/platform.ts` forces services to re-implement primitives.                                                                                                                                                                                                                                                                                                                 | `core/{platform,data,adminApi,ingest,fingerprint,ciTokens}.ts`, `services/license/{authz,auth,entitlements,gate}.ts`, `services/release/manifest.ts`, `services/identity/portal/headers.ts`, `services/distribution/page/detect.ts`; ~24 b64url / ~20 `sha256Hex` / 6 constant-time compares / 3 PKCE / 7 random-token copies | High: the extra layers the owner calls out; drift risk in security primitives.                         |
| P3  | **Admin authorisation has no single enforcement point.** One predicate under three names, re-checked in 10 handlers; top-level routes self-gate; 404 before 403; no route × role table.                                                                                                                                                                                                                                                                                        | §2.6                                                                                                                                                                                                                                                                                                                          | High: the owner's RBAC (four roles, OIDC mappings, sum of roles) cannot be added safely on this shape. |
| P4  | **Settings: three read paths, three write paths, and a fourth store.** A-13's parallel type system, `rowSettings` checks, bespoke `strict:false` routes; one registered setting with no writer.                                                                                                                                                                                                                                                                                | §2.7; ST-05 brief follow-up (`storefront.polarisKey.enabled`)                                                                                                                                                                                                                                                                 | High: every console settings feature (ST-07…ST-16) is built twice or blocked.                          |
| P5  | **Settings machinery is out of proportion.** ~12.2k source lines and ~11k test lines for 79 entries, a 35-field `SettingDef`, `legacyDefault` with one user, three ownership-marker systems, and about 4k lines of one-time migrations for two products. The open ST tail (ST-15/16/18/23/24) adds governance (promote, env diff, as-of, enforce/delegate).                                                                                                                    | §2.7; `program/workpackages.json` ST rows                                                                                                                                                                                                                                                                                     | High: directly against "reduce configuration surface area".                                            |
| P6  | **Error and response shapes are inconsistent.** Three body shapes plus plain text; three 405 spellings; `bad_request` overloaded across 400/405/409/422; the portal body reader has no cap and silently accepts bad JSON; five copies of the same try/catch.                                                                                                                                                                                                                   | §2.5                                                                                                                                                                                                                                                                                                                          | Medium–High: clients parse defensively; one small safety gap (portal body).                            |
| P7  | **No declarative route table for the main host or admin API.** ~231 method checks, positional and context handler styles side by side, hand-copied coverage tables.                                                                                                                                                                                                                                                                                                            | §2.2, §2.9                                                                                                                                                                                                                                                                                                                    | Medium–High: blocks RBAC, OpenAPI/type generation for the console, and consistent 405s.                |
| P8  | **Seven extension mechanisms and four context builders.** Module-load registries run while their service is off; cron work is hard-wired by name.                                                                                                                                                                                                                                                                                                                              | §2.8; `core/registry.ts:371,528`; `admin/api.ts:187-209`                                                                                                                                                                                                                                                                      | Medium: a handler's capabilities depend on its entry point; enablement principle violated.             |
| P9  | **Data ownership is unenforced; `repo.ts` is a misnomer.** SQL in 189 files; `licenses` written from 5 layers; `TABLE_OWNERS` lives in the docs generator; `products` gains a JSON column per feature.                                                                                                                                                                                                                                                                         | §2.4                                                                                                                                                                                                                                                                                                                          | Medium: comingled licensing (the owner's complaint) shows up in the data layer too.                    |
| P10 | **Core is a dumping ground.** 112 flat files; licensing (`authz.ts`, `entitlements.ts`, `entitledAccess.ts`, `keyEntries.ts`, `licenseHolders.ts`, `licenseDelete.ts`, `licenseMerge.ts`, `graceClamp.ts`, `refusals.ts`, `payload.ts`, `storeGrants.ts`; LX-08 adds `grants.ts` at 845 lines) sits beside hosts, email, credentials and storefront rules. Name collisions: `authz.ts` ×3 with three meanings, `settingsBackfill.ts` ×3, `fingerprint.ts` ×2, `session.ts` ×2. | §2.1                                                                                                                                                                                                                                                                                                                          | Medium: discoverability, ownership, review load.                                                       |
| P11 | **Product loading is eager and repeated.** Every product request unseals the private key; admin requests load the product 2–3 times; the resolver re-reads `products`; `/me` runs N+1 schema reads.                                                                                                                                                                                                                                                                            | `dispatch.ts:144`; `core/products.ts:151-179`; `admin/api.ts:108,169,185,303`; `admin/handlers/me.ts:42-50`                                                                                                                                                                                                                   | Medium: latency plus least-privilege (the key is in memory for discovery, JWKS, CORS preflight).       |
| P12 | **Audit has eight writer helpers and ten raw `INSERT INTO audit` sites**, plus three `actorOf` variants and eight inline actor literals.                                                                                                                                                                                                                                                                                                                                       | §2.4; `admin/audit.ts`, `repo.ts`, `core/settingsClaims.ts`, `core/settings/write.ts`, `core/platformEvents.ts`                                                                                                                                                                                                               | Medium: inconsistent audit rows; ST-24 retention has to know them all.                                 |
| P13 | **Two parallel sealed-credential stores (plus `product_secrets`).** `outletCredentials.ts` and `platformCredentials.ts` each have put/delete/open/pin/version/record-result (two `versionOf` with different formats).                                                                                                                                                                                                                                                          | `core/outletCredentials.ts:949`, `core/platformCredentials.ts:312`                                                                                                                                                                                                                                                            | Medium: blocks "use platform credentials automatically"; CM-02 would add a fourth store.               |
| P14 | **Dead and test-only code.** 14 dead exports; `core.adminGroup`; `GET /summary` per-service facts become dead with the owner's simplified product card.                                                                                                                                                                                                                                                                                                                        | §2.9; `admin/lib/summary.ts`, `admin/handlers/summary.ts`                                                                                                                                                                                                                                                                     | Low–Medium                                                                                             |
| P15 | **Three copy-pasted hostname modules and three host dispatchers.**                                                                                                                                                                                                                                                                                                                                                                                                             | §2.2                                                                                                                                                                                                                                                                                                                          | Low                                                                                                    |
| P16 | **Test harness duplication.** 86 files roll their own admin session.                                                                                                                                                                                                                                                                                                                                                                                                           | §2.9                                                                                                                                                                                                                                                                                                                          | Low–Medium: slows every admin WP.                                                                      |

## 4. Owner brief: item-by-item stance

| Brief item                                                                                                                                     | Stance                                                        | Reasoning and what it means in this domain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Run code quality audits … no duplicated code, code smells … consistency, style, extensibility and modularness"                                | **Adopt**                                                     | This audit. Duplication is concrete and countable (§3). Ship it as CQW-01…CQW-10 plus edits to the ST tail, not one giant refactor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| "A lot of layers and abstractions that might not really be needed anymore"                                                                     | **Adopt**                                                     | Delete 13 shims and facades (CQW-03), the A-13 parallel settings types (ST-05a), three module-load registries (CQW-05), `legacyDefault` and `core.adminGroup` (ST-25), and the one-time migration machinery once run (CQW-08).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| "Reduce the configuration surface area"                                                                                                        | **Adopt, and push back on part of the in-flight plan**        | Freeze the registry at what has a reader and a console row: a "settings budget" rule in `rules.ts`. Push back on ST-15 (turning hard-coded policy into new knobs), ST-18 and ST-23 (promote, export, environment diff), ST-16's enforce-or-delegate matrix, and the planned as-of and restore. Delete the dead `core.adminGroup`.                                                                                                                                                                                                                                                                                                               |
| "Flexibility within limits"                                                                                                                    | **Adapt**                                                     | The registry's `policyBound`, `inherits` and `allowUnset` already express limits. Keep them, but stop adding per-entry fields: ordering and "commonly changed" go in one areas manifest, not a new field.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| "If something can be automated … credentials available at the platform or product level … should just be done"                                 | **Adopt**                                                     | Code prerequisite: one credential resolver, product then platform then env, over one sealed store (CQW-09), so a connector or storefront can tell "already possible" without a wizard. Today that answer is spread over `platformStoreSettings.ts`, `platformCredentials.ts`, `outletCredentials.ts` and `product_secrets`.                                                                                                                                                                                                                                                                                                                     |
| "Shared technology … gracefully degraded based on service availability"                                                                        | **Adapt**                                                     | The principle exists in code (hooks answer `null` when the provider is off; `dispatchService` hides disabled services), but `admin/` composition reads service tables directly and module-load listeners run regardless. Fix: every cross-service read goes through descriptor hooks or contributors (CQW-05), with a transitive boundary test (CQW-03).                                                                                                                                                                                                                                                                                        |
| "Console Platform settings expanded … commonly changed settings above others"                                                                  | **Adapt**                                                     | One write path (ST-05a) makes every platform registry entry editable without a bespoke route; today `storefront.polarisKey.enabled` has no writer. Order comes from `core/settings/areas.ts` (area order and featured keys), not new per-entry knobs. The UI is the console audit's.                                                                                                                                                                                                                                                                                                                                                            |
| "Switch between the Platform and Product sidebar"                                                                                              | **Defer** (console audit)                                     | The route table (CQW-04) carries `scope: platform \| product`, so the console can derive which sidebar a page belongs to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RBAC: Superadmin, Platform Admin, {Product} Admin, Console Access, OIDC group and claim mappings, sum of roles, administrators subject to RBAC | **Adapt** (the role model belongs to the RBAC/identity audit) | Code prerequisites in this domain: (1) one enforcement point, `can(principal, capability, scope)`, run by the dispatcher from a declared capability per route (CQW-04, absorbing ST-21). (2) Remove the 10 handler-level re-checks. (3) Decide 404 vs 403 for scoped roles (recommended: answer 404 for a product the principal cannot see, to avoid enumeration). (4) Role bindings are **operator-owned in the console, never manifest-declared**: a `.pkey/` writer must not be able to grant console rights. So `core.adminGroup` is deleted rather than wired. (5) `PLATFORM_ADMIN_GROUP` stays as the deploy-time break-glass superadmin. |
| "Console/Management accounts go through the same accounts system"                                                                              | **Adapt**                                                     | First the shared HMAC realm-tagged token module (CQW-01, no cookie change). Then, in the RBAC WP, an account-backed admin principal (`accountId` plus roles in the session). Cookie realms stay separate (`__Host-pkey_admin` vs portal) for CSRF and blast radius.                                                                                                                                                                                                                                                                                                                                                                             |
| Simplified product card: "row with the icons for enabled services. No additional details"                                                      | **Adopt**                                                     | `GET /manage/api/summary` and `admin/lib/summary.ts` (four grouped queries over service tables) become dead. The card needs only `services` plus a status dot, served by the descriptor `productStatus` contributor (CQW-05).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Integration section, dismissible "after a handshake and data exchange happens end to end"                                                      | **Adapt**                                                     | Backend signal without new tables: each service's `productStatus` contributor derives `firstSeenAt` from existing rows (first device registration or activation, first signed document, first release publish, first feed or appcast read, first sign-in). The section's dismissal is a row-backed operator setting `core.integration.dismissed` (no new column).                                                                                                                                                                                                                                                                               |
| "Massive undertaking … we have a lot of inflight work"                                                                                         | **Adopt, with sequencing**                                    | Mass moves (CQW-03) are lead-run codemods at a batch boundary after LX-08 and HA-12 merge, so in-flight branches rebase once. Everything else is small, mergeable WPs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Licences: "lots of abstraction layers and comingling"                                                                                          | **Adapt** (licensing audit owns the model)                    | Code side: give licensing one home, `core/licensing/` (seats, grants, holders, entitlements, refusals, key entries, payload), with the `licenses` table written only from it plus documented seams (CQW-03/06). Identity's ten files of `licenses` SQL move behind it.                                                                                                                                                                                                                                                                                                                                                                          |
| "Subscription licences available even if Commerce is not active"                                                                               | **n/a here**                                                  | Licensing logic already sits in Core, independent of the commerce code in Distribution. Keep it that way when LX-23 and CM-08 land: the subscription state machine belongs in `core/licensing/`, not under `services/distribution/commerce/`.                                                                                                                                                                                                                                                                                                                                                                                                   |

## 5. Target design

### 5.1 Layers, enforced transitively

```
platform/   Env, Db types, bytes (b64url, hex), hash (sha256Hex/B64url, HMAC), compare, pkce,
            random ids and tokens, hmacToken (realm-tagged), json-column helpers, kv, keyvault,
            securityHeaders, platformOidc, http request helpers. Imports nothing else in src/.
core/       The always-on domain substrate, in domain folders (5.6). Imports platform/ only.
            Never admin/ (console/), never services/.
services/   Each imports core/, platform/ and itself; cross-service access only through
            descriptor hooks and contributors. (update → release stays the one exception.)
console/    (today admin/) the admin HTTP surface. Imports core/, platform/ and each service's
            `services/<slug>/public.ts`, never service internals.
app/        The composition root: index.ts, dispatch.ts, router.ts, mount.ts, scheduled.ts.
```

`test/boundaries.test.ts` becomes a **transitive** check (a runtime import-graph walk, as in this
audit). Core never reaches `services/` or `console/`. A service never reaches another service
except `update → release`. A `public.ts` barrel per service makes the console's reach countable.
The 13 shims are deleted, not kept as compatibility re-exports.

### 5.2 One descriptor, one extension point, one context builder

`ServiceDescriptor` gains typed members that replace the side channels:

- `routes` (product routes on the main host), `adminRoutes` (5.3), `byteRoutes` and
  `registryRoutes` (already declarative; they move from `mount.ts` lists onto the descriptor);
- `provides`: the hooks it implements (unchanged contract types in `core/hooks/`, split one file
  per hook);
- `contributes`: `licenseMerge`, `licenseDelete`, `subjectStores` (replacing
  `registerSubjectStore`), `licenseHolders` (replacing `registerLicenseHolderHooks`),
  `onAuthorization` (replacing `registerAuthorizationListener`), `ingest`, `maintenance`
  (replacing the hard-wired sweeps in `scheduled.ts`), and `productStatus` (5.7).

Contributors run only while the service is enabled for the product, except `maintenance` steps
explicitly declared `platform: true` (retention sweeps). A single `serviceContext(kind, …)` in
`core/context.ts` builds `{req, env, db, product, now, hooks, ingest, storeGrants, licenseMerge,
licenseDelete, settings, session?, waitUntil?}` the same way for public, admin, scheduled,
portal and host dispatch, so no handler's capabilities depend on its entry point.

### 5.3 One route table for the admin API (later, optionally, the main host)

Generalise the existing `ByteRoute` / `RegistryRoute` shape:

```ts
interface AdminRoute {
  name: string; // for logs, docs, tests
  methods: readonly HttpMethod[]; // dispatcher answers 405 method_not_allowed
  path: string; // "/products/:slug/license/tiers/:id"
  scope: "platform" | "product";
  service?: ServiceSlug; // product routes of a service
  capability: string; // "license.tiers.write", "platform.settings.write"
  stepUp?: true; // replaces ad-hoc isSteppedUp checks
  handle(ctx: AdminContext): Promise<Response>;
}
```

The dispatcher does session, rate limit, CSRF, method, product load (once, public facts),
`can(ctx.principal, route.capability, scope)`, `AdminBodyError` and error mapping. Handlers
receive one `AdminContext` (the 24 positional handlers become context handlers). The table is
exported for `routeCoverage`, the generated narrative docs list, a route × role test matrix, and
later a typed console client (replacing hand-mirrored types in `packages/admin/src/api.ts`, 5,673
lines). Public product routes can migrate later behind the transcripts gate. That migration is
optional and must not change bytes.

### 5.4 One response module per audience

- **Device surfaces (frozen wire)**: `core/http/wire.ts` keeps `errorResponse` (flat) and
  `wireError` (nested) exactly as contracted. No change.
- **First-party SPAs (console and portal, narrative-only)**: one `core/http/respond.ts` with
  `json`, `error(status, code, {message, reason, fields})` (nested `{error:{code, message,
reason, fields}}` only), `notFound`, `forbidden`, `methodNotAllowed` (always JSON
  `method_not_allowed`) and `readBody` (64 KiB cap, 400 on malformed JSON, for both surfaces).
  `code` names the class (`bad_request`, `conflict`, `unprocessable`, …) and `reason` the
  specific refusal. The console client keeps reading `body.error.*` first, so the cut-over is
  compatible. A test bans local `function err|json|notFound|badRequest` outside this module.
- Success bodies are the resource itself; `{ ok: true }` only for action endpoints with no
  resource.

### 5.5 Settings: one store model, one resolver, one write path

- **Write**: `writeSetting()` is the only writer at every scope. The A-13 platform route calls it
  in strict mode. `PlatformSettingDef`, `validateSettingValue`, `settingConfirmLevel`,
  `isHardOffVar`, `resolveSetting` and `writePlatformSetting` are deleted. `rowSettings.ts` keeps
  only the manifest-ingest statement builder, not its route checks. Bespoke routes become thin
  adapters that map a body to `SettingWrite[]` with no version, confirm or reason logic of their
  own.
- **Read**: `resolvePlatformSetting(key)` / `resolveProductSettings(product, keys)` everywhere
  except the column-backed hot paths. A typed key map (`PlatformSettingValues` generated from the
  registry) keeps call sites typed. The resolver accepts already-loaded `ProductFacts`
  (5.8) and never re-reads `products`.
- **Storage rule for new settings**: row-backed in `product_settings` by default. No new
  `products.*_json` columns and no new `*_source` markers. Column-backed stays for the existing hot
  path columns only (S-18 §4.3). HA-12's `presentation_json` lands as-is and is the last of its
  kind.
- **Registry discipline**: `rules.ts` refuses an entry that has no `readers` and is not `pending`.
  It caps `pending` entries per slice, and requires `NOT_A_SETTING` for constants that stay code
  (rate limits, TTLs, GC keep-N, feed depths). `legacyDefault` is retired with LX-16 and
  `core.adminGroup` is deleted (ST-25).
- **Ownership markers**: the six `*_source` columns are read through the adapters' `marker()`
  until ST-25 converts them into `product_settings` claim rows once (a replayable migration). One
  ownership vocabulary then remains: `manifest | console | default`.
- **Areas manifest**: `core/settings/areas.ts` lists each area's order, label and featured keys
  for "commonly changed first".

### 5.6 Core in domain folders

`core/{http, context, hooks, settings, licensing, devices, accounts, assets, credentials, hosts,
storefront, email, ops}` plus `platform/`. A mapping table goes into CQW-03's brief. Highlights:

- `licensing/`: `authz.ts` (renamed `seats.ts`), `entitlements.ts`, `entitledAccess.ts`,
  `keyEntries.ts`, `licenseHolders.ts`, `licenseDelete.ts`, `licenseMerge.ts`, `graceClamp.ts`,
  `refusals.ts`, `payload.ts`, `storeGrants.ts`, `reservedNames.ts`, LX-08's `grants.ts` and
  `entitlementEvents.ts`, and the licence/key/tier/profile queries from `repo.ts` and
  `admin/repo.ts`.
- `hosts/`: one `hosts.ts` table (`bytes: BLOB_ORIGIN`, `registry: PKG_ORIGIN`, `img:
IMG_ORIGIN`, with precedence) replacing three hostname modules, beside the three host
  dispatchers and two landing pages.
- `credentials/`: outlet, platform and product secrets, CI and registry tokens.

### 5.7 Product status contributor (supports onboarding)

`contributes.productStatus(ctx) → { configured: boolean, firstSeenAt: number | null, steps:
Array<{ id, done, href }> }`, computed from existing rows. It feeds the simplified product card
(enabled-service icons and a status dot), the Integration section and its "integration done"
signal, and the per-service setup wizards' checklists. It replaces `admin/lib/summary.ts` and the
service-specific reads in `admin/lib/shape.ts` `productView`.

### 5.8 Request-scoped product context

`loadProductContext(db, slug)` makes one read set per request (row, active key public half,
schema version) and returns `ProductPublic` plus `signer(): Promise<Signer>`, which unseals on
first use. `Product.signingKeyPem` is removed from the type, so the compiler finds the 7
consumers. Admin dispatch loads it once and passes it into `AdminContext`.

### 5.9 Data ownership and audit

- `db/owners.ts` holds `TABLE_OWNERS` (the docs generator imports it). A test refuses
  `INSERT|UPDATE|DELETE` on a table outside its owner's directory, except for a short, commented
  `SEAMS` list (for example Identity minting licences, which goes through `core/licensing`).
- `repo.ts` and `admin/repo.ts` split into owner stores (`core/products/store.ts`,
  `core/licensing/store.ts`, `core/devices/store.ts`, `services/config/store.ts` for
  `product_schema` and `profiles`, …).
- One audit writer: `core/audit.ts` `auditStatement({scope, product?, actor, action, target,
summary, before?, after?, origin?, settingKey?, reason?})`, with `actorOf(session)`. ST-24's
  keep-latest-per-setting retention lives there.

### 5.10 Credentials (with distribution and commerce)

One sealed store with `(scope: platform | product, kind, id)`. That covers `product_secrets`,
`outlet_credentials`, `platform_credentials`, and the non-secret `platform_store_settings`
values as unsealed `meta`. One resolver answers product, then platform, then env with
provenance. The "is this already possible?" check for automatic channel or storefront enablement
reads it.

## 6. Surface-area reduction

| Removed or merged                               | Today                                                                                                                                                                                                                                                                   | After                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Re-export facades and shims                     | 13 modules (`core/platform`, `core/data`, `core/adminApi`, `core/ingest`, `core/fingerprint`, `core/ciTokens`, `services/license/{authz,auth,entitlements,gate}`, `services/release/manifest`, `services/identity/portal/headers`, `services/distribution/page/detect`) | 0; per-service `public.ts` barrels for the console only                     |
| Encoding/crypto helper copies                   | ~24 base64url, ~20 `sha256Hex`, 6 constant-time compares, 3 PKCE, 7 random-token helpers, 2 session modules                                                                                                                                                             | 1 each in `platform/`                                                       |
| JSON-column parsers                             | ~25 local helpers                                                                                                                                                                                                                                                       | `platform/json.ts` (`parseJsonColumn`, `parseJsonObject`, `parseJsonArray`) |
| Error and response helpers                      | 3 body shapes plus plain text; 3 spellings of 405; 4 local `err`/`json` copies; 2 `readBody`s; 5 `AdminBodyError` try/catches                                                                                                                                           | device wire (frozen) plus one first-party module; one dispatcher catch      |
| Admin authorisation predicates                  | 3 names, 1 predicate, 10 handler re-checks                                                                                                                                                                                                                              | `can()` once in the dispatcher                                              |
| Settings: platform path                         | A-13 types, resolver, validator, confirm and writer beside the registry                                                                                                                                                                                                 | the registry and `writeSetting()` only                                      |
| Settings: product path                          | `rowSettings` route checks plus 12 `strict:false` bespoke writers                                                                                                                                                                                                       | strict `writeSetting()` with thin adapters                                  |
| Settings: entries and mechanisms                | `core.adminGroup` (dead), `legacyDefault` (1 user), 3 ownership-marker systems, `ConfirmLevel` ×2, reason-limit constant ×2                                                                                                                                             | deleted / deleted after LX-16 / 1 vocabulary / 1 / 1                        |
| Settings: planned additions avoided             | ST-15 new knobs, ST-18 promote/export/import, ST-23 env promote, ST-16 enforce-or-delegate, S-18 as-of/restore                                                                                                                                                          | `NOT_A_SETTING` entries; deferred                                           |
| Extension mechanisms                            | 7 (descriptor, hooks, contributors, 3 module-load registries, admin escape hatch, composition lists, hard-wired cron)                                                                                                                                                   | descriptor members (`routes`, `adminRoutes`, `provides`, `contributes`)     |
| Service context builders                        | 4 (public, admin, scheduled, host)                                                                                                                                                                                                                                      | 1                                                                           |
| Host modules                                    | 3 hostname modules                                                                                                                                                                                                                                                      | 1 table                                                                     |
| Data ownership                                  | `TABLE_OWNERS` in the docs generator, unenforced                                                                                                                                                                                                                        | `db/owners.ts` with a writer test                                           |
| Audit writers                                   | 8 helpers plus 10 raw insert sites plus 3 `actorOf`                                                                                                                                                                                                                     | 1 builder plus `actorOf`                                                    |
| Credential stores                               | `product_secrets`, `outlet_credentials`, `platform_credentials`, `platform_store_settings`                                                                                                                                                                              | 1 sealed store with scope (CQW-09)                                          |
| Console endpoints                               | `GET /manage/api/summary` per-service facts                                                                                                                                                                                                                             | gone (product card shows icons and status)                                  |
| One-time migrations (after the owner runs them) | settings backfill (about 2.3k lines, 3 files, 3 routes), override migration (about 1.7k lines, a console page, state table)                                                                                                                                             | deleted; reports exported to R2 or kept read-only for 90 days               |
| Dead code                                       | 14 dead exports; unused `makeEnv` parameter                                                                                                                                                                                                                             | 0, with a test that keeps it at 0                                           |
| Misfiled code                                   | KEK re-seal sweep in `admin/handlers/products.ts:654-1237`; three admin handlers in `core/` (`bundles`, `servicesAdmin`, `blobGc` admin)                                                                                                                                | `console/platform/kek.ts`; console layer                                    |

## 7. Automation and onboarding

- **Product status contributor** (5.7) is the backend for the owner's Integration section,
  "integration done" detection, the simplified product card and setup checklists. It needs no new
  tables. Dismissal is one row-backed operator setting.
- **Credential resolver** (5.10) lets the console say "Homebrew / App Store channel can be
  enabled now" and enable it on confirm, because whether credentials exist at product, platform
  or env scope is one call.
- **Route table** (5.3) generates the console's typed client, the narrative API docs list and the
  route × role matrix test, so a new admin endpoint gets docs, types and authorisation coverage
  automatically.
- **Settings areas manifest** plus the generic API mean a new registry entry appears in the
  console hub and ⌘K search with no bespoke route or page (ST-06's generator already does search
  and docs).
- **Descriptor `maintenance`** makes every retention or cleanup sweep declared next to the table
  it cleans. `scheduled.ts` becomes a loop, so a new service cannot forget its sweep.
- **Developer onboarding for contributors**: the 12-step "adding a service" checklist
  (`packages/docs/src/content/docs/contribute/layout.md:134-168`) loses steps 4 (`mount.ts` lists
  derive from descriptors) and 8 (route coverage reads the descriptor). A shared `adminWorld()`
  test harness removes about 40 lines of boilerplate per admin test file.

## 8. Migration, data and risk

- **Wire**: none of the recommended work touches the wire. Device error shapes, signed documents,
  client-core and the corpus are untouched. Moving _public_ routes onto a route table is optional,
  and the transcripts drift gate (`pnpm gen transcripts --check`) must stay byte-identical. If a
  later change wanted to unify device error shapes, it would be a plan-mode, all-SDK event; **this
  audit recommends against it**.
- **Console and portal error shape**: removing the hybrid top-level `code`/`message` from admin
  errors is safe because `packages/admin/src/api.ts:4231-4236` already prefers `body.error.*`.
  The portal's flat `{error:"code"}` moving to nested needs the portal client updated in the same
  WP (both are first-party, deployed together by `assemble`).
- **Mass moves (CQW-03)**: merge-conflict risk with every in-flight branch. Mitigation: the lead
  runs a scripted `git mv` plus specifier rewrite at a batch boundary, after LX-08 and HA-12 merge,
  in mechanical commits with no behaviour change, verified with typecheck plus the worker suite.
  No temporary shims stay behind. Builders of open branches merge `main` once (allowed by the
  integration rules).
- **D1 migrations**: drop `products.admin_group` (replayable; `ALTER TABLE … DROP COLUMN`, guarded
  by a reader audit). Convert the `*_source` markers into `product_settings` rows (ST-25,
  replayable, scratch-SQLite rehearsal). Drop the `settings_backfill_reports` and
  `override_migration` tables only after the owner steps are done and the reports are exported.
  The credential-store merge (CQW-09) moves sealed material: re-seal under the active KEK with the
  same AAD rules, as a dry-run and apply pair, with a security review and a THREAT-MODEL update.
- **Session module unification (CQW-01)**: code sharing only. Cookie names, domain tags
  (`pkey.admin.v1|`, `pkey.portal.v1|`) and keys are unchanged, so no session is invalidated.
  The account-backed admin principal (RBAC WP) changes the admin cookie payload and needs a
  one-redirect re-login of operators.
- **Lazy signer (CQW-07)**: removing `signingKeyPem` from `Product` makes the compiler find every
  signing path. Risk is low, and there is a latency win on discovery, JWKS, CORS and appcast.
- **Authorisation refactor (CQW-04)**: behaviour stays "platform admin may do everything" until
  RBAC. A THREAT-MODEL §9 review trigger applies because the enforcement point moves. A route ×
  principal matrix test is part of acceptance.
- **Removing one-time migrations (CQW-08)**: gated on the owner checklist
  (`~/Downloads/polaris-key-owner-steps.md` item 361 onwards). If never run, the code stays.

## 9. Backlog changes

| id                                              | action | target                        | note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-05                                           | split  | ST-05a, ST-05b                | **ST-05a** (worker, 0.6–0.8 wk): one settings path. Fold the A-13 platform store into the registry resolver and `writeSetting()` (delete `PlatformSettingDef` and the parallel validator, confirm, resolver and writer), strip `rowSettings` route checks, move the 8 A-13 readers to `resolvePlatformSetting`, make `/platform/settings` PATCH/DELETE strict writes, write `storefront.polarisKey.enabled`. **ST-05b** (0.5–0.7 wk): the generic routes per S-18 §4.7 _minus_ history, as-of and restore, and the bespoke routes rebuilt as thin adapters in the same WP (no long alias period). Declare both on CQW-04's route table if it has landed. |
| ST-21                                           | merge  | CQW-04                        | `can()` belongs on every admin route, not just settings writes. The registry `capability` becomes the settings routes' capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ST-22                                           | edit   | RBAC WP (identity/RBAC audit) | No longer "optional per-product roles". It becomes the owner-requested RBAC (Superadmin, Platform Admin, Product Admin, Console Access, OIDC group and claim bindings, sum of roles) on CQW-04's gate, with operator-owned bindings (not manifest). Keep plan mode and the security review. Depends on CQW-04 and CQW-01.                                                                                                                                                                                                                                                                                                                                |
| ST-15                                           | edit   | ST-15                         | Push back: promote only constants with a demonstrated operator need (seat dormancy per tier, if licensing wants it). Everything else (blob GC keep-N, feed depths, registry-token caps, retention) becomes `NOT_A_SETTING` entries with search copy. About 0.2 wk.                                                                                                                                                                                                                                                                                                                                                                                       |
| ST-16                                           | edit   | ST-16                         | Keep live inheritance and the fan-out count with an L2 confirm (already modelled by `inherits` and `policyBound`). Drop "enforce or delegate" and the products-policies matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ST-18                                           | defer  | —                             | Promote-to-repo, export and import, and the CLI diff have little value on a two-product deployment. Revisit when a third-party adopter exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ST-23                                           | defer  | —                             | Environment export, diff and promote and copy-from-product: same reason. A template copy can be one CLI command later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ST-24                                           | merge  | CQW-06                        | Keep-latest-per-setting retention is a property of the single audit writer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ST-25                                           | edit   | ST-25                         | Widen: plus delete `core.adminGroup` and `products.admin_group` (migration), retire `legacyDefault` (after LX-16), convert the `*_source` markers into claim rows, remove `rowSettings` leftovers and the bespoke aliases ST-05b made adapters, empty `PENDING`.                                                                                                                                                                                                                                                                                                                                                                                         |
| ST-11                                           | keep   | —                             | Consolidation (email caps, lazy-delta product settings, `operator_policy_json` into the registry). Depends on ST-05a, not the whole ST-05.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ST-12                                           | keep   | —                             | Also absorbs `platform_store_settings` into the registry; coordinate with CQW-09's store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ST-17                                           | keep   | —                             | One shared dry-run plan for the five manifest-apply entry points (link, link-existing, resync, deploy hook, backfill) is consolidation (release audit).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ST-07, ST-08, ST-09, ST-10, ST-13, ST-14, ST-27 | keep   | —                             | Console work; now depends on ST-05a/b instead of ST-05. ST-09 uses the areas manifest (5.5) for "commonly changed first".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| HA-10 (in-review)                               | keep   | —                             | Its readers (`core/assetSettings.ts`) already use the resolver; good model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| HA-12 (in-review)                               | keep   | —                             | Accept `presentation_json` as the last new `products.*_json` column. Follow-up: drop the `presentationInsert` dynamic-column hack once migration 0106 is everywhere (CQW-10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| LX-08 (in-review)                               | keep   | —                             | `core/grants.ts` is cleanly layered (imports only `db/types` and `storeGrants`), a good model. Its side-effect `import "./entitlementEvents.js"` registration moves to a descriptor `subjectStores` contribution in CQW-05. It moves into `core/licensing/` in CQW-03.                                                                                                                                                                                                                                                                                                                                                                                   |
| LX-16                                           | edit   | LX-16                         | Also retire the `legacyDefault` mechanism, the `legacy` branch of `licensing.entitlementModel`, and `resolveEffective`'s fused payload (`core/authz.ts:173`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| U-03 / ST-01c follow-up                         | edit   | CQW-08                        | After the owner runs them, delete the migration machinery (see §8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CM-02                                           | edit   | CM-02                         | "Platform secrets" for Stripe go into CQW-09's single sealed store, not a fourth table. Webhook intake routes are declared on the route table. Depends on CQW-09 (or at minimum on its design).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CM-03                                           | edit   | CM-03                         | Its dependency on ST-21 becomes CQW-04.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PS-06 (in-review)                               | keep   | —                             | It composes Identity and Distribution in `admin/handlers/polarisKeyStorefront.ts` through direct imports; CQW-05 moves those reads to hooks or `public.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| UK-13, UK-14                                    | keep   | —                             | Not in this domain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 10. New work packages

| proposed id | title                                                                                  | scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | deps                                                                   | plan mode                                      |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------- |
| CQW-01      | Platform primitives and duplicate-helper sweep                                         | `platform/{bytes,hash,compare,pkce,random,json,hmacToken}.ts`. Re-export them through `core/` so services can use them, then replace the ~24 base64url, ~20 `sha256Hex`, 6 constant-time compare, 3 PKCE, ~7 random-token and ~25 JSON-column copies. `admin/session.ts` and `services/identity/portal/session.ts` share `hmacToken` (same cookies, keys and domain tags). 0.6–0.9 wk.                                                                                                                                                                                                                                                           | —                                                                      | no                                             |
| CQW-02      | First-party response, error and body module                                            | `core/http/respond.ts` for console and portal. Nested error shape, one 405 (`method_not_allowed`), class `code` plus specific `reason`, a capped `readBody` for the portal (fixes the silent `{}`), one `AdminBodyError` catch in each dispatcher, a success-envelope rule, a test banning local helpers, and the console and portal clients updated. Device wire helpers untouched. 0.5–0.7 wk.                                                                                                                                                                                                                                                 | CQW-01                                                                 | no                                             |
| CQW-03      | Layering: physical moves, shim deletion, Core domain folders, transitive boundary test | Lead-run codemod at a batch boundary. Top-level `env/crypto/kv/keyvault/http/securityHeaders/platformOidc/fingerprint/merge` move into `platform/`. Shared `admin/lib/*`, `admin/audit.ts` and session types move into `core/` or `console/`. Split `admin/lib/shape.ts` (JSON helpers to `platform/`, licence summary to `core/licensing/`, `productView` stays in the console). Delete the 13 shims. Group `core/` into domain folders (5.6). Rename `admin/` to `console/`. Move the three Core admin handlers into the console. Add per-service `public.ts`, and make `test/boundaries.test.ts` transitive. No behaviour change. 0.8–1.2 wk. | LX-08, HA-12 merged; CQW-01                                            | no (lead-run, merge-window)                    |
| CQW-04      | Admin route table and the `can()` gate                                                 | `AdminRoute` declarations for every console route (Core and service `adminRoutes`). The dispatcher owns session, rate limit, CSRF, method/405, a single product load, capability check, step-up and errors. Positional handlers become `AdminContext` handlers. Remove the 10 handler re-checks and the 3 authz aliases. Product-scope 404 before authz becomes "invisible = 404". Export the table for `routeCoverage`, docs and a route × principal matrix test. Move the KEK sweep out of `products.ts`. Absorbs ST-21. 1.4–2.0 wk.                                                                                                           | CQW-02, CQW-03                                                         | no (THREAT-MODEL §9 review trigger)            |
| CQW-05      | Descriptor consolidation and `productStatus`                                           | Replace `registerSubjectStore`, `registerLicenseHolderHooks` and `registerAuthorizationListener` with descriptor `contributes.*`, gated by enablement. Add `maintenance` steps to replace the service imports in `scheduled.ts:53-69`. One `serviceContext()` builder for public, admin, scheduled, portal and hosts. `productStatus` contributors replace `admin/lib/summary.ts`, `GET /summary` facts and the service reads in `productView`. Route the console's cross-service reads through hooks or `public.ts`. 1.0–1.4 wk.                                                                                                                | CQW-03                                                                 | no                                             |
| CQW-06      | Data ownership and one audit writer                                                    | `db/owners.ts` (the docs generator imports it). A writer-location test with a `SEAMS` allow-list. Split `repo.ts` and `admin/repo.ts` into owner stores. Move Identity's `licenses` writes behind `core/licensing`. One `auditStatement` builder plus `actorOf` replaces 8 helpers and 10 raw inserts. Absorbs ST-24's retention rule. 1.0–1.5 wk.                                                                                                                                                                                                                                                                                               | CQW-03                                                                 | no                                             |
| CQW-07      | Request-scoped product context, lazy signer, one host table                            | `loadProductContext` with lazy `signer()`; `signingKeyPem` leaves `Product`. Admin loads the product once per request. The resolver accepts loaded facts. Fix the `/me` N+1. One `hosts.ts` table replaces three hostname modules, with a uniform host-dispatch signature. 0.5–0.8 wk.                                                                                                                                                                                                                                                                                                                                                           | — (schedule in the CQW-03 window)                                      | no                                             |
| CQW-08      | Sunset one-time migration machinery                                                    | After the owner checklist: delete the settings backfill (Core, console runner and routes) and the override migration (state machine, routes and `platformOverrideMigration.tsx`). Export reports, then drop their tables in a replayable migration. Same for any accounts catch-up step that has finished. 0.4–0.6 wk.                                                                                                                                                                                                                                                                                                                           | owner steps (ST-01c run, U-03 run); CQW-03                             | no                                             |
| CQW-09      | One sealed credential store and resolver                                               | Merge `product_secrets`, `outlet_credentials` and `platform_credentials` (plus `platform_store_settings` meta) into one scoped store with one put/open/pin/version/record API. One `resolveCredential(kind, product)` answers product, then platform, then env with provenance, and the automatic-enable checks read it. Re-seal migration with dry run, a THREAT-MODEL update and a security review. 1.5–2.0 wk.                                                                                                                                                                                                                                | CQW-06; coordinate with the distribution/commerce audits; before CM-02 | yes (custody of sealed key material, not wire) |
| CQW-10      | Guardrails and test harness                                                            | `noUnusedLocals` / `noUnusedParameters` for the worker. An unused-export test with an allow-list for test-only exports. Delete the 14 dead exports. A new-file size budget (warn above 800 lines). A shared `test/adminWorld.ts` (session, CSRF, call helper) adopted by new tests, with old tests migrated opportunistically. Drop `makeEnv`'s unused parameter. Drop HA-12's `presentationInsert` hack once migration 0106 is everywhere. 0.4–0.6 wk.                                                                                                                                                                                          | —                                                                      | no                                             |

Rough total: 8.1–11.6 engineer-weeks of new work. It is offset by deferring ST-18 and ST-23 and
narrowing ST-15 and ST-16 (about 3.0–4.0 weeks removed), and ST-21 merging into CQW-04.

Suggested order:

1. CQW-10, CQW-01 and CQW-07 (small, early).
2. CQW-02.
3. The batch-boundary window for CQW-03.
4. CQW-04 and ST-05a in parallel.
5. CQW-05, CQW-06 and ST-05b.
6. The RBAC WP (from ST-22).
7. CQW-09 before CM-02.
8. CQW-08 whenever the owner steps complete.

## 11. Quick wins (each under a day, no dependencies)

1. Export `sha256Hex`, `sha256B64url` and a base64url pair from `core/platform.ts` now. New
   service code stops copying them; the cause of the duplication goes away before the sweep.
2. Replace the five `AdminBodyError` try/catch blocks with one catch around `handleAdminApi`'s
   routing (`admin/api.ts:458-476`).
3. Make 405 one helper that answers JSON `method_not_allowed` on the console and portal
   (122 `err(405, ErrorCode.BadRequest…)` sites are a mechanical rewrite).
4. Cap the portal `readBody` (64 KiB) and answer 400 on malformed JSON
   (`services/identity/portal/api.ts:172-184`). This is a small safety fix.
5. Load the product once in `admin/api.ts` `handleProductScoped`: reuse the `getProduct` row at
   `:108` and the `loadProduct` result, and remove `:169`.
6. `/me`: one `SELECT product, MAX(catalog_version)` instead of N `getActiveSchema` calls
   (`admin/handlers/me.ts:42-50`).
7. `core/keyEntries.ts:170`: read `identity.keyEntryRefusals` through the resolver like `:116`.
8. Delete the 14 dead exports (§2.9) and the duplicate `ConfirmLevel` (`core/platformSettings.ts:87`).
9. One `actorOf(session)` in `admin/audit.ts`, replacing three variants
   (`overrideMigration.ts:56`, `platformStoreConnections.ts:166`, `settingsBackfill.ts:46`) and
   eight inline literals.
10. Fix the stale doc comment "product admin (or platform) gates…"
    (`admin/handlers/products.ts:27-28`). No product admin exists.
11. Merge the three hostname modules into one `hosts.ts` table (≈190 → ≈60 lines).
12. Drop `GET /manage/api/summary` facts together with the owner's simplified product card
    (console change in the same PR).
13. Add the transitive half of the boundary test as a **report-only** test now (prints the
    reach), so CQW-03 has a measurable before and after.

## 12. Cross-domain dependencies

- **RBAC / identity audit**: the role model, role bindings (console-owned, OIDC group and claim
  mappings) and the account-backed admin principal come from there. This domain supplies CQW-04
  (the enforcement point), CQW-01 (the shared session token code) and the fate of
  `core.adminGroup` (delete, because manifest-declared admin grants are a privilege-escalation path
  from repo write access). Also: admin `/me` becomes the capabilities source for `useCan`.
- **Settings / console audit**: ST-05a/b, ST-07…ST-14 and ST-27 depend on the single write path
  and the areas manifest. The console client (`packages/admin/src/api.ts`, 5,673 lines of
  hand-mirrored types, defensive error parsing at `:4209-4245`) can be generated from CQW-04's
  table later. The Platform vs Product sidebar can key off the route `scope`.
- **Licensing audit**: `core/licensing/` as the single owner of `licenses`, `tiers`, keys, seats
  and grants (CQW-03/06); LX-08 to LX-16 sequencing; LX-16 retires `legacyDefault` and the fused
  `resolveEffective` payload. The owner's config flow (user > licence > config profile > defaults)
  lives in `core/payload.ts`, `merge.ts` and `core/accountOverrides.ts`, which is that audit's
  model and this domain's file layout.
- **Products / onboarding audit**: the `productStatus` contributor (CQW-05) is the backend for
  the product card, the Integration section, handshake detection and wizard checklists.
  `core.integration.dismissed` is a registry entry.
- **Distribution / commerce audits**: CQW-09's credential store and resolver are the
  prerequisite for "automatically enable a storefront or channel when credentials exist" and for
  CM-02's platform secrets. Naming: keep `outlet` internally for distribution channels, because
  "channel" already means release and update channels (stable/beta/dev). The UI label can say
  "Distribution channel". `admin/handlers/platformStoreConnections.ts` (962 lines) and
  `core/storefront/*` move with CQW-03.
- **Release audit**: five manifest-apply entry points (`services/release/{linkRepo,linkExisting,
resync}.ts`, `admin/systemProduct.ts`, `platformDeploy.ts`, about 5k lines) converge on ST-17's
  shared plan, which uses Core's claims (`core/settingsClaims.ts`) unchanged.
  `admin/handlers/feeds.ts` (cross-service yank) moves to a contributor in CQW-05.
- **Identity code quality**: `services/identity/oidc.ts` (3,258 lines; LX-08 adds about 300) and
  `portal/api.ts` (1,772 lines, its own respond helpers) should adopt CQW-02's respond module and
  CQW-04's route-table shape for the portal API.
- **SDK / wire**: none. Device error shapes and every signed document stay as they are; nothing
  here regenerates the corpus or bumps `PROTOCOL_VERSION`.
