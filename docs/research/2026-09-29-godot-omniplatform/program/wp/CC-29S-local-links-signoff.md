# CC-29S Local links security sign-off (LP1-LP3) and cryptographer part P5

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC                                                                                                                 |
| Size        | 0.15–0.2 engineer-weeks                                                                                            |
| Depends on  | [CC-29](CC-29-local-links.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-23L](CC-23L-local-links-plan.md) |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-implementer`                                                                                                 |
| Plan mode   | no                                                                                                                 |
| Gates       | threat-model, security-review                                                                                      |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Passes LP1-LP3, and LP6 over the kit API of CC-29.15 (after its Node slice), over the local-links contract, client-core, the Node SDK and the other SDKs, and the cryptographer packet part P5 (CPace and the Elligator2 map), with the `launch.localPairing` gate column in the sign-off plan.

## Why

Write-ups are kept out of the public repository until released. Findings are fixed in CC-29 or CC-29b, not here.

## Read first

- `AGENTS.md` (always).
- `plans/CC-18-U-44-U-45-signoff.md`
- The CC-23L plan §8

## Acceptance criteria

- [ ] LP1-LP3 are closed and the cryptographer's P5 verdict is recorded; the gate column is set.

## Hand-off

The role agent sets `--set CC-29S in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-29S done`.
