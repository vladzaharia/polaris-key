# CM-11 Customer portal commerce: Account → Billing (orders, subscriptions, invoices across developers), product-page buy / upgrade / gift / manage, Stripe Customer Portal hand-off per merchant

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                       |
| Size        | 1.2–1.6 engineer-weeks                                                                               |
| Depends on  | [CM-07](CM-07-tier-upgrades.md), [CM-08](CM-08-subscriptions.md), [LX-15](LX-15-portal-licensing.md) |
| Unblocks    | [CM-16](CM-16-storefront-integration.md), [CM-17](CM-17-commerce-closeout.md)                        |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                     |
| Gates       | `portal-e2e`, `ui-snapshots`, `rule-10`, `docs-links`, `console-csp-parity`                          |
| Human input | the owner's go signal (removes `deferred`)                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                            |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

The portal's Account → Billing lists every order and subscription a person has with any developer, with change, cancel and resume and a per-merchant "Payment methods and invoices" hand-off to Stripe's Customer Portal; the product page shows the buy, upgrade, subscribe, gift and manage actions and the "Bought on Polaris Key" source.

## Why

Stripe's portal is per account; only Polaris Key sees a person's purchases across developers ([S-22 §7.10](../../notes/S-22-polaris-key-commerce.md#710-the-customer-portal), D4).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.10](../../notes/S-22-polaris-key-commerce.md#710-the-customer-portal)
- `docs/design/PORTAL.md` §3, §4.20, §4.26, §6
- `plans/CM-01.md`

## Scope

**In:**

- PORTAL.md amendment (Billing section, product-page CTAs).
- Portal API reads for orders, subscriptions and invoice links; Stripe billing-portal session route.
- The `/buy/…` focused flows completed; PX-W6's purchase source shows `polaris-key`.

**Out** (and where it belongs instead):

- Storefront listing (→ CM-16)
- Console (→ CM-12)

## Design notes

- Copy says tier and subscription, never plan; amounts with currency code where ambiguous.
- No Stripe script on the portal origin (D3).

## Steps

1. PORTAL.md amendment.
2. API and UI.
3. e2e and snapshots in both themes.

## Acceptance criteria

- [ ] Billing shows orders from two merchants (e2e).
- [ ] Cancel then resume round-trips (e2e).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
```

## Hand-off

- CM-16 reuses the CTA components on the listing.

The role agent sets `--set CM-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-11 done`.
