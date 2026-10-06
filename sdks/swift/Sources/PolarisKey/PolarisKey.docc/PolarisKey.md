# `PolarisKey`

Licensing, remotely managed config, identity, devices, commerce and updates for Apple apps, from
one client.

## Overview

`PolarisKeyClient` is the one object an app holds. Start it from the generated
`PolarisKey.plist`, then read the gate, config and entitlements from it:

```swift
import PolarisKey

let client = try await PolarisKeyClient.fromBundle()
await client.sync()
if await client.isEnabled(flag: "pro") {
    // unlock
}
```

Every signed document is verified on device with CryptoKit against the pinned trust set, and the
device token lives in the Keychain. The same cross-language conformance corpus that pins the
Node, Python, React, Kotlin and Godot SDKs pins this one.

## Topics

### Essentials

- <doc:iOSQuickstart>
- `PolarisKeyClient`
- `PolarisKeyBundleConfig`

### Change events

- `PolarisKeyClient.events`
- `PolarisKeyEvent`
- `PolarisEventHub`

### Sign-in

- `CurrentIdentity`
- `SignInBrowser`

### Devices and commerce

- `DevicesClient`
- `CommerceClient`
