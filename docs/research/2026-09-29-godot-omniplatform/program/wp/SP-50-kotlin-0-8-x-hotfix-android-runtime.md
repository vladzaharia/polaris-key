# SP-50 Kotlin 0.8.x hotfix: Android runtime, packaging, desktop store

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 1.5–2 engineer-weeks                                                               |
| Depends on  | none                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                             |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no                                                                                 |
| Gates       | `ci:android`                                                                       |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

Kotlin 0.8.x hotfix: Android runtime, packaging, desktop store, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-50) and §10.4.

## Scope

**In:** Ed25519 backend chosen by an RFC 8032 known-answer test, Tink preferred on Android; every public suspend function main-safe (body read and store, keyring and cache I/O off the caller's dispatcher); `PolarisKeyAndroid.client()` returns a usable client, a suspend `create()`, the kit starts it, `CoreOptions` without a store fails clearly on Android; `OkHttpTransport()` compiles for consumers; Gradle variants so `sdk`, `ui`, `billing` and `android-*` resolve zstd-jni's AAR with no excludes; packs optional; consumer R8 rules or a JVM-only RAM probe; `java-keyring` through a desktop artifact with a once-per-run warning when the store degrades; an emulator lane (minSdk, 34, newest) and a consumer app on documented and latest toolchains.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] On an API 36 emulator, `client(context)` → `activate()` → `sync()` launched from `Dispatchers.Main` against a server that splits headers and body gives `Ok` and an applied licence, with no workaround in app code.
- [ ] StrictMode `penaltyDeath` covers every public suspend function.
- [ ] `sdk` + `android-direct` + `ui` + `billing` build `assembleDebug` and minified `assembleRelease` on compileSdk 36 and 37 with no app rules.
- [ ] An APK without packs has no `libzstd-jni`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-50 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-50 done`.
