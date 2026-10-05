# CM-13 Commerce emails: in your Library, gift received, access ending, access ended; optional dunning mail

| Field       | Value                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                 |
| Size        | 0.3–0.5 engineer-weeks                                                                                                         |
| Depends on  | [CM-06](CM-06-refunds-disputes.md), [CM-08](CM-08-subscriptions.md), [CM-10](CM-10-gifting.md), [I-18](I-18-email-delivery.md) |
| Unblocks    | [CM-17](CM-17-commerce-closeout.md)                                                                                            |
| Role        | `pkey-implementer`                                                                                                             |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                               |
| Gates       | `email-snapshots`, `docs:privacy`                                                                                              |
| Human input | the owner's go signal (removes `deferred`)                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                      |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

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
