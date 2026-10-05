# CM-12 Console commerce: Product → Commerce (merchant, offers, orders with refund and re-fulfil, subscriptions, coupons, revenue, settings); platform merchants and webhook health

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                   |
| Size        | 1.2–1.6 engineer-weeks                                                                                                           |
| Depends on  | [CM-07](CM-07-tier-upgrades.md), [CM-08](CM-08-subscriptions.md), [CM-09](CM-09-coupons.md), [LX-14](LX-14-console-licensing.md) |
| Unblocks    | [CM-17](CM-17-commerce-closeout.md)                                                                                              |
| Role        | `pkey-implementer`                                                                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                 |
| Gates       | `ui-snapshots`, `console-csp-parity`, `docs-links`, `rule-10`                                                                    |
| Human input | the owner's go signal (removes `deferred`)                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

Developers manage commerce from the console: connect a merchant, edit offers and prices, search orders and refund or re-fulfil them, manage subscriptions and coupons, read revenue per currency from the ledger, and edit the `commerce.*` settings; platform admins see merchants and webhook health.

## Why

"The console (products' pricing, revenue, refunds)" from the brief ([S-22 §7.11](../../notes/S-22-polaris-key-commerce.md#711-console-and-emails), D29).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.11](../../notes/S-22-polaris-key-commerce.md#711-console-and-emails)
- [S-22 §7.13](../../notes/S-22-polaris-key-commerce.md#713-settings-s-18-registry)
- `docs/design/ADMIN.md`
- `plans/CM-01.md`

## Scope

**In:**

- ADMIN.md amendment.
- Commerce area pages; 3.1.3(b) parity warning for offers without an iOS IAP mapping.
- Platform merchants and webhook-health view.

**Out** (and where it belongs instead):

- Store revenue import (not in v1)

## Design notes

- Refund is L2 with a reason; merchant change is L3 (CM-03).

## Steps

1. ADMIN.md amendment.
2. Pages.
3. Snapshots in both themes.

## Acceptance criteria

- [ ] Refund from the console revokes the grant (e2e against the worker test harness).
- [ ] Revenue totals match the ledger (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
```

## Hand-off

- CM-17 documents the console pages.

The role agent sets `--set CM-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-12 done`.
