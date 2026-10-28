// The wiring behind PolarisKeyGate (SP-K06, notes/SDK-PARITY-PASS.md §2.5, §3.4; renamed in UK-09b.3):
//
//   setContent { PolarisKeyGate(client) { App() } }
//
// PolarisKeyGate (PolarisKeyGate.kt) composes the kit's existing pieces, unchanged: the boot shell over
// `client.bootHost()` (guard, sync, gate, decide, pack fetch, mount, launch confirmation), the gate
// for its activation stop, pack progress, and the update sheet or card (the banner only for "Restart to finish") over `client.updateActions()` (a
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

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import im.plrs.key.core.BootOptions
import im.plrs.key.core.LicenseState
import im.plrs.key.core.PresentationSource
import im.plrs.key.sdk.bootHost
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement

/** The client PolarisKeyGate (or PolarisKeyProvider) provides; null outside one. */
public val LocalPolarisKey: androidx.compose.runtime.ProvidableCompositionLocal<PolarisKeyClient?> =
    staticCompositionLocalOf { null }

/** Provide [client] to [content] (PolarisKeyGate does this itself). */
@Composable
public fun PolarisKeyProvider(client: PolarisKeyClient, content: @Composable () -> Unit) {
    // A PolarisTheme above this gate has no client of its own: hand it the product's presentation.
    val sink = LocalPolarisPresentationSink.current
    SideEffect { sink?.value = client.presentationSource }
    CompositionLocalProvider(LocalPolarisKey provides client, content = content)
}

/** What a [PolarisTheme] provides so a gate inside it can fill the product presentation (name, icon, accent). */
internal val LocalPolarisPresentationSink = staticCompositionLocalOf<MutableState<PresentationSource?>?> { null }

/** The provided client; throws outside PolarisKeyGate or PolarisKeyProvider. */
@Composable
public fun polarisKey(): PolarisKeyClient =
    LocalPolarisKey.current ?: error("polarisKey() needs PolarisKeyGate or PolarisKeyProvider above it")

// The live helpers are cold flows collected with collectAsState: the first read, then every
// change. (Not produceState: the Compose lint run by AGP 8.6 reports ProduceStateDoesNotAssignValue
// on these producer lambdas even though they assign `value`.)

/** The licence state now and after every change (`client.events`); null until first read. */
@Composable
public fun rememberPolarisLicense(client: PolarisKeyClient = polarisKey()): State<LicenseState?> =
    remember(client) {
        flow {
            emit(client.status())
            emitAll(client.events.filterIsInstance<PolarisEvent.License>().map { it.state })
        }
    }.collectAsState(null)

/** Whether [name] is entitled now (false whenever the gate is not usable, S-19 G11), live. */
@Composable
public fun rememberPolarisEntitled(name: String, client: PolarisKeyClient = polarisKey()): State<Boolean> =
    remember(client, name) {
        flow {
            emit(client.entitlements.has(name))
            client.events.filterIsInstance<PolarisEvent.License>().collect { emit(client.entitlements.has(name)) }
        }
    }.collectAsState(false)

/** A config key's effective value, live (`client.config.setting(key).flow`: local overrides and new documents). */
@Composable
public fun rememberPolarisSetting(key: String, client: PolarisKeyClient = polarisKey()): State<JsonElement?> =
    remember(client, key) { flow { emitAll(client.config.setting(key).flow) } }.collectAsState(null)

/** The old name of [PolarisKeyGate], kept for one release. */
@Deprecated(
    "Renamed: PolarisKeyGate is the one-liner.",
    ReplaceWith("PolarisKeyGate(client, modifier, bootOptions, onSignIn, packs, signIn, onQuit, content = content)", "im.plrs.key.ui.PolarisKeyGate"),
)
@Composable
public fun PolarisKeyApp(
    client: PolarisKeyClient,
    modifier: Modifier = Modifier,
    bootOptions: BootOptions = BootOptions(),
    onSignIn: (() -> Unit)? = null,
    packs: Boolean = client.packs.configured,
    signIn: Boolean = false,
    onQuit: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    PolarisKeyGate(client, modifier, bootOptions, onSignIn, packs, signIn, onQuit, content = content)
}

/**
 * [PolarisKeyGate] over an update state the caller holds. The desktop window ([PolarisKeyWindow]) shows an
 * optional update in its own window, so it turns [optionalUpdateInDialog] off; a mandatory update is
 * always a dialog inside this window (UK-10.8, K3).
 */
@Composable
internal fun PolarisKeyAppHost(
    client: PolarisKeyClient,
    modifier: Modifier,
    bootOptions: BootOptions,
    onSignIn: (() -> Unit)?,
    packs: Boolean,
    signIn: Boolean,
    onQuit: (() -> Unit)?,
    update: PolarisUpdateState,
    updateActions: PolarisUpdateActions,
    optionalUpdateInDialog: Boolean,
    autoSignIn: Boolean = true,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val boot = remember(client, bootOptions) { PolarisBootState(bootOptions) }
    val gate = remember(client, autoSignIn) { PolarisGateState(client.gateActions(), scope, autoSignIn = autoSignIn) }
    val packState = remember(client, packs) { if (packs) PolarisPackProgressState(client.packProgressSource()) else null }
    // Inline sign-in re-reads the licence when it completes (the SDK has already synced).
    // Held outside the composition (keyed to the client), so an activity recreation keeps the code.
    val signInState = if (signIn && onSignIn == null) {
        rememberHeldSignIn(client, client.signInActions()) { scope.launch { gate.reload() } }
    } else {
        null
    }
    val prefs = rememberUpdatePrefs()
    remember(update, prefs) {
        update.skippedVersion = prefs.skippedVersion
        update.onSkip = prefs.saveSkipped
    }
    LaunchedEffect(client, bootOptions) {
        client.start()
        gate.start()
        update.follow(updateActions, this)
        // The facts load beside the boot, never inside the builder's scope (which would wait for them).
        val effects = this
        val host = withContext(Dispatchers.IO) {
            client.bootHost(onCheck = { check ->
                update.show(check)
                effects.launch { update.loadFacts(client) }
            })
        }
        boot.launch(this, host)
    }
    PolarisKeyProvider(client) {
        PolarisBoot(
            state = boot,
            modifier = modifier,
            gate = gate,
            packs = packState,
            onSignIn = onSignIn,
            onUpdate = { update.install(updateActions, scope, onQuit) },
            signIn = signInState,
        ) {
            val offer by update.offer.collectAsState()
            Column {
                // Restart to finish is the banner's; an offered version is the sheet or card's (decision 9).
                val restart = offer?.takeIf { it.kind == PolarisUpdateUi.Kind.Restart }
                restart?.let { ui ->
                    PolarisUpdateBanner(
                        ui,
                        onUpdate = { update.install(updateActions, scope, onQuit) },
                        onDismiss = if (ui.mandatory) null else update::dismiss,
                    )
                }
                // The banner draws under the status bar, so the content below must not pad for it twice.
                Box(if (restart != null) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier) { content() }
            }
            offer?.takeIf { it.kind == PolarisUpdateUi.Kind.Install && (optionalUpdateInDialog || it.mandatory) }?.let { ui ->
                PolarisUpdatePromptDialog(
                    ui,
                    onUpdate = { update.install(updateActions, scope, onQuit) },
                    onLater = update::dismiss,
                    onSkip = if (ui.mandatory) null else update::skip,
                )
            }
        }
    }
}
