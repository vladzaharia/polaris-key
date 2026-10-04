# P6-06 Kotlin SDK core module, conformance runner, constants and parity manifest

| Field       | Value |
| ----------- | ----- |
| Phase       | P6: Commerce, ops, web |
| Size | 1.5–2 engineer-weeks |
| Depends on | [P1b-01](P1b-01-parity-registry.md), [P1b-02](P1b-02-sdk-constants.md), [P1b-03](P1b-03-http-transcripts.md), [P3-02](P3-02-wire-v4-contract-corpus.md), [P5-06](P5-06-kotlin-aar.md) |
| Unblocks | [P6-05](P6-05-kotlin-sdk.md), [P6-07](P6-07-kotlin-license-config-identity.md), [P6-08](P6-08-kotlin-update-packs.md), [P6-09](P6-09-kotlin-platform-module.md) |
| Role | `pkey-sdk-porter` |
| Plan mode   | no (it adds no corpus rows; a missing corpus case goes to `pkey-wire-planner` as its own package) |
| Gates       | `parity:check` (rules 3 and 4, the `sdks` list), `pnpm gen:constants -- --check`, a registry pass over `features.json`, the language lists, and a new `kotlin` CI job |
| Human input | none |
| Repo        | `vladzaharia/polaris-key` |

Slice a of [P6-05](P6-05-kotlin-sdk.md).

## Goal

`sdks/kotlin` grows from P5-06's platform backend into a Kotlin SDK build. This package lands its
verified core: a pure Kotlin/JVM `:core` module (usable unchanged on Android API 24+ and on a JVM
desktop) holding JWS and Ed25519 verification, the signed-document types, the verified cache and
clock floor, discovery, sync, the boot stage machine and the generated constants. It also lands the
JUnit conformance runner and the HTTP transcript replay harness that every later slice reuses, the
Kotlin `parity.json` (every row `planned`, each with an owner), its entry in
`conformance/parity/features.json`, and the `kotlin` CI job. A reviewer can tell it happened when
`:core:test` passes every corpus case the core owns, `pnpm gen:constants -- --check` and
`pnpm parity:check` are green with Kotlin registered, and nothing in `:core` imports Android.

## Why

- The owner decision of 2026-10-04 makes the Kotlin SDK a required deliverable, no longer optional
  ([README §11 decision 10](../../README.md#11-decisions-needed)). The old P6-05 was one 6–8 week
  PR train; this slice is its first, reviewable step.
- Every other slice needs a place to put its code, a way to prove it (the runner and the
  transcript harness) and a manifest to flip rows in. Swift's `PolarisKeyCore` is the closest
  analogue: it carries the same cross-service pieces and no UI or service.
- A new SDK starts with every feature `planned`, so the gate shows its backlog
  ([PARITY §3.3](../../PARITY.md#33-the-wave-model-extended)).

## Read first

- `AGENTS.md` (the wave model, rules 3, 4, 9 and 10, the green gate) and
  `.claude/agents/pkey-sdk-porter.md`.
- [P5-06](P5-06-kotlin-aar.md) including its "Corrections from implementation" (the Gradle layout,
  versions, flavours and the `:boundary` check you must not break).
- `sdks/swift/Package.swift` (the header comment is the target map), `sdks/swift/Sources/PolarisKeyCore/`
  and `sdks/swift/parity.json`.
- `conformance/parity/features.json`, `conformance/parity/manifest.schema.json`,
  `tools/parity-check.ts`, `tools/gen-sdk-constants.ts` (the Swift emitter around lines 1031–1260)
  and `conformance/runners/node/` (`corpusV2.test.ts`, `transcriptReplay.ts`, `suites.ts`).
- [PARITY §2](../../PARITY.md#2-what-parity-means), [§5](../../PARITY.md#5-the-feature-inventory),
  [§7](../../PARITY.md#7-runtime-limits-that-become-typed-nas); notes/E9 (the `KA` and `KJ` rows).

## Scope

**In:**

- Gradle structure under `sdks/kotlin` (confirm names in the PR; this is the proposal for the whole
  program, so later slices do not re-argue it):
  - JVM libraries, plain Kotlin JARs: `:core` now; `:license`, `:config`, `:identity`, `:release`,
    `:packs`, `:update` and the umbrella `:sdk` later.
  - Android libraries: `:platform` (exists), `:android` (the glue over platform and core), `:ui`
    (Compose), `:godot` (exists).
  - `:conformance`, an internal test-only module (not published) holding the runner.
  - Coordinates `im.plrs.key:polaris-key-<module>`, still proposed.
- `:core`: `Ed25519Verifier` port with two implementations, JCA (`Signature.getInstance("Ed25519")`,
  JDK 15+ and Android API 33+) and Tink below that; SHA-256 from `MessageDigest`; base64url; JWS
  compact verification; trust set and key rotation; the signed bundle and record shapes; `Semver`;
  the verified cache with monotonic clock floor; `Transport` port with a default implementation;
  discovery and capabilities; sync with ETag; headers; the typed error set; `Store` port with an
  in-memory and a 0600 file implementation (the Keystore implementation is
  [P6-12](P6-12-kotlin-android-glue.md)); the boot stage machine (`ui.stages`) over
  `stage-matrix.json`; fingerprint derivation from supplied inputs (`fingerprint.json`).
- Constants: a Kotlin emitter in `tools/gen-sdk-constants.ts` writing
  `sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Constants.generated.kt`, hooked into
  `pnpm gen:constants` so `--check` fails on drift; the `sdks` entry in `features.json` names it.
- The conformance runner in `:conformance`: reads `conformance/corpus/v2/` in place (no mirror),
  runs `cases.json` (verify, bundle, record sections that need only core), `headers.json`,
  `fingerprint.json`, `stage-matrix.json` and `outlet-matrix.json`'s decision rows; and the
  transcript replay harness (port of `transcriptReplay.ts`) with the `core.*` transcripts
  (`discovery-*`, `sync-*`). Later slices add their corpus files and transcripts to the same runner.
- `sdks/kotlin/parity.json`: `runtimes: ["android", "jvm"]`, every feature `planned` with an owner
  (`wp` of the slice that flips it, or `unowned` with a note where Swift is also unowned:
  `identity.oidc`, `commerce.receipt`, `packs.transport.steam`); flip the core rows this package
  proves. `@pkey-feature` tags on tests as the Swift and Python suites do.
- The registry pass: for every `allowedNa` in `features.json` that lists `macos`/`ios`/`node` but
  not `android` or `jvm`, decide and record the Kotlin answer in the registry with a `why`: at least
  `packs.type.godot.zip`, `packs.type.audio.bank`, `packs.type.ml.model`, `update.driver` (jvm),
  `packs.transport.steam`, `msix` and `flatpak` (jvm). List every addition in the PR body.
- The `kotlin` CI job (JDK 17, `./gradlew :core:test :conformance:test`, no Android SDK needed),
  beside P5-06's `android` job; `test:all`; and every place that lists the SDK languages
  (AGENTS.md, READMEs, the docs pages), as the Godot SDK did.
- `maven-publish` configuration on `:core` (sources jar, POM, Gradle module metadata) publishing to a
  local `build/repo` only. No `signing` plugin, no Central or Sonatype plugin, no remote repository.

**Out** (and where it belongs instead):

- Licence, config, devices (other than fingerprint), identity, release (→ [P6-07](P6-07-kotlin-license-config-identity.md)).
- Update, packs and the pack types (→ [P6-08](P6-08-kotlin-update-packs.md)).
- Android Keystore store, install-source readers, update driver, Play transport (→ [P6-12](P6-12-kotlin-android-glue.md)).
- Moving `:platform` (→ [P6-09](P6-09-kotlin-platform-module.md)); the UI kit (→ [P6-11](P6-11-kotlin-compose-ui-kit.md)).
- Publishing. Kotlin artifacts reach adopters only through Polaris Key's own Maven feed
  ([F-07](F-07-maven-feed.md), [F-10](F-10-sdks-onto-feeds.md)). There is no Maven Central
  publication anywhere in this program.
- New corpus cases (→ plan mode with `pkey-wire-planner`).

## Design notes

- **`:core` has no Android dependency.** `:platform` stays standalone as well (Godot links it
  alone); the only module that sees both is `:android` ([P6-12](P6-12-kotlin-android-glue.md)).
  Enforce it with a Gradle dependency check in CI.
- **Ed25519 verdicts must be identical** on both implementations: run the corpus once per
  implementation (a forced-Tink pass on the JVM). Tink's size and `minSdk` are a decision for the
  PR; keep min SDK 24 and Java 17 bytecode as P5-06 fixed them.
- **JSON.** Use `kotlinx.serialization.json` `JsonElement` behind a small `JSONValue`-style type so
  duplicate-key and canonical-name rules (WIRE-CONTRACT-V3 §10) are the corpus's, not the
  library's; the corpus malleability cases decide.
- **Transport.** `java.net.http` does not exist on Android 24; pick one HTTP client that works on
  both (OkHttp is the proposal) behind the `Transport` port, and never forward an `Authorization`
  header across a redirect (read Swift's `Transport.swift`).
- **Coroutines**: `suspend` for calls, `Flow` for streams ([PARITY §2.3](../../PARITY.md#23-naming-and-idiom)).
- **Rows flip with proof.** A row becomes `implemented` only when the corpus file or transcript it
  names passes in `:conformance`; `parity:check` rule 4 stays green at every commit.

## Steps

1. Plan section in the PR: module list, versions, dependency list, Tink and HTTP-client decisions.
2. Gradle restructure (keep `:platform`, `:godot`, `:boundary` green), `:conformance` skeleton, CI job.
3. Constants emitter and `features.json` registration; the registry pass.
4. `:core` verification, then cache, discovery, sync, headers, errors, caps, stage machine,
   fingerprint function, each with its corpus or transcript.
5. `parity.json`, docs and language lists.

## Acceptance criteria

- [ ] `./gradlew :core:test :conformance:test` passes every `cases.json`, `headers.json`,
      `fingerprint.json`, `stage-matrix.json` and `outlet-matrix.json` decision case, and the
      `core.*` transcripts, on both Ed25519 implementations.
- [ ] `pnpm gen:constants -- --check` is green and covers the Kotlin file.
- [ ] `sdks/kotlin/parity.json` exists, is registered in `features.json`, lists every feature, and
      `parity:check` is green; the core rows this package proves are `implemented`.
- [ ] Every registry addition for `android` and `jvm` is listed in the PR with its `why`.
- [ ] `:core` has no Android dependency and `:platform` has no dependency on `:core` (a CI check);
      P5-06's `check_flavours.sh` still passes.
- [ ] No Central, Sonatype or `signing` configuration exists in the build.
- [ ] The green gate passes (`AGENTS.md`), the new `kotlin` job and P5-06's `android` job are green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :core:test :conformance:test )
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm parity:check -- --check
```

## Hand-off

- The module layout, the `:conformance` runner and transcript harness, the `Transport`, `Store`,
  `Ed25519Verifier` ports and the generated constants: [P6-07](P6-07-kotlin-license-config-identity.md),
  [P6-08](P6-08-kotlin-update-packs.md) and [P6-09](P6-09-kotlin-platform-module.md) build on them.
- The manifest with each remaining row owned.
- The role agent sets `--set P6-06 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-06 done`.
