# I-21 Sign in with <Product> on the OAuth-shaped endpoints

| Field       | Value                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                                                                                                                                             |
| Size        | 1.9–2.6 engineer-weeks                                                                                                                                                                                                                   |
| Depends on  | [I-20](I-20-layer-2-plan.md)                                                                                                                                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-16](U-16-developer-backend-api.md)                                                                                                                                                            |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/I-20.md`](../plans/I-20.md) (no separate plan)                                                                                                                                                        |
| Gates       | plan mode; D1 migration; `TABLE_OWNERS`; rule 9 (validator rule, mutation table, JSON schema); rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `check:links`; OIDF Basic OP and Config OP conformance against staging; R-series audit |
| Human input | a staging deploy for the OIDF Basic OP and Config OP conformance runs                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W17.md`](../plans/PX-W17.md):** append `oauth/authorize` to the navigation entries; the ID token `sub` is the pairwise subject.

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`.

- **The `picture` claim** ([PX-W16](PX-W16-profile-avatars.md)). This issuer is the first to put a
  picture in a token. The ID token's and userinfo's `picture`, when the person consented to share it
  (PX-W13's `CONSENT_PROFILE_CLAIMS`), is `avatarUrl(accounts.avatar_key)` (`card/avatars.ts`) made
  absolute on the console origin: the account's chosen picture as the consent view shows it,
  re-encoded and served by `/media/avatar/<asset>` (which already allows cross-origin embedding).
  It is absent when the account shows initials (`avatar_key` NULL), and never a provider's original
  picture URL.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Sign in with <Product> on I-08's OAuth-shaped endpoints: adds discovery, a separate RS256 JWKS, id_token, userinfo, refresh, revocation, end-session and OIDF conformance. No second authorization-server tree; estimate drops about a third.

- Title: was "`Sign in with <Product>`: per-product OIDC issuer with a separate RS256 keyring, `sub` = pairwise subject, `pkey:*` scopes, static clients".
- Estimate: 1.9–2.6 engineer-weeks (was 2.8–3.9).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the same endpoints; `openid`; clients extend `ClientRecord`; the §12.8 sentence.

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
- Part of the per-product Identity service: the issuer exists only while the product's Identity toggle is on (owner, 2026-10-04). Its consent screen builds on the D22 "Continue to <App>" grant, and the `email` scope releases the account email only with consent (D19), both decided 2026-10-04.

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
