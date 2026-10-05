# CM-07 One-time tier upgrades: `upgrade` paths by `tiers.rank`, a new licence with `superseded_by` (S-19 §7.6), difference pricing, eligible sources, refund reversal; add-on base-licence rule

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                   |
| Size        | 0.5–0.8 engineer-weeks                                                           |
| Depends on  | [CM-06](CM-06-refunds-disputes.md)                                               |
| Unblocks    | [CM-11](CM-11-portal-billing.md), [CM-12](CM-12-console-commerce.md)             |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md)) |
| Gates       | `threat-model`, `rule-10`                                                        |
| Human input | the owner's go signal (removes `deferred`)                                       |
| Repo        | `vladzaharia/polaris-key`                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

A person who holds a one-time licence on tier A sees an `upgrade` path to each higher-`rank` tier with an upgrade offer, pays the difference (or the explicit upgrade price), and receives a new licence on tier B with the old licence's `superseded_by` set (S-19 §7.6, S-21 §6.10 seam 5); signed-in devices see tier B's entitlements at their next document in `combined` mode, and seats move at the next activation; a refund or lost dispute of the upgrade order ends the new licence and clears `superseded_by`; store-sourced base licences are not upgradable by default.

## Why

"The ability to upgrade licenses" from the owner's request ([S-22 §7.5](../../notes/S-22-polaris-key-commerce.md#75-tier-upgrades-and-proration), D13, D14). S-21 fixes the lifecycle (no new states) and makes upgrade paths depend on `tiers.rank`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.5](../../notes/S-22-polaris-key-commerce.md#75-tier-upgrades-and-proration)
- [S-19 §7.5, §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles)
- [S-21 §6.10](../../notes/S-21-polaris-storefront.md#610-seams-for-the-commerce-module-s-22)
- `plans/LX-01.md` §2.4, §2.5
- `plans/CM-01.md`

## Scope

**In:**

- `upgrade` path evaluation in `commercePaths` (held product, lower-rank source licence, eligible source).
- The upgrade branch of `issueFromPath`: mint the new licence (same seats as the tier gives, `source = 'polaris-key'`), set `superseded_by` on the old one in the same batch.
- Price by `commerce.upgrades.oneTimePricing`; eligibility by `commerce.upgrades.eligibleSources`; `commerce.addons.requireBase`.
- Reversal on refund and lost dispute.

**Out** (and where it belongs instead):

- Subscription tier changes (→ CM-08)
- `reanchor: onRefresh` (→ LX-21)

## Design notes

- The old licence stays usable while devices still run on it (`superseded_by` may be set on an active licence, LX-01 §2.5); it is hidden from the Library.
- Devices move at their next activation through SIGN-IN.md's licence choice, where the new licence is preselected by rank (LX-10); under `onRefresh` (LX-21) they move silently.

## Steps

1. `upgrade` paths.
2. Issuance branch and reversal.
3. Tests.

## Acceptance criteria

- [ ] Upgrade then refund ends the new licence and clears `superseded_by` (test).
- [ ] No `upgrade` path is offered to a tier of equal or lower rank (test).
- [ ] A Steam-sourced licence is refused by default (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-11 and CM-16 render the `upgrade` path; CM-12 shows the superseded licence on the order.

The role agent sets `--set CM-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-07 done`.
