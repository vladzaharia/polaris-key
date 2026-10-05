# ST-15 Hard-coded product policy into the registry (D7): seat dormancy, blob GC keep-N, feed depths, registry-token caps, portal presentation, shorten-only sessions and retention

| Field       | Value                                                |
| ----------- | ---------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 3: coverage) |
| Size        | 0.7–1 engineer-weeks                                 |
| Depends on  | [ST-04](ST-04-settings-resolver.md)                  |
| Unblocks    | none                                                 |
| Role        | `pkey-implementer`                                   |
| Plan mode   | no                                                   |
| Gates       | THREAT-MODEL                                         |
| Human input | none                                                 |
| Repo        | `vladzaharia/polaris-key`                            |

## Goal

The hard-coded product policies chosen in D7 become registry settings: seat dormancy (also per tier), blob GC keep-N, feed depths, registry-token caps, portal presentation, shorten-only sessions and retention.

## Why

D7 lists which constants become per-product settings and which stay code ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-15, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D7.

## Scope

**In:**

- Registry entries and readers switched for each D7 item; bounds at today's maxima.

**Out** (and where it belongs instead):

- Constants kept as code (rate limits, TTLs, body caps, wire constants).

## Design notes

- Shorten-only entries can never exceed the code value.
- THREAT-MODEL review per entry.

## Steps

1. One entry at a time with a reader test.

## Acceptance criteria

- [ ] Each reader honours its setting and its bound (test per entry).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set ST-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-15 done`.
