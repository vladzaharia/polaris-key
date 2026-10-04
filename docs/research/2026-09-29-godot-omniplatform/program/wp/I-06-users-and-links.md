# I-06 Users and identity links: tables, `licenses.user_id` migration, `signIn(verifiedIdentity)`, linking and licence-claim rules, Identity without License

| Field       | Value                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1, MVI)                                                                                                                                                                                                |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                   |
| Depends on  | [I-04](I-04-identity-plan.md)                                                                                                                                                                                                            |
| Unblocks | [I-07](I-07-console-users.md), [I-08](I-08-email-login.md), [I-10](I-10-exchange-endpoint.md), [I-15](I-15-portal-convergence.md), [I-16](I-16-product-issuer.md), [I-18](I-18-named-user-seats.md), [I-20](I-20-apple-kind.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                       |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                                                                 |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; rule 9 (validator rule, mutation table, JSON schema)                                                                                                                                         |
| Human input | none                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                |

## Goal

Identity owns a product-scoped principal: `identity_users` and `identity_links` exist, licences point at users through `licenses.user_id`, every front door ends in one `signIn(verifiedIdentity)`, and the linking, conflict and licence-claim rules of S-16 §5.1 are enforced. Identity works without License.

## Why

There is no user record today; "the user" is four columns on `licenses` (G7, G8, G9). Everything else in the Identity build hangs off this principal ([S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 3 and 5, [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-06, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D2 D4 D6 D14; `plans/I-04.md`.
- `packages/worker/migrations/0001_init.sql:64-81` (`licenses`), `0052_commerce.sql`.
- `packages/worker/src/services/identity/oidc.ts:591-635,697-845` (`activateFromIdentity`).
- `packages/worker/src/services/license/admin/licenses.ts:148-155`.
- `packages/worker/test/boundaries*.test.ts` (rule 6).

## Scope

**In:**

- Tables and `TABLE_OWNERS` entries per the approved plan; `licenses.user_id`.
- The reversible migration of `licenses.sub`: each `sub` becomes a user plus an `oidc:<iss>` link; platform subjects become `oidc:https://id.plrs.im` links so they keep working. Rehearsed on a production-shaped copy.
- `signIn(verifiedIdentity)` used by the existing redirect broker and device code.
- Linking rules: one link belongs to one user (`link_conflict`, Block by default, Transfer only by product opt-in); never orphan (`last_link`); explicit linking needs proof of both identities in one session; email auto-link only between `email_verified` email-authoritative issuers.
- Licence claim rules (below).
- Identity without License: under `requires-identity` an Identity-only product gets users and device tokens without minting licences.
- Email-match attach for operator-issued licences (closes G9).

**Out** (and where it belongs instead):

- Console pages (→ I-07).
- Email sign-in (→ I-08).
- Portal links to users (→ I-15).

## Design notes

- **Licence claim and transfer (safety defaults, owner-confirmed).**
  - First attach only: a licence with `user_id` null can be attached, by its key or by the device's enrolled licence, after a confirm screen (P1-07's show-then-confirm).
  - An owned licence is refused with `license_owned` whoever presents the key; it never moves by key.
  - It moves only when its owner detaches it from their own session, or an operator reassigns it under step-up and audit (I-07), recording the previous owner so it is reversible.
  - A licence that carries an email (operator-issued or bought) attaches only to a user with that verified email, not by key, unless the product sets `claimByKey: true`.
  - Each attach notifies the licence's email, if any.
- Licence-key sign-in is low assurance (`amr: ["pkey_license"]`): no SSO session, no auto-link, and for an owned licence it reaches only that licence.
- **Tenant isolation:** a user is product-scoped; every query is keyed by product. Add a test that a link, user or licence of product A is invisible at product B.
- No user row is created until a credential is verified (S-16 §5.5 retention).
- Store grants on first Steam sign-in go through a Core descriptor hook (rule 6), not an import of Distribution; that hook is I-12's.

## Steps

1. Migration and tables with the production-shaped rehearsal.
2. `signIn` and the linking engine with tests.
3. Claim rules with tests for every refusal.
4. Identity-without-License path and the `boundaries` test.

## Acceptance criteria

- [ ] Migration rehearsed on a production-shaped copy, reversible; every existing OIDC licence still signs in (test).
- [ ] `license_owned`, `link_conflict` and `last_link` are returned in the cases above (tests).
- [ ] An email-carrying licence cannot be attached by key unless `claimByKey` (test); attaching notifies the licence email (test).
- [ ] Cross-product isolation test passes.
- [ ] An Identity-only product signs in without a `licenses` row (test).
- [ ] The `boundaries` test passes (rule 6).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity license boundaries
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- migrations
```

## Hand-off

- I-07, I-08, I-10, I-15, I-16, I-20 call `signIn` and read `identity_users`/`identity_links`.
- I-07 owns operator reassign; I-06 provides the reversible reassign primitive it calls.

The role agent sets `--set I-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-06 done`.
