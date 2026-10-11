---
title: "Swift"
description: "Integrate PolarisKey for Swift: install from the feed in Package.swift or Xcode, generate PolarisConfig.swift, then take the SwiftUI drop-in or draw your own UI."
sidebar:
  order: 4
---

For iOS, iPadOS and macOS apps. Swift 6; the floors are iOS 18 and macOS 15.

## Install

Point SwiftPM at the feed first, so the package resolves from Polaris Key and nowhere else:

```sh
swift package-registry set --global --scope polaris-key https://pkg.plrs.im/swift/polaris-key
```

In a Swift package, add the dependency. `platforms:` must be at least the floors above.

```text
// Package.swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MyApp",
    platforms: [.macOS(.v15), .iOS(.v18)],
    dependencies: [
        .package(id: "polaris-key.PolarisKey", from: "0.9.3")
    ],
    targets: [
        .executableTarget(name: "MyApp", dependencies: [
            .product(name: "PolarisKey", package: "polaris-key.PolarisKey"),
            .product(name: "PolarisKeyUI", package: "polaris-key.PolarisKey"),
        ])
    ]
)
```

In an Xcode project, the `--global` setting above is the one that matters: Xcode reads the global
registry configuration. Then choose File, Add Package Dependencies, enter `polaris-key.PolarisKey`
in the search field, and add `PolarisKey` and, for the drop-in screens, `PolarisKeyUI` to the app
target. Other managers and the age gates that delay a new version:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/).

## Config

```sh
pnpm exec pkey sdk --lang swift --product <slug> --write
```

It writes `PolarisConfig.swift`: the slug, base URL, trust pins, advertised services and, when the
product has release keys, `pinnedReleaseKeys`. Add it to the app target and compare the printed pin
fingerprints with the console before you ship.

## The client

```swift
import PolarisKey

let client = try await PolarisKeyClient.create(
    options: PolarisConfig.clientOptions(version: "1.4.2")  // your app's marketing version
)
```

`create` is offline-first: it loads the token and re-verifies the cached documents, with no network.
Every path starts here.

## Pick a lane

| Host            | Drop-in screens                     | Your own UI                                                              |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| SwiftUI         | [The SwiftUI kit](#drop-in-screens) | [Your own UI](/docs/build/sdks/swift/your-own-ui/)                       |
| UIKit or AppKit | None: the kit is SwiftUI            | [UIKit and AppKit](/docs/build/sdks/swift/your-own-ui/#uikit-and-appkit) |

### Drop-in screens

One modifier gates the app and runs every screen the license needs.

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
                ContentView().polarisKeyGate(client)
            } else {
                ProgressView().task {
                    client = try? await PolarisKeyClient.create(
                        options: PolarisConfig.clientOptions(version: "1.4.2"))
                }
            }
        }
    }
}

struct ContentView: View {
    var body: some View { Text("Licensed") }
}
```

Customise it, or take the parts one by one: [SwiftUI kit](/docs/build/ui/frameworks/swiftui/). The
kit is English-only until its localization lands.

## The same eight checkpoints

| #   | Checkpoint         | Drop-in                                                     | Your own UI                                                    |
| --- | ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Install            | above                                                       | above                                                          |
| 2   | Config             | above                                                       | above                                                          |
| 3   | First activation   | The gate's key field                                        | `client.activate(key:)`                                        |
| 4   | Each refusal       | Shown by the gate; a full device list gets Replace a device | `ErrorCopy.activationMessage(result.kind)`, `ManageLink.read`  |
| 5   | Sign-in            | The gate's sign-in form                                     | `client.signInWithBrowser()`, then `client.identity.current()` |
| 6   | Status and offline | The gate and its grace banner                               | `client.status()`, `client.isLicensed()`                       |
| 7   | An update offer    | The update prompt                                           | `client.update.decide(channel:)`                               |
| 8   | Tests              | `PolarisKeyPreview(.named(.welcome, "default")!)`           | `InMemoryStore`, a `PolarisTransport` of your own              |

[Your own UI](/docs/build/sdks/swift/your-own-ui/) gives each call with its state and its words.
The whole API is the [Swift SDK reference](/docs/build/sdks/swift/).
