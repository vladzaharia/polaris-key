# I-22 Bring-your-own-auth: `oidc` (JWKS) and `firebase` (x509) exchange kinds for the product's own IdP, product-scoped principals, optional portal-side linking under step-up, SDK support

| Field       | Value                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                                                                                                                                |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                      |
| Depends on  | [I-13](I-13-exchange-endpoint.md), [I-20](I-20-layer-2-plan.md)                                                                                                                                                             |
| Unblocks    | none                                                                                                                                                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                       |
| Plan mode   | yes: executes the approved [`plans/I-20.md`](../plans/I-20.md) (no separate plan)                                                                                                                                           |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`); THREAT-MODEL; rule 9 (validator rule, mutation table, JSON schema) |
| Human input | none                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                   |

## Goal

An app that already signs users in (Clerk, Firebase, Auth0, Supabase, Cognito) exchanges that token through `oidc` (JWKS) and `firebase` (x509) kinds for a product-scoped principal; the person can link it to their Polaris account only from the portal under step-up; SDKs support the kinds.

## Why

No user migration for the product ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J3). A tenant-controlled login must never hang on the shared account, because the tenant could mint sign-ins for anyone ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 14, D18).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-20.md`](../plans/I-20.md).
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J3, [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) ("Bring-your-own-auth is layer 2"), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 14, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-22, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D18.

## Scope

**In:** `oidc` and `firebase` exchange kinds on I-13's route, `identity.methods[]` manifest entries (rule 9), product-only principals, portal-side linking under step-up, SDK support in all six SDKs.

**Out** (and where it belongs instead):

- Platform kinds (done in I-13 and I-14).

## Design notes

- Fail closed: missing `aud`/`azp` configuration is a validation error; Entra `email` is never trusted for linking.

## Steps

1. Kinds and manifest rules; product-only principals.
2. Portal linking; SDKs and transcripts.

## Acceptance criteria

- [ ] A product-IdP sign-in never reaches the global account unless linked from the portal under step-up (test).
- [ ] Transcripts and parity rows for both kinds in all six SDKs.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity exchange
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- I-25 and U-16 can rely on product-scoped principals existing.

The role agent sets `--set I-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-22 done`.
