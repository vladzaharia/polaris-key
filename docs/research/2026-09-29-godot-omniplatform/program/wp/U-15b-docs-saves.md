# U-15b Cloud Sync docs, saves half: saves guide, Steam Cloud coexistence, Godot save security

| Field       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                                                  |
| Size        | 0.2–0.3 engineer-weeks                                                                                                     |
| Depends on  | [U-15a](U-15a-docs-settings.md), [U-13](U-13-saves-sdk-node-react-python.md), [U-25](U-25-saves-sdk-swift-kotlin-godot.md) |
| Unblocks    | none                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                         |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                   |
| Gates       | `check:links`                                                                                                              |
| Human input | none                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                  |

## Goal

Developers have a saves guide, guidance on coexisting with Steam Cloud, and Godot save-security guidance.

## Why

Split from S-17's U-15 row (its saves half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); [S-17 §5.14](../../notes/S-17-user-data-sync.md#514-threat-model-deltas) (T12), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-15.

## Scope

**In:** the saves pages.

**Out** (and where it belongs instead):

- Collections (→ U-15c).

## Design notes

- Never hand-edit generated pages.

## Steps

1. Pages.

## Acceptance criteria

- [ ] Pages exist and links resolve.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- None.

The role agent sets `--set U-15b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-15b done`.
