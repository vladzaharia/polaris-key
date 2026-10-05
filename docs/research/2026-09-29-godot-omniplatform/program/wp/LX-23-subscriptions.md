# LX-23 Subscriptions: Apple auto-renewables, Play subscriptions, dunning (`past_due`, `dunningGraceDays`), Stripe and Paddle webhooks as grant and licence sources

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase D: optional)                                                                                       |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                              |
| Depends on  | [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md)                                                                                               |
| Unblocks    | none                                                                                                                                                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                |
| Plan mode   | yes: the plan [`plans/LX-23.md`](../plans/LX-23.md) needs human approval before code                                                                                 |
| Gates       | plan mode; THREAT-MODEL; D1 migration (replayable, scratch-SQLite rehearsal)                                                                                         |
| Human input | plan approval (`plans/LX-23.md`); App Store Connect and Play Console sandbox subscriptions, and Stripe or Paddle test accounts, for live checks (fixtures otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Goal

Optional: Apple auto-renewables, Play subscriptions, dunning (`past_due`, `dunningGraceDays`) and Stripe or Paddle webhooks become grant and licence sources.

## Why

Decision 22 defers subscriptions until a product needs them; the model is ready ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 22).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-23.

## Scope

**In:**

- The plan; store subscription handling; dunning; web checkout webhooks.

**Out** (and where it belongs instead):

- Anything a product does not need yet.

## Design notes

- `dunningGraceDays` default 0 (decision 21).

## Steps

1. Plan and approval.
2. Implementation with fixtures.

## Acceptance criteria

- [ ] Commerce tests and transcripts cover each source.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-23 done`.
