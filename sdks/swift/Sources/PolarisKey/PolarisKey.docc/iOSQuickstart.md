# iOS quickstart

Gate an iOS app on a licence, sell an in-app purchase through StoreKit 2, attest the device with
App Attest and hand updates to the App Store.

## Add the package

Add `PolarisKey` and, for SwiftUI, `PolarisKeyUI`. Add `PolarisKeyUpdate` only when the app
ships packs: App Store builds update through the store, and Sparkle is never linked on iOS.

Generate the configuration with `pkey sdk --lang swift --write` and add `PolarisKey.plist` to the
app target.

## Start the client

```swift
import PolarisKey
import PolarisKeyUI
import SwiftUI

@main
struct MyApp: App {
    @State private var client: PolarisKeyClient?

    var body: some Scene {
        WindowGroup {
            if let client {
                ContentView().polarisKey(client)
            } else {
                ProgressView().task { client = try? await PolarisKeyClient.fromBundle() }
            }
        }
    }
}
```

`.polarisKey(client)` puts the observable model in the environment and syncs when the scene
becomes active. Subscribe to `client.changes` for licence, config, update and pack events.

## Sell with StoreKit 2

```swift
switch await client.commerce.purchase(productID: "com.example.pro") {
case .claimed(let claim, _):
    print("unlocked", claim.flag)  // the licence carries the flag; the client already synced
default:
    break
}
```

The SDK asks the server for a binding, passes its id as `appAccountToken`, claims the signed
transaction, finishes it only after the claim and syncs. Call
`client.commerce.startTransactionUpdates()` at launch so renewals and Ask to Buy approvals are
claimed too, and `restore()` behind a Restore button.

## Attest the device

```swift
let result = await client.devices.attest()
```

App Attest runs on a real device only. A product that requires attestation answers
`attestation_required` on edge-mint and commerce claims; the SDK attests once and retries once
on its own. The simulator and macOS answer the typed `unsupported` result.

## Hand updates to the store

With `PolarisKeyUpdate` imported, `client.update.decide()` returns the signed decision and
`client.update.install(check)` opens the App Store, TestFlight or marketplace listing. Device
reports carry the update-health events the dashboard charts.
