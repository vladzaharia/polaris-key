# CM-09 Coupons and promotion codes at checkout: redemption, limits, subscription durations, 100 %-off path

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                      |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                              |
| Depends on  | [CM-05](CM-05-checkout-fulfilment.md)                                                                                                                                                               |
| Unblocks    | [CM-12](CM-12-console-commerce.md)                                                                                                                                                                  |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                    |
| Gates       | `rule-10`, `threat-model`                                                                                                                                                                           |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

Checkout accepts the product's promotion codes and link coupons with their offer restrictions, redemption limits, expiry and subscription durations; a 100 %-off coupon completes without payment and still fulfils.

## Why

Coupons are in the owner's request and distinct from LX-25 redeem codes ([S-22 §7.7](../../notes/S-22-polaris-key-commerce.md#77-add-ons-bundles-coupons-and-redeem-codes), D20).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.7](../../notes/S-22-polaris-key-commerce.md#77-add-ons-bundles-coupons-and-redeem-codes)
- `plans/CM-01.md`

## Scope

**In:**

- Coupon application in the checkout route; `commerce.checkout.allowPromotionCodes`; redemption counting from the ledger.

**Out** (and where it belongs instead):

- Coupon editor (→ CM-12)
- Redeem codes (→ LX-25)

## Design notes

- Errors to anonymous callers do not distinguish unknown from exhausted codes (CM-T10).

## Steps

1. Checkout integration.
2. Tests.

## Acceptance criteria

- [ ] An exhausted or expired code is refused (test).
- [ ] A 100 %-off order fulfils (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-12 edits coupons and shows redemptions.

The role agent sets `--set CM-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-09 done`.
