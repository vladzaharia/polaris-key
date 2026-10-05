# ST-06 `gen:settings`: generated settings reference page, ⌘K index and `--check`; `settings-coverage.test.ts` with a `PENDING` allow-list that only shrinks

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                  |
| Size        | 0.5–0.7 engineer-weeks                                                                                  |
| Depends on  | [ST-03](ST-03-settings-registry.md), [ST-02](ST-02-platform-inventory.md)                               |
| Unblocks    | [ST-10](ST-10-settings-search.md)                                                                       |
| Role        | `pkey-implementer`                                                                                      |
| Plan mode   | no                                                                                                      |
| Gates       | generated docs pages (`docs gen:check`; regenerate, never hand-edit); docsLinks; drift gate (`--check`) |
| Human input | none                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Goal

`gen:settings` generates the settings reference docs page and the ⌘K index from the registry, with `--check`; `settings-coverage.test.ts` fails when a setting exists without a registry entry, using a `PENDING` allow-list that may only shrink.

## Why

"Configure everything" stays true only if a gate catches a new setting with no home ([S-18 §4.13](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.13](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-06.

## Scope

**In:**

- Generator and `--check`; docs page; ⌘K index.
- Coverage test with the shrinking `PENDING` list.

**Out** (and where it belongs instead):

- The ⌘K UI (→ ST-10).

## Design notes

- Generated pages are regenerated, never hand-edited (rule 3).
- The coverage test fails on a listed-but-registered entry, so the list only shrinks.

## Steps

1. Generator.
2. Coverage test.
3. Wire into the gate.

## Acceptance criteria

- [ ] `gen:settings --check` passes and fails on a stale page.
- [ ] The coverage test fails on an entry that is both pending and registered.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:settings -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- ST-10 reads the index; ST-11, ST-14 and ST-25 shrink `PENDING`.

The role agent sets `--set ST-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-06 done`.
