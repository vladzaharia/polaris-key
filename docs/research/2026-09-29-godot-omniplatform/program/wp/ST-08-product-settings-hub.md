# ST-08 Console product settings hub (`#/p/<slug>/settings/<area>`): All settings table, web-origins editor, legacy redirects, phone layout

| Field       | Value                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 2: experience)                                                                                                                                                                 |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                 |
| Depends on  | [ST-07](ST-07-settings-row-v2.md)                                                                                                                                                                                      |
| Unblocks    | [U-11a](U-11a-console-data-settings.md), [ST-10](ST-10-settings-search.md), [ST-12](ST-12-api-only-settings.md), [ST-13](ST-13-listing-in-hub.md), [ST-14](ST-14-portal-settings.md), [ST-17](ST-17-resync-dry-run.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                     |
| Gates       | console CSP parity; docsLinks                                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                              |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W17.md`](../plans/PX-W17.md):** call `applyServiceTransitions`, and show the dry-run count in the confirm.

## Goal

Each product has one settings hub at `#/p/<slug>/settings/<area>` with an All settings table, a web-origins editor, redirects from the old pages and a phone layout.

## Why

Product settings are spread over service pages today ([S-18 §2.6](../../notes/S-18-settings-architecture.md#26-ux-audit-from-the-captures)); [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux) defines the hub.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-08.
- `docs/design/ADMIN.md` §5.2, §5.10, §6.9.

## Scope

**In:**

- Hub routes and areas; All settings table; web-origins editor; legacy redirects with a "Moved to Settings" banner for one release.

**Out** (and where it belongs instead):

- Search (→ ST-10); listing (→ ST-13); portal area (→ ST-14).

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 5 entries below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:product_keys` (`core.keys`)
- `table:product_secrets` (`core.secrets`: ST-19b registered this entry, pending on ST-08, with
  names only and storage `none`. Extend it with the `product_secrets` adapter and its readers,
  and drop its `pending`; do not register it again)
- `table:release_channel_floors` (`release.channelFloors`)
- `table:release_pack_floors` (`release.channelFloors`, packs)
- `column:release_pack_floors.source`

## Design notes

- U-11a's Cloud Sync section and I-12's sign-in settings land in the hub, so ST-08 precedes them.

## Steps

1. Routes and redirects.
2. Areas and table.
3. e2e and CSP parity.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 5 lower, and `settings-coverage.test.ts` passes.
- [ ] Old deep links redirect (e2e).
- [ ] Console CSP parity passes.
- [ ] The hub renders at phone width.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-10, ST-12, ST-13, ST-14, ST-17 and U-11a build into the hub.

The role agent sets `--set ST-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-08 done`.
