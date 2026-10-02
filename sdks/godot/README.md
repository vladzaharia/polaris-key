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
the boot guard (see "Updates by outlet").

## Layout

```text
sdks/godot/
  project.godot               main loop = PKeyTestRunner; flush_stdout_on_print
  export_presets.cfg          one preset, "Conformance (Linux)": the test pack (and its
                              polaris_key/* stamp options)
  polaris_key.tres            the harness's PKeyOptions, as the setup dock writes it (product
                              pkey-harness, editor channel dev)
  parity.json                 the Godot parity manifest (conformance/parity/)
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
                              outlet tables), resolve_update_outlet, decide_update, boot_decision
    distribution/outlets/     PKeyOutletAdapter and one adapter per outlet kind (direct.gd,
                              app_store.gd, steam.gd, web.gd, …; adapters.gd maps kinds to them);
                              the native-updater bridges PKeyNativeBridge, PKeySparkleBridge,
                              PKeyVelopackBridge, PKeyWinSparkleBridge, PKeyAppImageBridge
    updater/                  PKeyUpdater (PolarisKey.update.updater: the adapters' context,
                              methods, boot confirmation), PKeySlots (staged/current/previous),
                              PKeyBootGuard, PKeySidecarSwap, PKeyUpdaterEnv (every side effect),
                              PKeyApplyResult
    core/download.gd          PKeyDownload: a file download on HTTPClient with Range resume, the
                              transport's redirect and credential rules, gzip off
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
                              commit_feed (`pkey-feed+jws`)
    core/release_record.gd    PKeyReleaseRecord: record_hash, release_record_claims,
                              verify_release_record (`pkey-release+jws`, hash before signature)
    core/store/               PKeyStore, PKeyFileStore (0600, temp + rename), PKeyMemoryStore
    core/transport.gd         PKeyTransport: redirects by hand, credentials dropped cross-origin
    core/discovery.gd, sync.gd, token.gd, headers.gd, errors.gd, result.gd, semver.gd, device_id.gd
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
  `optional`; no v4 answer stops play) and `undismissable` (a mandatory offer or any `blocked`:
  a prompt the player cannot dismiss over a game that keeps running). `feed_doc` and
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
- `update_available(result)` fires for a decision worth showing (`boot == "optional"`), and for
  the v3 `check()` when this build is behind; test `result is PKeyUpdateCheck`. `last_available`
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
- Acting on the decision is P3-10's (next section); packs are P4-08's.

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
  AppImageUpdate in an AppImage, else Velopack, on Linux. The plugins are P5-07's: Engine
  singletons `PolarisKeySparkle`, `PolarisKeyVelopack`, `PolarisKeyWinSparkle` with
  `check_now(feed_url)` and `install_and_relaunch(feed_url)`. With no plugin every call is the
  typed unsupported result (`unsupported`, `detail.reason` `dependency`), `native` is not offered
  to the decision, and an adapter given `native` anyway opens the download link: a missing plugin
  never breaks boot. AppImage needs no plugin: with `APPIMAGE` set and `appimageupdatetool` on PATH
  it runs `appimageupdatetool -O $APPIMAGE` on a worker thread and relaunches `$APPIMAGE` (not the
  mounted executable).
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
beside the target (`<pck>.pkey-new`), verifies it there, journals the swap in `state.json`, renames
it over the pack and restarts at once (`OS.set_restart_on_exit` with this process's own arguments):
the running process still holds the old pack's directory, so it must not load anything more. The
rename is atomic on POSIX; on Windows Godot removes the target and moves the new file in (two
calls). A crash between journal and bookkeeping is finished or discarded at the next launch by
comparing the pack with the journal. The swap is refused (`swap-refused`, `detail.reason`) on a
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
- **Telemetry.** `devices/report` has no event key yet, so `update_downloaded`, `update_applied`,
  `update_confirmed` and `boot_rolled_back` (the `updateEvent` names) stay in `state.json`'s
  `events` (the last 32) until P6-03 allowlists them.
- **MSIX.** `user://` is virtualised to `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`, kept across
  package updates and deleted on uninstall, so uninstalling removes the slots (S-05 §4.4, from
  Microsoft's documentation). The swap itself is refused under MSIX.
- **Velopack** builds ship P5-07's launcher shim as `--mainExe`, which answers the `--veloapp-*`
  hooks in milliseconds without starting the engine. Godot as the main executable also survives
  the hooks (1.0–1.7 s each when an autoload quits from `_init`) but opens its renderer and window
  for every hook: a documented fallback only (S-05 §4.5).

**Inert** in the editor, in headless runs (the test runner, a dedicated server) and in debug
builds, as Diceroll's updater is: nothing is downloaded, swapped, restarted or counted, and the
decision gets the declared methods unchanged. `PolarisKey.update.updater.enabled = true` turns it
on (the tests do, with `PKeyFakeUpdaterEnv`).

**Tests** (`updater` suite): every outlet kind × every action through `apply()` with a recording
host; the bridges with and without their native side; `PKeyDownload` against the fake server; the
swap's refusals, a verified stage and swap, mismatches that change nothing, a locked rename, crash
recovery; the guard over successive launches with stage-matrix.json's guard and confirm cases;
PKeyBoot's GUARD and DECIDE with the real host. About 5 s on an M-series Mac, editor and release
template alike.

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
  show (or, without the signed decision, the v3 check found a newer version), otherwise `none` —
  never `required`, so no update floor stops play; fetch and mount are immediate until P4-08
  (mount after the first frame). `fail` is only for a store failure or an options file that
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
