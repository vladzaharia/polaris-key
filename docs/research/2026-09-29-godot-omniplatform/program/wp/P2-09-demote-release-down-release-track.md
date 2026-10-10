# P2-09 Demote a release down a release track

| Field       | Value                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation I: Packages, updates and packs)              |
| Size        | 0.5–0.8 engineer-weeks                                                                                          |
| Depends on  | [P2-08](P2-08-built-in-dev-release-track-default-store.md), [P2-12](P2-12-one-update-resolver-retire-github.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                          |
| Role        | `pkey-implementer`                                                                                              |
| Plan mode   | no                                                                                                              |
| Gates       | `migration`, `table-owners`, `rule-10`                                                                          |
| Human input | none                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                       |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-02** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/P2-12.md`](../plans/P2-12.md) §7: it reads yanks only in `loadDeliverableState`. If it is ready before P2-12's switch, it instead patches `legacyPolicyFor` (§6.4), and P2-12b deletes the patch.

## Plan follow-through (2026-10-09)

Approved [`plans/P2-08.md`](../plans/P2-08.md) (2026-10-09) bears on this package: it consumes P2-08's pure `trackFallbackState(newest, fallbackNewest)` for the stale-track state (`packages.release-tracks-stale`) and does not re-derive "behind" or "N builds ahead".

## Goal

Demote a release down a release track, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-02** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **UC-02**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- Demote as a per-track yank: a nullable channel column on release_yanks (NULL means everywhere, today's meaning) and the track's pointer in release_channel_policy moves back; no new table; a demote verb in policy.ts (console, CI route .../channels/<c>/demote, pkey release demote); resolution honours it; lanes show published, promoted and demoted; package tags re-render; audit release.channel.demote; the signed feed recomposes per track.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-02**; DX consolidation I: Packages, updates and packs.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- [ ] After Promote or Demote the affected track lane and the channel cells in 'Where each track goes' update in place (MO-09), others do not re-render; a partial result shows the lane callout (for example 'itch.io still serves 1.8.0' with 'Retry itch.io') and a toast with Retry; progress indicators only for a real running operation. (admin-2-17)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 5 mockup item(s):** `packages.demote`, `packages.promote`, `packages.release-tracks-stale`, `packages.release-tracks`, `packages.updates-godot`.

## Acceptance criteria

- [ ] A demoted release leaves the stable feed and stays on beta
- [ ] Audited
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-09 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-09 done`.
