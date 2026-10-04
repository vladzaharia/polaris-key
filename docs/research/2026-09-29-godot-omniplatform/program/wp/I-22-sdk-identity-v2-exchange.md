# I-22 SDK identity v2 part 2 in all six SDKs: `exchange`, `link` and `unlink`

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity service (S-16) (phase-2, MVI)                                                                          |
| Size        | 0.8–1.15 engineer-weeks                                                                                            |
| Depends on  | [I-10](I-10-exchange-endpoint.md), [I-11](I-11-sdk-identity-v2-email.md)                                           |
| Unblocks    | [I-12](I-12-game-verifiers.md), [I-17](I-17-identity-docs.md)                                                      |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-22.md` first; no code before a human approves it                          |
| Gates       | plan mode; all six SDKs + `parity:check`; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check` |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

All six SDKs offer `exchange({kind, token, provider})`, `link(...)` and `unlink(id)`, each passing the I-10 transcripts.

## Why

Bring-your-own-auth reaches apps only through the SDKs; link and unlink complete J6 ([S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK table), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-22; `plans/I-22.md` once approved.

## Scope

**In:**

- A plan (`plans/I-22.md`).
- `exchange`, `link`, `unlink` in Node, React, Python, Swift, Kotlin and Godot.
- Transcript replayers; parity manifests.

**Out** (and where it belongs instead):

- Platform helpers (`signInWithSteam` etc., → I-12).

## Design notes

- `link` needs the current session; `unlink` surfaces `last_link`.

## Steps

1. Plan approval.
2. Node first, then the other five.

## Acceptance criteria

- [ ] Each SDK replays the exchange, link and unlink transcripts with identical verdicts.
- [ ] `last_link` and `link_conflict` surface as typed errors in every SDK.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
- [ ] Every SDK's `parity.json` is updated and `pnpm parity:check` passes.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm test
```

## Hand-off

- I-12 builds platform helpers on `exchange`.

The role agent sets `--set I-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-22 done`.
