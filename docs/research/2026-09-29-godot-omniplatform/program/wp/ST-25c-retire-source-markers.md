# ST-25c Retire the legacy ownership markers (the `*_source` columns)

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments)       |
| Size        | 0.4–0.6 engineer-weeks                                                                      |
| Depends on  | [ST-25](ST-25-legacy-retirement.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                      |
| Role        | `pkey-implementer`                                                                          |
| Plan mode   | no                                                                                          |
| Gates       | `migration`, `table-owners`                                                                 |
| Human input | none                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Goal

The `*_source` ownership markers (`core/settings/columns.ts:12-15`, `SOURCE_MARKERS` in `worker/scripts/settings-coverage.ts`) are retired in two releases through P0-49. Done when every acceptance criterion holds and the green gate passes.

## Why

Split out of ST-25 (lead decision D7, 2026-10-23). The markers still drive the resync's `WHERE … = 'manifest'` guards: about 85 references in 21 files. Retiring them changes who owns a value, which is a semantic switch and not a cleanup, so it follows the two-release DB contract (`tracks.md` rules 5 and 6; S-18 §4.3 kept and mapped the markers on purpose).

## Read first

- `AGENTS.md` (always).
- [ST-25](ST-25-legacy-retirement.md) Corrections (S7) and [P0-49](P0-49-data-migration-runner-dry-run-report.md).
- `worker/src/core/settings/columns.ts` and `SOURCE_MARKERS` in `worker/scripts/settings-coverage.ts`.

## Scope

**In:**

- Release N: prove marker-to-claim parity in production with P0-49's job report (every marker maps to a claim row with the same owner).
- Release N+1: remove the markers and the resync's marker guards; migrations with down scripts; `TABLE_OWNERS` and the data-model page regenerated.
- A security review: the resync ownership guard changes.

**Out** (and where it belongs instead):

- The other legacy names and stores (→ ST-25, ST-25b).

## Steps

1. Plan the two releases against P0-49's report shape.
2. Release N: the parity job and its production fact.
3. Release N+1: remove the guards and markers; run the green gate; hand off.

## Acceptance criteria

- [ ] The parity report shows zero diffs in production before the removal, recorded in the P0-24 ledger.
- [ ] No `*_source` marker or marker guard remains outside migrations/ and scripts/rollback/; `SOURCE_MARKERS` is gone.
- [ ] The migrations replay cleanly, and the down scripts restore the empty columns.
- [ ] A security review of the resync ownership guard is recorded.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- migrations boundaries settings-coverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set ST-25c in-review` when it hands off. After review, the lead adds the last
commit of the PR:

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-25c done
```
