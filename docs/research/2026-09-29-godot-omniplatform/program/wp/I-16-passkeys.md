# I-16 Passkeys on key.plrs.im: enrolment only after email verification, account-level random user handle, post-sign-in nudge

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)          |
| Size        | 0.6–0.85 engineer-weeks                                                                         |
| Depends on  | [I-07](I-07-login-card-email.md)                                                                |
| Unblocks    | none                                                                                            |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package        |
| Gates       | `test:workerd`; D1 migration; `TABLE_OWNERS`; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`) |
| Human input | none                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Goal

People can add a passkey to their account on `key.plrs.im`, only after their email is verified, with one random account-level WebAuthn user handle; the card offers passkey sign-in when one is enrolled, and nudges enrolment after first sign-in.

## Why

Passkeys are the main defence of a high-value shared account and are phishing-resistant ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 14 and 17). The owner fixed passkeys to `key.plrs.im`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (recovery rules), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 7, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-16.
- `@simplewebauthn/server` docs; `packages/worker/wrangler.toml`; `packages/worker/src/core/singleUse.ts` (WebAuthn challenges).

## Scope

**In:**

- `account_passkeys` (credential id, COSE key, sign count, transports, `rp_id = key.plrs.im`, random account-level user handle); registration and authentication ceremonies on the card; enrolment only after email verification; post-sign-in nudge; listing and removal in account settings (I-11) under step-up and the last-method guard.

**Out** (and where it belongs instead):

- Per-product passkeys: none; one "Polaris Key" entry in the picker.

## Design notes

- The user handle is never the account id.
- Must run under workerd.
- Pocket ID passkeys (`rp_id = id.plrs.im`) cannot carry over; migrated users enrol again (I-17).

## Steps

1. Table and ceremonies under workerd.
2. Card integration, nudge and settings hooks.

## Acceptance criteria

- [ ] Enrolment is refused before email verification (test).
- [ ] A passkey signs in on the card; a challenge replays fail (tests under `test:workerd`).
- [ ] Removing the last method is refused (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- I-11's account settings list and remove passkeys.

The role agent sets `--set I-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-16 done`.
