# I-11 SDK identity v2 part 1 in all six SDKs: email sign-in with hosted-page fallback, `user`, `signOut`, `deleteUser`, P1-07 attach everywhere

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity service (S-16) (phase-1, MVI)                                                                          |
| Size        | 1.2–1.7 engineer-weeks                                                                                             |
| Depends on  | [I-08](I-08-email-login.md)                                                                                        |
| Unblocks    | [I-22](I-22-sdk-identity-v2-exchange.md)                                                                           |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-11.md` first; no code before a human approves it                          |
| Gates       | plan mode; all six SDKs + `parity:check`; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check` |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

All six SDKs (Node, React, Python, Swift, Kotlin, Godot) offer `signInWithEmail` and `verifyCode` with the hosted-page fallback, `user()`, `signOut()` and `deleteUser()`, and P1-07 confirm-and-attach everywhere, each passing the I-08 transcripts.

## Why

The email routes are device wire; the wave order is I-04 → I-08 → I-11 ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)). P1-07's attach step exists only in Godot today, and React's `identity.oidc` parity row has no transcript ([S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK API table), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 4, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-11; `plans/I-11.md` once written and approved.
- `conformance/parity/features.json`, each SDK's `parity.json`, `packages/sdk-node/src/identity/client.ts`, `sdks/swift/Sources/PolarisKeyUI/PolarisLoginView.swift`.

## Scope

**In:**

- A plan (`plans/I-11.md`) naming the per-language API.
- The calls above in all six SDKs, each language in its idiom.
- Hosted-page fallback when in-SDK start is off or no device token exists: open the system browser, complete through device code or loopback.
- Transcript replayers for the I-08 transcripts in each SDK; close the React `identity.oidc` transcript gap.

**Out** (and where it belongs instead):

- `exchange`, `link`, `unlink` (→ I-22).
- Native redirect `signIn({redirect})` (→ I-13).

## Design notes

- In-SDK `email/start` needs a registered device token; never ship Turnstile in an SDK.
- `deleteUser` supports App Store 5.1.1(v) in-app deletion; the server-side deletion semantics are I-07's.
- The email code UI copy keeps "never share this code".

## Steps

1. Plan approval.
2. Node first against transcripts, then React, Python, Swift, Kotlin, Godot.
3. Parity manifests and constants.

## Acceptance criteria

- [ ] Each SDK replays the I-08 email transcripts with identical verdicts.
- [ ] Each SDK falls back to the hosted page when in-SDK start is disabled or no device token exists (test per SDK).
- [ ] P1-07 confirm-and-attach is available in all six SDKs.
- [ ] `gen:constants -- --check` passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
- [ ] Every SDK's `parity.json` is updated and `pnpm parity:check` passes.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm test
```

## Hand-off

- I-22 extends the same identity client with `exchange`, `link` and `unlink`.

The role agent sets `--set I-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-11 done`.
