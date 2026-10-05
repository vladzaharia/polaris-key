# CM-07 One-time tier upgrades: in-place, revertible tier change tied to the order, difference pricing, eligible sources; add-on base-licence rule

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                   |
| Size        | 0.5–0.8 engineer-weeks                                                           |
| Depends on  | [CM-06](CM-06-refunds-disputes.md)                                               |
| Unblocks    | [CM-11](CM-11-portal-billing.md), [CM-12](CM-12-console-commerce.md)             |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md)) |
| Gates       | `migration`, `table-owners`, `threat-model`                                      |
| Human input | the owner's go signal (removes `deferred`)                                       |
| Repo        | `vladzaharia/polaris-key`                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

A person upgrades a one-time licence from tier A to tier B through checkout; the licence keeps its id (no device re-activation), the change is recorded in `dist_license_tier_changes`, and a refund or lost dispute of the upgrade order reverts it; store-sourced base licences are not upgradable by default.

## Why

"The ability to upgrade licenses" from the owner's request ([S-22 §7.5](../../notes/S-22-polaris-key-commerce.md#75-tier-upgrades-and-proration), D13, D14). This amends S-19 §7.6 for checkout upgrades; the lead applies the proposed amendment ([S-22 §12](../../notes/S-22-polaris-key-commerce.md#12-brief-changes-and-proposed-amendments)) before this package starts.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.5](../../notes/S-22-polaris-key-commerce.md#75-tier-upgrades-and-proration)
- [S-22 §12](../../notes/S-22-polaris-key-commerce.md#12-brief-changes-and-proposed-amendments)
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles)
- `plans/CM-01.md`

## Scope

**In:**

- `dist_license_tier_changes`.
- Upgrade offers in checkout; price by `commerce.upgrades.oneTimePricing`.
- Eligibility by `commerce.upgrades.eligibleSources`; `commerce.addons.requireBase`.

**Out** (and where it belongs instead):

- Subscription tier changes (→ CM-08)

## Design notes

- Reverting a superseded change asks the developer instead of guessing.

## Steps

1. Table and fulfilment branch.
2. Revert on refund and chargeback.
3. Tests.

## Acceptance criteria

- [ ] Upgrade then refund returns the licence to tier A (test).
- [ ] A Steam-sourced licence is refused by default (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-11 shows Upgrade on the product page; CM-12 shows tier changes on the order.

The role agent sets `--set CM-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-07 done`.
