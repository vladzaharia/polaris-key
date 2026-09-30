> Research note for [Godot on Polaris Key](../README.md), 2026-09-30.
> A working paper kept for its evidence and sources; the README synthesis is the cross-checked position.

# E9 - Runtime building blocks: what every SDK target can do in its own language, and where it needs native code

Researched 2026-09-30. The user rule behind this note: **every Polaris Key feature must exist in every SDK**. Node,
Python, Swift and React exist today; Godot is being added (README §5); Kotlin and C#/.NET are likely next. This note
answers, per runtime, the nine building-block questions that decide how much of each SDK can be plain language code and
how much needs a native module: outlet detection, self-update, background downloads, embedded resources, atomic file
replace and app-data directories, secure storage, platform-transport bindings, boot/login UI, and the minimal native
footprint. It ends with a runtime × feature matrix (§11) and a list of things found in the current SDKs (§12).

Godot is the reference implementation and is not repeated here (README §5, CONTENT §7.3, notes/A5, notes/A6).

**Repo read first:** `AGENTS.md`, `README.md`, the Godot `README.md` §3, §5, §7, §8, §12, and `CONTENT.md` §6, §9, §12.
Also the SDK sources that decide the answers below: `packages/sdk-node/src/devices/fingerprint.ts`,
`packages/sdk-node/src/core/{store,context}.ts`, `sdks/python/src/polaris_key/devices/{fingerprint,store}.py`,
`sdks/python/src/polaris_key/core/context.py`, `sdks/swift/Sources/PolarisKeyCore/{Fingerprint,Store}.swift` and
`sdks/swift/Package.swift`.

**Method and confidence.** Vendor documentation was read as raw text where possible (Apple documentation JSON, and the
Android, Microsoft Learn, Electron, Tauri, Velopack, Unity, Node.js, Python, Flatpak and WebKit pages), package facts
came from registry APIs (npm, PyPI, NuGet, Maven Central and Google Maven, crates.io), and browser support from MDN
`browser-compat-data` 8.1.3 (2026-09-24). Where a summarising fetch tool disagreed with the raw page, the raw page won.
One example: a summary claimed `AppDistributor` exists on macOS 14.4, while Apple's JSON lists iOS and iPadOS only.

Evidence tags used throughout:

- **[V]** read on a primary source this session, as raw text, JSON or a registry record.
- **[S]** from a search-result or fetch-tool summary only. Treat as likely and re-verify before building.
- **[M]** from memory, not re-verified this session.
- **[I]** inference or design recommendation, not a sourced fact.

Runtime shorthand used in tables:

| ID  | Runtime target                                             | SDK today                                                                            |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| N   | Node server or CLI (npm, Node SEA binary, Docker)          | `@polaris-key/node`                                                                  |
| E   | Electron main process (Electron 44.5.0, 2026-09-29 [V])    | `@polaris-key/node` in main + `@polaris-key/react` in renderer                       |
| Py  | Python CLI or desktop app (PyInstaller, Briefcase, Nuitka) | `polaris-key`                                                                        |
| SwM | Swift on macOS (Developer ID, Mac App Store, TestFlight)   | `PolarisKey` (macOS 14+)                                                             |
| SwI | Swift on iOS and iPadOS (App Store, TestFlight, EU)        | `PolarisKey` (iOS 17+)                                                               |
| W   | Browser: React SPA or PWA                                  | `@polaris-key/react`                                                                 |
| T   | Tauri 2.12.0 (Rust shell + system webview) [V crates.io]   | none; `@polaris-key/react` in the webview, Rust side missing                         |
| KA  | Kotlin on Android                                          | none (proposed AAR, README §7.1)                                                     |
| KJ  | Kotlin/JVM desktop (Compose Multiplatform 1.11.0 [S])      | none                                                                                 |
| U   | C# in Unity (6.3 LTS [V])                                  | none                                                                                 |
| D   | C#/.NET 10 desktop and MAUI (WPF, WinUI 3, MAUI 10.0.110)  | none (`Microsoft.WindowsAppSDK` 2.5.1, `Microsoft.Maui.Controls` 10.0.110 [V NuGet]) |

---

## 0. Headline findings

1. **Outlet detection is the least portable feature.** Only iOS and Android give a first-party answer to "how was I
   installed". iOS has `AppDistributor` (iOS and iPadOS 17.4+, `async throws`, cases `appStore`, `testFlight`,
   `marketplace(_:)`, `web`, `other`) [V]. Android has `PackageManager.getInstallSourceInfo` (API 30), with
   `getPackageSource()` (API 33) and `getUpdateOwnerPackageName()` (API 34) [V]. Windows gives package identity plus
   `Package.SignatureKind` and `GetAppInstallerInfo()` [V], which separate Store, App Installer and sideloaded MSIX.
   Everything else (Flatpak, Snap, AppImage, Steam, pip, npm, Homebrew, winget, PWA) is env vars, paths or API probing.
   The build stamp stays the baseline (README §5.5) and runtime evidence overrides it only where the platform knows
   better.
2. **`AppDistributor` and `AppTransaction` are Swift-only, and `AppDistributor` is not on macOS.** Apple's JSON declares
   both in `swift` only, and lists `AppDistributor` for iOS and iPadOS only [V]. Every non-Swift runtime on iOS
   (Unity, MAUI, Tauri iOS, Godot) needs a small Swift shim exposed through `@objc` or C. PyObjC has no MarketplaceKit
   wrapper (the PyPI package does not exist [V]). `Bundle.appStoreReceiptURL` is deprecated since iOS 18 and macOS 15 [V],
   so macOS channel detection is `AppTransaction` plus code-signature inspection.
3. **Self-update has six dynamic feed formats, but only two verify a signature over the payload.** Sparkle
   (EdDSA) and Tauri (minisign, mandatory, "cannot be disabled") do [V]. Electron's built-in `autoUpdater` (Squirrel.Mac,
   Squirrel.Windows, and a new MSIX updater with JSON feeds), Velopack, and MSIX App Installer rely on OS code signing
   [V/S]. So the Polaris SDK should follow a three-depth rule (§3.3): decide only (stores), verify then stage a local
   feed (Velopack accepts a local-directory source [V]), or render the updater's native feed and accept that Polaris'
   own signature protects only the decision.
4. **Electron 44 has more built in than the README assumes.** `autoUpdater` picks Squirrel.Mac, Squirrel.Windows or an
   MSIX updater (JSON feed, detected via `process.windowsStore`); `safeStorage` has an async API with a Portal Secret
   provider for Flatpak and reports `basic_text` when Linux has no secret store [V].
5. **Tauri needs a first-party Rust plugin, not just the React SDK.** The official updater plugin is desktop-only
   (`cfg(any(macos, windows, linux))`) and requires a minisign signature [V]. There is no official OS-keyring plugin:
   Stronghold is a password-derived vault [V]; the `keyring` crate is 4.2.0 (2026-08-29) and the community
   `tauri-plugin-keyring` is 0.1.0 (2024-12) [V]. The three system webviews (WKWebView, WebView2, WebKitGTK) differ, so
   WebCrypto Ed25519 must not be assumed inside the shell [I].
6. **Background downloads are OS-managed only on Apple and Android.** Apple has background `URLSession` (macOS 10.10+,
   iOS 8+), `BGContinuedProcessingTask` (iOS and iPadOS 26) and Background Assets; Android has WorkManager 2.12.0 and
   user-initiated data-transfer jobs (API 34) [V]. Desktop runtimes need the process alive and must handle sleep. Web has
   Background Fetch in Chromium only, and it is flagged experimental [V MDN].
7. **The hidden cross-runtime dependency is hashing and decompression.** WebCrypto `digest()` has no incremental mode [V].
   `DecompressionStream` has no zstd in any shipping browser (Firefox behind a flag) [V]. Apple's Compression framework
   has no zstd either (LZFSE, LZ4, LZMA, ZLIB, BROTLI, LZBITMAP, LZMESH, LZRAVEN only) [V], so **CONTENT §12's
   "Swift: delta (native zstd)" needs a vendored libzstd**, not an OS API. Node's `zlib` zstd is experimental
   (v22.15/v23.8) [V]; Python 3.14 has `compression.zstd` in the stdlib [V]. Recommendation (§4.3): add a universal
   `deflate` chunk codec so `chunk` patching is dependency-free everywhere.
8. **Android moved under our feet.** `androidx.security:security-crypto` has all APIs deprecated [V];
   foreground-service `dataSync` is capped at 6 hours per 24 hours for apps targeting API 35+ [V]; Play Asset Delivery's
   client library is still 2.3.0 from 2024-12-17 [V]; and Android developer verification's first regional deadline is
   **today, 2026-09-30**, for Brazil, Indonesia, Singapore and Thailand on certified devices [V].
9. **Windows packaging changes storage semantics.** An MSIX install root is read-only and locked, and new files a
   packaged desktop app writes under AppData go to a private per-app location that the OS removes on uninstall [V].
   Sparse packages ("package with external location") give identity to unpackaged apps [V], so "has package identity" is
   not "installed from an MSIX outlet". `wmic` is gone from Windows 11 (see §12).
10. **Unity is the outlier.** It has built-in outlet hints (`Application.installerName`, `Application.installMode`) [V],
    but no updater, `StreamingAssets` is a URL rather than a file on Android and Web [V], and `UnityWebRequest` stalls
    when iOS backgrounds the app [S]. It will lean on the same native plugins as Godot.
11. **Steam has a cheap "am I a Steam depot build" test.** `ISteamApps::GetAppBuildId()` "defaults to 0 if you're not
    running a build downloaded from steam" [V]. The bindings differ a lot in health (§8.3).
12. **Client-side Background Assets is reachable outside Swift; the extension is not.** `BAAssetPackManager` has an
    Objective-C declaration [V], PyObjC ships `pyobjc-framework-BackgroundAssets` 12.2.2 [V], .NET for iOS binds
    `BackgroundAssets` [V], and Rust has `objc2-background-assets` 0.3.2 [V]. But the downloader extension
    (`ManagedDownloaderExtension` / `StoreDownloaderExtension`, Swift protocols [V]) is an Xcode app-extension target, so
    the transport is realistic only where the build system lets you add one (Swift, MAUI, Unity post-build, Tauri iOS,
    Godot), not for PyInstaller or Electron packaging [I].
13. **The minimal native footprint is small.** Node, Python, Web, Kotlin and .NET desktop need no native code for the core
    features. Native appears only at platform edges: keyring in Node and Unity, MarketplaceKit and `AppTransaction`
    shims, Steamworks, the Background Assets extension, and Play Asset Delivery through the Kotlin AAR (§10).

---

## 1. Outlet detection

### 1.1 Signal catalogue

| Question                              | Signal                                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                         | Tag         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| iOS: App Store, TestFlight, alt store | `AppDistributor.current` (MarketplaceKit): `appStore`, `testFlight`, `marketplace(_:)`, `web`, `other`                                                                                                                                                                                         | `static var current: AppDistributor { get async throws }`, iOS/iPadOS 17.4+, Swift only. Apple: "check the current source at each launch". Package floor is iOS 17.0, so guard with `#available(iOS 17.4, *)` | [V]         |
| iOS: dev, ad hoc, AltStore            | absence of `AppDistributor` success; `embedded.mobileprovision` present; rewritten bundle id                                                                                                                                                                                                   | Heuristics from E1, not verified                                                                                                                                                                              | [I]         |
| macOS: Mac App Store, TestFlight      | `AppTransaction.shared` (macOS 13+, iOS 16+): `environment` is `production`, `sandbox` or `xcode`; the call throws or fails verification outside App Store distribution                                                                                                                        | `Bundle.appStoreReceiptURL` deprecated iOS 18, macOS 15. TestFlight reporting `sandbox` is community-reported (E1)                                                                                            | [V]/[I]     |
| macOS: Developer ID, Cask             | code signature (`SecCodeCopySigningInformation`): Developer ID vs Apple Distribution; sandbox entitlement; `Caskroom` path                                                                                                                                                                     | Pure Swift                                                                                                                                                                                                    | [M]/[I]     |
| Windows: any MSIX identity            | `GetCurrentPackageFullName` (kernel32, Win10 1709+); `APPMODEL_ERROR_NO_PACKAGE` when unpackaged                                                                                                                                                                                               | Microsoft's own detect page                                                                                                                                                                                   | [V]         |
| Windows: Store vs sideload vs sparse  | `Package.Current.SignatureKind` (`None`, `Developer`, `Enterprise`, `Store`, `System`; Win10 1607+); `Package.Current.GetAppInstallerInfo().Uri` (Win10 1809+) means installed via App Installer; identity without an install under `WindowsApps` means a sparse package                       | Store re-signs packages, so `Store` is a reliable Store signal. Sparse packages grant identity to unpackaged apps                                                                                             | [V]         |
| Windows: winget, Scoop, Chocolatey    | no marker is written into the app; path conventions only                                                                                                                                                                                                                                       | The artifact is usually the same installer as "direct", so a build stamp cannot distinguish it                                                                                                                | [I]         |
| Android: Play vs sideload vs F-Droid  | `getInstallSourceInfo(ownPackage)`: `installingPackageName` (installer of record), `initiatingPackageName`, `originatingPackageName`; `getPackageSource()` (API 33: `STORE`, `LOCAL_FILE`, `DOWNLOADED_FILE`, `OTHER`, `UNSPECIFIED`); `getInitiatingPackageSigningInfo()` (API 30)            | The package source is **declared by the installer** (`UNSPECIFIED` if it did not call `setPackageSource`). Verify the installer via its signing info, or use Play Integrity (E2 §A5)                          | [V]         |
| Android: update ownership             | `getUpdateOwnerPackageName()` (API 34), set by `setRequestUpdateOwnership` at first install                                                                                                                                                                                                    | Null when enforcement is off                                                                                                                                                                                  | [V]         |
| Linux: Flatpak                        | `FLATPAK_ID` env; `/.flatpak-info`; writable data only in `~/.var/app/$FLATPAK_ID`                                                                                                                                                                                                             | Docs confirm the env name and data dir; `/.flatpak-info` is from memory                                                                                                                                       | [V]/[M]     |
| Linux: Snap                           | `SNAP`, `SNAP_NAME`, `SNAP_REVISION`, `SNAP_INSTANCE_NAME`                                                                                                                                                                                                                                     | Search-result quote of the snapcraft reference                                                                                                                                                                | [S]         |
| Linux: AppImage                       | `APPIMAGE` (absolute path of the AppImage), `APPDIR`, `OWD`, `ARGV0` (type 2)                                                                                                                                                                                                                  | `APPIMAGE` is the one to use when touching the file to update it                                                                                                                                              | [V]         |
| Steam                                 | Steamworks: `SteamAPI_RestartAppIfNecessary`; `ISteamApps::GetAppBuildId()` is 0 outside Steam builds; `GetCurrentBetaName`, `GetAppInstallDir`; `steam_appid.txt` present means dev mode; `SteamAppId` / `SteamGameId` env vars set by the client; `steamapps/appmanifest_<id>.acf` `buildid` | API rows verified; the env vars and ACF are unverified. Pure file read of the ACF avoids the native API for detection                                                                                         | [V]/[M]/[I] |
| Python: pip, pipx, uv                 | PEP 376 `INSTALLER` file and PEP 610 `direct_url.json` in the `.dist-info` directory                                                                                                                                                                                                           | The `INSTALLER` file "records the name of the tool used to install the project"                                                                                                                               | [V]         |
| Node: npm, pnpm, npx                  | `npm_config_user_agent`, `npm_execpath` (only inside lifecycle scripts and `npx`); module path containing `node_modules` or `_npx`; `node:sea` `isSea()` for single-file binaries                                                                                                              | `isSea()` says "single executable", not which channel                                                                                                                                                         | [V]/[M]     |
| Homebrew                              | executable realpath under `…/Cellar/…`; casks under `…/Caskroom/…`                                                                                                                                                                                                                             | Cask apps are copied to `/Applications`, so the app path alone is not enough                                                                                                                                  | [M]/[I]     |
| Web: installed PWA                    | `matchMedia('(display-mode: standalone)')` (Chrome 42, Safari 13, iOS 12.2); iOS `navigator.standalone` (non-standard); `getInstalledRelatedApps()` (Chromium only, experimental); Trusted Web Activity `document.referrer` starting `android-app://`                                          | Browser tab vs installed is all the web can say                                                                                                                                                               | [V]/[M]     |
| Unity                                 | `Application.installerName` (iOS: "Apple Store"; Android: installer package name, empty or null when sideloaded; other platforms: empty string); `Application.installMode` (`Store`, `DeveloperBuild`, `Adhoc`, `Enterprise`, `Editor`, `Unknown`)                                             | Built in, no plugin                                                                                                                                                                                           | [V]         |
| Electron                              | `process.mas` (Mac App Store build), `process.windowsStore` (running as MSIX); env vars above                                                                                                                                                                                                  | Documented as current, not deprecated                                                                                                                                                                         | [V]         |

### 1.2 Per runtime: what is pure and what needs native code

| Runtime | Pure language                                                                                                                                                              | Small dependency                                                                                                               | Native module or plugin                                                                                                                                                               | Gotchas                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N       | env vars, path heuristics (`WindowsApps`, `Cellar`, `node_modules`), `isSea()`                                                                                             | `koffi` 3.3.2 (active FFI, 2026-09-27 [V npm]) for a real `GetCurrentPackageFullName` call                                     | none required                                                                                                                                                                         | A CLI is never Store-installed, so the useful outlets are npm, Homebrew, winget/Scoop, SEA binary, Docker                                                                        |
| E       | `process.mas`, `process.windowsStore`, env vars, `app.isInApplicationsFolder()` [M]                                                                                        | none                                                                                                                           | WinRT `SignatureKind` and `GetAppInstallerInfo` (only unmaintained `@nodert-win10-*` 0.4.4 from 2019 [V npm]): tiny N-API addon or helper exe; `AppTransaction` for TestFlight on Mac | MAS sandbox: shelling out to system tools is unreliable [I]; asar is read-only (§4)                                                                                              |
| Py      | env, paths, PEP 376 `INSTALLER`, `ctypes.windll.kernel32.GetCurrentPackageFullName`, receipt file check                                                                    | `winrt-Windows.ApplicationModel` 3.2.1 (2025-06, MIT [V]) for `SignatureKind`; `pyobjc-core` 12.2.2 for Security/StoreKit ObjC | `AppTransaction` (Swift-only), MarketplaceKit (no PyObjC wrapper [V])                                                                                                                 | A PyInstaller `--onefile` exe runs from a temp dir (`sys._MEIPASS`), so path heuristics must use the real `sys.executable` [V]                                                   |
| SwM     | `AppTransaction`, receipt file, code signature, sandbox entitlement, Caskroom path                                                                                         | none                                                                                                                           | none                                                                                                                                                                                  | Sparkle is not allowed in Mac App Store builds (Guideline 2.4.5(vii), E6)                                                                                                        |
| SwI     | `AppDistributor.current`, provisioning-profile file check                                                                                                                  | none                                                                                                                           | none                                                                                                                                                                                  | the enum also has `web` and `marketplace(_:)`; guard with `#available(iOS 17.4, *)` and call at every launch                                                                     |
| W       | display-mode media query, `navigator.standalone`, referrer                                                                                                                 | none                                                                                                                           | none                                                                                                                                                                                  | Cannot tell Store-hosted PWA (Microsoft Store) from a Chrome-installed PWA without a manifest hint [I]                                                                           |
| T       | Rust `std::env`, path checks, `_MASReceipt` file check                                                                                                                     | `windows` 0.62.2 crate for WinRT (`Package`, `PackageCatalog`) [V crates]                                                      | Swift shim for `AppDistributor` / `AppTransaction` (`swift-rs` 1.0.8 [V]); Kotlin plugin for `getInstallSourceInfo` on Tauri Android                                                  | Tauri documents distribution guides for App Store, Google Play, Microsoft Store, Flathub, Snapcraft, AppImage, DMG, deb, rpm, AUR [V nav], so all of those outlets are reachable |
| KA      | `getInstallSourceInfo`, `getPackageSource`, `getUpdateOwnerPackageName`                                                                                                    | Play Integrity client (optional)                                                                                               | none                                                                                                                                                                                  | Guard by API level (30, 33, 34); F-Droid and Obtainium show up as their own installer packages (E2 §B, §C)                                                                       |
| KJ      | env, paths, `Contents/_MASReceipt/receipt` file check                                                                                                                      | JNA 5.19.1 (2026-06-12 [V Maven]) for `GetCurrentPackageFullName`                                                              | `AppTransaction` via a Swift helper                                                                                                                                                   | Compose's jpackage output has no outlet marker; stamp at build                                                                                                                   |
| U       | `Application.installerName`, `installMode`; `DllImport` of `GetCurrentPackageFullName` on Windows standalone; Android `getInstallSourceInfo` via `AndroidJavaObject` [M]   | Steamworks.NET for Steam                                                                                                       | Swift plugin for `AppDistributor` (installerName only says "Apple Store")                                                                                                             | Windows Store (UWP) player is gone, so Windows outlets are Steam, itch and direct                                                                                                |
| D       | `Package.Current`, `SignatureKind`, `GetAppInstallerInfo` via the in-box WinRT projection (`Microsoft.Windows.SDK.NET.Ref` 10.0.26100.87 [V NuGet]); MAUI Android bindings | none                                                                                                                           | MAUI iOS: `AppDistributor` has no .NET binding (the MarketplaceKit page does not exist in the .NET API docs [V]), so a Swift shim                                                     | `Package.Current` throws when the process has no identity [M]; check first                                                                                                       |

---

## 2. Self-update mechanisms

### 2.1 Native mechanism per runtime

| Runtime | Native updater(s)                                                                                                                                                                                                                                                                                                                    | Payload verification                                                                                                                                             | Feed format                                                                                                                                                                                                                                           | Caveats                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N       | none for servers (redeploy). CLIs: package manager (`npm i -g`), or self-replace of a SEA binary. Velopack JS is aimed at Electron/desktop apps                                                                                                                                                                                      | our own: Ed25519 manifest plus SHA-256                                                                                                                           | the Polaris feed directly                                                                                                                                                                                                                             | Windows cannot overwrite a running exe; rename-away then drop-in is the usual trick [M]. Node SEA: `--build-sea`, assets API, VFS added in v26.9.0 (Stability 1.0) [V]                            |
| E       | Built-in `autoUpdater`: macOS Squirrel.Mac (app must be signed), Windows Squirrel.Windows or the MSIX updater (`setFeedURL` takes an MSIX link or a JSON feed "similar to Squirrel.Mac format"), no Linux support [V]. `electron-updater` 6.8.x (`latest*.yml`, blockmap deltas) [V npm]. Velopack JS 1.2.161 (native `.node`) [V]   | Squirrel: OS code signing. electron-updater: publisher/code signature, v27 alpha adds Ed25519 signed manifests (E6). Velopack: no documented feed signature (E6) | Squirrel.Mac JSON (`serverType: "json"`; 200 with JSON and 204 for none per the Squirrel.Mac README [M]), MSIX JSON or direct `.msix` link (`allowAnyVersion` permits MSIX downgrades [V]), electron-updater YAML, Velopack `releases.{channel}.json` | Mac App Store builds cannot self-update. Velopack needs the Squirrel startup code removed and `VelopackApp.build().run()` first in main [V]                                                       |
| Py      | Velopack Python 1.2.161 (needs PyInstaller `--onedir`, explicitly "not `--onefile`"; `vpk` needs the .NET SDK at build time) [V]; `tufup` 0.10.0 (2025-10-04; TUF, bsdiff) [V]. Briefcase and Nuitka: no built-in updater [M]                                                                                                        | Velopack: none on the feed (E6). tufup: TUF metadata                                                                                                             | Velopack feed, or TUF repo                                                                                                                                                                                                                            | Onefile extracts to a temp dir on every start (`_MEI…`), so it is incompatible with directory-replacing updaters [V]                                                                              |
| SwM     | Sparkle 2.10.0 (2026-09-13; macOS 12+) [S]; `PolarisKeyUpdate` already wraps it (package floor macOS 14, so the Sparkle floor does not conflict) [V repo]                                                                                                                                                                            | Sparkle EdDSA `sparkle:edSignature` (same algorithm as the Polaris release key)                                                                                  | appcast XML                                                                                                                                                                                                                                           | Not for Mac App Store. Sandboxed apps must follow Sparkle's separate sandboxing guide [V docs]                                                                                                    |
| SwI     | none. App Store, TestFlight or marketplace does the update                                                                                                                                                                                                                                                                           | store                                                                                                                                                            | n/a                                                                                                                                                                                                                                                   | Decision plus deep link only (`itms-apps://`, TestFlight, marketplace link)                                                                                                                       |
| W       | Service-worker lifecycle: the browser re-fetches the SW script on navigation and at most every 24 hours, and a byte difference installs a new worker that waits until no clients remain or calls `skipWaiting()` [V]; `registration.update()` for an explicit check [V BCD]; `workbox-window` 7.4.1, `vite-plugin-pwa` 1.3.0 [V npm] | browser (same-origin HTTPS, SW byte-diff)                                                                                                                        | the site itself; Polaris `/version` drives a "reload for update" prompt                                                                                                                                                                               | Polaris decides whether to prompt; it cannot deliver bytes                                                                                                                                        |
| T       | `tauri-plugin-updater` 2.13.1 (2026-09-29), **desktop only**; static JSON or dynamic server: 204 for none, 200 with `version`, `url`, `signature`, optional `notes`, `pub_date`; server can override the version comparison "useful if you need to roll back"; Windows `installMode` `passive`, `basicUi`, `quiet` [V]               | **mandatory** signature of the artifact ("cannot be disabled"), public key in `tauri.conf.json`; minisign format                                                 | Tauri JSON                                                                                                                                                                                                                                            | Mobile builds are store-updated. The `signature` value is the `.sig` file's content, not a path or URL [V]                                                                                        |
| KA      | Direct/F-Droid-repo/Obtainium: `PackageInstaller` session. Play: In-App Updates (`com.google.android.play:app-update` 2.1.0, 2023-05-22) [V Maven]                                                                                                                                                                                   | APK signature (same key as the installed app) plus our SHA-256 pin                                                                                               | Polaris feed (`/version`)                                                                                                                                                                                                                             | Play policy forbids self-update outside Play (E6). `USER_ACTION_NOT_REQUIRED` needs a recent target SDK, being installer of record or update owner, and `UPDATE_PACKAGES_WITHOUT_USER_ACTION` [V] |
| KJ      | Conveyor (Hydraulic): Sparkle-enabled macOS bundle, MSIX for Windows, apt repo for Linux, silent updates; free for open source, paid for commercial [S]. Velopack lists Java as "Planned" [V]. `update4j` 1.5.9 last released 2022-02 [V Maven]                                                                                      | Sparkle EdDSA, MSIX signature, apt GPG                                                                                                                           | appcast, `.appinstaller`, apt                                                                                                                                                                                                                         | No in-language library; the Worker would render Conveyor's site layout [I]                                                                                                                        |
| U       | none. Mobile is store-managed. Standalone builds: Steam, itch, or a custom launcher/patcher                                                                                                                                                                                                                                          | n/a                                                                                                                                                              | n/a                                                                                                                                                                                                                                                   | Velopack's hook contract needs to run first in `Main()`, which Unity does not expose; no documented Unity path [I]                                                                                |
| D       | Velopack C# 1.2.161 (`net10.0`, `net9.0`, `net8.0`, `netstandard2.0`, `net472`) with a custom `IUpdateSource` [V]; MSIX App Installer (`.appinstaller`, `OnLaunch`, `HoursBetweenUpdateChecks`; `ms-appinstaller:` scheme disabled by default since Dec 2023) [V]; `NetSparkleUpdater.SparkleUpdater` 3.1.0 (2026-05-05) [V NuGet]   | Velopack: none on the feed. NetSparkle: Sparkle-style appcast and signatures [M]                                                                                 | Velopack feed, `.appinstaller`, appcast                                                                                                                                                                                                               | MAUI mobile is store-managed. NetSparkle would reuse the appcast we already render [I]                                                                                                            |

### 2.2 Feed renderers the Worker would need

One release record (README §8) rendered into each format, so a new outlet is a renderer and never a new architecture:

| Renderer                     | Consumer                                  | Key fields                                                                      | Signature model                                                 |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Sparkle appcast              | Sparkle, WinSparkle, NetSparkle           | enclosure URL, length, `sparkle:edSignature`, `minimumSystemVersion` (now 12.0) | EdDSA = the Polaris release key                                 |
| Tauri dynamic JSON           | `tauri-plugin-updater`                    | `version`, `url`, `signature`, `notes`, `pub_date`; 204 for none                | minisign key (a second key, generated by `pkey sign tauri`) [I] |
| Electron JSON / MSIX JSON    | `autoUpdater` (Squirrel.Mac, MSIX)        | url, name, notes, pub_date; MSIX link                                           | OS code signing                                                 |
| electron-updater YAML        | `electron-updater`                        | `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, sha512, blockmap            | code signing (E6)                                               |
| Velopack `releases.*.json`   | Velopack SDKs (C#, JS, Python, Rust, C++) | Version, SHA1, Size, Full/Delta entries                                         | none on the feed; use local-feed staging (§2.3)                 |
| `.appinstaller`              | Windows MSIX                              | `UpdateSettings`                                                                | package signature                                               |
| Polaris signed feed directly | every Polaris SDK                         | channel feed + release manifest (README §3.3)                                   | two signers                                                     |

### 2.3 Three integration depths

- **A. Decide only.** iOS, Play builds, Mac App Store, Store MSIX, Steam, Flatpak. The SDK returns an outlet-aware decision
  (`store-link`, `inform`, `blocked`) and never touches bytes.
- **B. Verify, then stage.** Node/SEA CLIs, Android direct flavour, Velopack apps (local-directory source is documented:
  `new UpdateManager("C:\\Updates")` [V]). The SDK verifies the two-signer chain, downloads with Range resume, checks
  SHA-256, writes a local feed or a file, then invokes the platform installer. This is the only depth at which Polaris
  verifies the payload for updaters that do not.
- **C. Render the native feed.** Sparkle, Tauri, electron-updater, `.appinstaller`. The updater downloads and verifies with
  its own scheme. Polaris' signature protects only the decision, so pair it with the updater's own signature key (Sparkle
  EdDSA is the release key; Tauri gets its own minisign key).

**Recommended per runtime:** N B; E C for macOS/MSIX plus B where Velopack is chosen; Py B via Velopack Python; SwM C
(Sparkle); SwI A; W A (prompt); T C plus a Rust check that calls the Polaris decision before `downloadAndInstall`; KA B (direct)
and A (Play); KJ C via Conveyor if adopted, otherwise B; U A; D B via Velopack or C via appcast.

### 2.4 Android developer verification (dated)

`developer.android.com/developer-verification` (fetched 2026-09-30) [V]: milestone **September 30, 2026** applies to installs
from participating stores (Google Play, HONOR, OPPO, Galaxy Store, Palm Store, V-Appstore, GetApps) in Brazil, Indonesia,
Singapore and Thailand on certified Android 7+ devices; **2027** goes global. August 2026 launched developer APIs, limited
distribution accounts and the power-user advanced flow. `PackageInstaller.SessionParams` now carries verification-related
parameters [V]. This affects the direct, Obtainium and F-Droid-repo outlets (README §7.2), so a Kotlin SDK's
`PackageInstaller` driver must surface a "developer not verified" outcome rather than treat it as a network error [I].

---

## 3. Background downloads

### 3.1 Per runtime

| Runtime | Mechanism                                                                                                                                                                                                                                                                                                                       | Survives suspend or quit?                                                                                                      | Limits                                                                                                                                                                                                                         | Range resume                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| N       | plain streams (`fetch`, `http`) writing with `fs.createWriteStream(path, { flags: "r+", start })` [M]                                                                                                                                                                                                                           | process lifetime only; detach or run as a service for persistence                                                              | OS sleep kills sockets: re-issue Range with `If-Range` on resume [I]                                                                                                                                                           | manual `Range`                                                                                                           |
| E       | main-process `net` or Node fetch; `powerSaveBlocker.start("prevent-app-suspension")` ("Example use cases: downloading a file"); `powerMonitor` `suspend` and `resume` events [V]                                                                                                                                                | app must stay alive: tray, and `window-all-closed` handling                                                                    | same as Node                                                                                                                                                                                                                   | manual                                                                                                                   |
| Py      | threads or `asyncio` + `httpx`; sleep inhibit via `caffeinate` or IOKit (macOS), `SetThreadExecutionState` via `ctypes` (Windows), `systemd-inhibit` or the Inhibit portal (Linux) [M]                                                                                                                                          | process lifetime                                                                                                               | no portable OS hook; PyInstaller onefile cleanup on kill leaves `_MEI` dirs [V]                                                                                                                                                | manual                                                                                                                   |
| SwM     | `URLSessionConfiguration.background(withIdentifier:)` (macOS 10.10+) handled by a system process; `isDiscretionary`; Background Assets 26+ [V]                                                                                                                                                                                  | yes for background sessions; app relaunched on completion when `sessionSendsLaunchEvents` (default true)                       | resume data valid only if the resource is unchanged, a `GET` over HTTP(S), the server sent `ETag` or `Last-Modified`, supports byte ranges, and the temp file survived [V]                                                     | `downloadTask(withResumeData:)`                                                                                          |
| SwI     | background `URLSession` (survives suspension and system termination; **force-quit by the user cancels all transfers**) [V]; `BGContinuedProcessingTask` (iOS/iPadOS 26, shows a Live Activity, user can cancel, system may kill low-progress tasks) [V]; Background Assets (unmanaged iOS 16+, managed packs iOS 26+) [V]       | yes, except force quit                                                                                                         | data-protection class of the destination matters (§5.1); discretionary tasks wait for power and Wi-Fi                                                                                                                          | same resume-data rules                                                                                                   |
| W       | **Background Fetch** (Chrome and Edge 74+, experimental, not Firefox or Safari) [V]; Background Sync (Chromium only) [V]; otherwise a foreground Worker writing to OPFS with `FileSystemSyncAccessHandle` (Safari 15.2+) plus Wake Lock (Safari 16.4, iOS 18.4) and Web Locks (Safari 15.4) [V]                                 | only Chromium Background Fetch outlives the tab                                                                                | `Cache.put` cannot store 206 (E8 §4.7 [V]); WebKit origin quota 60% of disk (browser) or 15% (other WebKit apps, including embedded webviews); LRU eviction; `persist()` granted by heuristics such as Home Screen web app [V] | `fetch` with `Range` and `If-Range`; CORS needs `Range` allowed and `Content-Range`, `ETag`, `Accept-Ranges` exposed [M] |
| T       | desktop: Rust thread with `reqwest` 0.13.5 (2026-09-08 [V crates]); `tauri-plugin-upload` 2.5.0 is foreground [V]. Mobile: no official background-transfer plugin in the plugin list [V nav]                                                                                                                                    | desktop process lifetime; mobile needs native URLSession or WorkManager plugin                                                 | webview suspends JS on mobile; do the transfer in Rust or native                                                                                                                                                               | manual in Rust                                                                                                           |
| KA      | WorkManager 2.12.0 (2026-09-23, minSdk 24) for work "less than 10 minutes"; **user-initiated data-transfer jobs** (API 34): `RUN_USER_INITIATED_JOBS`, `JobInfo.Builder.setUserInitiated(true)`, `setEstimatedNetworkBytes`, must be scheduled while the app is visible, need a notification; foreground service `dataSync` [V] | yes, within the job rules                                                                                                      | `dataSync` foreground services: 6 hours per 24 hours once targeting API 35 (`onTimeout`) [V]                                                                                                                                   | manual (OkHttp/Ktor `Range`); `DownloadManager` resumes by itself [M]                                                    |
| KJ      | coroutines with Ktor 3.6.0 / OkHttp 5.5.0 [V Maven]; sleep inhibit via JNA [M]                                                                                                                                                                                                                                                  | process lifetime                                                                                                               | same as Python                                                                                                                                                                                                                 | manual                                                                                                                   |
| U       | `UnityWebRequest` + `DownloadHandlerFile` (documented property is `removeFileOnAbort`; no append property [S]); a `Range` request returns 206 [S]                                                                                                                                                                               | desktop: process. **iOS: transfers stall when backgrounded** (Unity issue-tracker reports [S]); Android needs a native service | write your own `DownloadHandlerScript` + `FileStream` to append or write at an offset [S]                                                                                                                                      | manual via `SetRequestHeader("Range", …)`                                                                                |
| D       | `HttpClient` + `RangeHeaderValue`; `Microsoft.Extensions.Http.Resilience` 10.10.0 for retries [V NuGet]; Windows `BackgroundDownloader` (WinRT) [M]; MAUI iOS background session via the `NSUrlSession` binding [M]; MAUI Android needs a WorkManager/foreground service binding [M]                                            | desktop: process; mobile: via platform APIs                                                                                    | as native platforms                                                                                                                                                                                                            | manual                                                                                                                   |

### 3.2 What the server must give every runtime

The transports above only resume if the byte host behaves (CONTENT §9, E5 §4.2, E8 §2.5):

- `Accept-Ranges: bytes`, a **strong** `ETag`, `If-Range` support, correct `Content-Range` on 206, and immutable
  content-addressed URLs. Apple's resume rules list exactly `ETag` or `Last-Modified` plus byte ranges [V].
- Browsers additionally need CORS to allow the `Range` and `If-Range` request headers and expose `Content-Range`,
  `Accept-Ranges` and `ETag` [M].
- The Godot finding that `Authorization` is forwarded on cross-host redirects (README §5.3) is an HTTP-client property.
  Check each runtime's client for it, since Node `fetch`, Python `httpx`, `URLSession` and browsers each handle redirect
  credential stripping differently [I].

### 3.3 Hashing and decompression per runtime

| Runtime | Incremental SHA-256                                                                                                           | zstd decode                                                                                                                                       | deflate/gzip                                                                                                     | Brotli                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| N, E    | `crypto.createHash` ✓                                                                                                         | `zlib.createZstdDecompress`, **Stability 1 Experimental**, added v23.8.0 and v22.15.0; options include `dictionary` and `ZSTD_d_windowLogMax` [V] | ✓                                                                                                                | ✓                                                                         |
| Py      | `hashlib` ✓                                                                                                                   | 3.14 stdlib `compression.zstd` with `ZstdDict(is_raw=True)` and `DecompressionParameter.window_log_max` [V]; earlier: `zstandard`                 | `zlib` ✓                                                                                                         | third-party                                                               |
| SwM/SwI | CryptoKit `SHA256` incremental ✓                                                                                              | **not in Compression framework** [V]; vendored libzstd via SwiftPM (the zstd repo builds under SwiftPM per Swift Package Index [S])               | `COMPRESSION_ZLIB` ✓                                                                                             | `COMPRESSION_BROTLI` ✓                                                    |
| W       | **WebCrypto `digest()` takes one buffer** [V]; `@noble/hashes` 2.4.0 (2026-08-27) or `hash-wasm` 4.12.0 for streaming [V npm] | none native (Firefox flag only) [V]; WASM: `@bokuweb/zstd-wasm` 0.0.27 (2025-02), `fzstd` 0.1.1 (2024-03, decode only) [V npm]                    | `DecompressionStream("deflate-raw")`: Chrome 103, Firefox 113, Safari 16.4 (`gzip` and `deflate`: Chrome 80) [V] | `DecompressionStream("brotli")`: Safari 18.4, Firefox 147; not Chrome [V] |
| T       | Rust `sha2` 0.11.0 ✓                                                                                                          | `zstd` 0.14.0 (C libzstd) or a pure-Rust decoder; `fastcdc` 5.0.0 for chunking [V crates]                                                         | ✓                                                                                                                | ✓                                                                         |
| KA, KJ  | `MessageDigest` ✓                                                                                                             | `zstd-jni` 1.5.7-20 (2026-09-24, JNI, ships Android natives) [V Maven/S]                                                                          | `java.util.zip` ✓                                                                                                | `org.brotli` [M]                                                          |
| U, D    | `IncrementalHash` ✓                                                                                                           | `ZstdSharp.Port` 0.8.8 (2026-04-29, pure C#, MIT) or `ZstdNet` 1.5.7 (native) [V NuGet]                                                           | `DeflateStream`, `GZipStream` ✓                                                                                  | `BrotliStream` ✓ [M]                                                      |

**Recommendation [I].** Add a `deflate-raw` chunk codec to the chunk-bundle format next to `zstd`. Every runtime above
decodes it with no dependency (including browsers, via `DecompressionStream`), which makes `full`, `file` and `chunk`
strategies dependency-free everywhere and confines the small dependency to `zstd` and `delta`. Godot already reuses its
engine decoder for `delta` (README §5.7), which is a Godot-only trick.

**Delta caveat [I].** `zstd --patch-from` uses the old file as a _prefix_. Decoding needs the binding to expose either
`ZSTD_DCtx_refPrefix` or a raw-content dictionary with a raised window limit. Node's `dictionary` option and Python
3.14's `ZstdDict(is_raw=True)` look sufficient but are unverified for multi-hundred-MB prefixes. This is a spike, not a
fact (§13).

---

## 4. Bundled and embedded resources as seeds

The chunk planner (CONTENT §9) copies reusable ranges from a seed. A good seed source has random access, needs no
extraction, and survives updates read-only.

| Runtime | Where embedded files live                                                                                                                                                                                                                        | Random access?                                                                                                         | Notes                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| N       | package files via `import.meta.dirname` [M]; **Node SEA assets**: `sea.getAsset(key)`, `getRawAsset`, `getAssetKeys`, and an experimental read-only VFS (`useVfs`, v26.9.0) [V]                                                                  | assets are in the binary; `getRawAsset` avoids a copy [I]                                                              | native `.node` addons cannot be loaded from the VFS: `process.dlopen()` needs a real file, so write the addon to a temp file first [V] |
| E       | `process.resourcesPath` (`extraResources`: real files) versus `app.asar` (read-only archive exposed through `fs`; `original-fs` bypasses it; some APIs extract to a temp file) [V]                                                               | `extraResources` and `asarUnpack` files: yes. Inside asar: reads work, but no direct file path for mmap-style access   | ASAR integrity is a separate fuse [V]. Use `extraResources` for seeds larger than a few MB [I]                                         |
| Py      | `importlib.resources.files()`; PyInstaller `sys._MEIPASS` (onedir: the `_internal` folder; **onefile: a temp folder unpacked at every launch**) [V]; Briefcase app resources; Nuitka `--include-data-files` [M]                                  | onedir yes; onefile pays extraction of every byte each start                                                           | For GB-scale seeds use onedir and never onefile [I]                                                                                    |
| SwM/SwI | `Bundle.main`, SwiftPM `Bundle.module`; files are part of the code signature and read-only                                                                                                                                                       | yes (`Data(contentsOf:options:.alwaysMapped)` [M])                                                                     | On-Demand Resources (`NSBundleResourceRequest`) is **deprecated at iOS 27** [V]; Background Assets is the replacement                  |
| W       | none. Precache through the service worker (Workbox) into Cache Storage as whole responses [M]                                                                                                                                                    | Cache API stores full responses only (E8 §4.7); read via `Response.blob().slice()`                                     | The web seed is "what the SW precached", not a file                                                                                    |
| T       | `bundle.resources` + `app.path().resolve(…, BaseDirectory::Resource)`; on Android use the fs plugin instead of `std::fs`; frontend assets are embedded in the binary; `include_bytes!` for small seeds [V/M]                                     | desktop yes; Android: resources are APK assets, not plain files [V]                                                    | Tauri's docs have an explicit Android caveat for resources [V]                                                                         |
| KA      | `AssetManager` from `assets/`; `openFd()` "**must be uncompressed, or an exception will be thrown**", so mark seed types in `androidResources.noCompress`; PAD install-time packs are also reachable through `AssetManager` [V/M]                | only uncompressed assets (`AssetFileDescriptor` offset and length inside the APK); compressed ones are sequential-only | Default AGP compression makes `openFd` throw for most types [I]                                                                        |
| KJ      | classpath resources (compressed in jars, sequential) or files added to the packaged app and located via Compose's resources directory; Compose docs list "resources library, JVM resource loading, or adding files to packaged applications" [V] | files added to the package: yes; classpath: no                                                                         | Put seeds outside the jar [I]                                                                                                          |
| U       | `Resources`, `StreamingAssets` (raw files), Addressables local bundles. **On Android and Web `Application.streamingAssetsPath` is a URL, not a file path; use `UnityWebRequest`** [V]                                                            | desktop/iOS StreamingAssets: yes; Android: no direct file API                                                          | Seeds for chunk copying on Android must be read through `UnityWebRequest` or a Java bridge [I]                                         |
| D       | `Assembly.GetManifestResourceStream` (embedded); MAUI `FileSystem.OpenAppPackageFileAsync`; WPF `Content` files next to the exe; packaged WinUI reads `Package.Current.InstalledLocation` (read-only) [M]                                        | embedded resource stream is not seekable to disk offsets [M]; loose files are                                          | Single-file publish hides `Assembly.Location`; use `AppContext.BaseDirectory` [M]                                                      |
| Godot   | `res://` inside the PCK                                                                                                                                                                                                                          | via `FileAccess`; no mmap                                                                                              | README §5.7                                                                                                                            |

---

## 5. Atomic file replace, locking and app-data directories

### 5.1 OS semantics

| OS / filesystem | Atomic replace primitive                                                                                                                                                                                                                                                                                                    | Locking and other gotchas                                                                                                                                                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux, POSIX    | `rename(2)` within one filesystem; `renameat2(RENAME_EXCHANGE)` swaps two paths; fsync file then parent directory [M]                                                                                                                                                                                                       | Replacing an open file is fine (the old inode lives until closed). Cross-device rename fails with `EXDEV`. Flatpak and Snap confine writable paths                                                                                                                                                                                                                      |
| macOS, APFS     | `rename(2)`; `renamex_np(RENAME_SWAP)` [M]; `FileManager.replaceItemAt(_:withItemAt:backupItemName:options:)` ("ensures no data loss"; **same volume only**, keeps creation date and permissions by default) [V]; `F_FULLFSYNC` for a true flush [M]                                                                        | App Sandbox container paths; downloaded files can carry the quarantine attribute [M]                                                                                                                                                                                                                                                                                    |
| Windows, NTFS   | `ReplaceFileW` (documented replace with optional backup, with enumerated partial-failure states) [V]; `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` (documented to replace the destination's contents, but the page makes no atomicity promise) [V]; `SetFileInformationByHandle` with POSIX rename semantics on Win10 1809+ [M] | A file open **without `FILE_SHARE_DELETE`** cannot be renamed or deleted. Antivirus and the indexer hold transient locks, so retry with backoff [M]. A running exe or dll can be renamed but not overwritten or deleted [M]. Paths over `MAX_PATH` need opt-in long path support [V]. MSIX install root is read-only and virtualized AppData is per app (§0 item 9) [V] |
| iOS             | as APFS; **data-protection class** per file: default `CompleteUntilFirstUserAuthentication`; `Complete` is unreadable while locked, which breaks finalizing a background download [V]                                                                                                                                       | `isExcludedFromBackup` for re-downloadable content [V]; `Caches` may be purged; store paths relative to the container because the absolute path can change [M]                                                                                                                                                                                                          |
| Android         | `File.renameTo`, `Files.move(ATOMIC_MOVE)` within one filesystem; `android.util.AtomicFile` for small files [M]                                                                                                                                                                                                             | `filesDir` (private, included in Auto Backup), `noBackupFilesDir` (excluded), `cacheDir` (evictable), `getExternalFilesDir` (app-specific external). Scoped storage restricts shared external storage, not these app-private and app-specific directories [M]. Auto Backup restore can leave Keystore-backed data undecryptable [V MAUI doc]                            |
| Web, OPFS       | `FileSystemWritableFileStream` commits on `close()` (swap-file semantics [M]) but exists in **Safari only from 26** (Chrome 86, Firefox 111) [V]; `createSyncAccessHandle` in a Worker (Safari 15.2) [V]; `FileSystemHandle.move()` is non-standard and partial in Chromium [V]                                             | Storage is per origin, LRU-evicted, `persist()` is heuristic [V]. **An IndexedDB transaction that flips an "active set" pointer is the reliable atomic step** [I]                                                                                                                                                                                                       |

### 5.2 Per runtime API

| Runtime | Replace call                                                                                                                                  | Gotchas                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N, E    | `fs.rename` after `fsync`; `write-file-atomic` 8.0.0 (2026-05-08) for small files [V npm]                                                     | Windows `EPERM`/`EBUSY` under AV: retry loop (what `graceful-fs` does) [M]. Electron: asar is read-only, use `original-fs` only to read the archive [V] |
| Py      | `os.replace(src, dst)`: "If successful, the renaming will be an atomic operation (this is a POSIX requirement)"; fails across filesystems [V] | Python opens files without delete-sharing on Windows [M]                                                                                                |
| SwM/SwI | `FileManager.replaceItemAt` [V]                                                                                                               | choose a temp directory on the destination volume (`.itemReplacementDirectory`) [V]                                                                     |
| W       | IndexedDB pointer flip; OPFS `createWritable` where available                                                                                 | no atomic directory swap                                                                                                                                |
| T       | `std::fs::rename` or `tempfile::NamedTempFile::persist` (tempfile 3.27.0 [V crates]); `atomicwrites` 0.4.4 (2024-09) [V]                      | Windows share-mode rules as above                                                                                                                       |
| KA, KJ  | `Files.move(…, ATOMIC_MOVE)`                                                                                                                  | on Windows the JDK uses `MoveFileEx`; expect `AccessDeniedException` when the target is open [M]                                                        |
| U, D    | `File.Replace(src, dst, backup)` (documented) or `File.Move(src, dst, overwrite: true)` [V/M]                                                 | Unity's Mono/IL2CPP file APIs are a subset; test `File.Replace` on each target [I]                                                                      |

### 5.3 App-data directories

| Runtime | Config                                                                                                           | Data (packs)                                                   | Cache                            | Notes                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| N       | XDG or `env-paths` 4.0.0 [V npm]                                                                                 | same                                                           | same                             | current SDK: `$XDG_CONFIG_HOME` or `~/.config` on **every** OS (§12)                                                                              |
| E       | `app.getPath("userData")` [M]                                                                                    | `userData`                                                     | `sessionData` / `temp` [M]       | MAS: container home. MSIX: virtualized                                                                                                            |
| Py      | `platformdirs` 4.12.2: `user_config_dir`, `user_data_dir`, `user_cache_dir`, `user_state_dir` [V version, M API] | `user_data_dir`                                                | `user_cache_dir`                 | Microsoft Store Python sandboxes AppData; resolve the real path [M]. Current SDK: `~/.config`                                                     |
| SwM/SwI | `applicationSupportDirectory`                                                                                    | `applicationSupportDirectory`, flag `isExcludedFromBackup` [V] | `cachesDirectory`                | MAS: sandbox container. Current SDK: `~/.config` on macOS, Application Support on iOS [V repo]. App Group container for extension-shared data [M] |
| W       | IndexedDB                                                                                                        | OPFS (`navigator.storage.getDirectory()`, Safari 15.2+ [V])    | Cache Storage                    | request `persist()` after engagement                                                                                                              |
| T       | `app.path().app_config_dir()`                                                                                    | `app_local_data_dir()`                                         | `app_cache_dir()` [M]            | webview storage is separate from Rust-side files                                                                                                  |
| KA      | `filesDir`                                                                                                       | `filesDir` or `noBackupFilesDir` for re-downloadable packs     | `cacheDir`                       | PAD packs are managed by Play                                                                                                                     |
| KJ      | none standard on the JVM                                                                                         | hand-rolled per OS or a small library                          | same                             | [I]                                                                                                                                               |
| U       | `Application.persistentDataPath` [V]                                                                             | same                                                           | `Application.temporaryCachePath` |                                                                                                                                                   |
| D       | `Environment.SpecialFolder.ApplicationData`, MAUI `FileSystem.AppDataDirectory` [M]                              | `LocalApplicationData`                                         | `FileSystem.CacheDirectory`      | packaged WinUI: `ApplicationData.Current.LocalFolder`                                                                                             |

### 5.4 Recommended activation design [I]

CONTENT §9 already stages into `store/<sha>` and writes state by temp plus rename. The cross-runtime consequence:

- Content-addressed directories never overwritten, plus one small **active-set record** replaced atomically. On Windows,
  wrap the replace in a bounded retry with backoff.
- Do not depend on directory symlinks: Windows symlinks need privilege or developer mode, junctions are Windows only,
  and OPFS has no directory rename. The pointer file (or IndexedDB record) works identically everywhere.
- Free-space preflight per runtime: Node `fs.statfs`, Python `shutil.disk_usage`, Swift `volumeAvailableCapacityForImportantUsage`,
  Android `StatFs`, web `navigator.storage.estimate()` (Safari 17+ [V]) [M].

---

## 6. Secure storage

| Runtime | Store and API                                                                                                                                                                                                                                                                                           | Strength and limits                                                                                                                                                                          | Gotchas                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N       | `@napi-rs/keyring` 2.1.0 (2026-09-13; prebuilt darwin arm64/x64, win32 x64/arm64/ia32, linux gnu and musl incl. riscv64, freebsd) [V npm]. Repo pins `^1.1.6` as an optional dependency [V]. `keytar` last released 2022-02-17 and its repository was archived 2022-12-15 [S]                           | OS keyring; falls back to a 0600 file when the module is missing or the keyring errors (repo behaviour)                                                                                      | Headless Linux has no Secret Service. **Native addons cannot be loaded from a SEA VFS** [V], so a SEA build silently takes the file fallback unless the addon is extracted to a temp file                               |
| E       | `safeStorage`: macOS Keychain, Windows DPAPI, Linux kwallet/kwallet5/kwallet6 or gnome-libsecret; async API with `org.freedesktop.portal.Secret` (preferred for Flatpak) or Secret Service and a fallback provider [V]                                                                                  | DPAPI protects from other users but **not from other apps in the same user session** [V]; on Linux with no store `getSelectedStorageBackend()` returns `basic_text` (hardcoded password) [V] | macOS: the app must be code signed or the Keychain re-prompts on every update [V]; encrypts a blob you store yourself                                                                                                   |
| Py      | `keyring` 25.7.0 (2025-11-16): macOS Keychain, Windows Credential Manager, Secret Service/KWallet [V version, M backends]                                                                                                                                                                               | OS keyring; headless hosts fail and the repo falls back to a file                                                                                                                            | Windows Credential Manager blobs are limited to `CRED_MAX_CREDENTIAL_BLOB_SIZE` = 5\*512 = **2560 bytes** [V]; PyInstaller can miss backends discovered by entry point, so add hidden imports (there is a hook set) [M] |
| SwM/SwI | Keychain generic password; repo uses service `pkey:<slug>` with `kSecAttrAccessibleAfterFirstUnlock` [V repo]                                                                                                                                                                                           | on macOS `kSecAttrAccessible` applies only with `kSecUseDataProtectionKeychain` = true [V]                                                                                                   | see §12: the repo sets the attribute without the flag                                                                                                                                                                   |
| W       | no keyring. Non-extractable `CryptoKey` (structured-cloneable into IndexedDB) [M]; WebCrypto Ed25519: Chrome 137, Firefox 129, Safari 17 [V BCD]                                                                                                                                                        | protects against exfiltration of key bytes, not against use by script running in the origin (XSS)                                                                                            | Safari deletes script-writable storage after 7 days without interaction unless persistent (E8 §4.7). Prefer memory tokens and HttpOnly cookies for browser OIDC [I]                                                     |
| T       | Rust `keyring` 4.2.0 (2026-08-29) [V crates]; `tauri-plugin-keyring` 0.1.0 (2024-12-23) [V]; `tauri-plugin-stronghold` 2.4.0 is a password-derived vault [V]; `tauri-plugin-store` 2.5.0 is plain JSON [V]                                                                                              | OS keyring via the crate                                                                                                                                                                     | Mobile needs Keychain and Keystore through native plugin code                                                                                                                                                           |
| KA      | Android Keystore (hardware-backed on TEE or StrongBox, API 28+ [V]) with DataStore 1.2.1 [V Maven]; Tink 1.23.0 [V Maven]                                                                                                                                                                               | hardware-backed keys; **`androidx.security:security-crypto` deprecates all APIs "in favour of existing platform APIs and direct use of Android Keystore"** [V]                               | Auto Backup can restore ciphertext whose Keystore key is gone; exclude via `dataExtractionRules` or use `noBackupFilesDir` [V MAUI doc]                                                                                 |
| KJ      | JNA 5.19.1 to Keychain, Credential Manager and libsecret; `java-keyring` 1.0.4 last released 2023-08 [V Maven]; FFM API on JDK 22+ [M]                                                                                                                                                                  | OS keyring                                                                                                                                                                                   | The one JVM library is stale; budget for a small in-house wrapper [I]                                                                                                                                                   |
| U       | none built in (`PlayerPrefs` is plaintext) [M]. iOS Keychain and Android Keystore need plugins; Windows DPAPI through .NET                                                                                                                                                                              | depends on plugin                                                                                                                                                                            | This is the one place Unity needs native plugin work for a core feature                                                                                                                                                 |
| D       | `ProtectedData` (DPAPI): "supported on the Windows platform only", throws `PlatformNotSupportedException` elsewhere [V]; MAUI `SecureStorage` (Keychain, Keystore-backed prefs, Windows data protection) with the Auto Backup caveat [V]; `Meziantou.Framework.Win32.CredentialManager` 3.0.4 [V NuGet] | OS-backed                                                                                                                                                                                    | WPF/WinUI are Windows only; a cross-platform .NET desktop app needs per-OS branches                                                                                                                                     |

**Design consequence [I].** Keep only the token and one wrapping key in the keyring. Everything else stays in the file
cache, which is already integrity-protected by signatures. That sidesteps Windows' 2560-byte blob limit, headless Linux
and SEA. If secrets need at-rest protection, encrypt them under a keyring-held key and store the ciphertext in the cache.

---

## 7. Platform transports: language bindings

### 7.1 Apple Background Assets

| Piece                                | API                                                                                                                                                                                                           | Language reach                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed client                       | `AssetPackManager` (Swift actor, iOS/macOS/tvOS/visionOS **26.0+**) and `BAAssetPackManager` (Objective-C, same OS floor); Info.plist keys `BAHasManagedAssetPacks`, `BAUsesAppleHosting`, `BAAppGroupID` [V] | Swift; ObjC bridges: PyObjC (`pyobjc-framework-BackgroundAssets` 12.2.2 [V]), .NET for iOS (`BAAssetPackManager` in the API docs [V]), Rust (`objc2-background-assets` 0.3.2 [V]) |
| Downloader extension                 | `ManagedDownloaderExtension` (self-hosted) or `StoreDownloaderExtension` (Apple-hosted), Swift protocols; ObjC equivalents `BAManagedDownloaderExtension` and `SKDownloaderExtension` [V]                     | an Xcode app-extension target with an App Group; not producible by PyInstaller or Electron packaging [I]                                                                          |
| Unmanaged (self-hosted, lower level) | `BADownloadManager`, `BADownloaderExtension`, `BAURLDownload`; iOS 16+, macOS 13+ [V]                                                                                                                         | same                                                                                                                                                                              |
| Hosting                              | Apple-hosted packs work for App Store and TestFlight installs; Developer ID and sideload behaviour is undocumented (E1 §E)                                                                                    | n/a                                                                                                                                                                               |

Apple's doc also says to use the framework only to download additional assets and "don't collect or transmit data to
identify a user or device" [V]. It follows that a manifest fetched by the extension should not carry the Polaris device
token or fingerprint [I].

### 7.2 Google Play Asset Delivery

| Language              | Route                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Kotlin and Java       | `com.google.android.play:asset-delivery` and `asset-delivery-ktx` **2.3.0** (Google Maven, last updated 2024-12-17) [V]  |
| C and C++             | Play Core Native SDK, header `play/asset_pack.h`, download `play-core-native-sdk-1.16.0.zip` [V]                         |
| Unity                 | Google's "Integrate asset delivery (Unity)" page and plugin [V nav]                                                      |
| .NET Android and MAUI | `Xamarin.Google.Android.Play.Asset.Delivery` 2.3.0.8 (2026-09-02, `net10.0-android36.0`, `net9.0-android35.0`) [V NuGet] |
| Tauri Android         | a Kotlin plugin plus AAB asset-pack modules configured in Gradle [I]                                                     |
| Others                | not applicable (Play only, tied to `versionCode`, CONTENT §6)                                                            |

### 7.3 Steamworks

| Runtime | Binding and health                                                                                                                                                                                                                       | Notes                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| N, E    | `steamworks.js` (repo active, 213 commits, 630 stars [S]; **npm latest 0.4.0 published 2024-08-06** [V]) and `steamworks-ffi-node` 0.11.3 (2026-09-24, MIT) [V npm]. Electron: native module, needs renderer flags and overlay setup [S] | check which one tracks the current Steamworks SDK before committing    |
| Py      | `SteamworksPy` 0.0.2 on PyPI (2024-11-30) [V]; the well-known ctypes wrapper is GitHub only [M]                                                                                                                                          | thin, low activity                                                     |
| U, D    | `Steamworks.NET` 2024.8.0 (2024-08-29) and `Facepunch.Steamworks` 2.3.3 (**2020-02-28**) on NuGet [V]                                                                                                                                    | `Steamworks.NET` is the safer pick; Facepunch's NuGet package is stale |
| T       | `steamworks` crate 0.13.1 (2026-05-05) and `steamworks-sys` 0.13.0 [V crates]                                                                                                                                                            |                                                                        |
| KJ      | `steamworks4j` 1.10.0 (2025-12-10) [V Maven]                                                                                                                                                                                             | JNI                                                                    |
| Godot   | GodotSteam 4.20 shipped with Godot 4.7; Steamworks SDK 1.64 was being integrated in 2026-05 [S]                                                                                                                                          | README §7                                                              |

API surface that matters to Polaris [V]: `ISteamApps::GetAppBuildId`, `GetCurrentBetaName`, `GetAppInstallDir`,
`BIsDlcInstalled`, `InstallDLC`, `GetDlcDownloadProgress`. Detection and version marking can avoid the native API by
reading the depot marker (`.pkey/pack.json`, CONTENT §6) and the Steam library's `appmanifest_<id>.acf` [I], leaving the
API only for DLC ownership and install triggers. Never write into the install directory (E8 §4.4).

### 7.4 MSIX optional packages

WinRT `PackageCatalog.OpenForCurrentPackage()` and `AddOptionalPackageAsync` (Win10 1703), `RemoveOptionalPackagesAsync`
(1709), plus `PackageStatusChanged` and staging events; optional packages are "useful for downloadable content (DLC)",
and related sets enforce a strict version set [V]. All of it needs package identity.

| Runtime         | Route                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D               | in-box WinRT projection                                                                                                                   |
| Py              | `winrt-Windows.ApplicationModel` 3.2.1 (pywinrt) [V]                                                                                      |
| T               | `windows` 0.62.2 crate [V]                                                                                                                |
| E, N            | no maintained Node WinRT binding (`@nodert-win10-rs4/windows.applicationmodel` 0.4.4 is from 2019 [V]); a helper exe or small N-API addon |
| KJ              | JNA or a helper exe [I]                                                                                                                   |
| U               | WinRT is awkward from a Mono/IL2CPP standalone player; treat as native work [I]                                                           |
| W, SwM, SwI, KA | not applicable                                                                                                                            |

### 7.5 Flatpak

Content arrives as extensions (a directory the app reads: pure file access) and the update flow is the portal
`org.freedesktop.portal.Flatpak` with `CreateUpdateMonitor`, an `UpdateAvailable` signal and `Update` [S]. Sandboxed apps
may talk only to their own bus names and `org.freedesktop.portal.*` [V]. D-Bus clients: Python `dbus-fast` 5.0.22 and
`jeepney` 0.9.0 [V], Rust `ashpd` [S], Node `dbus-next` [M], .NET `Tmds.DBus` [M], JVM `dbus-java` [M].

---

## 8. Boot, update and login experience

The stage protocol is shared (README §5.8, §8 item 6): `SHELL → GUARD → SYNC → GATE → DECIDE → FETCH → MOUNT → READY`, plus
`BACKGROUND`, `OFFLINE`, `ERROR`. What differs is the renderer. The right shape is a **headless state machine that emits
stage events**, and a thin renderer per toolkit.

| Runtime | Renderer                                                                                                           | Component name (proposed)                         | Notes                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| N (CLI) | terminal UI: `ink` 7.1.1 (React for CLIs, 2026-07-16) or plain ANSI; `@clack/prompts` 1.8.1 for prompts [V npm]    | `runBoot()` printing stage lines, `--json` events | no TTY: print URL and code, no QR                                                           |
| E       | BrowserWindow with `<PolarisBoot>` from `@polaris-key/react` over the existing desktop-over-node bridge            | reuse `<PolarisBoot>`                             | `shell.openExternal` for the verification URI                                               |
| Py      | CLI: `rich` 15.0.0 (Live, progress) or `textual` 8.2.8 (full TUI); desktop: Toga 0.5.6 (Briefcase) [V PyPI]        | `polaris_key.ui.rich_boot()`, Toga widget         | no single Python desktop toolkit, so ship the event stream plus two reference renderers [I] |
| SwM/SwI | SwiftUI; the repo already has `PolarisLoginView` and `PolarisTheme` in `PolarisKeyUI` [V repo]                     | `PolarisBootView`                                 | macOS and iOS from one view                                                                 |
| W       | React                                                                                                              | `<PolarisBoot>`                                   | PWA: add an update toast driven by `waiting`                                                |
| T       | the same React component in the webview; Tauri docs list a splashscreen guide and a deep-link plugin [V nav]       | `<PolarisBoot>` + Rust events                     | boot may need to run before the main window                                                 |
| KA, KJ  | Jetpack Compose (Android) and Compose Multiplatform 1.11.0 (Desktop; iOS stable since 1.8, web beta since 1.9 [S]) | `PolarisBoot` composable                          | one composable for both                                                                     |
| U       | UI Toolkit (runtime) or uGUI in a UPM package with UXML and USS                                                    | `PolarisBoot` prefab                              | gamepad focus needed (README §5.8)                                                          |
| D       | WinUI 3 (Windows App SDK 2.5.1), WPF and MAUI controls over one shared view model                                  | `PolarisBootView` ×3                              | three XAML dialects; keep logic in a `netstandard2.0` library [I]                           |

### 8.1 QR rendering per runtime

| Runtime | Option                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| N       | `uqr` 0.1.3 (2026-04), `lean-qr` 2.7.4 (2026-09), or `qrcode` 1.5.4 (2024-08); `qrcode-terminal` last released 2018 [V npm]                      |
| E, W, T | `qrcode.react` 4.2.0 (2024-12) or `react-qr-code` 2.2.0 (2026-06) [V npm]; `@paulmillr/qr` is renamed to `qr` and the old name is deprecated [V] |
| Py      | `segno` 1.6.6 (zero-dependency, terminal and SVG output) or `qrcode` 8.2 [V PyPI]                                                                |
| SwM/SwI | CoreImage `CIFilter.qrCodeGenerator` [M]                                                                                                         |
| KA, KJ  | ZXing core 3.5.4 (2025-11) or `qrose` 1.3.0 (Compose Multiplatform, 2026-09) [V Maven]                                                           |
| U, D    | `QRCoder` 1.8.0 (2026-04, MIT; SVG and PNG renderers are pure managed) [V NuGet]                                                                 |
| any     | alternative: the Worker returns an SVG QR for `verification_uri_complete`, so no client needs a QR library [I]                                   |

### 8.2 Browser sign-in launchers (identity, non-device-code)

| Runtime   | Launch and redirect                                                                           |
| --------- | --------------------------------------------------------------------------------------------- |
| N, Py, KJ | system browser plus a loopback listener (`open` 11.0.4, `webbrowser`, `java.awt.Desktop`) [M] |
| E         | loopback or custom protocol with a single-instance lock [M]                                   |
| SwM/SwI   | `ASWebAuthenticationSession` with own PKCE (README §7.1)                                      |
| W         | redirect or popup (`@polaris-key/react` browser-OIDC today)                                   |
| T         | loopback or the deep-link plugin [V nav]                                                      |
| KA        | Custom Tabs with own PKCE (AppAuth-Android unmaintained since 2021, README §7.1)              |
| U, D      | `Application.OpenURL` or MAUI `WebAuthenticator` [M]                                          |

---

## 9. Minimal native footprint per runtime

| Runtime | Required native code                                                                                  | Optional native code                                                                | Recommendation [I]                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N       | none                                                                                                  | `@napi-rs/keyring` (prebuilt), `koffi` for MSIX identity                            | Keep the file fallback. Document the SEA limitation and extract the addon to a temp file, or refuse to fall back silently                                                                   |
| E       | none                                                                                                  | WinRT `SignatureKind` helper; `AppTransaction` addon; Steam addon; Velopack `.node` | Use `safeStorage` instead of the keyring addon; use `extraResources` for seeds                                                                                                              |
| Py      | none                                                                                                  | `keyring`, `zstandard` (< 3.14), Velopack wheel, `winrt-*`, PyObjC                  | Ship the core dependency-free (aside from `cryptography` and `httpx`, already required); make everything else extras                                                                        |
| SwM     | none                                                                                                  | vendored libzstd; Sparkle                                                           | Sparkle stays in `PolarisKeyUpdate`; add zstd as an opt-in target so an app that does no content delivery does not link it                                                                  |
| SwI     | none                                                                                                  | Background Assets extension target                                                  | `PolarisKeyContentApple` product for the extension                                                                                                                                          |
| W       | none                                                                                                  | WASM zstd and hashing                                                               | Use `deflate-raw` and `@noble/hashes`; WASM only for zstd and delta                                                                                                                         |
| T       | a first-party Rust plugin crate (keyring, fingerprint, outlet, atomic fs, downloader, updater bridge) | Swift and Kotlin shims for Tauri mobile; Steam crate                                | Do not port the wire core to Rust. Run verification in the webview with `@polaris-key/react` and fall back to `ed25519-dalek` 3.0.0 on a webview that lacks Ed25519 [I]. Defer Tauri mobile |
| KA      | none (pure Kotlin AAR)                                                                                | `zstd-jni` (.so); PAD and In-App Updates AndroidX libraries                         | The AAR doubles as the Godot Android backend and the MAUI and Unity Android plugin (README §7.1); ship `play` and `foss` flavours                                                           |
| KJ      | none                                                                                                  | JNA for keyring and MSIX identity                                                   | Share the Kotlin core with Android; isolate platform calls behind an interface                                                                                                              |
| U       | Swift shim (`AppDistributor`, Keychain, Background Assets) for iOS                                    | Android AAR reuse; Steamworks.NET                                                   | One UPM package with prebuilt native plugins produced from the Swift and Kotlin SDKs                                                                                                        |
| D       | none                                                                                                  | BouncyCastle 2.7.0 or NSec 26.4.0 for Ed25519; `ZstdSharp.Port`; QRCoder            | Target `netstandard2.0` for the core so Unity and MAUI share it; per-platform head projects for keyring and outlet                                                                          |

---

## 10. Runtime × feature matrix

Legend:

- **✓** pure: the runtime's own language, standard library or platform API. No third-party code beyond what the SDK
  already ships.
- **◐** small dependency: a third-party library in the runtime's language, including ones that bundle prebuilt binaries
  the adopter never builds.
- **●** native module: code the adopter must build, link or sign for that runtime (N-API addon, Swift or Kotlin shim,
  Xcode extension target, AAR, JNI, Rust plugin with native calls).
- **✗** not applicable on that runtime, with the reason in the footnote.
- A slash separates sub-cases, most common first. **†** delta patching: needs prefix-dictionary decode support (§3.3), a spike.

Columns: **N** Node, **E** Electron main, **Py** Python, **SwM** Swift macOS, **SwI** Swift iOS, **W** web/React, **T** Tauri,
**KA** Kotlin Android, **KJ** Kotlin/JVM desktop, **U** Unity, **D** .NET desktop and MAUI.

### 10.1 Server, desktop shells and Apple

| Feature                                 | N                 | E               | Py             | SwM          | SwI          |
| --------------------------------------- | ----------------- | --------------- | -------------- | ------------ | ------------ |
| Ed25519 + JWS verify (prerequisite)     | ✓                 | ✓               | ◐ 1            | ✓            | ✓            |
| Fingerprint components                  | ✓ 2               | ✓/● 3           | ✓ 2            | ✓            | ✓ 4          |
| Keyring / secure token store            | ● 5               | ✓ (safeStorage) | ◐ (keyring)    | ✓ (Keychain) | ✓ (Keychain) |
| Device-code sign-in                     | ✓                 | ✓               | ✓              | ✓            | ✓            |
| QR rendering                            | ◐                 | ◐               | ◐              | ✓            | ✓            |
| Outlet detection                        | ✓/◐               | ✓/●             | ✓/◐            | ✓            | ✓            |
| Update decision (pure function)         | ✓                 | ✓               | ✓              | ✓            | ✓            |
| Self-update driver                      | ✓ 6               | ◐/●             | ◐              | ◐ (Sparkle)  | ✗ 7          |
| Content: full                           | ✓                 | ✓               | ✓              | ✓            | ✓            |
| Content: file                           | ✓                 | ✓               | ✓              | ✓            | ✓            |
| Content: chunk (zstd; ✓ with `deflate`) | ◐                 | ◐               | ◐              | ◐            | ◐            |
| Content: delta (`patch-from`)           | ◐†                | ◐†              | ◐†             | ◐†           | ◐†           |
| Background download                     | ✓                 | ✓               | ✓              | ✓            | ✓            |
| Transport apple-ba                      | ✗ 8               | ● 9             | ✗/● 9          | ✓ (26+)      | ✓ (26+)      |
| Transport play-pad                      | ✗ 10              | ✗ 10            | ✗ 10           | ✗ 10         | ✗ 10         |
| Transport steam-depot                   | ● (or ✓ ACF read) | ●               | ◐/●            | ●            | ✗ 11         |
| Transport msix-optional                 | ✗ 12              | ●               | ◐              | ✗ 13         | ✗ 13         |
| Transport flatpak                       | ◐                 | ◐               | ◐              | ✗ 13         | ✗ 13         |
| Atomic activation                       | ✓                 | ✓               | ✓              | ✓            | ✓            |
| Boot/update UI component                | ◐ (TUI)           | ✓ (React)       | ◐ (rich, Toga) | ✓ (SwiftUI)  | ✓ (SwiftUI)  |

### 10.2 Web, Tauri, Android, JVM, Unity and .NET

| Feature                                 | W                     | T                    | KA                    | KJ           | U                    | D                        |
| --------------------------------------- | --------------------- | -------------------- | --------------------- | ------------ | -------------------- | ------------------------ |
| Ed25519 + JWS verify (prerequisite)     | ✓/◐ 14                | ◐ 15                 | ◐ 16                  | ✓ 17         | ◐ 18                 | ◐ 18                     |
| Fingerprint components                  | ✗ 19                  | ◐                    | ✓ 20                  | ◐            | ✓ 21                 | ◐                        |
| Keyring / secure token store            | ✗ 22                  | ◐ (keyring crate)    | ✓ (Keystore)          | ◐ (JNA)      | ●                    | ✓ (SecureStorage, DPAPI) |
| Device-code sign-in                     | ✓                     | ✓                    | ✓                     | ✓            | ✓                    | ✓                        |
| QR rendering                            | ◐ (or server SVG)     | ◐                    | ◐                     | ◐            | ◐                    | ◐                        |
| Outlet detection                        | ✓ (PWA only)          | ◐/●                  | ✓                     | ◐/●          | ✓/●                  | ✓/●                      |
| Update decision (pure function)         | ✓                     | ✓                    | ✓                     | ✓            | ✓                    | ✓                        |
| Self-update driver                      | ✓ (SW flow)           | ◐ (desktop only)     | ◐                     | ◐ (Conveyor) | ✗ 23                 | ◐ (Velopack, MSIX)       |
| Content: full                           | ◐ 24                  | ✓                    | ✓                     | ✓            | ✓                    | ✓                        |
| Content: file                           | ◐ 24                  | ✓                    | ✓                     | ✓            | ✓                    | ✓                        |
| Content: chunk (zstd; ✓ with `deflate`) | ◐ (WASM)              | ◐                    | ◐                     | ◐            | ◐                    | ◐                        |
| Content: delta (`patch-from`)           | ●†                    | ◐†                   | ◐†                    | ◐†           | ◐†                   | ◐†                       |
| Background download                     | ◐ 25                  | ✓ desktop / ● mobile | ◐ (WorkManager, UIDT) | ✓            | ✓ desktop / ● mobile | ✓/◐                      |
| Transport apple-ba                      | ✗ 8                   | ●                    | ✗ 26                  | ✗ 26         | ●                    | ●                        |
| Transport play-pad                      | ✗ 10                  | ● (Android)          | ◐                     | ✗ 10         | ◐                    | ◐                        |
| Transport steam-depot                   | ✗ 11                  | ◐                    | ✗ 11                  | ●            | ◐                    | ◐                        |
| Transport msix-optional                 | ✗ 12                  | ◐                    | ✗ 13                  | ●            | ●                    | ✓                        |
| Transport flatpak                       | ✗ 13                  | ◐                    | ✗ 13                  | ◐            | ✗/◐ 27               | ◐                        |
| Atomic activation                       | ✓ (IndexedDB pointer) | ✓                    | ✓                     | ✓            | ✓                    | ✓                        |
| Boot/update UI component                | ✓ (React)             | ✓ (React)            | ✓ (Compose)           | ✓ (Compose)  | ✓ (UI Toolkit)       | ✓ (XAML ×3)              |

Footnotes:

1. Python needs the `cryptography` wheel (already a required dependency of `polaris-key`).
2. Exec-based reads; on Windows `wmic` is gone from Windows 11 (§12), so `boardSerial` and `machineModel` need PowerShell CIM
   or SMBIOS (`GetSystemFirmwareTable`) [I]. On Linux `product_uuid` and `*_serial` are root-only (0400) [V], so the anchor
   differs by privilege (§12).
3. Electron on Mac App Store: shell-outs to `ioreg`, `diskutil` and `sysctl` are unreliable inside the App Sandbox [I];
   prefer IOKit through a native call.
4. iOS supplies `identifierForVendor`, model and RAM only (README §5.3); no MAC, no board serial.
5. Node keyring is a native addon (`@napi-rs/keyring`) with a file fallback; SEA builds cannot load it from the VFS [V].
6. CLI self-replace (SEA binary) is plain fs plus the rename-away trick on Windows; servers redeploy instead.
7. iOS is store-managed; only a decision and a store link.
8. No App Store target for a Node CLI, a browser page or a Kotlin app.
9. Client API is reachable (PyObjC, N-API in ObjC++), but the downloader extension is an Xcode target that a PyInstaller or Electron
   packaging pipeline does not produce [I].
10. Play Asset Delivery exists only inside a Play-distributed Android app.
11. Steam has no iOS or Android client, and browsers cannot talk to it.
12. MSIX exists on Windows only; a Node CLI or browser is not packaged that way.
13. Apple, Android or web target: no MSIX or Flatpak.
14. WebCrypto Ed25519 is Chrome 137, Firefox 129, Safari 17 [V]; `@noble/ed25519` 3.2.0 is the fallback [V npm].
15. Inside the Tauri webview WebCrypto Ed25519 depends on the engine (WKWebView Safari 17+, WebView2, WebKitGTK unknown [I]);
    fall back to Rust `ed25519-dalek` 3.0.0 [V crates].
16. Android JCA `Signature` Ed25519 is API 33+ [V]; Tink 1.23.0 covers older levels [V].
17. JDK has EdDSA since JDK 15 (JEP 339) [M].
18. The .NET base library has no `Ed25519` type (the class page returns 404 on Microsoft Learn, while `MLDsa` exists) [V].
    Use BouncyCastle 2.7.0 or NSec 26.4.0 [V NuGet].
19. No stable hardware identifiers in a browser; a random id in IndexedDB. Strict tiers and keyless enrollment are impossible (README §5.3).
20. Android blocks serial and IMEI for normal apps (API 29+) and recommends a private GUID or Firebase installation id [V].
21. `SystemInfo.deviceUniqueIdentifier` is built in [M].
22. No browser keyring; a non-extractable `CryptoKey` protects key bytes but not use by script in the origin.
23. Unity has no updater; mobile is store-managed and standalone builds use Steam, itch or a custom launcher.
24. Whole-buffer `digest()` in WebCrypto; use `@noble/hashes` for streaming hashes of large payloads [V].
25. Chromium Background Fetch only; otherwise a foreground Worker with Wake Lock and OPFS [V].
26. Kotlin has no Apple runtime target in scope here.
27. Unity on Linux would need D-Bus through `Tmds.DBus`; treat Flatpak Unity builds as Steam-runtime style installs [I].

Reading the matrix:

- **Fully green rows:** update decision, device-code sign-in, atomic activation, and content `full` and `file`. These are
  the logic that lives in `client-core`-style shared code and needs no native support anywhere.
- **The ◐ block is small.** Ed25519 outside JS/Swift/JDK, QR, zstd, and a few keyring cases. None needs a build toolchain.
- **● is confined to a short list:** Node's keyring addon, Unity's keyring and iOS plugins, Apple Background Assets outside
  Swift, MarketplaceKit outside Swift, Steamworks in JS and JVM, WinRT from Node, Electron and JVM, Android background work
  from Tauri and Unity, and a WASM build for `delta` on the web.
- **✗ cells are real product decisions**, not gaps: web has no keyring or fingerprint, iOS has no self-update, Unity has no updater.

---

## 11. What this means for the shared SDK design [I]

1. **Specify capabilities, not calls.** Each SDK exposes `Capabilities { keyring, hardwareIds, outletApi, backgroundTransfer,
selfUpdate, transports[] }` so a product's `.pkey/` config and the server's outlet model can reason about a runtime
   without special cases. Web and iOS report their ✗ cells honestly.
2. **Put the stage machine in `client-core`.** The stages, events and outcomes are shared; SwiftUI, React, Compose, UI Toolkit,
   XAML, terminal and Godot scenes render them.
3. **Add a `deflate` chunk codec** before the first non-Godot SDK implements chunk patching (§3.3). It is a corpus-visible
   format decision, so it belongs in the same plan-mode change as the rest of the content wire format (the repo's rule
   for wire-touching changes: contract, catalog, corpus, then every SDK).
4. **Plan a Kotlin AAR and a Swift native-plugin package early.** They are the shared native backends for Godot, Unity and MAUI,
   so the work is done once (README §7.1).
5. **Prefer Depth B (verify, then stage) for any updater that does not sign its feed.** That is the only place Polaris'
   two-signer trust actually covers the bytes.

---

## 12. Observations about the current SDKs (worth fixing regardless of new runtimes)

1. **`wmic` on Windows 11.** The Node and Python fingerprints read `boardSerial` and `machineModel` by running
   `wmic baseboard get serialnumber` and `wmic computersystem get model` (`packages/sdk-node/src/devices/fingerprint.ts`
   lines 131 and 143; `sdks/python/src/polaris_key/devices/fingerprint.py` lines 194 and 196). Microsoft's KB5067470
   (change log entries 2026-08-19 and 2026-08-26) says WMIC "has now been removed from currently supported versions of
   Windows 11" and is no longer available as a Feature on Demand [V]. Both reads fail silently, so those two components are
   omitted and a Windows 11 device loses fingerprint precision. Of the four platform-specific components only
   `machineUuid` (registry `MachineGuid`) and `bootVolumeUuid` (`vol`) survive; `cpuModel`, `primaryMac` and `ramBucket`
   are unaffected. Swift is unaffected.
2. **Linux anchor differs by privilege.** Both SDKs read `/sys/class/dmi/id/product_uuid` first and fall back to
   `/etc/machine-id`. `product_uuid` and the `*_serial` files are readable only by root (0400) [S, kernel bug tracker and
   LKML threads]. The same machine therefore yields a different `machineUuid` when a CLI runs as root (or in a service)
   versus a normal user. Decide one anchor (for example `machine-id` always) and demote `product_uuid` to a separate
   optional component, using the existing drift tolerance to absorb the change [I].
3. **`defaultConfigDir()` is `~/.config` on every OS** in Node (`packages/sdk-node/src/core/context.ts` line 96), Python
   (`sdks/python/src/polaris_key/core/context.py` line 125) and Swift on macOS (`Store.swift`, deliberately, to share one directory
   across a developer's tools). On Windows that is `C:\Users\<user>\.config`; on macOS it is outside `~/Library`. Sharing
   the device id and token across Node, Python and Swift is a real feature, but large content packs need proper
   data, cache and state directories (§5.3) and must be excluded from backup where re-downloadable.
4. **Node keyring in a SEA binary.** `KeyringStore` dynamic-imports `@napi-rs/keyring` and silently falls back to a 0600 file on any
   failure (`core/store.ts` lines 139 to 210). Node's SEA docs say native addons cannot be loaded from the VFS [V], so a
   CLI shipped as a single executable stores the token in a file with no signal to the user. Also the optional dependency is pinned
   `^1.1.6` while npm latest is 2.1.0 [V]; check the 2.x changelog.
5. **Swift Keychain attribute on macOS.** `KeychainStore` sets `kSecAttrAccessible` but not `kSecUseDataProtectionKeychain`.
   Apple's doc says the accessibility attribute applies to macOS items only with that flag [V], so on macOS the attribute is
   ignored and the item lives in the legacy file-based keychain. The data-protection keychain needs entitlements that an unsigned CLI
   may lack [M], so this may be the right trade-off; record it as a decision.
6. **CONTENT §12 says Swift gets "delta (native zstd)".** Apple's Compression framework has no zstd [V], so this means a
   vendored libzstd, and the Swift package should say so.
7. **README §5.3 says no SDK sends secrets to the keyring.** Precisely: the device token goes to the keyring in Node
   (optional dependency), Python (`keyring` extra) and Swift (Keychain) [V repo]; managed config secrets and the offline
   cache are in the 0600 `managed.json` file. The docs claim and the code differ for secrets only.
8. **Swift package floor versus `AppDistributor`.** The package declares iOS 17.0 and macOS 14, while `AppDistributor` needs
   iOS 17.4 [V]; an outlet adapter needs `#available` guards and a fallback (`other`).

---

## 13. Spikes and open questions

1. **WebCrypto Ed25519 in the three Tauri webviews**, especially WebKitGTK; and the fallback cost of `ed25519-dalek` in Rust [I].
2. **`zstd --patch-from` decode through each binding** (Node `zlib` `dictionary`, Python 3.14 `ZstdDict(is_raw=True)`, `zstd-jni`,
   `ZstdSharp.Port`, libzstd via Swift, WASM) on a 100 MB prefix; measure memory and the window-log limit.
3. **Steam environment variables and ACF.** Confirm `SteamAppId`, `SteamGameId` and `appmanifest_<id>.acf` fields on Windows, macOS,
   Linux and Proton before relying on them for a pure-file detector.
4. **`AppTransaction.environment` for TestFlight on macOS** (community says `sandbox`, E1) and behaviour of `AppDistributor` on
   development-signed installs.
5. **Velopack local-feed staging** with a Polaris-verified artifact: does `UpdateManager` accept a directory that another
   process populated, and what does it re-verify (SHA1 only per E6)?
6. **Electron MAS sandbox shell-outs** (`ioreg`, `sysctl`, `diskutil`) and whether IOKit from a small addon is the right replacement.
7. **A Background Assets extension in non-Swift build systems**: Tauri iOS Xcode project patching, Unity post-build scripts, MAUI
   extension projects, Godot export (README §12).
8. **Windows SMBIOS board serial** through `GetSystemFirmwareTable("RSMB")` versus PowerShell CIM, as a `wmic` replacement.
9. **Node SEA plus native addon**: extract-to-temp for `@napi-rs/keyring`, or ship a small Windows/macOS-only credential helper.
10. **NetSparkle and Conveyor** as .NET and JVM updater drivers over the existing appcast renderer; Conveyor licensing for commercial adopters.
11. **`AppDistributor` `web` case on iOS** (alternative distribution from the web): entitlement and outlet mapping.
12. **Sparse-package MSIX identity** for unpackaged Electron, Python and .NET apps: which fields distinguish it from a packaged install.

---

## 14. Sources (retrieved 2026-09-30 unless noted)

**Apple** (documentation JSON at `developer.apple.com/tutorials/data/documentation/…`):
[marketplacekit/appdistributor](https://developer.apple.com/documentation/marketplacekit/appdistributor) and `/current`;
[storekit/apptransaction](https://developer.apple.com/documentation/storekit/apptransaction), `/environment`, `StoreType`;
[foundation/bundle/appstorereceipturl](https://developer.apple.com/documentation/foundation/bundle/appstorereceipturl) (deprecated iOS 18 / macOS 15);
[backgroundassets](https://developer.apple.com/documentation/backgroundassets), `AssetPackManager`, `BAAssetPackManager`,
`ManagedDownloaderExtension`, `StoreDownloaderExtension`;
[foundation/nsbundleresourcerequest](https://developer.apple.com/documentation/foundation/nsbundleresourcerequest) (deprecated 27.0);
[urlsessionconfiguration/background(withidentifier:)](<https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)>),
[downloading-files-in-the-background](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background),
`URLSessionDownloadTask.cancel(byProducingResumeData:)`;
[backgroundtasks/bgcontinuedprocessingtask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask);
[filemanager/replaceitem](<https://developer.apple.com/documentation/foundation/filemanager/replaceitemat(_:withitemat:backupitemname:options:)>);
[uikit/encrypting-your-app-s-files](https://developer.apple.com/documentation/uikit/encrypting-your-app-s-files), `FileProtectionType`;
`kSecUseDataProtectionKeychain`, `kSecAttrAccessible`; `URLResourceValues.isExcludedFromBackup`; `compression_algorithm`.
WebKit: [Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/).
Sparkle: [sparkle-project.org/documentation](https://sparkle-project.org/documentation/); release 2.10.0 via the GitHub release page (summary [S]).

**Android** (`developer.android.com`): reference for `InstallSourceInfo` and `PackageInstaller` (incl. `SessionParams`, `PACKAGE_SOURCE_*`),
[developer-verification](https://developer.android.com/developer-verification),
[background-tasks/uidt](https://developer.android.com/develop/background-work/background-tasks/uidt),
[services/fgs/timeout](https://developer.android.com/develop/background-work/services/fgs/timeout),
[data-transfer-options](https://developer.android.com/develop/background-work/background-tasks/data-transfer-options),
[jetpack/androidx/releases/work](https://developer.android.com/jetpack/androidx/releases/work),
[jetpack/androidx/releases/security](https://developer.android.com/jetpack/androidx/releases/security),
`AssetManager.openFd`, `java.security.Signature` algorithm table (Ed25519 API 33+),
[user-data-ids](https://developer.android.com/identity/user-data-ids),
[guide/playcore/asset-delivery](https://developer.android.com/guide/playcore/asset-delivery) and `/integrate-native`,
Keystore page. Maven metadata at `dl.google.com/android/maven2` (asset-delivery, work-runtime, datastore, security-crypto, app-update).

**Microsoft:** [detect-package-identity](https://learn.microsoft.com/en-us/windows/msix/detect-package-identity) (2025-06-10),
`Package.SignatureKind`, `PackageSignatureKind`, `Package.GetAppInstallerInfo`, `PackageCatalog`,
[optional-packages](https://learn.microsoft.com/en-us/windows/msix/package/optional-packages),
[desktop-to-uwp-behind-the-scenes](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes),
[grant identity to unpackaged apps (sparse)](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps),
[App Installer overview](https://learn.microsoft.com/en-us/windows/msix/app-installer/app-installer-file-overview),
`CREDENTIALA` (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), `ReplaceFileW`, `MoveFileExW`,
[`ProtectedData`](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata),
MAUI [SecureStorage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/secure-storage),
[WMIC removal, KB5067470](https://support.microsoft.com/en-US/servicing/os/windows/docs/2025/09/windows-management-instrumentation-command-line-wmic-removal-from-windows).

**Electron / Tauri / Velopack / Node / Python:** Electron [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [process](https://www.electronjs.org/docs/latest/api/process),
[asar](https://www.electronjs.org/docs/latest/tutorial/asar-archives), [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor),
[powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker);
Tauri [updater](https://v2.tauri.app/plugin/updater/), [resources](https://v2.tauri.app/develop/resources/), plugin index;
Velopack [docs](https://docs.velopack.io/) (`integrating/overview`, `getting-started/python`, `getting-started/javascript`);
Node [single-executable-applications](https://nodejs.org/api/single-executable-applications.html), [zlib](https://nodejs.org/api/zlib.html);
Python [`compression.zstd`](https://docs.python.org/3/library/compression.zstd.html), [`os.replace`](https://docs.python.org/3/library/os.html),
PyInstaller [runtime information](https://pyinstaller.org/en/stable/runtime-information.html) and operating mode,
[PEP 376 `INSTALLER` (recording installed packages)](https://packaging.python.org/en/latest/specifications/recording-installed-packages/).

**Web:** MDN `browser-compat-data` 8.1.3 (2026-09-24, unpkg); [Service worker lifecycle](https://web.dev/articles/service-worker-lifecycle);
WHATWG WebCrypto streaming-digest discussion (search summary [S]).

**Unity:** `Application.installerName`, `ApplicationInstallMode`, [StreamingAssets](https://docs.unity3d.com/6000.0/Documentation/Manual/StreamingAssets.html),
[Unity 6 releases](https://unity.com/releases/unity-6).

**Steam / Flatpak / Snap / AppImage:** Steamworks [ISteamApps](https://partner.steamgames.com/doc/api/ISteamApps) and
[steam_api](https://partner.steamgames.com/doc/api/steam_api); [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html),
[extensions](https://docs.flatpak.org/en/latest/extension.html); [AppImage environment variables](https://docs.appimage.org/packaging-guide/environment-variables.html);
Snap environment variables (search summary [S]); libflatpak and `ashpd` UpdateMonitor (search summary [S]).

**Registries** (queried 2026-09-30): npm (electron 44.5.0, electron-updater 6.8.9, velopack 1.2.161, @napi-rs/keyring 2.1.0, keytar 7.9.0,
@tauri-apps/plugin-updater 2.13.1, steamworks.js 0.4.0, steamworks-ffi-node 0.11.3, ink 7.1.1, koffi 3.3.2, @noble/hashes 2.4.0,
@noble/ed25519 3.2.0, hash-wasm 4.12.0, write-file-atomic 8.0.0, env-paths 4.0.0, workbox-window 7.4.1, vite-plugin-pwa 1.3.0,
QR libraries); PyPI (velopack 1.2.161, keyring 25.7.0, platformdirs 4.12.2, tufup 0.10.0, pyinstaller 6.22.3, briefcase 0.4.5, toga 0.5.6,
winrt-Windows.ApplicationModel 3.2.1, pyobjc-framework-BackgroundAssets 12.2.2, segno 1.6.6, textual 8.2.8, rich 15.0.0, dbus-fast 5.0.22);
NuGet (Velopack 1.2.161, Steamworks.NET 2024.8.0, Facepunch.Steamworks 2.3.3, QRCoder 1.8.0, NSec.Cryptography 26.4.0,
BouncyCastle.Cryptography 2.7.0, ZstdSharp.Port 0.8.8, Microsoft.Maui.Controls 10.0.110, NetSparkleUpdater 3.1.0,
Xamarin.Google.Android.Play.Asset.Delivery 2.3.0.8, Microsoft.WindowsAppSDK 2.5.1); Maven Central and Google Maven (zstd-jni 1.5.7-20,
oshi-core 7.7.0, ktor 3.6.0, okhttp 5.5.0, jna 5.19.1, tink-android 1.23.0, java-keyring 1.0.4, update4j 1.5.9, steamworks4j 1.10.0,
zxing core 3.5.4, qrose 1.3.0); crates.io (tauri 2.12.0, tauri-plugin-updater 2.13.1, keyring 4.2.0, steamworks 0.13.1, swift-rs 1.0.8,
objc2-background-assets 0.3.2, windows 0.62.2, reqwest 0.13.5, zstd 0.14.0, fastcdc 5.0.0, ed25519-dalek 3.0.0, tempfile 3.27.0).

**Sibling notes:** E1 (Apple), E2 (Android), E3 (Windows, Linux, web), E5 (frontier tech), E6 (client tools), E8 (content delivery),
README §3, §5, §7, §8, §12 and CONTENT §6, §9, §12.
