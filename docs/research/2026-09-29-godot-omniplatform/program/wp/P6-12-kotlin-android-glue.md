# P6-12 Kotlin SDK Android glue: Keystore store, device inputs, outlet readers, update driver and Play pack transport

| Field       | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Phase       | P6: Commerce, ops, web                                                                                 |
| Size        | 1–1.5 engineer-weeks                                                                                   |
| Depends on  | [P6-08](P6-08-kotlin-update-packs.md), [P6-09](P6-09-kotlin-platform-module.md)                        |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md)                                                                           |
| Role        | `pkey-sdk-porter`                                                                                      |
| Plan mode   | no                                                                                                     |
| Gates       | `parity:check`, Robolectric and fake-based unit tests, the `android` CI job, `tools/check_flavours.sh` |
| Human input | test devices and a Play Console internal test track for the device rows (recorded in the PR)           |
| Repo        | `vladzaharia/polaris-key`                                                                              |

Slice g of [P6-05](P6-05-kotlin-sdk.md). It is not in the owner's first sketch; the sketch left no
home for the rows that need both the core and the platform module, and putting them in either
would break the rule that `:platform` is standalone.

## Goal

An `:android` module, the only module that depends on both `:core` (and the service modules) and
`:platform`, closes the Android-only rows of the Kotlin SDK: the Keystore-backed `Store`, the
Android inputs to the fingerprint and device facts, the install-source readers feeding outlet
detection, the update driver (In-App Updates on Play, `PackageInstaller` on direct builds) and the
Play Asset Delivery pack transport. A reviewer can tell it happened when the rows below are
`implemented` and an Android app can go from `PolarisKeyClient` to a verified update and a mounted
pack using only SDK modules.

## Why

- `core.store`, `devices.fingerprint`, `outlet.detect`, `update.driver` and `packs.transport.play`
  are `planned` after [P6-06](P6-06-kotlin-core-runner.md) to [P6-08](P6-08-kotlin-update-packs.md)
  because each needs an Android edge; this package is where the SDK meets
  [P6-09](P6-09-kotlin-platform-module.md).
- Swift has the same seam: `PolarisKeyPlatform` is standalone and `PolarisKeyUpdate` and the
  umbrella use it.

## Read first

- `AGENTS.md`; the hand-offs of [P6-06](P6-06-kotlin-core-runner.md),
  [P6-08](P6-08-kotlin-update-packs.md) and [P6-09](P6-09-kotlin-platform-module.md);
  [P5-06](P5-06-kotlin-aar.md) corrections (Keystore `SecureStore`, update driver, PAD paths).
- `sdks/swift/Sources/PolarisKeyUpdate/OutletReaders.swift` and `PolarisKeyCore/Store.swift`,
  `Fingerprint.swift`, `OutletDetection.swift`.
- `conformance/corpus/v2/outlet-matrix.json`, `fingerprint.json`; PARITY §2.2 and §7 (Android has no
  hardware serials: an app-scoped id and the Keystore instead); notes/E2 §A2, §A3.

## Scope

**In:**

- `core.store` on Android: a `Store` over `:platform`'s `SecureStore` with the migration, degraded
  reasons and status reporting `:core` defines; JVM keeps the 0600 file store from P6-06.
- `devices.fingerprint` and `devices.facts` inputs on Android: the app-scoped id and Keystore anchor,
  `Build` facts, companion-app probes through the package manager, filling `:core`'s fingerprint
  inputs and `:license`'s `DeviceFactsSource`.
- `outlet.detect`: readers over `:platform`'s install source (installer, initiator and certificate
  digest, package source, update owner) feeding `:core`'s outlet decision; the `outlet-matrix.json`
  rows are already green from P6-06, this proves the readers.
- `update.driver`: the Play adapter (In-App Updates, priority and staleness from the decision) and
  the direct adapter (download to private storage, verify against the signed record, `PackageInstaller`
  session), as `:update`'s `InstallDriver` implementations; the flavour boundary is preserved
  (the `play` build has no installer code). On the JVM the row is the registry's typed N/A.
- `packs.transport.play`: a `PackTransport` over Play Asset Delivery states and `getPackLocation`
  paths, re-read on every launch and never persisted, as P5-06 recorded.
- Manifest, `parity.json`, docs, `maven-publish` to a local `build/repo`.

**Out** (and where it belongs instead):

- Compose screens (→ [P6-11](P6-11-kotlin-compose-ui-kit.md)).
- The Godot binding, which must not use this module (→ [P6-10](P6-10-godot-android-binding-on-kotlin.md)).
- Pack-module generation for PAD at build time (→ [P5-08](P5-08-platform-pack-transports.md)).
- Play Billing and `commerce.receipt` (stay `planned`, `unowned`).

## Design notes

- **`:android` is a leaf.** Nothing depends on it except apps and tests. A dependency check in CI
  asserts `:core`, `:platform` and `:godot` do not.
- **Flavours.** `:android` needs both flavours, with the direct adapter's classes absent from a
  `play` merged build; extend `check_flavours.sh` to cover it through `:boundary`.
- **Verification before install.** The direct adapter hashes the APK against the signed record and
  `:platform` re-hashes while streaming into the session (P5-06's `hash_changed`); never skip either.
- **Fakes.** Everything is testable with fakes (Play Core's `FakeAppUpdateManager`, a fake asset-pack
  manager, a `PackageInstaller` fake, Robolectric); device runs are by a person.

## Steps

1. Keystore `Store`, fingerprint and facts inputs.
2. Outlet readers.
3. Update driver adapters; flavour check extended.
4. Play pack transport.
5. `parity.json`, docs, device checks by a person.

## Acceptance criteria

- [ ] `core.store`, `devices.fingerprint`, `outlet.detect`, `update.driver` and
      `packs.transport.play` are `implemented` (or the registry's allowed `na` on jvm) in
      `sdks/kotlin/parity.json`, and `parity:check` is green.
- [ ] Unit tests cover each adapter against fakes, including every `PackageInstaller` refusal path
      the driver can surface.
- [ ] `tools/check_flavours.sh` passes with `:android` in the boundary apps.
- [ ] A CI check proves no module except `:android` depends on both `:core` and `:platform`.
- [ ] The device rows (internal-track update offered, direct self-update, fast-follow pack mounted,
      outlet readout) are recorded in the PR by the person who ran them.
- [ ] The green gate passes (`AGENTS.md`) and the `android` CI job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :android:testPlayDebugUnitTest :android:testDirectDebugUnitTest && tools/check_flavours.sh )
mise exec node@22 -- pnpm parity:check -- --check
```

## Hand-off

- A Kotlin SDK in which an Android app reaches every row without writing glue; this is the last
  piece [P6-05](P6-05-kotlin-sdk.md) waits for besides the UI kit.
- The role agent sets `--set P6-12 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-12 done`.
