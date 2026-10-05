# U-11b Console Data tab, saves half: saves, history and restore

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                |
| Size        | 0.4–0.55 engineer-weeks                                                                  |
| Depends on  | [U-11a](U-11a-console-data-settings.md), [U-10](U-10-saves-backend.md)                   |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | console CSP parity; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                    |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the registry hub area (S-18) for the Cloud Sync data settings.

## Goal

The console's Data tab shows a subject's saves, their history, and restore under step-up.

## Why

Split from S-17's U-11 row (its saves half, 2 days) so the graph follows its phases ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); `docs/design/ADMIN.md`; [S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-11.

## Scope

**In:** saves list, revision history, restore; audit of every read of saves (T10).

**Out** (and where it belongs instead):

- Collections (→ U-11c).

## Design notes

- Step-up for restore and bulk restore.

## Steps

1. Admin routes. 2. Tab UI.

## Acceptance criteria

- [ ] Every save read is audited; restore needs step-up (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set U-11b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-11b done`.
