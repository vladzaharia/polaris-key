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
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.BootTransition
import im.plrs.key.core.BootState
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.initialBootState
import im.plrs.key.sdk.BootDriver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** The boot as the screens render it: the machine's state and what its emits reported. */
public data class PolarisBootUi(
    val state: BootState = initialBootState(),
    /** The licence status the gate is waiting on (stage gate, outcome waiting). */
    val waiting: LicenseStatus? = null,
    val blocked: BootEmit.BlockedReason? = null,
    val errorCode: String? = null,
    /** A fetch waiting for the player's consent (stage fetch, outcome waiting). */
    val consent: Consent? = null,
    /** The latest fetch progress. */
    val progress: Progress? = null,
    /** The last update failed to start and the previous version was restored. */
    val rolledBack: Boolean = false,
    /** The decide stage found an optional update. */
    val updateAvailable: Boolean = false,
) {
    public data class Consent(val bytes: Long, val metered: Boolean)

    public data class Progress(val done: Long, val total: Long) {
        val fraction: Float? get() = if (total <= 0) null else (done.toFloat() / total).coerceIn(0f, 1f)
    }

    val stage: BootStage get() = state.stage

    /** Fold one transition in. */
    public fun reduce(transition: BootTransition): PolarisBootUi {
        var next = copy(state = transition.state)
        for (emit in transition.emits) {
            next = when (emit) {
                is BootEmit.StageChanged -> when {
                    emit.previous == BootStage.gate -> next.copy(waiting = null)
                    emit.previous == BootStage.fetch -> next.copy(consent = null, progress = null)
                    emit.previous == BootStage.blocked -> next.copy(blocked = null)
                    emit.previous == BootStage.error -> next.copy(errorCode = null)
                    else -> next
                }
                is BootEmit.Waiting -> next.copy(waiting = emit.status)
                is BootEmit.Blocked -> next.copy(blocked = emit.reason)
                is BootEmit.Error -> next.copy(errorCode = emit.code)
                is BootEmit.Offline -> next
                is BootEmit.ConsentNeeded -> next.copy(consent = Consent(emit.bytes, emit.metered))
                is BootEmit.FetchProgress -> next.copy(consent = null, progress = Progress(emit.done, emit.total))
                BootEmit.BootRolledBack -> next.copy(rolledBack = true)
                BootEmit.UpdateAvailable -> next.copy(updateAvailable = true)
                BootEmit.BootReady -> next
            }
        }
        return next
    }
}

/** What a fetch reports back while it runs (`im.plrs.key.sdk.PolarisFetchReporter`). */
public typealias PolarisFetchReporter = im.plrs.key.sdk.PolarisFetchReporter

/** Each stage's work (`im.plrs.key.sdk.PolarisBootHost`); `client.bootHost()` in :sdk is one over the umbrella client. */
public typealias PolarisBootHost = im.plrs.key.sdk.PolarisBootHost

/** The boot state holder: :sdk's [BootDriver] with every transition folded into [ui]. */
public class PolarisBootState(options: BootOptions = BootOptions()) {
    private val _ui = MutableStateFlow(PolarisBootUi(state = initialBootState(options)))
    public val ui: StateFlow<PolarisBootUi> = _ui.asStateFlow()
    private val driver = BootDriver(options) { transition -> _ui.value = _ui.value.reduce(transition) }

    /** Send [event] to the machine; answers the emits (empty when the event was ignored). */
    public fun send(event: BootEvent): List<BootEmit> = driver.send(event)

    /** Answer a pending consent request (the consent card's buttons). */
    public fun answerConsent(accept: Boolean): Unit = driver.answerConsent(accept)

    /** Retry from a stop or a waiting gate. */
    public fun retry(): Unit = driver.retry()

    /** Continue offline from a playable offline stop. */
    public fun playOffline(): Unit = driver.playOffline()

    /**
     * Run the boot with [host] in [scope] (`BootDriver.launch`): start the machine and, at every
     * working stage, do that stage's work and send its result. Waits at stops and at a waiting gate
     * until a retry (or the licence becoming usable, for the gate) moves the machine on; returns at
     * `ready`.
     */
    public fun launch(scope: CoroutineScope, host: PolarisBootHost): Job = driver.launch(scope, host)
}

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
            BootScreen.Progress -> PolarisProgressScreen(copy.bootStageLabel(ui.stage))
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
                )
            }
            BootScreen.Consent -> {
                val consent = ui.consent ?: PolarisBootUi.Consent(0, false)
                PolarisMessageScreen(PolarisMessageCopy(copy.consentTitle, copy.consentMessage(consent.bytes, consent.metered), PolarisMessageKind.Info)) {
                    PolarisPrimaryButton(copy.consentDownload, onClick = { onConsent(true) })
                    PolarisTextButton(copy.consentLater, onClick = { onConsent(false) })
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
                        PolarisPrimaryButton(copy.updateNow, onUpdate)
                        PolarisTextButton(copy.retry, onRetry)
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
