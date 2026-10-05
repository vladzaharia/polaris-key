# PS-07 `store_owned` obtain path: Steam ownership through the account's linked Steam sign-in, cached and budgeted, Add through the LX-11 holder binding

| Field       | Value                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 4: more paths)           |
| Size        | 0.6–1 engineer-weeks                                                                                     |
| Depends on  | [PS-03](PS-03-obtain-path-engine.md), [LX-11](LX-11-commerce-rework.md), [I-06](I-06-login-providers.md) |
| Unblocks    | none                                                                                                     |
| Role        | `pkey-implementer`                                                                                       |
| Plan mode   | no                                                                                                       |
| Gates       | THREAT-MODEL (S11 Steam ownership oracle); workerd                                                       |
| Human input | none                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                |

## Goal

A person whose account has a linked Steam sign-in that owns a product's Steam app sees it with "You own it on Steam" and can add it, creating exactly what a device-side Steam claim creates.

## Why

[S-21 §6.3, §6.4](../../notes/S-21-polaris-storefront.md#64-add-to-library-ps-04), D4. Needs LX-11's holder bindings and I-06's Steam sign-in.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `services/distribution/commerce/steam.ts`; [LX-11](LX-11-commerce-rework.md); [I-06](I-06-login-providers.md).

## Scope

**In:**

- `Delivery` gains `storeOwnership(identities)` (Distribution), backed by the Steam ownership check for the account's own linked Steam id only.
- 10-minute cache per (account, store, app) and a budget; measure the Steam Web API limits and record them in the brief.
- Claim through the LX-11 binding; audit `path: store_owned`.

**Out** (and where it belongs instead):

- Apple and Play (device receipts only; they reach the Library through the device).

## Design notes

- No route accepts a Steam id. Timed trials (`timedtrial`) stay refused as today.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-07:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-07 in-review`.

## Acceptance criteria

- [ ] Tests with a fake Steam client: owner sees and adds; non-owner identical to unknown.
- [ ] Budget and cache tests.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test obtain commerce
```

## Hand-off

None.

The role agent sets `--set PS-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-07 done`.
