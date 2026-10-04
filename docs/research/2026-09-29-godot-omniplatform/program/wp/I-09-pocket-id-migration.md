# I-09 Move `provider: platform` end users off Pocket ID onto the Polaris login; Pocket ID becomes operator-only

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1)                                                                                                                 |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                              |
| Depends on  | [I-03](I-03-console-oidc-client.md), [I-08](I-08-email-login.md)                                                                                     |
| Unblocks    | none                                                                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                   |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                             |
| Gates       | D1 migration; THREAT-MODEL; `check:links`                                                                                                            |
| Human input | owner sign-off on the rollout and the sunset date (after the email-less count); optional: a Pocket ID admin API key, only if a bulk export is wanted |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Goal

End users of `provider: platform` products sign in through the Polaris-run login (email, later passkeys) instead of Pocket ID, and Pocket ID becomes the operator directory only, without stranding any user.

## Why

The shared directory is G5: a customer can be put in `admins` by mistake. Owner decision D3 splits operators from customers ([S-16 §3.1](../../notes/S-16-identity-service.md#31-the-platform-idp-is-pocket-id), [S-16 §6](../../notes/S-16-identity-service.md#6-what-changes-for-the-existing-pieces), [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 10).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.1](../../notes/S-16-identity-service.md#31-the-platform-idp-is-pocket-id), [S-16 §6](../../notes/S-16-identity-service.md#6-what-changes-for-the-existing-pieces), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-09, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 10; the Pocket ID facts in the S-16 header.
- `packages/worker/src/platformOidc.ts`, `services/identity/oidc.ts`, `docs/RUNBOOK.md`.

## Scope

**In:**

- Switch `provider: platform` products to the Polaris login for end users.
- Migration by claim: at each user's next sign-in through Pocket ID, read `email_verified`; a verified email becomes an `email:` link on the existing user; otherwise the user verifies an email through I-08 before the link is created.
- A temporary `oidc:https://id.plrs.im` method for subjects with no email, until a published sunset date.
- A count of email-less subjects in the console or an admin query, which must precede setting the sunset date.
- Rollout runbook; operator-assisted relink (I-07) for the remainder after sunset.

**Out** (and where it belongs instead):

- Operator sign-in (stays on Pocket ID; I-03 gave it its own client).
- Bulk export, unless the owner issues an admin API key.

## Design notes

- **Pocket ID facts (lead, 2026-10-04).** `email_verified` is in the discovery document's `claims_supported` [M], so verified status is available per user at sign-in. A bulk export through the admin REST API needs an admin API key (the users endpoint answers 401 without one) [M]. So this package **migrates by claim at each user's next sign-in**, and adds a bulk export only if the owner issues an admin API key.
- Pocket ID passkeys are bound to `rp_id = id.plrs.im` and cannot carry over; migrated users enrol again on `key.plrs.im` (I-14).
- The sunset date follows the count, never precedes it.

## Steps

1. Claim-at-sign-in migration with tests.
2. The temporary method and the count.
3. Runbook and owner sign-off request.

## Acceptance criteria

- [ ] A Pocket ID user with a verified email is linked by email at next sign-in and keeps their licences (test).
- [ ] A user without a verified email must verify one before linking (test).
- [ ] Email-less subjects keep signing in through the temporary method and are counted.
- [ ] Runbook written; owner sign-off recorded in the PR before the switch.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity platform
```

## Hand-off

- After the sunset, `provider: platform` means the Polaris login only.

The role agent sets `--set I-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-09 done`.
