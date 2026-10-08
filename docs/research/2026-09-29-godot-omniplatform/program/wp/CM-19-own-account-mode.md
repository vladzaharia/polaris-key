# CM-19 Own-account mode: a Stripe Managed Payments provider (Stripe as merchant of record) for developers who choose it, only if the owner says yes to G5

| Field       | Value                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                                                                                     |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                          |
| Depends on  | [CM-05](CM-05-checkout-fulfilment.md), [CM-17](CM-17-commerce-closeout.md)                                                                                                                                                      |
| Unblocks    | none                                                                                                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                                                              |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                                                |
| Gates       | `threat-model`, `docs:privacy`, `migration`                                                                                                                                                                                     |
| Human input | the owner's go signal (removes `deferred`); the owner's yes to S-22 G5; a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                       |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive after v1 if asked. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Own-account mode with Stripe as merchant of record (owner G5). Revive after v1 if asked.

## Goal

Only if the owner chooses to: a second provider mode in which a developer's own Stripe account (restricted key stored as a product secret, not Connect) sells through Checkout with Managed Payments, so Stripe is the merchant of record and handles tax, while fulfilment and revocation are unchanged.

## Why

Managed Payments does not support Connect, so it needs its own mode ([S-22 §5](../../notes/S-22-polaris-key-commerce.md#5-merchant-of-record-and-the-multi-tenant-model), G5).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §5](../../notes/S-22-polaris-key-commerce.md#5-merchant-of-record-and-the-multi-tenant-model)
- [S-22 §6](../../notes/S-22-polaris-key-commerce.md#6-the-provider-abstraction)
- Stripe Managed Payments eligibility (S-22 §13)

## Scope

**In:**

- The `stripe-own-account` provider module, the per-product secret, webhook intake per account.

**Out** (and where it belongs instead):

- Connect changes

## Design notes

- Managed Payments needs Checkout or Payment Links, no embedded components, and creates subscriptions only through Checkout.

## Steps

1. Provider module.
2. Secret handling and intake.
3. Tests.

## Acceptance criteria

- [ ] The same fulfilment tests pass on both provider modes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set CM-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-19 done`.
