# P5-05 Apple plugin package: AppDistributor, AppTransaction, Background Assets, StoreKit 2, Keychain; Godot iOS binding

| Field       | Value                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                                           |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                       |
| Depends on  | [P3-10](P3-10-godot-updater.md), [S-01](S-01-apple-background-assets.md), [S-09](S-09-apple-storekit-distributor.md)                                                                                                                     |
| Unblocks    | [P5-08](P5-08-platform-pack-transports.md), [P6-01](P6-01-commerce-bridge.md), [P6-02](P6-02-trust-tiers.md), [SP-27](SP-27-godot-desktop-keyring.md)                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                       |
| Gates       | `ci:macos` with the Xcode 26 SDK (the Swift job runs `macos-15` today); `parity.json` for Godot (and Swift if it adopts the target)                                                                                                      |
| Human input | Apple developer account (Team ID, an App ID with the App Groups capability, sandbox in-app purchase products in App Store Connect, a Sandbox Apple Account); test devices on iOS 17.4+ and iOS 26.4+; TestFlight access for the test app |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                |

## Goal

One Swift package, reusable by the Swift SDK and later by Unity, MAUI and Tauri mobile, wraps the
Apple platform edges Polaris Key needs: `AppDistributor` (install source), `AppTransaction`,
Background Assets (`AssetPackManager`), StoreKit 2 purchases and entitlements, and Keychain storage,
behind a small C-callable surface. A Godot GDExtension packaged as an xcframework binds it for iOS,
and a GDScript facade with stubs lets every other platform, and an iOS build without the plugin,
get a typed "unsupported" result instead of a crash. The Background Assets extension target and App
Group that S-01 proved are added to the exported Xcode project by a repeatable step.

## Why

- iOS outlet detection needs `AppDistributor.current` (iOS 17.4+), which only native code can call;
  one IPA can be App Store, TestFlight, a marketplace or sideloaded (report
  [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet), notes/E1 §A2).
- Apple-hosted Background Assets is the App Store pack transport and needs `AssetPackManager` plus
  an extension target that Godot's export cannot add ([§4.1](../../README.md#41-ios-and-ipados),
  [§12](../../README.md#12-risks-and-open-questions)).
- Paid packs on iOS must use In-App Purchase (guideline 3.1.1); StoreKit 2 produces the signed
  transactions the commerce bridge verifies ([§3.10](../../README.md#310-commerce-and-entitlements)).
- PARITY builds the Apple edges once as a shared backend
  ([PARITY §1](../../PARITY.md#1-sdks-runtimes-and-shared-native-backends), §9 item 2); report
  [§5.10](../../README.md#510-native-plugins-optional-each-behind-a-gdscript-interface-with-stubs)
  requires each native plugin to sit behind a GDScript interface with stubs.

## Read first

- `AGENTS.md`; S-01's note and its `prototype/apple-ba/` patch script and shim (the extension-target
  patch, the `PolarisKeyApple` class and signals it prototyped, `url(for:)` paths, differential
  updates); P3-10's GDScript outlet-adapter and native-hook interfaces.
- notes/E1 §A2 (`AppDistributor`, `AppTransaction`), §E1–§E8 (Background Assets modes, plist keys,
  `AssetPackManager` API, consumption from Godot), §F2–§F3 (AppTransaction, StoreKit 2).
- notes/E4 §2.1–§2.2 and §3.2 (GDExtension xcframework vs `.gdip`, ABI coupling, the
  GodotApplePlugins stub pattern), notes/E9 §7.1.
- `sdks/swift/Package.swift` (targets, iOS 17 / macOS 14 floors, the Sparkle conditioning note) and
  `sdks/swift/Sources/PolarisKeyCore/Store.swift:196` (`KeychainStore`).
- [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here) (typed `Unsupported`) and
  [§5.6](../../PARITY.md#56-packs) (`packs.transport.apple`).

## Scope

**In:**

- A new SwiftPM library target, proposed name `PolarisKeyPlatform`, in `sdks/swift/`:
  - `distributor`: `AppDistributor.current` behind `#available(iOS 17.4, *)`, raced against a
    deadline (proposed 2 s; a timeout returns `unavailable`, which means no evidence, because the
    call never resolved in 100 s on the iOS 26.5 simulator:
    [notes/S-06](../../notes/S-06-outlet-signals.md) §1 and rule 5), with the `web` case matched
    only behind `#available(iOS 17.5, *)` (the case does not exist in 17.4). It returns the raw
    signal (`appStore`, `testFlight`, `marketplace:<bundleID>`, `web`, `other`, or `unavailable`),
    read at every launch and never cached;
  - `appTransaction`: environment, `originalAppVersion`, `appTransactionID` and the JWS
    representation for server verification. This is for commerce only: outlet detection does not
    call it (on macOS the `_MASReceipt` receipt, its `ProductionSandbox` marker and the signing
    leaf are enough, notes/S-06 §2);
  - `assetPacks` (iOS/macOS 26+): ensure (single and batch), status stream, `localVersion`,
    `checkForUpdates`, `remove`, and `url(for:)` resolved off the main thread and never persisted;
  - `store`: product lookup, purchase with an `appAccountToken`, `currentEntitlements`, the
    `Transaction.updates` listener, `finish`; results carry the signed transaction JWS;
  - `secureStore`: Keychain get/set/delete with the same attributes as `KeychainStore`.
- A C-callable surface (`@_cdecl`, JSON strings in and out, one callback registration for events),
  so every host binds the same functions.
- The Godot binding: sources in `sdks/godot/native/ios/`, a GDExtension against the stable C
  interface (godot-cpp or SwiftGodot; record the choice and why), built as
  `addons/polaris_key/native/ios/pkey_apple.xcframework` with its `.gdextension`. It registers class
  `PolarisKeyApple` with methods and the signals `pack_progress(id, bytes, total)`,
  `pack_ready(id, path)`, `pack_failed(id, err)`, `transaction_updated(jws)`.
- A GDScript facade `addons/polaris_key/native/pkey_apple.gd` (`PKeyApple`): on non-iOS, or when the
  class is absent, every call returns `Unsupported` with reason `runtime` or `dependency`.
- Export-plugin wiring: frameworks and plist keys through `add_apple_embedded_platform_*` (4.5+)
  with the `add_ios_*` fallback on 4.4; the Background Assets extension target, App Group and
  `BAAppGroupID`/`BAHasManagedAssetPacks`/`BAUsesAppleHosting` keys through the post-export Xcode
  patch from S-01; a per-preset switch that omits the extension for sideload IPAs.
- A CI job on a `macos-26` runner: build and test the target, build the xcframework for device and
  simulator, run the facade's stub tests headless.

**Out** (and where it belongs instead):

- App Attest (`DCAppAttestService`) calls (→ [P6-02](P6-02-trust-tiers.md), added to this package).
- Pack transport logic, marker verification, asset-pack packaging and upload (→ [P5-08](P5-08-platform-pack-transports.md)).
- Mapping raw distributor signals to an outlet (→ P3-11, `outlet-matrix.json`); the outlet adapters
  and update flow (→ [P3-10](P3-10-godot-updater.md)).
- Server-side transaction verification and entitlements (→ [P6-01](P6-01-commerce-bridge.md)).
- Sparkle and all macOS desktop updating (→ [P5-07](P5-07-desktop-plugins.md)). A macOS binding for
  Mac App Store Godot builds is not owned by any work package yet.

## Design notes

- **No `.gdip`.** Engine-header-linked iOS plugins break across Godot minors (notes/E4 §2.2); the
  GDExtension C interface is the ABI-stable route.
- **Floors.** The Swift package declares iOS 17.0 and macOS 14 (`Package.swift`), while
  `AppDistributor` needs 17.4 and the managed Background Assets part needs **26.4**: the class is
  26.0, but `getLocalStatusOfAssetPackWithIdentifier:`, `assetPackIsAvailableLocallyWithIdentifier:`
  and `ensureLocalAvailabilityOfAssetPack:requireLatestVersion:` are 26.4 (notes/S-01 §Environment,
  API availability). Guard with `#available(iOS 26.4, *)` and return `unavailable` below it, so
  26.0–26.3 devices take the `pkey-cdn` fallback; do not raise the package floor. On iOS 27 and
  later, get packs from `getManifestWithCompletionHandler:` (`#available(iOS 27, *)`) instead of
  the deprecated `getAllAssetPacks`/`getAssetPack(withID:)`. Compiling `AssetPackManager` needs the
  Xcode 26 SDK, which is why the CI job moves to `macos-26`.
- **Sideload builds ship no extensions.** Free Apple IDs get 3 apps and 10 App IDs a week and each
  extension uses one (report §4.1). The facade reports Background Assets as unsupported with
  reason `outlet` in such builds.
- **Background Assets rules.** Resolve `url(for:)` fresh on every launch and never persist it; the
  extension must not carry the device token or fingerprint (notes/E9 §7.1). Only Apple-hosted packs
  are supported: self-hosted managed packs would use the manifest `ba-package download-manifest`
  writes, but `pkey-cdn` already covers non-store outlets (notes/S-01).
- **S-01 recipe and lessons** ([notes/S-01](../../notes/S-01.md) §Recommendation). The patch is
  `prototype/apple-ba/patch/patch_ba.rb` (Ruby `xcodeproj` 1.27, in place and idempotent): target
  type `com.apple.product-type.extensionkit-extension`, id `<app id>.BackgroundDownload`, a
  `StoreDownloaderExtension`, `EXExtensionPointIdentifier =
com.apple.background-asset-downloader-extension`, versions copied from the app, App Group on both
  targets, embed into `$(EXTENSIONS_FOLDER_PATH)`. The extension's `IPHONEOS_DEPLOYMENT_TARGET` is
  the higher of the app's and 26.0, and the app keeps its own floor: copying an app floor below 26
  (Godot's default export writes 15.0) fails the build, because `StoreDownloaderExtension` and
  `AssetPack` are iOS 26 (measured, notes/S-01 §Results 1). Build the shim at the app's floor, not
  at 26.4, and guard every Background Assets call. In the binding: never touch `sharedManager` unless
  the `BA*` Info.plist keys are present (it traps); `url(for:)` returns a path for files that do not
  exist, so check existence; after `ensure` fails, re-check `getLocalStatus` and treat `downloaded`
  as ready (the simulator reports "Couldn't communicate with a helper application" after complete
  downloads); an update replaces the file at the same path while an open mount keeps the old
  bytes, so apply updates at the next launch; give the xcframework its own bundle id (an id equal
  to the app's blocks install).
- **Simulator.** The official 4.7.2 iOS template's simulator `libgodot.a` is x86_64 only. CI on
  Apple Silicon needs Rosetta or an arm64 simulator slice built from the same tag (`scons
platform=ios target=template_release arch=arm64 simulator=yes`, about 6 minutes), and the
  Compatibility renderer (the simulator template has no Metal or Vulkan).
- **StoreKit.** Set `appAccountToken` from the value P6-01 issues; `finish()` only after the server
  has recorded the transaction. TestFlight and sandbox report `originalAppVersion` as `1.0`
  (notes/E1 §F2); do not use it there.
- **Swift SDK reuse.** If P3-11 has already added `AppDistributor` to the Swift SDK, move that call
  into this target rather than keeping two.
- **What can be built before a human supplies anything:** the target with protocol seams and
  fakes, StoreKit Testing with a `.storekit` configuration where the test host allows it, the
  xcframework build, and the facade stubs. Device checks wait for the account and devices.

## Steps

1. Target skeleton with seams (`DistributorSource`, `AssetPackClient`, `StoreClient`) and fakes;
   unit tests.
2. C surface and its JSON shapes; tests through the C functions.
3. GDExtension, xcframework build script, `.gdextension`; the GDScript facade and stub tests.
4. Export-plugin wiring and the S-01 Xcode patch as a script CI can run.
5. The `macos-26` CI job; `parity.json` rows for the Godot SDK (`outlet.detect` signals,
   `core.store` on iOS, `packs.transport.apple` client, `commerce.receipt` client).
6. Device checklist (human): TestFlight build reports `testFlight`; an Apple-hosted test pack
   downloads and mounts; a sandbox purchase returns a verifiable JWS; Keychain survives relaunch.

## Acceptance criteria

- [ ] `swift test` covers each module against fakes, including `unavailable` below iOS 17.4 and,
      for Background Assets, below 26.4 (a 26.0–26.3 fake reports `unavailable`),
      `unavailable` when a fake `DistributorSource` never resolves within the deadline, and no
      `web` result below iOS 17.5.
- [ ] The xcframework builds for `ios-arm64` and the simulator in CI on `macos-26`.
- [ ] Headless Godot tests show every `PKeyApple` call returns `Unsupported` (reason `runtime`) on
      desktop and (reason `dependency`) when the class is missing.
- [ ] Exporting an iOS preset with the plugin produces an Xcode project containing the extension
      target, the App Group on both targets and the Background Assets plist keys; the sideload
      preset contains no extension.
- [ ] The device checklist is recorded in the PR by the person who ran it.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`), including `( cd sdks/swift && swift build && swift test )`.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
xcodebuild -scheme PolarisKeyPlatform -destination 'generic/platform=iOS' build
sdks/godot/native/ios/build.sh   # proposed name: builds the xcframework
GODOT_BIN=godot-4.7.2 sdks/godot/tools/run_tests.sh   # P1-01's runner; add suite_native_apple to the ci set
```

## Hand-off

- `PolarisKeyPlatform` and its C surface: the shared Apple backend for P5-08, P6-01 (StoreKit
  JWS, `appAccountToken`), P6-02 (App Attest is added here) and later Unity and MAUI.
- `PKeyApple` in GDScript with its signals; P5-08's `content/transports/apple_ba.gd` and P3-10's
  `distribution/outlets/app_store.gd` and `testflight.gd` call it.
- The Xcode patch script and the export-plugin switches for store and sideload IPAs.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-05 done`.

## Plan amendments (S-09)

The spike note [`notes/S-09-apple-storekit-distributor.md`](../../notes/S-09-apple-storekit-distributor.md) changes this package: its §Recommendation and §Proposed edits for this package override this brief where they differ.

## Corrections from implementation

Recorded by the implementer on 2026-10-03. The code is the fact where this brief and the code
disagree; S-09's §Recommendation was followed except where noted.

- **Target.** `PolarisKeyPlatform` in `sdks/swift` (tools 6.0, Swift 6 mode, iOS 17 / macOS 14),
  standalone (no dependency on other targets), with its own test target
  `PolarisKeyPlatformTests` (fakes only). Its JSON tree is `PlatformJSON`, not `JSONValue`, so a
  module importing PolarisKeyCore and PolarisKeyPlatform sees no clash. P3-11 had already added
  `AppDistributor.current` to `PolarisKeyUpdate`'s outlet reader; that reader now calls
  `PolarisKeyPlatform.SystemDistributor`, so the package holds one AppDistributor call (its
  `timeout` and error-reads-`other` behaviour is unchanged).
- **Gating as a value.** OS gates are a `PlatformAvailability` value (17.4, 17.5, 26.4, 27, 18.4),
  so `swift test` proves "unavailable below 17.4", "no `web` below 17.5" and "26.0–26.3 is
  unavailable" with fakes. The distributor's `unavailable` carries a `reason` (`version`,
  `runtime`, `timeout`, `error: …`); the Godot outlet env maps `timeout` to the corpus's
  `timeout` signal and every other `unavailable` to no signal.
- **Xcode 16.4.** The Background Assets client is behind `#if compiler(>=6.3)` (Xcode 26.4 ships
  Swift 6.3, confirmed), the iOS 27 manifest branch behind `#if compiler(>=6.4)`, and
  `currentEntitlements(for:)` behind `#if compiler(>=6.1)` plus `#available(iOS 18.4)`.
  `AppTransaction.storeType`/`.all`/`.revocationDate` are not used. Both CI routes are taken:
  the macos-15 job still compiles the whole package (and now builds PolarisKeyPlatform for iOS
  with warnings as errors), and a new `apple` job runs on `macos-26` (GA, Xcode 26.6). Locally
  verified: the package with the gated branches forced off type-checks for iOS and macOS, and
  the target plus its tests type-check on the Swift 6.0.3, 6.1.3 and 6.2.4 Linux images
  (`sdks/swift/tools/typecheck-platform-old-swift.sh`). Xcode 16.4 itself was not run here
  (owner checklist row 9).
- **GDExtension registration.** S-09's probe used `classdb_register_extension_class6`, which
  exists only from Godot 4.7, with `compatibility_minimum = "4.5"`: a 4.5 or 4.6 engine would
  have refused to initialise it. The glue tries `…6`, then `…5`, then `…4` (the 4/5 creation-info
  struct is one frozen layout), so `compatibility_minimum` is **4.4**. Only the 4.7 path was run
  (iOS simulator, Godot 4.7.2); 4.4–4.6 on iOS is unmeasured.
- **The `.gdextension` is not committed in the addon.** A desktop editor reports a
  `.gdextension` with no library for its own OS on every scan ("No GDExtension library found
  for current OS"), contrary to S-09's "logs nothing" (that was measured at run time, not at an
  editor scan). The source is `sdks/godot/native/ios/pkey_apple.gdextension`; `build.sh`
  installs it beside the xcframework in `addons/polaris_key/native/ios/`, which `.gitignore`
  keeps out of the repo. `sdks/godot/native/` carries a `.gdignore`.
- **Floors.** The xcframework is built at iOS 17.0 (the package floor) and `build.sh` refuses
  lower; the export plugin warns when a preset's `application/min_ios_version` is below 17.0
  (Godot's default is 15.0).
- **Export wiring.** One iOS-only preset option, `polaris_key/apple_background_assets`
  (`auto`/`on`/`off`, env `PKEY_APPLE_BACKGROUND_ASSETS`; `auto` = on for `app-store` and
  `testflight` only). It writes `PKeyAppleBackgroundAssets` and `PKeyAppleAppGroup` into the
  exported Info.plist through `add_apple_embedded_platform_plist_content` (4.5+) or
  `add_ios_plist_content` (4.4); `native/ios/patch_export.sh` reads the mark and runs S-01's
  `patch_ba.rb` byte for byte. No framework needs `add_*_framework`: the GDExtension export
  embeds the xcframework, and the dynamic framework carries its own system-framework links.
- **iOS export needs** an app icon and `textures/vram_compression/import_etc2_astc=true`; the
  checks' throwaway projects set both (an export without them fails with an empty
  "configuration errors" message).
- **Store.** The core.store work is `PKeyKeychainStore` (Godot), picked by default on iOS when
  the plugin is present: device id and token in the Keychain, the cache in the file store, the
  file store's token and device id migrated on first read, failures surfaced as
  `degraded: keyring-error` and never downgraded to a token file. `KeychainStore` (Swift) is
  unchanged and still uses `AfterFirstUnlock` for the token; flagged for the Swift SDK owner.
- **New client error code** `platform-error` (conformance/parity/errors.json; constants
  regenerated for every SDK) for a plugin error or an unreadable reply.
- **Parity.** Godot `core.store` moves from `planned P5-05` to `planned P5-06` (Android Keystore
  remains; no package owns a desktop keyring); notes on `outlet.detect`, `packs.transport.apple`
  (still P5-08) and `commerce.receipt` (still P6-01) in the Godot and Swift manifests. No
  feature became `implemented` and no N/A was added.
- **Tests.** Hosted XCTest project `sdks/swift/PlatformHostTests` (XcodeGen, host app with
  `get-task-allow`, `run.sh` erases a dedicated simulator first). Its warnings-as-errors is set
  on the app only: StoreKitTest's own headers use APIs deprecated in iOS 18, and the flag
  reaches the clang importer. A negative control without `get-task-allow` on an erased
  simulator fails on the product-count assertion, as intended. Godot: `suite_native_apple` in
  the `ci` set; `native/ios/export_check.sh` (store vs sideload, device builds) and
  `native/ios/sim_check.sh` (the binding in Godot 4.7.2 on the iOS 26.5 simulator; local only,
  it needs an arm64 simulator `libgodot.a`). The simulator run needs `audio/driver/driver=Dummy`:
  Godot's CoreAudio start aborts with an RPC timeout there.
- **Read-first correction.** The coordinator pointed at notes/S-06 §6, which is the itch section;
  the AppDistributor facts used here are S-06 §1 and its rule 5.

- **Review round 1.**
  - The C surface (`@_cdecl` `pkp_*`) is its own target, `PolarisKeyPlatformC`. Only native hosts
    link it: the Godot xcframework build compiles PolarisKeyPlatform as a static module and the
    C surface over it. `PolarisKeyUpdate` and other Swift consumers export no `pkp_*` symbol
    (checked with `nm`).
  - `listen`, `packs_watch` and `packs_unwatch` are asynchronous ops now. No op blocks the
    calling (Godot main) thread; S-09's probe and the first cut waited up to 2 s on a semaphore.
  - The PolarisKey autoload's launch work starts the `Transaction.updates` listener when
    `capabilities().storeKit` is true (S-09 Recommendation 4), before the distributor read.
  - PKeyApple's awaited results are shared across instances, keyed by native object and req.
    A result that arrives after its caller timed out is dropped. `shared()` documents that a
    game uses one instance.
  - `PKeyKeychainStore` surfaces and retries a failed token-file delete after migration, and
    `has_device_id()` surfaces a Keychain failure.
  - The glue NULL-checks its `malloc`.
  - THREAT-MODEL.md has a client token-store section.
  - The `apple` CI job pins `/Applications/Xcode_26.6.app` (macos-26 ships 26.0.1 to 26.6,
    26.6 the default) and fails unless `swift --version` is 6.3 or later, so the
    `#if compiler(>=6.3)` code cannot be compiled out silently.
  - XcodeGen 2.45.4 is downloaded and checked against its SHA-256.

### Owner checklist (device, account, TestFlight; not run)

Needs the Apple developer account (Team ID, an App ID with App Groups plus the extension's App
ID, sandbox IAP products, a Sandbox Apple Account), an iOS 26.4+ device, an iOS 17.4–25.x device
and TestFlight access. Build a store preset with `native/ios/build.sh`, export, `patch_export.sh`,
then archive and sign with both provisioning profiles.

| #   | Run                                                                      | Record                                                                                                | Default until then                     |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | TestFlight install; `PKeyApple.shared().distributor()`                   | signal and ms; `provisioned`                                                                          | `testFlight`; `unavailable` on timeout |
| 2   | Development-signed install from Xcode                                    | signal; `provisioned: true`                                                                           | no evidence                            |
| 3   | Sandbox purchase with an `appAccountToken`                               | JWS `x5c` length 3 chaining to Apple Root CA G3, `environment: Sandbox`; the sheet over Godot's scene | as Apple documents                     |
| 4   | `app_transaction()` on the same install                                  | environment, `originalAppVersion` (`1.0` expected), sign-in prompt                                    | commerce only                          |
| 5   | Refund the sandbox purchase                                              | one `transaction_updated` with `revoked: true`, latency                                               | server notifications are authoritative |
| 6   | Keychain: set, delete the app, reinstall, get (26.4+ and older iOS)      | which items survive                                                                                   | assume they may not                    |
| 7   | Keychain after a restart, before first unlock, from a background launch  | `AfterFirstUnlockThisDeviceOnly` readable?                                                            | as documented                          |
| 8   | TestFlight processing of the patched build with `pkey_apple.framework`   | result                                                                                                | assume it passes (S-01)                |
| 9   | One CI run of the macos-15 job (Xcode 16.4) and the macos-26 `apple` job | compile errors in guarded code, hosted tests                                                          | the guards above                       |
| 10  | An Apple-hosted test pack: `ensure_packs` then mount the path            | `pack_ready` path readable on device                                                                  | `pkey-cdn` fallback                    |
| 11  | The binding on a Godot 4.5 or 4.6 iOS build                              | `PolarisKeyApple` registers (the `…5` path)                                                           | unmeasured                             |
