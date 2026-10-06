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

package im.plrs.key.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import im.plrs.key.core.BootOptions
import im.plrs.key.core.LicenseState
import im.plrs.key.sdk.PolarisKeyClient
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

/** The licence state now and after every change (`client.licenseChanges`); null until first read. */
@Composable
public fun rememberPolarisLicense(client: PolarisKeyClient = polarisKey()): State<LicenseState?> =
    produceState<LicenseState?>(null, client) {
        value = client.status()
        client.licenseChanges.collect { value = it }
    }

/** Whether [name] is entitled now (false whenever the gate is not usable, S-19 G11), live. */
@Composable
public fun rememberPolarisEntitled(name: String, client: PolarisKeyClient = polarisKey()): State<Boolean> {
    val license by rememberPolarisLicense(client)
    return produceState(false, client, name, license) { value = client.license.isEntitled(name) }
}

/** A config key's effective value, live (`client.config.setting(key)`: local overrides and new documents). */
@Composable
public fun rememberPolarisSetting(key: String, client: PolarisKeyClient = polarisKey()): State<JsonElement?> =
    produceState<JsonElement?>(null, client, key) {
        client.config.setting(key).collect { value = it }
    }

/**
 * The whole kit wired to [client]: boot (with the gate, pack progress and the update banner) and
 * then [content]. [onSignIn] starts sign-in from the activation screen (null hides the button);
 * [packs] shows per-pack progress during the boot fetch.
 */
@Composable
public fun PolarisKeyApp(
    client: PolarisKeyClient,
    modifier: Modifier = Modifier,
    bootOptions: BootOptions = BootOptions(),
    onSignIn: (() -> Unit)? = null,
    packs: Boolean = client.packs.configured,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val update = remember(client) { PolarisUpdateState() }
    val updateActions = remember(client) { client.updateActions() }
    val boot = remember(client, bootOptions) { PolarisBootState(bootOptions) }
    val gate = remember(client) { PolarisGateState(client.gateActions(), scope) }
    val packState = remember(client, packs) { if (packs) PolarisPackProgressState(client.packProgressSource()) else null }
    LaunchedEffect(client, bootOptions) {
        gate.start()
        update.follow(updateActions, this)
        boot.launch(this, client.bootHost(onCheck = update::show))
    }
    PolarisKeyProvider(client) {
        PolarisBoot(
            state = boot,
            modifier = modifier,
            gate = gate,
            packs = packState,
            onSignIn = onSignIn,
            onUpdate = { update.install(updateActions, scope) },
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
