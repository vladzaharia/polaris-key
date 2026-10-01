# P3-10 Godot updater: outlet adapters, sidecar-PCK swap, boot guard, Velopack and Sparkle hooks

| Field       | Value                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                                                                                                                       |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                             |
| Depends on  | [P3-08](P3-08-v4-godot.md), [P3-09](P3-09-updater-feeds.md), [P3-11](P3-11-outlet-detection.md), [P1-10](P1-10-godot-ui-kit.md), [P1-11](P1-11-godot-export-plugin.md), [S-05](S-05-godot-platform-mechanics.md) |
| Unblocks    | [P4-08](P4-08-godot-packs.md), [P5-05](P5-05-apple-plugin-package.md), [P5-06](P5-06-kotlin-aar.md), [P5-07](P5-07-desktop-plugins.md), [D-03](D-03-diceroll-after-p3.md)                                        |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                                               |
| Gates       | none in the graph; `stage-matrix.json` boot-guard rows must already exist (planned in P3-01, emitted by P3-02), else this is a corpus change that needs a plan first                                             |
| Human input | none required. A Windows machine or CI runner to measure the sidecar rename                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                        |

Milestone: **Diceroll deletes its own updater and feed scripts** (with [D-03](D-03-diceroll-after-p3.md)).

## Goal

The Godot SDK acts on the verified update decision correctly for every outlet, without
`--main-pack`. Each outlet id has an adapter: store and sideload outlets open the right listing or
deep link; platform outlets (Steam, itch, Flathub, Snap, App Installer) stay silent and web
offers a reload; direct desktop builds hand off to Sparkle, Velopack or WinSparkle through GDScript hook interfaces, or
swap a verified sidecar `.pck` on writable portable installs; AppImage builds call
AppImageUpdate. A boot guard with staged, current and previous slots rolls back after two failed
boots and never re-offers the bad version. `PKeyBoot` runs the guard in `GUARD` and the decision
in `DECIDE`.

## Why

Official Godot 4.6+ templates ignore `--main-pack`, `--path`, `--scene` and `-s`
(godotengine/godot#111909, merged 2025-11-12), so Diceroll's relaunch at
`game/update/updater.gd:313` most likely never applies a code pack in shipped desktop builds
([README §0.4](../../README.md#04-findings-that-should-change-plans-now) #1,
[§9.2](../../README.md#92-diceroll-for-the-diceroll-side) #1). The research picks full-app
updaters with deltas first and a sidecar-PCK swap for portable installs
([README §5.6](../../README.md#56-code-updates-without---main-pack),
[§11](../../README.md#11-decisions-needed) decision 6). Capabilities must come from the outlet, not the game, because Diceroll's Steam and
itch builds run its updater today ([README §4.7](../../README.md#47-steam-and-itch),
[§5.5](../../README.md#55-distribution-layer-one-build-any-outlet)).

## Read first

- `AGENTS.md`; `.claude/agents/pkey-godot-engineer.md` (templates, pack mount semantics, HTTP).
- [README §5.5, §5.6](../../README.md#55-distribution-layer-one-build-any-outlet),
  [§5.8](../../README.md#58-ui-kit-and-pkeyboot) (stages),
  [§5.10](../../README.md#510-native-plugins-optional-each-behind-a-gdscript-interface-with-stubs)
  (hooks with stubs; missing plugins never break boot), §4.3–§4.7 (what each outlet needs),
  [§6.3](../../README.md#63-player-end-user) (in-game experience per outlet).
- [notes/A4 §1.5, §1.6, §4.1 and §5](../../notes/A4-diceroll-mapping.md): Diceroll's slots,
  `boot_attempts`, `BOOT_OK_SECONDS = 10`, rename retries (12 × 250 ms), the decision and its
  invariants P9–P13, and the list of files Diceroll deletes.
- [notes/E3](../../notes/E3-windows-linux-web.md) §A3 (Velopack hooks and the launcher shim;
  WinSparkle needs a GDExtension; a signed exe cannot have a PCK appended, so use a sidecar),
  §B1 (AppImage: `APPIMAGE`, `appimageupdatetool`); [notes/E4](../../notes/E4-godot-ecosystem.md)
  (self-update in Godot).
- `sdks/godot`: P3-08's `distribution/decision.gd` and update service; P1-02's transport and
  persistence; [P1-10](P1-10-godot-ui-kit.md)'s `PKeyBoot` shell;
  [P1-11](P1-11-godot-export-plugin.md)'s build stamp.
- [P3-09](P3-09-updater-feeds.md)'s feed routes (Sparkle, WinSparkle, Velopack, zsync).

## Scope

**In:**

- **Outlet adapters** in `distribution/outlets/`, one per outlet id in the plan, behind one
  interface (proposed `PKeyOutletAdapter`: `id()`, `capabilities()`,
  `apply(decision) -> result`). `store` opens the decision's listing or deep link; `platform`
  shows the outlet's own message; `binary` dispatches on `method`.
- **Native hook interfaces** in the mechanism scripts README §5.1 names
  (`distribution/outlets/{sparkle,velopack}.gd`, plus `winsparkle.gd`), which
  [P5-07](P5-07-desktop-plugins.md) expects (proposed classes `PKeySparkleBridge`,
  `PKeyVelopackBridge`, `PKeyWinSparkleBridge`): `is_available()`, `check_now()`,
  `install_and_relaunch()`, with feed URLs from discovery. Stubs return the typed unsupported result (`dependency`), and the adapter
  falls back to a download link.
- **AppImage**: when `APPIMAGE` is set and `appimageupdatetool` is available, run it through
  `OS.execute` and restart; otherwise a download link.
- **Sidecar-PCK swap** in `updater/sidecar_swap.gd`: download the release's `pck` build (from the
  URL the plan names, for example distribution by content hash) with Range resume through P1-02's
  transport, verify size and SHA-256 against the verified record, stage
  it, and at restart replace `<exe-name>.pck` beside the executable, keeping the old one as
  previous; `OS.set_restart_on_exit`. Refuse where the directory is not writable, inside a macOS
  `.app`, under `Program Files`, in MSIX, Flatpak or Snap installs, and in Velopack installs (S-05
  §4.5: an update replaces the whole app directory, and a sidecar beside the executable was deleted
  by the first update). Detect MSIX when `OS.get_executable_path()` contains a `WindowsApps` path segment
  (Godot returns `/` on Windows; compare case-insensitively on either separator, and give the fake
  a `C:/Program Files/WindowsApps/...` path) (S-05 §4.4);
  the MSIX install directory is read-only by design.
- **Slots and boot guard** in `updater/slots.gd` and `updater/boot_guard.gd`: staged, current and
  previous under `user://pkey/<product>/updates/` with a meta file (version, build number, record
  hash, SHA-256, size, engine); count launches, confirm after `BOOT_OK_SECONDS` or an explicit
  `confirm_boot()`, roll back after two failed boots, record the skipped version as a decision
  input; drop staged code on a channel switch, on an engine change, and when the binary is not
  older than it (A4 P10, P11).
- **`PKeyBoot`**: `GUARD` applies a staged swap or rolls back; `DECIDE` calls `decide()` and the
  outlet adapter. `PKeyUpdatePrompt` shows the per-outlet experience of README §6.3, including one
  clear screen for a mandatory floor.
- **Dev-menu channel picker**: "locked by <outlet>" where `channelSwitch` is false.
- **Telemetry**: report `boot_rolled_back` through `devices/report` if the key is allowlisted
  (P1-05); otherwise keep it local and note it for P6-03.
- Tests and the Godot docs page section "Updates by outlet"; `sdks/godot/parity.json`
  (`update.driver`, `update.bootguard`).

**Out** (and where it belongs instead):

- The native plugins behind the hooks, and Velopack's launcher shim
  (→ [P5-07](P5-07-desktop-plugins.md)); the iOS in-app store sheet
  (→ [P5-05](P5-05-apple-plugin-package.md)); Play In-App Updates and `PackageInstaller`
  (→ [P5-06](P5-06-kotlin-aar.md)).
- Outlet detection signals (→ [P3-11](P3-11-outlet-detection.md)); this package takes the outlet
  from the build stamp and, once it exists, the detector.
- Packs, pack mounts and delta-baked code packs (→ [P4-08](P4-08-godot-packs.md)); P3 downloads
  the full `pck` build.
- Changing Diceroll (→ [D-03](D-03-diceroll-after-p3.md)); the update funnel and auto-halt
  (→ [P6-03](P6-03-update-funnel-autohalt.md)).

## Design notes

- **Never relaunch with `--main-pack`, `--path`, `--scene` or `-s`.** Custom export templates are
  the only way to keep them, and the SDK does not support that path (README §5.6 option 3).
  Override packs at `_init()` are not used for code (option 4).
- **Adapters are per outlet, mechanisms are not outlets.** README §5.1's file list mixes outlet
  ids (`app_store`, `steam`) with updater mechanisms (`velopack`, `sparkle`, `appimage`, `apk`).
  Key the adapters on the README §3.1 outlet ids the plan fixes (`direct.gd`, `app_store.gd`,
  `ms_store.gd`, …), and keep the mechanisms as the bridge scripts that `binary.method` reaches.
- **Guard rows come from the plan.** [P1-09](P1-09-boot-stage-machine.md) leaves the boot-guard
  rows of `stage-matrix.json` to this package "under its own plan". P3-01 is asked to plan them
  (its item 20) so P3-02 emits them. If they are missing when you start, stop and escalate:
  adding them here would make this a corpus-touching, plan-mode change.
- **Capabilities only narrow.** The compiled outlet defaults from P3-08 are the ceiling; the feed
  can lower them. A store, Steam or itch build can never be talked into self-updating code.
- **Verify, then act.** Godot never checks a PCK's own hashes, so the SDK verifies the staged file
  against the record before the swap and again at boot (size and SHA-256), as Diceroll does.
- **Windows rename risk.** The engine opens `<exe>.pck` at start-up, before any script runs. If
  Windows refuses to rename the open file, a boot-time swap would only apply one launch later.
  Measure it. If rename fails, use a detached helper (`OS.create_process`) that waits for the
  game to exit, swaps and relaunches, or accept a second restart; record the choice and the
  measurement in the PR. Linux renames an open file without trouble.
  [D-01](D-01-diceroll-now.md) makes the same swap in Diceroll first and records the Windows
  behaviour; start from its result.
- **MSIX `user://`** (S-05 §4.4, from Microsoft's documentation; not run on Windows): `user://`
  works unchanged but is virtualized to `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`,
  is kept across package updates and is deleted on uninstall. Slots and the boot guard under
  `user://` therefore work in MSIX builds; say on the docs page that uninstalling removes them.
- **Velopack** (S-05 §4.5): ship the launcher shim as `--mainExe`. Godot as the main executable
  also survives the hooks (1.0–1.7 s per hook when an autoload quits from `_init`, limits 15/30 s),
  but starts its renderer and window for each hook; keep that only as a documented fallback.
- **The sidecar keeps the executable's hash stable**, which keeps its SmartScreen reputation across
  code updates (notes/E3 §A3.3).
- **HTTP rules from P1-02**: follow redirects manually without `Authorization` on a host change,
  turn gzip off for Range, append with `HTTPClient` to resume.
- **Inert where Diceroll's updater is inert**: in the editor, in headless test runs and in dev
  builds, unless a test enables it.

## Steps

1. Confirm P3-08 and P3-09 are `done`, and that P1-10 and P1-11 have landed (not graph
   dependencies, but this package wires into them); branch `wp/P3-10-godot-updater`.
2. Adapter interface and adapters, with hook stubs; mapping tests per outlet.
3. Slots and boot guard, with rollback tests.
4. Sidecar swap on Linux; then measure and settle Windows.
5. `PKeyBoot` stages, prompt states, dev-menu lock.
6. Docs, `parity.json`. Set `in-review`.

## Acceptance criteria

- [ ] For every outlet id in the plan, a test maps each decision action to the adapter's behaviour
      (link opened, hook called, sidecar staged, or silent).
- [ ] A verified staged `pck` replaces `<exe-name>.pck` and the old file becomes previous; a size or
      hash mismatch changes nothing; the swap is refused in the unsupported locations above.
- [ ] Two failed boots roll back to previous and record the skipped version; the next decision does
      not offer it; a confirmed boot resets the counter.
- [ ] Staged code is dropped on a channel switch, an engine change, or a binary at least as new.
- [ ] With no native plugin installed, `binary` with `method: native` degrades to a download link and
      boot continues.
- [ ] The Godot stage machine passes the boot-guard rows of `stage-matrix.json`.
- [ ] No SDK code passes `--main-pack`, `--path`, `--scene` or `-s` (a test greps the addon).
- [ ] Windows rename behaviour is measured and the chosen approach recorded in the PR.
- [ ] The Godot CI job passes on the editor and a release template; the green gate passes for the
      parts touched.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
# P1-01's runner: the editor, then a release template
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
# only explanatory comments may mention the relaunch flags
grep -rn -e '--main-pack' -e '"--path"' -e '"--scene"' sdks/godot/addons/polaris_key
```

## Hand-off

- `PKeyOutletAdapter` and the three bridge interfaces, which [P5-07](P5-07-desktop-plugins.md)
  implements for Sparkle, Velopack and WinSparkle, [P5-05](P5-05-apple-plugin-package.md) for the
  iOS store sheet and [P5-06](P5-06-kotlin-aar.md) for In-App Updates and `PackageInstaller`.
- The slot store and boot guard, which [P4-08](P4-08-godot-packs.md) extends so a binary and its
  pack set roll back together.
- For [D-03](D-03-diceroll-after-p3.md): Diceroll deletes `game/update/*` and its six suites,
  `tools/ci/update_manifest.py`, the `channels` release and the distribution half of
  `stamp_version.py` (notes/A4 §4.1), and takes feeds from [P3-09](P3-09-updater-feeds.md).
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-10 done` in the PR
  that completes the work.
