# P0-24 Migration ledger and one-time machinery sunset

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on)) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                |
| Depends on  | [P0-18](P0-18-table-ownership-owner-stores-one-audit.md)                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `docs-links`                                                                                                          |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-10** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Owner 2026-10-07: no compatibility windows (`tracks.md` rule 6). The ledger keeps only the break-glass `ADMIN_OIDC_*` window, paths that native binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes; removed once DJDL has shipped a build on 0.9) and the two-release DB contracts. There is no SDK, CLI, Action, cookie-mode, `PKEY_ADMIN_COOKIE` or Pocket ID env window, and manifest fields are removed, not deprecated.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: ledger rows for break-glass, the `adminGroup` offers' outcome fact and the `admin_group` column's two-release contract. `PKEY_ADMIN_COOKIE` gets no row: it goes in ST-34's release.
- [`plans/I-27.md`](../plans/I-27.md) §12: rows for the seeded audience, the `sub` sunset and the native-binary checks of SP-40 and I-32b. No row for the Pocket ID env or `SIGNIN_*`: they have no window.
- [`plans/LX-41.md`](../plans/LX-41.md) §13: the ledger row in its §6.1.
- [`plans/P2-12.md`](../plans/P2-12.md) §7: the P2-12/P2-12b pair, P2-12b's production fact and the expected-row acknowledgements; the deviation from `tracks.md` rule 5 and its reason (§6.5); two owner steps for djdl (the channel-workflow change ahead of PR 2, and dropping the two settings right after PR 2 deploys).
- [`plans/CM-29.md`](../plans/CM-29.md) §10: the ledger records §3.5's pre-deploy check. [`plans/SP-35.md`](../plans/SP-35.md) §12: no SDK row.

## Goal

Migration ledger and one-time machinery sunset, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-10** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.3, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.3, §6, for **CQW-10**.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- A RUNBOOK migration ledger listing every expand/contract pair with owner and exit criterion: U-03 (closed by U-27, U-27b), the ST-01c settings backfill, I-17's platform-IdP claim, LX-08's catch-up, LX-16 and LX-16b, I-28 and I-28b, P0-28 and P0-28b, A-27 and A-27b, PS-11, ST-25; the licensing rollback ladder (0105_licensing.down.sql valid only before LX-35's migration; each later migration ships its own down script); every deprecation window in calendar days with its production exit fact (break-glass, PKEY_ADMIN_COOKIE, SDK and Action aliases, Pocket ID env override); P0-49's job reports; delete the settings backfill runner, routes and console page once the owner has run it (owner step).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-10**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] Ledger exists with an exit criterion per row
- [x] Every window is stated in days with a production fact, never in releases
- [ ] Settings backfill code removed after the owner step (not met: the owner has not confirmed the production run; the ledger row stays open)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm --filter @polaris-key/docs build
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-24 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-24 done`.

## Verification against the code (2026-10-17)

- The ledger is the RUNBOOK section "Migration ledger" (`docs/RUNBOOK.md`), served at
  `/docs/operate/platform/runbook/migration-ledger/`. It is documentation and data, not a table or
  an API: P0-49's `data_migration_runs` and `data_migration_units` (migration 0122, Core-owned) are
  the record of each job report, read through `pkey migrate` and the existing admin route. No new
  migration, route or token scope.
- Entries are rows in the ledger's Entries table. The first is CM-29 section 3.5's pre-check
  (2026-10-17, 0 rows).
- The ledger sets one default the plans left open: a drop runs at least 14 days after the Worker
  that stopped using the object went live. The owner may change it.
- Not sunset (production state not verifiable here): the ST-01c settings backfill
  (`core/ops/settingsBackfill.ts`, its routes and console page; owner step), U-03's override
  migration (U-27 owns it) and the I-05 catch-up in `services/identity/accounts/legacy.ts` (the
  `LICENSE_WRITE_SEAMS` row names P0-24; it needs the fact that no pre-I-05 Worker serves).

## Status (2026-10-21)

`blocked` on the owner step: the ST-01c settings backfill has never run in production
(`settings_backfill_reports` had 0 rows on 2026-10-17). The owner runs it per product (dry run,
report, apply) with an explicit go; then the runner, its routes and console page are deleted and
the ledger row closes. The ledger itself is merged (`e306ea5c8`).
