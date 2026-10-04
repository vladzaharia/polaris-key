# I-12 Console per-product Users (every product; sign-in history and settings with Identity on): pairwise subjects only, that product's licences, devices and audit, per-subject export and deletion, reserved Data tab and account override editor, developer relink with step-up and 72-hour undo, sign-in settings

| Field       | Value                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                           |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                             |
| Depends on  | [I-05](I-05-accounts-core.md)                                                                                                                                                    |
| Unblocks    | [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [U-03](U-03-account-overrides.md), [U-12](U-12-privacy-settings-portal.md), [U-11a](U-11a-console-data-settings.md) |
| Role        | `pkey-implementer`                                                                                                                                                               |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                         |
| Gates       | console CSP parity; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); `check:links`; privacy docs                                                                               |
| Human input | none                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                        |

## Goal

Each product's console has a Users page that lists only that product's pairwise subjects, with that product's licences, devices, sessions, data size and audit, per-subject export and data deletion, a reserved Data tab and account override editor, the developer relink tool, and, for products with Identity on, sign-in settings and branding. Nothing about other products or the global account is ever shown. The Users page is platform-level and exists for every product (owner, 2026-10-04: the account is part of Core and the portal), because licences of any product attach to accounts and the account override layer works without Identity (Cloud Sync requires Identity).

## Why

Developers only ever see data for their own products (owner). With no recovery desk, the developer's relink tool is the recovery path beyond a person's remaining links ([S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 9).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (the header block, including the 2026-10-04 account/service split), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (console), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 9 and 12, [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-12, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D15, D19 and D21 (D19 and D21 accepted 2026-10-04).
- `docs/design/ADMIN.md`; `packages/admin/src/console/pages/identity/SignIn.tsx`; `packages/admin/src/console/nav.ts`; `packages/worker/src/services/identity/admin.ts`, `packages/worker/src/admin/authz.ts`.

## Scope

**In:**

- Users list and row detail keyed by pairwise subject, for every product: the product's licences, devices, account × product data size, and the product's audit trail. With Identity on, the row adds that product's sessions and sign-in history, showing only the method kind used to reach this product ("signed in with Steam"), never the account's link list. A merged subject shows "merged from" and resolves its alias (D21).
- Contact email: the licence's buyer email; the account primary email only with the person's consent (D19, accepted by the owner 2026-10-04).
- Actions: export the product's data for the subject (JSON); delete the product's data; detach the product's licence; **relink** a licence of this product to another subject.
- Reserved Data tab (U-11a) and account override editor slot (U-03); per-subject export and deletion call the deletion registry. The Data tab appears whenever Cloud Sync is on (which implies Identity on); the override editor appears whenever Config is on.
- Sign-in settings, shown only while the product's Identity toggle is on: key-entry limit, `claimByKey`, Terms version, native platform config with a per-kind checklist and a "test sign-in" dry run that mints nothing; branding for the passthrough header under the reserved-name validator; the App Review 4.8 warning.

**Out** (and where it belongs instead):

- The Data tab's content (→ U-11a, U-11b, U-11c); the account override editor's logic (→ U-03).
- Anything that disables, signs out, merges or deletes the account or touches its links: never a developer action.

## Design notes

- **Relink (safety defaults, owner-confirmed):** target named only by this product's pairwise subject, never by email (no cross-tenant oracle); the target first signs in to the product through passthrough (Identity on) or uses the explicit, rate-limited "Get a support code" action on the product's portal page (any product, I-11), which creates its subject (unlisted on the Users page until it holds a licence, sign-in or data), and reads it there as a short support code; step-up no older than 5 minutes; mandatory reason; audit with before and after; notice to both accounts before it takes effect; 72-hour undo; alert above a daily per-operator count.
- Never shown: the global account id, other products' licences, the rest of the Library, other products' sessions or data, personal details beyond consented claims.

## Steps

1. Admin routes keyed by subject, with cross-product visibility tests.
2. Users pages and actions.
3. Relink with step-up, notice and undo.
4. Sign-in settings and branding.

## Acceptance criteria

- [ ] Product A's console cannot see a subject, licence or datum of product B for the same account (test).
- [ ] No admin response contains the account id or the account's link list (test).
- [ ] A product with Identity off still has a Users page listing its licence owners' subjects, with no sign-in columns or sign-in settings (test).
- [ ] Relink refuses a target that is not an existing subject of this product, requires step-up and a reason, notifies both accounts and can be undone within 72 hours (tests).
- [ ] Console CSP parity holds; OpenAPI and `routeCoverage` updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity admin relink
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- U-03 puts the account override editor on the row; U-11a fills the Data tab; U-12 reuses per-subject export and deletion.

The role agent sets `--set I-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-12 done`.
