# P0-41 Living ADMIN.md and PORTAL.md; UX rows registered

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation A: Ground truth, decisions and quick wins) |
| Size        | 0.4–0.6 engineer-weeks                                                                                |
| Depends on  | [ST-37](ST-37-vocabulary-one-word-concept-rule-4.md)                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                |
| Role        | `pkey-implementer`                                                                                    |
| Plan mode   | no                                                                                                    |
| Gates       | `docs-links`                                                                                          |
| Human input | none                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-13** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins).

## Goal

Living ADMIN.md and PORTAL.md; UX rows registered, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-13** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, for **CQF-13**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- Rewrite ADMIN.md and PORTAL.md as current-state docs folding the EXPERIENCE, SETUP, FLOWS and SIGN-IN amendments; delete superseded sections and the EXPERIENCE §14 table; mark every UX-\* row in EXPERIENCE §13.3, SETUP §8.2 and FLOWS §4.2 from backlog-changes.json's uxRows map (graph id, built <sha>, parked with its revive condition, or dropped); contributor page 'add a page, a setting, a wizard, a write'.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track A (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-13**; DX consolidation A: Ground truth, decisions and quick wins.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A script checks every UX-\* id in the three specs against uxRows; none is unmapped
- [ ] ADMIN.md and PORTAL.md describe the shipped console and portal
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm --filter @polaris-key/docs build
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-41 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-41 done`.
