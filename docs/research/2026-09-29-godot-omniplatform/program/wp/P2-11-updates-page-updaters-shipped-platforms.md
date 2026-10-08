# P2-11 Updates page: updaters for shipped platforms with Wired status

| Field       | Value                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation I: Packages, updates and packs)           |
| Size        | 0.8–1.1 engineer-weeks                                                                                       |
| Depends on  | [P2-08](P2-08-built-in-dev-release-track-default-store.md), [A-20](A-20-product-facts-channel-read-model.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [D-03](D-03-diceroll-after-p3.md)                                    |
| Role        | `pkey-implementer`                                                                                           |
| Plan mode   | no                                                                                                           |
| Gates       | `console-csp-parity`                                                                                         |
| Human input | none                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-04** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Goal

Updates page: updaters for shipped platforms with Wired status, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-04** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §4.3, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §4.3, §4.4, for **UC-04**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- renderUpdaterSetup per shipped platform and channel (Sparkle, WinSparkle, Velopack, App Installer, zsync, the signed feed, Play in-app updates, the Godot updater); endpoints scoped to productPlatforms (A-20); Wired from update-health events is the Ship builds domain fact (updaters send no X-PKey-SDK, so no sighting exists); pkey release keys init --sparkle; the page is named Updates under Ship builds and its settings rows are reachable from the hub.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-04**; DX consolidation I: Packages, updates and packs.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A Windows-only product sees no Sparkle setup
- [ ] Wired flips on the first update check from a shipped build
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-11 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-11 done`.
