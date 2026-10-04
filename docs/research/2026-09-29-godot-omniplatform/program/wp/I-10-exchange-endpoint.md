# I-10 Identity exchange endpoint `POST /<p>/identity/token` with `oidc` (JWKS) and `firebase` (x509) verifiers, returning the activation response

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity service (S-16) (phase-2, MVI)                                                                                                              |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                 |
| Depends on  | [I-04](I-04-identity-plan.md), [I-06](I-06-users-and-links.md)                                                                                         |
| Unblocks    | [I-12](I-12-game-verifiers.md), [I-13](I-13-native-redirect.md), [I-19](I-19-backend-assertion.md), [I-22](I-22-sdk-identity-v2-exchange.md)           |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-10.md` first; no code before a human approves it                                                              |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd` |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Apps that already sign users in exchange that credential at `POST /<p>/identity/token` (RFC 8693-shaped), verified by a generic `oidc` (JWKS) verifier and a `firebase` (x509) verifier, and receive the existing activation response; the discovery fragment advertises `methods[]` and exchange metadata.

## Why

Bring-your-own-auth (J3): one generic JWKS verifier covers most surveyed providers, and today no mainstream IdP works as `custom` ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-10; `plans/I-04.md`; `plans/I-10.md` once written and approved.
- `packages/worker/src/core/x509.ts`, `services/identity/idToken.ts`, `core/identityTrust.ts`.

## Scope

**In:**

- A plan (`plans/I-10.md`) by `pkey-wire-planner`, then: `errors.json` first (rule 3), the route, transcripts (rule 1), OpenAPI and `routeCoverage` (rule 10), the THREAT-MODEL delta.
- `oidc` verifier (JWKS with caching, `aud`, `azp`, `token_use`, `iss`, expiry, fail closed when unset) and `firebase` verifier (x509 certs, project id).
- Result goes through `signIn` (I-06); response is the activation response.
- Discovery `methods[]` and `exchange` metadata.

**Out** (and where it belongs instead):

- Game verifiers (→ I-12).
- RFC 7523 backend assertion (→ I-19).
- SDK `exchange()` (→ I-22).

## Design notes

- Audience confusion is the classic broker bug: enforce `aud`, `azp` (Clerk), `token_use` (Cognito); never accept a token whose audience is not configured for this product's method.
- Upstream tokens are consumed once and never stored (S-16 §5.5 minimisation).
- No `PROTOCOL_VERSION` bump.

## Steps

1. Plan approval.
2. Errors, verifiers, route, transcripts, OpenAPI, THREAT-MODEL.

## Acceptance criteria

- [ ] A valid Clerk-, Auth0- and Firebase-shaped token yields an activation response (tests with fixtures).
- [ ] Wrong `aud`, wrong `azp`, wrong `token_use`, expired and unconfigured cases are refused with the planned error codes (tests).
- [ ] Transcripts recorded; OpenAPI and `routeCoverage` updated; THREAT-MODEL delta written.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity exchange
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

- I-22 adds `exchange()` to six SDKs; I-12 adds verifier kinds; I-13 adds the native redirect token route; I-19 adds `assertion`.

The role agent sets `--set I-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-10 done`.
