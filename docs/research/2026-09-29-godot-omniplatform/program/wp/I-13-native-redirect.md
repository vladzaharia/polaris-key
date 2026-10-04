# I-13 Native redirect sign-in: PKCE public-client token route, retire `/auth/poll`, `signIn({redirect})` in all six SDKs

| Field       | Value                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-2)                                                                                                                                  |
| Size        | 0.8–1.15 engineer-weeks                                                                                                                                               |
| Depends on  | [I-10](I-10-exchange-endpoint.md)                                                                                                                                     |
| Unblocks    | none                                                                                                                                                                  |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-13.md` first; no code before a human approves it                                                                             |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs + `parity:check`; THREAT-MODEL |
| Human input | none                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                             |

## Goal

Desktop and mobile apps sign in by native redirect: a PKCE public-client token route for loopback, claimed-HTTPS and registered-scheme redirects; `/auth/poll` retired; `signIn({redirect})` in all six SDKs.

## Why

G3: `/auth/poll` "completes no flow" and Swift's login view defaults to a no-op; device code is a poor fit on a phone (J9) ([S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps) G3, [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK table, `signIn({redirect})` row), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-13; `plans/I-13.md` once approved.
- `packages/worker/src/services/identity/oidc.ts:1871-1885`, `core/cors.ts`.

## Scope

**In:**

- A plan (`plans/I-13.md`).
- Token route (PKCE S256 only), exact redirect matching, registered native schemes per product.
- Retire `/auth/poll` and its rate-limit buckets.
- Node and Python (loopback), Swift (ASWebAuthenticationSession), Kotlin (Custom Tabs), React (web redirect with the route's CORS), Godot (desktop loopback; device code on mobile and console).
- Transcripts, `errors.json`, OpenAPI.

**Out** (and where it belongs instead):

- Issuing OIDC tokens to third parties (→ I-16).

## Design notes

- No non-http(s) schemes except per-product registered native schemes.
- The route returns the activation response; no `PROTOCOL_VERSION` bump.

## Steps

1. Plan approval.
2. Route and retirement with transcripts.
3. Six SDKs.

## Acceptance criteria

- [ ] A loopback flow completes in Node and Python; Swift and Kotlin complete against the route in tests.
- [ ] An unregistered redirect or a `plain` PKCE challenge is refused (tests).
- [ ] `/auth/poll` is gone; transcripts and OpenAPI updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
- [ ] Every SDK's `parity.json` is updated and `pnpm parity:check` passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity redirect
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- Swift's `PolarisLoginView(onSignIn:)` gets a real default.

The role agent sets `--set I-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-13 done`.
