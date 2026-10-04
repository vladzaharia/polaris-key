# I-14 Game verifiers: Steam ticket with optional ownership grants through a Core hook, Game Center, Play Games, EOS; Godot iOS and Android shims; Swift and Kotlin helpers

| Field       | Value                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)                                                                                                                                                      |
| Size        | 1.6–2.25 engineer-weeks                                                                                                                                                                                                                     |
| Depends on  | [I-13](I-13-exchange-endpoint.md)                                                                                                                                                                                                           |
| Unblocks    | [I-19](I-19-identity-docs.md)                                                                                                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                                                                          |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                                                                    |
| Gates       | THREAT-MODEL; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); rule 9 (validator rule, mutation table, JSON schema); CI: Android; CI: macOS; per-verifier security review in the PR |
| Human input | Steamworks Web API publisher key; a Game Center-enabled app; a Play Games project linked in Play Console; an EOS deployment (live checks only; fixtures otherwise)                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                   |

## Goal

Players sign in with their platform identity as links on the account: Steam session tickets (with optional ownership grants), Game Center, Play Games and EOS, verified by the Worker; Godot gets iOS and Android shims and `signInWithSteam`; Swift and Kotlin get helpers.

## Why

Platform sign-in is the game program's differentiator ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J4). Steam ticket and x509 chain verification already exist for commerce, so the verifiers reuse them ([S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-13.md`.
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J4, [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) ("Tenant-scoped links"), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK table), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes) (commerce claims), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-14, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risks 6–8.
- `packages/worker/src/services/distribution/commerce/steam.ts`, `apple.ts`, `packages/worker/src/core/x509.ts`, `core/storeGrants.ts`, `core/hooks.ts`.

## Scope

**In:**

- Exchange kinds: Steam ticket (`identity: "pkey:<product>"`), Game Center signature (x509 chain, never pinning the leaf), Play Games server auth code, EOS Connect token.
- Optional Steam `CheckAppOwnership` grants through a Core descriptor hook (rule 6), so Identity never imports Distribution.
- `identity.native` manifest fields with validator rules (rule 9) and console setup checklists.
- Godot iOS and Android shims, `signInWithSteam` (GodotSteam `getAuthTicketForWebApi`); Swift Game Center and Kotlin Play Games helpers.

**Out** (and where it belongs instead):

- Developer guides for Steam, Game Center and tenant-scoped links (→ I-19).

## Design notes

- Each verifier gets its own security review recorded in the PR.
- Game Center, Play Games and EOS subjects are tenant-scoped (per team, game or deployment); Steam IDs are global ([S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model)).
- First sign-in per new link goes through the card (`interstitial_required`); Steam players may resent it, so the copy and a QR path on Steam Deck matter ([S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 6).
- The Godot shims may need `pkey-godot-engineer`; the lead can split them out if the native work grows.

## Steps

1. Steam ticket and ownership hook.
2. Game Center, Play Games, EOS verifiers with fixtures.
3. SDK shims and helpers; transcripts per kind.

## Acceptance criteria

- [ ] Each kind verifies against fixtures and refuses tampered or wrong-audience input (tests).
- [ ] Steam ownership grants flow through the Core hook; the `boundaries` test passes.
- [ ] Transcripts per kind; Godot, Swift and Kotlin replayers; Android and macOS CI green.
- [ ] Security review notes per verifier in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity steam gamecenter playgames eos
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- I-19 writes the platform guides against these kinds.

The role agent sets `--set I-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-14 done`.
