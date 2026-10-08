# CM-13 Commerce emails: in your Library, gift received, access ending, access ended; optional dunning mail

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)      |
| Size        | 0.3–0.5 engineer-weeks                                                           |
| Depends on  | none                                                                             |
| Unblocks    | none                                                                             |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md)) |
| Gates       | `email-snapshots`, `docs:privacy`                                                |
| Human input | the owner's go signal (removes `deferred`)                                       |
| Repo        | `vladzaharia/polaris-key`                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [CM-05](CM-05-checkout-fulfilment.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [CM-05](CM-05-checkout-fulfilment.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Emails ride with their events on P0-21: fulfilment, refund and ended in CM-05; renewal and dunning in CM-08.

- Dependencies cleared on closing (they were CM-06, CM-08, CM-10 and I-18), so nothing in the graph waits on or through a closed package.

## Goal

Polaris Key sends the four access emails of S-22 §7.11 through `core/emailSender.ts`, and the failed-payment email only when `commerce.emails.dunning = polaris-key`; receipts and invoices remain the merchant's (Stripe).

## Why

Access changes need a notice; tax documents are the seller's ([S-22 §7.9](../../notes/S-22-polaris-key-commerce.md#79-receipts-and-invoices), D22).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.9](../../notes/S-22-polaris-key-commerce.md#79-receipts-and-invoices)
- [S-22 §7.11](../../notes/S-22-polaris-key-commerce.md#711-console-and-emails)
- `packages/worker/src/core/emailSender.ts`
- `docs/design/PORTAL.md` §6.3

## Scope

**In:**

- Templates, snapshots, triggers from fulfilment, gifting, cancellation and revocation.

**Out** (and where it belongs instead):

- Receipts and invoices (Stripe)

## Design notes

- Never mail the same person twice for one dunning event.

## Steps

1. Templates.
2. Triggers.
3. Snapshots.

## Acceptance criteria

- [ ] Each email has a snapshot and a trigger test.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-17 lists the emails in the privacy page.

The role agent sets `--set CM-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-13 done`.
