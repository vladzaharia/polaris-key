# CM-08 Polaris Key subscriptions on Core subscriptions (absorbs CM-07)

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                                                         |
| Size        | 1.4–1.9 engineer-weeks                                                                                                                                                                              |
| Depends on  | [LX-23](LX-23-subscriptions.md), [CM-05](CM-05-checkout-fulfilment.md), [LX-41](LX-41-durations-subscriptions-core-trials.md)                                                                       |
| Unblocks    | [CM-11](CM-11-portal-billing.md), [CM-12](CM-12-console-commerce.md)                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                    |
| Gates       | `migration`, `table-owners`, `rule-10`, `threat-model`, `workerd`                                                                                                                                   |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs CM-07. Stripe as one more source on LX-41's Core subscriptions, its trials as status trialing; drops renewalBufferHours (constant), trials.requirePaymentMethod and upgrades.proration (offer fields).

- Title: was "Subscriptions through Polaris Key checkout: base and add-on, trials, renewals with buffer, dunning on `past_due`, cancel at period end, resume, resubscribe on the same licence, proration on tier change".
- Depends on: added CM-05 and LX-41; removed CM-06.
- Absorbs CM-07: One-time and subscription tier changes share pricing and reversal rules.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/LX-41.md`](../plans/LX-41.md) §13: writes through `core/licensing/subscriptions.ts`; a store's billing grace is `pastDue`'s `storeGraceEnd`.

## Goal

Subscription offers sell through Checkout; a base subscription keeps one licence alive (`expires_at` = period end + buffer), an add-on subscription a grant; trials, failed renewals (`past_due`, `dunningGraceDays`), cancellation at period end, resume, resubscription reusing the same licence, and prorated tier changes all behave as S-22 §7.6 specifies.

## Why

Subscriptions are in the owner's request; LX-23's Stripe half moves here ([S-22 §7.6](../../notes/S-22-polaris-key-commerce.md#76-subscriptions), [S-22 §12](../../notes/S-22-polaris-key-commerce.md#12-brief-changes-and-proposed-amendments), D15–D17).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.5](../../notes/S-22-polaris-key-commerce.md#75-tier-upgrades-and-proration)
- [S-22 §7.6](../../notes/S-22-polaris-key-commerce.md#76-subscriptions)
- [`wp/LX-23-subscriptions.md`](LX-23-subscriptions.md) (amended)
- `plans/LX-01.md` §2.5, §3.2
- `plans/CM-01.md`

## Scope

**In:**

- `dist_subscriptions` and handlers for `invoice.paid`, `invoice.payment_failed`, `customer.subscription.*`.
- Portal and admin routes: change, cancel, resume; proration preview.
- Settings `commerce.subscriptions.renewalBufferHours`, `commerce.trials.requirePaymentMethod`, `commerce.upgrades.proration`; unhide `licensing.dunningGraceDays`.

**Out** (and where it belongs instead):

- Apple and Play subscriptions (→ LX-23)
- Portal UI (→ CM-11)

## Design notes

- Lapse is an expiry, not a revocation (`ended_reason` stays NULL).
- Grace is clamped to licence expiry by LX-07, hence the buffer.

## Steps

1. Table and lifecycle handlers.
2. Change, cancel, resume routes.
3. Tests per row of S-22 §7.6.

## Acceptance criteria

- [ ] Every row of S-22 §7.6 has a test.
- [ ] Resubscribing after a lapse keeps the licence id and enrolled devices (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-11 builds Manage subscription on these routes; CM-13 sends the access-ending email.

The role agent sets `--set CM-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-08 done`.
