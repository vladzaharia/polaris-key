# P3-07 Wire v4 in the Swift SDK

| Field       | Value                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4) (sdk-wave)                                                                  |
| Size        | 0.5–0.75 engineer-weeks                                                                                                |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md), [P3-05](P3-05-v4-react.md)                                                  |
| Unblocks    | [P3-11](P3-11-outlet-detection.md), [P4-07](P4-07-python-swift-packs.md), [P4-13](P4-13-revocation-floors-decision.md) |
| Role        | `pkey-sdk-porter`                                                                                                      |
| Plan mode   | no: behaviour is fixed by `plans/P3-01.md` and the corpus                                                              |
| Gates       | corpus (`feedCases`, `releaseRecordCases`, `update-matrix.json`)                                                       |
| Human input | none (a macOS runner, as CI already uses for `swift test`)                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                              |

## Goal

The Swift package (`PolarisKey`) verifies `pkey-feed+jws` and `pkey-release+jws`, computes the
rollout bucket and the update decision as pure functions in `PolarisKeyCore`, persists the signed
artifacts in its verified cache, and exposes the decision through `UpdateClient`. The decision
works on iOS and macOS alike, and `swift test` passes every `feedCases`, `releaseRecordCases` and
`update-matrix.json` row from the mirrored resources.

## Why

Swift is an independent port proven by the corpus. iOS apps are "decide only" hosts (App Store,
TestFlight, marketplaces) and macOS direct builds hand off to Sparkle
([notes/E9 §2.3](../../notes/E9-runtime-building-blocks.md)); both need the same verified
decision as every other SDK ([PARITY §5.5](../../PARITY.md#55-release-and-update)).
`PolarisKeyUpdate` is Sparkle wiring conditioned to macOS (`sdks/swift/Package.swift`), so the
parts iOS needs must live in `PolarisKeyCore`.

## Read first

- `AGENTS.md` (Swift toolchain in the green gate); `.claude/agents/pkey-sdk-porter.md`;
  `plans/P3-01.md`.
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents) (client order),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next).
- `sdks/swift/Package.swift` (the five targets, the Sparkle conditioning, `.copy("Resources/v2")`).
- `Sources/PolarisKeyCore/JWSVerifier.swift` (`JwsTyp` at `:39`, the verify order),
  `Verify.swift`, `Trust.swift`, `Store.swift` (`CacheRecord` at `:29`), `CoreContext.swift`
  (load path and floors), `Models.swift` (`POLARIS_PROTOCOL_VERSION` at `:262`), `Semver.swift`,
  `Discovery.swift`.
- `Sources/PolarisKeyUpdate/UpdateClient.swift`, `UpdateFeed.swift`, `SparkleUpdater.swift`.
- `Tests/PolarisKeyTests/ConformanceTests.swift`, `GateMatrixTests.swift` (the matrix pattern:
  a deliberate independent port), `UpdateTests.swift`.
- The reference implementation from [P3-05](P3-05-v4-react.md), a graph dependency.

## Scope

**In:**

- `JwsTyp` gains `.feed = "pkey-feed+jws"` and `.release = "pkey-release+jws"`, unless P3-02
  already added them.
- New `PolarisKeyCore` sources (names per the plan; proposed `Feed.swift`, `ReleaseRecord.swift`,
  `UpdateDecision.swift`): `verifyFeed`, `recordHash` (CryptoKit SHA-256 over the ASCII string),
  `verifyReleaseRecord`, `rolloutBucket`, `decideUpdate`, and the outlet capability defaults
  table. They return `nil` or a typed refusal, never throw for a bad artifact.
- `Store.swift` `CacheRecord`: the plan's new slices, with `Codable` round-trip; `CoreContext`
  re-verifies them on load with freshness off and derives the `seq` floor.
- `UpdateClient`: the plan's methods (proposed `feed(channel:)`, `releaseRecord(hash:)`,
  `decide(channel:staged:skipVersion:)`), using discovery's endpoints and the device id as
  `installId`; `check(channel:)` is unchanged.
- Options: `pinnedReleaseKeys`, `outlet` (host-supplied until [P3-11](P3-11-outlet-detection.md))
  and `buildNumber` (default: `CFBundleVersion`), where the plan puts them.
- Tests: new sections in `ConformanceTests.swift` for `feedCases` and `releaseRecordCases`; a new
  `UpdateMatrixTests.swift` reading `Resources/v2/update-matrix.json`; wiring tests in
  `UpdateTests.swift` (reload floor, hash before signature, stale feed).
- `packages/docs/src/content/docs/build/sdks/swift.mdx`; the package README.
- `parity.json` for Swift: `update.feed`, `release.record`, `update.decide` → `implemented`.

**Out** (and where it belongs instead):

- `AppDistributor` and `AppTransaction` outlet detection (→ [P3-11](P3-11-outlet-detection.md)).
- Gating Sparkle's own check with the decision, and other `update.driver` work (not in P3; the
  Godot Sparkle bridge is [P5-07](P5-07-desktop-plugins.md)).
- Packs and Background Assets (→ [P4-07](P4-07-python-swift-packs.md), P5-08).

## Design notes

- **Plan amendments (`plans/P3-01.md` §8, approved).** Where this brief and the plan differ, the
  plan wins:
  - the function names, refusal reasons and steps in plan §2.7 and §2.5, including
    `parseVersion`, `compareVersions`, `resolveUpdateOutlet` and
    `effectiveCapabilities(kind, {platform, …})`;
  - `decide()` returns an `UpdateCheck` (`channel`, `decision`, `feed`, `record`, `errors`) with
    §2.5's error map, the record-body bound (`MAX_RECORD_JWS_BYTES`, 88 844 bytes, refused at
    step 12 without hashing) included; the decision inputs are `outlet {id, kind}`, `subkind`,
    `format` and `methods`;
  - every pattern goes through the SDK's whole-string pattern helper, and member presence is as
    plan §2.2 says (a required member present, an optional one absent or typed, never `null`);
    `builds[].id` and `targets[].platform` are ASCII by `BUILD_ID_PATTERN` and
    `FEED_PLATFORM_PATTERN`;
  - the cache slices are `feeds` and `releaseRecords`; `bootDecision` never answers `required`,
    and `mandatory` and `blocked` are prompts the player cannot dismiss; an empty
    `pinnedReleaseKeys` raises `not-configured` and a release key that is also a trust pin raises
    `invalid-options`;
  - the canonical channel (§2.3, §2.5, §2.6): `feeds` and the floors are keyed by each feed's own
    `channel` claim, `verifyFeed`'s `floors` map is read only after step 5, the fallback order,
    the removal of the requested name's entry after an alias answer, and `UpdateCheck.channel`;
    no SDK resolves an alias itself, and the decision has no `channel` input;
  - this package's transcript replayer learns the `updateDecide` action and the `initial.update`
    block in the same PR that flips `update.feed`, `release.record` and `update.decide`
    (plan §5).
- **Keep the port independent.** `GateMatrixTests.swift` explains why: the matrix proves that
  independent implementations agree, and a shared helper would prove only that they share one.
- **Same order, same verdicts** as README §3.3: feed against the product trust set; record hash
  against the pin before any signature work; record against `pinnedReleaseKeys` only.
- **iOS must not link Sparkle.** Nothing new imports Sparkle, and nothing the decision needs sits
  behind `#if os(macOS)`. Check an iOS build of `PolarisKeyCore` on the macOS runner (for
  example `xcodebuild -scheme PolarisKeyCore -destination 'generic/platform=iOS' build`).
- **Swift 6 language mode** and `Sendable`: the new types are value types.
- **Floors are derived, never stored** (WIRE-CONTRACT-V3 §4.1); `CacheRecord` holds JWS strings
  only.
- The mirror is generator-owned (`Resources/v2/`); never edit it by hand.

## Steps

1. Confirm P3-02 and P3-05 are `done` (P3-05 is a graph dependency); branch `wp/P3-07-v4-swift`.
2. `JwsTyp`, models and pure functions; conformance and matrix tests go green.
3. Cache slices and the load path.
4. `UpdateClient` and options.
5. Docs, `parity.json`. `swift build && swift test`; set `in-review`.

## Acceptance criteria

- [ ] `swift test` passes every `feedCases`, `releaseRecordCases`, `update-matrix.json` row and
      bucket vector, with the same ids as the other runners.
- [ ] The decision functions compile and run for iOS (no Sparkle import in `PolarisKeyCore`).
- [ ] A reload refuses a feed with a lower `seq`, using a floor derived from a re-verified cached
      JWS.
- [ ] A record with a mismatched hash is refused before signature verification; a record signed
      by the product key is refused.
- [ ] `check(channel:)` and the Sparkle feed helpers behave as before.
- [ ] The green gate passes (`AGENTS.md`), including the Swift job.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
( cd sdks/swift && swift build && swift test )
( cd sdks/swift && swift test --filter UpdateMatrixTests )
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- `verifyFeed`, `verifyReleaseRecord`, `decideUpdate` and the `CacheRecord` slices in
  `PolarisKeyCore`, which [P4-07](P4-07-python-swift-packs.md) extends with the pack facet and
  [P4-13](P4-13-revocation-floors-decision.md) with content rows; the Apple plugin package
  ([P5-05](P5-05-apple-plugin-package.md)) reuses them.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-07 done` in the PR
  that completes the work.
