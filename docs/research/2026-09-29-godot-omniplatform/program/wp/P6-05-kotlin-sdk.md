# P6-05 The Kotlin SDK at full parity (umbrella)

| Field       | Value                                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                                                                                                                                                     |
| Size        | 0.1 engineer-weeks                                                                                                                                                                                                                                                                                         |
| Depends on  | [P6-06](P6-06-kotlin-core-runner.md), [P6-07](P6-07-kotlin-license-config-identity.md), [P6-08](P6-08-kotlin-update-packs.md), [P6-09](P6-09-kotlin-platform-module.md), [P6-10](P6-10-godot-android-binding-on-kotlin.md), [P6-11](P6-11-kotlin-compose-ui-kit.md), [P6-12](P6-12-kotlin-android-glue.md) |
| Unblocks    | none                                                                                                                                                                                                                                                                                                       |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                                                          |
| Plan mode   | no (an umbrella: it has no code of its own; a corpus case a child finds missing goes to `pkey-wire-planner`)                                                                                                                                                                                               |
| Gates       | none of its own; the children's gates, and the closing checks below                                                                                                                                                                                                                                        |
| Human input | none. Decided 2026-10-04: build now; Kotlin artifacts ship only through Polaris Key's own Maven feed, with no Maven Central account or signing key                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                  |

This package is an **umbrella**. It owns no branch and no pull request. It is `done` when all of its
children are `done` and the closing checks below pass; the lead then sets it with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-05 done`. It stays
`todo` until then (it is not dispatched), and `--ready` lists it only once every child is done.

The graph's id pattern has no letter suffix, so the slices have their own ids, and the original
sketch's letters map as below.

| Slice | Package                                                                                      | Role                  | Size (weeks) | Depends on                           |
| ----- | -------------------------------------------------------------------------------------------- | --------------------- | ------------ | ------------------------------------ |
| a     | [P6-06](P6-06-kotlin-core-runner.md) core module, runner, parity                             | `pkey-sdk-porter`     | 1.5–2        | P1b-01, P1b-02, P1b-03, P3-02, P5-06 |
| b     | [P6-07](P6-07-kotlin-license-config-identity.md) licence, config, devices, identity, release | `pkey-sdk-porter`     | 1.5–2        | P6-06                                |
| c     | [P6-08](P6-08-kotlin-update-packs.md) update and packs                                       | `pkey-sdk-porter`     | 2–3          | P6-06, P6-07, P4-11, P4-29           |
| d     | [P6-09](P6-09-kotlin-platform-module.md) platform module, Integrity                          | `pkey-implementer`    | 1.5–2        | P6-06, P5-06, P6-02                  |
| e     | [P6-10](P6-10-godot-android-binding-on-kotlin.md) Godot binding on platform                  | `pkey-godot-engineer` | 1–1.5        | P6-09, P5-08                         |
| f     | [P6-11](P6-11-kotlin-compose-ui-kit.md) Compose UI kit                                       | `pkey-implementer`    | 2–3          | P6-07, P6-08                         |
| g     | [P6-12](P6-12-kotlin-android-glue.md) Android glue (added)                                   | `pkey-sdk-porter`     | 1–1.5        | P6-08, P6-09                         |

## Goal

A full-parity Kotlin SDK in `sdks/kotlin` for native Android apps and, where sensible, JVM desktop,
with a Jetpack Compose UI kit, whose `parity.json` has no `planned` row except those that Swift
also leaves `planned` and `unowned` (`identity.oidc`, `commerce.receipt`, `packs.transport.steam`),
and whose Godot Android binding is rebuilt on the platform module only.

## Why

- Owner decisions of 2026-10-04 (supersede [README §11 decision 10](../../README.md#11-decisions-needed)
  and [PARITY §9](../../PARITY.md#9-new-sdks-order-and-shape) item 3, which called this optional):
  1. Build it now; it is no longer optional.
  2. Full-parity SDK for native Android (and JVM where sensible) plus a Compose UI kit modelled on
     the SwiftUI kit: every screen centred and polished; a neutral default theme that inherits the
     host app's look; Polaris Key branding optional through one opt-in switch; the "Powered by"
     badge optional and off by default.
  3. The Godot Android binding is rebuilt on the Kotlin SDK's **platform module only** (Play,
     Keystore, PackageInstaller, Integrity). Verification stays in Godot's shared GDScript core,
     as Godot on iOS uses only Swift's `PolarisKeyPlatform`.
  4. **No Maven Central.** Kotlin artifacts are distributed only through Polaris Key's own Maven
     feed ([F-07](F-07-maven-feed.md), [F-10](F-10-sdks-onto-feeds.md)).
- One 6–8 week package was not reviewable; the SDK now builds in slices that each flip a named set
  of parity rows.

## Read first

- `AGENTS.md`, `.claude/agents/pkey-sdk-porter.md`, [PARITY](../../PARITY.md), `conformance/parity/features.json`.
- [P5-06](P5-06-kotlin-aar.md) (what exists in `sdks/kotlin` today, with its Corrections) and each
  child brief.

## Scope

**In:** the seven children above, and the closing checks. **Out:** Compose Multiplatform, Kotlin
Multiplatform for Apple targets (notes/E9), a Kotlin desktop UI kit, any Maven Central publication.

## Design notes

- **Build order.** P6-06 first; P6-07 and P6-09 can then run in parallel; P6-08 follows P6-07;
  P6-12 needs P6-08 and P6-09; P6-11 needs P6-07 and P6-08; P6-10 waits for P6-09 and P5-08.
  Only one corpus-touching package at a time ([README §5](README.md)); every Kotlin slice edits
  `sdks/kotlin/parity.json`, so rebase before review.
- **Module map** (proposed in P6-06, settled there): JVM libraries `:core`, `:license`, `:config`,
  `:identity`, `:release`, `:update`, `:packs`, `:sdk`; Android libraries `:platform` (standalone),
  `:android` (the only module that sees both core and platform), `:ui`, `:godot`.
- **Distribution.** Every module carries `maven-publish` metadata (sources jar, POM, Gradle module
  metadata) to a local `build/repo`. [F-10](F-10-sdks-onto-feeds.md) publishes them to Polaris Key's
  feed; no child adds a `signing` or Central plugin.
- **Typed N/As** per [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here): the JVM has no install
  source or In-App Updates; Android has no hardware serials (app-scoped id and Keystore instead).
  The registry rows for `android` and `jvm` are settled once, in P6-06.

## Steps

1. Dispatch the children in the order above; each follows its own brief and review.
2. When all are `done`, run the closing checks and set this package `done`.

## Acceptance criteria

- [x] P6-06 to P6-12 are all `done`.
- [x] `sdks/kotlin/parity.json` has no `planned` row except the Swift-matching unowned rows, each
      with a note; every `na` is allowed by the registry; `parity:check` is green.
- [x] The Kotlin runner passes every file in `conformance/corpus/v2/` and every transcript in
      `conformance/transcripts/` that exists when the last child closes.
- [x] The Godot AAR's dependency graph contains `:platform` and no other SDK module.
- [x] No Maven Central, Sonatype or `signing` configuration exists in `sdks/kotlin`.
- [x] Every place that lists the SDK languages (AGENTS.md, READMEs, docs pages, `test:all`) names Kotlin.

## Verify

```sh
( cd sdks/kotlin && ./gradlew build )
mise exec node@22 -- pnpm parity:check -- --check
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
grep -rniE "maven ?central|sonatype|signing" sdks/kotlin --include=*.kts --include=*.toml --include=*.properties
```

## Hand-off

- A published-ready Kotlin SDK and UI kit for [F-10](F-10-sdks-onto-feeds.md) to put on the feed;
  Unity and MAUI Android can bind the same `:platform` AAR.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-05 done`.

## Plan amendments (P4-10, P4-19, P4-29)

The approved plans' amendments for the Kotlin SDK moved to [P6-08](P6-08-kotlin-update-packs.md),
which owns the pack engine they change.

## Corrections from closing

Recorded at the close-out on 2026-10-04 (branch `wp/P6-05-closeout`). The code is the fact where
this brief and the code disagree.

- **Four unowned planned rows, not three.** Besides `identity.oidc`, `commerce.receipt` and
  `packs.transport.steam`, `devices.attest` stays `planned` and unowned. Swift leaves the same row
  planned and unowned (App Attest is in `PolarisKeyPlatform`, unwired to the client), as Kotlin
  does for Play Integrity in `:platform`; each row carries a note, and `parity:check -- --check` is
  green.
- **Transcripts.** The runner replays 17 of the 18 transcripts on both Ed25519 backends (JCA and
  Tink forced, 98 tests each). `commerce-claim.json` proves `commerce.receipt`, which is planned
  and unowned in Kotlin as in Swift, so `parity.json` makes it not applicable.
- **The `signing` grep has three benign hits**, none of them a publishing configuration:
  `mavenCentral()` as a dependency-resolution repository in `settings.gradle.kts`, comments that
  say "no signing, no Maven Central", and the `:boundary` probe app's release build signed with
  the debug key so `tools/check_flavours.sh` can inspect its APK. `check_publication.sh` passes
  ("no signing, Sonatype or Central configuration").
- **`./gradlew build` failed on `:ui` until the close-out fixed two build-file defects** that
  P6-11's CI line (`:ui:testDebugUnitTest`, `:ui:lintRelease`) never ran into.
  `:ui:testReleaseUnitTest` could not launch `ComponentActivity`, which only the debug manifest
  declares, so the release unit-test variant is no longer created. `:ui:lintDebug` flagged the
  debug-only partial `values-fr` fixture as `MissingTranslation`, so that check is now disabled:
  the kit ships English only and supports partial translations by design.
- **A Kotlin docs page.** The SDK index now links a new `build/sdks/kotlin.mdx`, which renders
  `sdks/kotlin/README.md` the way the other SDK pages render theirs. The Compose kit page moves
  to sidebar order 7.
- **Language lists.** Kotlin is now named in `SECURITY.md` (six client SDKs, Maven packages) and
  `docs/PRIVACY.md` (the fingerprint sources on a JVM desktop and on Android). The repo maps in
  `AGENTS.md` and `README.md` now list the final module set. `test:all` already ran every Kotlin
  JVM module.
