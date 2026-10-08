# ST-10 Cmd-K settings search, permission-filtered

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 2: experience)                                                             |
| Size        | 0.4–0.55 engineer-weeks                                                                                                          |
| Depends on  | [ST-06](ST-06-settings-docs-coverage.md), [ST-08](ST-08-product-settings-hub.md), [ST-29](ST-29-admin-route-table-can-usecan.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                           |
| Role        | `pkey-implementer`                                                                                                               |
| Plan mode   | no                                                                                                                               |
| Gates       | console CSP parity                                                                                                               |
| Human input | none                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Cmd-K results filtered by view permission.

- Title: was "⌘K settings search with filters and deep links".
- Depends on: added ST-29.
- UX rows that name this package: UX-06b (parked: entity search; revive when ST-10's settings search and the product switcher stop being enough (a third product or a support desk)).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: filtering through `useCan`.

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
