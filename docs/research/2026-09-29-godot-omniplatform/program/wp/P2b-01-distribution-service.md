# P2b-01 Add the `distribution` service with Core descriptor hooks and coherence rules

| Field       | Value                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2b: Distribution core                                                                                                                                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                              |
| Depends on  | [P0-09](P0-09-service-table.md), [P2-03](P2-03-release-data-model.md)                                                                                                                                                                             |
| Unblocks    | [P2b-02](P2b-02-distribution-manifest.md), [P3-01](P3-01-wire-v4-plan.md), [P5-01](P5-01-outlet-credentials.md)                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                |
| Plan mode   | no (stop and escalate if P0-09 put the service table in `shared-protocol` or any wire shape would change)                                                                                                                                         |
| Gates       | new service; `pnpm gen services --check` (P0-09); rule 9 (two new coherence codes, one retired); D1 migration (backfill); threat model; all SDKs (generated enums); `docs check:links`                                                            |
| Human input | ✋ confirmation that [P0-08](P0-08-unknown-slug-tolerance.md) is **in production** before this is deployed (program README §6; not in the graph's list); djdl's live `.pkey/product` gains `distribution` before its next push (see Design notes) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                         |

## Goal

`distribution` is the sixth opt-in service. Its slug is one row in P0-09's service table, and
every place a service is wired (Worker, manifest, CLI, console, SDKs, docs) knows it. The chain
**release ← distribution ← update** is enforced by the coherence codes `distribution_requires_release`
and `update_requires_distribution`. Core declares three **descriptor hooks**, `releaseCatalog`
(implemented by release), `delivery` and `outletCapabilities` (implemented by distribution), which
a disabled service does not contribute. Existing products keep exactly their current behaviour.

## Why

Release answers "what exists", distribution "how it reaches devices and outlets and what state it
is in there", update "what this device should do next" ([§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered),
[§11](../../README.md#11-decisions-needed) decision 16). A service may import only `core/` and
itself, with the one exception `update → release` (`AGENTS.md` rule 6), so distribution reads
release and update reads distribution through Core-declared hooks, the pattern of
`ServiceDescriptor.authorizeRegistration`. Every later distribution package (P2b-02 to P2b-06,
P4-05, P4-14, P5-\*) and the wire v4 plan (P3-01) build on this service and these hooks.

## Read first

- `AGENTS.md` (rules 3, 5, 6, 9, 10), `CLAUDE.md`, the `authoring-pkey-manifests` skill.
- [README §3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered)
  (the authority for hook names and coherence rules), [§3.8](../../README.md#38-distribution-distribution-service),
  [§3.1](../../README.md#31-vocabulary) (outlet, transport, availability, rollout, capabilities).
- [notes/A3 §5.3](../../notes/A3-admin-dx.md#53-blast-radius-of-a-sixth-service-content) (the
  blast radius of a new slug) and [§5.4](../../notes/A3-admin-dx.md#54-terminology-new-nouns-that-dont-collide).
- [P0-09](P0-09-service-table.md) (`tools/services.json`, `pnpm gen services`, its assertion
  tests and the "Adding a service" checklist in `contribute/layout.md`), [P0-08](P0-08-unknown-slug-tolerance.md),
  [P2-03](P2-03-release-data-model.md) hand-off (`model.ts`).
- Code: `packages/worker/src/core/registry.ts:99-135` (`ServiceDescriptor`), `:121-134` and
  `:189-199` (the `authorizeRegistration` hook and its fail-closed accessor), `:162-173`
  (`dispatchService`); `src/core/services.ts:48-54,250-280`; `src/mount.ts:25-31`;
  `src/router.ts:41-47,168-183`; `src/core/discovery.ts:74-83`; `test/boundaries.test.ts:58-60,179`;
  `packages/shared-manifest/src/index.ts:268-278,1420-1432`; `products/djdl/product.json`.

## Scope

**In:**

- **The table row** in `tools/services.json`: `distribution`, label "Distribution", a `summary`
  for the Services card, `defaultEnabled: false`, `requires: ["release"]`, `legacyModules: ["releases"]`, a new console
  accent `distribution` and an icon. Change `update`'s `requires` from `["release"]` to
  `["distribution"]`. Run `pnpm gen services`.
- **Everything the table generates** (P0-09): `ServiceSlug`/`SERVICE_SLUGS`/`MODULE_SERVICES` in
  `@polaris-key/manifest`, `SERVICE_NAMESPACES`, discovery iteration, the console's `ServiceSlug`
  and `ServicesCard` rows, the CLI module list, and the service enums of `sdk-node`
  (`src/discovery.ts`), `sdk-react` (`src/core/services.ts`), Python (`polaris_key/discovery.py`)
  and Swift (`PolarisKeyCore/Discovery.swift`), plus `sdks/godot` if P1-01 has landed and the table
  covers it.
- **Everything the gate asks for by hand:**
  - `packages/worker/src/services/distribution/index.ts` (descriptor: `handle` returns `null` for
    every path; `discoveryFragment` `{enabled: true, configured: false, endpoints: {}}`), and the
    `mount.ts` entry;
  - coherence literals in `core/services.ts` `validateServices` and in the manifest validator:
    `distribution_requires_release`, `update_requires_distribution`; retire
    `update_requires_release` ("subsumed", README §3.2) with its mutation entry replaced by two new
    ones; `product.schema.json` `modules.properties.distribution` and the conditional rules;
    `SERVICE_ERROR_MESSAGES` in `packages/admin/src/api.ts` (line 423 at implementation, not 349);
  - the OpenAPI discovery schema (`services.required` and a `distribution` fragment);
  - console: a Distribution section in `route.ts` with one tab (an overview of enablement and hook
    status, docs `/docs/services/distribution/`), the icon in `components/Shell.tsx`, dark and
    light accent tokens in `styles.css`;
  - docs: `packages/docs/astro.config.mjs` sidebar, `services/distribution/index.md`,
    `start/concepts.md` (six services; outlet, transport, availability, submission, rollout,
    listing, outlet capabilities), `start/service-model.md`, `admin/services-enablement.md`;
    `AGENTS.md` (repo map and the service list), the manifest skill's step 4 table, the root
    `README.md`; regenerated `reference/*.mdx`.
- **Descriptor hooks** in a new `packages/worker/src/core/hooks.ts`:
  - `ServiceDescriptor` gains `releaseCatalog?`, `delivery?` and `outletCapabilities?`;
  - `ServiceContext`, `DiscoveryContext` and the admin context gain `hooks`, built by Core from the
    registry and the product's enablement: `hooks.releaseCatalog()`, `hooks.delivery()` and
    `hooks.outletCapabilities(outletId)` return `null` when the providing service is off;
  - release implements `releaseCatalog` in `services/release/catalog.ts` over P2-03's model
    (deliverables, releases, builds, artifacts, channel policy, yanks); read-only;
  - distribution implements `delivery` (no outlets yet: default transport `pkey-cdn`, empty
    availability) and `outletCapabilities` (returns `null` until P2b-02).
- **Backfill migration**: add `"distribution":{"enabled":true}` to `products.services_json` where
  `release` is enabled (`json_set` guarded by `json_extract`), whatever `services_source` says.
- Fixtures: `products/djdl/product.json` and the parity base fixture gain `distribution`.
- Threat model: the new service, the hooks as a read-only boundary, the rollback hazard.

**Out** (and where it belongs instead):

- `.pkey/distribution`, outlets, transports, capability defaults (→ [P2b-02](P2b-02-distribution-manifest.md)).
- Availability, submissions, keys (→ [P2b-03](P2b-03-availability-keys.md)); rollouts, access and
  byte serving (→ [P2b-04](P2b-04-rollouts-delivery.md)), which also adds `resolve` and the source
  opener to `releaseCatalog`.
- Outlet-credential custody (→ [P5-01](P5-01-outlet-credentials.md)). SDK sub-clients for
  distribution (none are planned; storefront clients read distribution's feeds directly).

## Design notes

- **Hook names.** README §3.2 is authoritative: `releaseCatalog`, `delivery`,
  `outletCapabilities`. README §10's P2b row says `buildCatalog`, `availability`,
  `outletCapabilities`, and §6.2 item 1 says "the build-catalog hook"; those are stale. P3-03's and
  P4-05's briefs say to use whatever lands here.
- **Fail closed, like `authorizeRegistration`** (`registry.ts:189-199`): the accessor checks the
  providing service's enablement first and returns `null`; consumers degrade explicitly (for
  example, update without a delivery hook serves no per-outlet state). A hook never writes: a
  cross-service write would be an import in disguise.
- **Types live in Core** (`core/hooks.ts`), because Core may not import a service. Keep the
  surfaces small: plain records keyed by deliverable, never by "is a pack" (README §11 guardrails).
- **Coherence.** Admin API: `distribution` on with `release` off → `distribution_requires_release`;
  `update` on with `distribution` off → `update_requires_distribution`. The manifest mapping
  `releases` → release + distribution + update never trips either. P0-09's test ties each
  `requires` edge `a → b` to the literal code `a_requires_b`.
- **Compatibility.** `products/djdl/product.json` declares the canonical `release` and `update`
  slugs, not the legacy `releases` README §3.2 cites, so the new rule rejects it until it gains
  `distribution: {enabled: true}`. Update the fixture here. If djdl's live repository manifest is
  the same shape, its next push fails validation (visibly, in the console) until it is edited; the
  backfill keeps its stored state serving meanwhile. Say so in the PR and the release notes.
- **Why backfill on `release`.** Every product with Release on serves `/release/dl` today, and
  P2b-04 moves byte serving into distribution. Backfilling from `release` keeps those downloads
  working for admin-owned rows too. A manifest that later enables Release alone turns
  distribution off by choice; P2b-04 documents that downloads then stop.
- **Rollback.** An old worker that meets `distribution` in `services_json` must keep every other
  slug. That is exactly P0-08, which must be deployed to production first. Record the deploy.
- **Router.** `distribution` joins `SERVICE_NAMESPACES`, so a manual release channel named
  `distribution` loses the `/<p>/distribution/appcast.xml` alias (`router.ts:178-183`); its
  canonical `/<p>/update/distribution/appcast.xml` still works. Document it.
- **Terminology.** The SDKs and Core already say "distribution" for release + update in comments
  (`core/services.ts:45`, `sdk-node/src/discovery.ts:47`, `sdk-react/src/core/services.ts:54`,
  `discovery.py:69`). Reword them in this PR so the word means only the service.
- **Not plan mode**, as long as the table is not in `shared-protocol` and discovery keeps its
  shape (a new key under `services` is additive; old SDKs ignore unknown slugs).

## Steps

1. Confirm P0-08 is in production and P0-09 and P2-03 are `done`; branch.
2. Add the table row and change `update`'s edge; run `pnpm gen services`; follow every failure of
   P0-09's assertion tests until they pass. Keep a list of files for the PR body.
3. Coherence codes in both validators, mutation entries, `product.schema.json`, fixtures.
4. `core/hooks.ts`, the context wiring in `dispatchService`, discovery and the admin API; release's
   `catalog.ts`; distribution's descriptor and default `delivery`. Tests for enablement gating.
5. Backfill migration with a test on seeded rows (release on and off, admin- and manifest-owned).
6. Console section, accent CSS, icon; docs pages and glossary; threat model; `AGENTS.md` and skill.

## Acceptance criteria

- [ ] `pnpm gen services --check` passes; P0-09's assertion tests pass with six slugs.
- [ ] `boundaries.test.ts` scans `services/distribution/` and the only cross-service exception is
      still `update → release`.
- [ ] Hook tests: with Release off, `hooks.releaseCatalog()` is `null` inside distribution; with
      distribution off, `hooks.delivery()` and `hooks.outletCapabilities()` are `null` inside update;
      a disabled service's hook code never runs (spy).
- [ ] `validateServices` and the manifest validator emit the two new codes and never
      `update_requires_release`; `pnpm --filter @polaris-key/manifest test` passes; djdl validates.
- [ ] After the migration, every product with Release on has distribution on, and every existing
      release, update and discovery test passes unchanged (discovery gains only `services.distribution`).
- [ ] Node, React, Python and Swift suites pass with the generated enums; the console builds and
      shows the section only when enabled.
- [ ] The green gate passes (`AGENTS.md`), including Python, Swift and `docs check:links`.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen services --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- boundaries registry services router hooks discovery
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- `core/hooks.ts` (`ReleaseCatalog`, `Delivery`, `OutletCapabilities`, `ServiceHooks`) is the
  interface P2b-02 to P2b-06, P3-03, P4-05, P4-14 and P6-03 use. P2b-04 extends `releaseCatalog`
  with resolution and source access; P2b-02 implements `outletCapabilities`; P2b-03 and P2b-04 fill
  `delivery`.
- `services/distribution/` exists with an empty route table; the next packages add routes.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2b-01 done`.
