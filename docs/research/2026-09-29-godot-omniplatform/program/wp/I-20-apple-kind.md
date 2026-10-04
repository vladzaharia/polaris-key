# I-20 Apple provider kind (not generic OIDC)

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1)                                                                    |
| Size        | 0.4–0.55 engineer-weeks                                                                                 |
| Depends on  | [I-05](I-05-broker-discovery.md), [I-06](I-06-users-and-links.md)                                       |
| Unblocks    | none                                                                                                    |
| Role        | `pkey-implementer`                                                                                      |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`) |
| Human input | an Apple Services ID, .p8 key and registered return URL (live checks only; fixtures otherwise)          |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Goal

Products can offer Sign in with Apple (`kind: apple`), the common provider that is not generic OIDC.

## Why

Apple needs a Worker-minted client secret and a cross-site `form_post` callback. App Review 4.8 makes Apple a requirement for iOS products offering social login ([S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) ("Not every social provider is generic OIDC", "App Review 4.8"), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-20.
- `packages/worker/src/services/identity/oidc.ts`, `keyvault.ts` (sealed secrets).

## Scope

**In:**

- `kind: apple`: ES256 client secret minted per request (or cached briefly) from the sealed `.p8` (team id, key id, Services ID as `sub`, at most 6 months' lifetime); `form_post` callback found by `state` server-side, never by a Lax cookie; first-authorisation name capture; a server-to-server notifications endpoint that unlinks or flags the user.
- Validator rules and mutation-table entries (rule 9); provider fixtures; routes (rule 10).

**Out** (and where it belongs instead):

- Apple private-relay sender registration (→ I-21).

## Design notes

- Apple's hidden relay emails receive mail only from registered sender domains; coordinate with I-21.
- The validator warning for iOS + social without `apple` lands in I-07's console page; the rule itself is here or in I-05.

## Steps

1. Manifest rules.
2. Apple kind with fixtures.

## Acceptance criteria

- [ ] Apple callback works without a Lax cookie (test); the name is stored on first authorisation (test).
- [ ] Rule 9 artefacts exist.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity apple
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
```

## Hand-off

- iOS products using social login through I-05 can ship once this lands.

The role agent sets `--set I-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-20 done`.
