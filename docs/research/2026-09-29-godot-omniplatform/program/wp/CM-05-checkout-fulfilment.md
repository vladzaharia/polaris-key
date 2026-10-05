# CM-05 Checkout and fulfilment for one-time purchases: portal checkout route, hosted Stripe Checkout (direct charge, Stripe Tax), fulfil-on-return and on-webhook, grants with source `polaris-key`

| Field       | Value                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                                                                                               |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                                                       |
| Depends on  | [CM-04](CM-04-offers-catalogue.md), [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [LX-12](LX-12-licence-lifecycle.md), [LX-13](LX-13-entitlements-backend.md)                                                                                     |
| Unblocks    | [CM-06](CM-06-refunds-disputes.md), [CM-09](CM-09-coupons.md), [CM-14](CM-14-device-checkout-wire.md), [CM-19](CM-19-own-account-mode.md)                                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                           |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                                                                                             |
| Gates       | `migration`, `table-owners`, `rule-10`, `rule-6`, `threat-model`, `docs:privacy`, `portal-e2e`, `workerd`                                                                                                                                                                    |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise); the G1 legal review and G4 waiver wording before the first live payment |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                    |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

A signed-in person buys a one-time offer through hosted Stripe Checkout on the developer's account; the order is fulfilled exactly once whether the return page or the webhook arrives first; a base offer mints a licence, an add-on an account-held grant, a seat pack a licence-held grant, all with source `polaris-key`, and the holder version bump emits `entitlements.changed`.

## Why

This is the core of "charge directly from within" ([S-22 §7.3](../../notes/S-22-polaris-key-commerce.md#73-checkout-and-fulfilment-one-time-purchases), D3, D8, D9, D12).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.3](../../notes/S-22-polaris-key-commerce.md#73-checkout-and-fulfilment-one-time-purchases)
- [S-22 §8](../../notes/S-22-polaris-key-commerce.md#8-threat-model-pci-scope-privacy-and-retention)
- [S-19 §7.2](../../notes/S-19-licensing-model.md#72-data-model), [§7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles)
- `plans/LX-01.md` §2.5, §6.1
- `plans/CM-01.md`

## Scope

**In:**

- `dist_orders`, `dist_order_lines`, `commerce_customers`.
- `POST /api/commerce/checkout`, `POST /api/commerce/orders/<id>/fulfil`, the `/buy/…` focused-flow pages (minimal; CM-11 completes the UI).
- `fulfilOrder()` state machine; writes only through `core/grants.ts` and the licence writer.
- Stripe Tax, tax codes, invoice creation per setting, waiver consent per setting.

**Out** (and where it belongs instead):

- Refunds (→ CM-06)
- Upgrades (→ CM-07)
- Subscriptions (→ CM-08)
- Device hand-off route (→ CM-14)

## Design notes

- The client sends an offer id, never an amount (CM-T4).
- Sign-in required; no guest checkout (D8).
- Success and cancel URLs are fixed portal paths (CM-T9).

## Steps

1. Ledger tables.
2. Checkout route and Stripe session.
3. Fulfilment from both entry points.
4. Portal e2e with recorded Stripe responses.

## Acceptance criteria

- [ ] Return-then-webhook and webhook-then-return each fulfil once (tests).
- [ ] A base offer mints a licence with `source = polaris-key` and `external_ref_hash` (test).
- [ ] An event for another merchant's account is refused (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- CM-06 to CM-10 extend `fulfilOrder` and the order state machine.

The role agent sets `--set CM-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-05 done`.
