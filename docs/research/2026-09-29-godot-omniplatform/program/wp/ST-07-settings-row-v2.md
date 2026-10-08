# ST-07 SettingsRow v2: the one settings engine

| Field       | Value                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 2: experience)                                                                                                                                                                                                            |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                          |
| Depends on  | [ST-05a](ST-05a-one-settings-read-write-path.md), [P0-39](P0-39-console-sections-move-page-budget-lead.md)                                                                                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [U-11a](U-11a-console-data-settings.md), [ST-08](ST-08-product-settings-hub.md), [ST-09](ST-09-platform-settings-area.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                                                              |
| Gates       | visual baselines (both themes, phone); console CSP parity                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                       |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> SettingsRow v2 is the one settings engine in ui/settings/ for both scopes: useSettingWrite with conflict and Revert, read-only through useCan with Request access, the duplicated confirmLevel/formatSettingValue deleted. No new settings page before it lands. A console 'now' item: starts after the lead's window (P0-39).

- Title: was "Console `SettingsRow` v2: unified SourceBadge, history drawer, pre-save diff, confirmation level from the registry".
- Depends on: added ST-05a and P0-39; removed ST-05.
- UX rows that name this package: UX-28 (dropped: merged into ST-07 (pre-save diff) and ST-16 (fan-out confirm)).

## Goal

The console's `SettingsRow` v2 renders any registry setting with one SourceBadge vocabulary, a history drawer, a pre-save diff and the confirmation level the registry declares.

## Why

The UX audit found five source vocabularies and inconsistent confirmations ([S-18 §2.6](../../notes/S-18-settings-architecture.md#26-ux-audit-from-the-captures)); [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux) specifies the row.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.6](../../notes/S-18-settings-architecture.md#26-ux-audit-from-the-captures), [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-07.
- `docs/design/ADMIN.md` T4.

## Scope

**In:**

- `SettingsRow` v2 component, SourceBadge, history drawer, pre-save diff, confirm level from the registry.
- Unit and a11y tests; visual baselines in both themes and at phone width.

**Out** (and where it belongs instead):

- The hub and Platform area pages (→ ST-08, ST-09).

## Design notes

- Claim and Revert copy follows model C (owner D2).

## Steps

1. Component.
2. Tests and baselines.

## Acceptance criteria

- [ ] Unit and a11y tests pass.
- [ ] Visual baselines exist for both themes and phone width.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-08, ST-09 and ST-12 compose pages from it.

The role agent sets `--set ST-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-07 done`.
