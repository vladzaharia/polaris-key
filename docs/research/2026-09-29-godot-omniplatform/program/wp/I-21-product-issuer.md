# I-21 `Sign in with <Product>`: per-product OIDC issuer with a separate RS256 keyring, `sub` = pairwise subject, `pkey:*` scopes, static clients

| Field       | Value                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                                                                                                                                             |
| Size        | 2.8–3.9 engineer-weeks                                                                                                                                                                                                                   |
| Depends on  | [I-20](I-20-layer-2-plan.md)                                                                                                                                                                                                             |
| Unblocks    | [U-16](U-16-developer-backend-api.md)                                                                                                                                                                                                    |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/I-20.md`](../plans/I-20.md) (no separate plan)                                                                                                                                                        |
| Gates       | plan mode; D1 migration; `TABLE_OWNERS`; rule 9 (validator rule, mutation table, JSON schema); rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `check:links`; OIDF Basic OP and Config OP conformance against staging; R-series audit |
| Human input | a staging deploy for the OIDF Basic OP and Config OP conformance runs                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                |

## Goal

"Sign in with <Product>": a per-product OIDC issuer at `https://key.plrs.im/<p>/identity` that passes OIDF Basic OP and Config OP conformance, with a separate RS256 keyring, `sub` = the product's pairwise subject, `pkey:*` scopes and static clients.

## Why

No licensing peer offers it, so it is a real differentiator ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J8); it makes Polaris a token issuer with ongoing duties ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 10).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-20.md`](../plans/I-20.md).
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J8, [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) ("Sign in with <Product>"), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 10, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-21.

## Scope

**In:** everything `plans/I-20.md` assigns to the issuer: discovery, JWKS, authorize, token, userinfo, refresh rotation with family revocation, revocation, end-session; clients and secrets shown once; console Clients page; THREAT-MODEL section.

**Out** (and where it belongs instead):

- Product-IdP kinds (→ I-22); app profiles (→ I-23).

## Design notes

- Keyring rotated about every 90 days, never mixed with the Ed25519 document keys; exact redirect-URI matching.
- Issuer tokens are outside the signed corpus.

## Steps

1. Keyring and discovery; authorize and token; userinfo and revocation.
2. Console Clients page; conformance runs on staging.

## Acceptance criteria

- [ ] OIDF Basic OP and Config OP pass against staging (results linked in the PR).
- [ ] `sub` equals the product's pairwise subject (test); refresh reuse revokes the family (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- issuer
```

## Hand-off

- U-16 uses issuer client credentials with a `pkey:sync` scope (S-17 decision 12).

The role agent sets `--set I-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-21 done`.
