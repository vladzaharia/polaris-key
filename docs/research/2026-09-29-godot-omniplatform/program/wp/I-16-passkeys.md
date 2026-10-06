# I-16 Passkeys on key.plrs.im: enrolment only after email verification, account-level random user handle, post-sign-in nudge

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)          |
| Size        | 0.6–0.85 engineer-weeks                                                                         |
| Depends on  | [I-07](I-07-login-card-email.md)                                                                |
| Unblocks    | [PX-W12](PX-W12-sign-in-methods-api.md), [PX-12](PX-12-login-card-v2.md)                        |
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
- Passkeys are an account sign-in method, platform-level and independent of any product's Identity toggle (owner, 2026-10-04). A passkey sign-in during app passthrough still ends on "Continue to <App>" the first time (D22).
- Must run under workerd.
- Pocket ID passkeys (`rp_id = id.plrs.im`) cannot carry over; migrated users enrol again (I-17).

## Corrections against the code (I-16 builder, 2026-10-06)

- **`account_passkeys` already exists** (I-05's `0068_a_accounts.sql`, with every column the
  scope names) and `TABLE_OWNERS` already lists it under Identity. The migration gate is two
  one-statement `ALTER`s instead: `accounts.passkey_user_handle` (the ONE random account-level
  handle, minted on first use and kept, so an abandoned first ceremony does not leave a second
  "Polaris Key" entry) and `account_passkeys.details_json` (AAGUID, backup flags, the browser it
  was added from, for the settings list): `0094_a_accounts_passkey_user_handle.sql` and
  `0094_b_account_passkeys_details.sql` (numbers assigned by the lead).
- **Each passkey is also a sign-in method** (`account_links`, `issuer_key = 'passkey'`, subject
  = the credential id, as S-16 §5.1's link list names it). The last-method guard, step-up, audit,
  notices, the nudge's method count, merge and deletion therefore apply unchanged; the link
  engine's error is `last_link` (registered in `errors.json`), not PX-W12's `last_method`.
- **Step-up** is the existing rule: a sign-in no older than 5 minutes (`STEP_UP_MAX_AGE_SECONDS`;
  a passkey sign-in counts). Right after a sign-in, as the nudge runs, adding a passkey passes.
- **Card integration is the Worker half.** The card's passkey button and conditional UI are
  PX-12's and the settings rows PX-13's (both depend on this package). I-16 delivers the routes
  (`/api/signin/passkey/options|verify`, `/api/me/passkeys[/options|/<id>]`), `auth.passkey` in
  `GET /api/capabilities`, and the nudge hook: the sign-in answer's existing `nudge` plus
  `GET /api/me/passkeys` → `canAdd` / `reason` for the nudge card's "Add a passkey" row.
- **RP id** is the console host from `CONSOLE_ORIGIN` (`key.plrs.im` in production,
  `key-staging.plrs.im` on staging), not a constant, and a ceremony is served only on that origin.
- **Dependency.** `@simplewebauthn/server` is pinned at 13.3.3 (the last 13.x; 14.x adds a
  post-quantum ASN.1 module the Worker does not need).
- **The workerd lane** ordered migrations by `parseInt` of the prefix, so an unnumbered
  placeholder that alters a table ran before the table existed. It now sorts by filename, as the
  Node lane, `record-deploy` and `LATEST_MIGRATION` do (identical for numbered files). While the
  migrations were unnumbered, `test/recordDeploy.test.ts` (its migration-name check refuses a
  placeholder by design) and `test/checkRepresentable.test.ts` (real `wrangler d1 migrations
apply`, which also orders by the leading number) failed; with the lead's numbers (0094) both
  pass.

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
