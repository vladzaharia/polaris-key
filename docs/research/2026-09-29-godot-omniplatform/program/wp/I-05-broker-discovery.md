# I-05 Identity broker fix: OIDC discovery behind SSRF and allowlist gates, configurable scopes and groups claim, RFC 9207 iss, many oidc methods per product

| Field       | Value                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1, MVI)                                                                              |
| Size        | 0.6–0.85 engineer-weeks                                                                                                |
| Depends on  | [I-04](I-04-identity-plan.md)                                                                                          |
| Unblocks    | [I-20](I-20-apple-kind.md)                                                                                             |
| Role        | `pkey-implementer`                                                                                                     |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                               |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); THREAT-MODEL; generated docs pages (regenerate, never hand-edit) |
| Human input | none                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                              |

## Goal

The product OIDC broker works with any discovery-capable IdP: endpoints come from discovery (every discovered URL through the SSRF and issuer-allowlist gates), scopes and the groups claim are configurable, RFC 9207 `iss` is checked, a product may declare several `oidc` methods, and the issuer allowlist becomes mandatory once any exist.

## Why

Today paths are hard-coded to Pocket ID's `/api/oidc/token`, the scope is fixed to `openid email profile groups` (Google rejects unknown scopes), and only one IdP works (G4, G13) ([S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps) G4 G13, [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (manifest), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-05; `plans/I-04.md` once approved.
- `packages/worker/src/services/identity/oidc.ts` (`:200-231` allowlist, `:904-908`, `:1466`, `:1499`).
- `packages/shared-manifest/` (validator rules and the mutation table).
- Skill `authoring-pkey-manifests`.

## Scope

**In:**

- Discovery fetch and cache with SSRF checks on every discovered URL.
- `identity.methods[]` entries of `kind: oidc` with `issuer`, `clientId`, `audience`, `azp`, `scopes`, `groupsClaim`, `emailTrust`.
- RFC 9207 `iss` check and per-provider mix-up defence.
- Mandatory `OIDC_ISSUER_ALLOWLIST` once a product declares any `oidc` method (closes the "not applied when unset" gap).
- Validator rules, mutation-table entries and JSON schema for every new field (rule 9); regenerated docs pages.

**Out** (and where it belongs instead):

- the `apple` kind (→ I-20).
- Users and links (→ I-06); the broker still ends where it does today until I-06 swaps in `signIn`.
- The console editor (→ I-07).

## Design notes

- Fail closed: missing `aud`/`azp` configuration is a validation error, not a permissive default.
- Entra `email` is never trusted for linking (`emailTrust` cannot be set true for Entra issuers).
- Keep `provider: platform` working unchanged.

## Steps

1. Manifest schema and validator rules first (rule 9).
2. Discovery and SSRF gating.
3. Multi-method routing and `iss` checks.
4. Tests with fixture IdPs (Google-shaped, Clerk-shaped with `azp`, Cognito-shaped with `token_use`).

## Acceptance criteria

- [ ] A product with two `oidc` methods signs in through either, using discovered endpoints (tests).
- [ ] A discovered URL that fails SSRF or the allowlist is refused (test).
- [ ] A wrong `iss` in the authorization response is refused (test).
- [ ] Validator rules, mutation-table entries and schema exist for every new field; `gen` docs are regenerated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity oidc
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- I-20 adds non-generic kinds beside `kind: oidc`.
- I-10 reuses the discovery and JWKS cache for the `oidc` verifier.

The role agent sets `--set I-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-05 done`.
