---
title: "Your own UI (Swift)"
description: "Draw your own screens on PolarisKey for Swift: the state model, each call with the words to show, an @Observable wrapper, UIKit and AppKit hosts, updates with Sparkle, and tests."
sidebar:
  order: 2
type: "reference"
lastReviewed: "2026-11-01"
sdks: ["swift"]
lanes: ["library"]
---

The library returns typed results and draws nothing. This page gives, for each screen you build, the
call, the states it can answer and the words to show. To take the finished screens instead, see the
[drop-in quickstart](/docs/build/quickstart/swift/#4-gate-the-app). Create the `client` as the
quickstart does; every snippet here takes it as a parameter.

## The state model

`await client.status()` reads the cached, re-verified documents with no network. It answers a
`LicenseState`: a `status`, plus `graceUntil` (epoch seconds) and `lastVerifiedAt` (milliseconds).

| `status`                                                  | Show                                                         | `ErrorCopy.message(status.rawValue)`                           |
| --------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `.ok`, `.notApplicable`                                   | Your app. `.notApplicable` means the product runs no License | "Your license is active." / "This app doesn't need a license." |
| `.grace`                                                  | Your app, with a notice that counts down to `graceUntil`     | "The licensing service can't be reached…"                      |
| `.needsActivation`                                        | Key entry and sign-in                                        | "Enter a license key or sign in to continue."                  |
| `.expired`                                                | Renew, or connect to refresh                                 | "Your license has expired…"                                    |
| `.revoked`                                                | Key entry and sign-in again                                  | "This device was signed out…"                                  |
| `.versionTooOld`, `.versionTooNew`, `.channelNotEntitled` | An update or channel notice                                  | One sentence each                                              |

```swift
import PolarisKey

enum Screen {
    case app(notice: String?, until: Int?)
    case activate(message: String)
    case update(message: String)
}

func gateScreen(_ client: PolarisKeyClient) async -> Screen {
    let state = await client.status()
    let message = ErrorCopy.message(state.status.rawValue)
    switch state.status {
    case .ok, .notApplicable:
        return .app(notice: nil, until: nil)
    case .grace:
        return .app(notice: message, until: state.graceUntil)
    case .needsActivation, .revoked, .expired:
        return .activate(message: message)
    case .versionTooOld, .versionTooNew, .channelNotEntitled:
        return .update(message: message)
    }
}
```

`await client.isLicensed()` is true for `.ok`, `.grace` and `.notApplicable`: use it where you only
need to gate. The English sentences are generated; `ErrorCopy.setOverrides` replaces one per key.
They are English only: the drop-in kit translates, this layer does not.

## First activation and refusals

`activateWithKey(_:)` never throws for a refusal: it answers an `ActivationResult` whose case says which.
`ErrorCopy.activationMessage(result.kind)` is the sentence for each.

```swift
import PolarisKey

/// The sentence for a refusal, and where to send the person when there is somewhere to go.
func refusalScreen(_ result: ActivationResult) -> (message: String, link: String?)? {
    switch result {
    case .ok:
        return nil
    case .deviceLimit(let limit, let count, let manageURL):
        // Replace a device: Polaris Locker makes room for another device. Nothing was wiped.
        var params: [String: String] = [:]
        if let limit { params["limit"] = String(limit) }
        if let count { params["deviceCount"] = String(count) }
        let link = ManageLink.read(manageURL).map { ManageLink.withReturn($0, "myapp://activated") }
        return (ErrorCopy.activationMessage(result.kind, params: params), link)
    case .keyEntryLimit(let manageUrl, _):
        // The key has no entries left; nothing was wiped. Add it to an account, or sign in.
        return (ErrorCopy.activationMessage(result.kind), manageUrl)
    case .licenseOwned(let signInUrl):
        // The license is in an account and a key never moves it: sign in.
        return (ErrorCopy.activationMessage(result.kind), signInUrl)
    case .rateLimited(let seconds):
        let params = seconds.map { ["retryAfterSeconds": String($0)] } ?? [:]
        return (ErrorCopy.activationMessage(result.kind, params: params), nil)
    case .refused(let code, _, _):
        return (ErrorCopy.activationMessage(result.kind, code: code), nil)
    default:
        return (ErrorCopy.activationMessage(result.kind), nil)
    }
}

func activate(_ client: PolarisKeyClient, key: String) async -> String? {
    refusalScreen(await client.license.activateWithKey(key))?.message
}
```

| Case                                                                | Meaning                                        | Offer                                      |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| `.unauthorized`                                                     | The key was not accepted                       | Retry                                      |
| `.deviceLimit`                                                      | The device limit is reached                    | `manageURL`, then retry the same key       |
| `.licenseExpired`, `.licenseDisabled`                               | The license ended or an operator disabled it   | Renew, or contact the developer            |
| `.hardwareMismatch`, `.fingerprintRequired`, `.attestationRequired` | The device check failed                        | Retry; `hardwareMismatch` lists what moved |
| `.keyEntryLimit`                                                    | The key has no entries left                    | `manageUrl`, or sign in                    |
| `.licenseOwned`                                                     | The license is in an account                   | `signInUrl`: sign in                       |
| `.enrollDisabled`, `.enrollClaimed`                                 | No free license, or it is on an account        | Key entry, or sign in                      |
| `.rateLimited`                                                      | Too many attempts                              | Wait `retryAfterSeconds`                   |
| `.refused`, `.error`                                                | Any other refusal; a network or server failure | Show the sentence and the `code`           |

`.ok` carries the device token; its description prints `<redacted>`, so a log line never leaks it.
Read it with a pattern match, not `print`. `ManageLink.read` returns the URL only when it is valid;
open it behind a user action, never automatically. A device a key counts is also freed from a device
that still has a credential: `await client.deauthorizeDevice(id)`.

## Sign-in and who signed in

`client.identity.signIn.start(_:)` starts a sign-in. The default channel is the device code; pass
`SignInOptions(browser:)` to show the page in an `ASWebAuthenticationSession`. Anyone holding the
code can finish the sign-in elsewhere, so say who signed in before you move on.

```swift
import PolarisKey

func signIn(_ client: PolarisKeyClient) async -> String {
    do {
        let browser = await WebAuthenticationSignInBrowser()
        let session = try await client.identity.signIn.start(
            SignInOptions(deviceName: "Studio Mac", browser: browser))
        // Also draw session.userCode, session.verificationUri and the QR of
        // session.verificationUriComplete, for another device.
        switch try await session.wait() {
        case .signedIn(let ready):
            let who = ready.identity
            return "Signed in as \(who?.name ?? who?.email ?? "your account")"
        case .chooseLicense:
            return "Pick the license to use."  // redirect channel only
        case .choose(let identity, _):
            return "Continue as \(identity.name ?? identity.email ?? "this account")?"
        case .activated:
            return "This device is activated."  // a key return: only when you opt in
        case .expired:
            return "The code expired. Start again."
        case .cancelled, .pending:
            return "Sign-in stopped."
        }
    } catch let error as SignInError {
        return error.message
    } catch {
        return error.localizedDescription
    }
}
```

`session.reopen()` shows the page again and `session.cancel()` stops the wait. `wait()` never
returns `.choose` today: that case is for a flow held at the signed-in identity. A Deny on the
Polaris Locker approval page throws `SignInError` with `code == ErrorCode.signInDenied`; a failure
after approval throws `sign-in-failed`. Sign-in needs the Identity service; with it off, `start`
throws `service-unavailable` before any request.

### Redirect sign-in

An app on the person's own device usually wants the [native redirect](/docs/features/sign-in/native-redirect/): leave `redirectUri` out and the SDK opens the system browser and takes the code itself. The rest of this section is the web redirect.

A host that opens a browser and receives its redirect (an app with a universal link on an `https:`
address it registered) uses `channel: .redirect`. The session is single use: keep it until the
browser returns.

```swift
import PolarisKey

func beginRedirect(_ client: PolarisKeyClient) async throws -> SignInSession {
    try await client.identity.signIn.start(
        SignInOptions(
            channel: .redirect, redirectUri: "https://app.example/auth/callback",
            licenseChoice: .app))
}

/// Open session.authorizeUrl in the browser; hand the URL it lands on back here.
func finish(_ session: SignInSession, callback: String) async throws -> String? {
    switch try await session.complete(callbackUrl: callback) {
    case .signedIn(let ready):
        return ready.subject
    case .chooseLicense(let pending):
        return pending.view.state  // run `identity.choice`, below
    default:
        return nil  // cancelled
    }
}
```

`complete` checks `state` and the issuer before it sends anything. A refusal throws a `SignInError`
under the Worker's code (`invalid_grant`, `rate_limited` with `retryAfterSeconds`,
`sign-in-failed`) and leaves the device's token alone. A second call with the same callback is
refused without a request.

### Continue without an account

Set `keyReturn: true` in `SignInOptions` on the redirect channel and the card offers **Continue
without an account** to a person who has a license key. `complete` then settles
`.activated(SignInActivated)`: the token is stored as a key activation, the account the device held
is forgotten, and `keyEntries` is the license's count. No `.signedIn` event fires. A refusal
(`device_limit`, `key_entry_limit`, `license_owned`) carries `details`. The device-code channel
refuses the option with `invalid-argument`. Leave it off until your UI renders `.activated`.

### The license choice

With `licenseChoice: .app`, a person who holds licenses settles `.chooseLicense(PendingSignIn)`. No
token is stored until you finish with `client.identity.choice`. A refusal throws a `ChoiceError`
with its `code`:

```swift
import PolarisKey
import PolarisKeyIdentity

func choose(_ client: PolarisKeyClient, pending: PendingSignIn) async -> String {
    guard let first = pending.view.choices.first else {
        try? await client.identity.choice.cancel(grant: pending.grant)
        return "No license to use."
    }
    do {
        let done = try await client.identity.choice.complete(
            grant: pending.grant, choice: .license(id: first.id))
        return done.ready.licenseId ?? "Signed in."
    } catch let error as ChoiceError {
        // device_limit leaves the grant open and carries manageUrl and a fresh view.
        return error.manageUrl ?? error.signInUrl ?? error.code
    } catch {
        return error.localizedDescription
    }
}
```

The grant lives 300 seconds (`pending.expiresAt`) and is a credential: its description prints
`[redacted]`, so keep it out of your own logs too. `choice.licenses(grant:)` reads a fresh view,
`choice.devices(grant:licenseId:)` lists the devices on a full license for **Replace a device**, and
the inputs are `.license(id:replaceDeviceId:)`, `.keep`, `.create` and `.key(_:)`. To draw the choice
with the kit's screen, build a `LicenseChoiceModel(identity:pending:)` from `PolarisKeyUICore`.

### The account

```swift
import PolarisKey

func account(_ client: PolarisKeyClient) async throws -> String? {
    let subject = try await client.identity.subject()  // "ps_…" or nil
    if case .confirm = try await client.identity.attach(confirm: false) {
        _ = try await client.identity.attach(confirm: true)
    }
    try await client.identity.openAccount()  // Polaris Locker, in the system browser
    let result = try await client.identity.signOut()
    return result.released ? "Signed out. Activate again to continue." : subject
}
```

`attach(confirm: false)` previews and writes nothing; `confirm: true` adds the device's license to
the account. A refusal (`account_required`, `license_owned`) is a `.refused` result. `signOut()`
removes the device token only when `released` is true; a device activated by a key keeps its
license. `client.signOut()` forwards to it, and `client.deactivate()` frees the device itself.

## Status, offline and refresh

`create()` and `status()` need no network. Call `sync()` to refresh, or subscribe to `events`: one
`AsyncStream<PolarisKeyEvent>` per access, one event per difference.

```swift
import PolarisKey

func keepFresh(_ client: PolarisKeyClient) async {
    // Sync when the app becomes active, at most once a minute.
    await client.syncOnForeground()
    for await event in client.events {
        switch event {
        case .license(let status, _):
            print("license:", status.rawValue)
        case .config(let key, _, _, _):
            print("setting changed:", key)
        case .updateAvailable(let version, _, let mandatory, _):
            print("update", version, mandatory ? "(required)" : "")
        default:
            break
        }
    }
}
```

The kinds are `license`, `entitlement`, `config`, `updateAvailable`, `packs` and `store`. A sync that
fails offline leaves the last verified documents in force until `graceUntil`;
`await client.storeStatus()` says where the token lives. A machine with no network at all
activates from a signed file: `try await client.importBundle(jws)`.

## An @Observable wrapper

Hold the state in one model and let the views read it. This is the shape the kit's own
`PolarisKeyGateModel` has, in 30 lines.

```swift
import Observation
import PolarisKey
import SwiftUI

@MainActor @Observable
final class LicenseModel {
    private(set) var state = LicenseState(status: .needsActivation)
    private(set) var message: String?
    private let client: PolarisKeyClient

    init(client: PolarisKeyClient) { self.client = client }

    func start() async {
        state = await client.status()
        for await event in client.events {
            if case .license = event { state = await client.status() }
        }
    }

    func activate(key: String) async {
        let result = await client.license.activateWithKey(key)
        if case .ok = result { message = nil } else {
            message = ErrorCopy.activationMessage(result.kind)
        }
        state = await client.status()
    }
}

struct LicenseView: View {
    @State var model: LicenseModel
    @State private var key = ""

    var body: some View {
        VStack {
            if isUsable(model.state) {
                Text("Licensed")
            } else {
                TextField("License key", text: $key)
                Button("Activate") { Task { await model.activate(key: key) } }
                if let message = model.message { Text(message) }
            }
        }
        .task { await model.start() }
    }
}
```

## UIKit and AppKit

The headless layer needs no SwiftUI. Host the kit in a view controller with
`UIHostingController` or `NSHostingController`, or draw your own over `PolarisKeyUICore`:
`PolarisKeyGateModel` is `@Observable`, `KitStates` turns its `inputs` into a screen, and
`KitCopy.bundled` formats the copy lines in nine locales. Observe the model with
`withObservationTracking`, or from `client.events`, and update your views.

```swift
import PolarisKey
import PolarisKeyUICore

@MainActor
func render(_ client: PolarisKeyClient) async {
    let model = PolarisKeyGateModel(client: client)
    await model.reload()
    let screen = model.gate
    print("state:", screen.stateName)
    for line in screen.copy {
        print(KitCopy.bundled.format(line, locale: "en"))
    }
}
```

`screen.actions` lists what the person may do; call the model's matching method
(`submitKey()`, `beginSignIn()`, `useDifferentKey()`, `signOut()`).

## An update offer

`decide()` answers from the signed channel feed and works on iOS and macOS. Import
`PolarisKeyUpdate` to get `client.update`.

```swift
import PolarisKey
import PolarisKeyUpdate

func updateOffer(_ client: PolarisKeyClient) async throws -> String? {
    let check = try await client.update.decide(channel: "latest")
    switch check.decision {
    case .store(_, let listingUrl, _, _, _, _):
        return listingUrl  // open the App Store or TestFlight listing
    case .binary(_, let release, _, _, _, _, _, _):
        return "Version \(release.version) is ready"  // macOS: hand it to Sparkle
    case .blocked(let reason, _, _):
        return "Update required (\(reason))"
    default:
        return nil
    }
}
```

`decide()` needs the release keys, and the generated `clientOptions(version:)` leaves
`pinnedReleaseKeys` out. Call
`try client.configureUpdate(UpdateClientOptions(pinnedReleaseKeys: PolarisConfig.pinnedReleaseKeys))`
once, before the first `client.update` call, or `decide()` throws `not-configured`.

On macOS, `PolarisSparkle.start(client:)` follows license and channel changes and keeps Sparkle's
feed in step; `SUPublicEDKey` in your `Info.plist` stays the anchor that verifies the payload.
`isUndismissable(check.decision)` is true for a mandatory offer: show it as a persistent notice over
a running app, not a sheet. An update check that fails reports its reason in `check.errors`; it
does not throw while a committed feed is left to decide from. For your own update UI, pass
`userDriver:` (an `SPUUserDriver`) to `PolarisSparkle.start`; it changes the UI only, never the feed,
the signature check or the install.

To hold an install while the app is busy, pass `relaunchGate:`. Sparkle asks it once the update is
installed and about to relaunch the app; return `true` to hold, and call `resume()` once when the
relaunch may go on.

```swift no-compile
let sparkle = try await PolarisSparkle.start(
    client: client,
    relaunchGate: { _, resume in
        guard recorder.isRecording else { return false }
        recorder.onStop = resume
        return true
    })
```

To see the other `SPUUpdaterDelegate` callbacks, pass `hostDelegate:`. It receives every callback
the SDK does not answer itself, plus `didDownloadUpdate` and `willInstallUpdate` after the SDK
journals them. The SDK keeps the feed URL and the allowed channels; the host's answers to those are
never asked. A `relaunchGate` answers `shouldPostponeRelaunchForUpdate` before the host delegate.

A sandboxed Developer ID app needs Sparkle's installer setup: `SUEnableInstallerLauncherService`
set to `YES` in `Info.plist`, a `com.apple.security.temporary-exception.mach-lookup.global-name`
entitlement naming `$(PRODUCT_BUNDLE_IDENTIFIER)-spks` and `$(PRODUCT_BUNDLE_IDENTIFIER)-spki`, and
`SUEnableDownloaderService` when the app lacks `com.apple.security.network.client`. Without them
Sparkle starts and fails when it installs, so `PolarisSparkle.start` reads the app's entitlements
and throws `SparkleSandboxError.notConfigured`, naming what is missing.

## Tests

The client takes its store and transport through `PolarisKeyClientOptions`, so a test runs offline
and touches no Keychain. `InMemoryStore` is the store; a `PolarisTransport` of your own answers the
requests.

```swift
import Foundation
import PolarisKey

struct OfflineTransport: PolarisTransport {
    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        throw URLError(.notConnectedToInternet)
    }
}

func testClient() async throws -> PolarisKeyClient {
    try await PolarisKeyClient.create(
        options: PolarisKeyClientOptions(
            productSlug: PolarisConfig.productSlug,
            baseUrl: PolarisConfig.baseUrl,
            version: "1.0.0",
            pinnedKeys: PolarisConfig.pinnedKeys,
            store: InMemoryStore(productSlug: PolarisConfig.productSlug),
            transport: OfflineTransport()))
}

let client = try await testClient()
print(await client.status().status)  // needs-activation: nothing is cached
```

Ready-made doubles (`TestSigner`, `ScriptedTransport`) are planned, to sign documents and script answers.
Until then, sign test documents with a key whose public half you pin. For views,
`PolarisKeyPreview(.named(.welcome, "default")!)` draws any kit state with no client at all, and
`PolarisKeyGateModel(preview:)` holds one still for a snapshot.
