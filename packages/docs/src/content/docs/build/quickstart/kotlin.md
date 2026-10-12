---
title: "Kotlin"
description: "Integrate the Kotlin SDK: install from the feed, generate PolarisConfig.kt, then take the Compose screens on Android or draw your own UI on Android, Compose Desktop or the JVM."
sidebar:
  order: 5
---

For Android apps (API 24 and later), Compose Desktop apps and JVM tools. JDK 17.

## Install

Send the `im.plrs.key` group to Polaris Key's Maven feed alone, then add the artifacts for your
host. Every artifact carries the server's version, in lockstep; use one version for all of them.
`0.9.3` is the current release, and each artifact's `maven-metadata.xml` on the feed lists the rest.

```kts
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository {
                maven { url = uri("https://pkg.plrs.im/maven/polaris-key/") }
            }
            filter { includeGroupAndSubgroups("im.plrs.key") }
        }
        google()
        mavenCentral()
    }
}
```

```kts
// build.gradle.kts
dependencies {
    // Android: one flavour per build, play for Google Play or direct for a build you distribute yourself
    implementation("im.plrs.key:polaris-key-android-direct:0.9.3")
    implementation("im.plrs.key:polaris-key-ui:0.9.3") // the Compose screens, Android only
    // Compose Desktop and JVM tools: the OS keyring is included
    implementation("im.plrs.key:polaris-key-desktop:0.9.3")
}
```

`polaris-key-sdk` comes with each. Add `im.plrs.key:polaris-key-zstd:0.9.3` only if the app
installs packs. The other coordinates, Maven and the age gates:
[Installing the SDKs from the feeds](/docs/build/install/).

## Config

```sh
pnpm exec pkey sdk --lang kotlin --product <slug> --write --package com.acme.polaris \
  --out app/src/main/kotlin/com/acme/polaris/PolarisConfig.kt
```

Without Node, run the same command from the `pkey` image, in the project directory:

```sh
docker run --rm -v "$PWD:/work" pkg.plrs.im/polaris-key/pkey:latest sdk --lang kotlin \
  --product <slug> --write --package com.acme.polaris \
  --out app/src/main/kotlin/com/acme/polaris/PolarisConfig.kt
```

It writes `PolarisConfig`: the slug, base URL, trust pins, advertised services and, when the
product has release keys, `pinnedReleaseKeys`. Compare the printed pin fingerprints with the console
before you ship. A local Polaris Key to run against is planned.

## The client

`clientOptions(version)` carries everything the client needs; `version` is your app's own. Each host
has one start, and no start touches the network: the Android one returns a usable client at once and
loads its state in the background; the desktop one is `suspend` and returns once the token and the
cached documents are loaded.

```kotlin android
import android.app.Application
import com.acme.polaris.PolarisConfig
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.android.PolarisKeyLifecycle
import im.plrs.key.sdk.PolarisKeyClient

class App : Application() {
    lateinit var client: PolarisKeyClient
        private set

    override fun onCreate() {
        super.onCreate()
        val version = packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
        client = PolarisKeyAndroid.client(this, PolarisConfig.clientOptions(version))
        PolarisKeyLifecycle.install(this, client) // syncs when the app comes to the foreground
    }
}
```

On Android, build the client with `PolarisKeyAndroid.client`: it supplies the Keystore store, and a
client built without a store throws `invalid-options`. It does no file work before it returns, so it
is safe on the main thread. Its `suspend` twin, `PolarisKeyAndroid.create`, returns once the state
is loaded.

```kotlin
import com.acme.polaris.PolarisConfig
import im.plrs.key.desktop.PolarisKeyDesktop

suspend fun start() {
    val client = PolarisKeyDesktop.create(PolarisConfig.clientOptions("1.4.2"))
    println(client.status())
    client.close() // ends the client's threads so a JVM main can exit
}
```

`PolarisKeyDesktop.create` keeps the token in the OS keyring, in a `0600` file when the keyring is
unreachable, and, when the options carry `UpdateClientOptions` (the generated config does when the
product has release keys), installs the desktop update driver.

## Pick a lane

| Host            | Drop-in screens                     | Your own UI                                                                     |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Android         | [The Compose kit](#drop-in-android) | [The library](/docs/build/sdks/kotlin/your-own-ui/)                             |
| Compose Desktop | None: the kit is Android only       | [A recipe](/docs/build/sdks/kotlin/your-own-ui/#compose-desktop)                |
| JVM tool        | None: a tool prints its own output  | [A command-line tool](/docs/build/sdks/kotlin/your-own-ui/#a-command-line-tool) |

### Drop-in: Android

`PolarisKeyApp` starts the client, gates your content, and runs activation and the update banner over
it. `signIn = true` adds the device-code sign-in to the gate.

```kotlin android
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import im.plrs.key.ui.PolarisKeyApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                PolarisKeyApp(client, signIn = true) { Text("Licensed") }
            }
        }
    }
}
```

Here `client` is the one `App` built: `(application as App).client`, with `App` named in the
manifest as `android:name` on `<application>`. Screens, branding and copy:
[Compose](/docs/build/ui/frameworks/compose/).

## The same eight checkpoints

| #   | Checkpoint         | Drop-in (Android)                                   | Your own UI                                                   |
| --- | ------------------ | --------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Install            | above                                               | above                                                         |
| 2   | Config             | above                                               | above                                                         |
| 3   | First activation   | The gate's key field                                | `client.activate(key)`                                        |
| 4   | Each refusal       | Printed by the kit; a full device list gets a link  | `Copy.activationMessage(kind, code = r.code)`, `manageUrl`    |
| 5   | Sign-in            | `PolarisKeyApp(client, signIn = true)`              | `client.identity.beginSignIn()`, then `waitForSignIn(prompt)` |
| 6   | Status and offline | The grace banner                                    | `client.status()`, then `client.licenseChanges`               |
| 7   | An update offer    | The update banner and prompt                        | `client.update.decide()`, then `client.update.install(check)` |
| 8   | Tests              | `PolarisKeyApp` over a client on an `InMemoryStore` | `InMemoryStore`, `PolarisTransport`, `CoreOptions.clock`      |

The kit does not say who signed in. `client.license.licenseUser()` answers the pairwise subject (it
ships after `0.9.3`); the person's name and email are planned.

The SDK's own test doubles are planned. Until they land, script a refusal with your own
`PolarisTransport`, as [Your own UI](/docs/build/sdks/kotlin/your-own-ui/#tests) shows, and pass
that client to `PolarisKeyApp`.

[Your own UI](/docs/build/sdks/kotlin/your-own-ui/) gives each call with its state and its words.
The whole API is the [Kotlin SDK reference](/docs/build/sdks/kotlin/); a full device list has a
[recipe](/docs/build/recipes/device-limit/).
