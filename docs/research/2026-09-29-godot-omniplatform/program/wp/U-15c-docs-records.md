# U-15c Cloud Sync docs, records half: collections guide

| Field       | Value                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                                                                  |
| Size        | 0.2–0.3 engineer-weeks                                                                                                                 |
| Depends on  | [U-15a](U-15a-docs-settings.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md) |
| Unblocks    | none                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                     |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                               |
| Gates       | `check:links`                                                                                                                          |
| Human input | none                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                              |

## Goal

Developers have a collections guide.

## Why

Split from S-17's U-15 row (its records half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); [S-17 §5.3](../../notes/S-17-user-data-sync.md#53-catalog-and-manifest-extension), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-15.

## Scope

**In:** the collections page.

**Out** (and where it belongs instead):

- None.

## Design notes

- Never hand-edit generated pages.

## Steps

1. Page.

## Acceptance criteria

- [ ] Page exists and links resolve.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- None.

The role agent sets `--set U-15c in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-15c done`.
