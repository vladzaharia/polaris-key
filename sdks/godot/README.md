# Polaris Key — Godot SDK (contributors)

A Godot 4 project holding the Polaris Key addon and its headless test runner. The addon is pure
GDScript: the engine has no Ed25519 and no SHA-512, so `addons/polaris_key/core/crypto/` carries
its own. Godot is the sixth language of the conformance corpus. Licence: MIT, like the rest of the
repository.

The addon's Core (P1-02) is offline-capable: strict base64url and JSON, the 13-step JWS verify,
licence and config claims, the trust manifest, the clock floor, the verified cache, the file
store, bundle import, discovery and capabilities, an HTTP transport that never leaks the bearer,
and `sync()`, behind the `PolarisKey` autoload. The service clients build on `PolarisKey.core`;
`PolarisKey.config` (P1-04), `license` (P1-03), `devices` (P1-05), `update` and `release` (P1-08)
are in, and `identity` (P1-07). Wire v4 (P3-08) adds the signed channel feed and release record,
verified in pure GDScript, and the conformance-tested update decision behind
`PolarisKey.update.decide()`. P1-10 adds the boot stage machine (`PKeyStages`), the drop-in boot
scene (`PKeyBoot`, `PolarisKey.boot()`) and the UI kit v1 under `addons/polaris_key/ui/`. P3-10
acts on the decision: one adapter per outlet, the native-updater hooks, the sidecar-PCK swap and
the boot guard (see "Updates by outlet"). P4-08 adds packs, `PolarisKey.update.packs`: a GDScript
port of client-core's pack core and pipeline, the `godot.pck` and `files.tree` handlers, the delta
bake through the engine's own decoder, the device-side directory check, and PKeyBoot's FETCH,
MOUNT and BACKGROUND stages (see "Packs"). P4-24 adds the content decision (the feed's
`packSets`, `packFloors` and `revocations`, CI-signed revocation records, the `packs` answer,
`content-floor` and `revoked-content`) and the device's revocations (see "Revocations"). P4-26
adds content-key delegation: data-only pack releases signed by a delegated content key, and the
data-only rule (see "Content-key delegation").

## Layout

```text
sdks/godot/
  project.godot               main loop = PKeyTestRunner; flush_stdout_on_print
  export_presets.cfg          one preset, "Conformance (Linux)": the test pack (and its
                              polaris_key/* stamp options)
  polaris_key.tres            the harness's PKeyOptions, as the setup dock writes it (product
                              pkey-harness, editor channel dev)
  parity.json                 the Godot parity manifest (conformance/parity/)
  native/                     the native plugins' sources: ios/ (P5-05), and P5-07's macos/,
                              windows/, build and signing scripts and e2e/ runs
                              (native/README.md); .gdignore'd, never in a release
  addons/polaris_key/         the addon (the only directory a release ships)
    plugin.cfg, plugin.gd     editor shell: the autoload, the export plugin, the setup dock
    export/export_plugin.gd   PKeyExportPlugin: the build stamp and the pkey_* feature tags
    editor/setup_dock.tscn    the setup dock (setup_dock.gd); editor/setup_check.gd is
                              PKeySetupCheck, its editor-free logic (pins, Check, Save)
    core/build_stamp.gd       PKeyBuildStamp: res://.polaris_key/build.json, its reader, the
                              editor fallback and the export-side checks
    polaris_key.gd            the PolarisKey autoload: configure, start, discover, capabilities,
                              sync, get_sync_state, import_bundle, status, build_info; three
                              signals;
                              the `devices`, `license`, `update` and `release` sub-objects
    services/devices.gd       PKeyDevices (PolarisKey.devices): fingerprint, register, list,
                              rename, deauthorize, report (also after every sync)
    services/license.gd       PKeyLicense (PolarisKey.license): the gate, activate_with_key,
                              enroll, deactivate, entitlements, entitled_channels, and the
                              401 re-acquire it installs into Core (license/token or
                              devices/register, P1b-06's rule)
    services/license/         PKeyActivationResult (both error spellings), PKeyLicenseEndpoints
    services/update.gd        PKeyUpdate (PolarisKey.update): decide -> PKeyUpdateCheck, feed ->
                              PKeyUpdateFeed, release_record -> PKeyReleaseRecordResult (wire
                              v4); check -> PKeyVersionCheck (v3); update_available(result),
                              appcast_url
    services/update/          flow.gd (PKeyUpdateFlow: §2.5 steps 2–18, client-core
                              `runUpdateCheck`) and the result classes
    distribution/decision.gd  PKeyDecision: rollout_bucket, effective_capabilities (the compiled
                              outlet tables), resolve_update_outlet, decide_update (the content
                              decision included), select_pack_rows, boot_decision
    distribution/outlets/     PKeyOutletAdapter and one adapter per outlet kind (direct.gd,
                              app_store.gd, steam.gd, web.gd, …; adapters.gd maps kinds to them);
                              the native-updater bridges PKeyNativeBridge, PKeySparkleBridge,
                              PKeyVelopackBridge, PKeyWinSparkleBridge, PKeyStoreContextBridge,
                              PKeyAppImageBridge
    native/                   P5-07's facades over the optional desktop GDExtensions:
                              PKeyNativeFacade, PKeySparkle, PKeyVelopack, PKeyWinSparkle,
                              PKeyStoreContext; native/bin/ is where a game installs the binaries
                              (git-ignored here)
    export/native_export.gd   PKeyNativeExport: the macOS export's Sparkle switches
    updater/                  PKeyUpdater (PolarisKey.update.updater: the adapters' context,
                              methods, boot confirmation), PKeySlots (staged/current/previous),
                              PKeyBootGuard, PKeySidecarSwap, PKeyUpdaterEnv (every side effect),
                              PKeyApplyResult
    core/download.gd          PKeyDownload: a file download on HTTPClient with Range resume, the
                              transport's redirect and credential rules, gzip off
    services/packs.gd         PKeyPacks (PolarisKey.update.packs, P4-08): start, ensure, estimate,
                              mount, boot_fetch, background, state, path, rollback, confirm,
                              packSetId, is_available, pack_for; the pack signals; P4-24:
                              ensure_releases, revocations, content_input, record_revocations;
                              P4-26: the stamp's holds reach the engine, content_input's
                              `delegated`, a delegated install is never mounted
    packs/                    the pack core, ported from client-core `packs/`: pack_claims.gd
                              (PKeyPackClaims: pack ids, object refs, content claims, the pack
                              record claims, variant keys, packSetId, the content stamp), files.gd
                              (PKeyPackFiles: the files index, path rules, treeDigest), select.gd
                              (PKeyPackSelect: selectVariant, planTarget, the planner), patch.gd,
                              apply.gd (PKeyPackApply: full, delta, file), marker.gd, state.gd
                              (PKeyPackState), revocations.gd (PKeyPackRevocations: the sibling
                              revocations.json, P4-24), engine.gd (PKeyPackEngine: the pipeline,
                              pack-revoked; P4-26: fetch_verified, the delegated surface,
                              pack-not-data-only, revoked_by, delegated_releases), dataonly.gd
                              (PKeyDataOnly: the data-only rule, P4-26), and the
                              Godot ports: zstd.gd (PKeyPackZstd: decompress, the window rule,
                              GDDL prefix decodes), pck.gd (PKeyPck: the PCK reader, the header and
                              directory checks, helper packs, the trailer), storage.gd
                              (PKeyPackStorage: user://pkey), byte_source.gd, job.gd, http.gd
                              (Range/If-Range on HTTPClient), transport*.gd (pkey-cdn, embedded),
                              handler.gd, godot_pck_handler.gd, files_tree_handler.gd
    services/release.gd       PKeyRelease (PolarisKey.release): changelog -> PKeyChangelogResult
                              of PKeyChangelogEntry (services/release/), install_url,
                              download_url
    core/uri.gd               PKeyUri: encodeURIComponent and URLSearchParams encoding, byte for
                              byte as sdk-node (String.uri_encode() is not)
    core/channel.gd           PKeyChannel: the §5.1 channel vocabulary, the header this SDK sends
    core/fingerprint.gd       PKeyFingerprint: per-platform readers as pure parsers over captured
                              output, hashing, the desktop device-id raw source
    core/host_io.gd           PKeyHostIo: every side effect the readers perform (replaceable)
    core/facts.gd             PKeyFacts: DeviceFacts, declared probes, the engine and outlet keys
    core/options.gd           PKeyOptions (a Resource): product, base_url, version, pins, …
    core/core.gd              PKeyCore: wiring, request(), sync state; PolarisKey.core
    core/b64url.gd            PKeyB64Url: strict (wire) and lenient (trust-set keys) base64url
    core/json_strict.gd       PKeyJson: RFC 8259 validator, duplicate keys, the §10 NUL rule
    core/jws.gd               PKeyJws: the 13-step verify; per-kid key cache; inline, thread, sliced
    core/verify.gd, claims.gd envelope, licence and config claims
    core/trust.gd, clock.gd   trust manifest (pins terminal) and the clock floor
    core/gate.gd, bundle.gd   license_state and bundle inspect/import
    core/cache.gd             PKeyCache: CacheRecordV3 (the `feeds` and `releaseRecords` slices
                              included), verified at load, one write per sync
    core/version.gd           PKeyVersion: parse_version, compare_versions (semver, semver+build,
                              4part; digit strings, no floats)
    core/feed.gd              PKeyFeed: feed_claims, verify_feed, feed_floor, reload_feeds,
                              commit_feed (`pkey-feed+jws`), feed_content, with_feed_content
    core/release_record.gd    PKeyReleaseRecord: record_hash, release_record_claims,
                              verify_release_record (`pkey-release+jws`, hash before signature),
                              revocation_of, verify_revocation, newer_revocation; P4-26:
                              verify_release_record's `delegation` (steps 13 and 16),
                              delegation_hash_of, delegation_of, verify_delegation, covers_pack,
                              record_revoked
    core/store/               PKeyStore, PKeyFileStore (0600, temp + rename), PKeyMemoryStore
    core/transport.gd         PKeyTransport: redirects by hand, credentials dropped cross-origin
    core/discovery.gd, sync.gd, token.gd, headers.gd, errors.gd, result.gd, caps.gd, semver.gd, device_id.gd
    core/services_generated.gd  GENERATED by `pnpm gen:services` — never edit
    core/crypto/              PKeySha512 (+ streaming), PKeyEd25519 (fast, resumable job), PKeyEd25519Ref
    core/stages.gd            PKeyStages: the boot stage machine (client-core `stages.ts`), the
                              five vocabulary constants, the boot guard and boot confirmation
    services/config.gd        PKeyConfig, PolarisKey.config: precedence, secrets, the catalog,
                              edge-mint, config_changed(keys)
    services/config/          PKeyConfigResolve (client-core's rules), PKeyConfigEnv,
                              PKeyOverrideStore, PKeyConfigFileStore, PKeyConfigEntry,
                              PKeyMintResult, PKeyConfigBinding
    services/identity.gd      PKeyIdentity (PolarisKey.identity): device-code sign-in, polling,
                              the opt-in confirm-identity step and licence attach
    services/identity/        PKeySignInPrompt, PKeySignInResult
    ui/qr/                    PKeyQr (byte mode, level M, versions 1-10), PKeyQrCode, PKeyQrRect
    ui/pkey_ui_view.gd        PKeyUiView: the base of every scene (copy, focus chain, sdk)
    ui/boot/                  PKeyBoot (pkey_boot.tscn), PKeyBootHost (each stage's work and the
                              event it sends), PKeyBootResult
    ui/gate/ activation/ sign_in/ offline/ settings/ banner/ update/ badge/ dev_menu/
                              one scene each (`.tscn` + view script) with a headless controller
                              (PKeyGateController, PKeyActivationController, …)
    ui/copy/pkey_ui_copy.gd   PKeyUiCopy: every string, English defaults, through tr()
    ui/theme/pkey_theme.tres  the default Theme (written by tools/gen_theme.gd)
  tests/
    runner.gd                 PKeyTestRunner
    support/test_context.gd   PKeyTestContext: check() and info()
    support/fake_server.gd    a TCPServer on 127.0.0.1 the core and transcript tests talk to
    support/transcript_replay.gd  replays conformance/transcripts against the fake server
    support/fake_host.gd      a PKeyHostIo over fixtures/devices-captures.json (any platform)
    support/fake_boot_host.gd a scripted PKeyBootHost: PKeyBoot's stage work answered step by step
    support/fake_updater_env.gd  a recording PKeyUpdaterEnv: an install anywhere, every hand-off,
                              link and restart recorded
    updater/                  the updater suite's groups (adapters, bridges, download, swap,
                              guard, boot, grep) and their support.gd
    packs/                    the packs suite's groups (content, plan, records, pck, bake, engine,
                              state, http, boot, guard, uid, revocations, delegation), support.gd and
                              fixtures.gd (pack
                              records signed with the corpus's test release key by
                              support/test_signer.gd, a fake pack transport)
    fixtures/packs/           P4-03's PCK fixtures and lint verdicts (check/) and the kaykit v1/v2
                              update objects (update/), written by
                              packages/cli/test/godotFixtures.test.ts — never edit; that test
                              byte-compares them
    fixtures/uid_packs/       two data-pack projects (dataA, dataB; `.gdignore`d) run_tests.sh
                              exports for the f_uid case
    support/ui_snapshot.gd    structural snapshots of a scene, and the focus test's oracle
    ui/                       scenarios.gd (every pinned scene state) and snapshots/*.txt (the
                              committed fixtures; `--pkey-test ui update` rewrites them)
    suite_<name>.gd           one suite per file (core/, config/, devices/, update/ and
                              build_stamp/ hold
                              their suites' groups); suite_platform reads THIS machine's
                              fingerprint; suite_export_stamps (outside `ci`) reads the ZIP
                              exports run_tests.sh makes
    config/catalog.json       the mirror fixture; catalog_generated.gd is GENERATED from it by
                              `pnpm gen:mirrors -- --lang gdscript` (a tools test keeps it fresh)
    fixtures/                 hand-maintained captures (identifiers replaced by fake values);
                              release-urls.json holds sdk-node's URL outputs, which
                              packages/sdk-node/test/godotUrlVectors.test.ts keeps true
    corpus/v2/                GENERATED mirror of conformance/corpus/v2/ — never edit
    transcripts/              GENERATED mirror of conformance/transcripts/ — never edit
    vectors/                  hand-generated SHA-512 and Ed25519 vectors (byte-for-byte)
    qr/                       QR fixtures from a reference encoder (gen_fixtures.py; byte-for-byte)
  tools/
    run_tests.sh              the one entry point, locally and in CI
    fetch_godot.sh            CI: download and hash-check the official editor (Linux, macOS,
                              Windows) and the Linux template
    godot.sha512              upstream SHA-512 pins for those downloads
    gen_theme.gd              writes ui/theme/pkey_theme.tres (`--script`, editor only)
    ui_screenshots.gd         one PNG per pinned UI state, for review (needs a display)
```

## supports() and capabilities (`PolarisKey.supports`, P1b-10)

`PolarisKey.supports(feature)` says whether a parity feature works here, offline and without
side effects (PARITY §2.2). It returns a PKeyResult: ok with detail `{feature}`, or
`code == &"unsupported"` with detail `{feature, reason, detail}`, where `reason` is `runtime`,
`outlet`, `product`, `dependency` or `version` and `detail` says why in words. Pass a
`PKeyConstants.Feature` id:

```gdscript
var r := PolarisKey.supports(PKeyConstants.Feature.LICENSE_ENROLL)
if not r.ok:
	print(r.detail["reason"], ": ", r.detail["detail"])   # runtime: license.enroll is not available on web.
```

`core/caps.gd` (PKeyCaps) reads the capability table that `pnpm gen:constants` generates from
`parity.json` into `PKeyConstants.capabilities()`. Reasons are checked in one order: an unknown
id is `version`; a `runtime` N/A on this platform; a `planned` feature is `version`; a feature of
an opt-in service the product does not run (discovery, else `expected_services`, else licence
and config) is `product`; then any conditional N/A's detector (Godot declares none yet). A call
into an unsupported feature returns the same result (enrol on web is `PKeyActivationResult`
kind `unsupported` with that detail). A sub-client whose service is off keeps its code
`service-unavailable` and carries the `product` fields in `detail`. `PolarisKey.caps()` lists the supported feature ids in
registry order, and every device report carries it as `caps`.

## Build stamp and setup dock (P1-11)

Every export carries `res://.polaris_key/build.json` (`pkeyBuild: 1`, no timestamps, sorted keys,
so two exports of one preset are byte-identical): product, version, build, outlet, outletKind
(always written; `""` when the outlet is a custom id stamped without a kind), outletSubkind and
format (written only when set), channel, engine, engineVersion, platform, arch, packSources,
embeddedPacks, debug, sdkVersion and outletIds. The export plugin adds per-preset options, each
overridable from CI with `get_or_env`, so a headless `--export-release` stamps exactly what CI
says:

| Option                       | Environment                 | Default                                                                                                                                                        |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `polaris_key/outlet`         | `PKEY_BUILD_OUTLET`         | `direct` on the desktop, `play`, `app-store`, `web`                                                                                                            |
| `polaris_key/outlet_kind`    | `PKEY_BUILD_OUTLET_KIND`    | empty: the outlet itself when it is one of the 17 kinds. A custom outlet id (`itch-beta`) needs its kind (`itch`)                                              |
| `polaris_key/outlet_subkind` | `PKEY_BUILD_OUTLET_SUBKIND` | empty (none): `homebrew`, `npm`, `pnpm`, `npx`, `scoop`, `chocolatey`, `flatpak` or `appimage`                                                                 |
| `polaris_key/format`         | `PKEY_BUILD_FORMAT`         | empty (none): the installed build's format (`zip`, `dmg`, `exe`, ...)                                                                                          |
| `polaris_key/channel`        | `PKEY_BUILD_CHANNEL`        | `stable` (stamped canonically: `staging` as `beta`)                                                                                                            |
| `polaris_key/build_number`   | `PKEY_BUILD_NUMBER`         | `0`                                                                                                                                                            |
| `polaris_key/outlet_ids`     | `PKEY_OUTLET_IDS`           | `{}`: a JSON object of `steamAppId`, `itchGameId`, `flatpakId`, `snapName`, `caskToken`, `homebrewFormula`, `msixFamilyName`, `bundleId`, every value a string |

A custom outlet id must come with `PKEY_BUILD_OUTLET_KIND` (or the `polaris_key/outlet_kind`
option). Without it the stamp says `outletKind: ""`, the build decides as `unknown` and it is
never offered an update; the export dialog warns, and a headless export logs a `push_warning`.

```sh
PKEY_OUTLET_IDS="$(pkey distribution outlet-ids --outlet steam)" \
PKEY_BUILD_OUTLET=steam PKEY_BUILD_CHANNEL=beta PKEY_BUILD_NUMBER=42 \
  godot --headless --export-release "Linux" build/game.x86_64

PKEY_BUILD_OUTLET=itch-beta PKEY_BUILD_OUTLET_KIND=itch \
  godot --headless --export-release "Linux" build/game.x86_64
```

- The plugin never reads `.pkey/distribution` (it may be YAML, and `.pkey/` sits at the product
  repo root). `bundleId` comes from the preset (`application/bundle_identifier`,
  `package/unique_name`) and wins over the option's.
- `_get_export_features` adds `pkey_outlet_<id>` and `pkey_channel_<channel>`, `-` mapped to `_`
  (`pkey_outlet_app_store`), plus `pkey_outlet_<outletKind>` when the id is not itself a kind.
  Custom feature tags do not exist in the editor.
- An export plugin cannot fail an export: an unknown outlet, a channel outside the vocabulary, a
  non-semver `application/config/version` and a bad `outlet_ids` value are dialog warnings, and
  at export a `push_warning` (naming `PKEY_OUTLET_IDS` when the environment supplied it) that a
  headless log shows. `PolarisKey.configure()` refuses a non-semver version and a malformed
  stamped channel.
- `PolarisKey.build_info()` returns the stamp, or in the editor the fallback: the project version,
  build 0, no outlet, the editor channel from `res://polaris_key.tres`, this platform and arch.
  The core sends the stamped channel as `X-PKey-Channel` (over `default_channel`). The device
  report carries the detected outlet (`PKeyCore.reported_outlet()`: the stamp moved by run-time
  detection, see "Outlet detection" below); `PKeyCore.outlet()` is still the stamped id.
  `PKeyOptions.build_stamp_path = ""` ignores the stamp (the tests do).
- The setup dock (right dock; `add_dock` on 4.6+, `add_control_to_dock` on 4.4) edits
  `res://polaris_key.tres`: product, base URL, pinned keys pasted from `pkey trust` (its Godot
  line is `const PINNED_TRUST_KEYS := {...}`), editor channel. "Check" verifies the live trust
  manifest against the pasted pins and lists each kid with a SHA-256 fingerprint. "Fill from
  discovery" only pre-fills candidates; "Save" needs the box confirming the pins match
  `pkey trust` or the console.

## Licence notes

- `X-PKey-Channel` is always a canonical §5.1 name: `dev` for `0.0.0-dev*` builds, `pr` for PR
  builds (the Worker narrows it to the build's `pr-<n>`), `beta` for `0.0.0-beta*` and
  `0.0.0-staging*`, never `staging`. `PKeyOptions.default_channel` accepts `stable`, `beta`,
  `pr-<n>`, `dev` or a manual channel name; an alias is sent canonically and anything malformed
  is refused at `configure`.
- The 401 re-acquire re-registers (`POST /devices/register`, keyless) when License is off or the
  token came from `devices.register()` in this process; otherwise it asks `POST /license/token`.
  The token's source is held in memory only, so after a restart a licensed product's device asks
  `license/token`. One attempt per sync pass, whichever route.
- `enroll()` is unsupported on web (no machine anchor). On iOS, enrolling again after every one of
  the vendor's apps was uninstalled mints a new free licence; the client does not work around it.
- Unlocking paid digital content on iOS or Android with an externally bought key conflicts with
  App Store 3.1.1 and Play's payments policy. The client does not enforce this.

## Running the tests

```sh
sdks/godot/tools/run_tests.sh                                   # godot on PATH, the ci suites
GODOT_BIN=/path/to/godot sdks/godot/tools/run_tests.sh          # a specific editor
GODOT_TEMPLATE=/path/to/linux_release.x86_64 sdks/godot/tools/run_tests.sh   # + exported pack
PKEY_TEST_SUITES=ed25519 sdks/godot/tools/run_tests.sh bench 20 # one suite, with suite args
```

- `GODOT_BIN` defaults to `godot` on `PATH`. Without an editor the script exits 2; it never skips.
- `GODOT_TEMPLATE` is optional. When set, the project is exported with
  `--export-pack "Conformance (Linux)"`, the template is copied beside the pack as
  `build/pkey_conformance.x86_64`, and the same suites run from the pack. On macOS, a template
  binary extracted from `macos.zip` (`godot_macos_release.universal`) works the same way.
- `PKEY_TEST_SUITES` defaults to `ci`; `PKEY_TEST_TIMEOUT` is per step, default 300 s.
- The packs suite reads the content corpus from the checkout (`PKEY_CONTENT_CORPUS`, defaulting to
  `conformance/corpus/v2/content`; `content/` is not mirrored) and the f_uid data packs that
  run_tests.sh exports into `build/uid_packs/` (`PKEY_UID_PACKS`). Run directly, export both.
- Logs land in `build/logs/<step>.log` (`build/` is git-ignored).

CI (`.github/workflows/ci.yml`, job `godot`) runs two Linux legs: the 4.7.2 editor plus the
official 4.7.2 `linux_release.x86_64` template, and the 4.4.1 editor (the floor). Both must print
the same corpus SHA-256. Two editor smoke legs on `windows-latest` and `macos-14` run the
`platform` and `devices` suites, so the Windows and macOS readers find their anchor on a real
machine.

## The runner protocol

The runner is the project's main loop, so the editor and an exported template use the same
invocation. Official 4.6+ templates ignore `--path`, `--script` and `--main-pack`, so nothing may
depend on them.

```sh
godot --headless --path sdks/godot -- --pkey-test ci
build/pkey_conformance.x86_64 --headless -- --pkey-test ci
godot --headless --path sdks/godot -- --pkey-test ed25519 bench 20   # args after the list go to every suite
```

- `--pkey-test <suite>[,<suite>]` selects suites; `ci` expands to the CI set (`SETS` in
  `tests/runner.gd`). Without `--pkey-test` the project is a plain `SceneTree`.
- Output: one `PKEY-TEST engine=… build=… target=editor|template …` header, then
  `PASS|FAIL <suite> <name>` and `INFO` lines, then `PKEY-TEST SUMMARY suites=N checks=N failed=N`.
  The exit code is 1 on any failure.
- A suite is `tests/suite_<name>.gd`, `extends RefCounted`, with
  `func run(t: PKeyTestContext, args: PackedStringArray) -> bool`. It may `await`. It fails if it
  does not load, returns anything but `true`, or reports zero checks. A new work package adds its
  suite to `SETS["ci"]`; `run_tests.sh` and CI stay the only entry points.

**Suites never use `assert` and never rely on a runtime error.** A release template skips GDScript
runtime checks: a method call on null, a missing key or index read (which returns null) and
`assert(false)` all continue silently, where the editor aborts the function. Report only through
`t.check(name, ok, detail)` and `t.info(text)`, and end every suite with a coverage check (vectors
evaluated equals vectors loaded, with a floor). Timing is `INFO`, never a check.

## The corpus mirror

`tests/corpus/v2/` is written by `pnpm gen:corpus` (`tools/sign-corpus.ts`, `CORPUS_TARGETS`) and
guarded by `pnpm gen:corpus -- --check`, exactly like the Swift mirror. **Never edit it**: change
the generator and regenerate. A JSON file there that the generator does not write fails the gate.
An exported pack can read only `res://`, which is why the mirror exists.

`PKeyJson` (the strict pre-validation every signed payload passes through) decodes the escape
`\u0000` as U+FFFD on every engine (WIRE-CONTRACT-V3 §10), and the conformance suite compares
those strings against the generator's `expect.docNulReplaced`.

## Writing GDScript here

- **4.4 syntax is the floor.** Typed dictionaries are fine; `@abstract` and variadic arguments are
  not. Do not add `config/features` to `project.godot`, which would pin the project to one engine.
- **Scripts the editor runs are `@tool`.** In the editor a non-tool script's static variables
  and `_static_init` never run (a `static var` reads null) and a loaded non-tool Resource is a
  placeholder whose methods fail. The export plugin and the dock reach `PKeyChannel`,
  `PKeySemver`, `PKeyJson`, `PKeyB64Url`, `PKeyTransport`, `PKeyJws`, `PKeyEd25519` and
  `PKeyOptions`, so those carry `@tool`; a new static-state script on that path needs it too.
- **Thread-reachable code never indexes or iterates a `const` Array.** On 4.4.1 a read-only
  Array hands each element out through one shared slot, so two threads reading the same constant
  get each other's values (a two-thread loop over a 16-element constant: about 1 read in 40,000
  wrong; 4.7.2: none). It made offloaded document verifies fail about one time in 70 (the
  scalar reduction reads the constant `L`), which surfaced as a flaky `ci` set on the 4.4 floor.
  Convert first (`PackedInt64Array(L)`, `PackedStringArray(PATHS)`): the conversion is safe.
  The `ed25519` suite runs the crypto on two threads to keep it that way.
- **Commit every `.uid` with its script.** The first import writes it; `run_tests.sh` fails on an
  untracked one.
- **Never reformat the crypto files.** A negative shift in a constant expression is a parse error in
  debug builds.
- Godot's own JSON parser is lenient (trailing commas, leading zeros, raw control characters, the
  last duplicate key wins) and turns every number into a float. Signed bytes go through
  `PKeyJson`, never `JSON.parse_string`; integer claims are `v == floor(v)`, never `TYPE_INT`.
- `HTTPRequest` forwards `Authorization` across hosts on a redirect. Use `PKeyTransport` (or
  `PolarisKey.core.request`), which follows redirects itself and drops the bearer once the origin
  changes.

## Measured pitfalls

| Behaviour                             | 4.7.2                                                                      | 4.4.1                                                        | Consequence                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `--import` with a parse error         | exit 0, prints nothing                                                     | exit 0, prints the error                                     | watch the log; never `\|\| true`                                            |
| runner fails to load                  | macOS: modal alert, the run hangs; Linux: exit 1 (`Invalid MainLoop`)      | macOS: SIGABRT, exit 134; Linux: exit 1 (`Invalid MainLoop`) | watchdog and timeout                                                        |
| runtime error in a suite              | editor aborts it; template continues silently                              | editor aborts it                                             | explicit and coverage checks                                                |
| `\u0000` in JSON                      | U+FFFD, plus a "Unicode parsing error" line                                | dropped                                                      | the §10 rule in `PKeyJson`                                                  |
| `--export-pack`                       | works with no templates installed                                          | same                                                         | CI needs only the template binary                                           |
| redirect with `max_redirects = 0`     | `RESULT_REDIRECT_LIMIT_REACHED`                                            | 303 and 307 come back as `RESULT_SUCCESS`                    | follow any 3xx with a `Location`                                            |
| lone surrogate `\ud800` in JSON       | rejected                                                                   | rejected                                                     | JS accepts it: divergence for P3-02                                         |
| slim container without fontconfig     | `ERROR: Unable to load fontconfig` on every run                            | same                                                         | the watchdog ignores generic errors                                         |
| non-tool script in the editor         | static vars and `_static_init` skipped; a loaded Resource is a placeholder | not measured (the `@tool` fix is green there)                | `@tool` on what the export plugin and dock reach                            |
| two threads reading one `const` Array | correct                                                                    | wrong values now and then (shared read slot)                 | convert to a packed array first; never index a constant off the main thread |
| `HTTPRequest.timeout`                 | a Timer on process delta: a long frame before the request spends it        | same                                                         | `PKeyTransport` times out on the wall clock, one budget per request         |
| `--export-pack`'s `uid_cache.bin`     | names only the files it exports                                            | names the whole project's UIDs, excluded files included      | a 4.4 data pack must not share a UID with the main project (packs suite)    |
| `PACK_FILE_DELTA` (GDDL) entries      | decoded by the engine on read                                              | absent (pack format v2)                                      | `zstd-patch-from` advertised on 4.6+ only (`PATCH_FROM_ENGINES`)            |

So every `run_tests.sh` step fails on `SCRIPT ERROR`, `Parse Error`, `Failed to load script`,
`Cannot get class` or `Invalid MainLoop` in its log, on its timeout, on a non-zero exit, and (for
runs) without a final `PKEY-TEST SUMMARY … failed=0`.

## Update and release (`PolarisKey.update`, `PolarisKey.release`)

```gdscript
# res://polaris_key.tres: pinned_release_keys = {kid: raw Ed25519 key, base64url}; and, when the
# stamp's outlet is not the whole story, update_outlet (a kind), update_outlet_id,
# update_outlet_subkind, update_methods (default ["download"]), update_format.
PolarisKey.update.update_available.connect(_on_update)   # something to show the player
var check := await PolarisKey.update.decide()            # or decide("beta"); a PKeyUpdateCheck
if check.ok:
    match check.decision["action"]:
        "binary", "store", "platform", "code-ready", "blocked": $PKeyUpdatePrompt.show_result(check)
        "none": pass                                     # check.decision["reason"] says why
var notes := await PolarisKey.release.changelog()        # notes.entries: Array[PKeyChangelogEntry]
```

**The decision (wire v4, P3-08).** `decide(channel, staged, skip_version)` runs plans/P3-01.md
§2.5 in the same order as every SDK: it reads `update.endpoints.feed` and
`release.endpoints.record` from discovery (running `discover()` first when this session has not),
fetches `GET …/update/{channel}/feed.jws?platform=` with the REQUESTED channel name, verifies the
feed against the effective product trust set (`pkey-feed+jws`, PKeyFeed), binds its `channel`
claim to the request, checks the selector and freshness at the effective clock
`max(system, highWaterMark)` and the `seq` floor of that canonical channel, commits it, then
fetches the record the target for this platform pins and verifies it hash first, against
`pinned_release_keys` only (`pkey-release+jws`, PKeyReleaseRecord), and ends in the pure
`PKeyDecision.decide_update`.

- **The answer** is a `PKeyUpdateCheck`: `channel` (the canonical one the feed claims; `latest`
  answers as `stable`; record THIS as a staged update's channel), `decision` (a Dictionary with
  `update-matrix.json`'s members), `feed` (`network` | `committed`), `record` (`network` |
  `cache` | `none`), `errors` ({code, detail}: what went wrong on the way), `boot` (`none` |
  `optional` | `required`: floors never stop play; only a CI-signed revocation of a REQUIRED pack
  gives `required`, plans/P4-13.md decision 4, which amends P3-01 decision 1) and
  `undismissable` (a mandatory offer or any `blocked`: a prompt the player cannot dismiss over a
  game that keeps running).
- **The content decision** (plans/P4-13.md §2.5, §2.6; P4-24). With a content stamp, `decide()`
  hands the flow `packs.content_input()` (the stamp and its holds, the running set with embedded
  baselines, the variant preferences and the stored revocations) and runs steps 10–14: the
  feed's content members (`PKeyFeed.feed_content`, parsed beside the claims: a malformed member
  is null and never refuses the feed), the relevant revocations (targets among the active
  releases, the stamp's pins and holds and the selected feed targets; at most 64 fetched per
  check, verified against `pinned_release_keys` only, `PKeyReleaseRecord.verify_revocation`, the
  newest `issuedAt` winning, `newer_revocation`), their replacements (verified as pack records
  with a variant for this host; an unfetched one is not yet usable), and the gate buckets. Row
  selection matches the engine exactly (`installed.engine`, "" for a build that declared none;
  no fallback). The answer may then be `packs` (`install`, `revoke`, `set`; applied by the boot's
  FETCH and BACKGROUND, boot `none`), a `binary` with `prestage` (the next content level's
  required and essential packs), an offer made mandatory by a `contentBlock`, `blocked
{content-floor}` (boot `optional`: a locked banner, the game keeps running) or `blocked
{revoked-content}` (boot `required`). A build without a stamp decides exactly as before. `feed_doc` and
  `record_doc` are the verified documents P3-10's adapters act on.
- **After a refusal** it decides from the committed feed (the canonical channel the Worker named,
  else the requested name, else its alias target); a stale committed feed answers
  `none {stale}`. It fails only with nothing to decide from (`feed-rejected` with its step,
  `feed-rollback`, or the transport's or Worker's code), and before dialling with
  `not-configured` (no `configure()`, or empty `pinned_release_keys`) or `service-unavailable`
  (Update off, or a Worker without the signed feed: fall back to `check()`).
- **Inputs** come from `PolarisKey.build_info()` (the stamp's version, build, platform, arch,
  engine and, when stamped, format; the project's settings without a stamp), the outlet from
  `PKeyDecision.resolve_update_outlet` (`update_outlet` wins, else the stamp's outlet, else
  `unknown`, which is never offered anything), `update_methods`, and the device id as the
  rollout bucket's install id. `configure()` refuses (`invalid-options`) a release key that is
  also a trust pin (compared as raw bytes), an outlet outside the 17 kinds, an id outside
  `^[a-z][a-z0-9-]{0,63}$`, an unknown subkind or method.
- **The cache.** `managed.json` gains `feeds` (keyed by each feed's own `channel` claim) and
  `releaseRecords` (keyed by SHA-256), signed artifacts only, written atomically with the rest
  of the record. On load each feed is re-verified (no freshness, its claim equal to its key)
  and each record re-verified and kept only while a surviving feed pins it; the floors are
  derived from what survived and never stored. A bundle import keeps both slices.
- **Off the first frame.** Every Ed25519 verify in `decide()` and in the cache load runs on a
  `WorkerThreadPool` task where the build has threads and in frame slices where it has none. A
  feed plus a record is about 10 ms on a desktop release template (the conformance suite logs
  the timing on every run).
- `update_available(result)` fires for a decision worth showing (`boot == "optional"`, or the
  revoked-content hard stop, `boot == "required"`), and for the v3 `check()` when this build is
  behind; test `result is PKeyUpdateCheck`. `last_available`
  holds the answer it last carried (null once a later answer has nothing to show), which a
  `PKeyUpdatePrompt` added later replays.
- `feed(channel)` runs steps 1–9 alone (a `PKeyUpdateFeed`) and `release_record(sha256)` one
  record by hash (a `PKeyReleaseRecordResult`; cross-checked and kept only when a committed feed
  pins it).
- **Outlet detection** (P3-11). With `PKeyOptions.update_outlet` empty and `update_detect` on
  (the default), `PolarisKey.update.outlet()` (`PKeyCore.update_outlet()`) resolves the stamp
  moved by run-time evidence, and `PolarisKey.update.detected()` (`PKeyCore.detected_outlet()`)
  returns the detection result, or null when the host names the outlet:
  `PKeyOutletSignals` reads `/.flatpak-info`, `SNAP_*`, `APPIMAGE`/`APPDIR`, the product's Steam
  `appmanifest_<steamAppId>.acf` and `SteamAppId`, the itch receipt, the macOS receipt,
  `ProductionSandbox` and the Mach-O signing leaf, the product's Caskroom link, the Windows
  WinGet/Scoop/Chocolatey paths, Android's `getInstallSourceInfo` with the initiator's
  certificate digest (pure GDScript through `JavaClassWrapper`, no plugin) and a web export's
  display mode; `PKeyOutlet.detect_outlet` maps them, with the stamp, exactly as every SDK does
  (`outlet-matrix.json`). The iOS `AppDistributor` and Windows package-identity readers are hooks
  on `PKeyOutletEnv` that answer "unavailable" until P5-05 and a Windows native reader land. A
  build without `build.json` falls back to its `pkey_outlet_<kind>` feature tag; a web export
  synthesises `outletKind: web`. The device report carries the detected outlet id
  (`PKeyCore.reported_outlet()`), never a raw signal.
- Acting on the decision is P3-10's (next section); packs are P4-08's ("Packs").

**The v3 check (P1-08).** `check()` is today's check, the same as sdk-node's and Python's:
`GET /<p>/update/version`, informational on every outlet; a Steam, itch or store build must not
act on it by itself.

- `update_available` compares `PKeyOptions.version` (the game's, never the SDK's) with
  PKeySemver, the gate's own semver, so a pre-release sorts below its release.
- `check("")` sends no `?channel=`. Any other value must be a channel name: an alias goes out
  canonically (`staging` as `beta`, `latest` as `stable`), `pr<n>` as `pr-<n>`, and a malformed
  one (`1.2.3`) is refused as `invalid-options` without a request. `appcast_url` follows the same
  rule and returns "" for a malformed channel.
- A 403 keeps the body's code (`channel_not_allowed`; `forbidden` when it names none); any other
  status is `not_found`; a check that got no answer keeps the transport's code. The changelog maps
  a 401 or 403 by its body's code in either spelling (`download_auth_required` stays itself). The
  bearer is forwarded only when one is held.
- With the service off (discovery this session, else `expected_services`), `check` and
  `changelog` answer `service-unavailable` without a request, and `install_url`, `download_url`
  and `appcast_url` return "". `update` and `release` exist before `configure()`, so a signal
  connected early survives it.
- There is no throttle: the caller decides when to check (P1-10's DECIDE stage checks once per
  boot). A periodic caller must not let a failed check consume its interval.
- `download_url` only builds the URL. Fetching it needs the transport's credential-safe redirects
  and no gzip (gzip breaks `Range`); that is P3-10's.

## Updates by outlet (P3-10)

```gdscript
PolarisKey.update.update_available.connect(func(r):
	if r is PKeyUpdateCheck: $PKeyUpdatePrompt.show_result(r))   # PKeyBoot does this itself
var applied := await PolarisKey.update.apply(check)    # what the prompt's button does
await PolarisKey.update.restart_to_update()            # code-ready: "Restart now"
PolarisKey.update.confirm_boot()                       # optional: the game is clearly running
```

The decision says what is on offer; the install's OUTLET says what can be done about it
(`PolarisKey.update.outlet()`, the stamp moved by detection). Each of the 17 outlet kinds has an
adapter in `distribution/outlets/` (`PKeyOutletAdapter`: `id()`, `capabilities()`,
`describe(decision, ctx)`, `apply(decision, host, check)`), and capabilities only narrow: the
compiled defaults are the ceiling and a feed entry can lower them, so a store, Steam or itch build
is never talked into self-updating code.

| Outlet                                                        | `store`                                                                                                                      | `platform`                            | `binary`            | `code-ready`  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------- | ------------- |
| App Store, Play, Play testing, Microsoft Store                | opens the https `listingUrl` (a `market://`, `itms-apps://` or `ms-windows-store://` link is never opened), else the page    | —                                     | —                   | —             |
| TestFlight                                                    | opens the TestFlight link                                                                                                    | —                                     | —                   | —             |
| AltStore, AltStore PAL, Obtainium, F-Droid repo, iOS `direct` | the feed has no listing: opens `PKeyOptions.update_page_url` (the source, repository or web-distribution page), else nothing | —                                     | —                   | —             |
| Steam, itch, Flathub, Snap, App Installer, winget             | —                                                                                                                            | silent, with the outlet's own message | —                   | —             |
| Web                                                           | —                                                                                                                            | "Reload"                              | —                   | —             |
| Direct (desktop, Android)                                     | —                                                                                                                            | package-managed: silent               | per `method`, below | "Restart now" |
| unknown                                                       | never offered anything                                                                                                       |                                       |                     |               |

`binary` on a direct build dispatches on `method`:

- **`native`**: the platform's native updater through its bridge (`PKeyNativeBridge`:
  `is_available()`, `check_now()`, `install_and_relaunch()`, with the feed URL from discovery):
  Sparkle on macOS (the appcast), Velopack on a Velopack install or with its plugin, else
  WinSparkle, on Windows (`update.endpoints.velopack` up to `releases.`, `…/winsparkle.xml`), and
  AppImageUpdate in an AppImage, else Velopack, on Linux. Each bridge calls, in order, a `native`
  object a test injects, an Engine singleton (`PolarisKeySparkle`, `PolarisKeyVelopack`,
  `PolarisKeyWinSparkle`, `PolarisKeyStoreContext`) a game registers itself, or P5-07's facade
  (see "Native desktop plugins" below). With no plugin every call is the typed unsupported result
  (`unsupported`, `detail.reason` `dependency`, or `runtime` on the wrong OS), `native` is not
  offered to the decision, and an adapter given `native` anyway opens the download link: a missing
  plugin never breaks boot. AppImage needs no plugin: with `APPIMAGE` set and `appimageupdatetool`
  on PATH it runs `appimageupdatetool -O $APPIMAGE` on a worker thread and relaunches `$APPIMAGE`
  (not the mounted executable).
- **`download`**: the build's URL from discovery's `distribution.endpoints.builds` (else
  `release.endpoints.builds`; never the R2-only `blobs`), `{selector}` = the record's version and
  `{buildId}` = the decision's build, percent-encoded; else `PKeyOptions.update_release_url`.
- **`sidecar-pck`**: `PKeySidecarSwap` downloads the record's `pck` build from that URL in the
  background (`auto_stage`; `PKeyDownload`: Range resume, gzip off, the bearer dropped across
  origins, one wall-clock deadline per request, the record's size as a cap), verifies size and
  SHA-256 against the verified record, and stages it with its meta (`channel` = the
  `PKeyUpdateCheck.channel` it was staged under, the canonical one). `update_staged(version)`
  fires and decide() runs again, so the answer becomes `code-ready`. A size or hash mismatch is
  `payload-mismatch` and stages nothing.

Every link is https only (`OS.shell_open` would hand anything else to a local handler).

**Methods.** `PKeyOptions.update_methods` (default `["download"]`) is what the game allows; add
`native` and `sidecar-pck` to opt in. While the updater is active the decision gets that list
narrowed to what this install can do: `native` only with a usable bridge, `sidecar-pck` only
where the swap is supported.

**The sidecar-PCK swap** (no `--main-pack`, `--path`, `--scene` or `-s` anywhere: official 4.6+
templates ignore them, and a test greps the addon). Godot loads `<exe-name>.pck` beside the
executable before any script runs, so `restart_to_update()` (and the guard, for a pack staged
earlier) re-verifies the staged pack, copies the running pack into `previous`, copies the new one
beside the target (`<pck>.pkey-new`), READS IT BACK from disk and verifies its size and SHA-256
(so a full disk or an I/O error that truncated the copy is removed and the live pack never
touched; the copy of the running pack into `previous` is read back the same way, and the rollback
path uses the same check), journals the swap in `state.json`, renames
it over the pack and restarts at once (`OS.set_restart_on_exit` with this process's own arguments):
the running process still holds the old pack's directory, so it must not load anything more. The
rename is atomic on POSIX; on Windows Godot removes the target and moves the new file in (two
calls). A crash between journal and bookkeeping is finished or discarded at the next launch by
comparing the pack with the journal. Before downloading and before each copy the free space is
checked (`DirAccess.get_space_left()`; unknown counts as enough). A short write or a full volume
does not restart the game; only a pack Windows holds open defers to the next launch. The swap is refused (`swap-refused`, `detail.reason`) on a
platform other than Windows and Linux (and macOS outside an `.app`), inside a macOS `.app`, under
`Program Files`, under MSIX (a `WindowsApps` path segment, any case, either separator), in Flatpak,
Snap and AppImage installs, in a Velopack install (`sq.version` beside the executable, or
`current/` beside `Update.exe`: an update replaces the whole directory), with an embedded pack, and
where the directory is not writable.

**Windows rename: not measured yet.** No Windows host was available to P3-10 (S-05 §4.4 has the
same gap). If Windows refuses to rename the open pack, the rename is retried 12 times 250 ms apart;
then the staged pack is kept, the game restarts anyway, and the next launch's guard applies it and
restarts once more (the "second restart" fallback; no detached helper). Godot opens the pack per
resource read rather than holding it, so the rename is expected to succeed when nothing streams
from it [I]. D-01 or a Windows CI runner records the measurement.

**Slots and the boot guard** (`updater/slots.gd`, `updater/boot_guard.gd`; notes/A4 §1.5, P9–P11).
`user://pkey/<product>/updates/` holds `staged/` (`payload.pck` + `meta.json`), `current/meta.json`
(its bytes are the pack beside the executable), `previous/` (the pack the last swap replaced: the
shipped one after the first swap) and `state.json` (`failedBoots`, `skipVersion`, `binaryVersion`,
`confirmedVersion`, the journal, local events). A meta is {version, channel, buildNumber, build,
recordHash, sha256, size, engine, scheme}. PKeyBoot's GUARD runs `PKeyBootGuard.run`:

- a `current` slot whose version is not the running stamp's, or whose size is not the pack's,
  means the install was replaced from outside: the slots forget it;
- staged code is dropped when it is incomplete, built for another engine, not newer than the binary
  (A4 P10), or no longer verifies; a channel switch drops it where it happens (the decision's
  `discardStaged`, and `PKeyDevMenuSection`'s picker, which shows "locked by <outlet>" where the
  outlet, its subkind or the committed feed's entry says `channelSwitch: false`);
- then `PKeyStages.boot_guard_action(staged, failedBoots)`: `roll-back` puts `previous` back,
  records the bad version as `skipVersion` (a decision input, so `code-ready` and `sidecar-pck`
  never offer it again) and restarts; `apply-staged` swaps and restarts; `none` counts the launch
  while an applied update runs. The launch after a swap or rollback sends `guard.done applied` or
  `rolled-back` (which emits `boot_rolled_back`). Two crashed launches roll back on the third.
- **Confirmation** (stage matrix v2): PKeyBoot reports each outcome to `PolarisKey.update`.
  `waiting`, `blocked` and `offline` confirm at once (quitting at the activation screen never rolls
  back a good update), `ready` after `BOOT_OK_SECONDS` (10) with the process alive or at
  `confirm_boot()`, and `running` and `error` never. A confirmed launch resets `failedBoots`.
- While a code pack runs, the decision's `installed.binaryVersion` is the binary's
  (`binaryVersion`); `installed.version` is the running pack's own stamp.
- **Telemetry** (P6-03). `update_downloaded`, `update_applied`, `update_confirmed` and
  `boot_rolled_back` ride on the device report's `updates` key (at most 16 per report) in the
  Worker's `boundedUpdates` shape: `eventId` (random, unique), `event`, `deliverable` (`app`),
  `release` (the record's tag, else its version), `fromRelease`, `outlet`
  (`PKeyCore.reported_outlet()`), `channel` (the canonical channel it was staged under), `at` and
  `code` (`failed-boots` on a rollback). `state.json`'s `events` is the queue (the last 64): an
  event leaves it once a report carrying it was accepted, and the Worker counts a resent one once.
- **MSIX.** `user://` is virtualised to `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`, kept across
  package updates and deleted on uninstall, so uninstalling removes the slots (S-05 §4.4, from
  Microsoft's documentation). The swap itself is refused under MSIX.
- **Velopack** builds ship P5-07's launcher shim as `--mainExe`, which answers the `--veloapp-*`
  hooks in milliseconds without starting the engine. Godot as the main executable also survives
  the hooks (1.0–1.7 s each when an autoload quits from `_init`) but opens its renderer and window
  for every hook: a documented fallback only (S-05 §4.5).

**Native desktop plugins** (P5-07; `addons/polaris_key/native/`, sources in `native/`, docs page
`/docs/services/update/godot-desktop/`). Four GDScript facades over optional GDExtensions, each
answering `unsupported` (`runtime` on the wrong OS or in an install the updater cannot serve,
`dependency` without the GDExtension or the library it loads):

- `PKeySparkle` (macOS): `PKeySparkleNative` drives `SPUStandardUpdaterController` on the main
  thread with discovery's appcast, the bearer in `httpHeaders` and the build's channel. It refuses
  to start without `SUPublicEDKey` in the bundle (`invalid-options`), off the main thread, and
  without `Sparkle.framework` (weak-linked). It never verifies an update itself. With a tree that
  does not auto-accept quitting, it quits on `will_relaunch`.
- `PKeyVelopack` (Windows): an UpdateManager over the feed directory with the headers; check and
  download on a worker thread (`progress` events), then apply on exit with a restart, and quit.
  Outside a Velopack install (no `Update.exe` above, no `sq.version` beside) it answers `runtime`.
  Public delivery only for now: the Worker's package route is a cross-origin 302, which drops
  `Authorization` (S-11 §5.2), so under `licensed` or `entitled` delivery a 401 or 403 download
  answers `unsupported` (`product`).
- `PKeyWinSparkle` (Windows): the appcast, `PKeyOptions.update_eddsa_public_key` (refused when
  empty), the `PolarisKey`/`<product>` registry identity and the headers; `shutdown_request` quits.
- `PKeyStoreContext` (Windows): package identity first; then the Store calls on an MTA thread after
  IInitializeWithWindow with the game window. No identity, or `0x803F6101`, `0x803F6107`,
  `0x80070002`, is `runtime` ("not a Store install"). `PKeyMsStoreAdapter` hooks it for a `store`
  answer in a Store MSIX (`ctx.store_bridge_available`) and falls back to the listing.

The updater configures every bridge with `download_headers` (read when the updater runs), the
build's channel, and WinSparkle's key and identity. The export plugin's macOS options
`polaris_key/sparkle/{enabled, public_ed_key, feed_url, automatic_checks}` (env `PKEY_SPARKLE`,
`PKEY_SPARKLE_PUBLIC_KEY`, `PKEY_SPARKLE_FEED_URL`) write `SUPublicEDKey`, `SUFeedURL` and
`SUEnableAutomaticChecks` into `Info.plist`, turn on Disable Library Validation, turn a Disabled
`codesign/codesign` into the built-in ad-hoc signature, and restore the executable bit on Sparkle's
helpers after a `.app` export. The Windows `.gdextension` ships `velopack_libc.dll`,
`WinSparkle.dll` and the Velopack shim beside the executable. The export plugin removes them
again from a Microsoft Store export (outlet kind `ms-store`): an `.exe` export loses only the files
it wrote, a `.zip` is rewritten, and a `.pck` carries none. A Mac App Store preset never gets the
Sparkle switches, and its export logs an error while the bridge is installed. The Sparkle bridge's
headless mode is test-only and needs `PKEY_SPARKLE_HEADLESS=1`. Velopack and WinSparkle feeds must
be https (http on loopback only). A facade's `last_result` carries the typed reason a bridge
reports. The `native_desktop` suite covers the facades over stand-in natives and the wiring; the
`native-desktop` CI workflow runs the real updates end to end (`native/e2e/`).

**Inert** in the editor, in headless runs (the test runner, a dedicated server) and in debug
builds, as Diceroll's updater is: nothing is downloaded, swapped, restarted or counted, and the
decision gets the declared methods unchanged. A link the player presses (a store listing, a source
page, a download URL) still opens while the updater is inert; only downloads, swaps, restarts, the
counting and native hand-offs wait for an active updater. `PolarisKey.update.updater.enabled = true`
turns it on (the tests do, with `PKeyFakeUpdaterEnv`).

**Tests** (`updater` suite): every outlet kind × every action through `apply()` with a recording
host; the bridges with and without their native side; `PKeyDownload` against the fake server; the
swap's refusals, a verified stage and swap, mismatches that change nothing, a locked rename, crash
recovery; the guard over successive launches with stage-matrix.json's guard and confirm cases;
PKeyBoot's GUARD and DECIDE with the real host. About 5 s on an M-series Mac, editor and release
template alike.

## Packs (`PolarisKey.update.packs`, P4-08)

```gdscript
# res://pkey_packs/pkey-content.json: the content stamp CI writes before the export (P4-03); a
# build without one has no packs. Embedded baselines sit beside it with their markers.
var boot := await PolarisKey.boot()            # FETCH, MOUNT and BACKGROUND drive packs
PolarisKey.update.packs.pack_ready.connect(func(id): print(id, " is usable"))
var r := await PolarisKey.update.packs.ensure(["diceroll.core3d"])   # outside PKeyBoot
await PolarisKey.update.packs.mount()          # this boot's godot.pck packs (PKeyBoot does it)
var dir := PolarisKey.update.packs.path("diceroll.l10n")             # a running files.tree
if not PolarisKey.update.packs.is_available("foe.goblin"):           # save compatibility (P4-20)
	var p = await PolarisKey.update.packs.pack_for("foe.goblin")     # {packId, release} or null
```

**Save compatibility** (P4-20, `packs/provides.gd`, PKeyPackProvides): a pack record may carry
`provides`, a list of opaque content ids (printable ASCII without the space, 1–128 characters, at
most 4096, unique; an unusable list provides nothing and never fails the record).
`is_available(content_id)` is true when a pack in the running set (mounted or active in this
process, embedded baselines included) provides the id and the licence holds its `entitlement` (no
License service hides nothing); false before packs start. `pack_for(content_id, targets = null)`
is a coroutine naming the first target, in order, that provides the id: `targets` is a packs
decision's install list (`[{pack, release: {sha256, seq, version}}]`), else the stamp's pins. It
reads only records: an install's verified record, else the record fetched by hash and verified as
`ensure` verifies it; a target that cannot be fetched or verified is skipped.

`PKeyPacks` is client-core's PackEngine (`packs/engine.gd`, PKeyPackEngine) with the Godot ports.
Every verdict of the pack core is client-core's: the packs suite runs every content case
(`PKEY_CONTENT_CORPUS`, the checkout's `conformance/corpus/v2/content`), every plan-matrix row,
variant and target case, and every pack-record and marker case on the editor and the release
template.

**Setup.** The content stamp is `res://pkey_packs/pkey-content.json` (`stamp_path`); without it
`ensure` answers `not-configured` and the boot has nothing to fetch. Embedded baselines live in
the same directory (`embedded_dir`): a single-file payload `X` with its marker `X.pkey.json`
beside it, or a tree `D/` with `D/.pkey/pack.json`. Each marker is verified once per process
(steps 12–14 against `pinned_release_keys`, the bytes matched, the stamp's pin checked) and the
baseline then counts as installed and as a delta base. An export preset must ship them: add
`pkey_packs/*` to "Filters to export non-resource files". `pinned_release_keys` must be set (pack
records verify against them only), and Release must be on (`service-unavailable` otherwise).
`axes` overrides the variant preferences (default: the texture families `OS.has_feature` reports,
`astc`, `bptc`, `s3tc`, `etc2`, `etc`, in that order, and the TranslationServer locale);
`mem_budget` bounds one delta frame (256 MiB); `root` is the store (`user://pkey`).

**Storage** (`PKeyPackStorage`): `user://pkey/staging/<planId>/` (objects, the output, a bake
journal), `user://pkey/store/<sha256>.pck` (a committed `godot.pck`, never overwritten, its index
beside it as `<sha256>.files.json`), `user://pkey/trees/<sha256>/` (a committed `files.tree`,
hot: the state's pointer swaps to it), `user://pkey/content/state.json`. Every FileAccess and
DirAccess error is checked and never read as "missing" (only ERR_FILE_NOT_FOUND is); every write
checks `store_buffer` and `get_error()`, and a file is read back from disk and compared before it
is renamed. Whole-pack hashes, the directory check and rebuilds that touch no engine state run on a
WorkerThreadPool task.

**The install state** is P4-06's, hardened the same way: a torn `state.json` is held aside as
`state.json.torn` with garbage collection held (its snapshot of the store saved as
`state.json.torn.list` and reused by later loads) until `recover_state()`; an unreadable state
refuses every write path with `pack-state-unreadable`; an install whose payload check raises stays
in the document, out of use and out of GC (active and previous alike), a fresh commit carries such
an active over as `previous` and a rollback re-verifies it; a listing that fails never drives GC.

**`godot.pck`** (`PKeyGodotPckHandler`, a container, `restart`): strategies `delta` (a whole-
payload `--patch-from` or a `files` set of per-entry frames), `chunk` (from seeds, below), `file`
(gaps plus blobs; a pack installed without a kept index derives its files from its own PCK
directory, once) and `full`.
Before a rebuilt pack is committed its whole-pack SHA-256 already equals the record's; then the
header (PCK v2–v4, no encryption, no sparse bundle; the engine at most the running one and inside
`requires.engine`: `pck-engine-mismatch`) and **the directory check** (S-05 §5 (f), the admission
list P4-03's publish lint applies, over the record's `handler.prefixes`: in-prefix entries and
their `.remap`/`.import`, the `.godot/exported/` and `.godot/imported/` files those name,
`.godot/uid_cache.bin` naming only the pack's own files; refused with its path,
`pck-directory-refused`: `project.binary`, the class cache, scripts and a `.remap` to one, native
libraries and `.gdextension`, out-of-prefix paths, orphaned exported files, a `.remap`/`.import`
target outside the pack, a uid cache entry outside the pack (a 4.4/4.5 exporter writes the whole
project's), and resources that embed GDScript or CSharpScript or cannot be inspected). Paths must
already be normal: the reader refuses a `..`, `.` or empty segment, a trailing `/` and a duplicate,
because Godot simplifies a path at mount. Resources are judged by **content**, not extension, with fail-closed rules that do not depend
on parser details: an `RSRC` entry is refused if a script marker (`GDScript`, `CSharpScript`,
`ScriptExtension`, `script/source`, `source_code`, plus every class this engine says inherits
`Script`) occurs anywhere in its bytes; a text resource (a `.tres`/`.tscn`/`.escn` name or a
`[gd_scene`/`[gd_resource` head) also for a NUL, invalid UTF-8 or a `\u` escape, and for a
marker found again once every backslash is removed (an unknown escape keeps its character);
an `RSCC` (compressed, the scene importer's `.scn`) under any name is decompressed with
`PKeyPck.rscc_body` (zstd only, at most `RSCC_MAX_TOTAL` = 64 MiB per entry and
`RSCC_PACK_BUDGET` = 512 MiB per pack, every block one single-segment zstd frame of exactly its
declared size with no zstd block above 128 KiB, the closing magic last) and its body gets the binary rule; anything
else about it is refused. An in-prefix `.remap`/`.import` is refused for a NUL or other control byte,
a backslash, invalid UTF-8, a byte-order mark, or a line with a `path` key anywhere in it that is
not exactly `path[.<x>] = "<plain literal>"`. Besides `.gd`/`.gdc`/`.cs`, the
device refuses every extension a loader claims for `Script` (`PKeyPck.refresh_script_kinds`, run by
`warm()`); the CLI takes `scriptExtensions`/`scriptTypes` (`pkey release publish
--script-extensions/--script-types`, the Action's `script-extensions`/`script-types`) for another
script language. Every admitted resource's references outside the pack are checked too (P4-28,
`PKeyPck.refs_problem`): a text `[ext_resource]` or binary external entry naming an app script (a
script extension, or the type `Script` or a script class) is refused unless
`PKeyOptions.pack_attachable` lists it (a `res://` path, or under a listed `res://…/`
directory; an app resource without a script extension is judged by its real type, read from its
file, whatever the reference's `type` hint says), and a `uid://` the pack's own uid cache does not
register is judged by the path the app's `ResourceUID` maps it to, or refused unless listed when
the app does not register it (the CLI cannot resolve app UIDs, so it refuses every unlisted one);
a sub-resource setting `resource_path` (which would enter the resource cache under an app path)
and overlapping internal-resource offsets are refused;
a reference the check cannot read the way the engine would (an `ext_resource` line that is not
one strict tag, an inline `Resource("…")`, a relative or non-normal path, a `.remap`/`.import`
path, a non-canonical UID, a big-endian or format-7+ binary, a non-`local://` sub-resource path,
the pre-4.0 inline external reference, an unknown value type) is refused. The default, an empty
list, attaches nothing; `configure` refuses a malformed entry (`invalid-options`). Mirror the
list in `.pkey/release` as `deliverables.app.content.attachable` so CI refuses the same packs. A
`files.tree` output's files get the same content scan (not the reference check: a tree is never
mounted into `res://`). The device check is held to the CLI's verdicts line for line
over P4-03's fixture PCKs. Packs are data-only on every build (S-07 row 13; `downloadedScripts` is
not in v1; docs/security/THREAT-MODEL.md, "Pack bytes on the device").

**Mounting** (`mount()`, PKeyBoot's MOUNT): after the first frame is drawn
(`RenderingServer.frame_post_draw`; one process frame headless), only the running set's
content-addressed paths, in `mountOrder` (then pack id), one per frame, each after the header and
directory checks again, with `replace_files=true` (S-05 §4.6: with `false` a pack's UIDs never
register), never twice in a process. A restart pack committed before its id was mounted in this
process (the boot's FETCH) mounts at this boot; one committed later activates at the next boot,
from its new path: an overwritten mounted pack corrupts reads, and a same-session remount serves
stale resources (A6 §2.7). A mount over 100 ms warns (more than ~1,000 entries belong under a
loading screen, S-05 §4.1). On web the mounted bytes are capped (150 MB on mobile browsers, 300 MB
on desktop: `web_cap`).

**Deltas through the engine.** `PackedByteArray.decompress` cannot take a prefix, so a
`--patch-from` frame is decoded by Godot's own delta decoder (A6 §2.4): the prefix is exposed under
a private path (`__pkey/<session>/<n>/b<i>`, never a path a game loads), a helper pack lists
`GDDL\x01` + the frame as a `PACK_FILE_DELTA` entry for it, and reading the path decodes. A prefix
inside an installed store pack is exposed by a trailer appended to that very file (mounted at its
own offset, truncated back after the reads; its size is journalled first, so a crash in between is
repaired by truncation at the next load: the journal is a list and names only
`user://pkey/store/<sha256>.pck` files, and a journal that cannot be written sends the frame to a
copy host instead); any other prefix is copied into a helper "host" pack. All
of a `files` set's frames go through one mount pair. The window check (§2.7 rule 3) and the
dictionary-magic rule run before any frame reaches the decoder, which enforces no window limit of
its own. `zstd-patch-from` is advertised only on the engines in `PKeyPackZstd.PATCH_FROM_ENGINES`
(4.6, 4.7: `PACK_FILE_DELTA` arrived in 4.6) whose start-up probe decodes; on the 4.4 floor the
planner never chooses a delta, and the corpus's decode cases are held to fail closed.

**Chunk sync** (P4-11; `PKeyPackChunks`, plans/P4-10.md §2.3, §2.5): `chunk` is in the engine's
default strategies (`delta`, `chunk`, `file`, `full`). A container variant carrying a usable
`pkey-chunks/1` index is rebuilt from **seeds**: this pack's installs, then every other pack's
active and previous installs (by pack id), then the embedded baselines (by pack id), each a
container whose own record names a chunk index kept in the seed store
(`user://pkey/index/<sha256>`, the stored bytes as fetched, re-verified against the install's
payload at every use). The first install of a pack is `full`; after every successful ensure the
index of each installed or embedded container that lacks one is fetched by hash, verified and kept,
and garbage collection drops every kept index no root install names. Before planning, the target
index is staged like any object and handed to the planner; `chunk` then copies seeded chunks,
copies duplicates from its own output, and fetches each missing run with **one single-range
request** (`PKeyPackHttp.open_range` on HTTPClient: `Range: bytes=<o>-<e>`, `If-Range:
"<bundle sha256>"`, `Accept-Encoding: identity`, never a multi-range; the body is pulled record by
record, so one chunk is held at a time). Only a `206` whose `Content-Range` is exactly the request
(or clipped at the bundle's end) and whose `ETag`, when present, is the quoted bundle hash is read;
anything else (a `200`, another range or tag) falls back to the next candidate, `full` last. Every
fetched chunk is decoded (`decompress` with its exact length) and hashed before it is written; a
failing payload hash runs the repair pass. Each completed run sets a bit in
`staging/<planId>/journal.json`: an interrupted run fails the ensure with `network-error` (detail
`chunk`), and the next ensure resumes the same plan, re-hashing every journalled run before reusing
it. A u64 in the index is two `decode_u32` reads saturated at 2^53, never `decode_u64`. Delegated
releases are trees, so they never take this path. On web, `user://` lives in memory, so seeds do
not persist and the planner falls back to `full` by itself.

**HTTP** (`PKeyPackCdnTransport`, `PKeyPackHttp`): the record from discovery's
`release.endpoints.record`, objects from `distribution.endpoints.blobs`, on HTTPClient (never
`download_file`, which truncates and, on web, deletes its file); `Accept-Encoding: identity`;
`Range` with `If-Range: "<sha256>"` on a resume (staged bytes re-hashed, never trusted; a 200
starts the object over); redirects followed by hand, the bearer sent only to the control plane's
origin and dropped on any cross-origin hop; one wall-clock deadline per request (`object_timeout`,
600 s; a timeout resumes at the next ensure). A 403 from the blob route (`delivery_gate_missing`,
`not_entitled`) fails with `pack-not-entitled`. A transport is an interface (`PKeyPackTransport`): P5-08 adds
the platform ones behind it.

**PKeyBoot.** `required_packs` and `essential_packs` default to the stamp's expects. FETCH runs
`boot_fetch`: it estimates what is missing and, when the `consent` option says so (`metered`, the
default, asks only with `metered: true`; `always`; `never`), shows the consent card with the size
before a byte downloads (Download / Not now; `answer_consent(bool)` from a game's own UI); a
decline stops at BLOCKED `content-declined`, never ERROR. MOUNT mounts and then applies the
`theme` option (a Theme a pack provides). After READY, BACKGROUND installs the `prefetch` packs
behind a corner pill that never takes input. Offline with the required set present reaches READY;
an essential pack missing offline offers "Play offline".

**Revocations** (plans/P4-13.md §2.3–§2.5; P4-24). A revocation is a CI-signed `kind:
revocation` release record naming the revoked pack record by hash (and an optional
replacement); only a pinned release key verifies it, so the Worker can withhold content but never
condemn or substitute it. The engine keeps every verified revocation in a sibling document,
`user://pkey/content/revocations.json` (`PKeyPackRevocations`), never inside `state.json`:

- A revoked release is never installed, activated or mounted (`pack-revoked`), embedded baselines
  and pinned packs included; a running one stops at once (a `hot` handler is deactivated, a
  `godot.pck` not yet mounted is withdrawn from this boot; a mounted one stays loaded until
  restart, because Godot cannot unload a resource pack, and is refused from the next boot;
  `set_changed("restart")` fires so the host can prompt a restart), a rollback never goes back to
  one, and FETCH treats it as missing. A revoked REQUIRED pack gives boot `required` from the next
  boot.
- The file is written only once the first entry is stored, with `revocationsStored: true` written
  to `state.json` first; an absent file is the empty document. A product that never had a
  revocation has no file, no flag and no `relearn`, so nothing here can refuse a mount.
- Can't-read is never missing: an unreadable file writes nothing this process and, only when the
  flag is set, refuses the embedded mount of every pack the stamp pins or the host embeds
  (`pack-revoked`, detail `relearn`). A torn file is held aside as `revocations.json.torn` and
  replaced by a fresh document whose `relearn` lists those packs.
- On load every entry is re-verified against the currently pinned release keys and its stored pin;
  a key that is no longer pinned forgets its target (the rotation lever for a stolen release key),
  any other failure adds the pack to `relearn`. A pack in `relearn` has its embedded baseline
  refused at every boot (online it is fetched and verified again instead) until a fresh,
  network-verified feed with a usable `revocations` member re-teaches it, or `recover_state()`
  clears it.
- At most 256 targets are kept, the oldest by `issuedAt` dropped first.

`revocations()` reports `{revoked, verified, relearn, issue}`; `ensure_releases([{pack,
release}])` and `estimate_releases` install a `packs` answer's exact releases; `content_input()`
and `record_revocations()` are what `decide()` uses. `boot_fetch` takes a `packs` answer's
`install` (PKeyBootHost passes it): required and essential entries install before mount, the rest
wait in `background_targets` for BACKGROUND.

**Content-key delegation** (plans/P4-19.md §2.3–§2.7 with Amendment A1; P4-26). A CI-signed `kind:
delegation` record lets one content key sign tree-layout pack releases of `files.tree`,
`data.json` or `l10n.table` under a pack-id scope (whole segments: `djdl.events` covers
`djdl.events.halloween`, never `djdl.eventsx`) inside a signing window. A delegated record names
its delegation in its header (`kid: pkd1-<sha256 of the delegation>`):

- `PKeyReleaseRecord.verify_release_record(body, {…, delegation})` verifies the delegation against
  the pinned release keys only (one level: never through another delegation; its key is no
  release or product key), then the record with the delegated key, then step 16 (`scope`). A
  pinned `pkd1-` kid is `invalid-options`. Verified delegations are cached per hash and trust
  inputs.
- The engine fetches a delegation by that hash (at most 16 distinct ones per call) only for a
  target that is neither the stamp's pin or hold for the pack nor a stored revocation's
  replacement: those are release-key surfaces, where the record is refused at `jws`. `pack_for`
  goes through the same path.
- A delegated release passes the data-only rule (`PKeyDataOnly.data_only_refusal`): the extension
  allow-list over the files index before any payload object is fetched, then, for every file the
  applier writes (and every file a `noop` reuse would keep), a padding-proof 64-byte head sniff, a
  tail sniff over the last 65,557 bytes and, for json/csv/tsv/po/txt, the whole-file text rule
  (strict UTF-8, no NUL, no script marker raw or with backslashes removed, no `\u`/`\U` escape
  that could spell ASCII). A refusal aborts the plan with `pack-not-data-only`, whose detail
  names the `path` and the rule (`extension` or `content`). The `files.tree` handler also asserts
  every staged path is its own `simplify_path()`.
- The install keeps the delegation verbatim (`delegation` in `state.json`) and reloads through it,
  so it stays valid after the window. A revocation of the delegation (a feed entry whose `kind` is
  `delegation`) stops every release under it: `pack-revoked`, detail `delegation`. `decide()`
  treats such entries as relevant when they name the delegation of a delegated release the engine
  knows or their scope covers a pack the stamp, the running set or the feed names, and revokes the
  delegated releases for the decision.
- **A delegated file never reaches `load_resource_pack`.** A delegated plan (or one starting from a
  delegated install) never takes the GDDL `zstd-patch-from` route, which mounts helper packs
  holding the base and the frame; the `godot.pck` handler and `mount()` refuse an install that
  carries a delegation. Apps must parse delegated text with pure JSON or CSV parsers
  (`JSON.parse_string`), never `str_to_var`, `ConfigFile` or `JSON.to_native(…, true)`, and never
  write delegated bytes under a code extension.

**Signals**: `pack_progress(id, bytes, total)`, `set_changed(activation)` (a commit or rollback
changed the active set: `hot` now, `restart` at this boot's mount or the next boot),
`pack_ready(id)` (usable in this process: a hot commit, or a mount), `pack_failed(id, err)`.

**Rollback.** The shared boot guard (P3-10) also counts while a pack set the last confirmed launch
did not run is active, and its `roll-back` puts each such pack back to `previous` together with
the binary; a packs-only rollback needs no restart (the guard runs before MOUNT). Each pack rolled
back queues `boot_rolled_back` with the pack id and the restored `packSetId`, and its record is
**held** (`held` in the install state, with a count): the restored install stays active and the
held record is not fetched again until the stamp pins a different one (installing that one
clears the hold) (an explicit `ensure` of it
fails with `pack-rolled-back`), so a broken pack costs two failed boots once. A pack that cannot
install (any code but a transient `network-error`) queues `pack_failed` with its code, both on the
device report's `updates` while the updater is active. A confirmed launch confirms the running
set. The device report carries `content: {packSetId}`.

**Tests** (`packs` suite): content, plan and records (the corpus); pck (the device checks over the
CLI's fixtures and verdicts); bake (both delta kinds decoded through a trailer on a MOUNTED base:
the running session's reads stay correct and the base comes back byte for byte); engine (a tree
install, update and rollback; resume; refusals; kaykit v1→v2 by the payload delta, the files
delta, file and full, each committing CI's v2 at `store/<sha256>.pck`, mounted by the next boot);
state (the hardened state); http (the real transport against PKeyFakeServer); boot (the stages
and signal order); guard (two failed boots roll the set back, with and without the binary);
revocations (`revocations.json`: two loads, torn, unreadable with and without the flag, the flag
restored, the cap, `pack-revoked` with and without `relearn`, the update check's content steps,
and the facet's `packs` answer through FETCH and BACKGROUND); delegation (strict UTF-8 vectors, the
delegated surfaces, `pack-not-data-only` before fetch, while writing and on reuse, a delegation
revocation, reload through the stored delegation, the 16-delegation bound, no GDDL mount of
delegated bytes, `pack_for`, the update check's step 11 and the facet's holds); uid
(two independently built, stripped packs resolve their own and this project's `uid://` with
`replace_files=true`, the class list unchanged). About 6 s in the editor and 5 s on the macOS
release template (M-series Mac, 4.7.2).

## Apple plugin (`PKeyApple`, P5-05)

iOS reaches AppDistributor, AppTransaction, StoreKit 2, the Keychain and Background Assets
through PolarisKeyPlatform (`sdks/swift`) and a GDExtension written against Godot's C interface
(no godot-cpp, no SwiftGodot). The native class `PolarisKeyApple` has one static
`cmd(json) -> String`; the facade `addons/polaris_key/native/pkey_apple.gd` (`PKeyApple`) turns
it into typed coroutines returning `PKeyResult`, drains the native event queue every frame and
emits `transaction_updated(jws, transaction)`, `pack_progress(id, bytes, total)`,
`pack_ready(id, path)` and `pack_failed(id, err)` on the main thread.

```gdscript
var apple := PKeyApple.shared()
var d := await apple.distributor()          # detail: {signal, reason?, provisioned, …}
var p := await apple.products(["gg.vlad.diceroll.pack.foes"])
var b := await apple.purchase("gg.vlad.diceroll.pack.foes", app_account_token)
# the server records b.detail.transaction.jws (P6-01), then:
await apple.finish(b.detail.transaction.id)
var r := await apple.ensure_packs([{"id": "foes-c3", "path": "foes/content.pck"}])
```

Without the native class every call answers Unsupported: `runtime` off iOS, `dependency` on an
iOS build without the xcframework. Background Assets also answers `version` below iOS 26.4 and
`outlet` in a build without the extension. On iOS with the plugin, `PKeyCore` stores the device
id and the token in the Keychain (`PKeyKeychainStore`, migrated from the file store), and the
`PolarisKey` autoload starts this launch's AppDistributor read, which outlet detection uses as
`ios.appDistributor`, `ios.provisioningProfile` and `ios.bundleIdRewrite` once it arrives.

Building and exporting (macOS with Xcode 26+):

```sh
GODOT_BIN=godot sdks/godot/native/ios/build.sh   # addons/polaris_key/native/ios/pkey_apple.xcframework
                                                 # + its .gdextension (build products, not committed)
godot --headless --export-release "iOS (App Store)" build/ios/Game.ipa   # Export Project Only
sdks/godot/native/ios/patch_export.sh build/ios  # adds the Background Assets extension when the
                                                 # preset asked for it
```

The iOS preset option `polaris_key/apple_background_assets` (`auto`, `on`, `off`; env
`PKEY_APPLE_BACKGROUND_ASSETS`) marks the exported Info.plist; `auto` is on for `app-store` and
`testflight` and off for sideload outlets, whose IPAs ship no extension. `patch_export.sh` runs
S-01's `patch_ba.rb` unchanged (Ruby `xcodeproj` 1.27). The preset's
`application/min_ios_version` must be at least 17.0. `native/ios/export_check.sh` checks a store
and a sideload export end to end; `native/ios/sim_check.sh` runs the binding in Godot on the iOS
simulator (it needs an arm64 simulator `libgodot.a`: the official 4.7.2 template's simulator
slice is x86_64 only). Archiving and signing need the owner's Apple account and are not
scripted here.

## Android plugin (`PKeyAndroid`, P5-06)

Android reaches install source, the Keystore, Play In-App Updates, Play Asset Delivery and the
verified PackageInstaller self-update through `polaris-key-platform` (`sdks/kotlin`) and the
Godot Android plugin `PolarisKeyAndroid` (`native/android/`, built with `native/android/build.sh`
into `addons/polaris_key/native/android/bin/`, not committed). The plugin has one method,
`cmd(json) -> String`; the facade `addons/polaris_key/native/pkey_android.gd` (`PKeyAndroid`) turns
it into `PKeyResult`s (asynchronous ones awaited by `req`), drains the plugin's event queue every
frame and emits `update_progress`, `update_result`, `pack_progress`, `install_status` and
`resumed`. Use the one instance `PKeyAndroid.shared()`.

```gdscript
var android := PKeyAndroid.shared()
var src := android.install_source()            # raw: installer, initiator, initiatorCertSha256, …
var r := await android.update_check()          # play: availability, priority, stalenessDays, …
r = await android.pack_fetch("foes")           # pack_progress … status 4, then:
var pck = android.pack_location("foes").detail.location.pck   # mount it now; never persist it
r = await android.apk_install(path, sha256, version_code)    # direct: verified, then committed
```

- **Typed unsupported.** Off Android every call is `unsupported` with reason `runtime`; on Android
  without the plugin, `dependency`; In-App Updates on a direct build or an install Play did not make
  (installer not `com.android.vending`), Play Asset Delivery on a direct build and the
  PackageInstaller calls on a play build, `outlet`. A plugin error is `platform-error` with the
  plugin's fields in `detail`; any In-App Updates failure is `detail.error == "unavailable"`.
- **Flavours.** The preset's `polaris_key/android_flavor` (`play`, `direct` or `none`;
  `PKEY_ANDROID_FLAVOR`) picks the AARs; the export plugin
  (`addons/polaris_key/native/android_export_plugin.gd`, rules in `PKeyAndroidExport`) adds Play
  Core for play and, for direct only, `REQUEST_INSTALL_PACKAGES` and
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. It needs the Gradle build and warns on a Play outlet with
  the direct flavour or an F-Droid outlet with the play flavour.
- **Store.** On Android with the plugin PKeyCore keeps the device id and token in the Keystore
  (`PKeyKeystoreStore`: migrated from the file store, failures surfaced as `keyring-error`, a lost
  key surfaced and the device re-activated); `PKeyOptions.store` overrides.
- **Updates.** The `play` and `play-testing` adapters act on a `store` answer through In-App
  Updates (flexible, or immediate when the decision is mandatory or critical; complete a downloaded
  update; silent while Play stages; the listing on any failure or a non-Play install). On a direct
  build the decision offers `binary {method: native}` (the `apk` bridge is available there only,
  and `native` must be among `PKeyOptions.update_methods`); the player's update action runs
  `PKeyUpdater.install_apk(check)` (`PKeyApkUpdate`): the record's APK is downloaded into
  `user://pkey/<product>/updates/apk/`, checked against the verified record's payload size and
  SHA-256, and handed to `apk_install`. The download link is opened only when the plugin answers
  unsupported. A self-update kills the game and
  nothing relaunches it: the next launch reads `PKeyAndroid.launch_install_outcome()`, and stale
  sessions are abandoned at launch.
- **Tests.** `suite_native_android` (in the `ci` set) runs the facade headless against
  `tests/support/fake_android_native.gd`: the stubs, the outlet gating, the event mapping, the
  Keystore store, the export rules and the play adapter. The Kotlin side has its own Robolectric
  tests (`sdks/kotlin`, the `android` CI job); `native/android/export_check.sh` exports the probe
  through the Gradle build and, with `DEVICE=`, runs it on an emulator.

## Device attestation (`PolarisKey.devices.attest()`, P6-02)

A store install proves it is genuine and the Worker records the device at trust level
`attested`; every other device stays `basic`, which is expected, not suspicious. The device token
and the signed documents do not change.

```gdscript
var r := await PolarisKey.devices.attest()
# ok: r.detail == {trust_level: "attested", kind: "app-attest" | "play-integrity", attested_at}
# r.code == &"unsupported": r.detail.reason is runtime (desktop, web, the iOS simulator) or outlet
```

It posts `devices/attest/challenge` (bearer), then `devices/attest` with either an App Attest
attestation (`PKeyApple.app_attest(request_hash, key_id)`: PolarisKeyPlatform's
`app_attest_attest` over DCAppAttestService, `clientDataHash = SHA-256(UTF-8(requestHash))`) or a
standard Play Integrity token (`PKeyAndroid.integrity_token(cloud_project_number, request_hash)`:
the play AAR's `integrity_token`, the `requestHash` verbatim, the cloud project number from the
challenge's `play.cloudProjectNumber`, else `PKeyOptions.play_cloud_project_number`).

- **Unsupported.** `runtime` on linux, macos, windows and web, and where App Attest does not run.
  `outlet` on an iOS install that is not App Store or TestFlight (AppDistributor's signal, or an
  embedded provisioning profile when it has none), an Android install Google Play did not make or
  the direct plugin build, and a mobile build without the native plugin. None of them touches the
  network. `PolarisKey.supports("devices.attest")` answers the same through the outlet detector
  `PKeyDevices.attest_outlet_detail`.
- **Keys.** iOS keeps the App Attest key id in the Keychain (account `app_attest_key`) and reuses
  it. A key the system no longer knows (reinstall, device migration, restore) answers
  `invalid_key`; `attest()` drops it and attests a fresh key in the same call. On
  `server_unavailable` the generated key is kept for the retry, as Apple advises.
- **Errors.** The Worker's codes come back verbatim (`unauthorized`, `rate_limited` — a few per
  hour per device —, `attestation_unavailable`, `attestation_rejected`); a plugin failure is
  `platform-error` with the plugin's reply as `detail` (Play's `errorCode`, App Attest's `error`).
- **Tests.** `tests/devices/test_attest.gd` (the `devices` suite) over the fake Worker and the two
  fake plugins; `suite_native_apple` and `suite_native_android` cover the facade calls.

## Config (`PolarisKey.config`)

```gdscript
var speed: float = PolarisKey.config.get_value("dice.animSpeed", 1.0)
PolarisKey.config.set_override_store(PKeyConfigFileStore.new("user://settings.cfg"))
PolarisKey.config.set_compiled_catalog(preload("res://catalog_generated.gd"))
PolarisKey.config.bind_property($Dice, "roll_speed", "dice.animSpeed", 1.0)
var minted := await PolarisKey.config.mint_token("leaderboard")   # minted.token, minted.expires_at
```

- Precedence is client-core's: enforced or hidden (remote) > local override > environment >
  remote default > fallback. An enforced or hidden key ignores the player's saved value without
  deleting it from `settings.cfg`.
- The local layer is read at call time. `PKeyConfigFileStore` finds a key at its catalog
  `accessor` (`section.key` -> `[section] key`), then in an explicit table, then at the key
  itself.
- The environment layer is `PKEY_CONFIG_<key with . as __>` plus `--pkey-config key=value` user
  arguments. `PKeyOptions.config_env_layer` controls it: Auto (on in debug builds and on desktop,
  off in release builds on mobile and web), Always or Never.
- `config_changed(keys)` fires after `start()`, each sync and each bundle import, and when the
  store changes. It fires once per event and carries exactly the keys whose effective value
  changed.
- **Secrets are not secret in a game.** A `clientScoped` secret sits in `managed.json` (IndexedDB
  on web, which any same-origin script can read) and anything in a `.pck` can be extracted. Use
  edge-mint for third-party API keys. Minted tokens are kept in memory only and never printed.
- Edge-mint sends nothing in four cases: Config is off, this session's discovery says
  `config.mint.available` is false, the recipe id fails `^[a-z0-9-]+$`, or no device token is
  held. A 401 gets one re-acquire, then the call fails. 401, 404, 429 and 5xx come back as
  distinct `PKeyMintResult.kind` values.

## Identity (`PolarisKey.identity`)

```gdscript
PolarisKey.identity.sign_in_pending.connect(func(p: PKeySignInPrompt):
	$Code.text = p.user_code                      # show it large
	$Qr.text = p.verification_uri_complete        # a PKeyQrRect
	$Url.text = p.verification_uri)               # the short URL to type
PolarisKey.identity.sign_in_finished.connect(func(r: PKeySignInResult):
	if r.ok: $Who.text = "Signed in as %s" % r.identity.get("email", r.identity.get("name", "")))
await PolarisKey.identity.begin_sign_in()        # polls in the background; cancel() stops it
```

- Device-code sign-in (RFC 8628) is the only native way a game finishes an identity sign-in.
  `begin_sign_in` refuses with `service-unavailable` before any request when Identity is off or,
  per this session's discovery, not configured.
- Polling follows the server's cadence: at least `interval` between polls (never under one
  second, never past the code's lifetime), a `slow_down` uses the returned interval or adds five
  seconds to the current one, a poll that got no answer or a 5xx is retried at the same
  interval, and nothing is sent after `expires_at`. Every poll carries the `X-PKey-Device` id.
- `ready` stores the device token (source `signin`) and runs one forced `sync(true)`, so the
  licence and config documents arrive at once. Show `PKeySignInResult.identity` afterwards: it
  is how a player notices a stranger confirmed the code and signed the device in to their
  account.
- **Opt-in licence attach.** `begin_sign_in(name, true)` holds the flow at the signed-in identity:
  `sign_in_confirm({identity, attachable})` fires and polling stops until the game calls
  `accept_sign_in(attach)` or `cancel()`. With `attachable`, `accept_sign_in(true)` attaches the
  device's anonymous enrolled licence to the account (`attached` is `claimed` or `migrated`).
  Nothing is minted or merged before the player accepts on the device, and only the device,
  which holds the device code, can ask.
- Device-code sign-in sends no fingerprint, so a `strict` tier refuses it.
- `PKeyQrRect` renders `verification_uri_complete` at any size: one texel per module, NEAREST
  filtering, a four-module quiet zone, theme colours `dark` / `light` for the type `PKeyQrRect`.
  The encoder is pure GDScript, held to fixtures from Nayuki's qrcodegen (`tests/qr/`); about
  8 ms per encode on a release template (11 ms in the editor) on an M-series Mac.

## Boot and UI kit (`PolarisKey.boot()`, `PKeyBoot`, P1-10)

```gdscript
func _ready() -> void:
	var boot := await PolarisKey.boot({allow_offline = true})   # or {view = $PKeyBoot, …}
	if boot.outcome == PKeyBoot.READY:
		get_tree().change_scene_to_file("res://game/title.tscn")
	# BLOCKED, OFFLINE, ERROR: PKeyBoot shows the card with Retry; a later stop arrives as
	# PolarisKey.boot_finished(result).
```

- **One machine, many views.** `PKeyStages` (core/stages.gd) is the port of client-core's
  `stages.ts`; the `stage_matrix` suite (`--pkey-test stage-matrix` works too) replays every row,
  probe, guard case and confirm case of `stage-matrix.json`, compares `failedBoots` numerically,
  and holds the port to the ignore rule (malformed events, identity, purity). PKeyBoot never
  decides a transition: it does a stage's work each time the machine enters that stage, sends the
  result, and renders what the machine says. Its signals are the machine's emits:
  `stage_changed(stage, previous)`, `waiting(status)`, `update_available()`, `blocked(reason)`,
  `offline(can_play_offline)`, `error(code)`, `boot_rolled_back()`, `boot_ready()` (a Control
  cannot redeclare `ready`), plus `boot_finished(result)` at every stop.
- **What PKeyBoot sends** is plans/P1-09.md §2.2, in PKeyBootHost: shell configures from
  `res://polaris_key.tres` when needed and starts (offline); guard runs the boot guard (`PolarisKey.update.run_guard()`: `ok`, `applied` or
  `rolled-back`; nothing at all when it swapped or rolled back a pack and restarted); sync runs
  discovery (not counted), registers first when a product without License has an `open`
  registration policy and no token, then `PolarisKey.sync()`, classified from
  `PKeySyncResult.classify()` (answered 200/304/401/403/429 is `ok`, no answer is `offline`,
  unusable is `error`; `PKeySyncResult.errors` keeps each failed document's status, 0 for no
  answer); gate sends `PolarisKey.status()` and sends it again while it waits whenever the
  licence state changes; decide is `optional` when `PolarisKey.update.decide()` has something to
  show (or, without the signed decision, the v3 check found a newer version), otherwise `none`.
  Floors never stop play; a CI-signed revocation of a REQUIRED pack does (plans/P4-13.md
  decision 4): decide is then `required` and the boot stops at a confirmed BLOCKED
  `update-required` with the revoked-content copy ("Content withdrawn": "Some of this game's
  content was withdrawn by its developer and can't be used. Update the app to keep playing."),
  with the update button when the answer is an offer and none for `blocked`. A `packs` answer is
  `none`; fetch and mount drive packs (P4-08, see "Packs"), FETCH at its exact releases. `fail` is only for a store failure or an options file that
  cannot configure. The sync stage has one wall-clock deadline (`sync_timeout_seconds`, 20 s, or
  45 s on a build without threads where a bundle verify runs in frame slices), after which the
  machine gets `sync.timeout` and a late answer is dropped.
- **Scenes** (each a `.tscn` with the default theme, a view script and a headless controller):
  `PKeyBoot`, `PKeyGate` (class `PKeyGateView`: the licence-gate logic already owns the name
  `PKeyGate`), `PKeyActivationPanel`, `PKeySignInDialog`, `PKeyOfflineDialog`,
  `PKeySettingsPanel`, `PKeyStatusBanner`, `PKeyUpdatePrompt`, `PKeyEntitlementBadge`,
  `PKeyDevMenuSection` (a Control, and `rows()` for a data-driven dev menu). Every string goes
  through `PKeyUiCopy` and `tr()`; every interactive control is in one wrapping focus chain, so
  ui_up / ui_down / ui_accept / ui_cancel operate every screen on a gamepad or a TV remote.
- **Update answers never cover the game.** A mandatory or blocked decision is a persistent banner
  with no dismiss in `PKeyUpdatePrompt`, whatever its `modal` setting; only a dismissable answer
  may use the modal card. The banner is a strip at the top in any parent: PKeyBoot hosts it on a
  plain full-rect overlay that takes no input, and inside a game's own Container it asks for its
  own height only. `PolarisKey.boot()` without a view keeps a visible prompt past READY: the boot
  view is freed and the prompt stays on its CanvasLayer as `PolarisKey.boot_prompt` (a locked
  answer for good, a dismissable one until dismissed); pass `keep_update_prompt = false` when the
  game shows its own prompt, which replays `PolarisKey.update.last_available`. Grace in
  `PKeyGate` is the same: only the status strip, and no full-rect control takes the game's input.
  The prompt's action is the outlet adapter's (see "Updates by outlet").
- **Sliced verifies report progress**: `PolarisKey.verify_progress(fraction)` (web builds without
  threads), which PKeyBoot's progress bar follows; the bar shows once a stage passes 250 ms.
- **Tests.** `boot` drives every stage-matrix row through `PolarisKey.boot()` with a scripted
  host, and the sync classes and keyless registration through the fake server; `ui` pins every
  scene state as a structural snapshot (`tests/ui/snapshots/`), walks focus with ui_down alone,
  and checks every visible string is PKeyUiCopy text under a pseudo-locale. Headless runs have no
  renderer; `tools/ui_screenshots.gd` renders the same states to PNGs for review.
- Timings (M-series Mac, 4.7.2): `stage_matrix` 15 ms in the editor and 13 ms on the release
  template (56 rows, 6,594 probe transitions); `boot` about 6.3 s on both (five deliberate 1 s
  request deadlines); `ui` about 12 s on both (67 states, three passes each).
