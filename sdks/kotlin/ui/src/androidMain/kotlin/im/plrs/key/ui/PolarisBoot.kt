// PolarisBoot: the boot shell. It drives :core's shared stage machine (`ui.stages`, bootTransition:
// idle → shell → guard → sync → gate → decide → fetch → mount → ready, and the offline, blocked and
// error stops) and renders every stage in place, cross-fading between screens rather than
// navigating: a labelled progress view while a stage works, the gate or activation screen while
// the licence waits, the consent card and pack progress during a fetch, and a message with Try
// again at a stop. At `ready` it renders the product.
//
// PolarisBootState is the state holder: the machine's state plus what its emits said (the waiting
// status, the blocked reason, the error code, the consent request, the fetch progress, a rollback),
// folded by a pure reducer (PolarisBootUi.reduce). A host either sends events itself (`send`) as
// its own work finishes, or hands a PolarisBootHost to `launch`, which runs each stage's work and
// sends the result. The loop is :sdk's BootDriver (SP-20), the same one `client.boot()` runs on the
// JVM; PolarisKeyClient.bootHost() (also :sdk) is a host over the umbrella client.

package im.plrs.key.ui

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/**
 * The boot shell over [state]. Renders each stage in place and [content] once the boot is ready.
 *
 * @param gate the gate's state holder, so a waiting gate shows the real activation form; when it
 *   reports a usable licence the boot retries on its own. Null shows the gate's message with Try
 *   again.
 * @param packs pack progress for the fetch stage; null shows the overall fetch progress.
 * @param onSignIn starts sign-in from the activation screen; null hides the button unless
 *   [signIn] is given.
 * @param signIn runs sign-in inside the gate (the one sign-in form), see [PolarisGate].
 * @param onUpdate opens the update (the store, the installer) from an update-required stop.
 */
@Composable
public fun PolarisBoot(
    state: PolarisBootState,
    modifier: Modifier = Modifier,
    gate: PolarisGateState? = null,
    packs: PolarisPackProgressState? = null,
    onSignIn: (() -> Unit)? = null,
    onUpdate: (() -> Unit)? = null,
    signIn: PolarisSignInState? = null,
    content: @Composable () -> Unit,
) {
    val ui by state.ui.collectAsState()
    if (gate != null) {
        val gateUi by gate.gate.collectAsState()
        val usable = gateUi.license?.status?.let { im.plrs.key.core.isUsable(it) } == true
        LaunchedEffect(usable, ui.waiting) { if (usable && ui.waiting != null) state.retry() }
    }
    if (packs != null) {
        androidx.compose.runtime.DisposableEffect(packs) {
            packs.start()
            onDispose { packs.stop() }
        }
    }
    val packUi = packs?.ui?.collectAsState()?.value
    PolarisBootScreen(
        ui = ui,
        modifier = modifier,
        gateUi = gate?.gate?.collectAsState()?.value,
        activation = gate?.activation?.collectAsState()?.value,
        packs = packUi,
        onKeyChange = { gate?.onKeyChange(it) },
        onActivate = { gate?.activate() },
        onSignIn = onSignIn,
        onRetry = state::retry,
        onPlayOffline = state::playOffline,
        onConsent = state::answerConsent,
        onUpdate = onUpdate,
        signIn = signIn,
        content = content,
    )
}

/** Which screen a boot state shows. */
internal enum class BootScreen { Progress, Gate, Consent, Fetch, Offline, Blocked, Error, Content }

internal fun bootScreen(ui: PolarisBootUi): BootScreen = when (ui.state.stage) {
    BootStage.ready, BootStage.background -> BootScreen.Content
    BootStage.gate -> if (ui.state.outcome == BootOutcome.waiting) BootScreen.Gate else BootScreen.Progress
    BootStage.fetch -> when {
        ui.state.outcome == BootOutcome.waiting && ui.consent != null -> BootScreen.Consent
        ui.progress != null -> BootScreen.Fetch
        else -> BootScreen.Progress
    }
    BootStage.offline -> BootScreen.Offline
    BootStage.blocked -> BootScreen.Blocked
    BootStage.error -> BootScreen.Error
    else -> BootScreen.Progress
}

/** The stateless boot shell over its UI values. */
@Composable
public fun PolarisBootScreen(
    ui: PolarisBootUi,
    modifier: Modifier = Modifier,
    gateUi: PolarisGateUi? = null,
    activation: PolarisActivationUi? = null,
    packs: PolarisPackProgressUi? = null,
    onKeyChange: (String) -> Unit = {},
    onActivate: () -> Unit = {},
    onSignIn: (() -> Unit)? = null,
    onRetry: () -> Unit = {},
    onPlayOffline: () -> Unit = {},
    onConsent: (Boolean) -> Unit = {},
    onUpdate: (() -> Unit)? = null,
    signIn: PolarisSignInState? = null,
    content: @Composable () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    Crossfade(targetState = bootScreen(ui), modifier = modifier, label = "PolarisBoot") { screen ->
        when (screen) {
            BootScreen.Progress -> PolarisBootSkeleton(copy.bootStageLabel(ui.stage))
            BootScreen.Gate -> {
                val waiting = ui.waiting ?: LicenseStatus.needsActivation
                // The boot's waiting status wins over a stale gate read.
                val shown = (gateUi ?: PolarisGateUi()).let { g ->
                    if (g.license?.status == waiting) g else g.copy(license = (g.license ?: LicenseState(waiting)).copy(status = waiting))
                }
                PolarisGateScreen(
                    gate = shown,
                    activation = activation ?: PolarisActivationUi(),
                    onKeyChange = onKeyChange,
                    onActivate = onActivate,
                    onSignIn = onSignIn,
                    onRetry = onRetry,
                    manageAsQr = isTelevision(),
                    signIn = signIn,
                    onUpdate = onUpdate,
                )
            }
            BootScreen.Consent -> {
                val consent = ui.consent ?: PolarisBootUi.Consent(0, false)
                PolarisMessageScreen(PolarisMessageCopy(copy.consentTitle, copy.consentMessage(consent.bytes, consent.metered), PolarisMessageKind.Info)) {
                    PolarisPrimaryButton(copy.consentDownload, onClick = { onConsent(true) })
                    PolarisSecondaryButton(copy.consentLater, onClick = { onConsent(false) })
                }
            }
            BootScreen.Fetch ->
                if (packs != null && packs.packs.isNotEmpty()) PolarisPackProgressScreen(packs)
                else PolarisProgressScreen(copy.bootFetching, progress = ui.progress?.fraction)
            BootScreen.Offline -> PolarisMessageScreen(copy.offlineMessage(ui.state.canPlayOffline)) {
                PolarisPrimaryButton(copy.retry, onRetry)
                if (ui.state.canPlayOffline) PolarisSecondaryButton(copy.playOffline, onPlayOffline)
            }
            BootScreen.Blocked -> {
                val reason = ui.blocked ?: BootEmit.BlockedReason.notAvailable
                PolarisMessageScreen(copy.blockedMessage(reason)) {
                    if (reason == BootEmit.BlockedReason.updateRequired && onUpdate != null) {
                        PolarisPrimaryButton(copy.updateAction, onUpdate)
                        PolarisSecondaryButton(copy.retry, onRetry)
                    } else {
                        PolarisPrimaryButton(copy.retry, onRetry)
                    }
                }
            }
            BootScreen.Error -> PolarisMessageScreen(copy.errorMessage(ui.errorCode ?: ErrorCode.unknown)) {
                PolarisPrimaryButton(copy.retry, onRetry)
            }
            BootScreen.Content -> Column(Modifier.fillMaxSize()) {
                var showRollback by rememberSaveable(ui.rolledBack) { mutableStateOf(ui.rolledBack) }
                if (showRollback) {
                    PolarisInfoBanner(
                        text = copy.bootRolledBack,
                        onDismiss = { showRollback = false },
                        modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)),
                    )
                }
                Box(Modifier.weight(1f)) { content() }
            }
        }
    }
}

/** A dismissible information banner (the rollback notice). */
@Composable
public fun PolarisInfoBanner(text: String, modifier: Modifier = Modifier, onDismiss: (() -> Unit)? = null) {
    val scheme = MaterialTheme.colorScheme
    Surface(modifier = modifier.fillMaxWidth(), color = scheme.secondaryContainer, contentColor = scheme.onSecondaryContainer) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Row(
                modifier = Modifier
                    .widthIn(max = PolarisMaxContentWidth * 1.5f)
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Info, contentDescription = null, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(12.dp))
                Text(
                    text,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f).padding(vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                )
                if (onDismiss != null) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = PolarisTheme.copy.close) }
                }
            }
        }
    }
}
