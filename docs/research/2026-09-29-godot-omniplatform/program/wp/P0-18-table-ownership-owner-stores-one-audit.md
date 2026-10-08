# P0-18 Table ownership, owner stores and one audit writer (absorbs ST-24)

| Field       | Value                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                           |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                                                                                                                        |
| Unblocks    | [P0-24](P0-24-migration-ledger-one-time-machinery.md), [P0-26](P0-26-core-manifest-ingest-pipeline.md), [P0-28](P0-28-one-sealed-credential-store-resolver.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md), [P0-51](P0-51-1-0-readiness-review.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                                             |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                      |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-04** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Absorbs ST-24: Keep-latest-per-setting retention and NDJSON export are properties of the one audit writer.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: the `console_role_bindings` owner row.

## Goal

Table ownership, owner stores and one audit writer (absorbs ST-24), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-04** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, §4.4, for **CQW-04**.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- db/owners.ts (the data-model generator imports it), a SEAMS allow-list, writer-location and table-crossing tests seeded with today's 17 crossings each tagged with the package that removes it; split repo.ts and admin/repo.ts into owner stores; Identity's licenses writes move behind core/licensing; one auditStatement builder plus actorOf and SYSTEM_ACTORS replace 8 helpers and 13 raw INSERT INTO audit; ST-24's keep-latest-per-setting retention and NDJSON export; AGENTS.md rule 6 amended to cover tables.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-04**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Table-crossing test blocking with a shrinking allow-list
- [ ] One audit writer (grep test)
- [ ] ST-24's retention acceptance met
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-18 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-18 done`.
