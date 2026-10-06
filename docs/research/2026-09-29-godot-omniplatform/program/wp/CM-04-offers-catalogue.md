# CM-04 Offers, prices and coupons catalogue; idempotent Stripe Product/Price/Coupon sync; priced offers contributed to the S-21 obtain-path engine as `buy` / `upgrade` paths

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                      |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                |
| Depends on  | [CM-03](CM-03-merchants.md), [PS-03](PS-03-obtain-path-engine.md)                                                                                                                                   |
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

Operators define offers (base, add-on, seat pack, upgrade, bundle; one-time or subscription) with per-currency prices and coupons through the admin API; each syncs idempotently to the merchant's Stripe account; and the S-21 obtain-path engine (PS-03) receives every offer the viewer may buy as an `ObtainPath` of kind `offer` with `action: "buy"` or `"upgrade"` and a `price`, through a new single-provider method on Distribution's `delivery()` hook, `commercePaths(account, product)`, so who may buy and who may see stay one function.

## Why

Polaris Key owns the catalogue and Stripe mirrors it (D7, D10, D11, D20); S-21 §6.10 seams 1, 2 and 7 make a priced offer an obtain path, and its engine lives in the identity service, so commerce contributes through a Core hook method, not a cross-service import ([S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-the-s-21-seams-commerce-plugs-into), rule 6).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-the-s-21-seams-commerce-plugs-into)
- [S-22 §7.2](../../notes/S-22-polaris-key-commerce.md#72-offers-and-prices-on-storefront-listings)
- [S-22 §7.7](../../notes/S-22-polaris-key-commerce.md#77-add-ons-bundles-coupons-and-redeem-codes)
- `packages/worker/src/core/hooks.ts`
- [S-21 §6.3, §6.10](../../notes/S-21-polaris-storefront.md#610-seams-for-the-commerce-module-s-22) and [PS-03](PS-03-obtain-path-engine.md)
- `plans/CM-01.md`

## Scope

**In:**

- `dist_offers`, `dist_offer_prices`, `dist_coupons` and admin routes.
- Sync to Stripe Products, Prices, coupons and promotion codes on the merchant; immutable price rows.
- Validation: offer targets name declared flags and existing tiers; an upgrade offer's `toTier` must have a higher `tiers.rank` than `fromTier` (LX-08).
- `ObtainPathKind` gains `offer`; `ObtainPath.action` gains `buy` and `upgrade`; `ObtainPath` gains `price: {amount, currency, period?}` and `offerId`; `delivery().commercePaths(account, product)` implemented by Distribution and called by PS-03's engine. `upgrade` paths only for products the viewer holds, from a lower-rank tier.

**Out** (and where it belongs instead):

- Checkout (→ CM-05)
- Coupon redemption at checkout (→ CM-09)
- Console editors (→ CM-12)
- Listing UI (→ CM-16)

## Design notes

- Offers and prices are operator-only: no manifest field (LX-01 §3.1 precedent).
- A price change mints a new price; open subscriptions keep theirs (D11).
- `commercePaths` answers `[]` with commerce off, the product unlisted, or no active merchant; `buy` paths are listed only under `storefront.polarisKey.listed = listed` (or `auto` when the operator includes `offer` in `offerPaths`), so S-21's listing modes stay the only visibility switch.
- Evaluation order: `offer` paths come after every free path, so a person who can add a product for free is never shown Buy first.

## Steps

1. Tables and admin API.
2. Sync with recorded-response tests.
3. `commercePaths` and the engine's new kind, with PS-03's dry-run and no-enumeration tests extended.

## Acceptance criteria

- [ ] Re-running a sync creates no duplicate Stripe object (test).
- [ ] `commercePaths` answers `[]` with commerce off (test), and the engine's refusing-database dry-run test still passes with offers present.
- [ ] An offer naming an undeclared flag is refused (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- CM-05 builds checkouts from these rows; CM-16 renders `buy` / `upgrade` paths on the storefront.

The role agent sets `--set CM-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-04 done`.
