# P5-05 Apple plugin package: AppDistributor, AppTransaction, Background Assets, StoreKit 2, Keychain; Godot iOS binding

| Field       | Value                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                                        |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                    |
| Depends on  | [P3-10](P3-10-godot-updater.md), [S-01](S-01-apple-background-assets.md)                                                                                                                                                              |
| Unblocks    | [P5-08](P5-08-platform-pack-transports.md), [P6-01](P6-01-commerce-bridge.md), [P6-02](P6-02-trust-tiers.md)                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                                                                    |
| Gates       | `ci:macos` with the Xcode 26 SDK (the Swift job runs `macos-15` today); `parity.json` for Godot (and Swift if it adopts the target)                                                                                                   |
| Human input | Apple developer account (Team ID, an App ID with the App Groups capability, sandbox in-app purchase products in App Store Connect, a Sandbox Apple Account); test devices on iOS 17.4+ and iOS 26; TestFlight access for the test app |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                             |

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
  - `distributor`: `AppDistributor.current` behind `#available(iOS 17.4, *)`, returning the raw
    signal (`appStore`, `testFlight`, `marketplace:<bundleID>`, `web`, `other`, or `unavailable`),
    read at every launch;
  - `appTransaction`: environment, `originalAppVersion`, `appTransactionID` and the JWS
    representation for server verification;
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
  `AppDistributor` needs 17.4 and managed Background Assets needs 26.0. Guard with `#available` and
  return `unavailable`; do not raise the package floor. Compiling `AssetPackManager` needs the
  Xcode 26 SDK, which is why the CI job moves to `macos-26`.
- **Sideload builds ship no extensions.** Free Apple IDs get 3 apps and 10 App IDs a week and each
  extension uses one (report §4.1). The facade reports Background Assets as unsupported with
  reason `outlet` in such builds.
- **Background Assets rules.** Resolve `url(for:)` fresh on every launch and never persist it; the
  extension must not carry the device token or fingerprint (notes/E9 §7.1); the self-hosted managed
  protocol is undocumented, so only Apple-hosted packs are supported.
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

- [ ] `swift test` covers each module against fakes, including `unavailable` below iOS 17.4 and
      below 26.0.
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
