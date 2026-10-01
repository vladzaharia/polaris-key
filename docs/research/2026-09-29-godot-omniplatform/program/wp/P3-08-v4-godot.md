# P3-08 Wire v4 in the Godot SDK

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P3: Signed feed, decision, feeds (wire v4) (sdk-wave)                                                                                            |
| Size        | 0.5–0.75 engineer-weeks                                                                                                                          |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md), [P1-02](P1-02-godot-core.md), [P3-05](P3-05-v4-react.md)                                              |
| Unblocks    | [P3-10](P3-10-godot-updater.md), [P3-11](P3-11-outlet-detection.md), [P4-08](P4-08-godot-packs.md), [P4-13](P4-13-revocation-floors-decision.md) |
| Role        | `pkey-godot-engineer`                                                                                                                            |
| Plan mode   | no: behaviour is fixed by `plans/P3-01.md` and the corpus                                                                                        |
| Gates       | corpus (`feedCases`, `releaseRecordCases`, `update-matrix.json`, on the editor and a release template)                                           |
| Human input | none                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                        |

## Goal

The Godot SDK (`sdks/godot/addons/polaris_key/`) verifies `pkey-feed+jws` and `pkey-release+jws`
in pure GDScript, computes the rollout bucket and the update decision, persists the signed
artifacts in its verified cache, and exposes `await PolarisKey.update.decide()` plus the
`update_available` signal. Its headless runner passes every `feedCases`, `releaseRecordCases` and
`update-matrix.json` row on the editor **and** on an exported release template.

## Why

Godot is the sixth conformance language, and the decision is the "conformance-tested update
function" the SDK layout reserves at `distribution/decision`
([README §5.1](../../README.md#51-shape-and-api)). Diceroll's own verifier, decision table and
store are what this replaces ([notes/A4 §1.6 and §4.1](../../notes/A4-diceroll-mapping.md)), and
[P3-10](P3-10-godot-updater.md) builds the outlet adapters and the updater on top of it. The
two-signer check is what keeps a compromised Worker from pushing a code pack to every desktop
install ([notes/A4 §5.7](../../notes/A4-diceroll-mapping.md)).

## Read first

- `AGENTS.md`; `.claude/agents/pkey-godot-engineer.md` (the measured Godot facts); `plans/P3-01.md`.
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next),
  [§5.1](../../README.md#51-shape-and-api), [§5.2](../../README.md#52-crypto-measured) (JSON
  caveats), [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet) (build stamp).
- [notes/A2 §1](../../notes/A2-sdk-port.md) (the verify order and strict JSON rules to port);
  [notes/A5 §3](../../notes/A5-godot-empirical.md#3-pure-gdscript-ed25519-verify) (timings).
- What [P1-01](P1-01-godot-scaffold.md) and [P1-02](P1-02-godot-core.md) landed in
  `sdks/godot/addons/polaris_key/`: `core/jws.gd`, `core/json_strict.gd` (`PKeyJson`),
  `core/cache.gd`, `store/file_store.gd`, `core/transport.gd`, the runner
  (`tests/runner.gd`, `tests/suite_conformance.gd`) and the mirror `tests/corpus/v2/`.
- [P1-11](P1-11-godot-export-plugin.md)'s `core/build_stamp.gd` (`PKeyBuildStamp`,
  `PolarisKey.build_info()`) and the stamp fields.
- The reference implementation from [P3-05](P3-05-v4-react.md) in `packages/client-core/src`,
  when it has landed.

## Scope

**In:**

- The JWS layer accepts the two new `typ`s as call-site expectations, like the existing four.
- Pure GDScript (names per the plan, snake_case): `verify_feed`, `record_hash` (SHA-256 through
  `HashingContext`, which Godot has natively), `verify_release_record`, `rollout_bucket`,
  `decide_update` in `distribution/decision.gd`, and the outlet capability defaults table.
- Configuration: `pinned_release_keys` in `res://polaris_key.tres` beside `pinned_trust_keys`
  (README §5.1), never merged with the product trust set.
- Decision inputs from `PolarisKey.build_info()` (the stamp `res://.polaris_key/build.json`:
  `version`, `build`, `outlet`, `channel`, `engine`, `platform`, `arch`), which falls back to
  project settings when there is no stamp; `install_id` is the SDK's device id.
- Cache: the plan's new slices in `user://pkey/<product>/managed.json`, written atomically
  (temp file and rename, as P1-02 does), re-verified on load, with the `seq` floor derived from
  the re-verified feed.
- The update service: `PolarisKey.update.feed(channel)`, `release_record(hash)` and `decide()`
  as coroutines returning typed `RefCounted` results, and an `update_available` signal carrying
  the decision (names per the plan).
- Runner: `feedCases`, `releaseRecordCases`, `update-matrix.json` rows and bucket vectors, on
  the editor and on a release template (`application/run/main_loop_type`, since 4.6+ templates
  ignore `--script`). Record verify timings for a feed plus one record on both.
- The Godot docs page's update section; `sdks/godot/parity.json`: `update.feed`,
  `release.record`, `update.decide` → `implemented`.

**Out** (and where it belongs instead):

- Outlet adapters, the sidecar-PCK swap, the boot guard, native updater hooks and the `DECIDE`
  stage of `PKeyBoot` (→ [P3-10](P3-10-godot-updater.md)).
- Outlet detection signals (→ [P3-11](P3-11-outlet-detection.md)); until then the stamp's outlet
  is the input.
- Packs (→ [P4-08](P4-08-godot-packs.md)).

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
- **Strict JSON after the signature check.** Godot's parser keeps the last duplicate key and
  accepts trailing commas, leading zeros and raw control characters; P1-02's strict validator
  must run on every feed and record payload. Every number is a float: compare `seq` and times as
  integers exact below 2^53, and reject non-integers where the plan says integer.
- **Same order, same verdicts** as README §3.3: feed against the product trust set; the record's
  hash compared with the pin before any Ed25519 work (it is also the cheaper check); record
  against `pinned_release_keys` only.
- **Performance.** A feed and a record are two small verifies, about 14 ms on a desktop release
  template and 40–90 ms estimated on low-end Android (notes/A5 §3). Keep them off the frame that
  draws the first scene; use a `WorkerThreadPool` task where threads exist and chunk on
  single-threaded web exports.
- **No persisted counters** (WIRE-CONTRACT-V3 §4.1). Derive floors on load; never write a
  "verified" marker.
- **The decision is pure.** No `OS`, file or network calls inside `decide_update`; the service
  gathers the inputs and passes them in, so the runner can drive it on a template.

## Steps

1. Confirm P3-02, P3-05 and P1-02 are `done`; branch `wp/P3-08-v4-godot`.
2. `typ` handling, models and pure functions; runner sections green on the editor.
3. Cache slices and the load path.
4. The update service methods and signal; configuration.
5. Release-template run and timings; docs; `parity.json`. Set `in-review`.

## Acceptance criteria

- [ ] The runner passes every `feedCases`, `releaseRecordCases`, `update-matrix.json` row and
      bucket vector on the editor and on an exported release template.
- [ ] Verify timings for a feed and a record are recorded in the PR for both targets.
- [ ] A reload refuses a feed with a lower `seq`, using a floor derived from a re-verified cached
      JWS; a record with a mismatched hash is refused before Ed25519 runs.
- [ ] `await PolarisKey.update.decide()` returns the plan's decision and `update_available` fires
      with it; if P1-08 has landed, its `check()` tests still pass.
- [ ] The green gate passes for the parts touched, including the Godot CI job.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
# P1-01's runner: the editor, then a release template
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
# the 4.4 source-compatibility floor
GODOT_BIN=godot-4.4.1 sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- `distribution/decision.gd` (`decide_update`, `rollout_bucket`, the capability defaults) and the
  verified feed and record, which [P3-10](P3-10-godot-updater.md)'s outlet adapters and updater
  act on.
- The cache slices and the `update` service surface, extended by [P4-08](P4-08-godot-packs.md)
  (pack facet) and [P4-13](P4-13-revocation-floors-decision.md) (content rows).
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-08 done` in the PR
  that completes the work.
