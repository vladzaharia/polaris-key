---
title: "Swift"
description: "Integrate PolarisKey in five minutes: generate PolarisConfig.swift, create the client, gate, read config, sync."
sidebar:
  order: 4
---

For macOS, iOS and iPadOS. Swift 6.

```sh
swift package-registry set --scope polaris-key https://pkg.plrs.im/swift/polaris-key
pkey sdk --lang swift --write   # writes PolarisConfig.swift; add it to the app target
```

```swift
import PolarisKey

let client = try await PolarisKeyClient.create(
    options: PolarisConfig.clientOptions(version: Bundle.main.appVersion))

if !(await client.isLicensed()) {
    let result = await client.activate(key: userEnteredKey)
    print("activation:", result)
}

let concurrency = await client.config.config("run.concurrency", default: .int(4))
await client.sync()
```

`Bundle.main.appVersion` stands for however the app reads its marketing version.
`PolarisConfig.pinnedReleaseKeys` feeds `UpdateClientOptions(pinnedReleaseKeys:)` in
`PolarisKeyUpdate` and `PolarisKeyPacks`. The drop-in SwiftUI gate is `PolarisKeyUI`.

Next: the full [Swift SDK reference](/docs/build/sdks/swift/).
