# I-05 Accounts and links core: tables and the reversible owner-pointer migration, `signIn(verifiedIdentity)`, link rules, merge with proof of both, pairwise subjects, licence claim rules, the device binding and Core's subject resolver, merge and deletion hooks

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                                                                                                             |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on  | [I-04](I-04-account-contract-plan.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Unblocks    | [I-06](I-06-login-providers.md), [I-07](I-07-login-card-email.md), [I-09](I-09-key-entry-attach.md), [I-11](I-11-portal-library.md), [I-12](I-12-console-users.md), [I-13](I-13-exchange-endpoint.md), [I-24](I-24-named-user-seats.md), [U-02](U-02-principal-binding.md), [U-03](U-03-account-overrides.md), [U-08](U-08-merge-prompt.md), [PX-W11](PX-W11-cloud-sync-api.md), [PX-W12](PX-W12-sign-in-methods-api.md), [PX-W15](PX-W15-email-gate.md), [PX-W17](PX-W17-identity-per-product.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                                                                                                                                                                                                                                                                                                                           |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; rule 9 (validator rule, mutation table, JSON schema); migration rehearsal on a production-shaped copy; `boundaries` test (rule 6)                                                                                                                                                                                                                                                                                                                      |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Goal

Identity owns one global principal: `accounts`, `account_links` and `account_product_subjects` exist; licences point at accounts through `licenses.account_id`; every front door ends in one `signIn(verifiedIdentity)`; the link, merge and licence-claim rules of [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) are enforced; and Core has the device binding, the subject resolver and the merge and deletion hooks Cloud Sync and Config build on. Identity works without License. The account is platform-level (owner, 2026-10-04): it exists for every product, whatever the product's `identity` toggle says.

## Why

There is no person record today: "the user" is four columns on `licenses` and a separate portal account ([S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps) G7–G9). Layer 1 hangs everything off one account with pairwise subjects per product ([S-16 owner decisions](../../notes/S-16-identity-service.md)). S-17 needs the binding and the hooks before any Cloud Sync data exists ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md` (approved).
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 3, 5, 12, 15 and 16, [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-05.
- [S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model) (principal, why the subject on the device), [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks) (account merge), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) ("Changes to S-16 work packages").
- `packages/worker/migrations/0001_init.sql:64-81`, `0008_portal.sql`, `packages/worker/src/core/devices.ts:136-142`, `packages/worker/src/services/identity/portal/repo.ts`, `packages/worker/src/services/identity/oidc.ts:697-845`, `packages/worker/src/core/hooks.ts`.

## Scope

**In:**

- Tables and the reversible migration from `portal_accounts`, `licenses.sub` and `portal_license_links` to `accounts`, `account_links`, `account_product_subjects` and `licenses.account_id`, rehearsed on a production-shaped copy. `TABLE_OWNERS` entries.
- `signIn(verifiedIdentity)` and the link engine: one link per account (`link_conflict`), last-method guard (`last_link`), step-up (fresh sign-in no older than 5 minutes), audit and email on every link change.
- Merge with proof of both (live sign-in to each account in one flow, both fresh): links, licences, sessions and personal details move; per product the surviving pairwise subject wins and the other becomes an alias; the absorbed account is a 30-day tombstone; the developer gets a `subject.merged` event (D21, accepted by the owner 2026-10-04). The same merge primitive serves I-07's join offer when a confirmed email belongs to another account.
- Pairwise subjects: stored random values per `(account, product)`, created on first contact (a licence of the product attached in the portal, a sign-in through the product, or account × product data), for every product whether or not its Identity toggle is on; tenant-scoped link lookups on `(issuer_key, tenant_scope, subject)`.
- Licence claim rules (below), floating licences, Identity without License (`requires-identity`, no licence row needed).
- **S-17 hooks:** the device binding column (name and content from I-04's plan, default `devices.subject` holding the pairwise subject); sign-in passes the subject to Core's activation path, which sets the binding; one Core hook clears it (sign-out, sign out everywhere, disable, deletion, per-product removal, relink; not plain detach); Core's resolver from `(account, product)` to the pairwise subject (`subjectFor`), with alias resolution; the per-product merge-hook and deletion-hook registry; merge enumerates account × product data to re-key; per-product removal and account deletion call registered deletion hooks (Cloud Sync, Config) before deleting the subject; detach on deletion with `subject.deleted` carrying licence ids.
- The decision record replacing D-14, as named in the plan.

**Out** (and where it belongs instead):

- Login-card providers (→ I-06), the card, email and interstitial (→ I-07), passthrough routes (→ I-08), key-entry wire (→ I-09).
- The portal UI for linking and merge (→ I-11) and console Users (→ I-12).
- `resolveSyncPrincipal` and the hook registry's guard test (→ U-02); the hooks' Cloud Sync and Config bodies (→ U-03, U-05).

## Design notes

- **Licence claim and transfer (safety defaults, owner-confirmed).** First attach only: a floating licence attaches by its key or by the device's enrolled licence after a confirm screen (P1-07's show-then-confirm). An owned licence is refused with `license_owned` on attach and portal Activate License; it never moves by key. It moves only when its owner detaches it or a developer relinks it (I-12). A licence that carries an email attaches only to an account whose verified email matches, unless the product sets `claimByKey: true`. Each attach notifies the licence's email, if any.
- **Never by email match.** A provider-verified email equal to another account's primary email never attaches the provider to it silently; the card offers to join the two accounts once both are proven in one session (owner, 2026-10-04; I-07).
- **Platform, not a toggle** (owner, 2026-10-04; supersedes D26). The account tables, `signIn`, merge, claim rules, `subjectFor` and the clearing hook run for every product; I-04's plan says which module owns the tables (`TABLE_OWNERS`), and nothing here reads the product's `identity` toggle. Only the sign-in routes that reach `signIn` _through a product_ (I-08, I-09's device-wire attach, I-13, I-15) check that toggle.
- **The global account id never leaves the Worker's Identity and Core code** (I-04's wording): not in any developer-facing API, export, webhook or SDK response. Developers see pairwise subjects only.
- **Per-product removal is not unlinkability** while a licence of that product stays attached (D25); the removal path offers detaching the licence too.
- No account row exists until a credential is verified ([S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy) retention).
- Store grants on Steam sign-in go through a Core descriptor hook (rule 6), owned by I-14.

## Steps

1. Migration and tables with the production-shaped rehearsal and a down path.
2. `signIn`, the link engine and pairwise subjects with tests.
3. Merge and its aliases and tombstone.
4. Claim rules with a test for every refusal.
5. Device binding, resolver, clearing hook and the merge and deletion registries; boundaries test.

## Acceptance criteria

- [ ] Migration rehearsed on a production-shaped copy and reversible; every existing OIDC licence and portal account still signs in (test).
- [ ] `license_owned`, `link_conflict` and `last_link` are returned in the cases above (tests).
- [ ] An email-carrying licence cannot be attached by key unless `claimByKey` (test); attaching notifies the licence email (test).
- [ ] A merge keeps the absorbed subject resolvable as an alias for each product (test); no merge happens without two fresh sign-ins (test).
- [ ] A tenant-scoped link of team A never resolves an account for a product of team B (test).
- [ ] Licence-key activation never sets the device binding (test); sign-out clears it (test).
- [ ] `subjectFor` resolves the licence owner's subject for a product with the Identity toggle off (test), so the account override layer and Cloud Sync's licence-owner line work there.
- [ ] No developer-facing response contains the account id (test over the admin and device routes touched).
- [ ] An Identity-only product signs in without a `licenses` row (test); the `boundaries` test passes (rule 6).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity license boundaries migrations
```

## Hand-off

- I-06, I-07, I-08, I-09, I-11, I-12, I-13 call `signIn` and read the account tables.
- U-02 adds `resolveSyncPrincipal` over the binding and the registry's guard test; U-03 and U-05 register their merge and deletion hooks.
- I-12 owns the developer relink tool; I-05 provides the reversible reassign primitive it calls.

The role agent sets `--set I-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-05 done`.
