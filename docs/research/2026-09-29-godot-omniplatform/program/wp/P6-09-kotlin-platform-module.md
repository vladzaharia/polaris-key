# P6-09 Kotlin SDK platform module: P5-06's :platform in the SDK structure, with Play Integrity

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P6: Commerce, ops, web                                                                                                                     |
| Size        | 1.5–2 engineer-weeks                                                                                                                       |
| Depends on  | [P6-06](P6-06-kotlin-core-runner.md), [P5-06](P5-06-kotlin-aar.md), [P6-02](P6-02-trust-tiers.md)                                          |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md), [P6-10](P6-10-godot-android-binding-on-kotlin.md), [P6-12](P6-12-kotlin-android-glue.md)                     |
| Role        | `pkey-implementer`                                                                                                                         |
| Plan mode   | no                                                                                                                                         |
| Gates       | `ci:android` (both flavours), `tools/check_flavours.sh`, the `:boundary` build, `maven-publish` dry run to `build/repo`                    |
| Human input | test devices (Android 12+ and 14+) for the Integrity and install-source checks; the P5-06 owner checklist rows that this move could change |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

Slice d of [P6-05](P6-05-kotlin-sdk.md).

## Goal

P5-06's `:platform` AAR becomes a first-class module of the Kotlin SDK build, with the structure,
naming, API stability and publication metadata of its siblings, and with Play Integrity added to it
([P6-02](P6-02-trust-tiers.md) specifies the calls). It stays **standalone**: no dependency on
`:core` or any service module, so a host that wants only the Android edges (Godot, later Unity and
MAUI) links it alone, exactly as Godot on iOS links only Swift's `PolarisKeyPlatform`. A reviewer
can tell it happened when `:platform` builds and tests in both flavours from the shared build
conventions, its dependency list contains no SDK module, and the flavour boundary check still passes.

## Why

- Owner decision 3 (2026-10-04): the Godot Android binding is rebuilt on the Kotlin SDK's platform
  module only (Play, Keystore, PackageInstaller, Integrity); verification stays in Godot's shared
  GDScript core. That needs the module to be a stable, documented, publishable SDK module first.
- Swift's `PolarisKeyPlatform` (`sdks/swift/Package.swift`, "STANDALONE") is the model: the same
  edges, one C surface, nothing else.

## Read first

- `AGENTS.md`; [P5-06](P5-06-kotlin-aar.md) including "Corrections from implementation" and its
  owner checklist; [P6-02](P6-02-trust-tiers.md) (the Play Integrity scope that lands in this module).
- [P6-06](P6-06-kotlin-core-runner.md)'s hand-off (the Gradle structure and conventions).
- `sdks/kotlin/platform/`, `sdks/kotlin/tools/check_flavours.sh`, `sdks/kotlin/boundary/`.
- `sdks/swift/Sources/PolarisKeyPlatform/` and `PolarisKeyPlatformC/` for the shape of the surface.

## Scope

**In:**

- Apply the SDK's shared build conventions (version catalog, `explicitApi`, Java 17, min SDK 24,
  compile SDK) to `:platform`; keep both flavours, `play` and `direct`, and the flavour policy
  boundary (no self-update or install permissions in `play`, no Play Core in `direct`).
- Coordinates `im.plrs.key:polaris-key-platform` finalised; `maven-publish` with a sources jar,
  POM and Gradle module metadata for each flavour, to a local `build/repo` only.
- The public Kotlin API reviewed and documented (KDoc) as an SDK surface: install source, In-App
  Updates, Play Asset Delivery, `PackageInstaller`, Keystore `SecureStore`, and Play Integrity
  (standard `prepareIntegrityToken` and `request`, available in the `play` flavour only, with typed
  `Unsupported` results elsewhere). Unit tests with fakes for each.
- A Gradle dependency check proving `:platform` depends on no SDK module, and an `:boundary`
  extension proving the `direct` AAR still has no Play Core classes with Integrity added.
- If P6-02 has already added Integrity to the AAR, this package reviews and adopts it; otherwise it
  implements it as P6-02 specifies, and P6-02 drops that part.

**Out** (and where it belongs instead):

- The Godot plugin, export plugin and facade (→ [P6-10](P6-10-godot-android-binding-on-kotlin.md)).
- Glue from platform to the core ports, the Keystore `Store`, the update driver (→
  [P6-12](P6-12-kotlin-android-glue.md)).
- Server-side Integrity verification and trust tiers (→ [P6-02](P6-02-trust-tiers.md)).
- Publishing to any feed or registry (→ [F-10](F-10-sdks-onto-feeds.md); there is no Maven Central).

## Design notes

- **Standalone is a rule.** If a convenience wants `:platform` to see `:core`, the convenience goes
  in `:android` instead.
- **Stable names.** The Godot plugin addresses `:platform` through the `cmd(json)` surface (P5-06),
  so keep the Kotlin API additive; a rename is a breaking change for [P6-10](P6-10-godot-android-binding-on-kotlin.md).
- **Integrity** needs a Google Cloud project number supplied by the host app at call time; the module
  never embeds one, and a `direct` build answers `Unsupported` with reason `outlet`.

## Steps

1. Move onto the shared conventions; keep the build and `check_flavours.sh` green.
2. Publication metadata and the standalone dependency check.
3. Play Integrity (or adopt P6-02's), with fakes.
4. KDoc, README and docs section; device checks recorded by a person.

## Acceptance criteria

- [x] `./gradlew :platform:testPlayDebugUnitTest :platform:testDirectDebugUnitTest` pass and cover
      Integrity, including every refusal and `Unsupported` case.
- [x] `tools/check_flavours.sh` passes on the release AARs and `:boundary` APKs with Integrity present.
- [x] `:platform`'s resolved dependency graph contains no `im.plrs.key` module (a CI check).
- [x] `publishAllPublicationsToLocalRepository` produces both flavours' artifacts with POM, sources
      and `.module`; no signing or Central configuration exists.
- [ ] The device checks (Integrity token on an internal-track install; install-source row of the
      P5-06 checklist) are recorded in the PR by the person who ran them.
- [ ] The green gate passes (`AGENTS.md`) and the `android` CI job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :platform:test :platform:assembleRelease :platform:publishAllPublicationsToLocalRepository )
( cd sdks/kotlin && tools/check_flavours.sh )
```

## Hand-off

- A stable, standalone `:platform` that [P6-10](P6-10-godot-android-binding-on-kotlin.md) rebinds
  Godot onto and [P6-12](P6-12-kotlin-android-glue.md) wraps for the SDK.
- The role agent sets `--set P6-09 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-09 done`.

## Corrections from implementation

- **P6-06 had not landed.** It was `todo` (its branch empty) when this package was dispatched, so
  there was no shared convention plugin to move onto. The shared values went into the version
  catalog instead (`androidCompileSdk`, `androidTargetSdk`, `androidMinSdk`, `jvmTarget` in
  `sdks/kotlin/gradle/libs.versions.toml`), read by `:platform` and `:boundary`; `explicitApi` and
  the Java 17 toolchain were already on `:platform`. P6-06 should read the same catalog entries
  (or fold them into its convention plugin) rather than add a second set. `:godot` lives with the
  Godot SDK and is rebuilt by P6-10, so it was left untouched.
- **Integrity was already in the AAR.** P6-02 added `play.PlayIntegrity` and the Godot ops
  `integrity_prepare`/`integrity_token`; this package adopted them unchanged and added the
  flavour-neutral surface the brief asks for: `PlatformIntegrity.create(context)` answering a typed
  `IntegrityResult` (`Success`, `Refused`, `Failed`, `Unsupported`) in every flavour, over
  `play.PlayPlatformIntegrity` in `play` and `Unsupported("outlet")` in `direct`. The Godot binding
  is untouched (no behaviour change; P6-10 rebinds it).
- **Coordinates are one artifact per flavour:** `im.plrs.key:polaris-key-platform-play` and
  `im.plrs.key:polaris-key-platform-direct`, not a single `im.plrs.key:polaris-key-platform`. One
  coordinate would need one POM, which would be wrong for one flavour (the play AAR depends on Play
  Core, the direct one must not). The AAR base name stays `polaris-key-platform`, so the release
  AAR file names that the Godot export plugin and `check_flavours.sh` read are unchanged.
- **The local repository is `sdks/kotlin/build/repo`** (the root build directory, newly ignored), so
  later modules (P6-06's `:core`) publish beside it. `tools/check_publication.sh` checks the AAR,
  POM, sources jar and `.module` of each flavour, no SDK dependency in either POM, no Play Core in
  the direct POM, no signature, and no signing/Sonatype/Central configuration in any build script.
- **The dependency check is a Gradle task**, `:platform:checkStandalone` (part of `check`): it walks
  the eight compile and runtime classpaths of the four variants and fails on any project dependency
  or `im.plrs.key` module, resolved or not (verified by injecting an unresolvable
  `im.plrs.key:polaris-key-core`). The `android` CI job runs it with the local publication and
  `check_publication.sh` as a new step.
- **`check_flavours.sh` extended** to read each platform AAR's `classes.jar`: `PlatformIntegrity` in
  both, no `com/google/android/play/` reference in direct, and `PlayPlatformIntegrity` /
  `PlatformIntegrity` present in the play / direct boundary APKs.
- **Docs section.** The README carries the module's documentation; a docs-site page for the
  Kotlin SDK belongs with P6-06's "every place that lists the SDK languages" pass.
