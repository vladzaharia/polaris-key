# CM-10 Gifting: buy as a gift mints an LX-25 gift code; refund voids or revokes

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                   |
| Size        | 0.4–0.6 engineer-weeks                                                           |
| Depends on  | [CM-06](CM-06-refunds-disputes.md), [LX-25](LX-25-redeem-codes.md)               |
| Unblocks    | [CM-13](CM-13-commerce-emails.md)                                                |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md)) |
| Gates       | `rule-10`, `threat-model`                                                        |
| Human input | the owner's go signal (removes `deferred`)                                       |
| Repo        | `vladzaharia/polaris-key`                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

A gift order fulfils into an LX-25 gift code (shown on the success page, emailed to the buyer and optionally to a recipient); redeeming creates the grant or licence on the redeemer's holder; a refund voids an unredeemed code and, by default, revokes a redeemed one.

## Why

Gifting is in the owner's request; S-19 decision 20 makes customer gifting a code ([S-22 §7.8](../../notes/S-22-polaris-key-commerce.md#78-gifting), D21).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.8](../../notes/S-22-polaris-key-commerce.md#78-gifting)
- [`wp/LX-25-redeem-codes.md`](LX-25-redeem-codes.md) (amended)
- `plans/CM-01.md`

## Scope

**In:**

- Gift branch of `fulfilOrder`; `order_ref` on codes; refund effects; `commerce.gifting.*` settings.

**Out** (and where it belongs instead):

- Scheduled gift delivery (not in v1)

## Design notes

- Codes are 128-bit random and rate-limited on redeem (LX-25).

## Steps

1. Fulfilment branch.
2. Refund effects.
3. Tests.

## Acceptance criteria

- [ ] Refund of an unredeemed gift voids the code (test).
- [ ] Refund of a redeemed gift revokes the recipient's grant when the setting is on (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- CM-13 sends the gift email; CM-11 shows Gift on the product page.

The role agent sets `--set CM-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-10 done`.
