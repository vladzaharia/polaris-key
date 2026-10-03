> Research note for [Godot on Polaris Key](../README.md), 2026-10-03. Spike S-11
> ([brief](../program/wp/S-11-desktop-updaters.md)). A working paper kept for its evidence and
> sources; the README synthesis is the cross-checked position. The probes are kept in
> [`S-11-desktop-updaters/`](S-11-desktop-updaters/) beside this note. Scratch paths, home
> directories and runner user names are removed from quoted observations. No signing certificate,
> Partner Center app or other account was used.

# S-11: Sparkle, Velopack, WinSparkle and StoreContext from a Godot desktop app

Run 2026-10-02/03. The macOS parts ran on a local machine; the Windows parts ran on GitHub's
`windows-latest` runner through a temporary workflow on a throwaway branch (`spike/S-11-windows`,
deleted after the last run; no secrets, push trigger on that branch only). The feed side is the
Worker's own code: every appcast and Velopack feed below was rendered by
`packages/worker/src/services/update/updaterRender.ts`, and every `sparkle:edSignature` was checked
with the Worker's streaming verifier (`verifyEd25519OverBytes` in `services/release/sparkle.ts`)
before it was listed, as the Worker does with CI's `.sig` sidecars. No product code changed.

Evidence tags, as in [S-02](S-02.md):

- **[M]**: measured here on the real target (macOS 27 on Apple silicon; Windows Server 2025 on the
  hosted runner);
- **[E]**: emulated: measured, but against a stand-in for the production setup (a local static
  server instead of the deployed Worker; an unsigned, developer-mode MSIX registration instead of a
  signed Store install);
- **[D]**: read in the vendor's documentation or source code;
- **[U]**: unmeasured: needs a signing certificate, notarisation, a Partner Center app or a device
  this spike did not have; the owner checklist in §7 lists each one;
- **[I]**: inference or recommendation.

## 1. Question

The brief asks five things before P5-07 builds the desktop update plugins:

1. Can a Godot GDExtension drive Sparkle 2 against the Worker's appcast and
   `sparkle:edSignature`, and what do EdDSA verification, the installer helper (unsigned vs
   ad-hoc-signed app) and the sandbox require?
2. Can a Godot Windows export be packaged with Velopack (full and delta) against the Worker's
   Velopack feed, and driven by WinSparkle against the WinSparkle feed? What does each need from
   Polaris Key's feeds?
3. What `StoreContext` calls do P5-07 and P5-04 need, what can an unpackaged app call, and what
   needs a Partner Center app?
4. GDExtension or helper process; threading; how CI builds it.
5. What must still be measured with signing certificates?

## 2. Short answer

| #   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | **Go.** A 1.2 MB universal GDExtension (godot-cpp 10.0.0, Objective-C++, Sparkle 2.10.0 weak-linked) updated an exported Godot 4.7.2 app from 1.0 to 1.1 through the Worker-rendered appcast: delta and full, EdDSA-verified, Godot quit cleanly on Sparkle's terminate request, relaunched into the new build. Open-to-relaunched took 4.2–4.7 s (n = 9). Two export defects must be fixed by P5-07's export plugin: Godot's `[dependencies]` copy **drops the executable bit** on four of Sparkle's five Mach-O files, and exporting with code signing **disabled** leaves the template's Developer ID signature on a modified bundle, so Sparkle rejects every update to that app. A forged or missing signature is rejected, but only **after** the full archive has downloaded. The `Authorization` header is sent to the feed and the bytes, and **dropped on a cross-origin redirect**. Sandboxed builds stayed unmeasured. | [M], [E], [U] |
| 2   | **Go, with one Worker fix.** Velopack: the shim plus a GDExtension over `velopack_libc` checked, downloaded a 5.6 KB delta (instead of 44.8 MB), applied on exit and restarted into 1.0.1 in 6.95 s, **but only with a feed whose `FileName` is a bare file name**. With the Worker's feed as rendered today (`FileName` = absolute URL), the Rust/C/C++ Velopack client downloads the bytes and then fails with Windows `os error 123`, because it writes the package to `packages_dir.join(FileName)`. WinSparkle: a GDExtension over a runtime-loaded `WinSparkle.dll` checked, downloaded, verified EdDSA, asked Godot to quit and ran the Inno Setup installer with the feed's `/SILENT /SP- /NOICONS`; the relaunched build reported 1.0.1 after 6.2–6.6 s. Velopack hooks answered in 9 ms from the shim and in 455–487 ms from Godot itself.                                                                               | [M], [D]      |
| 3   | The P5-07 calls are `GetAppAndOptionalStorePackageUpdatesAsync`, `RequestDownloadAndInstallStorePackageUpdatesAsync`, `TrySilentDownload(AndInstall)StorePackageUpdatesAsync` and `CanSilentlyDownloadStorePackageUpdates`, after `IInitializeWithWindow`. Unpackaged, `GetCurrentPackageFullName` returns 15700 (`APPMODEL_ERROR_NO_PACKAGE`) and the update query throws `0x803F6101`. With package identity but no Store association (an unsigned developer-mode registration), the query throws `0x80070002` and the product lookup returns `0x803F6107`. Real update results need a Store-associated package, which is a Partner Center app. P5-04 needs nothing from the device.                                                                                                                                                                                                                                             | [M], [E], [D] |
| 4   | **GDExtension, one per OS, C++ on godot-cpp 10.0.0**, plus the Rust shim on Windows for Velopack hooks. Sparkle needs the main thread (Godot's main thread is AppKit's, so `_ready` is fine); WinSparkle and Velopack call back on their own threads, so every callback goes through `call_deferred`; StoreContext's blocking `.get()` needs an MTA worker thread. CI: the godot-cpp build takes 97 s on the macOS host and 287–503 s on `windows-latest` uncached, 28 s cached. The Windows build needs SCons ≥ 4.11 for Visual Studio 2026, C++20 for the C++/WinRT file, and `velopack_libc.dll` under that exact name.                                                                                                                                                                                                                                                                                                         | [M]           |
| 5   | Developer ID signing, notarisation and Gatekeeper of the Sparkle helpers; Sparkle's code-signing match between a Developer-ID old and new build; Authenticode or Artifact Signing of shim, DLLs and installers, with SmartScreen; Velopack `--signParams`; a signed MSIX installed from the Store and every StoreContext result. §7 is the owner checklist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [U]           |

**Go/no-go for P5-07: go.** It is blocked on nothing measurable here. Before its Velopack step
lands, the Worker's Velopack feed must stop emitting absolute `FileName` values (§5.1). The P5-07
brief is updated in this branch (§9).

## 3. Environment and method

| Item      | macOS (local)                                                                                                                                                                               | Windows (`windows-latest`)                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host      | Apple M5 Pro (18 cores), 64 GB, macOS 27.0 (26A428), Xcode 27.0, Apple clang 21.0.0; region: local only (every server on `127.0.0.1`/`localhost`)                                           | Windows Server 2025 Datacenter 10.0.26100, 4 vCPU (AMD EPYC 7763 or Intel Xeon Platinum 8573C, by run), 16 GB, image `win25-vs2026 20260925.250.1`, MSVC 14.51 (VS 2026); interactive console session present |
| Godot     | 4.7.2-stable official (`ed1daf0bf`), official macOS release template, universal                                                                                                             | 4.7.2-stable official, `windows_release_x86_64.exe` template, embedded PCK, Compatibility renderer                                                                                                            |
| Binding   | godot-cpp 10.0.0-stable (`api_version=4.7`, `template_release`, universal), SCons 4.11.1                                                                                                    | godot-cpp 10.0.0-stable (`api_version=4.7`, `disable_exceptions=no`, `use_mingw=no`), SCons 4.11.1                                                                                                            |
| Updaters  | Sparkle 2.10.0 (`Sparkle.framework`, `sign_update`, `BinaryDelta`)                                                                                                                          | Velopack 1.2.161 (`vpk`, `velopack_libc`, Rust crate `=1.2.161`), WinSparkle 0.9.4 (x64 DLL, `winsparkle-tool`), Inno Setup 6                                                                                 |
| Feed side | Worker renderers and verifier from `main` @ `841c0b7e`, run with `tsx` (Node 22.13.1) by `gen_feeds.mts`; files served by `server.py`, which logs `Authorization`, `User-Agent` and `Range` | the same, on the runner (Node 22.23.3)                                                                                                                                                                        |
| Keys      | throwaway Ed25519 key generated per run with Node `crypto`; never committed                                                                                                                 | the same; the seed file was deleted in the run's last step                                                                                                                                                    |

The macOS probe is an exported Godot project whose `main.gd` reads a JSON config, opens the
`PKeySparkle` facade, starts the GDExtension in `headless` or `standard` mode, calls
`check_for_updates()` and logs every Sparkle delegate and user-driver event with its main-thread
flag. `headless` replaces Sparkle's UI with an `SPUUserDriver` that accepts every prompt, so an
update runs unattended; `standard` is `SPUStandardUpdaterController`, the controller P5-07 ships.
Version 1.0 is build 1 and 1.1 is build 2; the update archive is a `ditto` zip and the delta comes
from `BinaryDelta create`.

```sh
# macOS (scripts in S-11-desktop-updaters/; GODOT_CPP and SPARKLE_DIR point at the downloads)
./build_sparkle_ext.sh                                   # libpkey_sparkle.dylib, 2 s on top of godot-cpp
./build_app.sh 1.0 1 <codesign> out/<variant>-v1         # codesign: 0 = disabled, 1 = Godot's codesign with identity "-", post = disabled + codesign --deep -s -
./build_app.sh 1.1 2 <codesign> out/<variant>-v2
REPO=<polaris-key checkout> ./make_feed.sh <variant>     # zip + sign_update + BinaryDelta + Worker-rendered appcast.xml
SRV_LOG=srv.log python3 server.py 8711 serve &           # and a second one on 8712 for the redirect probe
./run_case.sh <case> <variant> headless|standard <feed> <timeout_s>
```

The Windows workflow (`windows/s11-windows-spike.workflow.yml`) builds godot-cpp and
`pkey_win.dll`, builds the Rust shim, exports 1.0.0 and 1.0.1 twice (a Velopack layout with the shim
as `S11Game.exe` and Godot as `s11game_godot.exe`, and a plain layout for WinSparkle), runs
`vpk pack --runtime win-x64` for each version and compiles a per-user Inno Setup installer for each,
renders the feeds with `gen_feeds.mts`, then runs scenarios V, V2, H, W, S and M (§4.2–§4.4).
Eight runs were needed; runs 1–6 failed on harness problems (exit codes, SCons not finding VS 2026,
C++/WinRT under C++17, a missing directory). Every result quoted below is from **run 7 or run 8**;
both ran every scenario to completion.

## 4. Results

### 4.1 macOS: Sparkle 2 from a GDExtension

**Feed side** [E]. For each variant `gen_feeds.mts` rendered one item with
`renderSparkleAppcast`: `sparkle:version` 2, `sparkle:shortVersionString` 1.1,
`sparkle:minimumSystemVersion` 11.0, the zip enclosure and a `<sparkle:deltas>` enclosure with
`sparkle:deltaFrom="1"`, each with its `sparkle:edSignature`. `sign_update --ed-key-file` and Node's
Ed25519 produced byte-identical signatures over the same zip (Ed25519 is deterministic), and the
Worker's `verifyEd25519OverBytes` accepted both in 75–606 ms for a 61 MB zip and 9–33 ms for a 30 KB
delta [M]. A signature made over a different file was rejected by the verifier, and the renderer
then emitted the enclosure **without** `sparkle:edSignature`, as the Worker does [M].

**Export wiring** [M].

- Godot copies a framework listed under `[dependencies]` in the `.gdextension` file into
  `Contents/Frameworks` with its symlinks intact, so `Sparkle.framework` needs no extra copy step.
- **The copy drops the executable bit.** After export, `Autoupdate`, `Updater.app/…/Updater`,
  `Downloader.xpc/…/Downloader` and `Installer.xpc/…/Installer` were `0644`, and so was the
  `Sparkle` binary itself, except under Godot's codesign mode, which restored `0755` on that one
  file. With the bits missing, an update got as far as extraction, then failed with
  `SUSparkleErrorDomain` 4005: "The file '…/Autoupdate' may not have executable permissions".
  `BinaryDelta` also refuses such a bundle. `chmod +x` on the five files after export fixes both,
  and does not invalidate the code signature (the mode is not sealed).
- `SUPublicEDKey`, `SUFeedURL` and `SUEnableAutomaticChecks` went into `Info.plist` through the
  macOS preset's `application/additional_plist_content`.
- Code signing: `codesign/codesign=1` (Xcode `codesign`) with identity `-` ad-hoc-signed the app,
  the GDExtension and every Sparkle helper with the hardened runtime and the Disable Library
  Validation entitlement (`flags=0x10002(adhoc,runtime)`). `codesign/codesign=2` (rcodesign)
  refused to export without an rcodesign path. With `codesign/codesign=0` (disabled) the main
  executable kept the official template's Developer ID signature (`Identifier=godot.macos.template_release.arm64`,
  Godot's Team ID) and `codesign --verify --deep --strict` failed with "code has no resources but
  signature indicates they must be present".

**Update runs** (headless driver, local server; the `elapsed` column is from `open -n` until the
relaunched process logged build 2):

| Case         | Build (codesign)                          | Feed                                                          | Outcome                                                                                                                                          | Elapsed      |
| ------------ | ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| m1           | 1, before the `chmod` fix                 | delta                                                         | extracted, then 4005 "may not have executable permissions"                                                                                       | (stayed 1.0) |
| r1–r3 delta  | 1 (ad-hoc, hardened runtime)              | delta 29.9 KB                                                 | updated to build 2; only the delta was fetched                                                                                                   | 4.19–4.69 s  |
| r1–r3 full   | 1                                         | zip 61.9 MB, no delta                                         | updated to build 2                                                                                                                               | 4.19–4.67 s  |
| r1–r3 cspost | post (`codesign --deep -s -`, no runtime) | delta 29.3 KB                                                 | updated to build 2                                                                                                                               | 4.17–4.19 s  |
| m4           | 0 (template signature kept)               | delta                                                         | rejected: "The update archive is validly signed, but the app's Apple code signing signature is corrupted" (OSStatus −67056)                      | (stayed 1.0) |
| m13          | 1, delta made from another v1 build       | delta, then zip                                               | delta failed silently; Sparkle fell back to the full zip and updated                                                                             | 7.56 s       |
| m7           | 1                                         | Worker dropped the bad signature (no `edSignature`)           | downloaded the 62 MB zip, then rejected: "The app has an EdDSA public key, but there is no EdDSA signature in the update"                        | (stayed 1.0) |
| m8           | 1                                         | forged signature, Worker bypassed                             | downloaded, then rejected: "EdDSA signature does not match"                                                                                      | (stayed 1.0) |
| m9           | 1 without `SUPublicEDKey`                 | –                                                             | the bridge refused to start (`missing_public_key`), as `SparkleAnchor.swift` does                                                                | –            |
| m10          | 1 without an ATS exception                | delta                                                         | `http://127.0.0.1` loaded anyway (loopback is exempt), so ATS is not exercised; production feeds are HTTPS [I]                                   | 7.20 s       |
| m6           | 1                                         | enclosure via a 302 from `127.0.0.1:8711` to `localhost:8712` | updated; `Authorization` reached the feed and the redirecting host and was **not** sent to the second origin                                     | 6.59 s       |
| m11c         | 1, `standard` controller                  | delta, background check, automatic downloads                  | downloaded silently, `willInstallUpdateOnQuit`; after `get_tree().quit()` the installed bundle was build 2 within 2 s (no relaunch, as designed) | –            |

Within a run, the phases were stable [M] (n = 9 across the r cases): check to `didFindValidUpdate`
36–76 ms; found to extracted 35–87 ms; extracted to ready-to-install 1.49–1.81 s (Sparkle's
installer validation, including the code-signing check); ready to Godot's `_exit_tree` 17–27 ms.

**How Godot quits** [M]. When Sparkle installs and relaunches it terminates the app through
AppKit; Godot 4.7.2 turned that into `NOTIFICATION_WM_CLOSE_REQUEST` and, with the default
`auto_accept_quit`, reached `_exit_tree` 10–27 ms after Sparkle's `will_relaunch`. A game that turns `auto_accept_quit` off must quit on its
own when the facade reports `will_relaunch`, or Sparkle waits for it.

**Threading** [M]. Godot's main thread is AppKit's main thread (`[NSThread isMainThread]` was true
in `_ready`), and every Sparkle delegate and user-driver callback arrived on it. Calling `start()`
from a GDScript `Thread` returned `not_main_thread`; the bridge checks and refuses.

**Headers** [M]. `updater.httpHeaders` carried `Authorization: Bearer …` on both the appcast GET and
the download, with `User-Agent: S11Sparkle/1.0 Sparkle/2.10.0`. On the cross-origin redirect (m6)
the header was dropped by Foundation. So an `entitled` feed whose enclosure redirects to another
host (for example, the bytes host) must sign that URL itself, not rely on the bearer header [I].

**Quarantine** [M]. The updated bundle carried no `com.apple.quarantine` attribute (only
`com.apple.provenance`). Gatekeeper on a quarantined first install of an ad-hoc app is a separate
question (§7).

**Sandbox** [U]. A sandboxed export did not run here. Godot's
`codesign/entitlements/additional` produced "an invalid entitlements blob" when given Sparkle's
`mach-lookup` exception, and a hand-signed sandboxed build launched but could not read the probe's
config outside its container, so the run produced no evidence either way. Sparkle documents
`SUEnableInstallerLauncherService` plus a `mach-lookup` temporary exception for
`<bundle id>-spks` and `-spki` (and `SUEnableDownloaderService` without the network-client
entitlement) [D]. Direct-download games are rarely sandboxed and Mac App Store builds must not ship
Sparkle, so this is low priority [I].

**Godot editor** [M]. The first `--import` of a project containing the extension crashed the editor
on exit (signal 11), and the second and later imports were clean. CI should run an import before
exporting and tolerate the first exit code, until the cause is known.

### 4.2 Windows: Velopack

Packaging [M]. `vpk pack --runtime win-x64 --mainExe S11Game.exe` took 4.5–7.3 s per version and
produced `S11Game-1.0.0-full.nupkg` (44.8 MB), `S11Game-1.0.1-full.nupkg` (44.8 MB),
`S11Game-1.0.1-delta.nupkg` (5.6 KB), `Setup.exe` (49 MB) and `Portable.zip`. Without `--runtime`
vpk defaults to x86 (it warns). Each `vpk pack` overwrites `S11Game-win-Setup.exe`, so CI must keep
the setup file of each version under its own name. `Setup.exe --silent` installed into
`%LOCALAPPDATA%\S11Game` in 0.9–1.1 s and ran the `--veloapp-install` hook (17 ms).

Feeds [M]. The Worker renderer, fed the 1.0.1 full and delta packages, produced the same `Assets`
as `vpk`'s own `releases.win.json` (same `SHA1`, `SHA256`, `Size`, `Type`), except that `FileName`
is the absolute URL.

| Scenario | Feed                                                                                                 | What happened                                                                                                                                                                                                                                                             | To 1.0.1 |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| V        | Worker renderer as shipped (`FileName` = `http://127.0.0.1:8711/velopack/S11Game-1.0.1-delta.nupkg`) | `check()` found 1.0.1 with one delta (5 ms). `download_async()` fetched the delta, then the full package (both GETs answered 200), then failed: "IO error: The filename, directory name, or volume label syntax is incorrect. (os error 123)". Identical in runs 7 and 8. | never    |
| V2       | Worker renderer with `FileName` reduced to the file name (the proposed fix), same install            | Fetched only the delta. Update.exe rebuilt the full package from the installed one in 4.60 s (`zsdiff` on the Godot exe). `apply_on_exit(true)` succeeded, Godot quit, Update.exe applied and restarted the shim, and the shim started 1.0.1.                             | 6.95 s   |

Velopack's Rust core joins `FileName` to the URL for the download (`url.join(&asset.FileName)`,
which accepts an absolute URL), but also to the local packages directory
(`packages_dir.join(&update.TargetFullRelease.FileName)` in `manager.rs`, and the same for each
delta) [D]. A URL is not a valid Windows file name, hence error 123. This applies to every client
built on the Rust core: `velopack_libc` (C and C++), the Rust crate, and so the P5-07 GDExtension and
shim. The C# client's `SimpleWebSource` is the source of the README's "an absolute `FileName` is
downloaded as is" (notes/E3 §A3.1); it was not run here [U].

Other Velopack observations [M]:

- The client sent `GET /velopack/releases.win.json?localVersion=1.0.0&id=S11Game&stagingId=…`
  with `User-Agent: ureq/3.4.2` and **no** `Authorization`: headers must be set explicitly through
  `vpkc_new_source_http_url_with_options` (`vpkc_http_options_t.Headers`) [D].
- Progress callbacks arrive on the download thread (`main_thread: false`): 0 %, 70 %, then 100 %
  when the delta was rebuilt, 4.7 s later.
- `vpkc_new_update_manager` in a build not installed by Velopack fails cleanly: "This application
  is not properly installed: Could not auto-locate app manifest". The facade can report that as
  `Unsupported`.
- Update.exe logged "Failed to wait for process (696) to exit (Access is denied)" and continued;
  Godot had already exited. Harmless here, but P5-07 should quit the tree immediately after
  `apply_on_exit`.

Hooks (scenario H, `time_hooks.py` from S-05, five repetitions per hook) [M]:

| `--mainExe`                             | install     | obsolete   | updated    | uninstall  | Limit         |
| --------------------------------------- | ----------- | ---------- | ---------- | ---------- | ------------- |
| Rust shim (0.6 MB)                      | 8.8–14.9 ms | 8.7–9.6 ms | 8.6–9.0 ms | 8.6–9.3 ms | 30/15/15/30 s |
| Godot itself, autoload quits in `_init` | 455–486 ms  | 469–478 ms | 472–487 ms | 469–479 ms | 30/15/15/30 s |

This is the Windows run S-05 §4.5 left outstanding: both arms stay far inside the limits, and the
shim is ~50× faster and opens no window, so S-05's "ship the shim" stands.

### 4.3 Windows: WinSparkle

[M] (scenario W, runs 7 and 8). The WinSparkle appcast from `renderWinSparkleAppcast` carried one
item with `sparkle:os="windows-x64"`, `sparkle:installerArguments="/SILENT /SP- /NOICONS"` (from the
build's `inno` format) and the verified `sparkle:edSignature`. `winsparkle-tool sign -f <seed>`
produced the same signature as Node, and `winsparkle-tool verify` accepted Node's ("Valid
signature."): WinSparkle's private-key file is the base64 32-byte seed, the same format as
Sparkle's `--ed-key-file`.

Installed 1.0.0 (Inno Setup, per user, `/VERYSILENT`), then the GDExtension: `load()`
(`LoadLibraryW` beside the exe), `start()` (appcast URL, EdDSA public key, app details, a bearer
header, automatic checks off, every callback) and `check("install")`
(`win_sparkle_check_update_with_ui_and_install`):

| t (ms) | Event (thread)                                                                  |
| ------ | ------------------------------------------------------------------------------- |
| 34     | check called (main)                                                             |
| 109    | `did_find_update` (WinSparkle thread)                                           |
| 336    | `can_shutdown` → 1, then `run_installer` with the temp path (WinSparkle thread) |
| 649    | `shutdown_request` (WinSparkle thread) → `get_tree().quit()`                    |
| 662    | Godot `_exit_tree`                                                              |
| ~5,700 | the installer's post-install run started 1.0.1, which logged its version        |

From process start to the 1.0.1 log line: 6.17 s (run 7) and 6.62 s (run 8). The uninstall key's
`DisplayVersion` became 1.0.1. Both the appcast and the installer download carried
`Authorization: Bearer …` with `User-Agent: S11WinSparkle/1.0.0 WinSparkle/0.9.4 (Win64)`. A
progress window appeared on the runner's interactive desktop; no prompt needed answering. With
`WinSparkle.dll` removed, `load()` returned `{error: "dependency", win32: 126}` and Godot ran on.

### 4.4 Windows: StoreContext

What P5-07 and P5-04 need [D]:

- Update APIs (Windows 10 1607+): `StoreContext.GetDefault()`, then
  `GetAppAndOptionalStorePackageUpdatesAsync`, then `RequestDownloadAndInstallStorePackageUpdatesAsync`
  (shows the OS consent dialog) or `RequestDownloadStorePackageUpdatesAsync`. On 1803+ there are
  also `TrySilentDownloadStorePackageUpdatesAsync` and `TrySilentDownloadAndInstallStorePackageUpdatesAsync`,
  which succeed only with "Update apps automatically" on and an unmetered network; check
  `CanSilentlyDownloadStorePackageUpdates` first. `PackageDownloadProgress` runs 0 → 0.8 for the
  download and 0.8 → 1.0 for the install.
- Mandatory updates: a submission's packages can be marked mandatory in Partner Center;
  `StorePackageUpdate.Mandatory` reports it; "the mandatory status of a package update is not
  enforced by Microsoft". The game enforces it.
- `StoreContext` implements `IInitializeWithWindow`; a desktop app sets the owner HWND before any
  call that shows UI.
- P5-04 is server-side (Partner Center submission API) and needs nothing from the device.

What the app could call (runs 7 and 8; `PKeyStoreContextNative.probe_async` on an MTA thread):

| Call                                                                | Unpackaged exe [M]                     | Package identity, not Store-associated (unsigned developer-mode registration) [E] |
| ------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `GetCurrentPackageFullName`                                         | 15700 (`APPMODEL_ERROR_NO_PACKAGE`)    | 0, `PolarisKeyS11.S11Game_1.0.0.0_x64__fk1mxaz31v9v4`                             |
| `StoreContext.GetDefault()`                                         | ok, 109 ms                             | ok, 1,871 ms                                                                      |
| `IInitializeWithWindow::Initialize(hwnd)` (Godot's `WINDOW_HANDLE`) | `S_OK`                                 | `S_OK`                                                                            |
| `GetStoreProductForCurrentAppAsync`                                 | `ExtendedError` 0x803F6107, no product | `ExtendedError` 0x803F6107, no product                                            |
| `GetAppAndOptionalStorePackageUpdatesAsync`                         | throws 0x803F6101                      | throws 0x80070002 ("The system cannot find the file specified")                   |
| `CanSilentlyDownloadStorePackageUpdates`                            | true                                   | true                                                                              |
| `GetAppLicenseAsync`                                                | `IsActive` true, `IsTrial` false       | `IsActive` false, `IsTrial` true                                                  |

So none of the update calls give a usable answer without a Store-associated package, and the
licence result even flips between the two layouts: the facade must treat any of these HRESULTs as
"not a Store install" rather than "no update" [I].

The same developer-mode registration also gave a first look at S-05 (d) [E]: `user://` resolved to
the **real** `%APPDATA%\Godot\app_userdata\S11Game` and the file landed there, not under
`%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming`, and the layout folder (outside `WindowsApps`)
was writable. A loose registration of an unsigned layout is not a Store install, so this does
**not** settle S-05 (d); it says the redirection depends on more than package identity, and a
signed MSIX installed into `WindowsApps` still has to be checked [U].

### 4.5 The Godot binding: GDExtension or helper, threading, CI

**GDExtension, not a helper process** [M][I].

- Sparkle's controller must live in the app's own process: it terminates and relaunches that
  process, reads its bundle and `Info.plist`, and its UI belongs to that app. The bridge is about
  370 lines of Objective-C++.
- The Windows extension (Velopack, WinSparkle and StoreContext in one 431 KB DLL) is about 440 lines
  of C++.
- A helper process would add an IPC protocol and a second signed binary without removing any native
  code. The one helper that earns its place is the Velopack shim, because Velopack starts the main
  exe for each hook (§4.2).

**Missing dependencies** [M].

- Weak-linking `Sparkle.framework` and runtime-loading `WinSparkle.dll` keep the extension loadable
  when the updater library is absent, so the facade answers `Unsupported(dependency)`.
- Import-linking `velopack_libc.dll` does not: with the DLL removed, Godot failed to load the whole
  extension and every class vanished, including WinSparkle and StoreContext. The facade still
  answered correctly (`ClassDB.class_exists` is false), but one missing DLL took down three
  backends.
- P5-07 should either runtime-load `velopack_libc.dll` too, or link the static `velopack_libc`
  library (`lib-static/velopack_libc_win_x64_msvc.lib`, 9.3 MB) [I].
- The import library names the DLL `velopack_libc.dll`, so the shipped file must have that name,
  not the archive's `velopack_libc_win_x64_msvc.dll` (`dumpbin /dependents`).

**Threading** [M].

| Library      | Thread the callbacks arrive on           | Rule for P5-07                                                                                                                          |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Sparkle      | main (AppKit)                            | create and call on the main thread; `call_deferred` costs nothing and keeps one pattern                                                 |
| WinSparkle   | its own threads (two different ids seen) | every callback through `call_deferred`; `shutdown_request` quits the tree; `win_sparkle_cleanup` in `_exit_tree`                        |
| Velopack     | the download thread                      | run `vpkc_download_updates` on a worker `std::thread` (the spike did); `check` too, for slow networks; progress through `call_deferred` |
| StoreContext | the MTA worker thread                    | blocking `.get()` only off the STA main thread; UI-showing calls also need the HWND through `IInitializeWithWindow`                     |

**CI build** [M].

| Step                                                          | macOS host                 | `windows-latest`                                                                     |
| ------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| godot-cpp 10.0.0 static library (`template_release`)          | 97 s (universal, 18 cores) | 287–503 s uncached (MSVC, 4 vCPU); 28 s with godot-cpp and `.sconsign.dblite` cached |
| the extension itself                                          | 2 s                        | (inside the 28 s)                                                                    |
| Rust shim (`velopack =1.2.161`, release, LTO)                 | –                          | 93–121 s                                                                             |
| Worker feed code (`pnpm install` + the worker's dependencies) | –                          | 23–34 s                                                                              |

Windows traps, each of which failed a run:

- SCons 4.9.1 does not know Visual Studio 2026, falls back to MinGW `g++`, and fails on `/bigobj`.
  SCons 4.11.x supports VS 2026.
- C++/WinRT under C++17 includes `<experimental/coroutine>`, which the VS 2026 STL rejects with
  STL1011. Compile that one translation unit with `/std:c++20`; godot-cpp stays at C++17.
- godot-cpp disables exceptions by default; C++/WinRT reports errors as `hresult_error`, so
  `disable_exceptions=no`.
- Cache `.sconsign.dblite` along with the godot-cpp tree, or SCons rebuilds everything.

## 5. What Polaris Key's feeds need

### 5.1 Velopack: `FileName` must be a file name (fix needed)

The renderer's comment and the docs page say Velopack downloads an absolute `FileName` as it is.
For the Rust-core clients that is only half true (§4.2): the download works and the local write
fails. Proposed change, for a small Worker follow-up before P5-07's Velopack step [I]:

- Emit `FileName` as the bare package file name (`S11Game-1.0.1-delta.nupkg`), as `vpk` does.
- Serve `GET /<product>/update/<channel>/velopack/<FileName>` as a 302 to the package's immutable
  delivery URL. It is the same lookup the feed already does, keyed by file name and checked against
  the listed `SHA256`.
- Correct the sentence in `packages/docs/src/content/docs/services/update/updater-feeds.md` and the
  comment in `updaterRender.ts`.

The redirect leg itself was not measured. `ureq` 3 follows redirects by default [D], and V2 served
the files at the feed's base URL directly [E]. P5-07's local end-to-end test should exercise the
redirect.

### 5.2 Sparkle and WinSparkle: no change, two operating rules

- **Keep `requireSparkleSignature` on.** Sparkle and WinSparkle both download the whole payload
  before they reject a missing or bad signature (m7, m8). The Worker's rule of leaving out an
  enclosure whose signature does not verify is right. An unsigned enclosure is also rejected by any
  app that carries a public key, so listing unsigned enclosures only wastes bandwidth [M][I].
- **Bearer headers do not survive a cross-origin redirect** (m6). Entitled feeds must point
  enclosures at URLs that authorise themselves (signed, or same-origin), not at a host that needs
  the header [M][I].
- `sparkle:deltas` with `deltaFrom` work as rendered, including the fallback to the full archive
  (m13) [M].
- One WinSparkle appcast URL per channel works as rendered [M].

## 6. Recommendation

1. P5-07 proceeds as briefed, with the GDExtension shapes measured here: `PKeySparkleNative`
   (`pkey_sparkle.mm`) and one Windows DLL with `PKeyVelopackNative`, `PKeyWinSparkleNative` and
   `PKeyStoreContextNative` (`pkey_win.cpp`). They are starting points, not product code.
2. Add a headless user-driver mode to the Sparkle bridge, used only by tests. It makes the
   macOS end-to-end test unattended in CI; the shipped mode stays `SPUStandardUpdaterController`.
3. Fix the Velopack `FileName` before P5-07's Velopack step (§5.1). The lead should decide whether
   that is a P3-09 follow-up or a new work package.
4. Keep the shim (S-05 confirmed on Windows).

## 7. Owner checklist: what needs certificates or accounts [U]

Run each with the P5-07 artifacts and record the result in the P5-07 PR.

| #   | Needs                                            | Check                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Developer ID Application certificate             | Godot's `codesign/codesign=1` with a Developer ID identity signs Sparkle's helpers inside-out with hardened runtime, `codesign --verify --deep --strict` passes, and Sparkle's `Autoupdate` runs (the ad-hoc equivalent passed here).              |
| 2   | Notarisation credentials (`notarytool`)          | The DMG or zip notarises with the GDExtension and Sparkle inside; staple; a quarantined first launch passes Gatekeeper.                                                                                                                            |
| 3   | Developer ID, two builds                         | Sparkle updates a Developer-ID 1.0 to a Developer-ID 1.1 (its code-signing match is satisfied), and **refuses** a 1.1 signed by another team or ad-hoc.                                                                                            |
| 4   | Developer ID                                     | Disable Library Validation is needed only for the GDExtension: check that a notarised app without it fails to load `libpkey_sparkle.dylib`, and with it loads.                                                                                     |
| 5   | Authenticode or Azure Artifact Signing           | Sign `S11Game.exe` (shim), `s11game_godot.exe`, `pkey_win.dll`, `velopack_libc.dll`, `WinSparkle.dll` and the installers; `vpk pack --signParams`/`--azureTrustedSignFile`; SmartScreen on a fresh machine for Setup.exe and the Inno installer.   |
| 6   | Signed MSIX + Partner Center app (can be hidden) | Install from the Store; `GetAppAndOptionalStorePackageUpdatesAsync` lists a flight update; `RequestDownloadAndInstall…` shows the consent dialog owned by the Godot window; `TrySilent…` with automatic updates on; a mandatory flag reads `true`. |
| 7   | Signed MSIX installed into `WindowsApps`         | Where `user://` lands and whether the install directory is read-only (S-05 (d)); the developer-mode registration here did not redirect `%APPDATA%`.                                                                                                |
| 8   | Sandboxed macOS build (optional)                 | Only if a direct build is ever sandboxed: `SUEnableInstallerLauncherService` with the `-spks`/`-spki` exceptions.                                                                                                                                  |

## 8. Recipe for P5-07

**macOS (`sdks/godot/native/macos/`).**

1. Build godot-cpp 10.0.0 (`api_version=4.7`, `template_release`, `arch=universal`) once per CI
   cache key, then compile `pkey_sparkle.mm` with
   `-fobjc-arc -weak_framework Sparkle -Wl,-rpath,@executable_path/../Frameworks`. The output is a
   universal dylib of about 1.2 MB.
2. `PKeySparkleNative.start(mode, feed_url, headers, channels)`:
   - refuse off the main thread, without `SPUUpdater` loaded (`dependency`), or without
     `SUPublicEDKey`;
   - `standard` is `SPUStandardUpdaterController(startingUpdater: NO)`, then set `httpHeaders`,
     then `startUpdater`; a headless `SPUUserDriver` exists for tests only;
   - feed URL and allowed channels go through `SPUUpdaterDelegate`;
   - every delegate event becomes a `sparkle_event` signal through `call_deferred`.
3. In the export plugin, when the Sparkle plugin is enabled:
   - list `Sparkle.framework` under the `.gdextension` `[dependencies]` for `Contents/Frameworks`;
   - add `SUFeedURL` (from discovery), `SUPublicEDKey` and `SUEnableAutomaticChecks` through
     `application/additional_plist_content`;
   - turn on `codesign/entitlements/disable_library_validation`;
   - **after export, `chmod 0755`** `Sparkle`, `Autoupdate`, `Updater.app/Contents/MacOS/Updater`,
     `Downloader.xpc/…/Downloader` and `Installer.xpc/…/Installer`;
   - **never export with `codesign/codesign=0`**. Ad-hoc (`1` with identity `-`) is the floor for
     local runs; CI uses Developer ID (§7 rows 1–4).
4. Package: `ditto -c -k --sequesterRsrc --keepParent` zip (or DMG), `sign_update --ed-key-file`
   in CI, `BinaryDelta create` against the previous release for the `delta` artifact with
   `deltaFrom` = its build number. The Worker verifies and renders them as is.
5. Facade: on `will_relaunch`, save and let Godot quit; a game with `auto_accept_quit` off must
   call `get_tree().quit()` itself. Install-on-quit needs nothing beyond a normal
   `get_tree().quit()`.
6. Local e2e test: headless mode against a Worker-rendered appcast served from `127.0.0.1`
   (no ATS exception needed), asserting build 2 relaunches. `run_case.sh` is the template.

**Windows (`sdks/godot/native/windows/`).**

1. Build with SCons ≥ 4.11 and MSVC (VS 2026). Use godot-cpp `disable_exceptions=no`,
   `/std:c++20` on the C++/WinRT file only, and link `WindowsApp.lib`. Cache `godot-cpp/` and
   `.sconsign.dblite`.
2. Velopack, the shim: S-05's Rust shim as `--mainExe`. Call `VelopackApp::build()` with the four
   fast callbacks, then `.run()`, then start `<game>_godot.exe` beside it with the same arguments.
   `vpk pack --runtime win-x64 --mainExe <Game>.exe`, keeping each version's `Setup.exe`.
3. Velopack, the GDExtension:
   - `vpkc_new_source_http_url_with_options` (bearer header) on `…/update/<channel>/velopack`;
   - `check` and `download` on a worker thread, progress through `call_deferred`;
   - `vpkc_wait_exit_then_apply_updates(…, silent=true, restart=true)`, then `get_tree().quit()`
     at once;
   - load `velopack_libc.dll` at run time (or link it statically) so its absence cannot unload the
     other backends.
4. WinSparkle:
   - `LoadLibraryW("WinSparkle.dll")` beside the exe, then `set_appcast_url`,
     `set_eddsa_public_key`, `set_app_details` (version from the project), the bearer header,
     automatic checks off and all callbacks, then `win_sparkle_init`;
   - `check_update_with_ui_and_install` for "update now", `check_update_with_ui` for a menu item;
   - `shutdown_request` quits the tree; `win_sparkle_cleanup` in `_exit_tree`;
   - the installer needs a silent switch, so the build's `format` (`inno`/`nsis`/`msi`) must be
     set for the Worker to emit `installerArguments`.
5. StoreContext:
   - `GetCurrentPackageFullName` first, and `Unsupported(runtime)` without identity;
   - otherwise `GetDefault`, then `IInitializeWithWindow` with
     `DisplayServer.window_get_native_handle(WINDOW_HANDLE)`, then the update calls on an MTA
     thread;
   - map 0x803F6101, 0x803F6107 and 0x80070002 to "not a Store install";
   - device checklist §7 row 6.
6. CI e2e on `windows-latest`, all without signing:
   - Velopack: install `<v1>-Setup.exe --silent`, run, delta to v2;
   - WinSparkle: install the v1 Inno installer `/VERYSILENT`, run, update to v2;
   - facades: each backend with its DLL removed.

   The spike's workflow is the template.

## 9. Briefs changed

- **[P5-07](../program/wp/P5-07-desktop-plugins.md)** (edited in this branch):
  - design notes: the `chmod` and never-unsigned export rules, the redirect and header facts,
    threading per library, the measured CI times and Windows build traps, the `velopack_libc.dll`
    name, and runtime loading;
  - the Windows hook timing that S-05 left open, now measured;
  - a hard prerequisite on the Velopack `FileName` fix.
- **[P5-04](../program/wp/P5-04-msstore-connector.md)**: no change. The connector is server-side;
  §4.4 only confirms that device-side StoreContext checks stay in P5-07.
- **Proposed, not edited:** a small Worker follow-up to P3-09 (done) for §5.1, and S-05 (d), which
  this run did not settle (§4.4).

## 10. Sources

- Sparkle 2.10.0 release and framework headers (`SPUUpdater.h`, `SPUUpdaterDelegate.h`,
  `SPUUserDriver.h`, `SPUStandardUpdaterController.h`), read from the release archive [D];
  sandboxing requirements from https://sparkle-project.org/documentation/sandboxing/ as summarised in
  notes/E1 §C1–§C2 [D].
- Velopack 1.2.161: `velopack_libc` headers (`Velopack.h`) and the Rust crate source
  (`src/manager.rs` `download_updates`, `src/sources/http.rs`), read from the release assets [D].
- WinSparkle 0.9.4: `include/winsparkle.h` and `tools/winsparkle-tool.cpp` (key file format,
  `sign`/`verify` arguments), read from the release source archive [D].
- Microsoft Learn, "Download and install package updates from the Store" (updated 2025-06-10):
  https://learn.microsoft.com/en-us/windows/uwp/packaging/self-install-package-updates [D].
- Microsoft Learn, "Display WinRT UI objects that depend on CoreWindow" (updated 2026-06-25;
  `StoreContext` implements `IInitializeWithWindow`):
  https://learn.microsoft.com/en-us/windows/apps/develop/ui/display-ui-objects [D].
- SCons 4.11.0 release notes ("Add support for Visual Studio 2026"):
  https://raw.githubusercontent.com/SCons/scons/master/CHANGES.txt [D].
- The Worker at `841c0b7e`: `services/update/updaterRender.ts`, `updaterFeeds.ts`, `appcast.ts`,
  `artifactBytes.ts`, `services/release/sparkle.ts`; docs page `services/update/updater-feeds.md`.
- Earlier notes: [E1](E1-apple.md) §C1–§C2, [E3](E3-windows-linux-web.md) §A1.3, §A3.1–§A3.2,
  [S-05](S-05-godot-platform-mechanics.md) §4.4–§4.5.
