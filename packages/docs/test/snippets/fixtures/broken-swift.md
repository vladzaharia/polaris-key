# A deliberately broken Swift page

The lane fails each of these. `NotAnExportInSwift` names no export.

```swift
import PolarisKey

let client = try await PolarisKeyClient.create(options: PolarisConfig.clientOptions(version: "1.0"))
await client.noSuchMethod()
```

```swift no-compile
this is not swift
```
