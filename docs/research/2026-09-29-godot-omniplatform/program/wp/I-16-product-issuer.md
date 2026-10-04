# I-16 `Sign in with <Product>`: per-product OIDC issuer with a separate RS256 keyring, static clients, pairwise subjects and entitlement claims

| Field       | Value                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-3)                                                                                                                            |
| Size        | 2–2.8 engineer-weeks                                                                                                                                            |
| Depends on  | [I-06](I-06-users-and-links.md), [I-08](I-08-email-login.md)                                                                                                    |
| Unblocks    | none                                                                                                                                                            |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                           |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-16.md` first; no code before a human approves it                                                                       |
| Gates       | plan mode; D1 migration; `TABLE_OWNERS`; rule 9 (validator rule, mutation table, JSON schema); rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `check:links` |
| Human input | staging deploy for the OIDF Basic OP and Config OP conformance runs                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                       |

## Goal

"Sign in with <Product>": a per-product OIDC issuer at `https://key.plrs.im/<p>/identity` with discovery, JWKS on a separate RS256 keyring, authorize (code + PKCE S256), token, userinfo, refresh rotation, revocation and end-session; static clients registered in the console and manifest; pairwise subjects; `pkey:*` scopes; entitlement claims; passing the OIDF Basic OP and Config OP conformance plans on staging.

## Why

J8: no licensing peer offers it. The owner put it in scope (phase 3) and decided: in-house on `jose` is the lean, decided in this package's plan, with Ory Hydra (Worker as login and consent app) as the alternative ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs), [S-16 §4 Option F](../../notes/S-16-identity-service.md#option-f-run-a-separate-open-source-idp-for-end-users), [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D8, D12).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) ("Sign in with <Product>"), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 10, [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §4 Option F](../../notes/S-16-identity-service.md#option-f-run-a-separate-open-source-idp-for-end-users), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-16, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D8 D12; `plans/I-16.md` once approved.
- `packages/worker/src/keyvault.ts` (`PLATFORM_KEK` keyring and AAD kinds).

## Scope

**In:**

- A plan (`plans/I-16.md`) that **decides in-house on `jose` versus Ory Hydra** (owner leaning in-house to stay on Workers, unless conformance proves heavier than running Hydra).
- Issuer endpoints; `identity_clients` and `identity_grants`; console Clients page (secrets shown once) and manifest clients (rule 9).
- RS256 keyring sealed under `PLATFORM_KEK` with its own AAD kind, rotated about every 90 days (`next`, `active`, `retired`), never mixed with the Ed25519 document keys.
- Refresh-token rotation with family revocation on reuse; exact redirect-URI matching; per-client registered native schemes only.
- Pairwise subjects; namespaced claims (`https://key.plrs.im/claims/entitlements`) carrying entitlements, not licence state; access tokens 5–15 minutes.
- Back-channel logout to relying parties on user deletion.
- Portal "connected apps" **API** (list and revoke grants).
- THREAT-MODEL section; an R-series audit (~3 days); "Sign in with <Product>" recipes in the docs.

**Out** (and where it belongs instead):

- Custom auth domains (deferred by the owner).
- Dynamic client registration (never, J15).
- Device SDK changes (none: tokens are for web and backend relying parties).
- Portal "connected apps" screens (→ portal redesign per `docs/design/PORTAL.md`).

## Design notes

- **Portal UI follows `docs/design/PORTAL.md`.** The customer portal is being redesigned in parallel and its spec will be `docs/design/PORTAL.md`. This package delivers only the API and data the portal needs; any portal screen is built to PORTAL.md once it lands (by the portal redesign work, or a follow-up here if PORTAL.md has landed first). Do not design portal UI in this package.
- An issuer URL cannot change once relying parties integrate; path-based first is deliberate.
- Codes and grants single-use through I-02's store.
- New signed artefact outside the corpus; OIDF conformance is its gate. No `PROTOCOL_VERSION` change.

## Steps

1. Plan (with the jose/Hydra decision) and approval.
2. Keyring, clients, endpoints.
3. Conformance runs on staging (owner deploy).
4. Audit, THREAT-MODEL, docs recipes.

## Acceptance criteria

- [ ] `plans/I-16.md` records the in-house versus Hydra decision with reasons.
- [ ] OIDF Basic OP and Config OP plans pass against staging (results linked in the PR).
- [ ] Refresh reuse revokes the family (test); pairwise subjects differ across products for one portal account (test).
- [ ] Keys rotate through `next`/`active`/`retired` and are never the document keys (test).
- [ ] Audit findings resolved or filed; THREAT-MODEL section written.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity issuer
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- The portal redesign builds "connected apps" on the grants API.

The role agent sets `--set I-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-16 done`.
