# P0-35 Vocabularies as data (platforms, ecosystems, licence)

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))            |
| Size        | 0.5–0.8 engineer-weeks                                                                                                           |
| Depends on  | [P0-39](P0-39-console-sections-move-page-budget-lead.md)                                                                         |
| Unblocks    | [P0-37](P0-37-complete-shared-component-inventory.md), [P0-51](P0-51-1-0-readiness-review.md), [PX-09](PX-09-get-it-complete.md) |
| Role        | `pkey-implementer`                                                                                                               |
| Plan mode   | no                                                                                                                               |
| Gates       | `console-csp-parity`                                                                                                             |
| Human input | none                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-05** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Vocabularies as data (platforms, ecosystems, licence), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-05** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, for **CQF-05**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- lib/vocab/{platforms,ecosystems,license}.ts; licence-key format into @polaris-key/manifest; delete the 6, 7 and 3 duplicated label maps. The stores half moves to A-19's tools/channels.json.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-05**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One label map per vocabulary
- [ ] No duplicated platform or ecosystem labels (grep test)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-35 done`.
