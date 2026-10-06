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

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Migrated users enrol their passkeys again** ([I-16](I-16-passkeys.md)). Pocket ID passkeys are
  bound to `rp_id = id.plrs.im`; Polaris Key's are bound to the console host (`CONSOLE_ORIGIN`:
  `key.plrs.im`, staging `key-staging.plrs.im`), so none carries over. A migrated account starts
  with no passkey. The runbook and the migration's notice say so, and the post-sign-in nudge
  (`GET /api/me/passkeys` → `canAdd`) offers **Add a passkey** once the email is verified.
- **The platform `/callback` join offer** ([PX-W15](PX-W15-email-gate.md)). `signInRefusal`
  (`portal/auth.ts`) still answers a platform-OIDC `join_offer` with a 409 page that sends the
  person away. SIGN-IN.md D-34 routes it into the email gate's join step (`card/gate.ts`,
  `email_in_use`, both accounts proven in one session), which is also this package's "conflicting
  email gets the join offer" criterion. PX-W15 left it until PX-21 renders that step. It moves here
  or to PX-21 (recorded in both); whichever does it says so in its hand-off, and the other drops
  it.
- **The contract phase drops `accounts.terms_json`** ([PX-W15](PX-W15-email-gate.md)). PX-W15 moved
  terms acceptances to `account_terms_acceptances` (migration 0091). `accounts.terms_json` (I-05's
  `0068_a_accounts.sql`) stays, neither read nor written, while migrations are expand-only. The
  contract-phase migration after this package (`plans/I-04.md` §6.1: the `portal_*` tables and
  `idx_licenses_sub` "stay until a contract-phase migration after I-17") drops it too, with
  `terms_json` in `AccountRow` (`accounts/repo.ts`).

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
- Migrating by email here is not "linking by email match across accounts": the Pocket ID subject is the same person's previous Polaris sign-in, and it lands on an account only if no other account holds that email. Otherwise the email step offers to join that account, with both proven in one session (the person signs in to the existing account by any of its methods), and never joins silently (owner, 2026-10-04).
- Migrated accounts are ordinary accounts for dormancy: no sign-in and no licence for 36 months means a warning email, then deletion (D23, decided by the owner 2026-10-04).

## Steps

1. Claim-on-sign-in path with tests.
2. Count of email-less subjects; runbook.

## Acceptance criteria

- [ ] A platform user with a verified email lands on one account on next sign-in (test); a conflicting email gets the join offer (both accounts proven in one session, never joined silently) (test).
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
