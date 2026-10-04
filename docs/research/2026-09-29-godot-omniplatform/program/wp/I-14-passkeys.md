# I-14 Passkeys on key.plrs.im: registration after email verification, per-product user handles

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-2)                                                            |
| Size        | 0.6–0.85 engineer-weeks                                                                         |
| Depends on  | [I-08](I-08-email-login.md)                                                                     |
| Unblocks    | none                                                                                            |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package        |
| Gates       | `test:workerd`; D1 migration; `TABLE_OWNERS`; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`) |
| Human input | none                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Goal

Users can register passkeys on `key.plrs.im` after verifying an email, and sign in with them, with a per-product random WebAuthn user handle and a legible `user.name`.

## Why

Passkeys are the phishing-resistant answer to code relay (§5.4 item 4). The owner decided custom auth domains are deferred and passkeys enrol on `key.plrs.im` only (D8) ([S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 7).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (recovery rules), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 7, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-14, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D8.
- `@simplewebauthn/server` docs; `packages/worker/wrangler.toml`.

## Scope

**In:**

- `identity_passkeys` table and `TABLE_OWNERS`.
- Registration only after a verified email (so a lost passkey falls back to email).
- `rp_id = key.plrs.im`; per-product random `user.id` handle (never global); `user.name` "<email> · <Product>".
- Challenges on I-02's single-use store.
- Hosted-page UI and routes (rule 10).

**Out** (and where it belongs instead):

- Custom auth domains and WebAuthn Related Origin Requests (deferred by the owner).

## Design notes

- **Tenant isolation:** product A's passkey must not authenticate at product B (test); handles never repeat across products.
- Must run under workerd.

## Steps

1. Library under workerd.
2. Registration and assertion routes with tests.
3. Hosted UI.

## Acceptance criteria

- [ ] Registration without a verified email is refused (test).
- [ ] Handles are per product and random; cross-product use fails (test).
- [ ] `test:workerd` passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity passkey
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- I-09 migrated users enrol here.

The role agent sets `--set I-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-14 done`.
