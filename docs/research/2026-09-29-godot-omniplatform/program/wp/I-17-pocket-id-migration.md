# I-17 Move `provider: platform` end users from Pocket ID to the Polaris Key account by claim at next sign-in; Pocket ID becomes operator-only

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)                                                                   |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                  |
| Depends on  | [I-03](I-03-console-oidc-client.md), [I-07](I-07-login-card-email.md)                                                                                    |
| Unblocks    | none                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                 |
| Gates       | D1 migration; THREAT-MODEL; `check:links`; rollout runbook; owner sign-off                                                                               |
| Human input | owner sign-off on the rollout and the sunset date (set after the email-less count); optional: a Pocket ID admin API key, only if a bulk export is wanted |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Goal

`provider: platform` end users move from Pocket ID to the Polaris Key account, by claim at each user's next sign-in, and Pocket ID becomes operator-only.

## Why

Operators and customers should not share a directory ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 1); end users leave Pocket ID, operators stay (owner).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (Pocket ID facts), [S-16 §3.1](../../notes/S-16-identity-service.md#31-the-platform-idp-is-pocket-id), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-17, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 11.
- `packages/worker/src/platformOidc.ts`, `packages/worker/src/services/identity/oidc.ts`, `docs/RUNBOOK.md`.

## Scope

**In:**

- On a `provider: platform` sign-in, match the Pocket ID subject to an account by its verified email (`email_verified` claim) or create one, keeping a temporary `oidc:https://id.plrs.im` link.
- Email-less subjects keep that link until a sunset date set after a count.
- Runbook for the rollout; optional bulk export only with an owner-issued admin API key.

**Out** (and where it belongs instead):

- Console operator sign-in (stays on Pocket ID; I-03 gave it its own client).

## Design notes

- **Pocket ID facts (lead, 2026-10-04).** `email_verified` is in `claims_supported` [M]; the admin REST users endpoint answers 401 without an admin API key [M]. So this migrates by claim at next sign-in.
- The sunset date follows the count, never precedes it.
- Migrating by email here is not "linking by email match across accounts": the Pocket ID subject is the same person's previous Polaris sign-in, and it lands on the account only if no other account holds that email; otherwise it routes to "sign in to connect".

## Steps

1. Claim-on-sign-in path with tests.
2. Count of email-less subjects; runbook.

## Acceptance criteria

- [ ] A platform user with a verified email lands on one account on next sign-in (test); a conflicting email routes to "sign in to connect" (test).
- [ ] Email-less subjects keep signing in through the temporary link (test).
- [ ] Runbook updated; the count is reported in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity platform
```

## Hand-off

- The owner sets the sunset date from the count.

The role agent sets `--set I-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-17 done`.
