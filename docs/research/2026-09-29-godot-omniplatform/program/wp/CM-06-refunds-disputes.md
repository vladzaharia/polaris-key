# CM-06 Refunds, disputes and revocation: console refund action, `charge.refunded` / dispute handlers, LX-12 states, partial-refund and open-dispute policies, bundle `order_ref` revocation

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                                                         |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                |
| Unblocks    | none                                                                                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                    |
| Gates       | `rule-10`, `threat-model`, `workerd`                                                                                                                                                                |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [CM-05](CM-05-checkout-fulfilment.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [CM-05](CM-05-checkout-fulfilment.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One fulfil-and-reverse state machine.

- Dependencies cleared on closing (they were CM-05), so nothing in the graph waits on or through a closed package.

## Goal

A full refund (from the console or the developer's Stripe Dashboard) revokes exactly what the order produced, with `refundGraceHours`; a partial refund revokes nothing by default; an opened dispute keeps or suspends access per setting; a lost dispute revokes with no grace and `ended_reason = chargeback`.

## Why

Refunds revoking per S-19 decisions is the other half of selling ([S-22 §7.4](../../notes/S-22-polaris-key-commerce.md#74-refunds-disputes-and-revocation), D18, D19).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.4](../../notes/S-22-polaris-key-commerce.md#74-refunds-disputes-and-revocation)
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles)
- `plans/LX-01.md` §2.5
- `plans/CM-01.md`

## Scope

**In:**

- Admin refund route (full or partial, reason, idempotency key).
- Handlers for refunds and disputes; order states.
- Settings `commerce.refunds.partialRevokes`, `commerce.disputes.onOpen`.

**Out** (and where it belongs instead):

- Gift-code voiding (→ CM-10)
- Upgrade reversion (→ CM-07)
- Console UI (→ CM-12)

## Design notes

- A flag stays held when another grant or licence gives it.
- Polaris Key never moves money; refunds debit the merchant's balance.

## Steps

1. Route and handlers.
2. Tests per row of S-22 §7.4.

## Acceptance criteria

- [ ] Every row of S-22 §7.4 has a test.
- [ ] A refund made in the Stripe Dashboard revokes the same as one made in the console (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-07, CM-08 and CM-10 add their own revocation effects to the same handlers.

The role agent sets `--set CM-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-06 done`.
