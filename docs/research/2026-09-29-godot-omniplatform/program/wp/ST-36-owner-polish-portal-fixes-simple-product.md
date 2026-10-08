# ST-36 Owner polish: portal fixes and the simple product card (fix/ux-polish-1007)

| Field       | Value                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation: batch 6 (merged))                                                                                                                                                                                 |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                                                                                |
| Unblocks    | [P0-31](P0-31-console-shared-layer-cleanup-lead-window.md), [P0-32](P0-32-one-data-layer-console-portal.md), [P0-36](P0-36-portal-on-copy-catalog.md), [P0-47](P0-47-quick-wins-console-portal-week-0.md), [ST-44](ST-44-one-home-delete-get-manage-api-summary.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                  |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-00**.

- UX rows that name this package: UX-45 (built 5ad447feb (ST-36)); UX-46 (built 5ad447feb (ST-36)).

## Goal

Owner polish: portal fixes and the simple product card (fix/ux-polish-1007), as scoped below. Done: merged before this package was registered.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-00** in batch 6 (tracks.md rule 1). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.1, §4.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.1, §4.2, §4.4, for **OB-00**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- Registers fix/ux-polish-1007, merged into integ/batch-6 as reviewed (5ad447feb): portal What's New formatted and summarised with full notes on expand; device count as a pill in the product sidebar; sidebar reorganised; 'Automatic Grant' licence source (P0-36 moves it to the catalog in sentence case); the tier pill top-right of License Details; the '0 out of 5 devices' line removed; console product card reverted to the name/slug header plus a row of enabled-service icons, and on phones the name plus a coloured pip per service. Absorbs UX-45 and UX-46.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of the plan (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-00**.
- Merged in batch 6 as `fix/ux-polish-1007` (5ad447feb), registered here as done (tracks.md rule 1).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. None: merged in batch 6 (5ad447feb).

## Acceptance criteria

- [x] The six portal items and two console items match the owner brief
- [x] PX-20's e2e states updated
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-36 done`.
