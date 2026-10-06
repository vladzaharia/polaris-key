---
title: "Kotlin"
description: "Integrate the Kotlin SDK in five minutes: generate PolarisConfig.kt, create the client, gate, read config."
sidebar:
  order: 5
---

For Android (with the Compose kit) and the JVM. JDK 17.

```sh
pkey sdk --lang kotlin --write --package com.acme.polaris --out app/src/main/kotlin/com/acme/polaris/PolarisConfig.kt
```

```kotlin
import com.acme.polaris.PolarisConfig
import im.plrs.key.core.isUsable
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.serialization.json.JsonPrimitive

val client = PolarisKeyClient.create(PolarisConfig.clientOptions(version = BuildConfig.VERSION_NAME))
if (!isUsable(client.status())) client.activate(userEnteredKey)
val theme = client.config("ui.theme", JsonPrimitive("dark"))
```

`clientOptions()` configures the update client when the product declares release keys; build on
`PolarisConfig.coreOptions()` to add a store, a transport or packs. On Android, `polaris-key-ui`
draws the boot shell, the gate and the update prompt over the host's `MaterialTheme`.

Next: the full [Kotlin SDK reference](/docs/build/sdks/kotlin/) and the
[Compose UI kit](/docs/build/ui/frameworks/compose/).
