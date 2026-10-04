# P6-07 Kotlin SDK licence, config, devices, identity and release services

| Field       | Value                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                     |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                       |
| Depends on  | [P6-06](P6-06-kotlin-core-runner.md)                                                                                                                                       |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md), [P6-08](P6-08-kotlin-update-packs.md), [P6-11](P6-11-kotlin-compose-ui-kit.md)                                                               |
| Role        | `pkey-sdk-porter`                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                         |
| Gates       | `parity:check`, the Kotlin runner's `gate-matrix.json`, `config-matrix.json` and transcript replay, `gen:mirrors` (Kotlin catalog mirror), `pnpm gen:constants -- --check` |
| Human input | none                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                  |

Slice b of [P6-05](P6-05-kotlin-sdk.md).

## Goal

The Kotlin SDK gains the service modules `:license`, `:config`, `:identity` and `:release`, the
device operations (facts, register, manage, report), and the umbrella `:sdk` with `PolarisKeyClient`,
so a one-dependency adopter can gate, resolve config, sign in and read a changelog. Every behaviour
is proved by the same corpus files and HTTP transcripts as Node and Swift, replayed through the
runner [P6-06](P6-06-kotlin-core-runner.md) built. A reviewer can tell it happened when the rows
listed below are `implemented` and `:conformance:test` replays every transcript that names them.

## Why

- These are the product-facing services of the registry's `license`, `config`, `devices`,
  `identity` and `release` families, and the ones a native Android app adopts first.
- Swift's `PolarisKeyLicense`, `PolarisKeyConfig`, `PolarisKeyIdentity`, `PolarisKeyRelease` and the
  `PolarisKey` umbrella are the structural model, and the transcripts
  ([P1b-03](P1b-03-http-transcripts.md)) make "byte-identical verdicts" checkable.

## Read first

- `AGENTS.md`; [P6-06](P6-06-kotlin-core-runner.md) and its hand-off; `.claude/agents/pkey-sdk-porter.md`.
- `sdks/swift/Sources/PolarisKeyLicense`, `PolarisKeyConfig`, `PolarisKeyIdentity`,
  `PolarisKeyRelease`, `PolarisKey/PolarisKeyClient.swift`.
- `conformance/corpus/v2/gate-matrix.json`, `config-matrix.json`; every transcript in
  `conformance/transcripts/` (activate, register, devicecode, edge-mint, config-schema-fetch,
  release-changelog\*, commerce-claim, telemetry-report, register-reregister-401).
- `tools/gen-mirrors.ts` (the Swift mirror emitter) and `tools/gen-mirrors.test.ts`.
- [P1b-06](P1b-06-reregister-401.md), [P1b-07](P1b-07-license-config-release-gaps.md),
  [P1b-08](P1b-08-devicecode-edgemint-ports.md) (the behaviours that must match).

## Scope

**In:**

- `:license`: gate, activate, enroll, deactivate, entitlements, channels, re-register on 401.
- `:config`: resolution, list, secrets, schema fetch, edge-mint, facts; the catalog mirror.
- Devices: facts, register, manage, report (the fingerprint function is [P6-06](P6-06-kotlin-core-runner.md);
  Android inputs are [P6-12](P6-12-kotlin-android-glue.md)).
- `:identity`: RFC 8628 device-code sign-in; the OIDC redirect stays a host-supplied sign-in
  closure, as in Swift.
- `:release`: changelog, download URLs, the release record.
- `:sdk` umbrella: `PolarisKeyClient` and re-exports (`api` dependencies), so `polaris-key-sdk` is
  the one-line dependency. Update and packs facets are added by [P6-08](P6-08-kotlin-update-packs.md).
- A Kotlin emitter in `tools/gen-mirrors.ts` (`--lang ... kotlin`) with its test, so a product's
  config catalog compiles to typed Kotlin.
- Runner additions: `gate-matrix.json`, `config-matrix.json` and every transcript above, with the
  `@pkey-feature` tags.
- `maven-publish` configuration on each new module (local `build/repo` only).
- Flip in `sdks/kotlin/parity.json`: `license.gate`, `license.activate`, `license.enroll`,
  `license.deactivate`, `license.entitlements`, `license.channels`, `license.reregister`,
  `config.resolve`, `config.list`, `config.secret`, `config.schema`, `config.mint`,
  `config.mirror`, `devices.facts`, `devices.register`, `devices.manage`, `devices.report`,
  `identity.devicecode`, `release.changelog`, `release.download`, `release.record`.

**Out** (and where it belongs instead):

- `identity.oidc` and `commerce.receipt` stay `planned`, `unowned`, with the same notes as Swift
  (Play Billing is a store edge, not an SDK service; the server side is [P6-01](P6-01-commerce-bridge.md)).
- Update, packs, boot guard (→ [P6-08](P6-08-kotlin-update-packs.md)).
- Any screen (→ [P6-11](P6-11-kotlin-compose-ui-kit.md)).
- New corpus or transcript cases: file a `pkey-wire-planner` package; do not edit `conformance/`.

## Design notes

- Each module depends on `:core` only (never on a sibling), as Swift's targets do; `:sdk` is the one
  place they meet.
- Public API is `suspend` and `Flow`, errors are the typed set from `:core`, and every public type
  is explicit-API (`explicitApi()` as `:platform` already uses).
- Re-registration on a 401 must behave as P1b-06 specified, proved by `register-reregister-401.json`.
- No Android types in these modules; the device-facts input that needs `Build` or the package
  manager arrives through a `DeviceFactsSource` port filled in by [P6-12](P6-12-kotlin-android-glue.md)
  (a JVM implementation ships here).

## Steps

1. `:license` with `gate-matrix.json` and its transcripts.
2. `:config` and the mirror emitter, with `config-matrix.json` and transcripts.
3. Devices and `:identity`.
4. `:release` and the umbrella.
5. `parity.json`, docs sections, READMEs.

## Acceptance criteria

- [x] `:conformance:test` passes every case in `gate-matrix.json` and `config-matrix.json` and
      replays every transcript naming one of the flipped rows.
- [x] Every row listed in Scope is `implemented` (or carries its registry-allowed `na`), the two
      unowned rows keep their notes, and `parity:check` is green.
- [x] `tools/gen-mirrors.ts --lang kotlin` output compiles in a test module and its test is in the gate.
- [x] No module in this package depends on a sibling service module or on Android.
- [x] The green gate passes (`AGENTS.md`) and the `kotlin` CI job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :license:test :config:test :identity:test :release:test :sdk:test :conformance:test )
mise exec node@22 -- pnpm parity:check -- --check
mise exec node@22 -- pnpm exec vitest run tools/gen-mirrors.test.ts
```

## Hand-off

- `PolarisKeyClient` and the service modules: [P6-08](P6-08-kotlin-update-packs.md) adds the
  `update` facet, [P6-11](P6-11-kotlin-compose-ui-kit.md) renders the services' state.
- The `DeviceFactsSource` port for [P6-12](P6-12-kotlin-android-glue.md).
- The role agent sets `--set P6-07 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-07 done`.

## Corrections from implementation

Recorded by the implementer on 2026-10-04. The code is the fact where this brief and the code
disagree.

- **Modules, as built.** `:license`, `:config`, `:identity`, `:release` and `:sdk` are plain
  Kotlin/JVM libraries (`explicitApi()`, packages `im.plrs.key.<module>`, `maven-publish` to
  `sdks/kotlin/build/repo` only as `im.plrs.key:polaris-key-<module>`; no signing, no remote
  repository). Each service module has `api(project(":core"))` and nothing else of the SDK; `:sdk`
  re-exports `:core` and the four service modules through `api`, so `polaris-key-sdk` is the one
  dependency. `checkModuleBoundaries` now covers every JVM module (no `com.android` plugin, no
  Android artifact, no `android.`/`androidx.` import) and refuses any project dependency of a
  service module other than `:core` (test fixtures included); it still checks `:platform`'s
  standalone rule when the Android modules are in the build.
- **Devices live in `:core`, not in a service module.** The registry files every `devices.*` row
  under the `core` service, and Swift puts registration and the roster on `CoreContext`, so
  `registerDevice`, `requestDeviceRegistration`, `listDevices`, `renameDevice` and
  `deauthorizeDevice` are `CoreContext` extensions in `:core/Devices.kt`. The two input ports are
  in `:core` as well: `FingerprintSource` (with `JvmFingerprintSource`: rule 2's Linux anchor,
  macOS `IOPlatformUUID`, rule 1's Windows CIM read, rule 3's RAM bucket) and
  `DeviceFactsSource` (with `JvmDeviceFactsSource`). P6-12's brief names "`:license`'s
  `DeviceFactsSource`"; it is `:core`'s, because both `:sdk` (which assembles the report) and
  `:android` (which fills it) already see `:core`, and putting it in `:license` would make the
  Android glue link the licence module for a devices concern. `ProbeDeclaration` gains an
  `android` field (a package name) for P6-12's probe reader; the JVM source ignores it.
- **The release record verifier is in `:core`** (`ReleaseRecord.kt`, with the pack claims step 14
  applies in `PackClaims.kt`), as in Swift's `PolarisKeyCore`: both `:release` (`release.record`)
  and P6-08's `:update` verify records, and service modules never depend on one another.
  `ReleaseClient.verifyRecord` binds it to the app's pinned release keys, the client's effective
  trust set and the product as the audience. The delegated path (`pkd1-` kids, plans/P4-19.md,
  `delegationCases`) is the pack engine's and is left to P6-08: a record whose kid is not a pinned
  release key is refused at step `jws` here, which every `releaseRecordCases` vector agrees with.
- **`licenseState` stays in `:core`** (P6-06 put it there for the clock-floor and sync proofs);
  `LicenseClient.status()` assembles its inputs, and `:license` adds the `isUsable(LicenseState)`
  overload.
- **The transcript harness drives `PolarisKeyClient`.** `TranscriptTest.kt`'s two composed
  closures (P6-06) are gone: the §5 re-acquire is the client's (`POST /license/token`, or
  `POST /devices/register` for a registered-without-licence device or a product with License
  off) and the report body is the client's (`{os, hardware, runtime, locale, timezone, probes?,
config, entitlements, caps}`). Registration and activation in a replay send a FIXED hashed
  fingerprint, so a replay does not depend on the host; the report's facts are the host's own (the
  transcripts match them by shape). Replayed: every transcript whose features are implemented —
  the four `core.*` ones plus `activate-enroll-deactivate`, `config-schema-fetch`,
  `devicecode-expired`, `devicecode-happy`, `edge-mint`, `register-open`,
  `register-reregister-401`, `release-changelog`, `release-changelog-entitled` and
  `telemetry-report`, on both Ed25519 backends. `update-record-by-hash` names `release.record`
  but also `update.decide`, which is P6-08's, so by the parity rule (every feature implemented)
  it starts replaying when P6-08 flips that row; `commerce-claim` stays unowned.
- **P6-06 review notes addressed.** `OkHttpTransport`'s `Call.await()` resumes with an
  `onCancellation` handler that closes a response landing after the caller cancelled (no leaked
  connection or body). `PolarisResponse` keeps every header line (`headerList`,
  `headerValues(name)`); no service in this package reads a repeated header, but the transport no
  longer drops them. Every `:conformance` suite extends `ConformanceSuite`, whose `@BeforeClass`
  installs the backend the Gradle task names (`test` → JCA, `testTink` → Tink) and whose
  `@Before` re-checks it, so no suite runs on a backend another suite left installed.
- **Test fixtures.** `:core` gains a `java-test-fixtures` source set (a throwaway JDK Ed25519
  signer that mints wire-shaped licence and config documents, and a scripted transport) used by
  the service modules' unit tests through `testFixtures(project(":core"))`. The fixture variants
  are skipped from the published component, so the local publication is unchanged.
- **The Kotlin catalog mirror.** `tools/gen-mirrors.ts --lang kotlin [--kotlin-package <pkg>]`
  (default package `im.plrs.key.catalog`) writes `ConfigSchema.generated.kt`: the Swift mirror's
  fields plus `accessor`, `schemaJson` and `defaultJson` (JSON text with sorted keys; never a
  secret's default), every declaration `public` so it compiles under explicit-API mode, string
  literals ASCII-only with `$` escaped. The `:config` tests compile the committed sample
  (`config/src/test/kotlin/im/plrs/key/config/mirror/ConfigSchema.generated.kt`, rendered from
  `config/src/test/resources/catalog.json`), and `tools/gen-mirrors.test.ts` (in `pnpm test`)
  holds the sample byte-for-byte to today's renderer.
- **Rows and evidence.** Implemented: `license.gate` (`GateMatrixTest`, `gate-matrix.json`),
  `license.activate`, `license.enroll`, `license.deactivate`, `license.reregister`,
  `devices.register`, `devices.report`, `config.schema`, `config.mint`, `identity.devicecode`,
  `release.changelog`, `release.download` (their transcripts), `config.resolve` and `config.list`
  (`ConfigMatrixTest`, `config-matrix.json`), `release.record` (`ReleaseRecordTest`,
  `cases.json#releaseRecordCases`), and the unit-proven `license.entitlements`,
  `license.channels`, `config.secret`, `config.mirror`, `devices.facts`, `devices.manage`.
  `identity.oidc` and `commerce.receipt` keep their unowned notes. `CapabilitiesTest`'s "planned
  feature" example moved from `license.gate` to `devices.fingerprint` (still P6-12's).
