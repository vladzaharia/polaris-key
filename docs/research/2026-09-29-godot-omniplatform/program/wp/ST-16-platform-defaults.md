# ST-16 Platform defaults and policies: live inheritance with fan-out preview and L2 confirm (D5), enforce or delegate, clamped-value display; licence defaults, key-entry maximum, Cloud Sync ceilings

| Field       | Value                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings architecture (S-18) (phase 3: coverage)                                                         |
| Size        | 0.6–0.85 engineer-weeks                                                                                      |
| Depends on  | [ST-09](ST-09-platform-settings-area.md), [ST-04](ST-04-settings-resolver.md), [U-05](U-05-cloud-sync-do.md) |
| Unblocks    | none                                                                                                         |
| Role        | `pkey-implementer`                                                                                           |
| Plan mode   | no                                                                                                           |
| Gates       | THREAT-MODEL; console CSP parity                                                                             |
| Human input | none                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                    |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the three Cloud Sync ceiling entries.

## Goal

Platform defaults and policies apply to product settings: platform values inherit live with a fan-out preview and an L2 confirm, entries offer enforce or delegate where they allow a lock, and clamped values are displayed. Covers licence defaults, the key-entry maximum and the Cloud Sync ceilings.

## Why

The owner accepted live inheritance ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 2: live inheritance with a fan-out preview and an L2 confirm). [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance) defines cascade, policy and clamps.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance), [S-18 §5.4](../../notes/S-18-settings-architecture.md#54-s-17--u-01-cloud-sync), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-16.

## Scope

**In:**

- `inherits`, enforce/delegate, fan-out counts, L2 on propagation, per-product audit rows with `origin = 'platform'`, "Clamped by Platform" display.
- Licence defaults, key-entry max, Cloud Sync ceilings (after U-05).

**Out** (and where it belongs instead):

- "Copy settings from product" one-time template (→ ST-23).

## Design notes

- Policy bounds sit on the permissive side only; a platform write never rewrites product rows, it clamps them.

## Steps

1. Resolver tests on bound direction.
2. UI and fan-out preview.

## Acceptance criteria

- [ ] A platform change shows the affected product count and needs L2 (e2e).
- [ ] Clamped values display both set and effective (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set ST-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-16 done`.
