---
title: "Your own UI (Kotlin)"
description: "Draw your own screens on the Kotlin SDK: the state model, each call with the words to show, threading, a Compose Desktop recipe, a command-line tool, and tests."
sidebar:
  order: 2
type: "reference"
lastReviewed: "2026-10-16"
sdks: ["kotlin"]
lanes: ["library"]
---

The library returns typed results and draws nothing. This page gives, for each screen you build, the
call, the states it can answer and the words to show. To take the finished Android screens instead,
see the [drop-in quickstart](/docs/build/quickstart/kotlin/#4-gate-the-app). Create the `client`
as the quickstart does; every snippet here takes it as a parameter.

## Threading

Every `suspend` function on the client is main-safe: it moves its own file and network work off the
calling thread, so call it from `viewModelScope`, `rememberCoroutineScope` or `runBlocking` alike.
`client.update.install` is the exception: it runs the platform installer where you call it, and each
installer keeps its own file work off the main thread. Canceling the scope cancels a sign-in wait.
`close()` is not `suspend`; it stops the client's threads so a JVM `main` can exit. From Java,
`PolarisKeyFutures(client)` returns `CompletableFuture`s.

## The state model

`client.status()` reads the cached, re-verified documents with no network. It answers a
`LicenseState`: a `status`, plus `graceUntil` (epoch seconds) and `allowedRange`.

| `status`                                               | Show                                                        | `Copy.message(status.wire)`                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `ok`, `notApplicable`                                  | Your app. `notApplicable` means the product runs no License | "Your license is active." / "This app doesn't need a license." |
| `grace`                                                | Your app, with a notice that counts down to `graceUntil`    | "The licensing service can't be reached…"                      |
| `needsActivation`                                      | Key entry and sign-in                                       | "Enter a license key or sign in to continue."                  |
| `expired`                                              | Renew, or connect to refresh                                | "Your license has expired…"                                    |
| `revoked`                                              | Key entry and sign-in again                                 | "This device was signed out…"                                  |
| `versionTooOld`, `versionTooNew`, `channelNotEntitled` | An update or channel notice from `allowedRange`             | One sentence each                                              |

```kotlin
import im.plrs.key.core.Copy
import im.plrs.key.core.LicenseStatus
import im.plrs.key.sdk.PolarisKeyClient

data class GateScreen(val show: String, val message: String? = null, val graceUntil: Long? = null)

suspend fun gateScreen(client: PolarisKeyClient): GateScreen {
    val state = client.status()
    val words = Copy.message(state.status.wire)
    return when (state.status) {
        LicenseStatus.ok, LicenseStatus.notApplicable -> GateScreen("app")
        LicenseStatus.grace -> GateScreen("app", words, state.graceUntil)
        LicenseStatus.needsActivation, LicenseStatus.revoked, LicenseStatus.expired ->
            GateScreen("activate", words)
        LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled ->
            GateScreen("update", words)
    }
}
```

`client.isLicensed()` is true for `ok`, `grace` and `notApplicable`: use it where you only need to
gate. Times are epoch seconds, except `lastVerifiedAt`, which is milliseconds.

## First activation and refusals

`activate` never throws for a refusal: it answers an `ActivationResult` whose type says which.
`Copy.activationMessage(kind)` is the sentence for each. Every result but `Ok` carries a `code`: the
server's, or `network` or `server-error` for `Error`. A `Refused` code reads its own sentence when
the catalog has one, so the code is its kind.

```kotlin
import im.plrs.key.core.Copy
import im.plrs.key.core.ManageLink
import im.plrs.key.license.ActivationResult
import im.plrs.key.sdk.PolarisKeyClient

fun kindOf(r: ActivationResult): String = when (r) {
    is ActivationResult.Ok -> "ok"
    is ActivationResult.KeyEntryLimit -> "key-entry-limit"
    is ActivationResult.LicenseOwned -> "license-owned"
    is ActivationResult.DeviceLimit -> "device-limit"
    is ActivationResult.Unauthorized -> "unauthorized"
    is ActivationResult.FingerprintRequired -> "fingerprint-required"
    is ActivationResult.HardwareMismatch -> "hardware-mismatch"
    is ActivationResult.EnrollDisabled -> "enroll-disabled"
    is ActivationResult.EnrollClaimed -> "enroll-claimed"
    is ActivationResult.LicenseDisabled -> "license-disabled"
    is ActivationResult.LicenseExpired -> "license-expired"
    is ActivationResult.AttestationRequired -> "attestation-required"
    is ActivationResult.RateLimited -> "rate-limited"
    is ActivationResult.Refused -> r.code
    is ActivationResult.Error -> "error"
}

class Refusal(val message: String, val link: String? = null, val retryAfterSeconds: Long? = null)

suspend fun activate(client: PolarisKeyClient, key: String): Refusal? {
    val r = client.license.activateWithKey(key)
    if (r is ActivationResult.Ok) return null
    val message = Copy.activationMessage(kindOf(r), code = r.code)
    return when (r) {
        // Replace a device: Polaris Locker makes room for another device. Nothing was wiped.
        is ActivationResult.DeviceLimit -> Refusal(
            message,
            link = r.manageUrl?.let { ManageLink.withReturn(ManageLink.withKey(it, key), "myapp://activated") },
        )
        is ActivationResult.RateLimited -> Refusal(message, retryAfterSeconds = r.retryAfterSeconds)
        else -> Refusal(message)
    }
}
```

| Result                              | Meaning                                                          | Offer                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Unauthorized`                      | The key was not accepted                                         | Retry                                                                                    |
| `KeyEntryLimit`                     | The key has used every entry its product allows                  | `manageUrl`, to add the key to an account                                                |
| `LicenseOwned`                      | The license is in an account, and a key does not move it         | `signInUrl`, behind a user action                                                        |
| `DeviceLimit`                       | The device limit is reached                                      | `manageUrl`, then retry the same key                                                     |
| `LicenseExpired`, `LicenseDisabled` | The license ended or an operator disabled it                     | Renew, or contact the developer                                                          |
| `HardwareMismatch`                  | The hardware moved past the tier's tolerance                     | Retry: it binds the new hardware and counts toward the limit; `changed` lists what moved |
| `FingerprintRequired`               | The tier needs a hardware fingerprint this device could not give | Show the copy                                                                            |
| `AttestationRequired`               | The product needs a verified device                              | `client.devices.attest()`, then retry                                                    |
| `EnrollDisabled`, `EnrollClaimed`   | From `client.enroll()`: no free license, or it is on an account  | Key entry, or sign in                                                                    |
| `RateLimited`                       | Too many attempts                                                | Wait `retryAfterSeconds` when it is set                                                  |
| `Refused`, `Error`                  | Any other refusal; a network or server failure                   | Show the copy and `code`                                                                 |

Leave `withKey` out of any QR code you draw: a TV is on view to anyone in the room. The device limit is also
freed from a device that still holds a credential, with `client.deauthorizeDevice(id)`. See the
[device-limit recipe](/docs/build/recipes/device-limit/).

## Sign-in and who signed in

```kotlin
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.sdk.PolarisKeyClient

suspend fun signIn(client: PolarisKeyClient, show: (code: String, address: String, qr: String) -> Unit): String {
    val session = client.identity.signIn.start(SignInOptions(deviceName = "Living-room PC"))
    // Show userCode large, verificationUri as the short address and the QR of
    // verificationUriComplete.
    show(session.userCode, session.verificationUri, session.verificationUriComplete)
    return try {
        when (session.wait()) {
            is SignInOutcome.SignedIn -> "Signed in as ${client.license.getLicenseUser()?.subject}"
            is SignInOutcome.Choose -> "Choose the license to use."
            SignInOutcome.Expired -> "The code expired. Start again."
            SignInOutcome.Cancelled -> "Sign-in cancelled."
            is SignInOutcome.Pending -> "Still waiting."
        }
    } catch (e: SignInError) {
        e.message ?: e.code
    }
}
```

`session.wait()` paces its polls and stops when its coroutine is canceled (`session.cancel()` ends the sign-in itself); when it answers `SignedIn`,
the token is stored and the first sync is done. `getLicenseUser()` is the pairwise subject only (it
ships after `0.9.3`); the person's name and email are planned. Anyone holding the code can finish
the sign-in elsewhere, so say who signed in. Sign-in needs the Identity service; with it off, every
call throws `service-unavailable` before any request. `client.deactivate()` signs this device out and
asks the server to stop counting it.

## Status, offline and refresh

`start()` and `status()` need no network. `events` carries a `PolarisEvent.License` with the gate after each transition that
goes through the client: an activation, a deactivation, a bundle import, and a sync that moved the
documents or the gate (a revoke it saw, a block, grace or expiry as the clock moved). An unchanged
state is not emitted again, and nothing ticks between syncs, so read `status()` for the present.
`licenseState` holds the latest as a `StateFlow`, `null` until the first. `events` carries license,
config, update and pack changes to any number of collectors:

```kotlin
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

fun keepFresh(client: PolarisKeyClient, scope: CoroutineScope) {
    client.startRefresh() // a no-op unless refreshIntervalSeconds is set; start() already calls it
    scope.launch {
        client.events.collect { event ->
            when (event) {
                is PolarisEvent.License -> println(event.state.status)
                is PolarisEvent.Config -> println("settings changed")
                is PolarisEvent.UpdateAvailable -> println("an update is offered")
                is PolarisEvent.Packs -> Unit
                is PolarisEvent.Identity -> Unit
                is PolarisEvent.CloudSync -> Unit
            }
        }
    }
}
```

Polling is off until you set `refreshIntervalSeconds` on `PolarisKeyClientOptions`; a pass that
fails is tried again on the next tick. On Android, `PolarisKeyLifecycle.install(application, client)`
syncs when the app comes to the foreground, once a minute at most. A sync that fails offline leaves
the last verified documents in force until `graceUntil`; `client.storeStatus()` names the `backend`
that holds the token (`keystore`, `keyring` or `file`, the `0600` file) and, when that is weaker
than the platform's best, why. A machine with no network activates from a signed file:
`client.importBundle(jws)`.

On Android, a Compose screen of your own collects the same two flows:

```kotlin android
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import im.plrs.key.core.Copy
import im.plrs.key.core.isUsable
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map

@Composable
fun MyGate(client: PolarisKeyClient, content: @Composable () -> Unit) {
    val state by remember(client) {
        flow {
            emit(client.status()) // the gate now
            emitAll(client.events.filterIsInstance<PolarisEvent.License>().map { it.state }) // then every transition
        }
    }.collectAsState(null) // null until status() answers
    val current = state
    when {
        current == null -> CircularProgressIndicator()
        isUsable(current.status) -> content()
        else -> Column { Text(Copy.message(current.status.wire)) }
    }
}
```

## An update offer

```kotlin
import im.plrs.key.core.UpdateDecision
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.update.InstallResult

class UpdateNotice(val version: String?, val blocking: Boolean)

suspend fun updateNotice(client: PolarisKeyClient): UpdateNotice? =
    when (val d = client.update.decide().decision) {
        is UpdateDecision.Binary -> UpdateNotice(d.release.version, d.mandatory)
        is UpdateDecision.Store -> UpdateNotice(d.release.version, d.mandatory)
        is UpdateDecision.Platform -> UpdateNotice(d.release.version, d.mandatory)
        is UpdateDecision.CodeReady -> UpdateNotice(d.release.version, false)
        is UpdateDecision.Blocked -> UpdateNotice(null, true)
        else -> null // none, or packs
    }

suspend fun install(client: PolarisKeyClient): InstallResult =
    client.update.install(client.update.decide())
```

`decide()` needs the Update service and `UpdateClientOptions(pinnedReleaseKeys)`, which the
generated config carries. A mandatory answer or `Blocked` is a notice with no dismiss control over an
app that keeps running, never a window that covers it. `install` hands the decision to the platform's
installer: Play In-App Updates or a verified PackageInstaller session on Android, the verified
installer opened by the OS on a desktop.

## A command-line tool

A tool that draws its own output reads the same states. A script reads the JSON, never the words:

```kotlin
import com.acme.polaris.PolarisConfig
import im.plrs.key.core.Copy
import im.plrs.key.core.isUsable
import im.plrs.key.desktop.PolarisKeyDesktop
import kotlinx.coroutines.runBlocking
import kotlin.system.exitProcess

fun main(args: Array<String>): Unit = runBlocking {
    val client = PolarisKeyDesktop.create(PolarisConfig.clientOptions("1.4.2"))
    val status = client.status().status
    val usable = isUsable(status)
    println("""{"status":"${status.wire}","usable":$usable}""")
    if (!usable) System.err.println(Copy.message(status.wire))
    client.close()
    exitProcess(if (usable) 0 else 1)
}
```

The words are localised catalog sentences and may change between releases; the status codes do not.

## Compose Desktop

There is no Compose Desktop kit (it is planned), so this is a recipe: a window that gates its
content, with key entry, the refusal copy, Replace a device and sign-in. It is one file over the
desktop artifact, which brings the OS keyring. Add the feed as the
[quickstart](/docs/build/quickstart/kotlin/#1-install) shows.

```kts
// build.gradle.kts
plugins {
    kotlin("jvm") version "2.1.21"
    kotlin("plugin.compose") version "2.1.21"
    id("org.jetbrains.compose") version "1.8.2"
}

dependencies {
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation("im.plrs.key:polaris-key-desktop:0.9.3") // the SDK and the OS keyring
}

compose.desktop { application { mainClass = "MainKt" } }
```

```kotlin
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import com.acme.polaris.PolarisConfig
import im.plrs.key.core.Copy
import im.plrs.key.core.LicenseState
import im.plrs.key.core.ManageLink
import im.plrs.key.core.isUsable
import im.plrs.key.desktop.PolarisKeyDesktop
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.license.ActivationResult
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.launch
import java.awt.Desktop
import java.net.URI

fun main() = application {
    val client by produceState<PolarisKeyClient?>(null) {
        value = PolarisKeyDesktop.create(PolarisConfig.clientOptions("1.4.2"))
    }
    Window(onCloseRequest = { client?.close(); exitApplication() }, title = "Tidewater") {
        MaterialTheme {
            client?.let { PolarisGate(it) { Text("Licensed") } } ?: CircularProgressIndicator()
        }
    }
}

@Composable
fun PolarisGate(client: PolarisKeyClient, content: @Composable () -> Unit) {
    val state by produceState<LicenseState?>(null, client) {
        value = client.status()
        client.events.filterIsInstance<PolarisEvent.License>().collect { value = it.state }
    }
    // A desktop app has no foreground event: sync when the window regains focus.
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(focused) { if (focused) client.sync() }

    val current = state
    when {
        current == null -> CircularProgressIndicator()
        isUsable(current.status) -> content()
        else -> ActivationForm(client, Copy.message(current.status.wire))
    }
}

@Composable
fun ActivationForm(client: PolarisKeyClient, headline: String) {
    val scope = rememberCoroutineScope()
    var key by remember { mutableStateOf("") }
    var message by remember { mutableStateOf(headline) }
    var link by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        Text(message)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(key, { key = it }, label = { Text("License key") })
        Row {
            Button(onClick = {
                scope.launch {
                    val r = client.license.activateWithKey(key.trim())
                    link = (r as? ActivationResult.DeviceLimit)?.manageUrl
                        ?.let { ManageLink.withReturn(ManageLink.withKey(it, key.trim()), "tidewater://activated") }
                    if (r !is ActivationResult.Ok) message = Copy.activationMessage(r.code ?: "ok", code = r.code)
                }
            }) { Text("Activate") }
            link?.let { url -> Button(onClick = { Desktop.getDesktop().browse(URI(url)) }) { Text("Replace a device") } }
            Button(onClick = {
                scope.launch {
                    val session = client.identity.signIn.start(SignInOptions(deviceName = "Tidewater"))
                    message = "Enter ${session.userCode} at ${session.verificationUri}"
                    message = try {
                        when (session.wait()) {
                            is SignInOutcome.SignedIn -> "Signed in."
                            is SignInOutcome.Choose -> "Choose the license to use."
                            is SignInOutcome.Pending -> "Still waiting."
                            SignInOutcome.Cancelled -> "Sign-in cancelled."
                            SignInOutcome.Expired -> "The code expired."
                        }
                    } catch (e: SignInError) {
                        e.message ?: e.code
                    }
                }
            }) { Text("Sign in") }
        }
    }
}
```

`Copy.activationMessage` takes the result's `code` as its kind, so a `Refused` result reads its own
sentence when the catalog has one, as in [refusals](#first-activation-and-refusals). The return URL
must be a scheme the OS opens for your app.

## Tests

Every seam is an option: `store = InMemoryStore()`, `transport` for the network, `clock` for time
and `LicenseClientOptions(fingerprint = false)` to skip reading the machine. A `PolarisTransport` of
your own scripts a refusal against the real client:

```kotlin
import com.acme.polaris.PolarisConfig
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions

class DeviceLimitWorker : PolarisTransport {
    override suspend fun send(request: PolarisRequest) = PolarisResponse(
        status = 403,
        body = """{"error":"device_limit","limit":3,"deviceCount":3}""".toByteArray(),
    )
}

suspend fun deviceLimit(): ActivationResult {
    val client = PolarisKeyClient.create(
        PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = "acme",
                version = "1.0.0",
                pinnedKeys = PolarisConfig.pinnedKeys,
                store = InMemoryStore("acme"),
                transport = DeviceLimitWorker(),
                clock = { 1_700_000_000L },
            ),
            license = LicenseClientOptions(fingerprint = false),
        ),
    )
    return client.license.activateWithKey("pkey_acme_0000").also { client.close() }
}
```

`client.status(now)` takes the clock as an argument, so a test moves time without touching the
system clock. The SDK's own test doubles (a scripted Worker, a test signer) are planned; today
they live in the repository's test fixtures and are not published.
