# CM-16 Storefront integration: `buy` / `upgrade` paths with prices on Discover tiles and the storefront product page, the footnote and counts, owned-elsewhere

| Field       | Value                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                               |
| Size        | 0.5–0.8 engineer-weeks                                                                                       |
| Depends on  | [CM-04](CM-04-offers-catalogue.md), [CM-11](CM-11-portal-billing.md), [PS-05](PS-05-storefront-portal-ui.md) |
| Unblocks    | [CM-17](CM-17-commerce-closeout.md)                                                                          |
| Role        | `pkey-implementer`                                                                                           |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                             |
| Gates       | `portal-e2e`, `ui-snapshots`                                                                                 |
| Human input | the owner's go signal (removes `deferred`)                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                    |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

PS-05's Discover tiles and storefront product page (`#/discover/:product`) render `buy` and `upgrade` paths from the server with their price and terms ("€9.99", "€4.99 a month · 14-day trial"), the reason line for a priced path reads "Buy on Polaris Key", a product the viewer already holds elsewhere shows the free `store_owned` path first, the Discover count stays "offers you can add now" (priced products are listed but not counted), and the footnote changes to "Products you can add for free, and products you can buy".

## Why

The storefront is where people meet the price; S-21 renders actions from the server, so a priced path needs no new tile ([S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-the-s-21-seams-commerce-plugs-into), S-21 §6.10 seams 1, 2, 8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §3](../../notes/S-22-polaris-key-commerce.md#3-the-s-21-seams-commerce-plugs-into)
- [S-22 §7.2](../../notes/S-22-polaris-key-commerce.md#72-offers-and-prices-on-storefront-listings)
- [S-22 §7.14](../../notes/S-22-polaris-key-commerce.md#714-coexistence-with-store-commerce)
- [S-21 §6.5, §6.10](../../notes/S-21-polaris-storefront.md#610-seams-for-the-commerce-module-s-22)
- [PS-05](PS-05-storefront-portal-ui.md)

## Scope

**In:**

- Price and terms rendering for `buy` / `upgrade` paths; Buy goes to CM-05's checkout; signed-out "Sign in to buy"; footnote and count copy.

**Out** (and where it belongs instead):

- The engine and the tiles themselves (PS-03, PS-05)

## Design notes

- Free paths always come first in the evaluation order (CM-04).

## Steps

1. Render priced paths.
2. e2e and snapshots in both themes.

## Acceptance criteria

- [ ] A viewer who owns the item on Steam sees "You own it on Steam" and Add, not Buy (e2e).
- [ ] The Discover count excludes buy-only products (test).
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
