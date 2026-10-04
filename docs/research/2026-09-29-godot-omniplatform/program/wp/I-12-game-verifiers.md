# I-12 Game-platform verifiers: Steam ticket, Game Center, Play Games, EOS, with Godot shims and Swift and Kotlin helpers

| Field       | Value                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-2)                                                                                                                                                              |
| Size        | 1.6–2.25 engineer-weeks                                                                                                                                                                           |
| Depends on  | [I-10](I-10-exchange-endpoint.md), [I-22](I-22-sdk-identity-v2-exchange.md)                                                                                                                       |
| Unblocks    | none                                                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                          |
| Gates       | THREAT-MODEL; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs + `parity:check`; rule 9 (validator rule, mutation table, JSON schema); Android CI; macOS CI |
| Human input | Steamworks Web API publisher key; a Game Center-enabled app; a Play Games project linked in Play Console; an EOS deployment (live checks only; fixtures otherwise)                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                         |

## Goal

Games sign users in silently with their platform identity: Steam ticket, Game Center signature, Play Games server auth code and EOS ID token verifiers behind the exchange endpoint, Godot iOS and Android shims, and Swift and Kotlin helpers.

## Why

J4 is the game-program differentiator; Steam and x509 verification already exist for commerce ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes), [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risks 4 and 5).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-12, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risks 4 and 5.
- `packages/worker/src/services/distribution/commerce/steam.ts`, `apple.ts`, `packages/worker/src/core/x509.ts`, `core/storeGrants.ts`, `core/hooks.ts`.

## Scope

**In:**

- Verifier kinds `steam`, `gamecenter`, `pgs`, `eos` with manifest fields (rule 9).
- Steam: ticket with the per-product `identity` string enforced; optional `CheckAppOwnership` and store grants at first sign-in through a Core descriptor hook (rule 6).
- Game Center: reuse `core/x509.ts`; do not pin the leaf (Apple rotates).
- Play Games and EOS.
- Godot iOS (Game Center) and Android (Play Games) shims; Swift `signInWithGameCenter()`, Kotlin `signInWithPlayGames()`, Godot `signInWithSteam()` over GodotSteam `getAuthTicketForWebApi("pkey:<product>")`.
- Transcripts per kind.

**Out** (and where it belongs instead):

- Console platforms PSN, Xbox, Nintendo (→ I-19, later).

## Design notes

- Each verifier gets its own security review recorded in the PR.
- The Godot shims may need `pkey-godot-engineer`; the lead can split them out if the native work grows.
- A platform-only user recovers by signing in on that platform again; SDKs prompt such users to add an email after first sign-in (product setting, on by default).

## Steps

1. Worker verifiers with fixtures and transcripts.
2. Core hook for store grants.
3. SDK helpers and Godot shims.

## Acceptance criteria

- [ ] Each kind accepts a valid fixture and refuses wrong identity string, wrong bundle or app id, and expired inputs (tests).
- [ ] Store grants run only through the Core hook (`boundaries` test).
- [ ] The add-an-email prompt is on by default and switchable.
- [ ] Per-verifier security review in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
- [ ] Every SDK's `parity.json` is updated and `pnpm parity:check` passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity exchange steam gamecenter
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- I-17 links the Steam and Game Center guides this package writes.

The role agent sets `--set I-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-12 done`.
