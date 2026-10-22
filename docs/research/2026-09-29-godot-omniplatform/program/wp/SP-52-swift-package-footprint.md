# SP-52 Swift package footprint

| Field       | Value                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08))                                  |
| Size        | 0.5–0.8 engineer-weeks                                                                                              |
| Depends on  | none                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-52b](SP-52b-ios-app-footprint.md), [SP-62](SP-62-swift-server-vapor.md) |
| Role        | `pkey-sdk-porter`                                                                                                   |
| Plan mode   | no                                                                                                                  |
| Gates       | `ci:macos`                                                                                                          |
| Human input | none                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                           |

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

### Corrections recorded (code verified, 2026-10-11)

- **Archive.** SwiftPM archives the whole working tree of a package nested in a monorepo (`.gitattributes export-ignore` is honoured only when the package is the repository root). `sdks/swift/tools/stage-registry-source.sh` copies the tracked files minus `Tests/`, `PlatformHostTests/` and `tools/`, and `sign-registry-release.sh` publishes from that copy; `check-registry-archive.sh` asserts under 6 MB and no Tests directory (2.2 MB measured).
- **Fonts.** The static Rubik Regular/Bold and their notice are gone; the kit reads Rubik's regular and bold instances from the one variable face. JetBrains Mono stays because the kit's key and code fields use it.
- **zstd.** libzstd 1.5.7 is vendored from the official release tarball as the `libzstd` C target. `PolarisKeyUpdate` and `PolarisKeyUI` no longer depend on `PolarisKeyPacks`: a host that wants packs adds `PolarisKeyPacks` and passes the `PacksClient` as `UpdateClientOptions.content` (the `UpdateContentSource` seam in Core). `UpdateClientOptions(packs:)` is replaced by that, and every caller is migrated.
- **Resolve.** Owner decision (lead, 2026-10-11): `swift package resolve` clones only the macOS Sparkle binary dependency; zstd is vendored. UK-08 owns the Sparkle driver and is the package that can remove the residual Sparkle clone; `check-resolve-clones.sh` asserts exactly that.
- **Size.** `measure-ios-footprint.sh` builds the same Release arm64 app (kit plus `decide()`, `tools/size-app`) over the `v0.8.33` tag and over this tree with one toolchain, and exits non-zero unless this tree is at least 25% smaller. CI runs it report-only, in the `apple-footprint` job with `continue-on-error`, so a miss does not fail the build.

## Status

In progress. The 25% size target is not met: main CI run 39571880256 measured 3,348,956 B against a 3,109,960 B baseline (+7.7%). Everything else in the brief is met. The size target stays here, and `apple-footprint` stays report-only until it holds.

## Acceptance criteria

- [x] The published archive is under 6 MB with no Tests directory.
- [ ] A Release arm64 iOS app with the kit and `decide()` is at least 25% smaller than at 0.8.33 (measured in CI): moved to SP-52b (2026-10-22); +7.7% today.
- [x] `swift package resolve` clones only the macOS Sparkle binary dependency; zstd is vendored (UK-08 can remove the residual Sparkle clone).
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-52 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-52 done`.

## Split 2026-10-22 (triage)

Set done on the met criteria. The size target is **[SP-52b](SP-52b-ios-app-footprint.md)** (1 to 2 days). SP-62 does not need the target.
