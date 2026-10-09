// One-call wiring for a Compose app (SP-K06, notes/SDK-PARITY-PASS.md §2.5, §3.4):
//
//   setContent { PolarisKeyApp(client) { App() } }
//
// PolarisKeyApp composes the kit's existing pieces, unchanged: the boot shell over
// `client.bootHost()` (guard, sync, gate, decide, pack fetch, mount, launch confirmation), the gate
// for its activation stop, pack progress, and the update banner over `client.updateActions()` (a
// Play flexible update's progress and "Restart to finish" included). It also provides the client
// to the tree through LocalPolarisKey, so screens read it with polarisKey() and the remember*
// helpers instead of threading it through every composable.
//
// It adds no look of its own: every screen is the kit's, and restyling the kit belongs to the UI-kit
// program (docs/design/UI-KITS.md).
//
// SP-50: it starts the client before anything else reads it (`client.start()`, once and main-safe),
// and builds the boot host off the main thread (the default boot guard checks for update slots on disk).

package im.plrs.key.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import im.plrs.key.core.BootOptions
import im.plrs.key.core.LicenseState
import im.plrs.key.sdk.bootHost
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement

/** The client PolarisKeyApp (or PolarisKeyProvider) provides; null outside one. */
public val LocalPolarisKey: androidx.compose.runtime.ProvidableCompositionLocal<PolarisKeyClient?> =
    staticCompositionLocalOf { null }

/** Provide [client] to [content] (PolarisKeyApp does this itself). */
@Composable
public fun PolarisKeyProvider(client: PolarisKeyClient, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalPolarisKey provides client, content = content)
}

/** The provided client; throws outside PolarisKeyApp or PolarisKeyProvider. */
@Composable
public fun polarisKey(): PolarisKeyClient =
    LocalPolarisKey.current ?: error("polarisKey() needs PolarisKeyApp or PolarisKeyProvider above it")

// The live helpers are cold flows collected with collectAsState: the first read, then every
// change. (Not produceState: the Compose lint run by AGP 8.6 reports ProduceStateDoesNotAssignValue
// on these producer lambdas even though they assign `value`.)

/** The licence state now and after every change (`client.licenseChanges`); null until first read. */
@Composable
public fun rememberPolarisLicense(client: PolarisKeyClient = polarisKey()): State<LicenseState?> =
    remember(client) {
        flow {
            emit(client.status())
            emitAll(client.licenseChanges)
        }
    }.collectAsState(null)

/** Whether [name] is entitled now (false whenever the gate is not usable, S-19 G11), live. */
@Composable
public fun rememberPolarisEntitled(name: String, client: PolarisKeyClient = polarisKey()): State<Boolean> =
    remember(client, name) {
        flow {
            emit(client.license.isEntitled(name))
            client.licenseChanges.collect { emit(client.license.isEntitled(name)) }
        }
    }.collectAsState(false)

/** A config key's effective value, live (`client.config.setting(key)`: local overrides and new documents). */
@Composable
public fun rememberPolarisSetting(key: String, client: PolarisKeyClient = polarisKey()): State<JsonElement?> =
    remember(client, key) { flow { emitAll(client.config.setting(key)) } }.collectAsState(null)

/**
 * The whole kit wired to [client]: boot (with the gate, pack progress and the update banner) and
 * then [content]. [onSignIn] starts sign-in from the activation screen (null hides the button);
 * [signIn] runs the device-code sign-in inside the gate instead, whose "Use a license key instead"
 * and Cancel come back to the key field; [packs] shows per-pack progress during the boot fetch.
 */
@Composable
public fun PolarisKeyApp(
    client: PolarisKeyClient,
    modifier: Modifier = Modifier,
    bootOptions: BootOptions = BootOptions(),
    onSignIn: (() -> Unit)? = null,
    packs: Boolean = client.packs.configured,
    signIn: Boolean = false,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val update = remember(client) { PolarisUpdateState() }
    val updateActions = remember(client) { client.updateActions() }
    val boot = remember(client, bootOptions) { PolarisBootState(bootOptions) }
    val gate = remember(client) { PolarisGateState(client.gateActions(), scope) }
    val packState = remember(client, packs) { if (packs) PolarisPackProgressState(client.packProgressSource()) else null }
    // Inline sign-in re-reads the licence when it completes (the SDK has already synced).
    // Held outside the composition (keyed to the client), so an activity recreation keeps the code.
    val signInState = if (signIn && onSignIn == null) {
        rememberHeldSignIn(client, client.signInActions()) { scope.launch { gate.reload() } }
    } else {
        null
    }
    LaunchedEffect(client, bootOptions) {
        client.start()
        gate.start()
        update.follow(updateActions, this)
        boot.launch(this, withContext(Dispatchers.IO) { client.bootHost(onCheck = update::show) })
    }
    PolarisKeyProvider(client) {
        PolarisBoot(
            state = boot,
            modifier = modifier,
            gate = gate,
            packs = packState,
            onSignIn = onSignIn,
            onUpdate = { update.install(updateActions, scope) },
            signIn = signInState,
        ) {
            val offer by update.offer.collectAsState()
            Column {
                offer?.let { ui ->
                    PolarisUpdateBanner(
                        ui,
                        onUpdate = { update.install(updateActions, scope) },
                        onDismiss = if (ui.mandatory) null else update::dismiss,
                    )
                }
                content()
            }
        }
    }
}
