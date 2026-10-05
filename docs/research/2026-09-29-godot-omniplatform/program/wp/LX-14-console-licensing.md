# LX-14 Console licensing: Entitlements and Grants tabs, comp, trial, suppress and move actions, tier rank, catalog `combine` and `entitlementKind`, commerce mappings and restore policy, licensing report

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                          |
| Size        | 0.7–1 engineer-weeks                                                                                                                                                                  |
| Depends on  | [LX-06](LX-06-licensing-settings.md), [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md) |
| Unblocks    | none                                                                                                                                                                                  |
| Role        | `pkey-implementer`                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                    |
| Gates       | console CSP parity; docsLinks                                                                                                                                                         |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Goal

The console shows and manages the licensing model: Entitlements and Grants tabs on the licence record, comp, trial, suppress, move-grant and move-device actions, tier rank, catalog `combine` and `entitlementKind`, commerce mappings and restore policy, and the licensing (holder) report.

## Why

[S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface) specifies the console surface; ADMIN.md needs the matching amendment.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-14.
- `docs/design/ADMIN.md` §6.5.2, §6.5.3.

## Scope

**In:**

- Tabs, actions, editors, report page; ADMIN.md amendment (remove "stored, not enforced").

**Out** (and where it belongs instead):

- Portal (→ LX-15).

## Design notes

- Build in S-18's hub where it exists (ST-08); reuse ST-12's mapping editor.

## Steps

1. Tabs.
2. Actions.
3. Editors and report.

## Acceptance criteria

- [ ] Each action writes an audited change (tests).
- [ ] Console CSP parity passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set LX-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-14 done`.
