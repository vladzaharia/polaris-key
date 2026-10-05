# PS-08 Optional: `product_idp` obtain path for products with their own IdP, from a verified product-scoped link

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 4: more paths) |
| Size        | 0.4–0.6 engineer-weeks                                                                         |
| Depends on  | [PS-03](PS-03-obtain-path-engine.md), [I-22](I-22-bring-your-own-auth.md)                      |
| Unblocks    | none                                                                                           |
| Role        | `pkey-implementer`                                                                             |
| Plan mode   | no                                                                                             |
| Gates       | THREAT-MODEL (S5 cross-tenant identity); workerd                                               |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Goal

Optional: products whose sign-in uses their own IdP are offered to an account that holds a verified product-scoped link to that IdP.

## Why

[S-21 §6.3](../../notes/S-21-polaris-storefront.md#63-the-eligibility-engine-obtain-paths-ps-03). Until I-22, a custom-issuer subject cannot be linked to an account (R5-02), so such products are never shown.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- [I-22](I-22-bring-your-own-auth.md) and its plan; `services/identity/accounts/`.

## Scope

**In:**

- A `product_idp` branch reading only product-scoped links; reason "Included with your <IdP label> account"; mint through the product's own policy.

**Out** (and where it belongs instead):

- Any guess from email or name.

## Design notes

- The platform-issuer predicate is untouched for platform paths.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-08:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-08 in-review`.

## Acceptance criteria

- [ ] Tests: a linked account sees it; an unlinked one gets the identical invisible answer.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test obtain
```

## Hand-off

None.

The role agent sets `--set PS-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-08 done`.
