> Research note for [Godot on Polaris Key](../README.md), 2026-09-30. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. The code is kept in
> [`prototype/platform-mechanics/`](../prototype/platform-mechanics/README.md).

# S-05 - Godot platform mechanics: Android pack stall, PAD paths, web multi-pack, MSIX `user://`, Velopack hooks, UIDs and class cache

Research date: 2026-09-30. Engine: **Godot 4.7.2-stable (official, `ed1daf0bf`)**, official export
templates; every probe runs as an exported project on a release template (official 4.6+ templates
ignore `--path`, `--script` and `--main-pack`, godotengine/godot#111909). Evidence tags as in the
other notes: [V] primary source read raw, [M] measured, [S] summary or secondary source, [I]
inference. Each result row is also labelled **measured** (real target), **emulated** (emulator,
simulator, headless browser engine or another OS standing in for the target) or **unmeasured**
(no run was possible here; the row gives a documented or inferred default).

## 1. Question

Six engine-level questions from [README §12](../README.md#12-risks-and-open-questions) and
[CONTENT §17](../CONTENT.md#17-open-questions-and-spikes) Q5, each of which changes a design already
written down (brief: [S-05](../program/wp/S-05-godot-platform-mechanics.md)):

- **(a)** How long does `ProjectSettings.load_resource_pack` block the main thread on Android, by
  pack size and entry count (godotengine/godot#105009)?
- **(b)** Can a Play Asset Delivery (PAD) pack be mounted from its absolute path?
- **(c)** How do several packs behave in a web export: memory, boot time, persistence?
- **(d)** Where does `user://` live in a full-trust MSIX package, and is the install directory writable?
- **(e)** Can Godot survive Velopack's lifecycle hooks, or is a launcher shim required?
- **(f)** Do UIDs from the main pack and several independently built data packs all resolve when
  mounted in order, and does a pack carrying a class cache wipe `class_name` globals?

## 2. Short answer

| Item | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Label                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| (a)  | The stall scales with **entry count, not bytes**. A 200 MB pack of 8 files mounts in ≤ 8 ms (median); 12,800 entries take 48 ms warm and 208 ms cold from `user://`; 20,000 entries take 46–755 ms (medians; single runs up to 1.5 s). Mounting from a `Thread` works but did not remove main-thread hitches. Mounting in `_ready` delays the first frame by about 1.1 s. **Default: one pack per frame after the first frame, packs ≤ 2,000 entries for spinner-time mounts; above that, mount only under a loading screen.**          | emulated (Android 14 emulator); phone: unmeasured |
| (b)  | **Yes.** `getPackLocation(name).assetsPath() + "/<name>.pck"` is a plain file under `/data/data/<pkg>/files/assetpacks/<pack>/<v>/<v>/assets/` (`STORAGE_FILES`); `load_resource_pack` mounts it (2.5–4.4 ms, 320/320 SHA-256 checks pass) for both on-demand and fast-follow packs. Install-time packs mount as `res://…pck`.                                                                                                                                                                                                          | emulated (`bundletool --local-testing`)           |
| (c)  | All three delivery paths mount fine (≤ 5 ms per pack) and every pack occupies JS memory once mounted. `user://` (IDBFS) persists but loads everything in it at every boot; the browser HTTP cache is not reliable (Playwright WebKit re-downloaded every time); **the Cache Storage API plus a non-`user://` MEMFS path** persisted across reload and browser restart in Chromium, WebKit and iOS Simulator Safari, with the fastest warm boots. `HTTPRequest.download_file` deletes the file on web in 4.7.2, so it is unusable there. | emulated (Chromium, WebKit, iOS Simulator)        |
| (d)  | From Microsoft's documentation: the install directory (`C:\Program Files\WindowsApps\<full name>`) is **read-only**; new files under `%APPDATA%` (where Godot's `user://` lives) are redirected to `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`, kept across package updates and **deleted on uninstall**. P3-10 must keep the sidecar swap disabled under MSIX.                                                                                                                                                                | unmeasured (no Windows host)                      |
| (e)  | Godot as `--mainExe` **survives**: all four `--veloapp-*` hooks reached `OS.get_cmdline_args()` and an autoload that quits from `_init` exited with code 0 in 1.0–1.7 s, well under the 15/30 s limits. But it starts the display server and a window for every hook. A 0.7 MB Rust shim answers in 7–11 ms and applies updates before Godot opens its pack. **Default: ship the shim.** An update replaces the whole app directory, so **a sidecar `.pck` beside the executable is deleted by every update**.                          | emulated (macOS); Windows: unmeasured             |
| (f)  | With `replace_files=true`, UIDs of the main pack and of two independently built packs all resolve (the in-memory UID registry is cumulative). With `replace_files=false` a pack's UIDs never register. `--export-pack` always adds `project.binary` and `.godot/global_script_class_cache.cfg` even to a script-free pack, and mounting such a pack with `replace_files=true` replaces the class cache: `get_global_class_list()` went from 6 to 0. Stripping those two entries fixes it.                                               | measured (macOS release template)                 |

## 3. Environment and method

| Item            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host            | Apple M5 Pro (18 cores), 64 GB, macOS 27.0 (26A428), Xcode 27.0; region: local only (every server was on `localhost`)                                                                                                                                                                                                                                                                                                                                                             |
| Android         | Emulator 37.1.11.0, AVD `capture`: Android 14 `UE1A.230829.050` google_apis arm64-v8a, 4 vCPU, 4 GB RAM. Three other emulators ran at the same time on the host (other work packages), so frame-time numbers are noisy; call times are the robust metric.                                                                                                                                                                                                                         |
| Android tooling | Official 4.7.2 Android template (release APK, throwaway keystore); for (b) the Gradle build template plus `com.google.android.play:asset-delivery:2.3.0`, bundletool 1.18.3 `build-apks --local-testing`                                                                                                                                                                                                                                                                          |
| Web             | Single-threaded web export (`variant/thread_support=false`, no extensions) with a custom HTML shell; served over `http://localhost:8765` (a secure context) with `cache-control: public, max-age=31536000, immutable` on packs. Playwright-core 1.63.0: Chromium 153.0.8010.12, WebKit build 2359 (headless); iOS 26.5 Simulator (iPhone 17e) Safari. Firefox 155 (Playwright build 1543) does not start on macOS 27 ("Could not find profile folder"), so Firefox is unmeasured. |
| Velopack        | `vpk` 1.2.161 on .NET 8, Rust crate `velopack = "=1.2.161"`; macOS release template (`macos.zip`) as `S05Game.app`                                                                                                                                                                                                                                                                                                                                                                |
| Packs           | Generated data-only PCK v4 files (`tools/gen_packs.py`: random incompressible entries plus a SHA-256 manifest). (a): 5/50/200 MB as 8 entries ("few") or 64 entries per MB ("many": 320, 3,200, 12,800), and `c20k` (5 MB in 20,000 entries). (c): `w1` = 1 × 50 MB, `w3` = 3 × 33 MB, `w6` = 6 × 25 MB, 64 entries each. After each mount the probes read three entries per pack and check their SHA-256.                                                                        |

Commands (from `prototype/platform-mechanics/`; the README lists every script):

```sh
./a_stall/build_packs.sh && ./a_stall/export_apk.sh && DEV=emulator-5556 ./a_stall/run_a.sh install
DEV=emulator-5556 ./a_stall/matrix_a.sh > logs/a_matrix.txt; ./a_stall/retry_a.sh; python3 tools/summarize_a.py
DEV=emulator-5556 ./b_pad/build_pad.sh
PKG=org.polariskey.s05pad DEV=emulator-5556 ./a_stall/run_a.sh case pad_fetch warm '"pad":["s05ondemand","s05fastfollow"],"verify":true'
./c_web/build_c.sh; (cd c_web && node server.mjs &)
(cd c_web && node run_c.mjs browsers=chromium,webkit modes=idb,mem,cache chunk=4194304)
(cd c_web && MODES="idb mem cache" ./run_ios.sh <udid>); python3 tools/summarize_c.py
./e_velopack/build_e.sh 1.0.0 v1 launcher && ./e_velopack/build_e.sh 1.0.1 v2 launcher
python3 e_velopack/time_hooks.py godot_main_exe .../S05Game.app/Contents/MacOS/s05game
python3 e_velopack/time_hooks.py shim .../S05Game.app/Contents/MacOS/s05launcher
./f_uid/run_f.sh
./d_msix/build_d.sh    # (d) builds the Windows layouts; d_msix/run_d.ps1 is for a Windows host (not run)
```

"Cold" in (a) means `echo 3 > /proc/sys/vm/drop_caches` plus a force-stop before the launch;
"warm" means a force-stop only. Each (a) case ran three times in `matrix_a.sh`; runs that adb lost
(the device dropped under load) were re-run by `retry_a.sh`, which appended rows 101–105 of
`out/a/results.jsonl`. So a case has n = 2 to 4: n = 2 where a run was lost and not recovered, and
n = 4 for `m_res_c20k` warm, which the retry ran twice. The tables below are `tools/summarize_a.py`
over all 108 rows; `out/a/summary.txt` gives n per cell.

## 4. Results

### 4.1 (a) Android `load_resource_pack` stall - emulated

The probe animates a spinner, mounts at frame 5 (or in `_ready`) and records the call's
main-thread time and every frame delta. Medians of two to four runs (min/max in brackets; n per
cell in `out/a/summary.txt`) [M]:

| Pack (entries)       | `user://` cold    | `user://` warm  | `res://` (APK assets) cold | `res://` warm   |
| -------------------- | ----------------- | --------------- | -------------------------- | --------------- |
| 5 MB few (8)         | 4.3 (2.7–5.8)     | 3.1 (0.2–14.5)  | 3.9 (3.8–40.3)             | 0.4 (0.2–0.5)   |
| 5 MB many (320)      | 3.3 (3.0–6.3)     | 1.1 (0.7–1.5)   | 2.2 (2.1–26.2)             | 0.8 (0.7–8.9)   |
| 50 MB few (8)        | 12.6 (8.2–16.9)   | 0.2 (0.2–0.2)   | 2.5 (1.8–7.5)              | 0.2 (0.2–0.4)   |
| 50 MB many (3,200)   | 18.4 (9.5–77.8)   | 7.6 (6.1–254.8) | 14.1 (7.4–106.0)           | 7.3 (7.2–87.0)  |
| 200 MB few (8)       | 8.3 (2.8–222.1)   | 0.2 (0.2–2.9)   | 1.5 (1.5–6.5)              | 0.2 (0.2–163.4) |
| 200 MB many (12,800) | 208.6 (128–289)   | 48.2 (47–50)    | 51.8 (50–53)               | 28.5 (25–32)    |
| 5 MB c20k (20,000)   | 156.4 (122–1,161) | 164 (118–380)   | 46.4 (38–376)              | 755 (138–1,465) |

All values are the `load_resource_pack` call in milliseconds; every mount returned `true` and passed
its SHA-256 checks (3/3).

- **Cost per entry** [M, I]: from `user://`, about 16 µs per entry cold and 4 µs warm (200 MB
  many); from APK assets about 4 µs cold and 2 µs warm. Bytes barely matter: 8 entries of 25 MB each
  mount as fast as 8 small ones. The `res://` c20k warm cell (n = 4: 138, 980, 1,465 and 530 ms;
  median 755 ms) is driven by host contention: the three slow runs reached their first frame 40 to
  107 s after launch, against about 5 s for the fast one, and the matching `user://` warm median is
  164 ms. Likewise the 163 ms maximum in the `res://` 200 MB few warm cell is a retry run whose
  frames stalled for up to 19 s [M, I].
- **Absolute external paths** work: `/sdcard/Android/data/<pkg>/files/packs/p50_many.pck` mounted in
  2.4 ms and `/storage/emulated/0/…` in 2.6 ms (warm) [M].
- **Six packs in six consecutive frames** (5 → 200 MB, `user://`, cold, median of two runs): the
  calls were 1.8, 2.6, 1.8, 7.9, 1.3 and 57.9 ms - only the 12,800-entry pack stood out [M].
- **In `_ready`, before the first frame** (200 MB many, warm): the call took 62–203 ms, but the
  first frame arrived 1.12–1.28 s late in all three runs, against 36–120 ms of worst hitch when the
  same pack is mounted at frame 5 [M].
- **From a `Thread`**: the mount succeeded and the data verified, but the main thread still hitched
  (worst frame 83–651 ms for 200 MB many cold, 110–289 ms for c20k warm, with one 5.4 s outlier on a
  contended host) - no better than a main-thread mount of the same pack. `PackedData` and the UID
  registry are not documented as thread-safe while the main thread loads resources [M, I].
- **Frame hitches**: the median worst frame is 13–230 ms even for the smallest packs, because the
  emulator shared the host with three other emulators; treat the hitch columns in
  `out/a/summary.txt` as noise and use the call times [M, I].

**The low-end phone multiplier is unmeasured.** No physical phone was available; S-04's low-end
device is the right one to repeat `matrix_a.sh` on (handoff). Until then assume a low-end phone is
3–5 times slower than this emulator per entry [I], which puts a 2,000-entry pack at roughly
30–160 ms cold from `user://`: one or several dropped frames, acceptable under a spinner.

### 4.2 (b) Play Asset Delivery paths - emulated

The AAB carries Godot's own install-time pack (`assetPackInstallTime`, holding `packs/p5_many.pck`)
plus two extra asset-pack modules, `s05ondemand` (on-demand) and `s05fastfollow` (fast-follow),
each with one 5 MB, 320-entry PCK. A 70-line Godot v2 plugin (`S05Pad.java`) exposes `fetch`,
`getStatus`, `getAssetsPath` and `getStorageMethod`. Installed with
`bundletool install-apks` from a `--local-testing` build [M]:

| Pack                          | Status after fetch | Fetch time (first, second launch) | `assetsPath()`                                                               | Storage             | Mount                                     | SHA-256 |
| ----------------------------- | ------------------ | --------------------------------- | ---------------------------------------------------------------------------- | ------------------- | ----------------------------------------- | ------- |
| `s05ondemand` (on-demand)     | 4 (COMPLETED)      | 110 ms, 55 ms                     | `/data/data/org.polariskey.s05pad/files/assetpacks/s05ondemand/1/1/assets`   | 0 (`STORAGE_FILES`) | `true`, 2.5–2.8 ms                        | 320/320 |
| `s05fastfollow` (fast-follow) | 4 (COMPLETED)      | 349 ms, 294 ms                    | `/data/data/org.polariskey.s05pad/files/assetpacks/s05fastfollow/1/1/assets` | 0 (`STORAGE_FILES`) | `true`, 4.1–4.4 ms                        | 320/320 |
| install-time (Godot's)        | -                  | -                                 | merged into APK assets                                                       | -                   | `res://packs/p5_many.pck`: `true`, 0.4 ms | 3/3     |

Before the first fetch `assetsPath()` was empty; on the second launch it was already set before
`fetch` was called (the pack stays on disk). The two path segments are the app's `versionCode`
(`1/1`) [M], so the path changes with every app update [I]. Real Play delivery (internal test track,
cellular confirmation dialog for packs over 200 MB, and the other storage method
`AssetPackStorageMethod.APK_ASSETS` (value 1; `STORAGE_FILES` is 0, both read with `javap` from the
2.3.0 AAR [V]), never seen here) is unmeasured (handoff).

### 4.3 (c) Web multi-pack - emulated

Three delivery paths, each with 1, 3 and 6 packs (50, 100 and 150 MB), run as a first visit, a
reload, a browser restart and (for 3 packs) an ephemeral context [M]:

- **idb**: `HTTPRequest` with the body in memory, written to `user://packs/` (IDBFS, persisted).
- **mem**: page JavaScript `fetch()` (browser HTTP cache), then `engine.copyToFS('/tmp/pk/…')`, a
  MEMFS path outside `user://`, then `load_resource_pack`.
- **cache**: as mem, but the page stores the response in the Cache Storage API (`caches.open`) and
  reads it back from there on later boots.

Time until every pack is in the filesystem ("fetch", ms; 0 = already in `user://` at boot), and
engine-ready time (`_ready`, ms since navigation start) [M]:

| Browser    | Path  | Fetch 1 / 3 / 6 packs, first visit    | Fetch 1 / 3 / 6, reload | Fetch 1 / 3 / 6, browser restart | Ready, range over all loads | Pack GETs on reload/restart |
| ---------- | ----- | ------------------------------------- | ----------------------- | -------------------------------- | --------------------------- | --------------------------- |
| Chromium   | idb   | 3,537 / 5,350 / 8,994                 | 0 / 0 / 0               | 0 / 0 / 0                        | 304–1,011                   | 0                           |
| Chromium   | mem   | 2,389 / 3,716 / 24,284                | 939 / 6,358 / 25,867    | 1,183 / 5,235 / 19,684           | 340–6,775                   | 0 (HTTP cache)              |
| Chromium   | cache | 5,722 / 1,152 / 2,037                 | 1,257 / 2,195 / 3,073   | 1,504 / 1,889 / 1,526            | 527–1,642                   | 0                           |
| WebKit     | idb   | 911 / 4,114 / 13,598                  | 0 / 1 / 1               | 0 / 1 / 1                        | 1,940–15,246                | 0                           |
| WebKit     | mem   | 1,929 / 1,207 / 5,062                 | 619 / 3,146 / 723       | 585 / 658 / 1,216                | 870–2,864                   | **all packs again**         |
| WebKit     | cache | 418 / 529 / 854                       | 106 / 169 / 250         | 184 / 159 / 284                  | 869–1,478                   | 0                           |
| iOS Safari | idb   | 512 / 736 / 1,461                     | 0 / 0 / 0               | 0 / 0 / 0                        | 634–2,811                   | 0                           |
| iOS Safari | mem   | 59 / 110 / 161 (cached from idb runs) | 51 / 118 / 171          | 55 / 103 / 152                   | 766–886                     | 0                           |
| iOS Safari | cache | 350 / 385 / 8,487                     | 131 / 205 / 459         | 143 / 348 / 544                  | 977–3,153                   | 0 (Cache Storage hits)      |

- **iOS rows left out of the table** [M]: `out/c/reports.jsonl` rows 49, 52 and 53 are idb, 1-pack
  `ios_first` loads from the first version of `run_ios.sh`, which opened the same URL each time (no
  `t=$RANDOM` query parameter). Their engine-ready times were 17,443, 3,786 and 36,601 ms. Row 49
  was a genuine cold first visit (fetch 3,510 ms, nothing in `user://` at boot); rows 52 and 53
  found the pack already in `user://`, so they were not first visits. Including them, the iOS idb
  "Ready" range is 634–36,601 ms and the 1-pack first-visit fetch 512–3,510 ms. They are excluded
  because the superseded driver cannot say which Safari process or navigation produced them.
- **Mount time** is trivial on every path: ≤ 1 ms per pack in Chromium, ≤ 5 ms in WebKit and
  ≤ 3 ms in iOS Safari; all SHA-256 checks passed (3/3 per pack, every load) [M].
- **Memory** (Chromium, V8 heap plus ArrayBuffer backing store after mounting, via CDP) [M]:

  | Path  | 1 pack (50 MB) | 3 packs (100 MB) | 6 packs (150 MB) |
  | ----- | -------------- | ---------------- | ---------------- |
  | idb   | 99–138 MB      | 110–176 MB       | 200–209 MB       |
  | mem   | 148 MB         | 175–176 MB       | 159–209 MB       |
  | cache | 148–167 MB     | 176–209 MB       | 209 MB           |

  Every path holds the mounted packs in JS memory (MEMFS); none maps them from disk. The wasm heap
  stayed at 40–115 MB. WebKit's process-group RSS was 0.97–1.76 GB on every path and pack count
  (the whole Playwright WebKit, not a per-page number), so WebKit memory is not separable here [M, I].

- **idb** keeps the whole of `user://` in memory from boot, including packs a session never mounts
  and superseded versions (Godot's IDBFS syncs all of it into MEMFS at start; A6 §2.6 [V], seen as
  `installed_at_boot` listing all 10 files, 300 MB, in the iOS runs) [M].
- **Persistence**: idb and cache both survived reload and browser restart in all three engines. The
  HTTP cache did in Chromium and iOS Safari but not in Playwright WebKit, which fetched every pack
  again on every load (`immutable` headers notwithstanding) [M].
- **Ephemeral ("private") contexts**: Chromium kept idb and Cache Storage across a reload and lost
  both in a new context. WebKit kept idb across a reload but re-downloaded from Cache Storage on the
  reload (3 GETs) [M]. Real private windows in Safari and Chrome are unmeasured.
- **`HTTPRequest.download_file` loses the file on web** in 4.7.2: in Chromium and WebKit the request
  reports success with 50,011,772 bytes downloaded, but the `.part` file is gone and the rename and
  mount fail. The desktop control (`c_web/dlprobe`) keeps the file both with a `Content-Length` and
  with a chunked body [M]. The cause (the web body arrives with unknown length) is inferred, not
  traced [I]; it is worth an upstream report.
- **iOS page reload under memory pressure** (the point at which Safari reloads the tab) cannot be
  produced on a simulator backed by 64 GB; unmeasured (handoff).
- **Firefox**: unmeasured (the Playwright Firefox build does not start on this macOS; handoff).

### 4.4 (d) MSIX `user://` and install-directory writability - unmeasured

No Windows host was available, so nothing was packaged or run. The probe for that run is ready:
`d_msix/build_d.sh` exports `s05msix.exe` plus a sidecar `s05msix.pck` on the official Windows
x86_64 release template (done here, from macOS [M]) and lays out two MSIX versions;
`d_msix/run_d.ps1` packs, self-signs, installs, relaunches, updates, uninstalls and reinstalls them
and records every row below into `out/d/summary.json` (not executed or parsed here). The documented
behaviour:

| Question                              | Documented answer                                                                                                                                                                                                                                                                                      | Tag           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Where `user://` points                | `%APPDATA%\Godot\app_userdata\<project>` (or `%APPDATA%\<name>` with `use_custom_user_dir`)                                                                                                                                                                                                            | [V]           |
| Where new files there really land     | Windows 10 1903+: "All newly created files and folders in the user's AppData folder … are written to a private per-user, per-app location; but merged at runtime to appear in the real AppData location." The physical location is `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\…`. | [V], path [S] |
| What `OS.get_user_data_dir()` returns | The unredirected `%APPDATA%\…` path: the app sees the merged view. Other processes (a crash reporter, Explorer) do not see the files there.                                                                                                                                                            | [I]           |
| An existing pre-MSIX `user://`        | Opened from the real AppData and modified in place ("If the file is opened from the real AppData location, then no virtualization for that file occurs"), so saves from an earlier unpackaged install carry over.                                                                                      | [V]           |
| Persistence across a package update   | Kept; redirected writes are removed only when the app is removed.                                                                                                                                                                                                                                      | [V, I]        |
| Cleanup on uninstall                  | Removed with the package: "any redirected writes to AppData … are removed". Saves are lost unless `desktop6:FileSystemWriteVirtualization` is disabled, which needs the `unvirtualizedResources` restricted capability.                                                                                | [V]           |
| Install directory writability         | "Writes under `C:\Program Files\WindowsApps\<package_full_name>` aren't allowed. The package is read-only."                                                                                                                                                                                            | [V]           |
| `OS.get_executable_path()`            | `C:\Program Files\WindowsApps\<PackageFullName>\<exe>` by default, but packages can be installed on other PackageVolumes, so the hint is the `\WindowsApps\` segment, not the drive                                                                                                                    | [V, I]        |

### 4.5 (e) Velopack hooks - emulated on macOS

Velopack runs the main executable with `--veloapp-install|obsolete|updated|uninstall <version>` and
kills it if it has not exited within 30/15/15/30 s [V]. `time_hooks.py` spawns each executable
exactly that way, five times per hook [M]:

| Main executable                                       | install                       | obsolete       | updated        | uninstall      | Exit code | Killed |
| ----------------------------------------------------- | ----------------------------- | -------------- | -------------- | -------------- | --------- | ------ |
| Godot 4.7.2 macOS template, autoload quits in `_init` | 1,167–1,618 ms                | 1,157–1,719 ms | 1,039–1,362 ms | 1,190–1,407 ms | 0         | never  |
| Rust shim (`VelopackApp::build().run()`)              | 8–9 ms (first 1,622 ms, cold) | 7–10 ms        | 9–11 ms        | 8–9 ms         | 0         | never  |

- The hook argument reached `OS.get_cmdline_args()` unchanged (`["--veloapp-install", "1.0.1"]`)
  and `OS.get_cmdline_user_args()` was empty; the engine did not reject the unknown argument [M].
- The autoload's `_init` ran 403–686 ms after process start and already saw a real display server
  (`DisplayServer.get_name() == "macOS"`, window size 1152 × 648): Godot creates its window before
  any script can quit, so every hook starts the renderer [M]. Whether the window is visible on
  Windows, and what a broken GPU driver does to a hook, is unmeasured.
- **Update end to end through the shim** (portable 1.0.0 → 1.0.1 from a local file feed): check,
  download and apply in 439 ms, `UpdateMac` replaced the bundle and relaunched, the shim logged
  "restarted 1.0.1", and Godot started with the new pack (marker `v2`) [M]. On macOS `UpdateMac`
  ran no hook during apply (none in its log) [M].
- **A sidecar `.pck` does not survive an update**: `hotfix.pck` placed in `Contents/MacOS/` (beside
  the executable) and in `Contents/Resources/` was gone after the update; a copy outside the bundle
  survived [M]. On Windows Velopack documents the same: "During updates, only the `current` folder
  is replaced", and "it's not safe to store settings, logs, etc in the `current` dir" [V].
- The Windows run (Godot's Windows template as `--mainExe`, `Update.exe` running the hooks, SmartScreen
  and file locks) is unmeasured (handoff).

### 4.6 (f) UIDs and class cache - measured

A main project (5 `class_name` scripts plus the probe) and three packs imported and exported
**independently** with `--export-pack`: `dataA` and `dataB` (a `.tres` and a `.tscn` each, with their
own UIDs, referencing the main pack's `base.tres` by UID) and `classpack` (a `class_name PackClass`
script) [M]:

| Case                             | UIDs: main / A / B / C | `get_global_class_list()` | Scenes by UID                   |
| -------------------------------- | ---------------------- | ------------------------- | ------------------------------- |
| nothing mounted                  | yes / - / - / -        | 6                         | -                               |
| A and B, `replace_files=true`    | yes / yes / yes / -    | **0**                     | both load; refs to main resolve |
| A `true`, B `false`              | yes / yes / **no** / - | 0                         | B only by path                  |
| A `false`, B `true`              | yes / **no** / yes / - | 0                         | A only by path                  |
| A, B, then classpack, all `true` | yes / yes / yes / yes  | 1 (`PackClass` only)      | all load                        |
| classpack `true`                 | yes / - / - / yes      | 1                         | -                               |
| classpack `false`                | yes / - / - / no       | 6                         | -                               |
| A and B **stripped**, `true`     | yes / yes / yes / -    | **6**                     | both load                       |

- `--export-pack` of a script-free project still writes seven entries: two exported resources, two
  `.remap` files, `.godot/uid_cache.bin`, **`project.binary`** and an 8-byte
  **`.godot/global_script_class_cache.cfg`** [M]. With `replace_files=true` the pack's class cache and
  `project.binary` replace the main pack's (md5 changes from `72abceb7` to `393edcca` and from
  `3ed850c5` to `6ecac325`), and `get_global_class_list()` drops from 6 to 0 - the same effect as
  Diceroll's 180 → 0 ([A4 §2.4](A4-diceroll-mapping.md#24-building-and-mounting-52)), caused by the
  always-added cache rather than by the scripts [M, I].
- `class_name` identifiers of the main pack still compiled after the mount, including in a script
  first compiled after it (`late_user.gd` using `MainA` and `MainE`) [M]. So the loss hits code that
  enumerates `get_global_class_list()` (plugins, registries, some addons), not ordinary GDScript [I].
- The UID registry is cumulative: `res://.godot/uid_cache.bin` itself is replaced by each pack's
  (281 B → 76 B), but the main pack's UIDs keep resolving [M].
- `tools/strip_pack.py` removing only `project.binary` and the class cache gives a pack whose UIDs
  still resolve and which leaves `get_global_class_list()` at 6 [M].

The brief's desktop control run of `prototype/patching/tplrun.sh` needs the Linux templates and
cannot run on macOS; `tplrun_mac.sh` is the macOS equivalent and `run_f.sh` was re-run with it on
2026-09-30 with identical results [M].

## 5. Recommendation (rules the named briefs adopt)

**(a) → P1-10, P4-08, P4-03.** "`PKeyBoot`'s MOUNT stage starts after the first frame has been drawn and
mounts at most one pack per frame, on the main thread (not from a `Thread`). Mount time grows with a
pack's entry count, not its size (about 16 µs per entry cold from `user://` on an Android 14
emulator). Packs of up to 2,000 entries may be mounted while the spinner runs; larger packs are
mounted only while a loading screen is shown. The `godot.pck` lint in `pkey release publish` warns
above 2,000 entries per pack and fails above 20,000." Replace the defaults with the low-end phone's numbers when the device run lands.

**(b) → P5-06, P5-08.** "A PAD pack named `<pack>` ships one PCK at `<pack>/src/main/assets/<pack>.pck`.
After `AssetPackManager.fetch` reports `COMPLETED`, mount
`getPackLocation(<pack>).assetsPath() + "/<pack>.pck"` with `ProjectSettings.load_resource_pack`. The
path is a plain file under the app's internal storage (`STORAGE_FILES`); re-read it on every launch,
because it contains the app's `versionCode`, and never persist it. Install-time packs are merged
into the APK's assets and mount as `res://<path>.pck`. Treat
`AssetPackStorageMethod.APK_ASSETS` (value 1) or an empty `assetsPath()` as not available."

**(c) → P4-08, D-04.** "On web, packs never go to `user://`. The shell (or a head include) fetches
each pack by its content-addressed URL through the Cache Storage API, copies the bytes into a MEMFS
path outside `user://` (`/pkey/packs/<sha256>.pck`) with the engine's `copyToFS`, and GDScript mounts
that path. `user://` holds only small state. Do not use `HTTPRequest.download_file` on web. Every
mounted pack costs its full size in JS memory, so the web build caps the total mounted pack bytes
(default 150 MB on mobile browsers and 300 MB on desktop, until device numbers exist) and treats a
Cache Storage miss as a normal re-download."

**(d) → P3-10, P5-07, S-06 / P3-11.** "Under MSIX (executable path contains `\WindowsApps\`, or the
GDExtension reports a package identity) the sidecar-PCK swap is off and every self-updater is off.
`user://` works unchanged, but it is virtualized to `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming`,
is kept across package updates and is deleted on uninstall; the product's docs page says so, and any
path handed to another process uses the physical location." Keep the default virtualization; turning
it off needs a restricted capability.

**(e) → P3-10, P5-07.** "Velopack builds ship the launcher shim as `--mainExe`: it runs
`VelopackApp::build().run()` (hooks answered in milliseconds without starting the engine), applies a
downloaded update, then starts Godot with the same arguments. As a fallback, a Godot export may be
the main executable if an autoload quits from `_init` on any `--veloapp-*` argument (measured at
1.0–1.7 s per hook). Under Velopack the sidecar-PCK swap is off, because an update replaces the
whole app directory; runtime packs live in `user://`."

**(f) → P4-08, P4-03, D-04.** "Data packs are mounted with `replace_files=true`, in `mountOrder`.
A `godot.pck` payload may contain only: (1) entries under one of the deliverable's
`handler.prefixes`, including their `.remap` and `.import` files; (2) the `.godot/exported/…` and
`.godot/imported/…` files that those `.remap` and `.import` files point to; and (3)
`.godot/uid_cache.bin`, which is what makes the pack's `uid://` references resolve. Everything else
is rejected with its path, in particular `project.binary`, `.godot/global_script_class_cache.cfg`,
scripts (`.gd`, `.gdc`, `.cs`, and a `.remap` that points to one), native libraries and
`.gdextension` files. `--export-pack` always adds `project.binary` and
`.godot/global_script_class_cache.cfg`, even to a project with no scripts, so
`pkey release publish --deliverable <packId>` removes exactly those two entries from a `godot.pck`
payload before it lints, hashes and indexes it, and writes the stripped PCK back in place, so an
embedded copy is the one its marker pins. The publish lint and the device-side directory check
apply the same list; the directory check refuses a pack that still carries either file. `uid://`
references into a pack are allowed once it is mounted. With `replace_files=false` a pack's UIDs
never register, so only UID-free packs may use it."

Evidence for each clause: the admitted `.remap`, `.godot/exported/…` and `uid_cache.bin` entries
are exactly what `--export-pack` wrote for `dataA` and `dataB` (§4.6) and they resolved by UID
after stripping [M]; `.import` plus `.godot/imported/…` is the texture case A6 and A7 exported
[M, from those notes]; the script denylist is the `classpack` case (`pack_class.gdc` plus
`pack_class.gd.remap`) [M]. A `.godot/exported/` or `.godot/imported/` file that no in-prefix
`.remap` or `.import` names is rejected, because nothing in the pack could load it [I].

## 6. Briefs changed

Edited in this branch: [P1-10](../program/wp/P1-10-godot-ui-kit.md), [P3-10](../program/wp/P3-10-godot-updater.md),
[P4-03](../program/wp/P4-03-ci-patch-artifacts.md) (the (f) admission list, the strip step, the
`uid_cache.bin` answer and the (a) entry-count lint), [P4-08](../program/wp/P4-08-godot-packs.md)
(mount pacing, the web pack path, the (f) rule and `replace_files=true`),
[P5-06](../program/wp/P5-06-kotlin-aar.md), [P5-07](../program/wp/P5-07-desktop-plugins.md),
[P5-08](../program/wp/P5-08-platform-pack-transports.md), [D-04](../program/wp/D-04-diceroll-after-p4.md)
and [S-05](../program/wp/S-05-godot-platform-mechanics.md) (the macOS control run in Verify).

Proposed for the lead, not edited:

- `workpackages.json`: add `S-05` to P4-03's `deps` (and its header row), since P4-03 now carries
  S-05's lint rules; regenerate `INDEX.md`.
- README §5.7 and §12: drop (b), (e) and (f) from the unverified list; state the web pack path
  (Cache Storage into a non-`user://` MEMFS path); replace "no `uid://` into packs" with the (f)
  rule (`uid://` into a stripped pack mounted with `replace_files=true` works).
- README §5.7 / A6 §6's "`replace_files=false` for full, disjoint-prefix, UID-free packs": the (f)
  rule makes `true` the default for every data pack; `false` stays allowed only for UID-free packs.

## 7. Open items (handoff)

| Row                                                                                     | Why not here                           | Default until then                |
| --------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| (a) on a physical low-end Android phone (cold and warm)                                 | no phone                               | the 2,000-entry rule, 3–5× margin |
| (b) PAD delivered by Play (internal track), `APK_ASSETS` storage, >200 MB dialog        | Play Console account                   | the (b) rule                      |
| (c) Firefox; real iOS Safari memory ceiling and tab reload; private windows             | Firefox does not start here; no iPhone | 150 MB mobile cap, Cache Storage  |
| (d) the whole MSIX row set: run `d_msix/build_d.sh`, then `d_msix/run_d.ps1`            | no Windows host                        | the (d) rule from documentation   |
| (e) Velopack on Windows: Godot's window during hooks, `Update.exe`, file locks, sidecar | no Windows host                        | ship the shim                     |

## 8. Sources

- Microsoft, "Understanding how packaged desktop apps run on Windows" (updated 2026-01-28):
  https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes [V]
- Microsoft, "Flexible virtualization": https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization [V]
- Microsoft, "MSIX troubleshooting guide" (the `LocalCache` container):
  https://learn.microsoft.com/en-us/windows/msix/msix-troubleshooting-guide [S]
- Advanced Installer, "User settings and data associated with a package" (the `LocalCache\Roaming`
  path shape): https://www.advancedinstaller.com/application-packaging-training/msix-packaging/ebook/user-settings-data-associated.html [S]
- Godot docs, "File paths in Godot projects": https://docs.godotengine.org/en/stable/tutorials/io/data_paths.html [V]
- Velopack, "App hooks": https://docs.velopack.io/integrating/hooks [V]; "Overview" (install
  layout and `current`): https://docs.velopack.io/integrating/overview [V]
- godotengine/godot#105009 (Android `load_resource_pack` stall), #111909 (templates ignore
  `--main-pack`)
- Internal: [A6 §2.6–§2.7](A6-godot-patching.md#26-web-source-level-not-run),
  [A4 §2.4](A4-diceroll-mapping.md#24-building-and-mounting-52),
  [E2 §A3](E2-android.md#a3-play-asset-delivery-pad-play-feature-delivery-and-godot-4),
  [E3 §A1, §A3](E3-windows-linux-web.md#a1-microsoft-store)
- Raw data (git-ignored, regenerated by the scripts): `out/a/results.jsonl`, `out/a/summary.txt`,
  `out/c/runs.jsonl`, `out/c/reports.jsonl`, `out/e/*.jsonl`, `logs/f_case_*.txt`
