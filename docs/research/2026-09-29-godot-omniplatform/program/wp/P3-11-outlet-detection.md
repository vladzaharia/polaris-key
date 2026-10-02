# P3-11 Outlet detection in every SDK against `outlet-matrix.json`

| Field       | Value                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                                                                                                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md), [P1-02](P1-02-godot-core.md), [S-06](S-06-outlet-signals.md), [P3-04](P3-04-v4-node.md), [P3-05](P3-05-v4-react.md), [P3-06](P3-06-v4-python.md), [P3-07](P3-07-v4-swift.md), [P3-08](P3-08-v4-godot.md) |
| Unblocks    | [P3-10](P3-10-godot-updater.md)                                                                                                                                                                                                                     |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                   |
| Plan mode   | no: the matrix and its vocabulary are fixed by `plans/P3-01.md`                                                                                                                                                                                     |
| Gates       | corpus (`outlet-matrix.json`); all SDKs; rule 9 (the `direct.homebrewFormula` identity in `.pkey/distribution`)                                                                                                                                     |
| Human input | none. Device checks of the platform APIs belong to S-06 and P5                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                           |

## Goal

Every SDK answers "where did this install come from?" the same way. A pure function (proposed
`detectOutlet`, `detect_outlet` in Python and GDScript) maps observed signals and the build stamp
to `{outlet, confidence, source}`, and it passes every row of `outlet-matrix.json` in Node (via
`client-core`), React, Python, Swift and Godot. Each SDK also reads the signals its runtime can
see without native code, and its update decision defaults to the detected outlet when the host
does not name one.

## Why

The update decision depends on the outlet, and outlet detection is the least portable feature:
only iOS and Android have a first-party API, and Android's install source is declared by the
installer rather than proven. The signals differ per runtime, but the mapping from signals to an
outlet must not, which is why it has its own corpus file
([PARITY §7](../../PARITY.md#7-runtime-limits-that-become-typed-nas),
[§4.1](../../PARITY.md#41-corpora-behaviour-as-data)). Diceroll stamps the outlet per export, not
per artifact, and so mislabels Steam, itch and sideload builds
([README §5.5](../../README.md#55-distribution-layer-one-build-any-outlet),
[§9.2](../../README.md#92-diceroll-for-the-diceroll-side) #2–#3).

## Read first

- `AGENTS.md`; `.claude/agents/pkey-sdk-porter.md`; `plans/P3-01.md` (the row schema, signal
  names, confidence levels, precedence and the capability defaults).
- [notes/E9 §1](../../notes/E9-runtime-building-blocks.md#1-outlet-detection): the signal
  catalogue (§1.1, with verification tags) and what is pure per runtime (§1.2).
- [README §5.5](../../README.md#55-distribution-layer-one-build-any-outlet) (runtime detection
  overrides the stamp when the platform knows better);
  [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here) and
  [§8](../../PARITY.md#8-parity-gaps-to-close-now) (the `AppDistributor` iOS 17.4 guard, P3).
- The decision wiring each SDK got in [P3-04](P3-04-v4-node.md) to [P3-08](P3-08-v4-godot.md);
  `conformance/runners/node`, `sdks/python/tests/`, `sdks/swift/Tests/PolarisKeyTests/`, the Godot
  runner.

## Scope

**In:**

- **The pure function** in `client-core` (with a subpath export), Python, Swift and GDScript, and
  the React SDK's use of `client-core`. No I/O inside it: it takes a signals map and the stamp.
- **Runners**: every `outlet-matrix.json` row in the Node runner, pytest, `swift test` and the
  Godot runner (editor and release template), with the same row names.
- **Signal readers**, pure language or small dependency only (notes/E9 §1.2):
  - Node: environment variables, executable path conventions, `node:sea` `isSea()`, and Electron's
    `process.mas` and `process.windowsStore` when present.
  - React / web: `matchMedia('(display-mode: standalone)')`, `navigator.standalone`, the
    `android-app://` referrer.
  - Python: environment, PEP 376 `INSTALLER`, `sys.executable` (not `sys._MEIPASS`) path
    conventions, `ctypes` `GetCurrentPackageFullName` on Windows.
  - Swift: `AppDistributor.current` behind `#available(iOS 17.4, *)` (the package floor is iOS 17),
    raced against a deadline (proposed 2 s; a timeout is `unavailable`, meaning no evidence;
    [notes/S-06](../../notes/S-06-outlet-signals.md) §1), with the `web` case only behind
    `#available(iOS 17.5, *)`; on macOS the `_MASReceipt` receipt, its `ProductionSandbox` marker
    and the signing leaf (`SecCodeCopySigningInformation`), since `AppTransaction` is for commerce
    only; Caskroom checks.
  - Godot: `/.flatpak-info`, `FLATPAK_ID`, `SNAP_NAME`, `APPIMAGE`/`APPDIR`, `SteamAppId`, the
    Steam library ACF, the itch receipt, the macOS receipt and Mach-O signing leaf, the
    `pkey_outlet_*` feature tags and the build stamp through `PolarisKey.build_info()`
    ([P1-11](P1-11-godot-export-plugin.md)). Android's `getInstallSourceInfo`, including the
    initiator's certificate SHA-256 (`getInitiatingPackageSigningInfo().getApkContentsSigners()`
    hashed with `HashingContext`), is pure GDScript through `AndroidRuntime` and
    `JavaClassWrapper` (Godot 4.4+, measured on 4.7.2 in
    [notes/S-06](../../notes/S-06-outlet-signals.md) §7), so it needs no plugin. iOS
    `AppDistributor` and Windows package identity come from plugin hooks that return
    "unavailable" until [P5-05](P5-05-apple-plugin-package.md) and a Windows native reader land.
- **Wiring**: the update client uses the detected outlet when the host passes none; a host
  override always wins. The result is available to the host (for UI and support diagnostics).
- Docs for each SDK page; `parity.json` in every SDK: `outlet.detect` → `implemented`.

- **The Godot build stamp's v4 fields** (moved here from P1-11, which merged before plan P3-01
  §8 could change its brief): the stamp's `outlet` becomes the product's outlet id
  (`^[a-z][a-z0-9-]{0,63}$`); a new `outletKind` (export option `polaris_key/outlet_kind`, env
  `PKEY_BUILD_OUTLET_KIND`) defaults to `outlet` when that value is a kind, the export dialog warns
  when the kind is not one of the 17, and at runtime such a kind decides as `unknown`; optional
  `format` and `outletSubkind`; `outletIds` gains optional `homebrewFormula` and `bundleId`, which
  `pkey distribution outlet-ids` emits once this package adds them. Change P1-11's export plugin
  and `PKeyBuildStamp` accordingly, with export tests.

**Out** (and where it belongs instead):

- Verifying the unverified signals on real devices (→ [S-06](S-06-outlet-signals.md)).
- Native signal sources: the Apple plugin package (→ [P5-05](P5-05-apple-plugin-package.md)) and
  the Kotlin AAR's install-source API (→ [P5-06](P5-06-kotlin-aar.md)).
- Acting on the outlet in Godot (→ [P3-10](P3-10-godot-updater.md)).
- Changing `outlet-matrix.json`: that is plan-mode; report a missing row instead.

## Design notes

- **Plan amendments (`plans/P3-01.md` §8, approved).** Where this brief and the plan differ, the
  plan wins:
  - S-06's rules run over outlet **kinds**, with plan §2.9's five steps and its `source` rule;
    `android.installerMismatch` is its own signal;
  - the result goes to `resolveUpdateOutlet` as `detected` (plan §2.8), never straight into the
    decision;
  - the signal value shapes, `platformData`, subkind narrowing, the web runtime's synthesised
    stamp, and `AppDistributor.web` mapping to `direct`, as `outlet-matrix.json` fixes them;
  - `signals[].verified` says which readers a device run must confirm first; no SDK branches on
    it;
  - this package adds the `direct.homebrewFormula` identity and the `homebrewFormula` and
    `bundleId` keys of `pkey distribution outlet-ids` (P2b-02, done, did not add them), with gate
    rule 9;
  - it wires detection into the `decide()` each of [P3-04](P3-04-v4-node.md) to
    [P3-08](P3-08-v4-godot.md) builds, so all five are graph dependencies.

- **Mapping is shared, reading is not.** Only the pure function is conformance-tested; readers
  are unit-tested with faked environments, because each runtime sees different signals.
- **Precedence** as the plan fixes it: first-party platform evidence (for example
  `AppDistributor`, MSIX `SignatureKind`) over installer-declared evidence (Android) over
  environment and path heuristics over the build stamp, except that below attested evidence,
  runtime evidence may only restrict the stamp or veto it (next bullet): a heuristic never turns a
  `steam` or `itch` stamp into `direct`. `unknown` when nothing applies, with the restrictive
  capabilities the plan assigns.
- **Detection never widens capabilities.** It chooses an outlet; the outlet's compiled defaults and
  the feed's narrowing decide what the install may do.
- **Identity conditions and restrict-only evidence** ([notes/S-06](../../notes/S-06-outlet-signals.md),
  proposed for `plans/P3-01.md`): a launcher signal counts only when it names this product (Flatpak
  app id, snap name, Steam app id in the env or the library ACF, itch receipt `game.id`, `APPDIR`
  containing the executable, Android installer equal to the initiator, and the MSIX package
  family name equal to the product's before any `windows.*` row counts, because identity can be
  inherited from an MSIX parent process). A signal with no identity condition in the note's
  table is diagnostic only and never counts: `ITCHIO_APP=1` names no product (any child of an
  itch-launched process inherits it), so `itch.appEnv` is recorded but never moves or keeps an
  outlet, and `itch.receipt` is the only itch signal that counts. The receipt's `game.id` is a
  JSON number, which Godot's `JSON` parses as a float, so compare `str(int(game.id))` with the
  stamp's `itchGameId` string (and likewise compare the Steam app id as a decimal string). The
  ids come from the
  stamp: [P1-11](P1-11-godot-export-plugin.md)'s export plugin writes the product's outlet
  identities (Steam app id, itch game id, Flatpak app id, snap name, cask token, MSIX package
  family name, bundle or application id) into `build.json` (from its `polaris_key/outlet_ids`
  option, which CI fills from [P2b-02](P2b-02-distribution-manifest.md)'s
  `pkey distribution outlet-ids`), so detection works offline at first
  launch, and the pure function receives them with the stamp. Non-attested evidence may
  move the stamp only to an outlet with no wider `binaryUpdates`. Attested evidence overrides the
  stamp only when it names a README §3.1 outlet. On macOS only two signing leaves select:
  `Apple Mac OS Application Signing` (`app-store`) and `TestFlight Beta Distribution`
  (`testflight`). A Developer ID, Apple Distribution, Apple Development or ad hoc leaf, or an
  unsigned bundle (signal value `none`), is a veto and never selects `direct`, because Steam
  macOS builds are Developer ID, ad hoc or unsigned (6/4/2 of 12 measured). A veto
  drops the stamp and gives `unknown` when the stamp names the vetoed outlet, and changes nothing
  otherwise: Android installer ≠ initiator against `play`; an iOS provisioning profile against
  `app-store`; a non-store macOS leaf against `app-store`/`testflight`; a snap revision `x<n>`
  against `snap`; a Windows `SignatureKind` of `Developer` or `Enterprise` against `ms-store`.
  Windows package identity alone selects nothing (a sparse package has identity too): it gates the
  other `windows.*` rows, and when none of them fires the stamp stands.
  On Android only `play` can be `attested`, and only when the initiator digest equals the Play
  Store's recorded digest; until P5-06's device checklist records it, Android `play` evidence is
  `declared` (restricting only), in Godot and every SDK. Async platform calls get a deadline,
  because `AppDistributor.current` hung on the simulator. If the plan does not adopt
  these rules, follow the plan and report the gap.
- **Verification status** comes from [notes/S-06](../../notes/S-06-outlet-signals.md) (its
  signal-to-outlet table). `steam_appid.txt` is refuted as a dev-mode signal and the macOS
  provisioning profile as a development-build signal: do not read either for detection;
  `itch.appEnv` is diagnostic only (previous bullet). Each
  signal takes the confidence in the note's table, including rows S-06 could not measure on a
  device (Play tracks, iOS devices, Windows, Steam on Windows, Linux and Proton, real itch and
  Snap launches). The attested rows backed only by documentation (`ios.appDistributor`,
  `windows.packageIdentity`, `windows.signatureKind`, `windows.appInstallerUri`,
  `windows.externalLocation`) are "attested per documentation"; P3-01 confirms or lowers them.
  Do not downgrade them here: Swift, Node and Python have no stamp producer, so a lower
  `ios.appDistributor` would make every stamp-less App Store install `unknown` (rule 7).
- **Privacy** (AGENTS rule 7): read markers, never enumerate installed applications. Report only
  the detected outlet id, if the telemetry allowlist has an `outlet` key (P1-05).
- **No typed N/A.** Every runtime can at least return the stamp or `unknown`.

## Steps

1. Confirm P3-02 is `done`; branch `wp/P3-11-outlet-detection`. The Godot part needs P1-02, and
   the wiring step needs each SDK's wave package (P3-04 to P3-08). Where one has not landed, ship
   the pure function and readers for that SDK, and leave the default-outlet wiring to its wave
   package with a note in the PR.
2. The pure function and runner sections, one SDK per commit.
3. Signal readers with fake-environment tests, one SDK per commit.
4. Wire the default outlet into each update client; docs; `parity.json`. Set `in-review`.

## Acceptance criteria

- [x] Node (through `client-core`), Python, Swift and Godot pass every `outlet-matrix.json` row,
      with identical row names; React uses the `client-core` function.
- [x] Each SDK's readers have unit tests with faked signals for every outlet its runtime can see.
- [x] Swift's `AppDistributor` call is guarded for iOS 17.4 (the `web` case for 17.5) and raced
      against a deadline, a test with a never-resolving fake returns `unavailable` (no evidence),
      and the package still builds for its iOS 17 floor.
- [x] Each update client uses the detected outlet when the host passes none, and the host's value
      when it does (a test per SDK).
- [x] The green gate passes (`AGENTS.md`), including the Python, Swift and Godot jobs.
- [x] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm --filter @polaris-key/react test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

For Godot, P1-01's runner on the editor and a release template:
`GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh`.

## Corrections from implementation

Where this brief and the code disagreed when P3-11 was built, the code won:

- **Python does not read PEP 376 `INSTALLER`.** It names `pip`, `uv` or `conda`, none of which is a
  kind, a subkind or a signal in `outlet-matrix.json`'s vocabulary, so reading it would need a
  26th signal, which is a plan-mode corpus change. A pip-installed tool is `direct` with no
  subkind, which the stamp (or the host) already says. The Python readers are the environment,
  `sys.executable`/script/`sys.prefix` path conventions (a Homebrew `Cellar`, WinGet, Scoop,
  Chocolatey), product-named markers (a frozen `.app`'s receipt, `Caskroom/<caskToken>/`, the
  install's Steam `appmanifest`, the nearest itch receipt, `/.flatpak-info`) and
  `GetCurrentPackageFamilyName` through `ctypes`.
- **Godot does not count `FLATPAK_ID`.** An environment variable is inherited by child processes,
  and `linux.flatpakInfo` is attested only because Flatpak writes `/.flatpak-info` read-only; the
  reader reads the file alone.
- **Godot's `pkey_outlet_<kind>` feature tag stands in for a lost `build.json` only.** With
  `PKeyOptions.build_stamp_path = ""` (no stamp at all, as the tests configure) no tag stands in
  either. A web export with no stamp synthesises `outletKind: web`.
- **Godot's device report carries the detected outlet** (`PKeyCore.reported_outlet()`: the
  decision's outlet id, else its kind, never `unknown`), the "detected outlet id" the privacy
  bullet allows under P1-05's `outlet` key; `PKeyCore.outlet()` keeps answering the stamped id.
- **Node reads product-named markers too**, not only the environment and path conventions: the
  Mac App Store receipt (and `ProductionSandbox`) in an `.app`, `Caskroom/<caskToken>/`, the
  install's own `appmanifest_<steamAppId>.acf`, the nearest itch receipt and `/.flatpak-info`.
  Electron's `process.mas` gates nothing by itself (the receipt is the evidence);
  `process.windowsStore` lets the reader take the package family name from the `WindowsApps`
  folder. SignatureKind, the App Installer URI and the external location need WinRT, so a
  packaged Windows install keeps its stamp in Node and Python as in Godot.
- **Swift also reads AltStore's `ALTBundleIdentifier` and an iOS `embedded.mobileprovision`**
  (`ios.bundleIdRewrite`, `ios.provisioningProfile`), and detects at the update client's first
  decision rather than at construction, because `AppDistributor.current` is async. A Developer ID
  leaf is reported without its team name.
- **The option and accessor names.** `detect` (default true) in Node, React, Python and Swift,
  `update_detect` in Godot (beside `update_outlet`); the readers take a fakeable environment
  (`outletEnvironment` / `outlet_environment` / `PKeyCore.outlet_env`); the result is exposed as
  `outlet` and `detected` (`client.update.outlet`/`.detected`, `adapter.outlet`/`.detected`,
  Swift `outlet()`/`detected()`, Godot `PolarisKey.update.outlet()`/`.detected()`, which
  delegate to `PKeyCore.update_outlet()`/`detected_outlet()`, kept for the device report). Node adds
  `packageName` for `node.packageManager`'s identity condition. Every SDK exports
  `detectionStamp`/`detection_stamp`, the build stamp as detection reads it.
- **`homebrewFormula`'s pattern stays [I].** `^[a-z0-9][a-z0-9.@+_-]{0,99}$` as plan §3 wrote it;
  Homebrew's own naming rules were not checked against it here.
- **`pkey distribution outlet-ids`' `bundleId`** is the build's own Apple entry's (`app-store`,
  `testflight`, `altstore`, `altstore-pal`), else the first of those entries that declares one; a
  Godot preset's bundle identifier still wins in the stamp.
- **Godot's stamp writes `outletKind` always** (`""` for a custom outlet id with no kind, which
  resolves as `unknown`), and `outletSubkind` and `format` only when set. The Godot runner's
  stamp exports gain `kind.zip` and `nokind.zip`.

## Hand-off

- `detectOutlet` and the per-SDK readers. [P3-10](P3-10-godot-updater.md)'s outlet adapters
  consume the Godot detector (a dependency the graph does not yet show); P5-05 and P5-06 plug
  their native signals into the hooks named here.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-11 done` in the PR
  that completes the work.
