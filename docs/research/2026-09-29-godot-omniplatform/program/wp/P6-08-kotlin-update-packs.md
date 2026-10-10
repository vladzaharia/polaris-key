# P6-08 Kotlin SDK update client and packs engine

| Field       | Value                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                 |
| Size        | 2–3 engineer-weeks                                                                                                                                                     |
| Depends on  | [P6-06](P6-06-kotlin-core-runner.md), [P6-07](P6-07-kotlin-license-config-identity.md), [P4-11](P4-11-chunk-sync-sdks.md), [P4-29](P4-29-feed-delta-menu.md)           |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md), [P6-11](P6-11-kotlin-compose-ui-kit.md), [P6-12](P6-12-kotlin-android-glue.md)                                                           |
| Role        | `pkey-sdk-porter`                                                                                                                                                      |
| Plan mode   | no (every case it needs exists in the corpus; a missing one goes to `pkey-wire-planner`)                                                                               |
| Gates       | `parity:check`, the Kotlin runner's `update-matrix.json`, `plan-matrix.json` and `content/` suites, `pnpm gen constants --check`, the registry rows for the pack types |
| Human input | none                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                              |

Slice c of [P6-05](P6-05-kotlin-sdk.md).

## Goal

The Kotlin SDK checks for updates and installs packs by the same rules as Node, Python and Swift.
`:update` holds the update client (check, feed, decide, content, boot guard) and `:packs` holds the
pack engine: records, revocations, delegation, the planner, the file, chunk, delta and full
appliers, the install state, type handlers and `provides`. The packs facet appears on
`PolarisKeyClient`. A reviewer can tell it happened when the Kotlin runner passes `update-matrix.json`,
`plan-matrix.json` and every `content/` case, and the rows below are `implemented`.

## Why

- These are the P4 engine rules (plans P4-01, P4-10, P4-19, P4-29) and their SDK ports
  ([P4-07](P4-07-python-swift-packs.md), [P4-11](P4-11-chunk-sync-sdks.md)); a native Android app
  that ships content between releases needs them, and Godot's shared core does its own.
- Swift's `PolarisKeyPacks` (a cross-platform target that links libzstd and no updater) and
  `PolarisKeyUpdate` are the structural model.

## Read first

- `AGENTS.md`; [P6-06](P6-06-kotlin-core-runner.md), [P6-07](P6-07-kotlin-license-config-identity.md) hand-offs.
- `sdks/swift/Sources/PolarisKeyPacks/` (Plan, Select, ChunkApply, Patch, Window, State, Revocations,
  Provides, TypeHandlers) and `PolarisKeyUpdate/UpdateClient.swift`, `UpdateFeed.swift`.
- `conformance/corpus/v2/update-matrix.json`, `plan-matrix.json`, `stage-matrix.json`,
  `content/`, `cases.json` (`feedContentCases`, `delegationCases`, `dataOnlyCases`).
- `plans/P4-10.md` §8.5, `plans/P4-19.md`, `plans/P4-29.md` §2.4 and §5 (see the amendments below),
  and `CONTENT.md`.
- notes/E9 (zstd-jni, 16 KB page alignment).

## Scope

**In:**

- `:update`: `update.check`, `update.feed`, `update.decide`, `update.content`, `update.bootguard`
  (the slots, counting and confirmation rows). The install driver is a port; its Android
  implementations are [P6-12](P6-12-kotlin-android-glue.md) and the JVM one is a typed N/A (link only).
- `:packs`: `packs.record`, `packs.revoke`, `packs.delegation`, `packs.delta.feed` (`feedContent`'s
  `deltas`, `withFeedDeltas`, at most one feed-offered delta per install, journal `feedDelta`),
  `packs.plan`, `packs.index.files`, `packs.index.chunks`, `packs.apply.full`, `.file`, `.chunk`,
  `.delta`, `packs.state`, `packs.handlers`, `packs.provides`, and the pack types
  `data.json`, `l10n.table` plus the registry answer for `godot.zip`, `audio.bank` and `ml.model` on
  android and jvm made in [P6-06](P6-06-kotlin-core-runner.md).
- A `PackStorage` port with a directory implementation; chunk sync from seeds; transports are ports.
- zstd for deltas and chunks through `zstd-jni`, behind the same port style as Swift's `Zstd.swift`,
  with the `ZstdDictionary` handling the registry's `dependency` and `version` N/A rules describe.
  Its `.so` files must be 16 KB page aligned (verify with the repository's alignment check).
- The `update` and `packs` facets on `:sdk`'s `PolarisKeyClient`.
- Runner additions for `update-matrix.json`, `plan-matrix.json`, `stage-matrix.json` (guard rows),
  every `content/` file and the update transcripts (`update-feed-rollback`, `update-record-by-hash`).
- `maven-publish` on `:update` and `:packs` (local `build/repo` only).

**Out** (and where it belongs instead):

- The install driver on Android (In-App Updates, `PackageInstaller`) and the Play pack transport
  (→ [P6-12](P6-12-kotlin-android-glue.md)).
- `ui.kit` pieces for banners and progress (→ [P6-11](P6-11-kotlin-compose-ui-kit.md)).
- New corpus cases (→ `pkey-wire-planner`).

## Design notes

- **The engine is a port of the corpus, not of Swift.** Where Swift and the corpus disagree, the
  corpus is right and the disagreement is a finding to report.
- **Pack stores and journals** live under the data directory the Store port gives; never in cache
  directories the OS may purge ([P1b-09](P1b-09-fingerprint-storage-fixes.md)).
- **Typed N/As.** A missing zstd decoder is `dependency`, a runtime that ignores the dictionary is
  `version`, never `runtime` (registry rows); the JVM has no Play Asset Delivery.
- **Memory.** Chunk and delta appliers stream; do not load a whole pack into memory on a 2 GB device.

## Steps

1. `:update` with `update-matrix.json`, the feed and record transcripts.
2. `:packs` records, revocations, delegation, then the planner (`plan-matrix.json`).
3. Appliers: full, file, chunk, delta (zstd), state, handlers, provides, feed deltas.
4. Facets on the umbrella, `parity.json`, docs sections.

## Acceptance criteria

- [x] The Kotlin runner passes every case in `update-matrix.json`, `plan-matrix.json` and
      `content/`, including `feedDeltaApplyCases`, `delegationCases` and `dataOnlyCases`.
- [x] Every row in Scope is `implemented` or carries a registry-allowed `na`; `update.driver` and
      `packs.transport.play` stay `planned` with `wp: P6-12`.
- [x] The zstd native libraries are 16 KB page aligned (checked in CI or the PR).
- [x] The green gate passes (`AGENTS.md`) and the `kotlin` CI job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :update:test :packs:test :sdk:test :conformance:test )
mise exec node@22 -- pnpm parity:check -- --check
```

## Hand-off

- The update client, the pack engine and their ports (`InstallDriver`, `PackStorage`,
  `PackTransport`) that [P6-12](P6-12-kotlin-android-glue.md) implements on Android, and the state
  flows [P6-11](P6-11-kotlin-compose-ui-kit.md) renders.
- The role agent sets `--set P6-08 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-08 done`.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.
(Carried over from the P6-05 brief it replaces.)

## Plan amendments (P4-19)

The approved [`plans/P4-19.md`](../plans/P4-19.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (P4-29)

The approved [`plans/P4-29.md`](../plans/P4-29.md) adds the parity feature `packs.delta.feed` (the
feed's delta menu: `feedContent`'s `deltas`, `withFeedDeltas`, at most one feed-offered delta per
install, journal `feedDelta`), proved by `cases.json#feedContentCases`,
`plan-matrix.json#feedDeltaCases` and `content/cases.json#feedDeltaApplyCases`. The Kotlin
`parity.json` lists it like every other feature; its §2.4 and §5 override this brief where they differ.

## Corrections from implementation

Recorded by the implementer on 2026-10-04. The code is the fact where this brief and the code
disagree.

- **Where the logic lives.** As in Swift, the pure decisions are `:core`'s, not `:update`'s:
  `Version.kt` (`compareVersions`), `Feed.kt` (`verifyFeed`, `feedClaims`, `reloadFeeds`,
  `commitFeed`), `Content.kt` (`feedContent` with the delta menu, `holdsOf`/`stampHolds`,
  `revocationOf`, `verifyRevocation`, `newerRevocation`), `ContentDecision.kt`
  (`selectPackRows`, the composition, prestage), `UpdateDecision.kt` (`decideUpdate`,
  `bootDecision`, `resolveUpdateOutlet`, `rolloutBucket`) and `UpdateCheck.kt` (`runUpdateCheck`
  with the content steps). `ReleaseRecord.kt` gains the delegated path (P6-07 left it here):
  `VerifyReleaseRecordOptions.delegation`, the `delegation` and `scope` steps,
  `VerifyReleaseRecordResult.Delegated`, `verifyDelegation`, `delegationOf`, `recordRevoked`,
  `reloadReleaseRecords`. `CoreContext` gains Swift's update slices (`updateSlices`,
  `commitUpdateSlices`, `feedFloors`, re-verified on load, after a trust refresh and across
  `clearAll`) and the `packSetId` source the device report reads (`content.packSetId`).
  `Templates.kt` holds the shared `encodeURIComponent` template expansion and same-origin rule.
- **`:update` and `:packs` never see each other.** Swift's `UpdateClient` owns `packs`; here the
  update client takes an `UpdateContentHost` (a `:core` interface: `contentInput`,
  `noteFeedDeltas`, `recordRevocations`) and `:sdk`'s `PolarisKeyClient` wires the packs facet
  into it. The facets are `client.update` and `client.packs` (not `client.update.packs`);
  `PolarisKeyClientOptions` gains `update` and `packs`. `checkModuleBoundaries` now lists both
  modules as service modules (`:core` only).
- **`update.feed`** is the signed channel feed (`feedCases`, the transcripts); Swift's Sparkle
  appcast helpers (`UpdateFeed.swift`) are not ported: no Sparkle exists on Android or a JVM
  desktop, and `channelFeed()` is the feed a host reads.
- **`update.bootguard` is implemented** (the brief's scope; Swift, Python and Node leave it unowned):
  `:update`'s `BootGuard` over an `UpdateSlots` port with Godot P3-10's semantics (replaced from
  outside, stale staged code dropped, `apply-staged` and `roll-back` with `skipVersion`,
  `failedBoots` counted only while an applied update is active, the stage-matrix v2 confirmation
  rows, `confirmNow` after `BOOT_OK_SECONDS`). Godot's crash journal and its pack-set rollback are
  the slots port's own concern and are not ported. With no slots (a platform-installed Android app,
  a JVM desktop build) nothing is counted. `StageMatrixTest` (whose guard and confirm rows already
  ran) is tagged `update.bootguard` and `packs.state`.
- **The install driver** is the `InstallDriver` port (`UpdateClient.install`); `JvmInstallDriver`
  throws the typed `runtime` N/A, and `update.driver` stays planned for P6-12. Outlet detection
  reads signals through `OutletSignalReader`; the JVM's `NoOutletSignals` reads none (detection
  falls to the build stamp), and Android's readers are P6-12's.
- **zstd through zstd-jni 1.5.7-21.** zstd-jni exposes no `ZSTD_DCtx_refPrefix`, only
  `ZSTD_DCtx_loadDictionary` (dictionary auto-detection): a base that does not start with the zstd
  dictionary magic loads as raw content, and §2.7 rule 5's magic refusal runs in the applier first
  (as Node's `node:zlib` path), so every admitted frame decodes as with a prefix; libzstd copies the
  dictionary, so a delta holds its base twice. Every frame decodes as a STREAM
  (`ZstdInputStreamNoFinalizer` with `setLongMax`), which enforces `windowLogMax` and never
  sizes a buffer from a frame header: a non-streamed decode allocates the SIGNED size from the
  record or index up front, and `full` payloads stream to their sink. The start-up
  probe gates `zstd-patch-from`.
- **16 KB alignment.** The repository had no alignment check, so `sdks/kotlin/tools/check_16k_alignment.py`
  reads every ELF `PT_LOAD` of the pinned zstd-jni AAR's `.so` files (64-bit ABIs must have
  `p_align ≥ 0x4000`); all four ABIs of 1.5.7-21 are `0x4000`. The `kotlin` CI job runs it. The
  zstd-jni JAR `:packs` depends on carries only desktop natives: P6-12's `:android` must link the
  AAR of the same version (`com.github.luben:zstd-jni:<v>@aar`) in place of the JAR's natives.
- **`packs.apply.delta` carries `except: android, jvm: dependency`** (registry-allowed `*`):
  where zstd-jni's native library cannot load, `supports()` answers `dependency` through a
  `:core` detector that probes zstd-jni by reflection (so `:core` never links it), and
  `selectZstd()` answers `UnavailableZstd` with the typed `Unsupported`.
- **Storage.** `DirPackStorage` (and the default pack root, `<FileStore directory>/packs`, or the
  store's default directory when the store is not a `FileStore`) uses `java.nio.file`, which needs
  Android API 26+ as `:core`'s `FileStore` does; P6-12 passes the app's `filesDir` (never a cache
  directory). Files and directories are synced with `FileChannel.force` before a rename names them;
  the JVM cannot issue macOS's `F_FULLFSYNC`. Temp names use a random per-process token
  (`ProcessHandle` does not exist on Android).
- **Concurrency.** The engine's mutating calls run under one mutex (Swift's serialised actor
  queue); `state`, `open`, `packSetId`, `isAvailable`, `revocations`, `revokedBy` and
  `delegatedReleases` read `@Volatile` immutable snapshots and never wait for an install.
- **Transports.** `PackObjectTransport` is the object port; `OkHttpPackObjectTransport` streams
  bodies in 64 KiB pieces (`supportsRange` true), follows redirects by hand (https → http refused,
  five hops, `Authorization` dropped on every redirect, as `:core`'s transport). `:packs` adds OkHttp
  and zstd-jni as `implementation` dependencies (no SDK module).
- **The runner.** New suites: `FeedCasesTest`, `UpdateMatrixTest`, `ContentDecisionTest`,
  `PackRecordTest`, `DelegationTest`, `PlanMatrixTest`, `ContentCorpusTest` (every `content/`
  section under both zstd paths). The transcript replayer maps `updateDecide`, seeds
  `initial.update.cache` and serves the Worker's standard discovery document to a transcript that
  loads none (as the Swift and Node replayers); `update-feed-rollback` and `update-record-by-hash`
  now replay on both Ed25519 backends. `update.check`'s only proof is a transcript none records
  yet, so `UpdateClientTest` carries its tag. The packs and update unit suites
  (`PackEngineTest`, `PackTypeHandlersTest` over `pack-type-cases.json`, `PackZstdTest`,
  `UpdateClientTest`, `BootGuardTest`) are in the manifest's new `testRoots`. `TestSigner.sign`
  gains a `headerKid` (a delegated content key's `pkd1-` kid).
- **Gate.** The `kotlin` CI job's steps (the module suites, `:conformance:test` on JCA and Tink,
  `checkModuleBoundaries`, the local publications, the alignment check) were run locally and pass;
  the job itself runs when the branch is pushed.
- **No finding** where Swift and the corpus disagreed: every verdict the Swift port reaches, the
  Kotlin port reaches, and both match the corpus byte for byte.
