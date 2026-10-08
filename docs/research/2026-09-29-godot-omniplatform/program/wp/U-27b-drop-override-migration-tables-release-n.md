# U-27b Drop the override-migration tables (release N+1)

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync) |
| Size        | 0.1–0.2 engineer-weeks                                                   |
| Depends on  | [U-27](U-27-keep-licence-config-layer-delete.md)                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                   |
| Role        | `pkey-implementer`                                                       |
| Plan mode   | no                                                                       |
| Gates       | `migration`, `table-owners`                                              |
| Human input | owner decision 1 (answered 2026-10-07, open to veto)                     |
| Repo        | `vladzaharia/polaris-key`                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CFG-01b** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Goal

Drop the override-migration tables (release N+1), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CFG-01b** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **CFG-01b**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §6, for **CFG-01b**.

## Scope

**In:**

- One release after U-27, after a production check that nothing read or wrote them: drop override_migration and override_migration_report (lead-numbered migration, replay-safe, a down script in scripts/rollback/); P0-24 ledger row closed (about 3,000 lines and 2 tables gone across U-27 and U-27b).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track G (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CFG-01b**; DX consolidation G: Managed config and Cloud Sync.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- Gated on owner decision 1 ([README §8](../../../2026-10-07-dx-consolidation/README.md#8-owner-decisions)), answered on 2026-10-07 under delegated authority with the recommendation and open to the owner's veto; a veto takes that row's "If the answer is no" column.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Production check recorded before the drop
- [ ] Down script restores the empty tables
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-27b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-27b done`.
