# P5-07 Desktop plugins: macOS Sparkle bridge; Windows Velopack, WinSparkle and StoreContext

| Field       | Value                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                                                   |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                               |
| Depends on  | [P3-10](P3-10-godot-updater.md), [S-05](S-05-godot-platform-mechanics.md), [S-11](S-11-desktop-updaters.md)                                                                                                                                      |
| Unblocks    | [D-03](D-03-diceroll-after-p3.md)                                                                                                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                                                               |
| Gates       | `ci:macos`, `ci:windows` (new jobs that build the GDExtensions and the launcher shim); `parity.json` for Godot                                                                                                                                   |
| Human input | code-signing certificates: Developer ID Application plus notarisation credentials (macOS); Authenticode or Azure Artifact Signing (Windows); for `StoreContext` checks, a Partner Center app the test MSIX is associated with (it can be hidden) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                        |

## Goal

The Godot SDK's desktop update hooks (P3-10) have native backends: on macOS a GDExtension drives
Sparkle 2's standard updater; on Windows a launcher shim plus GDExtension drives Velopack, a
GDExtension drives WinSparkle, and a C++/WinRT GDExtension drives `StoreContext` for MSIX Store
builds. Each sits behind a GDScript facade whose stub answers `Unsupported` when the plugin is
missing, so boot never fails for want of a native library.

## Why

- Official Godot 4.6+ templates ignore `--main-pack`, so full-app updaters with deltas are the first
  choice for desktop direct outlets: Sparkle on macOS, Velopack on Windows
  ([§5.6](../../README.md#56-code-updates-without---main-pack), decision 6 in
  [§11](../../README.md#11-decisions-needed)).
- WinSparkle is the Sparkle-format option for installer builds; `StoreContext` is how a Store MSIX
  build checks and applies Store updates ([§4.4](../../README.md#44-windows), notes/E3 §A1.3,
  §A3.1–§A3.2).
- Report [§5.10](../../README.md#510-native-plugins-optional-each-behind-a-gdscript-interface-with-stubs)
  lists these as the macOS and Windows plugins; no Godot integration exists for any of them
  (notes/E1 §C2, notes/E4 §3.3).

## Read first

- `AGENTS.md`; P3-10's hook interfaces (`distribution/outlets/{sparkle,velopack,ms_store}.gd` and
  the updater's hand-off points) and P3-09's feed URLs.
- notes/E1 §C1–§C2 (Sparkle feed features, key custody, embedding in a non-Cocoa app, inside-out
  signing, Disable Library Validation).
- notes/E3 §A1.3 (`StoreContext`, `IInitializeWithWindow`, package identity), §A3.1 (Velopack:
  `VelopackApp::Build().Run()` must run first in `main()`, hooks relaunch the exe and kill it if it
  lingers), §A3.2 (WinSparkle API and EdDSA).
- `sdks/swift/Sources/PolarisKeyUpdate/SparkleAnchor.swift` and `SparkleUpdater.swift`: the Swift
  SDK's rules for Sparkle (fail loudly without `SUPublicEDKey`; never verify updates itself; feed
  URL from discovery; bearer header for `entitled` feeds; allowed channels from the licence).

## Scope

**In:**

- **macOS Sparkle bridge** (`sdks/godot/native/macos/`): a GDExtension linking `Sparkle.framework`
  (≥ 2.9.6, the floor P0-10 sets) that creates `SPUStandardUpdaterController` on the main thread and
  exposes `check_for_updates()`, `set_automatically_checks(bool)`, allowed channels, the feed URL
  and HTTP headers, and state signals. It refuses to start without `SUPublicEDKey`, as
  `SparkleAnchor.swift` does.
- **Velopack** (`sdks/godot/native/windows/velopack/`): a small launcher shim, built as the
  `--mainExe`, that calls `VelopackApp::Build().Run()` first and then starts the Godot executable;
  and a GDExtension over the Velopack C++ library exposing check, download (with progress) and
  apply-on-exit, pointed at P3-09's `releases.<channel>.json`.
- **WinSparkle** (`sdks/godot/native/windows/winsparkle/`): a GDExtension over `WinSparkle.dll`
  setting the appcast URL and EdDSA public key, initialising, checking with UI, and quitting the
  Godot tree from the shutdown callback.
- **StoreContext** (`sdks/godot/native/windows/storecontext/`): a C++/WinRT GDExtension that calls
  `IInitializeWithWindow` with the main window handle from
  `DisplayServer.window_get_native_handle`, lists Store package updates, requests download and
  install (silent variants where allowed), and reports package identity
  (`GetCurrentPackageFullName`).
- GDScript facades in `addons/polaris_key/native/` (`PKeySparkle`, `PKeyVelopack`,
  `PKeyWinSparkle`, `PKeyStoreContext`), each returning `Unsupported` (reason `runtime` on the wrong
  OS, `dependency` when its library is absent).
- Export-plugin wiring: `Sparkle.framework` into `Contents/Frameworks`, `SUFeedURL` and
  `SUPublicEDKey` into `Info.plist`, the Disable Library Validation entitlement; the Velopack shim
  and DLLs into Windows exports; nothing Store-incompatible in an MSIX preset.
- CI scripts that sign Sparkle's helpers inside-out and notarise (macOS), and sign the shim, DLLs
  and exe (Windows); `macos-26` and `windows-latest` jobs that build every plugin.

**Out** (and where it belongs instead):

- Feed rendering (Sparkle extensions, WinSparkle, Velopack, `.appinstaller`) (→ P3-09).
- Choosing which updater to use for which outlet and the sidecar-PCK swap (→ [P3-10](P3-10-godot-updater.md)).
- Microsoft Store connector on the server (→ [P5-04](P5-04-msstore-connector.md)); Store add-ons
  and in-product purchases (not owned by any work package).
- MSIX packaging of the Godot export and its `user://` behaviour (S-05 answers the latter).
- Linux: AppImageUpdate is `OS.execute`, no plugin (report §5.10).

## Design notes

- **No updater may run in a store build.** Steam, itch, Microsoft Store, Mac App Store, Flatpak and
  Snap builds disable Sparkle, Velopack and WinSparkle; `StoreContext` is the only updater in a
  Store MSIX. The facades trust P3-10's outlet decision; they never decide on their own.
- **Keys stay out of the Worker.** Sparkle and WinSparkle EdDSA private keys are CI's (notes/E1
  §C1). The bridges only carry public keys and URLs.
- **Signed feeds stay off at first.** `SURequireSignedFeed` clashes with dynamically rendered
  appcasts unless CI pre-signs every variant (report §4.3).
- **Velopack hooks relaunch the main exe** with `--veloapp-*` arguments and kill it after a timeout,
  which is why the shim, not Godot, is the main exe. S-05 §4.5 decided it: **ship the shim**
  (Rust `velopack` crate, 0.7 MB on macOS: `VelopackApp::build().run()`, apply any downloaded
  update, then start Godot beside it with the same arguments; hooks answered in 7–11 ms). Godot as
  `--mainExe` with an autoload that quits from `_init` on `--veloapp-*` also stayed inside the
  limits (1.0–1.7 s) but starts a window per hook. The macOS run is in
  `prototype/platform-mechanics/e_velopack/`. [S-11](../../notes/S-11-desktop-updaters.md) §4.2
  measured Windows: the shim answered every hook in 9–15 ms, Godot as `--mainExe` in 455–487 ms.
- **MSIX** (S-05 §4.4, documentation only): the install directory is read-only; `user://` lands in
  `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`, survives updates and is removed on
  uninstall. Keep the default virtualization (disabling it needs the `unvirtualizedResources`
  restricted capability).
- **`StoreContext` has no simulator**: testing needs a Store-associated package, which is a human
  input. Unit-test the GDExtension's argument handling; leave the Store calls to a device checklist.
- **GDExtensions on macOS** force the Disable Library Validation entitlement (notes/E4 §2.1); the
  export plugin adds it only when the Sparkle plugin is enabled.
- **Measured by [S-11](../../notes/S-11-desktop-updaters.md)** (prototypes in
  `notes/S-11-desktop-updaters/`; recipe in its §8):
  - **The Worker's Velopack feed must change first.** Its absolute `FileName` makes every Rust-core
    Velopack client (`velopack_libc`, the shim) fail with Windows `os error 123` after download.
    A bare file name plus a redirect route works (S-11 §5.1). The fix is a Worker change outside
    this package; land it before step 3.
  - Godot 4.7.2's `[dependencies]` copy drops the executable bit on `Sparkle`, `Autoupdate`,
    `Updater`, `Downloader` and `Installer`; the export plugin must `chmod 0755` them after export.
  - Never export with `codesign/codesign=0`: the template keeps its Developer ID signature on a
    modified bundle and Sparkle rejects every update ("code signing signature is corrupted").
  - Sparkle drops the bearer header on a cross-origin redirect; Velopack sends no headers unless
    given through `vpkc_new_source_http_url_with_options`.
  - Threads: Sparkle calls back on the main thread; WinSparkle and Velopack call back on their own
    threads (`call_deferred` everything); StoreContext's blocking calls need an MTA worker thread.
  - Load `WinSparkle.dll` and `velopack_libc.dll` at run time (or link Velopack statically).
    Import-linking `velopack_libc.dll` makes its absence unload all three Windows backends. Its
    import library expects the name `velopack_libc.dll`.
  - Windows build: SCons ≥ 4.11 (VS 2026), godot-cpp `disable_exceptions=no`, `/std:c++20` on
    the C++/WinRT file, and a cache of `godot-cpp/` plus `.sconsign.dblite` (the uncached build
    takes 287–503 s on `windows-latest`, cached 28 s).
  - Add a headless `SPUUserDriver` test mode so the macOS end-to-end test runs unattended.
  - S-11 §7 lists what only certificates or a Partner Center app can verify.
- **Size risk.** Four native components in 1–1.5 weeks is tight; if it grows past half again,
  split StoreContext into its own package and say so in the PR.
- **Lead follow-up (2026-10-03, branch `fix/delivery-surface`): non-public Velopack delivery.**
  The Velopack feed now names each package by its bare `FileName`, and the client fetches
  `…/update/<channel>/velopack/<FileName>`, which answers a cross-origin `302` to the package's
  delivery URL on the bytes host. Under licensed or entitled delivery the measured updaters drop
  `Authorization` on that cross-origin redirect (S-11 §5.2), so the second hop is refused (fail
  closed). Public delivery works today. Before P5-07 relies on Velopack for a non-public delivery,
  it must make the package route either stream the bytes same-origin (no redirect) or redirect to
  a signed, short-lived `Location` that needs no `Authorization`; until then, gate Velopack on
  public delivery and say so in the facade's error.

## Steps

1. GDScript facades and stub tests (no native code needed).
2. Sparkle bridge, export wiring, signing script; a test app updates from a local appcast.
3. Velopack shim and GDExtension; a test app updates from a local `releases.win.json` rendered by
   the Worker (after the `FileName` fix, S-11 §5.1).
4. WinSparkle GDExtension; a test installer build updates from a local appcast.
5. StoreContext GDExtension; device checklist with a Store-associated MSIX.
6. CI jobs; `parity.json` (`update.driver` on macOS and Windows).

## Acceptance criteria

- [ ] Headless Godot tests show each facade returns `Unsupported` with the right reason on the
      wrong OS and when its library is missing.
- [ ] CI builds the Sparkle GDExtension (universal), the Velopack shim and GDExtension, the
      WinSparkle GDExtension and the StoreContext GDExtension.
- [ ] The Sparkle bridge refuses to start when `SUPublicEDKey` is absent (test on a fixture bundle).
- [ ] Local end-to-end runs (recorded in the PR): Sparkle updates a signed, notarised test app from a
      local appcast; Velopack applies a delta from a local feed; WinSparkle installs a signed
      installer.
- [ ] The StoreContext device checklist is recorded by the person who ran it.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
sdks/godot/native/macos/build.sh      # proposed names
sdks/godot/native/windows/build.ps1
GODOT_BIN=godot-4.7.2 sdks/godot/tools/run_tests.sh   # P1-01's runner; add suite_native_desktop to the ci set
```

## Hand-off

- `PKeySparkle`, `PKeyVelopack`, `PKeyWinSparkle` and `PKeyStoreContext`: the backends behind
  P3-10's desktop hooks.
- The signing scripts and export-plugin switches that Diceroll's CI adopts (D-03).
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-07 done`.

## Corrections from implementation

Recorded by the implementing agent (2026-10-03). Where this brief and the code disagreed, the code
won:

- **P3-10's hook shape.** P3-10 documented the native side as Engine singletons
  (`PolarisKeySparkle`, …). The facades are plain GDScript objects instead: `PKeyNativeBridge`
  calls an injected `native`, else a singleton, else its facade (`make_facade()`), and awaits it,
  because Velopack downloads before it applies. A bridge now reports the facade's own reason
  (`runtime` on the wrong OS) instead of always `dependency`. A new `PKeyStoreContextBridge` lets
  `PKeyMsStoreAdapter` hook StoreContext for a `store` answer in a Store MSIX, with the listing as
  the fallback.
- **One Windows DLL.** Velopack, WinSparkle and StoreContext share `pkey_win.dll` (S-11 §4.5);
  the brief's three directories hold its three translation units. Both updater DLLs load at run
  time, so the facade matrix holds per backend.
- **The public key for WinSparkle** comes from a new `PKeyOptions.update_eddsa_public_key`
  (validated: 32 bytes of standard base64). The export plugin reuses it as the default
  `SUPublicEDKey`.
- **API level 4.4, not 4.7.** godot-cpp 10.0.0 is built against the 4.4 API, the SDK's floor, so the
  plugins load in 4.4+ (S-11 used 4.7). The macOS dylib targets macOS 12, Sparkle 2.10's own floor.
- **Export option warnings do not stop an export** (Godot lists them but exports anyway). A
  Sparkle build without a key therefore exports with a warning, and the bridge refuses to start in
  it. The plugin does guarantee "never unsigned": `codesign/codesign` 0 becomes 1 (built-in ad
  hoc). The S-11 note's "codesign=1 (Xcode codesign)" is the built-in ad-hoc signer in Godot
  4.7's enum (0 Disabled, 1 built-in, 2 rcodesign, 3 Xcode).
- **chmod after export works only for a `.app` export.** For `.zip`/`.dmg` the plugin warns, and
  `sign_and_notarize.sh` restores the bits before it packages the archive.
- **A Microsoft Store export ships no updater.** After a Windows export whose outlet kind is
  `ms-store`, the export plugin removes `velopack_libc.dll`, `WinSparkle.dll` and the shim.
  Godot chooses a GDExtension's `[dependencies]` from the preset's features, which never include
  an export plugin's own tags, so a `.gdextension` key cannot express this. The first CI run
  showed the feature-tag approach failing.
- **The shim** starts `<own stem>_godot.exe`. `pack_velopack.ps1` renames the shipped
  `pkey_velopack_shim.exe` to `<PackId>.exe`.
- **CI runners.** The jobs run on `macos-15` (the repository's current macOS image, not
  `macos-26`) and `windows-latest`, in a separate path-filtered workflow,
  `.github/workflows/native-desktop.yml`.
- **The Velopack feed fix** (bare `FileName` plus the 302 package route) merged into this branch
  from `main`. `e2e/gen_feeds.mts` builds the Velopack feed with the Worker's own code:
  `velopackCandidatesFrom` and `velopackAssets`, exported from `updaterFeeds.ts` by a refactor with
  no behaviour change. `e2e/server.py` 302s only the files that feed lists, as the route does.
- **Lead follow-up, non-public Velopack delivery:** the Worker is unchanged. Discovery does not
  expose the delivery access, so `PKeyVelopack` cannot refuse up front. A 401 or 403 download
  answers `unsupported` (`product`) naming the cause. The docs page, the SDK README and the parity
  note say that Velopack needs public delivery for now. A local check with ureq 3.4.2 (Velopack's
  HTTP client) showed it drops `Authorization` on every redirect, even a same-origin one. So a
  same-origin redirect would not fix this: the route must stream the bytes or redirect to a
  signed URL.
- **The e2e server answers each redirect with `Connection: close`.** Its HTTP/1.0 responses
  otherwise let ureq pool the 302's connection and fail the redirected request with "Peer
  disconnected" (the second CI run's Velopack failure). The Worker's HTTP/1.1 route is not
  affected.

Acceptance as delivered:

- [x] Headless facade tests (`native_desktop` suite, in the `ci` set): `runtime` on every other OS,
      `dependency` without the class or its library.
- [ ] CI builds every plugin: the workflow is written, but **it has not run**. Pushing was not
      allowed in this run. The macOS build and its end-to-end run pass locally; the Windows sources
      pass a syntax check against a stub `windows.h` (except the C++/WinRT file), and the
      PowerShell scripts parse.
- [x] The Sparkle bridge refuses a fixture bundle without `SUPublicEDKey` (macOS e2e, locally).
- [~] Local end-to-end: Sparkle delta and full updates (ad hoc, unnotarised) pass locally. Velopack
  and WinSparkle run only in the Windows job, which has not run. Signed and notarised runs are the
  owner's (checklist below).
- [ ] StoreContext device checklist: the owner's (needs a Partner Center app).
- [x] `parity.json` (Godot `update.driver` note).

Owner checklist: `sdks/godot/native/README.md` §"Owner checklist" and the docs page
`/docs/services/update/godot-desktop/`, from notes/S-11 §7 rows 1–8.
