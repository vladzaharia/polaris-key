---
title: "Your own UI (Swift)"
description: "Draw your own screens on PolarisKey for Swift: the state model, each call with the words to show, an @Observable wrapper, UIKit and AppKit hosts, updates with Sparkle, and tests."
sidebar:
  order: 2
type: "reference"
lastReviewed: "2026-10-16"
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

`activate(key:)` never throws for a refusal: it answers an `ActivationResult` whose case says which.
`ErrorCopy.activationMessage(result.kind)` is the sentence for each.

```swift
import PolarisKey

/// The sentence for a refusal, and where to send the person when there is somewhere to go.
func refusalScreen(_ result: ActivationResult) -> (message: String, link: String?)? {
    switch result {
    case .ok:
        return nil
    case .deviceLimit(let limit, let count, let manageURL):
        // Replace a device: Polaris Locker frees a seat. Nothing was wiped.
        var params: [String: String] = [:]
        if let limit { params["limit"] = String(limit) }
        if let count { params["deviceCount"] = String(count) }
        let link = ManageLink.read(manageURL).map { ManageLink.withReturn($0, "myapp://activated") }
        return (ErrorCopy.activationMessage(result.kind, params: params), link)
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
    refusalScreen(await client.activate(key: key))?.message
}
```

| Case                                                                | Meaning                                        | Offer                                      |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| `.unauthorized`                                                     | The key was not accepted                       | Retry                                      |
| `.deviceLimit`                                                      | Every seat is taken                            | `manageURL`, then retry the same key       |
| `.licenseExpired`, `.licenseDisabled`                               | The license ended or an operator disabled it   | Renew, or contact the developer            |
| `.hardwareMismatch`, `.fingerprintRequired`, `.attestationRequired` | The device check failed                        | Retry; `hardwareMismatch` lists what moved |
| `.enrollDisabled`, `.enrollClaimed`                                 | No free license, or it is on an account        | Key entry, or sign in                      |
| `.rateLimited`                                                      | Too many attempts                              | Wait `retryAfterSeconds`                   |
| `.refused`, `.error`                                                | Any other refusal; a network or server failure | Show the sentence and the `code`           |

`.ok` carries the device token; its description prints `<redacted>`, so a log line never leaks it.
Read it with a pattern match, not `print`. `ManageLink.read` returns the URL only when it is valid;
open it behind a user action, never automatically. A seat a key holds is also freed from a device
that still has a credential: `await client.deauthorizeDevice(id)`.

## Sign-in and who signed in

`signInWithBrowser()` runs the device-code flow in an `ASWebAuthenticationSession`. Anyone holding
the code can finish the sign-in elsewhere, so say who signed in before you move on.

```swift
import PolarisKey

func signIn(_ client: PolarisKeyClient) async -> String {
    do {
        let result = try await client.signInWithBrowser(deviceName: "Studio Mac")
        switch result {
        case .ready:
            // identity is nil for a key-only device, so ask once sign-in has settled.
            let who = await client.identity.current()
            return "Signed in as \(who?.name ?? who?.email ?? "your account")"
        case .confirm(let identity, _):
            return "Continue as \(identity.name ?? identity.email ?? "this account")?"
        case .expired:
            return "The code expired. Start again."
        case .error(let message):
            return message
        }
    } catch {
        return error.localizedDescription
    }
}
```

`signInWithBrowser()` never returns `.confirm`: that case comes only from
`waitForSignIn(_:confirmIdentity:)` on `client.identity` with `confirmIdentity: true`, which holds at
the signed-in identity until the person accepts. Sign-in needs the Identity service; with it off,
the call throws `service-unavailable` before any request. `try await client.signOut()` ends the
session.

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
        let result = await client.activate(key: key)
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
does not throw while a committed feed is left to decide from. A custom Sparkle driver (your own
update UI) is planned.

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
