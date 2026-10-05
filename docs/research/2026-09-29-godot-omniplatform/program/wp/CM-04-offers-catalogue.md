# CM-04 Offers, prices and coupons catalogue; idempotent Stripe Product/Price/Coupon sync; the `commerceCatalog` Core hook for the storefront

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                      |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                |
| Depends on  | [CM-03](CM-03-merchants.md)                                                                                                                                                                         |
| Unblocks    | [CM-05](CM-05-checkout-fulfilment.md), [CM-16](CM-16-storefront-integration.md)                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                    |
| Gates       | `migration`, `table-owners`, `rule-10`, `rule-6`, `threat-model`, `docs-generated`                                                                                                                  |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

Operators define offers (base, add-on, seat pack, upgrade, bundle; one-time or subscription) with per-currency prices and coupons through the admin API; each syncs idempotently to the merchant's Stripe account; the storefront reads on-sale offers, display prices and what the viewer already owns through the null-when-off `commerceCatalog` hook.

## Why

Polaris Key owns the catalogue and Stripe mirrors it (D7, D10, D11, D20); S-21's listing needs prices through a Core hook, not a cross-service import ([S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-seams-assumed-from-s-21-to-reconcile-when-s-21-lands) seam S4, rule 6).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-seams-assumed-from-s-21-to-reconcile-when-s-21-lands)
- [S-22 §7.2](../../notes/S-22-polaris-key-commerce.md#72-offers-and-prices-on-storefront-listings)
- [S-22 §7.7](../../notes/S-22-polaris-key-commerce.md#77-add-ons-bundles-coupons-and-redeem-codes)
- `packages/worker/src/core/hooks.ts`
- S-21's note and listing package, if landed
- `plans/CM-01.md`

## Scope

**In:**

- `dist_offers`, `dist_offer_prices`, `dist_coupons` and admin routes.
- Sync to Stripe Products, Prices, coupons and promotion codes on the merchant; immutable price rows.
- Validation: offer targets name declared flags and existing tiers.
- `commerceCatalog(product, viewer)` in `core/hooks.ts`, implemented by Distribution.

**Out** (and where it belongs instead):

- Checkout (→ CM-05)
- Coupon redemption at checkout (→ CM-09)
- Console editors (→ CM-12)
- Listing UI (→ CM-16)

## Design notes

- Offers and prices are operator-only: no manifest field (LX-01 §3.1 precedent).
- A price change mints a new price; open subscriptions keep theirs (D11).
- When S-21 lands, add its listing package as a dependency here.

## Steps

1. Tables and admin API.
2. Sync with recorded-response tests.
3. Hook and its tests.

## Acceptance criteria

- [ ] Re-running a sync creates no duplicate Stripe object (test).
- [ ] The hook answers `null` with commerce off (test).
- [ ] An offer naming an undeclared flag is refused (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- CM-05 builds checkouts from these rows; CM-16 renders the hook's output.

The role agent sets `--set CM-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-04 done`.
