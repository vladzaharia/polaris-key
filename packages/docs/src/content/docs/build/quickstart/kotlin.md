---
title: "Kotlin"
description: "Integrate the Kotlin SDK: install from the feed, generate PolarisConfig.kt, then take the Compose screens on Android or draw your own UI on Android, Compose Desktop or the JVM."
sidebar:
  order: 5
---

For Android apps (API 24 and later), Compose Desktop apps and JVM tools. JDK 17.

## Install

Send the `im.plrs.key` group to Polaris Key's Maven feed alone, then add the artifacts for your
host. `<version>` is the version your Polaris Key runs; the feed's `maven-metadata.xml` lists it.

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
    // Android: one flavour per build, play or direct
    implementation("im.plrs.key:polaris-key-android-direct:<version>")
    implementation("im.plrs.key:polaris-key-ui:<version>") // the Compose screens
    // Compose Desktop and JVM tools: the OS keyring is included
    implementation("im.plrs.key:polaris-key-desktop:<version>")
}
```

`polaris-key-sdk` comes with each. Add `im.plrs.key:polaris-key-zstd:<version>` only if the app
installs packs. The other coordinates, Maven and the age gates:
[Installing the SDKs from the feeds](/docs/build/install/).

## Config

```sh
pnpm exec pkey sdk --lang kotlin --product <slug> --write --package com.acme.polaris \
  --out app/src/main/kotlin/com/acme/polaris/PolarisConfig.kt
```

It writes `PolarisConfig`: the slug, base URL, trust pins, advertised services and, when the
product has release keys, `pinnedReleaseKeys`. Compare the printed pin fingerprints with the console
before you ship. A local Polaris Key to run against is planned.

## The client

`clientOptions(version)` carries everything the client needs; `version` is your app's own. Each host
has one start, and it returns a usable client at once, with no network.

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

On Android, `PolarisKeyAndroid.client` is the only start: it supplies the Keystore store, which a
client built any other way lacks. It is safe on the main thread.

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
unreachable, and installs the desktop update driver.

## Pick a lane

| Host            | Drop-in screens                     | Your own UI                                                                     |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Android         | [The Compose kit](#drop-in-android) | [The library](/docs/build/sdks/kotlin/your-own-ui/)                             |
| Compose Desktop | None: the kit is Android only       | [A recipe](/docs/build/sdks/kotlin/your-own-ui/#compose-desktop)                |
| JVM tool        | None: a tool prints its own output  | [A command-line tool](/docs/build/sdks/kotlin/your-own-ui/#a-command-line-tool) |

### Drop-in: Android

`PolarisKeyApp` starts the client, gates your content, and runs activation, sign-in and the update
banner over it.

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
                PolarisKeyApp(client) { Text("Licensed") }
            }
        }
    }
}
```

Here `client` is the one `App` built. Screens, branding and copy:
[Compose](/docs/build/ui/frameworks/compose/).

## The same eight checkpoints

| #   | Checkpoint         | Drop-in (Android)                                  | Your own UI                                                   |
| --- | ------------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Install            | above                                              | above                                                         |
| 2   | Config             | above                                              | above                                                         |
| 3   | First activation   | The gate's key field                               | `client.activate(key)`                                        |
| 4   | Each refusal       | Printed by the kit; a full device list gets a link | `Copy.activationMessage(...)`, `manageUrl`                    |
| 5   | Sign-in            | `PolarisKeyApp(client, signIn = true)`             | `client.identity.beginSignIn()`, then `waitForSignIn(prompt)` |
| 6   | Status and offline | The grace banner                                   | `client.status()`, `client.licenseState`                      |
| 7   | An update offer    | The update banner and prompt                       | `client.update.decide()`                                      |
| 8   | Tests              | `InMemoryStore`, your own `PolarisTransport`       | `InMemoryStore`, `PolarisTransport`, `CoreOptions.clock`      |

[Your own UI](/docs/build/sdks/kotlin/your-own-ui/) gives each call with its state and its words.
The whole API is the [Kotlin SDK reference](/docs/build/sdks/kotlin/); a full device list has a
[recipe](/docs/build/recipes/device-limit/).
