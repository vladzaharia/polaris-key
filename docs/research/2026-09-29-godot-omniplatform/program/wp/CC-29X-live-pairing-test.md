# CC-29X Cross-SDK live pairing test: Node, Python, Kotlin JVM, Godot and Swift drivers over loopback

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | CC                                                                           |
| Size        | 0.15–0.25 engineer-weeks                                                     |
| Depends on  | [CC-29](CC-29-local-links.md), [CC-29b](CC-29b-local-links-android-godot.md) |
| Unblocks    | none                                                                         |
| Role        | `pkey-implementer`                                                           |
| Plan mode   | x                                                                            |
| Gates       | x                                                                            |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Goal

One test that pairs two real clients of different SDKs with a code over loopback, for every ordered pair of the Node, Python, Kotlin JVM, Godot and Swift drivers, and opens the link in mode l.

## Why

The local-links corpus proves each SDK against recorded vectors. Only a live run shows that two SDKs agree with each other.

## Read first

- `AGENTS.md` (always).
- `docs/security/WIRE-CONTRACT-V5.md` §15.12
- [CC-29](CC-29-local-links.md) and [CC-29b](CC-29b-local-links-android-godot.md)

## Acceptance criteria

- [ ] Every ordered pair of the five drivers pairs with a typed code and opens the link in mode l.
- [ ] The test needs no network beyond loopback and does not depend on the wall clock.

## Hand-off

The role agent sets `--set CC-29X in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-29X done`.
