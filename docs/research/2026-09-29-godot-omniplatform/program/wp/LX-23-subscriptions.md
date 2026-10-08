# LX-23 Store subscriptions: Apple and Play on Core subscriptions (required)

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase D: optional)                                                                                    |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                           |
| Depends on  | [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md), [LX-41](LX-41-durations-subscriptions-core-trials.md), [CM-29](CM-29-commerce-service.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-08](CM-08-subscriptions.md)                                                                                           |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                             |
| Plan mode   | yes: the plan [`plans/LX-23.md`](../plans/LX-23.md) needs human approval before code                                                                              |
| Gates       | plan mode; THREAT-MODEL; D1 migration (replayable, scratch-SQLite rehearsal)                                                                                      |
| Human input | plan approval (`plans/LX-23.md`); App Store Connect and Play Console sandbox subscriptions, for live checks (fixtures otherwise)                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Amendments from S-22 (2026-10-05)

The commerce plan [S-22](../../notes/S-22-polaris-key-commerce.md) (its packages are optional and deferred) changes this brief as follows. These amendments win over the text below where they differ.

- **Scope narrowed.** Stripe and Paddle web-checkout subscriptions move to [CM-08](CM-08-subscriptions.md) and the CM provider abstraction ([S-22 §6](../../notes/S-22-polaris-key-commerce.md#6-the-provider-abstraction), [§7.6](../../notes/S-22-polaris-key-commerce.md#76-subscriptions)). LX-23 keeps Apple auto-renewables, Play subscriptions and the shared dunning machinery: the `past_due` → `active` / `revoked` transitions, `grace_until` from `licensing.dunningGraceDays`, and unhiding that setting.
- **CM-08 depends on this package** for the dunning machinery; build it provider-neutral (no store-specific names in the state transitions) so CM-08 only adds Stripe's events.
- The human input no longer needs Stripe or Paddle test accounts.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Required now (owner asks for subscriptions): Apple auto-renewables and Play subscriptions as sources on LX-41's Core subscriptions; billing grace maps to past_due; free trials and introductory offers map to status trialing; its plan joins CM-20.

- Title: was "Subscriptions: Apple auto-renewables, Play subscriptions and the shared dunning machinery (`past_due`, `dunningGraceDays`); web-checkout subscriptions moved to CM-08 (S-22)".
- Depends on: added LX-41.
- Required now (was optional).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: executes §2.4 under a short plan of its own, which settles §2.4's three store facts. Plan mode stays, and so do the `sec` and `mig` gates. It adds `revokePurchase`'s subscription branch, the licence-delete blocker and the widened `expired → active` transition. No transcript.
- [`plans/LX-41.md`](../plans/LX-41.md) §13: writes through `core/licensing/subscriptions.ts`; a store's billing grace is `pastDue`'s `storeGraceEnd`; it adds the licence-delete blocker for live store subscriptions.
- [`plans/CM-29.md`](../plans/CM-29.md) §10: its code goes in `services/commerce/`, after CM-29.

## Goal

Optional: Apple auto-renewables and Play subscriptions become grant and licence sources, on a provider-neutral dunning machinery (`past_due`, `dunningGraceDays`) that CM-08 reuses for web checkout.

## Why

Decision 22 defers subscriptions until a product needs them; the model is ready ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 22).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-23.

## Scope

**In:**

- The plan; store subscription handling; provider-neutral dunning.

**Out** (and where it belongs instead):

- Anything a product does not need yet.
- Web-checkout (Stripe, Paddle) subscriptions (→ CM-08).

## Design notes

- `dunningGraceDays` default 0 (decision 21).

## Steps

1. Plan and approval.
2. Implementation with fixtures.

## Acceptance criteria

- [ ] Commerce tests and transcripts cover each source.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/durations`; `help/subscriptions`, `help/license-status`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## S-21 note (2026-10-05)

Web checkout (Stripe first) is designed in a separate plan, S-22, behind the Polaris Key
storefront. [S-21 §6.10](../../notes/S-21-polaris-storefront.md#610-seams-for-the-commerce-module-s-22) fixes the seams it plugs
into: priced obtain paths (`action: "buy" | "upgrade"`), the single issuance function
`issueFromPath`, grant source `polaris-key` and this package's lifecycle states. Map
checkout events onto those; add no parallel issuance path.

## Hand-off

- None.

The role agent sets `--set LX-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-23 done`.
