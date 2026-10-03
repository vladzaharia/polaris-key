> Research note for [Godot on Polaris Key](../README.md), 2026-10-03. Spike S-09 of the
> [execution program](../program/wp/S-09-apple-storekit-distributor.md). It unblocks
> [P5-05](../program/wp/P5-05-apple-plugin-package.md). It was run on one Mac with no Apple
> developer account, no device and no App Store Connect entry; no account resource or certificate
> was used or created. Every claim carries an evidence class (below). The probe code is in
> [`S-09-apple-storekit-distributor/`](S-09-apple-storekit-distributor/README.md). It builds on
> [S-01](S-01.md) (Background Assets, the Xcode patch, the C-interface shim) and
> [S-06](S-06-outlet-signals.md) §1 and short answer 6 (`AppDistributor.current` on the simulator).
> Team ids and device identifiers are removed from every quoted observation.

# S-09: StoreKit 2, AppTransaction, AppDistributor, Keychain and the Godot iOS binding

Evidence classes:

- **[M]**: measured on this Mac with real tools (builds, compilers, file and binary inspection).
- **[E]**: emulated. Run in the iOS 26.5 simulator, and for StoreKit against StoreKit Testing in
  Xcode (environment `Xcode`), not the App Store or its sandbox.
- **[D]**: documented. Read raw from a primary source: the iOS 27 SDK interfaces and headers, or
  Apple's documentation JSON.
- **[U]**: unmeasured, because it needs a device, the owner's Apple account or Xcode 16.4.

**[I]** marks an inference drawn from the above.

## Question

The brief asks five things:

1. What can a Swift package verify locally with StoreKit 2 and a `.storekit` file
   (`currentEntitlements`, purchase, refund, `AppTransaction.shared`)? What do the JWS payloads
   look like?
2. Which APIs reveal the install source on iOS 26? Which of them return on the simulator? What
   fallback order should P5-05 use?
3. How should a Godot GDExtension store the device id and the licence token in the Keychain
   (accessibility class, access group), and what happens across a reinstall?
4. What shape should the Godot iOS binding take: async Swift exposed to GDScript, main-actor
   isolation under Swift 6 and Xcode 16.4 as CI uses, and composition with S-01's Background Assets
   patch?
5. What must still be measured on a device?

## Short answer

| #   | Question             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Class          |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1a  | StoreKit 2 locally   | **Yes, but only in an XCTest bundle hosted by an app that carries `get-task-allow`.** Products, purchase with `appAccountToken`, `Transaction.updates`, `finish()`, refund (`SKTestSession.refundTransaction`), `currentEntitlements` and `AppTransaction.shared` all work [E]. Under `swift test` on macOS, and under `xcodebuild test` of the bare SwiftPM test target on the simulator, the session silently loads **zero products**, and AppTransaction fails (`noAccount` on macOS, `unknown` on iOS) [M]. A host app without `get-task-allow` gets the same empty result: `storekitd` logs "is not installed for development" [M] | emulated       |
| 1b  | JWS shape            | Compact JWS, `alg ES256`, `kid Apple_Xcode_Key`, **one** self-signed P-256 certificate in `x5c` ("StoreKit Testing in Xcode", valid for one year from the session). The signature verifies against that certificate (`openssl dgst -verify`: OK) [M]. It chains neither to Apple Root CA G3 nor to Xcode's `StoreKitTestCertificate.cer` (RSA) [M]. Payload field names match App Store Server API names (`transactionId`, `appAccountToken`, `environment: "Xcode"`, `revocationType`, …) [E]. P6-01 must reject `environment == "Xcode"` and any chain that does not end at Apple's root                                              | measured       |
| 1c  | Entitlement timing   | Right after `purchase()` returns `.success`, `currentEntitlements`, `Transaction.all`, `unfinished` and `latest(for:)` stay empty for **about 1 s**: still empty at 0.55 s, first seen at 0.88–1.13 s (three runs) [E]. After a refund, the revoked transaction reaches `Transaction.updates` in 0.58 s [E]. `Transaction.updates` also re-delivers the purchase that `purchase()` already returned [E]                                                                                                                                                                                                                                 | emulated       |
| 2   | Install source       | `AppDistributor.current` **never resolves on the simulator** within 2 s, 5 s or 10 s, in a Godot app or an XCTest host (S-06 saw no answer in 30 s and 100 s) [E]. The new `AppDistributor.eligibilityRegion` (iOS 26.4) also never resolves [E]. Recommended fallback order, raw signals only: distributor with a 2 s deadline, then static bundle evidence (`embedded.mobileprovision`, AltStore's bundle-id suffix and `ALTBundleIdentifier`), then `unavailable`. Never AppTransaction (§Results 2)                                                                                                                                 | emulated + doc |
| 3   | Keychain             | Works from the GDExtension in the Godot process [E]. Items in every accessibility class tested **survive uninstall and reinstall on the simulator**; a `user://` file does not [E]. The default access group is the app's own `<prefix>.<bundle id>` [E]. An explicit group outside the entitlements fails with `-34018` [E]. The App Group from S-01's patch works as an access group once the entitlement is present [E]. Persistence across reinstall on a device is undocumented [U, I]                                                                                                                                             | emulated       |
| 4   | Binding shape        | **Works end to end in Godot 4.7.2 on the simulator.** The Swift package is compiled with the C-interface glue into one 265 KB dynamic framework per slice at iOS 17.0 (Swift 6 mode, clean) [M]. GDScript calls `cmd(json)` on the main thread (`Thread.isMainThread == true`) [E]. Async results come back through a native queue that a GDScript facade drains each frame (1.8 µs per empty poll) and turns into signals [E]. Purchase found a foreground `UIWindowScene` and used `purchase(confirmIn:)` [E]. The S-01 patch on top builds for device and simulator [M]                                                              | measured + emu |
| 4b  | Swift 6 / Xcode 16.4 | The concurrency patterns compile the same way under Swift 6.0.3, 6.1.3, 6.2.4 and 6.4 in Swift 6 mode [M]. The real Xcode 16.4 risk is **SDK symbols**: `AssetPackManager` and the managed Background Assets API (Xcode 26 SDK), `eligibilityRegion` and the 26.4 Background Assets methods (Xcode 26.4 SDK), and `AppTransaction.storeType`/`revocationDate`/`all` (Xcode 27 SDK) all compile here and fail to compile on Xcode 16.4. `#if canImport(BackgroundAssets)` does not separate them [D, I]. Xcode 16.4 itself was not run [U]                                                                                               | measured + doc |
| 5   | Device list          | §Hand-off: TestFlight `testFlight`, the sandbox JWS chain to Apple's root, Keychain across reinstall, `purchase(confirmIn:)` with a real sheet, and the patched build's TestFlight processing (S-01)                                                                                                                                                                                                                                                                                                                                                                                                                                    | unmeasured     |

**Go/no-go for P5-05: GO.** Every part a Mac can exercise works through the proposed shape. The
changes to the brief are listed in §Proposed edits. Three of them matter most:

- the signals move to the GDScript facade;
- StoreKit tests need a hosted XCTest project, not `swift test`;
- SDK-gated code must compile on Xcode 16.4, or the target must leave the macos-15 job.

## Environment

| Item                  | Value                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware              | Apple M5 Pro Mac; no iOS device attached                                                                                                                                                                                                  |
| OS                    | macOS 27.0 (26A428)                                                                                                                                                                                                                       |
| Xcode                 | 27.0 (27A266a), iOS SDK 27.0, Swift 6.4 (swiftlang-6.4.0.34.1). **Xcode 16.4 (CI's Swift 6.1.2) is not installed and was not run**                                                                                                        |
| Simulator             | iPhone 17 Pro, iOS 26.5 runtime (23F77); arm64; no Rosetta                                                                                                                                                                                |
| Godot                 | 4.7.2-stable official (`ed1daf0bf`) editor and iOS export template. The arm64 simulator `libgodot.a` was rebuilt from tag `4.7.2-stable` (same commit; `scons platform=ios target=template_release arch=arm64 simulator=yes`, 2 min 19 s) |
| Older Swift compilers | Docker 29.4.0 (OrbStack, arm64): `swift:6.0` (6.0.3), `swift:6.1` (6.1.3), `swift:6.2` (6.2.4) Linux images, type-check only                                                                                                              |
| Tools                 | XcodeGen 2.45.4; system Ruby 2.6.10 with `xcodeproj` 1.27.0 (S-01's patch); OpenSSL 3.6.4; Python 3.14.6                                                                                                                                  |
| Signing               | Simulator builds are ad hoc (`CODE_SIGN_IDENTITY=-`); device builds are unsigned (`CODE_SIGNING_ALLOWED=NO`). Xcode injects a simulated `application-identifier` with a team prefix into simulator builds; it is redacted here            |
| Deployment targets    | Package iOS 17.0 / macOS 14 (as `sdks/swift`). Framework and Godot app iOS 17.0. The patched extension is iOS 26.0 (S-01 rule)                                                                                                            |
| Network / region      | Loopback only; storefront `USA` from the `.storekit` file; no App Store or sandbox traffic                                                                                                                                                |

### API availability (iOS SDK 27.0 interfaces) [D]

Read raw from `MarketplaceKit.swiftinterface` and `StoreKit.swiftinterface` (`arm64e-apple-ios`).

| API                                                                                                           | Introduced                                             | P5-05 use                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AppDistributor.current` (`get async throws`), cases `appStore`, `testFlight`, `marketplace(String)`, `other` | iOS 17.4                                               | yes, with a deadline                                                                      |
| `AppDistributor.web`                                                                                          | iOS 17.5                                               | matched behind `if #available(iOS 17.5, *), case .web = d` (compiles at a 17.0 floor) [M] |
| `AppDistributor.eligibilityRegion` (`get async`, `String?`)                                                   | **iOS 26.4**                                           | no: marketplace transaction reporting only [D]; never resolves on the simulator [E]       |
| `AppTransaction.appTransactionID`, `originalPlatform`                                                         | iOS 16, back-deployed before 18.4                      | yes                                                                                       |
| `AppTransaction.storeType` (`consumer`/`education`/`enterprise`), `AppTransaction.all`, `revocationDate`      | **iOS 27 SDK** (`storeType` back-deployed as a string) | avoid: not in the Xcode 16.4 SDK; read the JWS server-side instead                        |
| `Product.purchase(options:)`                                                                                  | iOS 15, **`@MainActor`**                               | fallback                                                                                  |
| `Product.purchase(confirmIn: some UIScene, options:)`                                                         | iOS 17, **`@MainActor`**                               | yes                                                                                       |
| `Product.purchase(confirmIn: UIViewController, options:)`                                                     | iOS 18.2, not annotated `@MainActor`                   | no (above the floor)                                                                      |
| `Transaction.currentEntitlements(for:)`                                                                       | **iOS 18.4**                                           | no: a 17.0 floor needs `#available` (compile error measured) [M]                          |
| `Transaction.commitmentInfo`                                                                                  | iOS 26.4                                               | no                                                                                        |
| `Synchronization.Mutex`                                                                                       | iOS 18                                                 | no: use `OSAllocatedUnfairLock` (iOS 16)                                                  |

## Method

All code and commands are in the probe directory's [README](S-09-apple-storekit-distributor/README.md).

1. **Package** (`pkplat/`): tools 6.0, `swiftLanguageMode(.v6)`, iOS 17 / macOS 14. It has five
   modules shaped like P5-05's: a distributor raced against a deadline (S-06's two-detached-task
   race, made Swift 6 clean), AppTransaction, a `StoreService` actor plus a `@MainActor`
   `purchase`, `SecureStore` (generic-password items under service `pkey:<product>`, as
   `KeychainStore`), and a C surface: `char *pkp_call(const char *json)`, `pkp_free`,
   `pkp_set_event_callback(void (*)(const char *))`. Events carry only a Sendable `JSONValue`
   tree. The tests (`StoreKitProbeTests`) drive `SKTestSession` with a two-product `.storekit`
   file (non-consumable `…pack.foes`, consumable `…gems100`). Each observation prints one
   `S09 <label> <json>` line.
2. **StoreKit runners.** The same tests ran three ways: `swift test` on macOS; `xcodebuild test`
   of the SwiftPM scheme on the simulator (no host app); and an XcodeGen app with a hosted
   unit-test bundle (`skhost/`), first without and then with a `get-task-allow` entitlement. The
   failing runs were diagnosed from the simulator's unified log (`storekitd`). Three `.storekit`
   variants (no settings block, settings without ids, format version 3) ruled out the file format.
3. **JWS.** The purchase JWS was decoded. Its `x5c` leaf was checked with
   `openssl x509 -text`, and the ES256 signature verified with `openssl dgst -sha256 -verify` over
   the signing input. `openssl verify` was tried against Xcode's
   `IDEStoreKitEditor.ideplugin/…/StoreKitTestCertificate.cer`.
4. **Godot binding** (`gdx/`):
   - `pkap.m` is S-01's C-interface glue with class `PolarisKeyApple`. Its static `cmd(json)`
     forwards to `pkp_call`, and `{"op":"poll"}` drains a locked queue that the Swift callback
     fills from any thread.
   - `build.sh` compiles the glue with clang, then links it and the package sources with `swiftc
-swift-version 6 -emit-library` into `pkap.framework` per slice, and wraps both slices in an
     xcframework at iOS 17.0.
   - The facade `PKeyApple` (`pkey_apple.gd`) polls in `_process`, resolves awaited requests by
     id, and emits `transaction_updated` (and the `pack_*` signals) in GDScript.
   - The project was exported with "Export Project Only", the arm64 simulator slice merged with
     `lipo` (S-01 lesson), and `get-task-allow` added to the exported entitlements. It was built
     with `xcodebuild` and run with `simctl launch`.
   - The app's stdout did not reach `--console-pty`, so the probe also appends JSON lines to
     `user://pkap_log.jsonl`, and the harness reads that file from the app container.
5. **StoreKit inside Godot.** Probe only: the simulator slice links `StoreKitTest`, and `{"op":
"sk_session","path":…}` starts an `SKTestSession` on a copy of the `.storekit` file. The first
   attempt aborted (§Results 1). Inserting XCTest through `SIMCTL_CHILD_DYLD_*` made it work.
6. **Keychain.** Plan `kc_write` writes three items with different accessibility classes, tries two
   explicit access groups and writes a `user://` file. Plan `kc_read` reads them back. The
   sequence was: install, write, relaunch and read, uninstall, reinstall, read. It was repeated in
   the S-01-patched build, which has an App Group entitlement.
7. **Composition.** S-01's `patch_ba.rb` was run unchanged on a copy of the export (App Group
   `group.dev.polariskey.research.pkap`). The copy was built for the simulator and the device, and
   the keychain plan was run in it.
8. **Swift 6 across compilers.** `swift6/Core.swift` holds the package's concurrency patterns
   without Apple frameworks: the C-callback sink, the deadline race, the actor, the `@MainActor`
   hop, `@_cdecl`. It also holds three tempting shortcuts behind `-D SHORTCUTS`. Each file was
   type-checked with `-swift-version 6` on Swift 6.0.3, 6.1.3, 6.2.4 (Docker) and 6.4 (local).

## Results

### 1. StoreKit 2 and AppTransaction [emulated; runner findings measured]

**Where StoreKit Testing works:**

| Runner                                                               | Products        | AppTransaction                                       | Keychain | Verdict         |
| -------------------------------------------------------------------- | --------------- | ---------------------------------------------------- | -------- | --------------- |
| `swift test`, macOS                                                  | `[]` (no error) | `systemError(StoreKitInternalError.noAccount)`, 4 ms | `-34018` | unusable [M]    |
| `xcodebuild test`, SwiftPM scheme, simulator (no host)               | `[]`            | `unknown`, 30 ms; `refresh()` > 10 s                 | `-34018` | unusable [M]    |
| hosted XCTest, ad hoc, no `get-task-allow`                           | `[]`            | `unknown`, 17 ms                                     | works    | unusable [M]    |
| hosted XCTest, ad hoc, **`get-task-allow`**                          | 2               | verified, `Xcode`, 19 ms                             | works    | **works** [E]   |
| Godot app + in-process `SKTestSession` (probe hook, XCTest inserted) | 2               | verified, `Xcode`, 6–13 ms                           | works    | works [E]       |
| Godot app, fresh bundle id, never a session                          | `[]`            | `unknown`, 5–11 ms (twice)                           | works    | no StoreKit [E] |

- In every failing runner, `SKTestSession(contentsOf:)` **succeeds** and only the log tells why:
  `[SKTestSession] Error saving configuration file: SKInternalErrorDomain Code=3`. `storekitd`
  says `dev.polariskey.research.skhost is not installed for development` [M]. Adding
  `get-task-allow = true` to the host app's entitlements fixed it; all three `.storekit` variants
  then loaded [M]. A test that does not assert the product count passes while testing nothing.
- `SKTestSession` in a process without XCTest **aborts** in `-[SKTestSession bundleID]` →
  `__getXCTestConfigurationClass_block_invoke` → `XCTestLibrary` → `abort` (crash report) [M].
  `StoreKitTest` loads from the simulator runtime's `/Developer/Library/Frameworks`. It works in an
  app only when XCTest is inserted with `DYLD_INSERT_LIBRARIES`. That is a probe technique, never
  a product path [I].
- The StoreKit Testing configuration **persists per bundle id** in the simulator's `storekitd`
  after a session. A later plain launch of the same app got an `Xcode` AppTransaction without
  starting a session [E]. CI must erase the simulator or use a fresh bundle id when it needs the
  "no StoreKit" path.

**Transactions** (hosted XCTest and the Godot app agree) [E]:

| Step                                                                      | Observed                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Product.products(for:)` with one unknown id                              | the 2 known products, no error for the unknown one                                                                                         |
| `purchase` non-consumable with `appAccountToken`                          | `.success`, verified, 1,107 ms (XCTest, first) and 173–188 ms (Godot); `confirmIn` = scene in Godot                                        |
| `currentEntitlements` / `all` / `unfinished` / `latest(for:)` right after | empty at 14 ms and 545 ms, present at 1,093 ms (XCTest); first seen at 875 ms and 1,134 ms (Godot, two runs)                               |
| `finish()` on the kept transaction                                        | `true`; `unfinished` then empty                                                                                                            |
| `refundTransaction(identifier:)`                                          | `Transaction.updates` first re-delivers the purchase (not revoked), then the revoked copy at 579 ms; `currentEntitlements` empty at 617 ms |
| Consumable through the C surface                                          | `pkp_call` returns `{"ok":true,"req":2}`; the `purchase` event arrives on a background thread with the transaction and its JWS             |

**AppTransaction** under StoreKit Testing [E]: `environment "Xcode"`, `appTransactionID "0"`,
`originalAppVersion` = the app's `CFBundleVersion` (`"14"`, and `"1"` in the Godot export; not
`"1.0"` as in the sandbox [D]), `originalPurchaseDate` 0, verified, JWS 1,546 bytes. Payload keys:
`appTransactionId, applicationVersion, bundleId, deviceVerification, deviceVerificationNonce,
originalApplicationVersion, originalPlatform ("iOS"), originalPurchaseDate, receiptCreationDate,
receiptType ("Xcode"), requestDate`. There is no `appAppleId` [E].

**Transaction JWS** (non-consumable purchase, 1,878 bytes; the revoked copy is 2,029 bytes) [E]:

```json
{"alg":"ES256","kid":"Apple_Xcode_Key","typ":"JWT","x5c":["<1 certificate>"]}
{"appAccountToken":"6f2c3b1a-0000-4000-8000-00000000c0de","appTransactionId":"0","bundleId":"dev.polariskey.research.skhost",
 "currency":"USD","deviceVerification":"…","deviceVerificationNonce":"…","environment":"Xcode","inAppOwnershipType":"PURCHASED",
 "originalPurchaseDate":1791009838364,"originalTransactionId":"0","price":4990,"productId":"dev.polariskey.research.pack.foes",
 "purchaseDate":1791009838364,"quantity":1,"signedDate":1791009838365,"storefront":"USA","storefrontId":"143441",
 "transactionId":"0","transactionReason":"PURCHASE","type":"Non-Consumable"}
```

The revoked copy adds `revocationDate`, `revocationReason: 0`, `revocationType: "REFUND_FULL"` and
`revocationPercentage: 100000`. Note that the token comes back **lower-case** in the JWS but
upper-case from `Transaction.appAccountToken.uuidString` [E]. P6-01 must compare UUIDs, not
strings.

**What a package can verify locally** [M, I]: StoreKit's own `VerificationResult` (`.verified`)
and the JWS signature against its `x5c` leaf. The leaf is `CN=StoreKit Testing in Xcode`,
self-signed, `CA:TRUE, pathlen:0`, P-256, valid one year from the session. The same leaf signed
the AppTransaction, the purchase and the refund in one session (SHA-256 prefix `a719867a…` for
all three) [M]. `openssl verify` against Xcode's `StoreKitTestCertificate.cer` fails ("self-signed
certificate"), because that certificate is an unrelated RSA root [M]. So Xcode-environment JWS are
fit for testing P6-01's parsing and field mapping, but not its chain validation. Production and
sandbox JWS carry Apple's three-certificate chain [D, notes/E1 §F1], measured on a device only
[U].

### 2. Install source on iOS 26 [emulated + documented]

| API                                       | Simulator result                                                                                                                              | Evidence |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `AppDistributor.current`                  | no answer: `timeout after 2.0s` (2,002 ms), `timeout after 10.0s` (10,507–10,514 ms) in Godot; 5,039–5,081 ms in XCTest. S-06: 30 s and 100 s | [E]      |
| `AppDistributor.eligibilityRegion` (26.4) | no answer in 2 s (Godot) or 5 s (XCTest)                                                                                                      | [E]      |
| `AppTransaction.shared`                   | throws `unknown` in 5–11 ms with no StoreKit configuration; `Xcode` with one. Never `production`/`sandbox` here                               | [E]      |
| `Bundle.appStoreReceiptURL`               | non-nil URL, file absent (S-06)                                                                                                               | [E]      |
| `embedded.mobileprovision`                | absent in simulator builds (S-06)                                                                                                             | [E]      |
| AltStore/SideStore bundle-id rewrite      | `<id>.<TEAMID>` and `ALTBundleIdentifier` (AltStore source, S-06)                                                                             | [D]      |

Apple's `AppDistributor` page says to "check the current source at each launch — not just at the
first launch", and that `eligibilityRegion` serves marketplace apps' transaction reporting [D].
`AppTransaction.shared` "throws an error if the AppTransaction isn't available or if the user
isn't authenticated with the App Store" and "may require network connectivity" [D]. That is why it
stays out of outlet detection (P5-05's rule stands).

**Fallback order for P5-05** (it returns raw signals; P3-11 maps them):

1. `AppDistributor.current` under `#available(iOS 17.4, *)`, raced against a **2 s** deadline,
   every launch, never cached. Below 17.4, or on timeout or error, return `unavailable`, which
   means no evidence (S-06 rule 5).
2. Static bundle evidence, read in the same call and always returned:
   - `provisioned`: `embedded.mobileprovision` is present (development, ad hoc, AltStore,
     SideStore; never App Store or TestFlight [D, S-06]);
   - `altBundleIdentifier`;
   - the running `bundleIdentifier`.
     These can veto a store outlet. They never select one.
3. Otherwise `unavailable`, and the build stamp stands.

Proposed result shape of the `distributor` op:
`{"signal":"appStore|testFlight|marketplace:<id>|web|other|unavailable","reason":…,"ms":…,
"provisioned":bool,"altBundleIdentifier":…}`.

### 3. Keychain from the GDExtension [emulated]

| Item (service `pkey:probe`)      | Class written                        | Read back (`kSecAttrAccessible`) | After relaunch | After uninstall + reinstall |
| -------------------------------- | ------------------------------------ | -------------------------------- | -------------- | --------------------------- |
| `device`                         | `AfterFirstUnlockThisDeviceOnly`     | `cku`                            | present        | **present**                 |
| `token`                          | `AfterFirstUnlock` (KeychainStore's) | `ck`                             | present        | **present**                 |
| `wu`                             | `WhenUnlockedThisDeviceOnly`         | `aku`                            | present        | **present**                 |
| `user://device_id.txt` (control) | file                                 | —                                | present        | **gone**                    |

- `kSecUseDataProtectionKeychain` items, `synchronizable 0`, each call about 1 ms [E].
- Default access group: `<prefix>.dev.polariskey.research.pkap`, from the application identifier
  Xcode simulates [E].
- Explicit `kSecAttrAccessGroup`:
  - `group.dev.polariskey.research.pkap` without the App Group entitlement: `-34018`
    (`errSecMissingEntitlement`) [E];
  - the same group in the S-01-patched build (App Group entitled): **succeeds** [E];
  - an arbitrary `<prefix>.dev.…shared`: `-34018` in both builds [E].
- In a test bundle without a host app the Keychain answers `-34018` to everything, on macOS and
  on the simulator [M], which is why `KeychainStore` keeps its fake `KeychainAPI` seam.
- Whether Keychain items survive app deletion on a **device** is not documented as a guarantee
  [I]. The simulator result does not carry over [U].

Recommendation:

- Device id: `AfterFirstUnlockThisDeviceOnly`, so it is never restored onto another device from a
  backup. It is readable after first unlock, so background launches (Background Assets
  extension wake-ups, background `URLSession`) can read it.
- Token: the same class. It is bound to the device id, so moving it to a new device is worse
  than re-activating [I]. This differs from `KeychainStore`'s `AfterFirstUnlock` (§Proposed
  edits).
- No explicit access group and no `keychain-access-groups` entitlement. The Background Assets
  extension must not read either value (notes/E9 §7.1), and the default group is app-private.
- Keep the device id's source of truth in the Keychain (KeychainStore keeps it in a 0600 file,
  which a reinstall removes). Treat "Keychain present, file absent" as a reinstall, not a new
  device.

### 4. The Godot binding [measured + emulated]

**Shape that worked:**

```
GDScript  PKeyApple (facade, autoload)    signals: transaction_updated, pack_progress, pack_ready, pack_failed
   │  ClassDB.class_call_static("PolarisKeyApple", "cmd", json)   (main thread)
   ▼
C glue    pkap.m: GDExtension C interface, no godot-cpp; {"op":"poll"} drains a locked queue
   │  pkp_call(json) / pkp_set_event_callback(cb)
   ▼
Swift     PKPlatform: Task.detached per async op → JSON event → callback (any thread) → queue
```

| Measurement (Godot 4.7.2, iOS 26.5 simulator) | Result                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd` thread                                  | `Thread.isMainThread == true` when called from GDScript [E]                                                                                                                       |
| async result latency (StoreKit op inside)     | `godot_wait_ms` 33–38 ms for AppTransaction/products (StoreKit itself 6–13 ms), 173–188 ms for purchase [E]                                                                       |
| event thread                                  | every Swift event `main_thread: false`; delivered to GDScript by the next poll [E]                                                                                                |
| poll cost                                     | 1.77–1.83 µs per empty `poll`; 3.5–5.6 µs per `ping` through Swift and JSON [E]                                                                                                   |
| polls during the 16.6 s binding plan          | 946 polls, 16 events [E]                                                                                                                                                          |
| framework                                     | 271,512 B (device) / 259,192 B (simulator); minos 17.0; MarketplaceKit **weak**-linked automatically; Swift runtime and Concurrency from the OS (`/usr/lib/swift`) [M]            |
| desktop, no native class                      | every call `{"ok":false,"unsupported":true,"reason":"runtime"}`; no load error printed [M]                                                                                        |
| iOS export without the plugin                 | every call `reason: "dependency"` [E]                                                                                                                                             |
| S-01 patch on top                             | App Group + `PKBADownloader.appex` (minos 26.0) + `BA*` keys; app minos 17.0; `** BUILD SUCCEEDED **` for simulator and device; the patch keeps the exported `get-task-allow` [M] |

**Why signals belong in the facade** [I from the measurements]. The native class only answers
`cmd`, so no Swift code ever calls the engine. That removes the one threading hazard (emitting a
Godot signal from a StoreKit or Background Assets callback thread), and the GDExtension surface
shrinks to one static method on the C interface. That method is ABI-stable across 4.x (notes/E4
§2.2), needs neither godot-cpp nor SwiftGodot, and adds no binary size. The facade can be tested
headless, and the native class cannot. Unity, MAUI and Tauri bind the same three C functions. The
cost is at most one frame of latency (16 ms at 60 fps), which nothing in P5-05 needs to beat.
**Binding choice to record in P5-05: C-interface glue (S-01 style), not godot-cpp, not
SwiftGodot.** SwiftGodot would bind the whole engine API through `extension_api.json`, tie the
build to a Godot version and add megabytes (GodotApplePlugins is about 2.5 MB, notes/E4 §2.2)
[I].

**Main-actor isolation.**

- StoreKit's `purchase` is `@MainActor` [D]. The C entry point is `nonisolated` and synchronous,
  so the probe hops with `Task.detached { await purchase(…) }` into a `@MainActor func` [M].
- `MainActor.assumeIsolated` would also work in Godot, where `cmd` runs on the main thread [E].
  But it traps on any other host thread, so it is not recommended [I].
- Only Sendable values (`String`, `UUID`, the `JSONValue` tree) may cross into the task.
- The callback lives in an `OSAllocatedUnfairLock<PKEventCallback?>` (a `@convention(c)` type is
  Sendable on 6.0–6.4) [M].
- A plain global `var` for the callback is an error on every compiler: "var 'gCallback' is not
  concurrency-safe because it is nonisolated global shared mutable state" [M].
- Capturing a non-Sendable `[String: Any]` in `Task { @MainActor in }` and
  `MainActor.assumeIsolated` from `@_cdecl` compiled on all four compilers [M]. They are legal,
  not safe [I].

**What compiles here but would fail on CI's Xcode 16.4** (Swift 6.1.2, iOS 18.5 SDK):

| Construct                                                                                                                           | Why it fails on Xcode 16.4                                                                                        | Guard                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AssetPackManager`, `AssetPack`, `StoreDownloaderExtension`, `BAAssetPackManager` and every managed Background Assets call          | not in the iOS 18.5 SDK (Xcode 26 SDK) [D, S-01]                                                                  | `#if compiler(>=6.2)` (Xcode 26.0 ships Swift 6.2) [I]. `canImport(BackgroundAssets)` is true on 16.4 (the framework is iOS 16) [I] |
| `ensureLocalAvailability(of:requireLatestVersion:)`, `getLocalStatus`, `assetPackIsAvailableLocally` (26.4)                         | Xcode 26.4 SDK [D, S-01]                                                                                          | `#if compiler(>=6.3)` [I; confirm the Swift version of Xcode 26.4 in CI]                                                            |
| `AppDistributor.eligibilityRegion`                                                                                                  | iOS 26.4 SDK [D]                                                                                                  | do not use                                                                                                                          |
| `AppTransaction.storeType`, `.all`, `.revocationDate`; `Transaction.commitmentInfo`                                                 | iOS 27 / 26.4 SDK [D]                                                                                             | do not use; read them from the JWS server-side                                                                                      |
| `@concurrent`, `nonisolated(nonsending)`, `Task.immediate`, isolated conformances, the `@c` attribute, tools-6.2 `defaultIsolation` | Swift 6.2+ language and package features [I]                                                                      | forbid; keep `swift-tools-version: 6.0` and `@_cdecl`                                                                               |
| `Transaction.currentEntitlements(for:)`, `Synchronization.Mutex`                                                                    | compile on 16.4 but sit above the iOS 17 floor; `currentEntitlements(for:)` errored here without `#available` [M] | `#available` or avoid                                                                                                               |
| `@MainActor final class …: XCTestCase` with `override func setUp() async throws`                                                    | compiled with the 27 SDK; Xcode 16.4's XCTest annotations were not checked                                        | [U]: run once on macos-15                                                                                                           |

The language patterns themselves are not the risk: the four compilers agree on every case tried
[M]. The repo's swift CI job runs `swift test --package-path sdks/swift` on macos-15. As soon as
`PolarisKeyPlatform` lands in `sdks/swift`, that job compiles it with Xcode 16.4, so the guards
above are mandatory unless the whole job moves to macos-26 [I].

### 5. Composition with S-01

The Swift framework and S-01's patch are independent [M]:

- the patch touches the project (target, entitlements, Info.plist) and not the framework;
- the framework is built at the app's floor (17.0);
- the extension is lifted to 26.0;
- both build for device and simulator.

The Background Assets calls themselves were not re-run in Swift here. S-01 measured them through
Objective-C `BAAssetPackManager`. That the Swift `AssetPackManager` overlay behaves the same,
including the `sharedManager` trap in an unconfigured process, is [I]. P5-05 should keep S-01's
Info.plist-key guard.

## Recommendation: the recipe for P5-05

1. **Package target `PolarisKeyPlatform`** (tools 6.0, Swift 6 mode, iOS 17 / macOS 14).
   - Modules `distributor`, `appTransaction`, `store`, `secureStore` and `assetPacks`, each behind a
     protocol seam with fakes.
   - The C surface is three functions: `pkp_call(json) -> char*` (sync result, or
     `{"ok":true,"req":N}` plus a later event carrying that `req`), `pkp_free`, and
     `pkp_set_event_callback`.
   - Events are JSON built from a Sendable value tree, emitted from any thread. The callback
     sits behind `OSAllocatedUnfairLock`.
2. **Async ops** each run in `Task.detached` and return a `JSONObject`. `purchase` is a
   `@MainActor` function that prefers `purchase(confirmIn:)` with the foreground-active
   `UIWindowScene`, and falls back to `purchase(options:)`. The C entry point never calls
   `MainActor.assumeIsolated`.
3. **Distributor**: §Results 2 order and result shape. The deadline is 2 s, and the timed-out
   task is left running and ignored (a task group would wait for it).
4. **Store**:
   - Set `appAccountToken` from P6-01's value.
   - Keep the verified `Transaction` from `purchase()` and `finish()` it only on the host's
     `finish` op, after the server has recorded it.
   - Start the `Transaction.updates` listener at launch and **deduplicate by transaction id**:
     updates re-deliver purchases.
   - Do not re-read `currentEntitlements` to confirm a purchase that just succeeded. It lags
     about 1 s, so use the purchase result.
   - Results carry `jwsRepresentation`.
5. **Secure store**: §Results 3. Both items `AfterFirstUnlockThisDeviceOnly`, data-protection
   keychain, no explicit access group, and the device id kept in the Keychain.
6. **Godot binding**:
   - `sdks/godot/native/ios/`: C-interface glue (from `pkap.m`/S-01 `pkba.m`) plus the package
     sources, linked by `swiftc -emit-library` into `pkey_apple.framework` per slice at the
     app's floor.
   - An xcframework with its own bundle id.
   - A `.gdextension` with `compatibility_minimum = "4.5"` and only `ios.*` entries (desktop then
     loads nothing and logs nothing).
   - Class `PolarisKeyApple` with the static `cmd`.
7. **Facade** `addons/polaris_key/native/pkey_apple.gd` (`PKeyApple`):
   - `call_sync`, an awaitable `call_async` resolved by `req`, and a `_process` poll.
   - Declares and emits `transaction_updated(jws)`, `pack_progress`, `pack_ready` and
     `pack_failed`.
   - Returns `Unsupported` with reason `runtime` off iOS and `dependency` without the class
     (both measured).
8. **Export**: S-01's patch unchanged for store presets. Nothing in the new framework needs a
   `keychain-access-groups` or extra entitlement.
9. **Tests**:
   - (a) `swift test` with fakes only. StoreKit Testing does nothing there.
   - (b) A small hosted XCTest project (app host with `get-task-allow`, unit tests with
     `SKTestSession`), run by `xcodebuild test` on a simulator in the macos-26 job. Each test
     must assert the product count, because a misconfigured session fails silently.
   - (c) The facade's stub tests headless.
   - (d) Optionally a simulator run of the Godot probe. It needs the arm64 simulator
     `libgodot.a` from the 4.7.2 tag (2 min 19 s here) and the Compatibility renderer.
   - Never link `StoreKitTest` or insert XCTest outside test builds.
10. **CI**: guard the SDK-gated code as in §Results 4, so the existing macos-15 job keeps compiling
    `sdks/swift`, and run the xcframework build and the hosted StoreKit tests on macos-26.
    Alternatively, move the whole Swift job to macos-26 and say so in the brief.

## Proposed edits (not applied; the lead applies them)

- **P5-05 Scope, Godot binding**: replace "registers class `PolarisKeyApple` with methods and
  the signals …" with "registers class `PolarisKeyApple` with one static `cmd(json) -> String`
  over the C interface (no godot-cpp, no SwiftGodot: S-09). Events are queued natively and
  drained by the facade, which declares and emits the signals `pack_progress`, `pack_ready`,
  `pack_failed` and `transaction_updated`."
- **P5-05 Scope, distributor**: add "Static bundle evidence in the same result
  (`embedded.mobileprovision` present, `ALTBundleIdentifier`, the running bundle id). Do not use
  `eligibilityRegion` (26.4, marketplace reporting only; never resolves on the simulator)."
- **P5-05 Scope, store**: add "Deduplicate `Transaction.updates` by transaction id (it
  re-delivers purchases). Do not confirm a purchase by re-reading `currentEntitlements` (about
  a 1 s lag, S-09). `currentEntitlements(for:)` is iOS 18.4."
- **P5-05 Scope, secureStore**: "the same attributes as `KeychainStore`" becomes "data-protection
  keychain, service `pkey:<product>`, `AfterFirstUnlockThisDeviceOnly` for the device id and the
  token, no access group. The device id lives in the Keychain (a reinstall removes the file)."
  Raise the class difference with `KeychainStore` (`AfterFirstUnlock`) for the Swift SDK owner
  rather than changing it silently.
- **P5-05 Gates / Design notes**: "The repo's macos-15 swift job (Xcode 16.4) compiles
  everything in `sdks/swift`. Guard Xcode-26-SDK code with `#if compiler(>=6.2)` and 26.4 APIs
  with `#if compiler(>=6.3)` (`canImport(BackgroundAssets)` does not separate them), avoid
  iOS 27 SDK StoreKit properties, keep tools-version 6.0 and `@_cdecl`. The hosted StoreKit tests
  and the xcframework build run on macos-26."
- **P5-05 "What can be built before a human supplies anything"**: "StoreKit Testing with a
  `.storekit` configuration where the test host allows it" becomes "StoreKit Testing in a hosted
  XCTest bundle whose app has `get-task-allow` (S-09). `swift test` and the bare SwiftPM test
  scheme load no products."
- **P5-05 Design notes, StoreKit**: add "Xcode-environment JWS are signed by a per-session
  self-signed P-256 certificate (`kid Apple_Xcode_Key`, one `x5c` entry). They test P6-01's
  parsing, not its chain validation."
- **P6-01**: reject `environment: "Xcode"` and any `x5c` that does not end at Apple Root CA G3.
  Compare `appAccountToken` as a UUID (the JWS has it in lower case). Payload field names are in
  §Results 1.
- **notes/E1 §F2**: add "StoreKit Testing reports `originalAppVersion` = `CFBundleVersion`, not
  `1.0`."

## Hand-off: device and account checklist for the owner [U]

Needs:

- the Apple developer account (Team ID, an App ID with App Groups, the two IAP products in App
  Store Connect, a Sandbox Apple Account);
- an iOS 26.4+ device, and for row 6 an iOS 17.4–25.x device;
- TestFlight access.

Build the probe (`gdx/`) signed, without `SKTestHook.swift`.

| #   | Run                                                                                           | Record                                                                                                                                                     | Default until then                                            |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | TestFlight install, plan `binding` without the `sk_*` ops                                     | `distributor` signal and ms; `provisioned`                                                                                                                 | `testFlight` per Apple's docs; `unavailable` on timeout       |
| 2   | Development-signed install from Xcode on the device                                           | `distributor` (resolves? which case?), `provisioned: true`                                                                                                 | `unavailable`/`other` = no evidence                           |
| 3   | Sandbox purchase of the non-consumable with an `appAccountToken`                              | the JWS: `x5c` length 3, chain to Apple Root CA G3 (`openssl verify`), `environment: "Sandbox"`; `purchase(confirmIn:)` shows the sheet over Godot's scene | as Apple documents (notes/E1 §F1)                             |
| 4   | Same install: `app_transaction`                                                               | `environment`, `originalAppVersion` (expect `1.0` in sandbox), whether it prompts for sign-in                                                              | do not use for outlet detection                               |
| 5   | Refund the sandbox purchase (Settings → Developer → sandbox account, or App Store Connect)    | `transaction_updated` with `revoked: true` and latency; `currentEntitlements` empty                                                                        | treat `REFUND`/`REVOKE` server notifications as authoritative |
| 6   | Keychain: `kc_write`, delete the app, reinstall, `kc_read` (on iOS 26.4+ and on an older iOS) | which items survive                                                                                                                                        | assume they may not; the device id falls back to a new one    |
| 7   | Keychain after a device restart, before first unlock, triggered by a background launch        | `-25308` (`errSecInteractionNotAllowed`) expected for `WhenUnlocked*` only                                                                                 | `AfterFirstUnlockThisDeviceOnly` for both items               |
| 8   | S-01's TestFlight processing of the patched build that also contains this framework           | processing result                                                                                                                                          | S-01 hand-off default                                         |
| 9   | One CI run of the package on macos-15 (Xcode 16.4)                                            | compile errors, if any, in the guarded code and the XCTest overrides                                                                                       | the guards in §Results 4                                      |

## Sources

- iOS SDK 27.0 (Xcode 27.0), read raw: `MarketplaceKit.swiftinterface` (`AppDistributor`,
  `eligibilityRegion` 26.4, `AppLibrary`), `StoreKit.swiftinterface` (`AppTransaction`,
  `Transaction`, `Product.purchase` overloads and isolation, `currentEntitlements(for:)` 18.4,
  `storeType`/`all` 27.0), `StoreKitTest.framework` headers and Swift interface (`SKTestSession`,
  `NS_SWIFT_SENDABLE`, `refundTransaction(identifier:)`) [D].
- Xcode 27.0 `IDEStoreKitEditor.ideplugin/Contents/Resources/StoreKitTestCertificate.cer` (RSA,
  `CN=StoreKit`, 2020–2040) [M].
- Apple documentation JSON (fetched 2026-10-03): `marketplacekit/appdistributor`,
  `marketplacekit/appdistributor/eligibilityregion`, `storekit/apptransaction/shared`,
  `storekit/apptransaction/originalappversion`, `storekit/appstore/environment/xcode` [D].
- The iOS 26.5 simulator's unified log (`storekitd`: "is not installed for development") and the
  probe crash report (`SKTestSession` → `XCTestLibrary` abort) [M].
- Godot 4.7.2-stable source tag (`ed1daf0bf`), built for the arm64 simulator [M].
- notes/S-01 (patch, shim, floors, simulator template), notes/S-06 §1 and short answers 3 and 6,
  notes/E1 §A2 and §F1–§F3, notes/E4 §2.2 and §3.2, notes/E9 §7.1,
  `sdks/swift/Sources/PolarisKeyCore/Store.swift` (`KeychainStore`), `.github/workflows/ci.yml`
  (swift job on macos-15) [S].
