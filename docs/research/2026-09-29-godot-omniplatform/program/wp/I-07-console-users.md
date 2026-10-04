# I-07 Console Identity Users and Sign-in methods pages: per-user audit and export, disable, delete, audited relink and reassign under step-up

| Field       | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1, MVI)                                                          |
| Size        | 1–1.4 engineer-weeks                                                                               |
| Depends on  | [I-06](I-06-users-and-links.md)                                                                    |
| Unblocks    | [I-17](I-17-identity-docs.md)                                                                      |
| Role        | `pkey-implementer`                                                                                 |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package           |
| Gates       | console CSP parity; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); `check:links`; privacy docs |
| Human input | none                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                          |

## Goal

Developers manage their product's users from the console: a Users page (list, search, profile, links, licences, devices, sessions, per-user audit, JSON export), lifecycle actions (disable, sign out everywhere, delete), audited support tools (relink and reassign under step-up with notice and undo), and a Sign-in methods page with per-kind setup checklists, a test sign-in dry run and the App Review 4.8 warning.

## Why

G8 and G13: no user management and a read-only Sign-in page. S-16 makes the developer, not Polaris, responsible for recovery beyond a user's links, so the console tool is the recovery mechanism and the softest takeover target ([S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 9, [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (Console), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 9, [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-07, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D15.
- `docs/design/ADMIN.md`; `packages/admin/src/console/pages/identity/SignIn.tsx`; `packages/admin/src/console/nav.ts`.
- `packages/worker/src/services/identity/admin.ts`, `packages/worker/src/admin/authz.ts`, `admin/auth.ts`.

## Scope

**In:**

- Users and user-detail pages; Sign-in methods page replacing the read-only Sign-in page.
- Admin API routes behind the Identity descriptor, with OpenAPI and `routeCoverage` (rule 10).
- Per-user JSON export (GDPR Art. 15/20, for the developer to answer requests).
- Disable; sign out everywhere; delete (below).
- Support relink and reassign (below).
- Test sign-in dry run that mints nothing.
- App Review 4.8 warning for an iOS release target with a social method and no `kind: apple`.
- Inactive-user flag (default 24 months, product-set).
- Docs page for the console section and its help links.

**Out** (and where it belongs instead):

- Branding editor beyond reusing `portal_product_settings.branding_json` (follow-up).
- Clients page (→ I-16).
- Portal UI of any kind (→ portal redesign, `docs/design/PORTAL.md`).

## Design notes

- **Recovery tool (safety defaults, owner-confirmed).** Polaris runs no recovery desk. Relink, reassign, disable and delete require:
  - step-up: a fresh operator re-authentication (OIDC `max_age` or passkey) no older than 5 minutes;
  - a mandatory reason, and an `audit` row with before and after (old and new user, link and licence ids);
  - a notification to every verified email on the affected user(s), sent **before** the change takes effect for relinks;
  - a 72-hour undo for reassign and relink;
  - an alert when one operator exceeds a set number of these actions in a day.
- **GDPR deletion.** Operator deletes are soft for 14 days (restorable), then hard. A hard delete cascades to links, sessions, passkeys, grants and pairwise mappings; detaches licences and nulls their personal columns (`sub`, `name`, `email`, `groups_json`) while keeping commercial fields; rewrites `audit` and `portal_audit` rows naming the user to a tombstone id; revokes F-20 licence-bound tokens through the Core hook; and records the user id and hashed email in a **tombstone list that is re-applied after any D1 Time Travel restore**, so deletions survive the restore window. The privacy docs say a deleted user stays restorable for the Time Travel window.
- Peppered email hashes are pseudonymous personal data: include them in export and deletion.
- Docs state plainly: beyond a user's own links, recovery is the developer's decision on their own evidence; Polaris supplies the tool and the audit trail.

## Steps

1. Admin API with tests (step-up, audit, notification ordering, undo window).
2. Deletion pipeline and tombstone list.
3. Console pages per ADMIN.md.
4. Docs and help links.

## Acceptance criteria

- [ ] Relink and reassign are refused without a step-up younger than 5 minutes and without a reason (tests).
- [ ] Each writes a before-and-after audit row; the notification is sent before a relink takes effect; undo works within 72 hours and not after (tests).
- [ ] Soft delete restores within 14 days; hard delete scrubs licence personal columns and audit rows and writes a tombstone (tests).
- [ ] A restore-then-reapply test proves tombstoned users stay deleted.
- [ ] Export returns every personal field for a user, including hashed links.
- [ ] Admin build, console CSP parity and `check:links` pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity admin audit
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- I-09's operator-assisted relink for email-less Pocket ID subjects uses this tool.
- I-15 reuses the deletion pipeline for portal-account deletion; I-17 documents recovery.

The role agent sets `--set I-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-07 done`.
