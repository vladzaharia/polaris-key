# LX-15 Portal licensing: what you own with sources, licence cards, Apply to a licence, downloads on the resolver; PORTAL.md amendment

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)               |
| Size        | 0.5–0.7 engineer-weeks                                                                                     |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [PX-W6](PX-W6-purchase-source.md) |
| Unblocks    | none                                                                                                       |
| Role        | `pkey-implementer`                                                                                         |
| Plan mode   | no                                                                                                         |
| Gates       | portal e2e                                                                                                 |
| Human input | none                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W17.md`](../plans/PX-W17.md):** use `identityEnabled` to decide whether to create licence-held grants.

## Goal

The portal shows what a person owns with sources, licence cards, "Apply to a licence", and downloads on the resolver; PORTAL.md is amended.

## Why

[S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface); PX-W6 reads `grants` after LX-09's switch ([S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-15.
- `docs/design/PORTAL.md` §1, §3.1, §5.3.

## Scope

**In:**

- Portal views; downloads through `resolveDeviceEntitlements`; PORTAL.md edits (status precedence adds `refunded` and `superseded`).

**Out** (and where it belongs instead):

- "Run this device on" (→ LX-21).

## Design notes

- Copy uses "licence" in prose, `license` in UI copy (rule 4).

## Steps

1. Views.
2. Downloads.
3. PORTAL.md.

## Acceptance criteria

- [ ] Library shows source badges (portal e2e).
- [ ] Downloads honour the effective set (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-15 done`.
