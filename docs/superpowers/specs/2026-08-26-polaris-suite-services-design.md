# Polaris Suite Services — Design

**Date:** 2026-08-26
**Status:** Approved (design); implementation plan pending.
**Supersedes:** the "Polaris Core suite re-org" brainstorm (interrupted 2026-08-26, worktree `lethal-walrus`); its 12 answered decisions are incorporated below.
**Relates to:** `docs/security/WIRE-CONTRACT-V2.md` (superseded by v3 defined here), the brand-package rollout (a separate plan, sequenced after this work; its D4 is amended by D-17 below).

Polaris Key becomes **Polaris**: a suite of per-product opt-in services — **License, Config, Release, Update, Identity** — over an always-on **Core** substrate. Applications integrate one or more services without entangling the rest, including fully offline/local-only operation. Pre-launch posture applies throughout: wire breaks are sanctioned via a `PROTOCOL_VERSION` bump, corpus regeneration, D1 reshaping, and djdl re-seeding. Nothing has ever been released (no git tags, all packages 0.0.0).

---

## 1. Decision register

Locked decisions. Sources: **[P]** = prior brainstorm session (answers recovered from transcript), **[S]** = this session's question rounds, **[L]** = Lead synthesis approved in section review.

| #          | Decision           | Choice                                                                                                                                                                                |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 [P]   | Decoupling depth   | Full Core substrate extraction: product registry, Device principal (registration/tokens/list/fingerprints), trust & signing, discovery, rate limiting, errors, audit                  |
| D-02 [P]   | Topology           | One Cloudflare Worker; `src/core/` + `src/services/<slug>/`; service registry; lint-enforced boundaries. Split-ready, not split                                                       |
| D-03 [P+L] | Naming             | Suite = **Polaris**; substrate = **Core** (not opt-in). License keeps brand `key`; Identity is brand `id`. Packages `@polaris/*`                                                      |
| D-04 [S]   | Service slugs      | `license`, `config`, `release`, `update`, `identity` (singular; used for routes, dirs, sub-clients, `data-service`)                                                                   |
| D-05 [P]   | Release vs Update  | Release = truth (sync, channels, artifacts, changelog, install). Update = feed (appcast, `/version`, eligibility). `update → release` is the only sanctioned cross-service dependency |
| D-06 [P]   | Auth principal     | Core owns Device: keyless `POST /<p>/devices/register` governed by per-product registration policy (`open` \| `requires-identity` \| `requires-license`)                              |
| D-07 [P]   | Route shape        | Service-namespaced product routes + Core non-service paths (`/.well-known/*`, `/devices/*`) + conventional aliases for external tooling                                               |
| D-08 [S]   | Wire shape         | **Per-service signed documents** over a shared envelope; Core owns verify/cache/trust/clock-floor; signed offline bundle for air-gap                                                  |
| D-09 [S]   | ISSUER             | `plrs.im` (host-neutral). Host stays `key.plrs.im` [P]                                                                                                                                |
| D-10 [P]   | Identifier rebrand | `pkey_`→`plrs_`, `pkeyt_`→`plrst_`, `X-PKey-*`→`X-Polaris-*`, `.pkey/`→`.polaris/`                                                                                                    |
| D-11 [P]   | SDK shape          | One package per language; Core + service sub-clients (`client.license`, `client.config`, …); subpath exports for tree-shaking (Node/React)                                            |
| D-12 [S]   | Offline depth      | All three: offline-tolerant grace; air-gapped activation (out-of-band signed bundles); local-only build profile. Consciously unlocks the old "offline activation OUT" exclusion       |
| D-13 [S]   | Update gating      | Per-product **`entitled`** feed access mode (opt-in) enforcing tier channels + version windows on feeds/artifacts; default stays `public` (closes R3 gap by policy, not by force)     |
| D-14 [P]   | Identity scope     | ~~Carve the boundary now (move OIDC, browser session, portal into `services/identity/`); build centralized identity later~~ **Superseded by Amendment A2 (2026-10-04).**              |
| D-15 [S]   | Console UX         | Unified suite console: per-service sections, nav filtered by the product's enabled services                                                                                           |
| D-16 [S]   | Deployment         | Modular monolith, split-ready (restates D-02)                                                                                                                                         |
| D-17 [P]   | Console theming    | Per-section `data-service` accent + new `core` accent; amends brand-spec locked decision D4 (`data-service="key"` everywhere)                                                         |
| D-18 [P]   | Sequencing         | This workstream proceeds independently; brand rollout and docs workstreams rebase onto the result afterward. Security audit already landed on `main`                                  |
| D-19 [L]   | edgeMint           | Folds into **Config** as a secret-delivery capability (`delivery: edgeMint`); routes at `/<p>/config/mint/*`                                                                          |
| D-20 [L]   | Entitlements       | Ride the **license** document (grants of the license/tier). Build gate enforced on `/license/document` responses                                                                      |
| D-21 [L]   | Capabilities       | Fail-closed when discovery succeeds (honest `enabled` flags); on discovery failure fall back to the app's configured expectations, never all-true                                     |
| D-22 [L]   | Air-gap grace      | `MAX_GRACE_SECONDS` stays 365 d; air-gapped installs re-issue bundles on ≤ annual cadence. Perpetual document kind deferred                                                           |
| D-23 [L]   | Deferred renames   | Repo rename and any domain moves deferred; `@polaris` org verification is a P0 external gate                                                                                          |
| D-24 [L]   | Sparkle            | Continues as the update mechanism; Swift `PolarisUpdate` target pins Sparkle ≥ 2.9.6 (raised from 2.6.4)                                                                              |

Out of scope (YAGNI, explicit): centralized identity capability; non-GitHub release providers (the seam is designed, not built); Sparkle delta updates; per-service Workers; Sparkle key lifecycle tooling; perpetual/no-expiry license documents.

---

## 2. Service model

### 2.1 Taxonomy

| Unit         | Kind                 | Owns                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **core**     | substrate, always on | product registry; Device principal (registration, `plrst_` tokens, list/rename/deauthorize, fingerprints, facts/telemetry); trust & signing (per-product Ed25519 keys, JWKS, trust manifest, **trust refresh scheduling**); discovery; rate limiting; error taxonomy; audit; manifest ingest dispatch |
| **license**  | service              | licensing & activation: activate/enroll/token/deauthorize, license document, licenses/keys, tiers (plans), fingerprint & auto-issue policy                                                                                                                                                            |
| **config**   | service              | settings distribution: catalog (schema), config document (config + secrets), profiles, edge-mint secret delivery                                                                                                                                                                                      |
| **release**  | service              | release distribution: GitHub App sync, channel resolution, artifacts (dl), changelog, install script, release truth store                                                                                                                                                                             |
| **update**   | service              | update distribution: appcast rendering, `/version`, eligibility, `entitled` access mode. Hard-depends on release                                                                                                                                                                                      |
| **identity** | service              | product OIDC, browser sessions, customer portal (carved now; centralized identity later)                                                                                                                                                                                                              |

Old module vocabulary maps: `licensing→license`, `config→config`, `releases→release+update`, `oidc→identity`, `edgeMint→config` capability.

### 2.2 Per-product enablement — the single authority

New columns on `products` (following the `fingerprint_policy_json`/`_source` precedent, migration in its own file per the D1 convention):

- `services_json` — e.g. `{"license":{"enabled":true},"config":{"enabled":true},"release":{"enabled":true},"update":{"enabled":true},"identity":{"enabled":false}}`
- `services_source` — `manifest` | `admin`. Resync writes only while `manifest`-owned; an admin edit claims ownership; an explicit revert returns it (mirrors `setFingerprintPolicy`/`revertFingerprintPolicyToManifest`).

Fed by the manifest: `.polaris/product` `modules.<slug>.enabled` — `normalizeModules()` already parses this and `validateManifestDocuments()` already returns `enabledModules`; the fix is to carry it through `ParsedManifest` and persist it (today it is validated then discarded). Defaults when undeclared: `license` + `config` enabled (current behavior).

Validation rules (manifest + admin API): `update` requires `release`; `requires-identity` registration policy requires `identity`; `config` without `license` requires registration policy ≠ `requires-license` (generalizing the existing `config_without_activation` warning into an error); enabling `release` requires a release block (GitHub coordinates) or is held in `not-configured` state.

**Consumers — all four existing "modules" surfaces become projections of this flag:** route mounting (disabled service ⇒ its routes 404 as not-configured, matching the existing hide-don't-reveal pattern), the discovery document (per-service fragments with honest `enabled`), the admin setup view (`productSetupView`), and portal capabilities. None of them re-infer enablement from row presence anymore.

### 2.3 Device registration policy

Product manifest key `devices.registration`: `open` | `requires-identity` | `requires-license`. Default derived: `requires-license` if license enabled; else `requires-identity` if identity enabled; else `open`. `POST /<p>/devices/register` (keyless, rate-limited) mints a `plrst_` device token for `open`/`requires-identity` products (the latter after an identity exchange); for `requires-license` products, tokens are minted only by license activation/enrollment exactly as today.

---

## 3. Wire contract v3

`PROTOCOL_VERSION = 3`. Normative spec to be written as `docs/security/WIRE-CONTRACT-V3.md`; conformance corpus regenerated as `conformance/corpus/v2/` (see §10 risks for lockstep mechanics). JWS mechanics (EdDSA-only, size caps, strict base64url, duplicate-key rejection, verify-before-parse, kid-from-trust-set-only) are unchanged from v2.

### 3.1 Document envelope (shared claims)

Every service document carries: `iss: "plrs.im"` · `aud: <product-slug>` · `deviceId` · `issuedAt` · `expiresAt` · `graceUntil` (bounded by `MAX_GRACE_SECONDS` = 365 d, enforced at verify time). `CLOCK_SKEW_SECONDS` = 300 unchanged. The `checkFreshness` split (on for network path, off for cache reload) is preserved per document.

### 3.2 Documents

| Document       | `typ`              | Payload (beyond envelope)                                                                                                                                                   | Endpoint                                 |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| License        | `plrs-license+jws` | `licenseId`, `profile`, **`entitlements`** (incl. `channels`, `app.minVersion`/`maxVersion`, `deviceLimit`, catalog flags); license _state_ stays gate-derived, not carried | `GET /<p>/license/document`              |
| Config         | `plrs-config+jws`  | `config`, `secrets`, catalog `schemaVersion`                                                                                                                                | `GET /<p>/config/document`               |
| Trust manifest | `plrs-trust+jws`   | key set (semantics unchanged: pins-terminal, replace-not-merge, revoked-key positive prune)                                                                                 | `GET /<p>/.well-known/polaris-trust.jws` |
| Offline bundle | `plrs-bundle+jws`  | `{ bundleId, deviceId, docs: { license?: <jws>, config?: <jws> }, trust: <jws> }`                                                                                           | minted out-of-band (§7.2)                |

Per-doc `ETag`/304 with the v2 half-life re-fetch rule (`REFRESH_MARGIN_SECONDS`) applied per document. 401 → one `POST /<p>/license/token` re-acquire, then retry (unchanged). Build-gate enforcement (channels/version windows) returns 403 + `allowedRange` on **`/license/document`** (and identity's `/session`); the config document enforces device auth only.

### 3.3 Gate & clock floor

- `LicenseStatus` gains **`not-applicable`**: returned when the product does not enable the license service; `isUsable(not-applicable) = true`. This replaces the hardcoded `needs-activation` boot assumption in every SDK/UI.
- Gate input gains `activationSource: "token" | "bundle"` — a verified imported bundle satisfies activation without a `plrst_` token (air-gap, §7.2).
- Monotonic clock floor: `highWaterMark = max(issuedAt over all verified cached documents, trust manifest issuedAt)`; `effectiveNow = max(systemClock, highWaterMark)`. **Core owns trust refresh on its own schedule** — never as a side effect of any one service's fetch — so the floor stays live for any service mix (this closes the v2 landmine where a license-only product would have lost rollback protection).
- Cache format v3: one Core-owned record, per-service namespaced slices holding **signed artifacts only** (plus the unsigned tighten-only hints `lastSyncUnauthorized`, `blocked`); every load re-verifies; version mismatch discards, never migrates. The six v2 offline invariants (freshness-off-on-reload; pins-only manifest verify; pins spread last; replace-not-merge; discard-not-migrate; fail-closed-to-needs-activation) are normative in v3.

### 3.4 Identifier rebrand on the wire

`plrst_` token prefix · `X-Polaris-Device/Version/Channel/SDK/SDK-Version/Platform/Arch` headers · `iss plrs.im` · discovery stays `/.well-known/polaris.json`. Host remains `key.plrs.im` (infra, not wire).

---

## 4. API surface

### 4.1 Product-scoped routes (public wire)

| Area     | Canonical routes                                                                                                                                                            | Notes                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core     | `/<p>/.well-known/{polaris.json, jwks.json, polaris-trust.jws}` · `/<p>/devices/register` · `/<p>/devices[/:id]` (GET/PATCH/DELETE, self-only) · `POST /<p>/devices/report` | `devices/report` relocates `/config/report` (it was license anti-fraud telemetry under a config path)                                                   |
| license  | `POST /<p>/license/{activate,enroll,token,deauthorize}` · `GET /<p>/license/document`                                                                                       | today's `/activate` etc., renamespaced                                                                                                                  |
| config   | `GET /<p>/config/document` · `GET /<p>/config/schema` · `/<p>/config/mint/:id/{token,auth}`                                                                                 | schema = the public catalog; mint = edge-mint relocated                                                                                                 |
| release  | `GET /<p>/release/{changelog,install.sh}` · `GET /<p>/release/dl/:version/:binary-:arch[.dmg]`                                                                              | dl unifies today's `/cli/*` and `/dmg/*`                                                                                                                |
| update   | `GET /<p>/update/appcast.xml` · `GET /<p>/update/:channel/appcast.xml` · `GET /<p>/update/version`                                                                          | appcast gains per-arch support (`?arch=` + dual enclosures); wiring release notes fixes the CDATA `]]>` neutralization (R6-13/R9-08) in the same change |
| identity | `/<p>/identity/auth/{start,callback,poll,logout}` · `/<p>/identity/auth/device/{start,verify,poll}` · `GET /<p>/identity/session` · `POST /<p>/identity/session/license`    | `/auth/login` alias of `/auth/start` is dropped (redundant)                                                                                             |

**Conventional aliases (stable, tooling-facing):** `/<p>/appcast.xml` and `/<p>/<channel>/appcast.xml` (shipped `SUFeedURL` values) → update; `/<p>/install.sh` (published curl-pipe URLs) → release; `/<p>/version` → update. Aliases are permanent, documented, and excluded from future deprecations.

**Removed:** `/<p>/config` (split into the two documents), `/<p>/config/report` (→ `devices/report`), `/<p>/account` (folded into `/devices` + license document), `/auth/login` alias.

### 4.2 Admin & portal APIs

- `/manage/api/products/<slug>/<service>/…` regrouped: `license/{licenses,tiers,policy}`, `config/{catalog,profiles,mint}`, `release/{health,resync,releases}`, `update/{settings}`, `identity/{oidc,portal}`, plus core-level `keys` (signing), `secrets`, `services` (the enablement read/patch/revert endpoint), `activity`. Platform-level `/manage/api/products` CRUD unchanged in shape.
- Portal `/api/*` keeps its shape; `capabilities` and `releases` repoint to `services_json` and the release truth store. The admin-path 5-segment destructure cap is removed as part of the re-route (core router owns full-path dispatch).

### 4.3 Discovery

`/.well-known/polaris.json` becomes registry-assembled: Core emits trust/device/platform info; each **enabled** service contributes a fragment with `enabled: true` and its endpoints (license: activate/token/document URLs; config: document/schema; release: changelog/install/dl; update: appcast/version, channels, `sparkleEd25519PublicKey`; identity: auth URLs). Disabled services are present with `enabled: false` and nothing else. This is the SDK capability-negotiation source (D-21).

---

## 5. Worker topology & data

### 5.1 Layout

```
packages/worker/src/
  core/        router.ts, products.ts, devices.ts, trust.ts, signing.ts,
               discovery.ts, rateLimit.ts, errors.ts, audit.ts, registry.ts
  services/
    license/   routes.ts, document.ts, activation.ts, tiers.ts, policy.ts, admin.ts
    config/    routes.ts, document.ts, catalog.ts, profiles.ts, mint.ts, admin.ts
    release/   routes.ts, sync.ts (github/linkRepo/resync), channels.ts, assets.ts,
               changelog.ts, install.ts, store.ts (truth store), admin.ts
    update/    routes.ts, appcast.ts, version.ts, eligibility.ts, admin.ts
    identity/  routes.ts, oidc.ts, browserSession.ts, portal/, admin.ts
```

`ServiceDescriptor` (in `core/registry.ts`): `{ slug, mountRoutes, discoveryFragment(product), adminFragment, enablementCheck, manifestIngest? }`. Adding a service = one descriptor + one directory. The core router mounts a service's routes only when enabled; the webhook/resync pipeline stays core-owned and dispatches per-service `manifestIngest` hooks.

**Boundary enforcement:** ESLint `no-restricted-imports` zones — `services/<x>/` may import `core/`, itself, and shared packages; the only sanctioned cross-service import is `services/update → services/release`. Everything else crosses via core-mediated interfaces.

### 5.2 Data ownership (logical; no physical table moves)

| Owner    | Tables                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core     | `products` (+ new `services_json`/`services_source`), `product_keys`, `product_secrets`, `devices`, `device_fingerprints`, `device_facts`, `audit`, `product_sync_state`, `schema_index_assertion` |
| license  | `licenses`, `keys_index`, `tiers`, `license_profiles`                                                                                                                                              |
| config   | `product_schema`, `profiles`, `edge_mint_config`                                                                                                                                                   |
| release  | `release_config`, `release_metadata`, `release_artifacts`, `release_channels`, `release_health`, `release_download_tokens`                                                                         |
| identity | `oidc_config`, `provisioning_config`, `portal_accounts`, `portal_account_emails`, `portal_account_identities`, `portal_license_links`, `portal_product_settings`, `portal_audit`                   |

Cross-domain reads are confined to declared seams (the eleven coupling points inventoried during research); lint on query call sites keeps new ones from accruing silently. Tiers remain license-owned even though they reference config profiles and carry update policy — license owns plans; other services consume entitlements from the license document.

**Release truth store goes live:** resync populates `release_metadata`/`release_artifacts`/`release_channels`/`release_health` from GitHub (today they are write-orphaned scaffolding). The portal's releases view and the `entitled` mode's per-artifact gating read from it. Populating it arms the dormant R6-12 open-redirect/TOCTOU on `/download/<token>` — that finding is fixed in the same change, as a blocking requirement.

---

## 6. SDK architecture

### 6.1 Shared core: `@polaris/client-core`

New isomorphic TS package (WebCrypto-only, zero deps, safe for browser + Node + workerd): JWS verification (re-exporting `@polaris/jws`), trust merge/manifest verification, monotonic clock floor, **the gate** (one implementation — absorbing the React port that silently dropped `highWaterMark`), config-precedence resolution, semver/channel helpers, `PolarisErrorCode` taxonomy, and the per-service protocol types (reorganized out of the current single `shared-protocol` barrel into service-scoped modules with subpath exports). Node and React consume it; Python and Swift mirror it natively under corpus v2.

### 6.2 Per language (D-11: one package, sub-clients, umbrella)

- **`@polaris/node`** — `PolarisClient` composes `client.license / .config / .release / .update / .devices`; subpath exports `./core ./license ./config ./release ./update ./cli` (plain-`tsc` dist makes this a package.json change); per-service option bags over shared `CoreOptions` (`trust.pinnedKeys` lives in core options; release/update-only consumers don't carry trust config); Core owns `sync()` = trust refresh → per-enabled-service document fetches (parallel) → cache patch → floor raise → telemetry; activation completes via an `onLicenseAcquired` event that triggers `sync()` (replacing the hard license→config call); store v3 with namespaced slices; `discoverProduct` becomes the capability negotiator; CLI command core gains per-service commands under the existing commander/yargs adapters.
- **`@polaris/react`** — service subpaths (`./license ./config ./identity ./update`) layered over the transport subpaths; `"sideEffects": false`; `capabilities` map keyed by service slugs replaces the two ad-hoc booleans (fail-closed per D-21); per-service `busy`/`error`; one root provider retained; shared `MessageScreen`/button/input primitives extracted with the test-pinned a11y contract; theme vars emitted at `:root` scope so portaled UIs inherit them; bridge v2 (`BridgeState` gains `highWaterMark` + capabilities; adds versioned `invoke(service, method, args)` escape hatch); peer range widens to `react >=18`. New prebuilt UIs: **ConfigPanel** (data layer already shipped), **UpdatePrompt**, **DeviceManager**; `LicenseGate` unchanged in behavior, re-homed under `./license`.
- **Python** — single dist, subpackages `polaris.core / .license / .config / .release / .update / .identity`; parity fixes shipped with the split: HTTPS/base-URL guard, per-request timeout knob, real device-management endpoints, discovery client; keyring stays an extra; CLI front-ends unchanged in shape. (Dist/import naming: see §9 external gates.)
- **Swift** — package `Polaris`; targets `PolarisCore`, `PolarisLicense`, `PolarisConfig`, `PolarisUpdate`, `PolarisUI`, umbrella product `Polaris` (re-exports Core+License+Config for one-import adopters). `PolarisUpdate` is macOS-only, depends on **Sparkle ≥ 2.9.6** (raised from 2.6.4; the package's first external dependency, platform-conditioned), and owns: feed URL construction from discovery, entitled-channel selection from `entitlements["channels"]`, `SPUUpdaterDelegate` wiring (incl. `feedParameters` auth for `entitled` products), `SUPublicEDKey` presence assertion (never reimplementation — the app bundle key remains the terminal anchor). A `PolarisTransport` protocol lands in Core (un-inlining `refreshTrust` from the client actor); HTTPS guard added to match Node.

### 6.3 Cross-cutting SDK rules

Protocol types come from the protocol package(s) only — service barrels never re-export them. The conformance runners re-attribute their imports to the new homes (`client-core` for gate/verify/trust in JS). The worker's e2e test and the React parity/a11y harnesses are re-baselined as part of the SDK phases, not left broken.

---

## 7. Offline & local-only

### 7.1 Offline-tolerant (exists; becomes normative)

Post-activation zero-network operation on Node/Python/Swift is preserved exactly (verified cache, pins-only reload, grace to `graceUntil`, tighten-only unsigned hints, clock floor). The React browser transport remains online-only by design; desktop mode inherits the bridge host's offline capability.

### 7.2 Air-gapped activation (new)

Classic request-code flow, device-bound:

1. App in offline-activation mode displays its **request code** (deviceId + product).
2. Operator mints a bundle in the console (or `plrs` CLI): admin API signs a license document (+ config document if enabled) bound to that deviceId with operator-chosen `graceUntil` (≤ 365 d), wraps them with the current trust manifest as a `plrs-bundle+jws`.
3. User imports the file; SDK `importBundle()` verifies the bundle signature against **pinned keys**, then each inner artifact independently, then writes the cache atomically. No partial imports; any failure imports nothing.
4. Gate treats verified bundle state as activated (`activationSource: "bundle"`); no `plrst_` token exists; fingerprint enforcement is skipped (no server to dedupe against). Revocation lever = the grace bound; re-issue cadence ≤ annual (D-22).

### 7.3 Local-only build profile (new)

Per-app integration mode with **no network code paths active**: Swift by not linking network-bearing targets (`PolarisUpdate` absent ⇒ no update traffic is a link-time guarantee; no `SUFeedURL` set); Node/Python via a transportless core mode (no fetch implementation wired). Config resolves `local > env > fallback` only, or from an embedded/imported bundle (which may carry `enforced` values); license state comes from an imported bundle or `not-applicable` when the app doesn't use License; telemetry/update modules absent, not merely disabled.

---

## 8. Console & portal UX

- **Suite shell:** product switcher + nav grouped by service, **filtered by `services_json`** (the seam is the `TABS` constant + `Shell.tsx` sidebar). Platform pages (product registry, signing keys, KEK, secrets, activity) live at top level under the `core` accent.
- **Sections:** License (licenses, keys, devices, tiers, enrollment/fingerprint policy — giving the currently orphaned fingerprint-policy API a surface), Config (catalog, profiles, mint), Release (releases, channels, health, sync), Update (feed settings, access mode incl. `entitled`, compat window — relocated from product Settings), Identity (OIDC, sessions, portal settings). The Settings grab-bag dissolves into its owning services; General/Danger stay platform-level.
- **Theming:** per-section `data-service` accents (`license`→`key`, `identity`→`id`, new `config`/`release`/`update`/`core` accents) — brand-registry additions are an external prerequisite tracked in §9. Implemented with the current hand-built components; the brand-package rollout is a separate later workstream that restyles this structure (its spec's file paths get rebased there, per D-18).
- **Portal:** structure unchanged; capabilities + releases repoint to `services_json` and the truth store; per-product portal toggles surface under their owning services in the console.

## 9. Rebrand sweep & external gates

| Item               | New value                                                                                                           | Gate                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm scope          | `@polaris/*` (jws, protocol→client-core split, catalog, manifest, node, react, cli, worker, admin, tools, products) | **External:** `polaris` GitHub org + Packages scope + `.npmrc`/token. Verify at P0; if unavailable, fallback decision returns to Vlad (e.g. `@plrs/*`) |
| PyPI dist / import | target `polaris` / `polaris`                                                                                        | **External:** PyPI name availability — verify at P0; fallback `polaris-sdk` or keep `polaris-key` (Vlad decides)                                       |
| Swift package      | `Polaris`                                                                                                           | —                                                                                                                                                      |
| CLI bin            | `pkey` → `plrs` (manifest authoring); SDK-embedded CLIs unchanged in shape                                          | —                                                                                                                                                      |
| Manifest dir       | `.pkey/` → `.polaris/` (webhook, resync, CLI, docs, djdl repo)                                                      | djdl repo updated at re-seed                                                                                                                           |
| Wire identifiers   | `plrs_`/`plrst_`/`X-Polaris-*`/`iss plrs.im`                                                                        | corpus v2                                                                                                                                              |
| Brand registry     | add `config`/`release`/`update`/`core` service entries                                                              | **External:** brand-package repo edit                                                                                                                  |
| Host / repo name   | `key.plrs.im` stays; repo rename deferred                                                                           | D-23                                                                                                                                                   |

## 10. Phasing, orchestration, risks

**Phases** (each green — build + all four language test suites + corpus drift gate — before the next):

- **P0 Contracts** _(Lead-authored)_: WIRE-CONTRACT-V3 doc; protocol/client-core package skeletons; corpus v2 generator + vectors; `services_json` migration + manifest `enabledModules` persistence; service registry skeleton; external-gate verification (`@polaris` org, PyPI name).
- **P1 Worker core & services**: core extraction; service dirs + registry mounts + enablement gating; route table + aliases; split documents; `/devices/register`; wire identifier rebrand server-side; djdl re-seed.
- **P2 Release/Update**: module split; truth-store ingestion via resync; `entitled` mode; per-arch appcast; release-notes wiring + CDATA fix; R6-12 fix.
- **P3 Identity carve**: oidc/browserSession/portal relocate behind the identity descriptor; `/identity/*` routes; alias removals.
- **P4 JS core + Node**: `@polaris/client-core`; Node sub-client re-shape; store v3; CLI; conformance runner re-attribution.
- **P5 SDK fan-out** _(parallel: React, Python, Swift)_: per-language splits, parity fixes, prebuilt UIs (ConfigPanel/UpdatePrompt/DeviceManager), `PolarisUpdate` + Sparkle wiring.
- **P6 Offline**: bundle mint (console + `plrs` CLI) + `importBundle()` across SDKs + local-only profiles + corpus bundle cases.
- **P7 Console**: suite shell, service sections, accents, Settings dissolution, portal repointing.
- **P8 Finalization**: rebrand sweep completion (`.polaris/`, `plrs`), docs updates, risk-register closeout, exit criteria.

**Orchestration** (per the established model): the Lead personally authors shared contracts — wire-contract v3, corpus generator, protocol/client-core package shapes, migrations, the service registry interface, the route table. Contract-consuming work fans out to parallel subagents on disjoint files (per-service worker modules; the four SDKs; console sections), fanned in through review subagents with the green gate between waves.

**Top risks**

| Risk                                                  | Mitigation                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 4-language corpus lockstep during a wire break        | Corpus-first (P0); `gen:corpus --check` remains the CI drift gate; per-language suites all green per phase |
| Clock-floor regression while re-orchestrating refresh | Core-owned trust schedule (§3.3); dedicated multi-doc `clockFloorCases` in corpus v2                       |
| Bundle import as new attack surface                   | Pins-only bundle verification, verify-everything-before-write, no partial imports, corpus bundle vectors   |
| Truth-store arming of R6-12                           | Fix is a blocking requirement of P2, not a follow-up                                                       |
| `@polaris` org / PyPI name unavailable                | P0 external verification; fallback decision escalates to Vlad before any publish-name is baked into code   |
| Appcast changes breaking live Sparkle clients         | djdl is the only adopter and is re-seeded; aliases keep shipped `SUFeedURL`s working                       |
| Four "modules" surfaces drifting back                 | All become projections of `services_json`; lint forbids new presence-inference                             |

**Verification model:** existing behavior pins stay authoritative — wire-contract regression suites (per language), gate matrix, fingerprint corpus, React parity/a11y harnesses, worker e2e — all re-baselined intentionally per phase, never deleted to go green. Tests run on Node 22 (better-sqlite3 constraint).

---

## Amendment A1 (2026-08-27): Polaris Key remains the brand

On review, the suite keeps the **Polaris Key** identity, living at `key.plrs.im`; services are
named **Polaris Key License / Config / Release / Update / Identity**. The architecture (Core
substrate, five opt-in services, `services_json`, wire v3's per-service documents, device
principal, bundles, entitled mode, SDK sub-clients, suite console) is unchanged — this amendment
reverts the _naming layer only_. Decision register deltas:

| #    | Was                                   | Now                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-03 | Suite "Polaris"; packages `@plrs/*`   | Suite "Polaris Key"; packages **`@polaris-key/*`** (org exists — the external gate dissolves). PyPI **`polaris-key`** / `import polaris_key` / script `polaris-key`; Swift package **`PolarisKey`** with `PolarisKeyCore/License/Config/Update/UI` targets and umbrella `PolarisKey`; facade class `PolarisKeyClient`                                                                                                            |
| D-09 | ISSUER `plrs.im` (host-neutral)       | ISSUER **`key.plrs.im`** (total brand/wire coherence; a future host move is a sanctioned pre-launch wire break)                                                                                                                                                                                                                                                                                                                  |
| D-10 | Identifier rebrand to the plrs family | **Full revert to the pkey family**: typs `pkey-license+jws` / `pkey-config+jws` / `pkey-trust+jws` / `pkey-bundle+jws`; tokens `pkeyt_`; license keys `pkey_`; headers `X-PKey-*`; session tags `pkey.admin.v1\|` / `pkey.portal.v1\|`; cookies `__Host-pkey_*` / `pkey_<p>_session`; keyring `pkey:<product>`; env `PKEY_CONFIG_*`; manifest dir **`.pkey/` only** (the `.polaris/` dual-read is removed); CLI bin stays `pkey` |
| D-17 | Per-section `data-service` accents    | **Kept** (per this review) — sections stay visually distinct inside the Polaris Key console                                                                                                                                                                                                                                                                                                                                      |
| D-23 | `@plrs` org creation as external gate | Obsolete — `@polaris-key` publishing continues as-is                                                                                                                                                                                                                                                                                                                                                                             |

Notes: the v2 typ strings `pkey-config+jws`/`pkey-trust+jws` are re-used for the v3 config
document and trust manifest (pre-launch; corpus v1 is deleted in the same wave, so no dual-shape
ambiguity ever ships). `PROTOCOL_VERSION` stays 3 — the document _shapes_ are unchanged; corpus
v2 regenerates with the pkey identifiers. The djdl repository's `.pkey/` manifests (GitHub-synced)
are updated to the v3 modules/registration/redirect-URI shape as part of this amendment's rollout.

---

## Implementation closeout (2026-08-27)

Shipped. The architecture landed as specified; **Amendment A1 was executed**
in the finalization  
 wave, reverting the naming layer to Polaris Key while leaving Core, the five
services,  
 services_json, wire v3's split documents, the device principal, offline  
 bundles, the SDK  
 sub-clients and the suite console exactly as designed. Corpus v1 is deleted;
corpus/v2 is the  
 only corpus, in all four languages.

### §10 risk register — outcomes

| Risk                                | Outcome                             |
| ----------------------------------- | ----------------------------------- |
| 4-language corpus lockstep during   | **Held.** One generator, one        |
| a wire break                        | corpus, four runners; gen:corpus -- |
| --check is the drift gate and       |
| stayed green through the A1         |
| identifier flip, which re-signed    |
| every vector. The Swift mirror is   |
| written by the same generator, so   |
| the copy cannot drift from the      |
| source.                             |
| Clock-floor regression while re-    | **Closed.** highWaterMark folds the |
| orchestrating refresh               | whole verified artifact set and     |
| Core owns trust refresh, so the     |
| floor stays live for any service    |
| mix. The defective single-document  |
| form is pinned as the corpus vector |
| floor-config-doc-alone-does-not-    |
| stop-rollback; seven                |
| clockFloorCases cover the rest.     |
| Bundle import as new attack         | **Closed as designed.** Pins-only   |
| surface                             | bundle verification, verify-        |
| everything-before-write, no partial |
| imports, and a pkey-bundle+jws-only |
| raised payload cap. Nine            |
| bundleCases pin the refusal order,  |
| including the all-or-nothing        |
| property against a populated cache. |
| Truth-store arming of R6-12         | **Closed.** The open-               |
| redirect/TOCTOU fix landed with the |
| ingestion, as the blocking          |
| requirement said it must            |
| (services/release/store.ts,         |
| services/release/github.ts,         |
| http.ts; regression cases in R6-    |
| release.test.ts).                   |
| @polaris org / PyPI name            | **Moot.** A1 dissolved the gate:    |
| unavailable                         | @polaris-key/\* and the polaris-key |
| PyPI name are the existing, owned   |
| names. Nothing external was ever    |
| required.                           |
| Appcast changes breaking live       | **Held.** /<p>/appcast.xml and      |
| Sparkle clients                     | /<p>/<channel>/appcast.xml are      |
| permanent aliases onto the update   |
| service (router.ts), so shipped     |
| SUFeedURL values keep resolving;    |
| djdl is re-seeded regardless.       |
| Four "modules" surfaces drifting    | **Held structurally.** Route        |
| back                                | mounting, discovery, the admin      |
| setup view and portal capabilities  |
| are all projections of              |
| services_json (core/services.ts);   |
| test/boundaries.test.ts walks every |
| file under src/services/ and        |
| refuses cross-service imports and   |
| reach-backs into legacy top-level   |
| modules.                            |

### Deferred out (unchanged, and deliberately)

• **Repo and domain rename — NOW MOOT for naming.** D-23 deferred a rename  
 that A1 removed the  
 reason for: the repo simply stays polaris-key and the host stays key.plrs.im.
Nothing is  
 pending here; the entry is closed rather than carried.  
 • **Brand rollout workstream** (docs/superpowers/specs/2026-06-30-polaris-  
 brand-rollout-design.md)  
 — restyles the console structure this wave built. Its D4 stays amended by D-
17: the per-section  
 data-service accents survive A1 and are what the brand package must  
 accommodate.  
 • **Sparkle key lifecycle tooling.** PolarisKeyUpdate asserts SUPublicEDKey
is present and  
 never reimplements the check; rotating that key is still a manual, app-  
 bundle-side operation.  
 • **Non-GitHub release providers.** The seam is designed (services/release/),
not built.  
 • **Sparkle delta updates.** Full artifacts only.  
 • **Centralized identity.** The boundary is carved (services/identity/); the
capability is not  
 built. Per-service Workers and perpetual/no-expiry license documents  
 likewise stay unbuilt —  
 the modular monolith is split-ready, not split.

_Closeout correction:_ §5.1's "lint-enforced boundaries (ESLint `no-restricted-imports`)" is
implemented as `packages/worker/test/boundaries.test.ts` (a static import-walk over
`src/services/`), not ESLint — the repo has no ESLint toolchain and `lint` is prettier. The
enforcement is equivalent and CI-gated; the mechanism differs from the spec's wording. Separately
noted for CI: `pnpm -r build` does not typecheck the worker (esbuild strips types), so the green
gate must include `pnpm -r typecheck` — build+test alone missed five broken type-only imports
during the A1 sweep.

---

## Amendment A2 (2026-10-04): the Polaris Key account and the Identity service

**Supersedes D-14.** "Centralized identity later" is now: one Polaris Key **account** per person
across every product (layer 1), and a per-product **Identity service** that signs that account in
_through_ a product. Decided by the owner on 2026-10-04 (research note S-16 and its owner
decisions; S-17 for Cloud Sync), approved as the account contract in
`docs/research/2026-09-29-godot-omniplatform/program/plans/I-04.md`, and built from I-05 on. The
owner decisions this amendment records, quoted from that plan's §0:

- **D17** credentials only on the `key.plrs.im` login card, no in-app email-code API. **D18** a
  product's own IdP stays product-only in layer 2, linkable from the portal under step-up. **D19**
  the console shows the buyer email, the account primary email only with consent. **D20** a key
  entry counts only when it enrols a new device or is a portal submission. **D21** on merge the
  survivor's pairwise subject wins, the other becomes an alias, and the developer gets
  `subject.merged`. **D22** no silent SSO into apps: the first sign-in per app needs "Continue to
  <App>", and device code always does. **D23** dormant accounts (no sign-in, no licence) deleted
  after 36 months with an email warning.
- **D24** `license_owned` (403, with `signInUrl`) on key entry of an owned licence on a new device,
  only with Identity on, while re-entry on an enrolled device and existing installs keep working.
  **D25** per-product removal keeps the licence unless "also remove". **D27** deletion leaves
  developer-set buyer columns to the developer, notified by `subject.deleted` (the DPA wording is
  pending a legal review). D26 is superseded by the split below.
- **The account/service split.** The Polaris Key account is platform-level, part of Core and the
  portal, always present and never a per-product toggle. The per-product `identity` toggle gates
  only sign-in _through the product_. Cloud Sync declares `requires: [config, identity]`; its
  principal is `devices.subject` only, with no licence-owner fallback. Key-entry limits and the
  `license_owned` key-entry refusal exist only with Identity on.
- Carried unchanged: no Discord; email confirmation interstitial with the provider-verified fast
  path and the join offer (never silent); profile import; the safety defaults (email-bound licences
  attach only by verified email unless `claimByKey`; an owned licence never moves by key; no
  recovery desk; custom auth domains deferred; passkeys on `key.plrs.im`); operators on Pocket ID.

**What it changes in this spec.** §5's ownership table gains Identity's account tables
(`accounts`, `account_links`, `account_product_subjects` and their aliases, `account_tombstones`,
`subject_events`, `account_sessions`, `account_product_grants`, `account_passkeys`), License's
`licenses.account_id` (the owner pointer; `portal_license_links` and the platform `licenses.sub`
join retire after I-17) and Core's `devices.subject`/`devices.bound_by` (the device binding).
Core gains the account accessors other services read without importing Identity
(`src/core/accountSubjects.ts`: `subjectFor`, `resolveSubject`, `licenseOwnerSubject`) and the
subject hooks (`src/core/subjectHooks.ts`: the clearing hook, the licence-ownership hook, and the
registry through which Config and Cloud Sync hear about merges and deletions), so rule 6 holds.
The global account id never leaves the Worker's Identity and Core code: developers see pairwise
subjects only. The wire stays v4 (`PROTOCOL_VERSION` 4): the device-facing additions are I-08's
and I-09's, additive and feature-detected.

---

## Amendment A3 (2026-10-05): Cloud Sync and the account override

**Adds a seventh service.** Cloud Sync (slug `sync`) stores and syncs a signed-in person's user
settings, collections and saves for one product. Decided by the owner on 2026-10-04 (research note
S-17, its final answers and §7.3), approved as the contract in
`docs/research/2026-09-29-godot-omniplatform/program/plans/U-01.md` on 2026-10-05, and landed from
U-04 on. The owner decisions this amendment records, quoted from that plan's §0:

- **Cloud Sync is its own service** named "Cloud Sync" (slug `sync`), with its own toggle; it
  depends on Config and on the product's Identity service, because Cloud Sync needs sign-in:
  descriptor `requires: [config, identity]`, enforced by the console Services toggle.
- **The principal is the account × product**, seen by the product only as its pairwise subject:
  `resolveSyncPrincipal(device) = devices.subject`, set only by sign-in through the product; no
  licence-owner fallback for Cloud Sync. Config's account override layer keeps its owner fallback
  (`subjectFor(license.account_id, product)`), so owned licences on key-entry devices still get
  account overrides.
- **The licence-level config override layer is removed everywhere**, replaced by the account
  override (user-level managed config per account × product). No exception for products without
  Identity. **Floating (unowned) licences have no such layer** and are prompted to sign up.
  **Overrides on licences with no owner are dropped at migration** with an operator-visible
  report; no grace period.
- **No Cloud Sync without signing in, ever.** Floating licences, key-activated devices and
  products without Identity get local persistence only; settings upload at the first sign-in;
  U-26 stays retired. SDKs and UI kits offer sign-in on `account_required`.
- **Defaults confirmed:** MVP first, then the anonymous-to-signed-in merge and saves, then
  collections; per-product ceilings 50 GiB, 100k users holding data, 2,000 pushes/s; 1 MiB with
  saves off for signed-in users with no licence for the product; the platform pays Cloudflare
  until per-product billing; web apps use a device token issued through I-08 to an origin on the
  product's `core.web.origins` allowlist.
- **S-17 decisions 20–24:** 20 entitlement overrides stay on the licence, only `config` and
  `secrets` move; 21 a 30-day notice counted from I-07 and I-11 both live, and a 90-day report;
  22 Cloud Sync needs sign-in; 23 web Cloud Sync uses I-08's web redirect; 24 the
  developer-backend credential follows Identity.
- **S-18:** ceilings and quotas are `product_settings` rows in the settings registry, not a
  `sync_product_settings` table; developer limits are `claimable`; the account is not a settings
  scope.
- Fixed names: the binding column is I-05's `devices.subject`; the SDK namespace is `cloudSync`
  (`cloud_sync` in Python and GDScript), never `sync`.

**What it changes in this spec.** §2.1's service table gains its seventh row in
`tools/services.json` (default off, `requires: ["config","identity"]`), and the coherence rules
gain `sync_requires_config` and `sync_requires_identity`, refused both ways by the admin API and
manifest ingest. The catalog (`@polaris-key/catalog`) gains the `user` block on `config` entries
and a top-level `cloudSync` block (the data shape); `.pkey/product` gains `cloudSync` (limits and
access policy, persisted through the settings registry). No new `ConfigKind`; the config
document's shape, `PROTOCOL_VERSION` (4) and the signed corpus are unchanged: every addition is
content or an unsigned, feature-detected route. §5's ownership table gains Cloud Sync's
`sync_directory` and `sync_product_usage` and Config's `account_overrides` and
`override_migration_report` as the packages that create them land (U-03, U-05).
