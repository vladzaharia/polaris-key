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

## Acceptance criteria

- [ ] A Windows-only product sees no Apple channel in console, portal or CLI
- [ ] An arm64-only Windows build offers no x64 download or winget installer; the Mac App Store channel requires a universal or arm64 build
- [ ] 'one click' computed from credentials already held
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-20 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-20 done`.
