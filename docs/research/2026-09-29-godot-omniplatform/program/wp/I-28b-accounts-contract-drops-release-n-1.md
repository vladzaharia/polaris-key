# I-28b Accounts contract drops (release N+1)

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity) |
| Size        | 0.1–0.2 engineer-weeks                                                                            |
| Depends on  | [I-28](I-28-accounts-contract-phase.md)                                                           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                            |
| Role        | `pkey-implementer`                                                                                |
| Plan mode   | no                                                                                                |
| Gates       | `migration`, `table-owners`                                                                       |
| Human input | none                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-01b** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Corrections from I-28 (2026-10-23)

Written by I-28.4 from the slice plan (`_lead/plans/I-28-MO-13-slices.md`, "What I-28b inherits"). The code is the fact.

- **Names.** I-28's migrations are `0141_a_portal_contract_purge.sql` and `0141_b_index_assertion.sql` (not `0140_*`; `LATEST_MIGRATION` is `0141_b`). The `_v` views never existed.
- **Timing and check.** I-28b ships at least 14 days after release N is live. The production check before it is `scripts/portal-contract-check.sql` at zero AND all four `portal_*` tables empty (`SELECT COUNT(*)` on each). Record it under RUNBOOK Entries first.
- **Drop and down script.** The drop migration is replay-safe; its down script in `scripts/rollback/` recreates the four empty tables and their indexes (the 0017 shapes). Release N already removed the index requirement (`REQUIRED_INDEXES`, `0141_b`), so there is no index coupling.
- **Remove with the drop.** The four `TABLE_OWNERS` rows, the settings-coverage row `column:portal_license_links.source` (`pnpm gen settings`), the data-model rows (`pnpm gen docs-reference`), and empty `RETIRED_TABLES` in `db/owners.ts` (the `tableCrossings` retired-table assertion then guards an empty list; drop it with the list).
- **Tests that seed portal rows** move to a scratch DB of the migrations before the drop: R11's cascade test (`attack/R11-data`), `portalIdentityIssuer` (0059), `accountsMigration` (0068) and `subjectStores`. `licenseDelete` and the schema-walking completeness tests read `RETIRED_TABLES`.
- **RUNBOOK.** Mark `scripts/rollback/0068_accounts.down.sql` as superseded. Close P0-24's "Portal tables" ledger row with an Entry. If release N shipped with a non-zero purge, the erased-person residue note in "Portal tables purge" closes with this drop.
- **`terms_json`.** I-28.4 made it dormant (out of `ACCOUNT_COLUMNS` and `AccountRow`; `DORMANT_ACCOUNT_COLUMNS` in `mergeUndo.ts`, accepted by the pin test). SQLite drops a plain column without a rebuild, but `gen-reference.mjs` (~:449) has no `DROP COLUMN` arm: extend it, or leave the column dormant and say so here.

## Goal

Accounts contract drops (release N+1), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-01b** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **IX-01b**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, for **IX-01b**.

## Scope

**In:**

- One release after I-28, after a production check that nothing read or wrote them: drop portal_accounts, portal_account_emails, portal_account_identities and portal_license_links with their \_v views (lead-numbered migration, replay-safe, a down script in scripts/rollback/); accounts.terms_json stays dormant unless D1 can drop the column without a table rebuild; P0-24 ledger row closed.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-01b**; DX consolidation F: Identity.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
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
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-28b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-28b done`.
