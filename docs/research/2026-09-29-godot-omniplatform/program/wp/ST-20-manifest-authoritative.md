# ST-20 Manifest-authoritative mode with expiring break-glass claims: on and locked for the system product (7-day claims), deploy-hook summary of live claims, webhook resync of the system product refused

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                 |
| Size        | 0.4–0.55 engineer-weeks                                                |
| Depends on  | [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md) |
| Unblocks    | none                                                                   |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | THREAT-MODEL                                                           |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

A product can be manifest-authoritative: console writes to claimable settings are refused except as expiring break-glass claims. It is on and locked for the system product `polaris-key`, whose break-glass claims last at most 7 days, and a webhook resync of the system product is refused.

## Why

The owner accepted manifest-authority for the system product ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 1: model C; the system product is manifest-authoritative with 7-day break-glass claims): two environments deployed from the same commit must have the same product settings, so the deploy hook is its only writer ([S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) items 7–8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) items 7–8, [S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-20.

## Scope

**In:**

- `core.manifest.authoritative`, locked `true` for `system = 1` by a registry rule; offered per product for customers (default off, D14).
- Break-glass claim: reason required, L2, `expires_at` = earlier of 7 days or the first apply that changes that field.
- Every resync and deploy summary lists live break-glass claims; webhook resync of `polaris-key` refused with "the system product is applied by the deploy hook".

**Out** (and where it belongs instead):

- The dry-run plan UI (→ ST-17).

## Design notes

- An apply that leaves the field alone does not end a claim, so an unrelated deploy cannot undo an incident fix.
- ST-01b refuses all console claims on `system = 1` until this lands.

## Steps

1. Registry rule and claim expiry.
2. Deploy-hook summary.
3. Webhook refusal; tests.

## Acceptance criteria

- [ ] A break-glass claim expires after 7 days or at the first apply that changes the field, whichever is first (test).
- [ ] A webhook resync of the system product is refused (test).
- [ ] The deploy-hook summary lists live claims (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-17's dry run shows break-glass claims.

The role agent sets `--set ST-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-20 done`.
