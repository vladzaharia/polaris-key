# ST-16 Live platform defaults with fan-out confirm (trimmed)

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage)            |
| Size        | 0.6–0.85 engineer-weeks                                                       |
| Depends on  | [ST-09](ST-09-platform-settings-area.md), [ST-04](ST-04-settings-resolver.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                        |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | THREAT-MODEL; console CSP parity                                              |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the three Cloud Sync ceiling entries.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Keep live platform defaults with the fan-out count and L2 confirm; drop enforce/delegate per entry and the products-policies matrix. No longer waits for U-05: U-05 registers its own Cloud Sync rows (cloudSync.ceiling.bytes and writesPaused). Platform-wide service restriction (owner brief 'restrict features ... platform-wide') stays deferred; revive here as one platform policy row when a deployment needs to switch a service off for every product.

- Title: was "Platform defaults and policies: live inheritance with fan-out preview and L2 confirm (D5), enforce or delegate, clamped-value display; licence defaults, key-entry maximum, Cloud Sync ceilings".
- Depends on: removed U-05.
- UX rows that name this package: UX-28 (dropped: merged into ST-07 (pre-save diff) and ST-16 (fan-out confirm)).

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
