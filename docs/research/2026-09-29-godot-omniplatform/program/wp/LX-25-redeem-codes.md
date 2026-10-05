# LX-25 Redeem and gift codes that create a grant on the redeemer's holder

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase D: optional)       |
| Size        | 0.5–0.7 engineer-weeks                                                               |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-11](LX-11-commerce-rework.md)                |
| Unblocks    | none                                                                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                |
| Plan mode   | yes: the plan [`plans/LX-25.md`](../plans/LX-25.md) needs human approval before code |
| Gates       | plan mode; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`)        |
| Human input | plan approval (`plans/LX-25.md`)                                                     |
| Repo        | `vladzaharia/polaris-key`                                                            |

## Goal

Optional: redeem and gift codes create a grant on the redeemer's holder.

## Why

Decisions 11 and 20: add-on keys and customer gifting via codes ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 11, decision 20).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-25.

## Scope

**In:**

- The plan; code minting and redeem route (OpenAPI, `routeCoverage`); SDK parity.

**Out** (and where it belongs instead):

- Licence transfer (unchanged).

## Design notes

- Plan mode: a new device-facing route across SDKs.

## Steps

1. Plan and approval.
2. Route.
3. SDKs.

## Acceptance criteria

- [ ] Redeeming creates a grant on the redeemer's holder (test).
- [ ] Parity passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None.

The role agent sets `--set LX-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-25 done`.
