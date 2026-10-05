# LX-22 Licensing close-out: docs, glossary (rule 4), THREAT-MODEL T1–T10 and P1–P3, migration runbook, djdl and system-product verification

| Field       | Value                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (close)                                                |
| Size        | 0.3–0.4 engineer-weeks                                                                                            |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-11](LX-11-commerce-rework.md), [LX-13](LX-13-entitlements-backend.md) |
| Unblocks    | none                                                                                                              |
| Role        | `pkey-implementer`                                                                                                |
| Plan mode   | no                                                                                                                |
| Gates       | generated docs pages (`docs gen:check`; regenerate, never hand-edit); THREAT-MODEL; privacy docs                  |
| Human input | an operator verifies `djdl` and `polaris-key` on production against the runbook                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                         |

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
