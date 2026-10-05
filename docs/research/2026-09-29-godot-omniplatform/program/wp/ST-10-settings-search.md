# ST-10 ⌘K settings search with filters and deep links

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 2: experience)                           |
| Size        | 0.4–0.55 engineer-weeks                                                          |
| Depends on  | [ST-06](ST-06-settings-docs-coverage.md), [ST-08](ST-08-product-settings-hub.md) |
| Unblocks    | none                                                                             |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | console CSP parity                                                               |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Goal

⌘K finds any setting by name, key or description, filters by scope and area, and deep-links to its row.

## Why

About 170 registry entries need search to be usable ([S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-10.

## Scope

**In:**

- Palette provider over ST-06's index; filters; deep links.

**Out** (and where it belongs instead):

- None beyond the palette.

## Design notes

- The index is generated; the palette never hard-codes entries.

## Steps

1. Provider.
2. Tests.

## Acceptance criteria

- [ ] Palette tests cover filtering and deep links.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set ST-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-10 done`.
