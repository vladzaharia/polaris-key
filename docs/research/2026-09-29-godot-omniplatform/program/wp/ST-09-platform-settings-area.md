# ST-09 Console Platform settings area: Limits generated from code, Product defaults, Product policies matrix, feeds policy move

| Field       | Value                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 2: experience)                                                                                              |
| Size        | 1–1.4 engineer-weeks                                                                                                                                |
| Depends on  | [ST-07](ST-07-settings-row-v2.md), [ST-02](ST-02-platform-inventory.md)                                                                             |
| Unblocks    | [ST-11](ST-11-sql-only-settings.md), [ST-12](ST-12-api-only-settings.md), [ST-16](ST-16-platform-defaults.md), [ST-27](ST-27-alert-destinations.md) |
| Role        | `pkey-implementer`                                                                                                                                  |
| Plan mode   | no                                                                                                                                                  |
| Gates       | console CSP parity; docsLinks                                                                                                                       |
| Human input | none                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                           |

## Goal

The console has a Platform settings area with Limits generated from code, a Product defaults section, a Product policies matrix and the feeds policy moved into it.

## Why

Platform-wide values are scattered or invisible ([S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home)); [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux) specifies the area.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-09.

## Scope

**In:**

- Platform area routes; Limits page from ST-02's inventory (about 40 constants, read-only, D15); Product defaults; policies matrix; feeds policy move.

**Out** (and where it belongs instead):

- Live-inheritance fan-out (→ ST-16); SQL-only settings (→ ST-11).

## Design notes

- Limits are generated from code, never hand-maintained.

## Steps

1. Area and pages.
2. e2e and CSP parity.

## Acceptance criteria

- [ ] Limits match the inventory (test).
- [ ] Console CSP parity passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-11, ST-12, ST-16 and ST-27 add sections here.

The role agent sets `--set ST-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-09 done`.
