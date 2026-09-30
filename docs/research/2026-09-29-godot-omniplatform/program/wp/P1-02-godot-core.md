# P1-02 Godot core: strict JSON, verify, trust, clock, cache, transport, persistence

| Field       | Value                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P1: Godot SDK core                                                                                                                                                                                                                         |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                       |
| Depends on  | [P1-01](P1-01-godot-scaffold.md)                                                                                                                                                                                                           |
| Unblocks    | [P1-03](P1-03-godot-license.md), [P1-04](P1-04-godot-config.md), [P1-05](P1-05-godot-devices.md), [P1-07](P1-07-godot-identity.md), [P1-08](P1-08-godot-update-check.md), [P1-09](P1-09-boot-stage-machine.md), [P3-08](P3-08-v4-godot.md) |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                                      |
| Plan mode   | no (no corpus or contract change; a divergence found here goes to a plan-mode work package)                                                                                                                                                |
| Gates       | `corpus:cases`: every `cases.json` section and `fingerprint.json` `deviceIds` pass in the Godot runner on the editor and the release template                                                                                              |
| Human input | none                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                  |

## Goal

The addon has a complete, offline-capable Core: strict base64url and JSON, the 13-step JWS
verify, licence and config claim checks, the trust manifest, the clock floor, the verified cache,
file persistence, bundle import, discovery and capabilities, an HTTP transport that never leaks
the bearer token, and `sync()`. The Godot runner passes all 36 `jwsCases`, 16
`licenseDocCases`, 18 `configDocCases`, 11 `trustCases`, 7 `clockFloorCases`, 9 `bundleCases`
and the 4 `fingerprint.json` `deviceIds` vectors, on the 4.7.2 editor and the release template.

## Why

Every service client (licence, config, devices, identity, update) and the v4 work sit on this
Core. Godot's engine differs from the reference in ways that silently change verdicts if they are
not handled: a lenient JSON parser that keeps the last duplicate key and accepts trailing commas,
leading zeros and raw control characters; every number a float; `HTTPRequest` forwarding
`Authorization` on cross-host redirects; no SHA-512 or Ed25519 at all (report
[§5.2](../../README.md#52-crypto-measured),
[§5.3](../../README.md#53-transport-persistence-device-identity),
notes/A5 §2 and §4). The feature ids this work package turns on are `core.verify`,
`core.cache`, `core.bundle`, `core.discover`, `core.sync`, `core.local`, and partly
`core.headers`, `core.errors`, `core.store` ([PARITY §5.1](../../PARITY.md#51-core)).

## Read first

- `AGENTS.md` (rules 1, 2, 7; the green gate), the [P1-01](P1-01-godot-scaffold.md) hand-off
  and `program/plans/P1-01.md` (the NUL decision).
- Report [§5.1](../../README.md#51-shape-and-api), [§5.2](../../README.md#52-crypto-measured),
  [§5.3](../../README.md#53-transport-persistence-device-identity).
- [notes/A2](../../notes/A2-sdk-port.md) §1.1–§1.8, §1.12–§1.15 (every algorithm with file:line
  in the reference), §2 (the HTTP surface), §9.1 (the facade API), §12 (persistence).
- [notes/A5](../../notes/A5-godot-empirical.md) §2 (base64, int64, JSON), §3 (verify cost and the
  per-`kid` cache), §4 (HTTP probe results).
- `docs/security/WIRE-CONTRACT-V3.md` §1–§7 and §10 (no local tolerances).
- Reference code: `packages/shared-jws/src/index.ts:80-121,136-185,308-379`;
  `packages/client-core/src/{verify.ts,trust.ts,clock.ts,gate.ts,bundle.ts,store.ts}`;
  `packages/sdk-node/src/core/{context.ts,cache.ts,sync.ts,token.ts,store.ts}`,
  `packages/sdk-node/src/discovery.ts:258-291`. Swift's `sdks/swift/Sources/PolarisKeyCore/` is
  the closest non-JS port.

## Scope

**In** (files under `addons/polaris_key/core/` unless noted):

- `b64url.gd`: strict alphabet check first, reject `len % 4 == 1`, map, pad, then
  `Marshalls.base64_to_raw`; a lenient decoder for trust-set keys only.
- `json_strict.gd` (`PKeyJson`): a byte-level RFC 8259 validator that rejects everything
  `JSON.parse` rejects (trailing commas, leading zeros, `1.`, raw control characters, bad
  escapes, non-JSON literals) plus duplicate keys at any depth, then builds values with
  `JSON.new().parse()` and checks its `Error`, never `JSON.parse_string` (whose `null` is
  ambiguous).
- `jws.gd` (`PKeyJws`): the 13-step order over `PKeyJson`; a per-`kid` cache of the decompressed
  key and its precomputed table; an incremental `PKeySha512` API so a bundle-sized verify runs on
  `WorkerThreadPool` where `OS.has_feature("threads")`, and spreads across frames otherwise.
- `semver.gd` (`PKeySemver.parse`, `compare`: a port of `client-core/src/semver.ts`, used to
  refuse a non-semver version here and by P1-03 and P1-08).
- `verify.gd` (envelope, licence and config claims), `trust.gd` (verify against pins only, merge
  with pins terminal, anti-rollback in memory), `clock.gd`, `gate.gd` (`license_state`,
  `is_usable`: the nine-step order, needed by `clockFloorCases`), `bundle.gd` (inspect with the
  four refusal reasons, then import).
- `cache.gd`: the `CacheRecordV3` shape exactly as `client-core/src/store.ts:34-50`, the load
  procedure, one whole-record write per sync.
- `store/file_store.gd` behind a `PKeyStore` interface: the files `device`, `token` and
  `managed.json` under `user://pkey/<product>/`, 0600 via `FileAccess.set_unix_permissions` on
  macOS and Linux, temp file plus `DirAccess.rename_absolute` for every write, a write-once
  device id whose write failure is surfaced, and `store_status()` in P1b-09's shape (`backend`:
  `file` or `indexeddb`; `degraded` with a reason when persistence is not durable).
- `device_id.gd`: `PKeyDeviceId.from_raw(slug, raw)` and a default raw source
  (`OS.get_unique_id()`; on web or on failure a random 16-byte UUID).
- `transport.gd`, `discovery.gd`, `token.gd`, `sync.gd`, `errors.gd`, `result.gd`,
  `options.gd` (`PKeyOptions extends Resource`), and the autoload `polaris_key.gd`
  (`configure`, `start`, `discover`, `capabilities`, `sync`, `get_sync_state`, `import_bundle`,
  `status`, signals).
- Runner: the remaining `cases.json` sections and `fingerprint.json` `deviceIds` in
  `suite_conformance.gd`; a `core` unit suite against a GDScript loopback fake server
  (`tests/support/fake_server.gd`, `TCPServer` on 127.0.0.1). Both join the `ci` set.

**Out** (and where it belongs instead):

- `gate-matrix.json`, the build-gate port, the licence client and both re-acquire strategies
  (→ [P1-03](P1-03-godot-license.md)).
- Config resolution and secrets (→ [P1-04](P1-04-godot-config.md)); fingerprint components,
  desktop device-id sources, register and report (→ [P1-05](P1-05-godot-devices.md)).
- Keychain/Keystore token stores (→ [P5-05](P5-05-apple-plugin-package.md),
  [P5-06](P5-06-kotlin-aar.md)); a desktop keyring is unowned.
- Recording transcripts (→ [P1b-03](P1b-03-http-transcripts.md), which leaves the Godot replayer
  to the Godot P1 packages; see Design notes); `supports()` and generated constants
  (→ [P1b-01](P1b-01-parity-registry.md), [P1b-02](P1b-02-sdk-constants.md)); canonical header
  values (→ [P1b-04](P1b-04-headers-config-corpora.md)).
- Worker CORS for web exports (→ [P0-05](P0-05-cors.md)); wire v4 (→ [P3-08](P3-08-v4-godot.md)).
- WebCrypto or GDExtension verify accelerators (optional, unowned; they must pass the same
  corpus if added).

## Design notes

- **Verdicts come from the corpus, not from Godot.** Validate before `JSON` sees a byte. Two
  divergences are known and must be recorded, not tolerated: Godot rejects a lone surrogate
  that JS accepts, and U+0000 follows the P1-01 plan's decision. No corpus vector covers the
  lone surrogate yet; report it for [P3-02](P3-02-wire-v4-contract-corpus.md) (report
  [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #19) instead of adding a
  case here.
- **Numbers are float64.** Integer claims (`schemaVersion`) are `v == floor(v) and v >= 1`;
  never test `typeof(v) == TYPE_INT`. The cache's `v` compares as `3.0 == 3`.
- **Never persist derived state.** Clock floor, anti-replay floors, the trust set and
  `lastVerifiedAt` are recomputed at load. Do not copy Swift's double verify on reload
  (notes/A2 §1.7): it doubles the most expensive operation.
- **Never pin from discovery** (`trust.pinnedKeys`): pins come only from
  `PKeyOptions.pinned_trust_keys`.
- **Transport rules** (notes/A5 §4): `max_redirects = 0` and follow redirects manually, dropping
  `Authorization` whenever the origin changes; `timeout = 15.0`; `body_size_limit` 512 KiB for API
  responses; `accept_gzip = false` for any `Range` request; https only, except
  `http://localhost|127.0.0.1|[::1]`. `HTTPRequest` nodes live under the autoload. On web the
  browser follows redirects and strips credentials itself; cross-origin calls need P0-05.
- **Headers:** the seven `X-PKey-*` headers, with `X-PKey-SDK-Version: SDK_VERSION`. The SDK id
  is `polaris-key-godot` (notes/A2 §5.4) unless [P1b-04](P1b-04-headers-config-corpora.md)'s plan
  has settled on short ids (it recommends `godot`). No canonical platform or arch set exists yet
  (report §9.1 #17); use the report's vocabulary ([§3.1](../../README.md#31-vocabulary):
  `windows`, `macos`, `linux`, `ios`, `android`, `web`; `x86_64`, `arm64`, `armv7`, `wasm32`,
  omitting anything else) from one table in `core/headers.gd`. P1b-02 generates
  `core/constants_generated.gd` to replace it, and P1b-04's `headers.json` pins the mapping.
- **Version** is `PKeyOptions.version`, else `application/config/version`; it must be semver,
  refused at `configure` otherwise. The channel is `PKeyOptions.default_channel` until the build
  stamp (P1-11) supplies one.
- **Sync** mirrors `sdk-node/src/core/sync.ts`: discovery once per session, trust at the top of
  every pass (a failure keeps the old set), licence and config fetched in parallel with a
  signal-based join, ETag/304, the half-life refetch (`effectiveNow > expiresAt − 1800`), one
  shared re-acquire per pass through an injected callable (P1-03 supplies it), a hard 401 records
  `lastSyncUnauthorized`, a 403 build block records `blocked`, 200/304 clears both, one cache
  write. Read both error-body spellings (nested and flat, notes/A2 §1.13). There are no generic
  retries, as in every SDK today; a 429 surfaces as `rate_limited`. The refresh loop is off by
  default (`refresh_interval_seconds`, a `Timer` child) and, when on, also syncs on
  `NOTIFICATION_APPLICATION_RESUMED`.
- **Capabilities** are fail-closed (D-21): discovery this session, else
  `PKeyOptions.expected_services`, else licence and config only.
- **Results** (settles PARITY §11 question 3): `PKeyResult extends RefCounted` with `ok`,
  `code: StringName` (wire codes as the server spells them, client codes such as
  `insecure-base-url`, `local-only`, `service-unavailable`), `message` and `detail`. An
  unsupported feature is `code == &"unsupported"` with `detail = {feature, reason}`.
- **Web:** `user://` is IndexedDB and may not persist (`OS.is_userfs_persistent()`); report it.
  A cleared store means a new device id.
- **Transcripts:** write the fake server so it can serve P1b-03's `conformance/transcripts/*.json`
  format. If P1b-03 has landed when this package starts, add a Godot mirror to
  `pnpm gen:transcripts` (beside Swift's) and a replayer that filters by `sdks/godot/parity.json`,
  replaying the `discovery-*` and sync transcripts; otherwise the first Godot package that starts
  after P1b-03 does it.
- Keep 4.4 syntax (P1-01). Use `@warning_ignore` sparingly; never silence parse errors.

## Steps

1. Split the prototype `PKeyJws` into `b64url.gd`, `json_strict.gd` and `jws.gd`; keep the
   `jwsCases` green after each step.
2. Port claims, trust, clock and the gate's `license_state`; add the corresponding corpus
   sections to the runner one at a time.
3. Port bundle inspect/import and add `bundleCases` with reason attribution.
4. Write the store, the cache and `device_id.gd`; add the `deviceIds` vectors.
5. Write the fake server, then transport, discovery, token and sync, test-first.
6. Add the per-`kid` cache and threaded or chunked bundle verification; record timings.
7. Wire the autoload and `PKeyOptions`; run the full `ci` set on both targets.

## Acceptance criteria

- [ ] On the 4.7.2 editor and release template the runner reports, per section: `jwsCases`
      36/36, `licenseDocCases` 16/16, `configDocCases` 18/18, `trustCases` 11/11,
      `clockFloorCases` 7/7, `bundleCases` 9/9 (including the refusal reason), `deviceIds` 4/4.
- [ ] `PKeyJson` unit tests reject each of: a trailing comma, a leading zero, `1.`, a raw
      control character, a duplicate key at depth 3; and accept `1e400` and 2^53−1 exactly as
      `JSON.parse` does.
- [ ] Transport tests against the fake server: a same-origin redirect keeps `Authorization`; a
      cross-origin redirect drops it; a body over the cap and a timeout both return a
      `PKeyResult` error; plain `http://` to a non-loopback host is refused at `configure`.
- [ ] Sync tests: 304 keeps the cached document; parallel 401s cause exactly one re-acquire
      call; a hard 401 sets `lastSyncUnauthorized`; a 403 block sets `blocked`; a later 200
      clears both; each pass writes `managed.json` exactly once.
- [ ] A cache file edited by hand (a changed payload byte, a `v` of 2, a foreign `kid`) loads
      as absent, never as trusted; derived counters are never read from disk.
- [ ] A failed device-id write is surfaced through `store_error` and `last_store_error`, and no
      new id is minted on the next start.
- [ ] The profile suite records trust + licence + config verification time and a 350 KB bundle
      import on the release template in the PR; the main thread is not blocked by the bundle
      verify on a threaded build.
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job.
- [ ] `sdks/godot/parity.json` marks `core.verify`, `core.cache`, `core.bundle`,
      `core.discover`, `core.sync`, `core.local` implemented, with `# @pkey-feature` test tags
      (once P1b-01 has landed).

## Verify

```sh
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
godot --headless --path sdks/godot -- --pkey-test core,conformance
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- **Autoload** `PolarisKey`: `configure(opts: PKeyOptions)`, `await start()`, `await discover()`,
  `capabilities() -> Dictionary`, `await sync(force := false) -> PKeySyncResult`,
  `get_sync_state()`, `await import_bundle(text) -> PKeyResult`, `status()`; signals
  `state_changed(state)`, `sync_finished(result)`, `store_error(err)`.
- **Hooks** for later packages: `PKeyTokenManager.set_reacquire(callable)` (P1-03);
  `PolarisKey.core.request(method, path, body, auth)` returning `PKeyResult` (every service
  client); `PKeyDeviceId.set_raw_source(callable)` (P1-05); a post-sync hook for telemetry
  (P1-05).
- **Types:** `PKeySemver`, `PKeyResult`, `PKeyCache`, `PKeyStore`, and `PKeyOptions`
  (`product`, `base_url`, `version`, `default_channel`, `pinned_trust_keys`,
  `pinned_release_keys` (unused until P3-08), `expected_services`, `local_only`,
  `refresh_interval_seconds`).
- **Generated constants path** for P1b-02: `addons/polaris_key/core/constants_generated.gd`.
- Divergences found (lone surrogate, anything else) are listed in the PR for P3-02.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-02 done`.
