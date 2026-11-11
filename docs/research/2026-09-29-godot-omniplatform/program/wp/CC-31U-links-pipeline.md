# CC-31U Links: one pipeline, Automatic Pairing, the pairing payload

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC                                                                                                                                                         |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                     |
| Depends on  | [CC-31](CC-31-pipeline-plan.md), [CC-29](CC-29-local-links.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-29K](CC-29K-local-links-kit-screens.md) |
| Unblocks    | [CC-31S](CC-31S-pipeline-signoff.md), [CC-30](CC-30-cloud-pairing.md)                                                                                      |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                       |
| Plan mode   | x                                                                                                                                                          |
| Gates       | x                                                                                                                                                          |
| Human input | none                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                  |

## Goal

Pairing, Direct Transfer and sync run through one pipeline, with Automatic Pairing and the pairing payload, in every SDK.

## Why

It is a wire change (AGENTS.md rule 2), so it runs in plan mode against the CC-31 plan: contract, catalog, corpus, then every SDK.

## Read first

- `AGENTS.md` (always).
- `docs/security/WIRE-CONTRACT-V5.md`
- [CC-29K](CC-29K-local-links-kit-screens.md)

## Acceptance criteria

- [ ] The corpus is regenerated and every SDK passes it; `pnpm gen --check` is clean.
- [ ] Every new validator rule has a mutation-table entry.
- [ ] Every screen passes `pkey-ux-reviewer` in BUILT mode.

## Hand-off

The role agent sets `--set CC-31U in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-31U done`.
