# Godot platform mechanics on 4.7.2 (S-05)

This is research code for [Godot on Polaris Key](../../README.md) that backs
[notes/S-05](../../notes/S-05-godot-platform-mechanics.md). It is not part of the green gate and not a published SDK.

Every probe runs as an **exported project on an official Godot 4.7.2-stable template**
(`ed1daf0bf`), because official 4.6+ templates ignore `--path`, `--script` and `--main-pack`
(godotengine/godot#111909). Test packs are generated, data-only PCKs (no `.gd`, no `.import`, no
`.godot/` caches) except in `f_uid/`, where the class-cache pack is the negative case.

## Environment of the recorded run (2026-09-30)

| Item          | Value                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Host          | Apple M5 Pro (18 cores), 64 GB, macOS 27.0 (26A428), Xcode 27.0                                                                |
| Engine        | Godot 4.7.2-stable official `ed1daf0bf`, official export templates                                                             |
| Android       | Emulator 37.1.11.0, AVD `capture`: Android 14 (`UE1A.230829.050`, google_apis arm64-v8a), 4 vCPU, 4 GB RAM, 8 GB data          |
| Android tools | Android Studio JBR, bundletool 1.18.3, `com.google.android.play:asset-delivery:2.3.0`                                          |
| Web           | Playwright-core 1.63.0: Chromium 153.0.8010.12 (build 1243), WebKit build 2359; iOS 26.5 Simulator Safari (iPhone 17e)         |
| Velopack      | `vpk` 1.2.161 (.NET 8), Rust crate `velopack = "=1.2.161"`                                                                     |
| Not available | Physical Android phone, Windows machine (MSIX, Velopack on Windows), Firefox (the Playwright build does not start on macOS 27) |

## What is here

| Path                         | What                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/gen_packs.py`         | streams a data-only PCK v4: `gen_packs.py <out.pck> <total_bytes> <entries> [prefix] [seed]`, plus a SHA-256 manifest                                                                                                                                                                                       |
| `tools/strip_pack.py`        | rewrites a PCK without `project.binary` and `.godot/global_script_class_cache.cfg` (what `--export-pack` always adds), keeping the source header; refuses v2, encrypted and sparse PCKs and verifies the rewritten directory                                                                                |
| `tools/editor_sc.sh`         | self-contained editor under `tpl/editor/` so Android exports use their own Java SDK setting                                                                                                                                                                                                                 |
| `tools/summarize_a.py`       | per-case medians of `out/a/results.jsonl`                                                                                                                                                                                                                                                                   |
| `tools/summarize_c.py`       | table of `out/c/runs.jsonl` (Playwright) and the `ios_*` rows of `out/c/reports.jsonl`, then a per-pack-count table (ready, fetch, ready + fetch, files at boot; iOS rows from batch `IOS_BATCH`)                                                                                                           |
| `tplrun_mac.sh`              | exports a project as a pack and runs it on the macOS release template as `<name>.app/Contents/Resources/<name>.pck`                                                                                                                                                                                         |
| `a_stall/`                   | (a) mount-stall probe: `probe/probe.gd` reads a JSON plan, animates a spinner, mounts, records call time and frame deltas                                                                                                                                                                                   |
| `a_stall/build_packs.sh`     | the (a) packs: 5, 50, 200 MB as 8 entries ("few") or 64 entries/MB ("many"), and `c20k` (5 MB in 20,000 entries)                                                                                                                                                                                            |
| `a_stall/export_apk.sh`      | release APK with a throwaway keystore (git-ignored)                                                                                                                                                                                                                                                         |
| `a_stall/run_a.sh`           | one case on a device or emulator (`DEV`, `PKG`); cold = `drop_caches` + force-stop, warm = force-stop only                                                                                                                                                                                                  |
| `a_stall/matrix_a.sh`        | the (a) matrix, three repetitions; `retry_a.sh` re-runs the cases adb dropped                                                                                                                                                                                                                               |
| `b_pad/build_pad.sh`         | (b) AAB: the (a) probe plus two asset packs (on-demand, fast-follow) and the `S05Pad` Java plugin; `--local-testing` APKs                                                                                                                                                                                   |
| `c_web/build_c.sh`           | (c) web export (single-threaded) and pack sets `w1` (1 × 50 MB), `w3` (3 × 33 MB), `w6` (6 × 25 MB)                                                                                                                                                                                                         |
| `c_web/server.mjs`           | serves the export and packs (`immutable` cache headers), counts pack GETs, collects the probe's reports                                                                                                                                                                                                     |
| `c_web/run_c.mjs`            | Playwright driver: per browser, mode and pack count a first visit, reload, browser restart, and an ephemeral context                                                                                                                                                                                        |
| `c_web/run_ios.sh`           | the same loads in the iOS Simulator's Safari (`simctl openurl`); erases Safari's website data before each mode and pack count and tags rows with `batch=`; 3 s after each report samples the page's WebContent `footprint` from the host into `out/c/ios_mem.jsonl` (`NS="0 1 3 6"` adds a 0-pack baseline) |
| `c_web/dlfile_demo.mjs`      | shows `HTTPRequest.download_file` losing the file on web                                                                                                                                                                                                                                                    |
| `c_web/dlprobe/`             | desktop control for the same `download_file` path (Content-Length and chunked)                                                                                                                                                                                                                              |
| `d_msix/game/`               | (d) Windows export (`s05msix.exe` + sidecar `s05msix.pck`) whose `run/main_loop_type` logs `user://`, the exe path and a write beside the exe, and carries a marker across phases                                                                                                                           |
| `d_msix/build_d.sh`          | exports 1.0.0 and 1.0.1 on the official Windows x86_64 release template (from macOS or Linux) and lays out `build/d/layout-<v>/` with `AppxManifest.xml`                                                                                                                                                    |
| `d_msix/AppxManifest.xml.in` | full-trust MSIX manifest template (`runFullTrust`, an `s05msix.exe` app execution alias, default virtualization)                                                                                                                                                                                            |
| `d_msix/run_d.ps1`           | on Windows (not run yet): `makeappx pack`, self-signed `signtool sign`, `Add-AppxPackage`, relaunch, update to 1.0.1, `Remove-AppxPackage`, reinstall; writes `out/d/summary.json`                                                                                                                          |
| `e_velopack/launcher/`       | Rust launcher shim: `VelopackApp::build().run()`, optional update from a local feed, then runs Godot beside it                                                                                                                                                                                              |
| `e_velopack/game/`           | Godot export whose autoload logs its arguments and quits from `_init` on a `--veloapp-*` hook                                                                                                                                                                                                               |
| `e_velopack/build_e.sh`      | builds `S05Game.app` (template + pack + launcher) and a `vpk pack` release of it                                                                                                                                                                                                                            |
| `e_velopack/time_hooks.py`   | spawns an executable with each hook as Velopack does and times it against the 30/15/15/30 s limits                                                                                                                                                                                                          |
| `f_uid/`                     | (f) a main project and three independently imported packs (`dataA`, `dataB`, `classpack`); `run_f.sh` runs all mount cases                                                                                                                                                                                  |

`out/`, `logs/`, `tpl/`, `build/`, exports, packs, APKs, AABs, keystores, browser profiles and the Rust
`target/` are git-ignored.

## Running

Set up Godot 4.7.2 with its export templates (`godot` on `PATH`; templates in
`~/Library/Application Support/Godot/export_templates/4.7.2.stable`). Then, from this directory:

```sh
# (f) UIDs and class cache (desktop, about a minute)
./f_uid/run_f.sh

# (a) Android stall: packs, APK, install, prep (copies the packs into user://), matrix
./a_stall/build_packs.sh && ./a_stall/export_apk.sh
DEV=emulator-5556 ./a_stall/run_a.sh install
DEV=emulator-5556 ./a_stall/run_a.sh case prep warm '"prep_copy":[["res://packs/p5_few.pck","user://packs/p5_few.pck"]]'  # one pair per pack
DEV=emulator-5556 ./a_stall/matrix_a.sh > logs/a_matrix.txt; ./a_stall/retry_a.sh > logs/a_retry.txt
python3 tools/summarize_a.py

# (b) Play Asset Delivery (Gradle build, bundletool local testing), then fetch + mount
DEV=emulator-5556 ./b_pad/build_pad.sh
PKG=org.polariskey.s05pad DEV=emulator-5556 ./a_stall/run_a.sh case pad_fetch warm '"pad":["s05ondemand","s05fastfollow"]'

# (c) web multi-pack
./c_web/build_c.sh && (cd c_web && npm install && node server.mjs &)
(cd c_web && node run_c.mjs browsers=chromium,webkit modes=idb,mem,cache chunk=4194304)
(cd c_web && MODES="idb mem cache" NS="0 1 3 6" BATCH=<tag> ./run_ios.sh <simulator-udid>)
IOS_BATCH=<tag> python3 tools/summarize_c.py

# (d) MSIX: build the two layouts here (any host), then on a disposable Windows 10 1903+/11 VM with
# the Windows SDK, from an elevated PowerShell in a copy of this directory:
./d_msix/build_d.sh
#   powershell -ExecutionPolicy Bypass -File d_msix\run_d.ps1      # -> out\d\summary.json

# (e) Velopack: launcher, two releases, hook timings, update end to end
(cd e_velopack/launcher && cargo build --release)
./e_velopack/build_e.sh 1.0.0 v1 launcher && ./e_velopack/build_e.sh 1.0.1 v2 launcher
python3 e_velopack/time_hooks.py godot_main_exe <path>/S05Game.app/Contents/MacOS/s05game
python3 e_velopack/time_hooks.py shim <path>/S05Game.app/Contents/MacOS/s05launcher
```

The web and Velopack runs need a desktop session (Playwright and `open -n` start GUI processes).
`d_msix/build_d.sh` and the probe were run on macOS (the export succeeds and the probe runs under
the editor); `d_msix/run_d.ps1` has not been executed or even parsed here (no Windows host and no
PowerShell on this machine), so expect to fix small things on its first run.
