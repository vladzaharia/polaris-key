# SP-52 Swift package footprint

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.5–0.8 engineer-weeks                                                             |
| Depends on  | none                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-62](SP-62-swift-server-vapor.md)       |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no                                                                                 |
| Gates       | `ci:macos`                                                                         |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

Swift package footprint, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-52) and §10.4.

## Scope

**In:** the registry archive drops tests and tools; one Rubik variant, JetBrains Mono only if used; iOS hosts link `decide()` without packs and libzstd; zstd vendored as a C target.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The published archive is under 6 MB with no Tests directory.
- [ ] A Release arm64 iOS app with the kit and `decide()` is at least 25% smaller than at 0.8.33 (measured in CI).
- [ ] `swift package resolve` clones nothing.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-52 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-52 done`.
