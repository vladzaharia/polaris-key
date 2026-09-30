# Polaris Suite Services Implementation Plan

> **⚠️ THE NAMING LAYER IN THIS PLAN WAS INVERTED — DO NOT COPY NAMES FROM IT.**
> This plan specifies npm scope `@plrs/*`, PyPI dist `polaris-suite`, CLI bin `plrs`, and the
> manifest directory `.polaris/`. **Amendment A1 (2026-08-27) reverted every one of them.** What
> actually shipped is `@polaris-key/*`, PyPI `polaris-key`, bin **`pkey`**, and **`.pkey/`** —
> plus the whole `pkey` identifier family (`pkey_`, `pkeyt_`, `X-PKey-*`, `pkey-*+jws`,
> `PKEY_CONFIG_*`) and ISSUER `key.plrs.im`. In particular, **Task 8.2's grep-gates assert the
> opposite of what shipped**: they demand zero `@polaris-key/`, zero `X-PKey-`, zero `pkeyt_`,
> which are now the correct spellings. The architecture below (Core substrate, five opt-in
> services, `services_json`, wire v3, `PROTOCOL_VERSION` 3) landed as written; only the names
> flipped. **For final state read the sibling spec's closeout, not this plan:**
> `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` — "Amendment A1" and
> "Implementation closeout".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize Polaris Key into the Polaris suite — License/Config/Release/Update/Identity services over an always-on Core substrate — per the approved spec `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (all D-numbers below refer to its decision register).

**Architecture:** One Cloudflare Worker restructured into `core/` + `services/<slug>/` with a service registry and lint-enforced boundaries; wire contract v3 with per-service signed documents over a shared envelope; per-product opt-in via `products.services_json`; four SDKs re-shaped as core + service sub-clients; three offline depths; suite console. Pre-launch: wire breaks sanctioned, `PROTOCOL_VERSION → 3`, corpus v2, djdl re-seeded.

**Tech Stack:** Cloudflare Workers (workerd, D1, KV, DO), TypeScript ESM (plain `tsc`, pnpm + turbo), React 18, Python ≥3.9 (hatchling, httpx, cryptography), Swift 6 (SwiftPM, CryptoKit, Sparkle ≥ 2.6.4, since raised to 2.9.6), Ed25519 JWS (WebCrypto), conformance corpus.

**Naming (resolved external gates):** npm scope **`@plrs/*`** publishing to GitHub Packages (org `plrs` — availability verified 2026-08-26; creation is an external prerequisite before any publish, not before code). PyPI dist **`polaris-suite`**, import **`polaris`**, console script **`polaris`**. Swift package **`Polaris`**. Manifest CLI bin **`plrs`**.

---

## 0. Operating model

- **Orchestration:** Lead authors shared contracts (this plan's reference sections + P0); contract-consuming tasks fan out to parallel subagents on **disjoint files** (≤4–5 per wave); fan in with review subagents (code-reviewer, silent-failure-hunter for error paths, pr-test-analyzer for coverage); the green gate runs between waves. Subagent model: **Opus** for cross-cutting/crypto/gate/orchestrator work; **Sonnet** for mechanical moves, renames, per-view UI work.
- **Toolchain:** All JS tests/builds run under Node 22: `mise exec node@22 -- pnpm <cmd>` (system Node is 26; better-sqlite3 won't build there). Python: `cd sdks/python && .venv/bin/python -m pytest -q` (create venv with `python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"` if absent). Swift: `swift test --package-path sdks/swift` (needs Swift 6 toolchain; macOS 15 runner in CI).
- **Green gate (run at every phase boundary, and per-task where stated):**
  1. `mise exec node@22 -- pnpm -r build`
  2. `mise exec node@22 -- pnpm -r test`
  3. `mise exec node@22 -- pnpm gen:corpus -- --check` (drift gate)
  4. `cd sdks/python && .venv/bin/python -m pytest -q`
  5. `swift test --package-path sdks/swift`
- **Commits:** one commit per task minimum, message style matches repo history (imperative, no prefixes). Never delete a behavior-pin test to go green — re-baseline intentionally with the wire change that justifies it.
- **Phase DAG:** P0 → P1 → {P2, P3} (parallel) → P4 → P5 (React ∥ Python ∥ Swift) → P6 → P7 → P8. P2/P3 touch disjoint worker dirs after P1's extraction. P5's three language tracks are fully parallel.

---

## Reference sections

### R1. Route table (complete old → new)

Product-scoped (public wire). `<p>` = product slug. Aliases are permanent (D-07).

| Old                                      | New (canonical)                                                | Notes                                       |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- | ------- |
| `GET /<p>/.well-known/polaris.json`      | same                                                           | core; registry-assembled fragments (§P1.T6) |
| `GET /<p>/.well-known/jwks.json`         | same                                                           | core                                        |
| `GET /<p>/.well-known/polaris-trust.jws` | same                                                           | core                                        |
| —                                        | `POST /<p>/devices/register`                                   | **new**, core; registration policy (§P1.T5) |
| `GET/PATCH/DELETE /<p>/devices[/:id]`    | same                                                           | core (moves out of licensing.ts)            |
| `POST /<p>/config/report`                | `POST /<p>/devices/report`                                     | core telemetry; old path removed            |
| `POST /<p>/activate`                     | `POST /<p>/license/activate`                                   |                                             |
| `POST /<p>/enroll`                       | `POST /<p>/license/enroll`                                     |                                             |
| `POST /<p>/token`                        | `POST /<p>/license/token`                                      |                                             |
| `POST /<p>/deauthorize`                  | `POST /<p>/license/deauthorize`                                |                                             |
| `GET /<p>/config`                        | `GET /<p>/license/document` **and** `GET /<p>/config/document` | split documents (§P1.T4)                    |
| `GET /<p>/account`                       | _(removed)_                                                    | superseded by `/devices` + license document |
| `GET /<p>/schema`                        | `GET /<p>/config/schema`                                       |                                             |
| `GET/POST /<p>/mint/:id/token`           | `GET/POST /<p>/config/mint/:id/token`                          | D-19                                        |
| `GET /<p>/mint/:id/auth`                 | `GET /<p>/config/mint/:id/auth`                                | D-19                                        |
| `GET /<p>/session`                       | `GET /<p>/identity/session`                                    |                                             |
| `POST /<p>/session/license`              | `POST /<p>/identity/session/license`                           |                                             |
| `GET /<p>/auth/start`                    | `GET /<p>/identity/auth/start`                                 |                                             |
| `GET /<p>/auth/login`                    | _(removed)_                                                    | redundant alias of start                    |
| `POST /<p>/auth/logout`                  | `POST /<p>/identity/auth/logout`                               |                                             |
| `GET /<p>/auth/callback`                 | `GET /<p>/identity/auth/callback`                              |                                             |
| `GET /<p>/auth/poll`                     | `GET /<p>/identity/auth/poll`                                  |                                             |
| `POST /<p>/auth/device/start`            | `POST /<p>/identity/auth/device/start`                         |                                             |
| `GET+POST /<p>/auth/device/verify`       | `GET+POST /<p>/identity/auth/device/verify`                    |                                             |
| `POST /<p>/auth/device/poll`             | `POST /<p>/identity/auth/device/poll`                          |                                             |
| `GET /<p>/version`                       | `GET /<p>/update/version` + **alias** `/<p>/version`           |                                             |
| `GET /<p>/changelog`                     | `GET /<p>/release/changelog`                                   |                                             |
| `GET /<p>/install.sh`                    | `GET /<p>/release/install.sh` + **alias** `/<p>/install.sh`    |                                             |
| `GET /<p>/cli/:v/:bin-:arch`             | `GET /<p>/release/dl/:v/:bin-:arch`                            | `?checksum=sha256` kept                     |
| `GET /<p>/dmg/:v/:bin-:arch.dmg`         | `GET /<p>/release/dl/:v/:bin-:arch.dmg`                        |                                             |
| `GET /<p>/appcast.xml`                   | `GET /<p>/update/appcast.xml` + **alias** `/<p>/appcast.xml`   | gains `?arch=arm64                          | x86_64` |
| `GET /<p>/:channel/appcast.xml`          | `GET /<p>/update/:channel/appcast.xml` + **alias**             |                                             |

Platform/portal: `/manage/*`, `/webhooks/github`, root portal routes unchanged. Admin API regroups under `/manage/api/products/<slug>/…`:

| Old admin resource                                               | New                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `licenses[/…]`                                                   | `license/licenses[/…]`                                                             |
| `tiers[/…]`                                                      | `license/tiers[/…]`                                                                |
| `policy`, `policy/revert`                                        | `license/policy`, `license/policy/revert`                                          |
| `schema`                                                         | `config/catalog`                                                                   |
| `profiles[/…]`                                                   | `config/profiles[/…]`                                                              |
| `release/health`, `release/resync`                               | same (already service-shaped) + `release/releases` (truth store, P2)               |
| `portal`                                                         | `identity/portal`                                                                  |
| —                                                                | `update/settings` (access modes incl. `entitled`, compat window relocated) **new** |
| —                                                                | `services` (GET/PATCH), `services/revert` **new** (§P1.T7)                         |
| `keys/*` (signing), `secrets/*`, `activity`, product CRUD, `kek` | unchanged (core/platform)                                                          |
| —                                                                | `POST bundles` **new** (P6: offline bundle mint)                                   |

The admin dispatcher's 5-segment destructure cap (`admin/api.ts:113`) is removed — the new core router owns full-path dispatch (§P1.T2).

### R2. D1 & data

Migrations (one concern per file; at most one bare `ALTER` per file, per repo convention):

```sql
-- packages/worker/migrations/0019_services_json.sql
-- Per-product service enablement (spec §2.2). JSON: {"license":{"enabled":true},...}
ALTER TABLE products ADD COLUMN services_json TEXT;
```

```sql
-- packages/worker/migrations/0020_services_source.sql
-- Ownership marker for services_json: 'manifest' (resync may write) | 'admin' (operator-claimed).
ALTER TABLE products ADD COLUMN services_source TEXT;
```

Logical ownership is spec §5.2 verbatim. Release truth store (`release_metadata`/`release_artifacts`/`release_channels`/`release_health`) becomes resync-populated in P2; `release_download_tokens` redemption hardened same phase (R6-12). `release_config.metadata_access`/`artifacts_access` gain the value `'entitled'` (no DDL — TEXT columns; validation in code).

### R3. Package & naming map

| Old                                                                          | New                                                                                                        | Phase                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `@polaris-key/jws`                                                           | `@plrs/jws`                                                                                                | P0 sweep                                   |
| `@polaris-key/protocol`                                                      | `@plrs/protocol` (service-scoped modules + subpaths)                                                       | P0                                         |
| `@polaris-key/catalog`                                                       | `@plrs/catalog`                                                                                            | P0 sweep                                   |
| `@polaris-key/manifest`                                                      | `@plrs/manifest`                                                                                           | P0 sweep                                   |
| —                                                                            | `@plrs/client-core` (new, `packages/client-core`)                                                          | P0 skeleton, P4 complete                   |
| `@polaris-key/node`                                                          | `@plrs/node`                                                                                               | P0 sweep (rename), P4 (re-shape)           |
| `@polaris-key/react`                                                         | `@plrs/react`                                                                                              | P0 sweep (rename), P5 (re-shape)           |
| `@polaris-key/cli` (bin `pkey`)                                              | `@plrs/cli` (bin `plrs`)                                                                                   | P0 sweep (scope), P8 (bin)                 |
| `@polaris-key/{worker,admin,tools,products,conformance-node}`                | `@plrs/…`                                                                                                  | P0 sweep                                   |
| `sdks/python` dist `polaris-key`, import `polaris_key`                       | dist `polaris-suite`, import `polaris`, script `polaris`                                                   | P5                                         |
| Swift package `PolarisKey`                                                   | `Polaris` (targets `PolarisCore/PolarisLicense/PolarisConfig/PolarisUpdate/PolarisUI`, umbrella `Polaris`) | P5                                         |
| `pkey_`/`pkeyt_` prefixes, `X-PKey-*`, `iss key.plrs.im`                     | `plrs_`/`plrst_`, `X-Polaris-*`, `iss plrs.im`                                                             | P0 (protocol) / P1 (worker) / P4–P5 (SDKs) |
| `.pkey/` manifest dir                                                        | `.polaris/` preferred, `.pkey/` dual-read                                                                  | P1 (dual-read), P8 (docs)                  |
| Session tags `pkey.admin.v1\|` / `pkey.portal.v1\|`, cookies `__Host-pkey_*` | `plrs.admin.v1\|` / `plrs.portal.v1\|`, `__Host-plrs_*`                                                    | P1                                         |

### R4. Wire contract v3 — normative shapes (authored fully in P0.T3's doc; summarized here for type consistency)

```ts
// @plrs/protocol/core
export const PROTOCOL_VERSION = 3;
export const ISSUER = "plrs.im";
export type JwsTyp =
  | "plrs-license+jws"
  | "plrs-config+jws"
  | "plrs-trust+jws"
  | "plrs-bundle+jws";
export interface DocClaims {
  // shared envelope (spec §3.1)
  iss: string;
  aud: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  graceUntil: number;
}
export const HEADER_DEVICE = "X-Polaris-Device"; // + Version/Channel/SDK/SDK-Version/Platform/Arch
// @plrs/protocol/license
export interface LicenseDoc extends DocClaims {
  licenseId: string;
  profile?: DocProfile;
  entitlements: Record<string, JSONValue>; // channels, app.minVersion/maxVersion, deviceLimit, flags
}
export type LicenseStatus =
  | "ok"
  | "grace"
  | "expired"
  | "revoked"
  | "needs-activation"
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled"
  | "not-applicable";
// @plrs/protocol/config
export interface ConfigDoc extends DocClaims {
  schemaVersion: number;
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
}
// @plrs/protocol/core (bundle)
export interface BundleDoc {
  bundleId: string;
  aud: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  docs: { license?: string; config?: string }; // inner compact JWSs
  trust: string; // trust-manifest compact JWS
}
```

```ts
// @plrs/client-core gate (spec §3.3)
export type ActivationSource = "token" | "bundle";
export interface GateInput {
  licenseServiceEnabled: boolean; // false ⇒ status "not-applicable", isUsable true
  activation: ActivationSource | null; // replaces hasToken
  doc: LicenseDoc | null;
  now: number;
  highWaterMark?: number;
  lastSyncUnauthorized?: boolean;
  blocked?: BlockedState | null;
  lastVerifiedAt?: number | null;
}
// cache v3 (core-owned, per-service slices; signed artifacts only + tighten-only hints)
export const CACHE_VERSION = 3;
export interface CacheRecordV3 {
  v: 3;
  trustJws?: string;
  docs?: { license?: string; config?: string };
  etags?: { license?: string; config?: string };
  importedBundle?: { bundleId: string; importedAt: number };
  lastSyncUnauthorized?: boolean;
  blocked?: { reason: BlockReason; allowedRange?: AllowedRange };
}
```

New endpoint shapes:

```
POST /<p>/devices/register            (core; keyless; rate-limited bucket "register")
  → 200 {"token":"plrst_…","deviceId":"…"}
  → 403 {"error":{"code":"registration_closed"}}     (policy requires-license/requires-identity unmet)
  → 404 not-configured                                (product absent)
GET /<p>/license/document             (auth: plrst_ bearer; ETag/304; build gate here)
  → 200 application/jwt (plrs-license+jws)
  → 403 {"error":{"code":"version_blocked"|"channel_not_allowed"},"allowedRange":{…}}
GET /<p>/config/document              (auth: plrst_ bearer; ETag/304; device auth only)
  → 200 application/jwt (plrs-config+jws)
POST /<p>/devices/report              (auth: plrst_ bearer; body = DeviceFacts + optional per-service snapshots)
GET/PATCH /manage/api/products/<slug>/services  → {"services":{…},"source":"manifest"|"admin"}
POST     /manage/api/products/<slug>/services/revert → returns control to manifest
POST /manage/api/products/<slug>/bundles   {deviceId, graceDays≤365, includeConfig?:bool}
  → 200 {"bundleId":"…","bundle":"<plrs-bundle+jws>"}
```

### R5. Corpus v2

`conformance/corpus/v2/` emitted by the extended `tools/sign-corpus.ts`: `cases.json` (`corpusVersion: 2`) with sections `jwsCases` (v1's 34 carried, typs renamed), `licenseDocCases`, `configDocCases`, `trustCases` (carried), `clockFloorCases` (multi-doc: floor = max over license doc, config doc, trust manifest), `bundleCases` (valid; tampered inner doc; wrong deviceId; expired bundle; pinned-substitution in inner trust); plus `gate-matrix.json` v2 (adds `not-applicable` and `activation:"bundle"` rows) and `fingerprint.json` (unchanged content, copied for single-dir consumption). Swift mirror copies under `sdks/swift/Tests/PolarisKeyTests/Resources/` (renamed with the target in P5). v1 stays until P5 lands all runners; deleted in P8.

---

## P0 — Contracts (Lead-authored; sequential)

### Task 0.1: Toolchain gate & baseline

**Files:** none (verification only)

- [ ] Run `mise exec node@22 -- pnpm install --frozen-lockfile` then the full green gate (§0). Record baseline pass. If Python venv missing: `cd sdks/python && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"`.
- [ ] Expected: all five gate commands pass at HEAD (`9f08401`). Any pre-existing failure is fixed or documented before proceeding.

### Task 0.2: `@plrs/*` scope sweep (mechanical)

**Files:** every `packages/*/package.json`, `conformance/runners/node/package.json`, `tools/package.json`, `products/package.json`, all import specifiers `@polaris-key/…` repo-wide, `.changeset/config.json`, `.github/workflows/{ci,release}.yml` registry lines.

- [ ] Rename all workspace package names `@polaris-key/X` → `@plrs/X` and update every `from "@polaris-key/…"` import (grep-driven; ~35 consumer files per the research inventory). No behavior change.
- [ ] Green gate 1–3 (JS only — Python/Swift untouched). Commit: `Rename the workspace scope to @plrs`.

### Task 0.3: WIRE-CONTRACT-V3.md

**Files:** Create `docs/security/WIRE-CONTRACT-V3.md`; Modify `docs/security/WIRE-CONTRACT-V2.md` (add superseded banner pointing at v3).

- [ ] Author the full normative doc: §1 trust (v2 semantics unchanged), §2 envelope claims (R4), §3 per-document claim validation (license/config; `checkFreshness` network-vs-reload split per doc), §4 cache v3 + monotonic floor over all artifacts + Core-owned trust schedule, §5 ETag/304 + half-life refetch per doc, §6 device registration policy + `plrst_` tokens, §7 offline bundles (mint, import, verify-before-write, `activationSource`), §8 identifier rebrand table, §9 rollout (corpus v2, discard-not-migrate cache v2→v3), §10 divergence table seeded from v2 §6. Every claim in R4 above appears verbatim.
- [ ] Commit: `Specify wire contract v3`.

### Task 0.4: Protocol package re-org

**Files:** Modify `packages/shared-protocol/src/index.ts` → split into `src/{core,license,config,release,update,identity,trust}.ts` + barrel `src/index.ts`; `packages/shared-protocol/package.json` (subpath exports `./core ./license ./config ./release ./update ./identity ./trust`); Test `packages/shared-protocol/test/exports.test.ts` (new).

- [ ] Move types per R4's module map (fingerprint/device-facts types → `core.ts` as Device-principal contracts; `LicenseStatus`+gate types → `license.ts`; `ReleaseAccess` gains `"entitled"` → `release.ts`). Add `PROTOCOL_VERSION = 3`, `ISSUER = "plrs.im"`, `X-Polaris-*` header constants, `DocClaims`, `LicenseDoc`, `ConfigDoc`, `BundleDoc`, new `JwsTyp` values, `LicenseStatus` += `"not-applicable"`. Barrel keeps ALL old names exported (old `ManagedConfigDoc` retained alongside — the worker still serves it until P1) so the repo stays green.
- [ ] Write `exports.test.ts`: imports from each subpath resolve; `PROTOCOL_VERSION === 3`; `ISSUER === "plrs.im"`; barrel re-exports the union. Run `mise exec node@22 -- pnpm --filter @plrs/protocol test` → PASS. Green gate 1–2. Commit: `Reorganize the protocol package by service and define wire v3 types`.

### Task 0.5: `@plrs/client-core` skeleton

**Files:** Create `packages/client-core/{package.json,tsconfig.json,tsconfig.build.json}`, `src/{verify,trust,gate,config,semver,claims,clock,errors,store,index}.ts`; Test `packages/client-core/test/{gate.test.ts,parity.test.ts}`.

- [ ] Package: `@plrs/client-core`, ESM, plain `tsc`, deps `@plrs/jws` + `@plrs/protocol`, `sideEffects: false`, subpath exports mirroring the module list. Contents at this phase: **move** (copy + re-export) sdk-node's pure modules — `gate.ts` (with the new `GateInput`/`not-applicable` semantics from R4), `config.ts` (resolution), `semver.ts`, `claims.ts`, `verify.ts`/`trust.ts` (over `@plrs/jws`), new `clock.ts` (`highWaterMark` fold over artifact set), `errors.ts` (`PolarisError` with `PolarisErrorCode`), `store.ts` (types only: `Store` iface, `CacheRecordV3`). No I/O, no Node APIs — isomorphic (WebCrypto only), so React can consume it.
- [ ] `gate.test.ts`: port sdk-node's gate tests + new cases — `not-applicable` when `licenseServiceEnabled:false` (isUsable true); `activation:"bundle"` treated as activated; floor math (`now = max(now, highWaterMark)`). `parity.test.ts`: drives `conformance/corpus/v1/gate-matrix.json` (still v1 here) through the new gate with a `licenseServiceEnabled:true` + `activation:"token"` shim proving byte-parity with the old semantics. Run → PASS. sdk-node/sdk-react keep their own copies until P4/P5 (no consumer flip yet). Green gate. Commit: `Add the isomorphic client-core package`.

### Task 0.6: Corpus v2 generator + vectors

**Files:** Modify `tools/sign-corpus.ts`; Create `conformance/corpus/v2/{cases.json,gate-matrix.json,fingerprint.json}` (generated); Modify `.github/workflows/ci.yml` (drift gate covers v2); Test: `conformance/runners/node/corpusV2.test.ts` (new, drives v2 through `@plrs/client-core`).

- [ ] Extend the generator per R5 (new typs signed with the committed test keys; license/config doc cases mirror v1's docCases split per document; bundleCases as listed; multi-doc clockFloorCases incl. `floor-config-doc-alone-does-not-stop-rollback` carried and a new `floor-max-over-three-artifacts`). Emit v2 alongside v1; `--check` reconciles both.
- [ ] `corpusV2.test.ts` runs every v2 section through client-core (`verifyJws`/`verifyDoc` per typ/`verifyTrustManifest`/gate). Run → PASS. `pnpm gen:corpus -- --check` → clean. Commit: `Generate conformance corpus v2 for wire contract v3`.

### Task 0.7: Service enablement authority

**Files:** Create `packages/worker/migrations/0019_services_json.sql`, `0020_services_source.sql` (R2 verbatim), `packages/worker/src/core/services.ts`; Modify `packages/shared-manifest/src/index.ts` (carry `enabledModules` into `ParsedManifest` as `services`), `packages/worker/src/repo.ts` (`ProductRow` + row mapping), `packages/worker/src/release/linkRepo.ts` + `resync.ts` (persist with source semantics), `packages/worker/src/product.ts` (`Product.services`); Tests `packages/worker/test/services.test.ts`, `packages/shared-manifest/src/index.test.ts` (extend).

- [ ] `core/services.ts`:

```ts
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "update"
  | "identity";
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "update",
  "identity",
];
export type ServicesMap = Record<ServiceSlug, { enabled: boolean }>;
export const DEFAULT_SERVICES: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};
export function parseServices(json: string | null): ServicesMap; // strict; unknown keys rejected; null ⇒ DEFAULT
export function validateServices(s: ServicesMap): string[]; // "update requires release", …
```

- [ ] Manifest: map old module names (`licensing→license`, `releases→release`+`update` when a release block exists, `oidc→identity`, `edgeMint` folds into config) and accept new names directly; `parseManifest` returns `services: ServicesMap`; validation errors per spec §2.2 (upgrade `config_without_activation` to error when registration policy is `requires-license`; new `update_requires_release`). Manifest gains `devices.registration` (`open|requires-identity|requires-license`, default derived per spec §2.3).
- [ ] Persistence: `linkRepo` writes `services_json` (+`services_source='manifest'`) in the atomic batch; `resync` updates only when `services_source='manifest'`; admin claim/revert lands in P1.T7. `loadProduct` exposes `services` (parsed, defaulted).
- [ ] Tests: parse/default/validate matrix; old-name mapping; resync-respects-admin-ownership; linkRepo persists. Run worker + manifest suites → PASS. Green gate. Commit: `Persist per-product service enablement as the single authority`.

### Task 0.8: Service registry skeleton + boundary lint

**Files:** Create `packages/worker/src/core/registry.ts`, `packages/worker/eslint.boundaries.mjs` (flat-config fragment wired into the existing lint setup); Test `packages/worker/test/registry.test.ts`.

- [ ] `registry.ts`:

```ts
import type { ServiceSlug, ServicesMap } from "./services";
export interface ServiceContext {
  req: Request;
  env: Env;
  product: Product;
  rest: string[];
}
export interface ServiceDescriptor {
  slug: ServiceSlug;
  handle(ctx: ServiceContext): Promise<Response | null>; // null = no route match within service
  discoveryFragment(
    product: Product,
    env: Env,
  ): Promise<Record<string, unknown>>;
  adminHandle?(
    ctx: ServiceContext & { session: AdminSession },
  ): Promise<Response | null>;
  manifestIngest?(
    parsed: ParsedManifest,
    product: string,
  ): D1PreparedStatement[];
}
export function dispatchService(
  registry: Map<ServiceSlug, ServiceDescriptor>,
  slug: ServiceSlug,
  services: ServicesMap,
  ctx: ServiceContext,
): Promise<Response>;
// disabled ⇒ 404 {"error":{"code":"not_found"}} (hide-don't-reveal); enabled ⇒ descriptor.handle, 404 on null
```

- [ ] Lint zones: `services/<x>/**` may import `core/**`, own dir, `@plrs/*` shared packages; sole cross-service exception `services/update → services/release`. Registry test: disabled service 404s; enabled dispatches; unknown slug 404s. Run → PASS. Commit: `Add the service registry and boundary lint`.

**P0 exit:** green gate; corpus v2 exists; wire v3 doc merged; enablement authority live (not yet consumed by routes — that's P1).

---

## P1 — Worker core & services (Lead: router + document split contracts; fan-out: per-service moves)

### Task 1.1: Core extraction

**Files:** Create `packages/worker/src/core/{products.ts,devices.ts,trust.ts,signing.ts,discovery.ts,rateLimit.ts,errors.ts,audit.ts}` (moves of `product.ts`, device parts of `licensing.ts`+`licenseCore.ts` (`validateDeviceToken`, token mint/purge, device CRUD, fingerprints, facts), `jwks.ts`, `configDoc.ts` signing half, `discovery.ts`, `rateLimit.ts`+`rateLimitDo.ts` wiring, `http.ts` error helpers, audit writers); Modify all importers.

- [ ] Mechanical relocation with import updates; no behavior change; every existing worker test stays green unmodified. Commit per sub-move (`Move device authority into core`, …).

### Task 1.2: Core router v2

**Files:** Rewrite `packages/worker/src/router.ts` (`matchRoute` → core route table + service-slug extraction + alias map from R1); Modify `packages/worker/src/index.ts` (dispatch via registry; remove the 27-branch switch); Delete the 5-segment cap in `admin/api.ts` (full-path arrays flow to `adminHandle`); Tests: rewrite `packages/worker/test/router.test.ts` from R1 (every row: old removed paths 404, new paths dispatch, aliases dispatch to their service).

- [ ] Route match order preserved (reserved namespaces before `/<p>/…`). Aliases: `/appcast.xml`, `/:channel/appcast.xml`, `/install.sh`, `/version` map to update/release with a marker so handlers emit identical bytes. Run router tests → PASS. Commit: `Mount services through the core router`.

### Task 1.3: License service module

**Files:** Create `packages/worker/src/services/license/{index.ts,routes.ts,activation.ts,document.ts,tiers.ts,policy.ts,admin.ts}` (moves of `licensing.ts` activate/enroll/token/deauthorize, `enroll.ts`, `gate.ts` build-gate call site, `licenseCore.ts` license half, admin `licenses.ts`/`keys.ts`/`devices.ts`(license-scoped)/`tiers.ts`/policy handlers); descriptor registered.

- [ ] `document.ts`: serve `GET /license/document` — `plrs-license+jws` per R4 (entitlements via `injectAdminPolicy`, build gate enforced here: 403 + `allowedRange`). ETag + 304 + half-life rule per doc.
- [ ] Tests: port `/config`-era licensing tests to `/license/*`; document claim tests against wire v3 (verify with client-core in-test); build-gate 403 shape. Commit: `Carve the license service`.

### Task 1.4: Config service module

**Files:** Create `packages/worker/src/services/config/{index.ts,routes.ts,document.ts,catalog.ts,profiles.ts,mint.ts,admin.ts}` (moves of `schema.ts`, `configDoc.ts` assembly, admin `schema.ts`/`profiles.ts`, `edgeMint.ts` → `mint.ts` with `/config/mint/:id/*` paths).

- [ ] `document.ts`: `GET /config/document` — `plrs-config+jws` (config+secrets+schemaVersion; device auth only, no build gate). Merge pipeline (`resolveEffective`) splits: license-owned entitlements injection stays in license/document; config/document carries only config/secrets. Tests: document shape; config-only product (license disabled, registered device) gets a config doc — **the wire-level proof of D-08**. Commit: `Carve the config service and split the signed documents`.

### Task 1.5: Device registration + policy

**Files:** Create `packages/worker/src/core/register.ts`; Modify `core/devices.ts` (mint for registration), manifest (`devices.registration` — done P0.T7), `core/services.ts` (policy read); Test `packages/worker/test/register.test.ts`.

- [ ] `POST /<p>/devices/register` per R4 shapes; policy: `open` mints immediately (rate-limited, fingerprint optional); `requires-identity` requires a valid identity session (checked via identity descriptor once P3 lands — until then products can't set it, validation enforces); `requires-license` → 403 `registration_closed` (activation is the mint path). Token prefix `plrst_` (mint path in `kv.ts` + `licenseCore` updated; old `pkeyt_` rejected — pre-launch). `POST /devices/report` relocates `handleReport`. Tests: policy matrix, prefix, report round-trip. Commit: `Add the universal device principal`.

### Task 1.6: Discovery v2 + identifier rebrand server-side

**Files:** Modify `core/discovery.ts` (registry-assembled fragments, honest `enabled` per `services_json`), `shared-protocol` consumers for `X-Polaris-*` (worker reads both old/new headers? No — pre-launch: new only), `admin/session.ts` + `portal/session.ts` (domain tags `plrs.admin.v1|`/`plrs.portal.v1|`, cookies `__Host-plrs_*`), webhook `.polaris/` dual-read (`PKEY_FILES` → prefer `.polaris/*`, fall back `.pkey/*`).

- [ ] Discovery test: disabled service ⇒ fragment `{enabled:false}` only; enabled ⇒ endpoints per service. Header/cookie tests updated. Commit: `Assemble discovery from service fragments and rebrand wire identifiers`.

### Task 1.7: Services admin endpoint + e2e re-baseline + djdl re-seed

**Files:** Create `packages/worker/src/core/servicesAdmin.ts` (`GET/PATCH …/services`, `POST …/services/revert` per R4; PATCH validates via `validateServices`, sets `services_source='admin'`); Modify `products/djdl/product.json` (add `modules` block with new slugs + `devices.registration`), regenerate seed; Rewrite `packages/worker/test/e2e.test.ts` against the v3 flow (register/activate → license+config documents → offline reload via client-core).

- [ ] Green gate (worker suite fully green on v3; sdk suites still green on their v1 copies — they don't hit the worker). Commit: `Expose service enablement to admins and re-seed djdl`.

**P1 exit:** worker serves wire v3 only; all worker tests green; SDK packages unchanged (their unit suites don't require the worker).

---

## P2 — Release/Update split (parallel with P3; fan-out)

### Task 2.1: Split `release/` into two services

**Files:** Create `services/release/{index.ts,routes.ts,sync.ts,channels.ts,assets.ts,changelog.ts,install.ts,store.ts,admin.ts}` and `services/update/{index.ts,routes.ts,appcast.ts,version.ts,eligibility.ts,admin.ts}` (moves from `src/release/*` per D-05: appcast+version+eligibility → update; the rest → release); registry + `update→release` import (the sanctioned edge).

- [ ] Route tests per R1 (canonical + aliases byte-identical). Commit: `Split release truth from update feed`.

### Task 2.2: Release truth store ingestion + R6-12 fix

**Files:** Modify `services/release/sync.ts` (resync populates `release_metadata`/`release_artifacts`/`release_channels`/`release_health` from the GitHub release list + assets in the same pass), `services/release/store.ts` (typed readers), `portal/api.ts` + `portal/repo.ts` (releases view reads the store), `portal` download-token redemption (single-use atomic claim via `UPDATE … WHERE used_at IS NULL` returning-row check; `source_url` host allowlist = the existing `isAllowedStorageHost`; stream through the gateway instead of 302 when host is not allowlisted).

- [ ] Tests: resync populates rows; portal lists from store; token double-spend rejected; disallowed `source_url` never redirected. Commit: `Populate the release truth store and close R6-12`.

### Task 2.3: Entitled access mode + update settings

**Files:** Modify `services/update/eligibility.ts` (new), `services/release/index.ts` access enforcement (`'entitled'`: `validateDeviceToken` → load license entitlements → channel ∈ entitled set + version window over the selector), `services/update/admin.ts` (`update/settings`: access modes + compat window relocated from product PATCH); Tests: entitled matrix (stable-only license × beta feed ⇒ 403 `channel_not_allowed`; entitled ⇒ 200), public default unchanged.

- [ ] Commit: `Add the entitled feed access mode`.

### Task 2.4: Appcast per-arch + release notes + CDATA fix

**Files:** Modify `services/update/appcast.ts` (`?arch=arm64|x86_64` param + arch-specific enclosure selection via the existing `ReleaseParams.arch` plumbing; `descriptionHtml` from changelog summaries + `minimumSystemVersion` wired into `buildAppcastItem`; CDATA `]]>` split-neutralization in `renderItem`).

- [ ] Tests: x86_64 feed serves the x86 DMG; `]]>` payload in release notes renders inert (snapshot); arm64 default preserved. Commit: `Serve per-arch appcasts with sanitized release notes`.

---

## P3 — Identity carve (parallel with P2; Sonnet-mechanical + Opus review)

### Task 3.1: Move + renamespace

**Files:** Create `services/identity/{index.ts,routes.ts,oidc.ts,browserSession.ts,portal/,admin.ts}` (moves of `oidc.ts`, `browserSession.ts`, `portal/*`, admin portal-settings handler); routes per R1 (`/identity/*`; `/auth/login` alias dropped; session routes moved); `requires-identity` registration exchange lands here (`identity` session → `POST /devices/register` accepted).

- [ ] All identity/portal/browser-session tests re-pathed and green; registration policy matrix test extended. Commit: `Carve the identity service`.

---

## P4 — JS client-core completion + Node SDK re-shape (Lead: sub-client contracts; then fan-out)

### Task 4.1: client-core completion

**Files:** Modify `packages/client-core/src/*` — absorb final gate/config/verify semantics as the single implementation; add `bundle.ts` (`verifyBundle(jws, pins, now)` → verified inner docs, all-or-nothing); conformance runner re-attribution (`conformance/runners/node/*` imports move to `@plrs/client-core`; corpusV2 primary, v1 runner retired here).

- [ ] Commit: `Complete client-core and re-attribute the conformance runners`.

### Task 4.2: Node SDK re-shape

**Files:** Rewrite `packages/sdk-node/src/` → `core/{context,trust,cache,token,sync,telemetry}.ts`, `license/{client,endpoints}.ts`, `config/{client,fetch}.ts`, `devices/client.ts`, `release/client.ts` (version/changelog), `update/client.ts` (appcast URL + version check), `local/index.ts` (transportless mode), `client.ts` (`PolarisClient` facade + `onLicenseAcquired` event → `core.sync()`), `cli/*` (per-service commands); `package.json` subpath exports (`./core ./license ./config ./devices ./release ./update ./local ./cli`); store v3; `plrst_`/`X-Polaris-*`; per-service option bags over `CoreOptions` (pins in core).

- Decomposition follows the research seam map §6.3 (CoreContext/TrustManager/CacheManager/TokenManager/modules); `refresh()` semantics: core `sync()` = trust → enabled-doc fetches (parallel) → verify → cache patch → floor → report; 401 single re-acquire preserved; activation event replaces the hard call.

- [ ] Tests: port the full sdk-node suite to the new shape (offline init, 401-once, ETag/304, deactivate-offline, R2/R4 attack suites against cache v3); new: config-only product flow (register→config doc, gate `not-applicable`); `getSyncState()` exposes `{activation, doc, lastSyncUnauthorized, blocked, lastVerifiedAt, highWaterMark}` (the bridge contract gap). Worker e2e re-run. Green gate. Commit per module wave.

---

## P5 — SDK fan-out (three parallel tracks; Opus for Swift/React orchestrators, Sonnet for mechanical ports)

### Task 5.R: React

**Files:** `packages/sdk-react` — consume `@plrs/client-core` (delete `core/gateModel.ts` port); subpath exports `./license ./config ./identity ./update` + `"sideEffects": false`; `capabilities: Record<ServiceSlug,{enabled:boolean}>` on state (discovery-driven, fail-closed per D-21, configured-expectation fallback via a provider `expectServices` prop); per-service `busy`/`error` maps; primitives extraction (`src/components/primitives/{MessageScreen,buttons,card,input}.tsx` — `MessageScreen` promoted with its a11y contract); theme vars to `:root` injection; bridge v2 (`BridgeState` + `highWaterMark` + `capabilities`; `invoke(service,method,args)`); new `ConfigPanel`, `UpdatePrompt`, `DeviceManager` components; peer `react >=18`; parity/a11y suites re-baselined; gate-matrix runner → corpus v2.

### Task 5.P: Python

**Files:** `sdks/python` — `pyproject.toml` (name `polaris-suite`, packages `src/polaris`, script `polaris`); split `src/polaris/{core,license,config,release,update,identity}/` mirroring Node's shape; parity fixes: base-URL scheme guard (raise on non-https/non-loopback), `request_timeout` option applied to every call incl. injected clients, real `/devices` endpoints, `discovery.py`; wire v3 (typs, headers, `plrst_`, ISSUER); cache v3; corpus v2 paths; `test_wire_contract_v2.py` → `test_wire_contract_v3.py` re-baselined case-by-case.

### Task 5.S: Swift

**Files:** `sdks/swift` — `Package.swift` v2: name `Polaris`; targets `PolarisCore` (Base64URL/JSONValue/Models(v3)/JWSVerifier/Trust/Semver/DeviceID/Fingerprint/KeychainStore/`PolarisTransport` protocol + `URLSessionTransport`/`MonotonicClock`/Discovery), `PolarisLicense` (Gate(v3 incl. not-applicable/bundle)/Endpoints/LicenseClient), `PolarisConfig` (Fetch/ConfigClient/Facts), `PolarisUpdate` (macOS-only, Sparkle `from: "2.6.4"` (since raised to `"2.9.6"`) platform-conditioned; feed URL from discovery; entitled auth via `SPUUpdater.httpHeaders`; `SUPublicEDKey` presence assertion), `PolarisUI` (login/gate views re-pointed), umbrella `Polaris` (`@_exported import` Core+License+Config); `refreshTrust` moves out of the client actor into Core behind the transport; HTTPS guard; keychain service tag `plrs:<product>`; corpus v2 mirror + tests re-pathed.

- [ ] Each track: full language suite green + corpus v2 green before fan-in review. Green gate closes P5.

---

## P6 — Offline (Lead: bundle contract already in R4; fan-out per SDK)

### Task 6.1: Bundle mint (worker + console + CLI)

**Files:** Create `packages/worker/src/core/bundles.ts` (`POST …/bundles` per R4: signs license doc (+config doc if enabled & requested) bound to the given `deviceId` with `graceUntil = issuedAt + graceDays*86400` (≤365), wraps with current trust manifest as `plrs-bundle+jws`); console: `packages/admin/src/views/licenses/OfflineBundleDialog.tsx` (license detail action: enter request code → download `.plrsbundle`); CLI: `plrs bundle` verb hitting the admin API.

- [ ] Tests: mint shape verifies via client-core `verifyBundle`; grace cap enforced (366 ⇒ 400); audit row written. Commit: `Mint offline activation bundles`.

### Task 6.2: importBundle across SDKs (three parallel subagents)

**Files:** `sdk-node/src/core/bundle.ts` (`importBundle(jws)` — client-core `verifyBundle` → atomic cache write → `activation:"bundle"`), Python `polaris/core/bundle.py`, Swift `PolarisCore/Bundle.swift`; per-SDK tests from `bundleCases` (tampered/wrong-device/expired ⇒ no write; valid ⇒ offline `status()==="ok"` with zero network).

### Task 6.3: Local-only profiles

**Files:** `sdk-node` `./local` entry (no fetch impl; construct from bundle or config-only), Python `polaris.local`, Swift docs + `NoNetworkTransport`; per-SDK test: local mode makes zero network calls (exploding-fetch harness), config resolves `local>env>fallback`, updates absent.

- [ ] Green gate closes P6. Commit per SDK.

---

## P7 — Console (fan-out per section; Sonnet)

### Task 7.1: Suite shell

**Files:** Modify `packages/admin/src/route.ts` (`Tab` → service-grouped union + per-product filter fn), `src/components/Shell.tsx` (nav sections from `services_json` via extended `productView`; `data-service` attribute per section: license→`key`, identity→`id`, config/release/update/core as new tokens), `src/api.ts` (services endpoints + import shared `ConfigEntry` types from `@plrs/catalog`, deleting the local re-declarations), `src/views/Settings.tsx` dissolution (PortalCard→Identity/Release sections, compat→Update settings view, KeyCard/DangerCard stay platform), new `src/views/services/ServicesCard.tsx` (enable/disable + revert with `update requires release` guardrails), `src/views/FingerprintPolicy.tsx` (surface the orphaned API under License).

### Task 7.2: Section views + portal repoint

**Files:** Releases view reads truth store; new Update settings view (access modes incl. `entitled`, compat window); portal capabilities/downloads already repointed in P2 — verify + nav gating parity test. Console smoke: `mise exec node@22 -- pnpm --filter @plrs/admin build` + vitest suite.

---

## P8 — Finalization

### Task 8.1: Rebrand completion

**Files:** `packages/cli` bin `pkey`→`plrs` (keep `pkey` as a deprecation shim printing the rename? No — pre-launch: rename outright); `.polaris/` becomes the documented dir (dual-read stays); `plrs init` scaffolds `.polaris/`; delete protocol barrel's legacy v2 names + `conformance/corpus/v1` + old gate copies; docs sweep (`README`, `docs/CONCEPTS.md`, `docs/ADOPTER-GUIDE.md` — Sparkle section documents `PolarisUpdate` + entitled mode, `docs/CONFIG-AUTHORING.md`, `products/README.md`, `CONTRIBUTING.md` matrix).

### Task 8.2: Exit gates

- [ ] Full green gate; `gen:corpus -- --check`; grep-gates: zero `@polaris-key/`, zero `X-PKey-`, zero `pkeyt_`, zero `key.plrs.im` as ISSUER (host references in wrangler/docs stay), zero imports of deleted legacy modules; risk-register closeout appended to the spec; memory + `docs/security/2026-08-26-security-audit.md` residual-risk note updated (clock-floor text was already stale — correct it).
- [ ] Final commit: `Complete the Polaris suite re-organization`.

---

## Verification map (spec §→ tasks)

| Spec section                             | Tasks                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| §2 service model / enablement            | 0.7, 0.8, 1.6, 1.7                                                                 |
| §3 wire v3 (docs, gate, floor, cache)    | 0.3–0.6, 1.3–1.5, 4.1–4.2                                                          |
| §4 API surface / aliases / admin regroup | 1.2–1.7, 2.1, 3.1, R1                                                              |
| §5 topology / data / truth store / R6-12 | 1.1, 0.8 (lint), 2.2, R2                                                           |
| §6 SDKs                                  | 0.5, 4.1–4.2, 5.R/5.P/5.S                                                          |
| §7 offline                               | 6.1–6.3, corpus bundleCases (0.6)                                                  |
| §8 console/portal                        | 7.1–7.2                                                                            |
| §9 rebrand/external gates                | 0.2, 1.6, 5.P/5.S, 8.1; org creation = user-side prerequisite before first publish |
| §10 phasing/risks                        | this plan's DAG + phase exit gates                                                 |
