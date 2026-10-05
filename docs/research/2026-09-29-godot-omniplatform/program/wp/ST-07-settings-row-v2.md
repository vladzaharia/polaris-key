# ST-07 Console `SettingsRow` v2: unified SourceBadge, history drawer, pre-save diff, confirmation level from the registry

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 2: experience)                           |
| Size        | 0.8–1.1 engineer-weeks                                                           |
| Depends on  | [ST-05](ST-05-settings-admin-api.md)                                             |
| Unblocks    | [ST-08](ST-08-product-settings-hub.md), [ST-09](ST-09-platform-settings-area.md) |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | visual baselines (both themes, phone); console CSP parity                        |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

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
