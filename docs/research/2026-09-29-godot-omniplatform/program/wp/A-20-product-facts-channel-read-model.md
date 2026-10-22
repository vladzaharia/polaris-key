# A-20 Product facts and the channel read model

| Field       | Value                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                                                                                                     |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                                                                                                    |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md), [ST-42](ST-42-create-defaults.md)                                                                                                                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-11](P2-11-updates-page-updaters-shipped-platforms.md), [A-21](A-21-console-ia-distribution-commerce-groups.md), [A-22](A-22-channel-page-status-releases-listing.md), [A-26](A-26-customer-channel-actions.md), [A-31](A-31-derived-identities-short-pkey.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                        |
| Plan mode   | no                                                                                                                                                                                                                                                                                                        |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-03** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-53.

## Goal

Product facts and the channel read model, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-03** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **DC-03**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- productPlatforms with sources (builds, declared); reads the distribution.intendedPlatforms key ST-42 registers; a known-format table and fit; one four-state vocabulary per facet (Not set up, with 'one click' when credentials are already held; Ready; Live; Attention): unavailable channels are hidden, 'not using' is a recorded core.setup choice, 'setting up' is transient runner progress; CPU architecture is a fact beside OS (an arm64-only build offers no x64 artefact); GET .../distribution/channels (OpenAPI, routeCoverage); the product summary's channels[]; a validator warning for an outlet without a build (rule 9). A product with no macOS build or declared macOS platform sees no macOS channel. Absorbs UX-53.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-03**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 6 mockup item(s):** `distribution.channels-no-release`, `distribution.channels-product-role`, `distribution.channels`, `distribution.download-page`, `packages.updates-godot`, `packages.updates`.

## Acceptance criteria

- [ ] A Windows-only product sees no Apple channel in console, portal or CLI
- [ ] An arm64-only Windows build offers no x64 download or winget installer; the Mac App Store channel requires a universal or arm64 build
- [ ] 'one click' computed from credentials already held
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-20 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-20 done`.

## Corrections (2026-10-22)

The code is the fact (`_lead/plans/A-20-A-28-slices.md` §0). Where the brief disagrees:

- **A1.** `distribution.intendedPlatforms` already exists: registered at `services/distribution/settings.ts:49` (values `RELEASE_PLATFORMS`), written by `core/products/createDefaults.ts:252`; its `readers` names only createDefaults.
- **A2.** "Not using" already exists as `core.setup.notUsing` (`core/settings/setupShape.ts`, ST-39).
- **A3.** The A-18j read `GET …/distribution/storefronts` (`services/distribution/storefronts/admin.ts`) is flow-shaped, behind the platform-admin gate and narrative-only. Renaming it with an alias (integration.md §5.3) collides with the no-alias rule (CM-20 §0, C-54); see D2.
- **A4.** The catalogue (`tools/channels.json`, 19 entries) had `platforms` and flat `formats` but no arch requirement. `RELEASE_ARCHES` has `universal` and `any`; a build's arch is on `CatalogBuild.arch` and `ManifestArtifactEntry.arch`. A-20.1 adds the optional per-channel `arches` and the pure fit functions (`shared-manifest/src/formats.ts`).
- **A5.** Builds are already split by arch in three places: the Download page (`page/model.ts:429-458`, `ARCH_PREFERENCE`, `pickBuild`), Scoop (`feeds/render.ts:313`, `SCOOP_ARCH`) and winget (`cli/src/storefronts/winget.ts:44`, `ARCH`). An arm64-only build already yields no x64 entry, so criterion 2 is mostly proofs (A-20.6).
- **A6.** `/<p>/distribution/download.json` is wire-recorded (transcript `distribution-download-model.json`, SDK replayers). It must not change.
- **A7.** CM-29 §3.3's `services/commerce/readiness.ts` was never built. `setupOf` (`services/commerce/admin.ts:64`) and `readyStorefronts` (`commerce/public.ts`) stand in.
- **A8.** No CLI command lists a product's channels. The CLI part of criterion 1 is the validator warning in `pkey validate` (D11).
- **A9.** The declared artifact map (`.pkey/release deliverables.app.artifacts[]`, `release_deliverables.def_json`) is not reachable through `ReleaseCatalog`. A-20.2 adds one hook member.
- **A-20.1 data fix.** The catalogue listed winget's formats as `msi, exe, msix`, but the winget adapter installs a `.zip` with a nested portable (`cli/src/storefronts/winget.ts`). `zip` is added to winget's `formats`.
