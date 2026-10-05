# CM-03 Merchants: the payment provider as a Store connection (Stripe Connect onboarding, status mirror), product → merchant, the `polaris-key` adapter's `pricing`/`iap` ops flipped to `first-party`, kill switch

| Field       | Value                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                                                                                  |
| Size        | 0.7–1 engineer-weeks                                                                                                                                                                                                                                            |
| Depends on  | [CM-02](CM-02-provider-webhooks.md), [PS-01](PS-01-polaris-key-adapter.md), [ST-04](ST-04-settings-resolver.md), [ST-05](ST-05-settings-admin-api.md), [ST-21](ST-21-capability-gate.md)                                                                        |
| Unblocks    | [CM-04](CM-04-offers-catalogue.md)                                                                                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                              |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                                                                                |
| Gates       | `migration`, `table-owners`, `rule-10`, `threat-model`, `console-csp-parity`, `docs-links`                                                                                                                                                                      |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise); G1 and G3 answers (merchant of record, merchant countries) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                       |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

Stripe appears in the console as one more connection (Platform → Store connections, a `PLATFORM_CREDENTIALS` slot for the platform account) and a product owner can connect their own Stripe account as a merchant (onboarding link, return, status); `charges_enabled` and requirements are mirrored from `account.updated`; a product maps to one merchant through the critical `commerce.merchant` setting; while a product has an active merchant the `polaris-key` storefront adapter's `pricing` and `iap` ops report `first-party` instead of `unsupported` (S-21 §6.10 seam 6), so the hub and readiness checklist need no new shape; the platform kill switch hides every commerce route.

## Why

Developer-as-seller through Connect direct charges is D1 ([S-22 §5](../../notes/S-22-polaris-key-commerce.md#5-merchant-of-record-and-the-multi-tenant-model)); every product must name the account it sells through, and changing it is a takeover risk (CM-T6).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §5](../../notes/S-22-polaris-key-commerce.md#5-merchant-of-record-and-the-multi-tenant-model)
- [S-22 §7.13](../../notes/S-22-polaris-key-commerce.md#713-settings-s-18-registry)
- [S-22 §8](../../notes/S-22-polaris-key-commerce.md#8-threat-model-pci-scope-privacy-and-retention)
- [S-18 §4.2](../../notes/S-18-settings-architecture.md#42-the-registry)
- `plans/CM-01.md`

## Scope

**In:**

- `commerce_merchants` (Core).
- The provider connection in Platform → Store connections; onboarding and status routes (admin API); `account.updated` handler.
- The `polaris-key` adapter's `pricing` / `iap` Support entries become `first-party` when the product has an active merchant (PS-01's declaration; the conformance branch's no-HTTP rule still holds for those ops, which read Polaris tables only).
- Registry rows `commerce.enabled`, `commerce.merchant`, `commerce.mode`, `commerce.platform.enabled`, `commerce.platform.applicationFeeBps`, `commerce.platform.merchantCountries`.
- Minimal console Merchant page (the full Commerce area is CM-12).
- Owner notification email on merchant change.

**Out** (and where it belongs instead):

- Offers (→ CM-04)
- Own-account mode (→ CM-19)

## Design notes

- `commerce.merchant` is critical, L3, product-owner capability only (ST-21), audited.
- Disconnecting a merchant stops new checkouts; existing grants are untouched.

## Steps

1. Table and onboarding flow.
2. Settings rows and kill switch.
3. Console page and email.

## Acceptance criteria

- [ ] A product without an active merchant answers not-found on every commerce route (test).
- [ ] Changing the merchant needs the owner capability and emails owners (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- CM-04 syncs offers to the product's merchant; CM-12 hosts the Merchant page in the Commerce area.

The role agent sets `--set CM-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-03 done`.
