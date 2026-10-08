# LX-22 Licensing close-out on the new glossary

| Field       | Value                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (close)                                                |
| Size        | 0.3–0.4 engineer-weeks                                                                                            |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-11](LX-11-commerce-rework.md), [LX-13](LX-13-entitlements-backend.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                            |
| Role        | `pkey-implementer`                                                                                                |
| Plan mode   | no                                                                                                                |
| Gates       | generated docs pages (`docs gen:check`; regenerate, never hand-edit); THREAT-MODEL; privacy docs                  |
| Human input | an operator verifies `djdl` and `polaris-key` on production against the runbook                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                         |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W3.md`](../plans/PX-W3.md):** the THREAT-MODEL vocabulary uses "download ticket".

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Close-out on ST-37's glossary (add-on, limits, duration, keeps the last version, trial, consumable, automatic grant); THREAT-MODEL rows for consumable replay, fallback freeze and the external renewal API; developer pages use generated SDK tabs.

- Title: was "Licensing close-out: docs, glossary (rule 4), THREAT-MODEL T1–T10 and P1–P3, migration runbook, djdl and system-product verification".

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/LX-41.md`](../plans/LX-41.md) §13: the fallback-freeze and upsert THREAT-MODEL rows are LX-41's.

## Goal

The licensing model is documented and verified: docs, glossary (licence, unowned (floating), grant, anchor), THREAT-MODEL T1–T10 and P1–P3, the migration runbook, and production verification of `djdl` and `polaris-key`.

## Why

[S-19 §7.1](../../notes/S-19-licensing-model.md#71-vocabulary-rule-4-glossary-edits-in-lx-22) vocabulary, [S-19 §7.15](../../notes/S-19-licensing-model.md#715-threat-model-and-privacy-deltas-threat-model-edits-in-lx-22) threat and privacy deltas, [S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) runbook.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.1](../../notes/S-19-licensing-model.md#71-vocabulary-rule-4-glossary-edits-in-lx-22), [S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract), [S-19 §7.15](../../notes/S-19-licensing-model.md#715-threat-model-and-privacy-deltas-threat-model-edits-in-lx-22), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-22.

## Scope

**In:**

- Docs and glossary (rule 4); THREAT-MODEL edits; runbook; verification checklist.

**Out** (and where it belongs instead):

- Code changes.

## Design notes

- Concurrent-use "floating" stays out of scope; docs say "unowned (floating)" (decision 24).

## Steps

1. Docs.
2. THREAT-MODEL.
3. Runbook and verification.

## Acceptance criteria

- [ ] `docs gen:check` passes.
- [ ] THREAT-MODEL lists T1–T10 and P1–P3.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- None: closes Phase B.

The role agent sets `--set LX-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-22 done`.
