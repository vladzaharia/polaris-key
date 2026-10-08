# I-22 Bring-your-own-auth: `oidc` (JWKS) and `firebase` (x509) exchange kinds for the product's own IdP, product-scoped principals, optional portal-side linking under step-up, SDK support

| Field       | Value                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                                                                                                                                |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                      |
| Depends on  | none                                                                                                                                                                                                                        |
| Unblocks    | none                                                                                                                                                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                       |
| Plan mode   | yes: executes the approved [`plans/I-20.md`](../plans/I-20.md) (no separate plan)                                                                                                                                           |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`); THREAT-MODEL; rule 9 (validator rule, mutation table, JSON schema) |
| Human input | none                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                   |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [I-32](I-32-product-connections-absorbs-i-22.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [I-32](I-32-product-connections-absorbs-i-22.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Bring-your-own-auth becomes a product connection with exchange: true; firebase is an oidc connection with a JWKS override.

- Dependencies cleared on closing (they were I-13 and I-20), so nothing in the graph waits on or through a closed package.
- `planRef` removed on closing (it executed I-20's plan, [`plans/I-20.md`](../plans/I-20.md)).

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
- D18 is decided (owner, 2026-10-04): the product-IdP principal is product-only; linking to the global account happens only from the portal under step-up, never in the app. Available only for products with Identity on.

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
