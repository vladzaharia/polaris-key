# CM-08 Subscriptions through Polaris Key checkout: base and add-on, trials, renewals with buffer, dunning on `past_due`, cancel at period end, resume, resubscribe on the same licence, proration on tier change

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                      |
| Size        | 1.4–1.9 engineer-weeks                                                                                                                                                                              |
| Depends on  | [CM-06](CM-06-refunds-disputes.md), [LX-23](LX-23-subscriptions.md)                                                                                                                                 |
| Unblocks    | [CM-11](CM-11-portal-billing.md), [CM-12](CM-12-console-commerce.md), [CM-13](CM-13-commerce-emails.md)                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                    |
| Gates       | `migration`, `table-owners`, `rule-10`, `threat-model`, `workerd`                                                                                                                                   |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

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
