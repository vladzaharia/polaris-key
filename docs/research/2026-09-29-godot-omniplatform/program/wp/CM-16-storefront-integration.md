# CM-16 Storefront integration: price block, buy / upgrade / subscribe / gift CTA states on the S-21 listing, owned-elsewhere, 3.1.3(b) guard

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                   |
| Size        | 0.5–0.8 engineer-weeks                                                           |
| Depends on  | [CM-04](CM-04-offers-catalogue.md), [CM-11](CM-11-portal-billing.md)             |
| Unblocks    | [CM-17](CM-17-commerce-closeout.md)                                              |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md)) |
| Gates       | `portal-e2e`, `ui-snapshots`                                                     |
| Human input | the owner's go signal (removes `deferred`)                                       |
| Repo        | `vladzaharia/polaris-key`                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

The S-21 storefront listing shows prices from `commerceCatalog`, fills the reserved `buy` and `upgrade` CTA states, says "Owned (Steam)" when the resolver already holds the item, and never offers Polaris Key checkout where the listing's outlet rules forbid it.

## Why

The storefront is where people meet the price ([S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-seams-assumed-from-s-21-to-reconcile-when-s-21-lands) seams S2–S4, S6).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-seams-assumed-from-s-21-to-reconcile-when-s-21-lands)
- [S-22 §7.2](../../notes/S-22-polaris-key-commerce.md#72-offers-and-prices-on-storefront-listings)
- [S-22 §7.14](../../notes/S-22-polaris-key-commerce.md#714-coexistence-with-store-commerce)
- S-21's note and listing package

## Scope

**In:**

- Listing price block, CTA states, signed-out "Sign in to buy".

**Out** (and where it belongs instead):

- The listing itself (S-21)

## Design notes

- Add S-21's listing package as a dependency when it is registered.

## Steps

1. Wire the hook into the listing.
2. e2e and snapshots.

## Acceptance criteria

- [ ] A viewer who owns the item on Steam sees Owned, not Buy (e2e).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- CM-17 documents the storefront commerce states.

The role agent sets `--set CM-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-16 done`.
