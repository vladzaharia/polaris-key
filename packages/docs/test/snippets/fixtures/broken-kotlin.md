# A deliberately broken Kotlin page

The lane fails each of these. `NotAnExportInKotlin` names no export.

```kotlin
import com.acme.polaris.PolarisConfig
import im.plrs.key.sdk.PolarisKeyClient

suspend fun start() {
    val client = PolarisKeyClient.create(PolarisConfig.clientOptions(version = "1.0"))
    client.noSuchMethod()
}
```

```kotlin no-compile
this is not kotlin
```
