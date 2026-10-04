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
// sends the result. PolarisKeyClient.bootHost() is a host over the umbrella client.

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
import im.plrs.key.core.BootState
import im.plrs.key.core.BootTransition
import im.plrs.key.core.DocOutcome
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.bootTransition
import im.plrs.key.core.initialBootState
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

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

/** What a fetch reports back while it runs. */
public interface PolarisFetchReporter {
    /** Bytes fetched so far of the total. */
    public fun progress(done: Long, total: Long)

    /** Ask the player before fetching [bytes]; true to go ahead. Suspends until they answer. */
    public suspend fun consent(bytes: Long, metered: Boolean): Boolean
}

/** Each stage's work. Every method has the do-nothing answer by default except [sync] and [gate]. */
public interface PolarisBootHost {
    public suspend fun shell() {}
    public suspend fun guard(): BootEvent.GuardResult = BootEvent.GuardResult.ok
    public suspend fun sync(): BootEvent.SyncResult
    public suspend fun gate(): LicenseStatus
    public suspend fun decide(): BootEvent.Decision = BootEvent.Decision.none

    /** Fetch what the boot needs; answers the result and the pack ids installed afterwards. */
    public suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> =
        BootEvent.FetchResult.ok to emptyList()

    public suspend fun mount() {}
}

/**
 * The umbrella client as a boot host: sync is `client.sync()` (offline when every document the
 * product runs failed, or the call threw), the gate is `client.status()`, and decide asks the
 * update client when it is configured (an update client without options decides nothing). Fetch
 * and mount are the product's; pass [fetch] and [mount] to do them here.
 */
public fun PolarisKeyClient.bootHost(
    decide: Boolean = true,
    fetch: (suspend (PolarisFetchReporter) -> Pair<BootEvent.FetchResult, List<String>>)? = null,
    mount: (suspend () -> Unit)? = null,
): PolarisBootHost {
    val client = this
    return object : PolarisBootHost {
        override suspend fun sync(): BootEvent.SyncResult {
            val result = try {
                client.sync()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return BootEvent.SyncResult.offline
            }
            val ran = result.documents.values.filter { it != DocOutcome.Skipped }
            return if (ran.isNotEmpty() && ran.all { it == DocOutcome.Error }) BootEvent.SyncResult.offline else BootEvent.SyncResult.ok
        }

        override suspend fun gate(): LicenseStatus = client.status().status

        override suspend fun decide(): BootEvent.Decision {
            if (!decide) return BootEvent.Decision.none
            return try {
                client.update.decide().boot
            } catch (e: CancellationException) {
                throw e
            } catch (e: PolarisException) {
                BootEvent.Decision.none
            }
        }

        override suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> =
            fetch?.invoke(reporter) ?: (BootEvent.FetchResult.ok to emptyList())

        override suspend fun mount() {
            mount?.invoke()
        }
    }
}

/** The boot state holder. */
public class PolarisBootState(options: BootOptions = BootOptions()) {
    private val _ui = MutableStateFlow(PolarisBootUi(state = initialBootState(options)))
    public val ui: StateFlow<PolarisBootUi> = _ui.asStateFlow()
    private var consentAnswer: CompletableDeferred<Boolean>? = null

    /** Send [event] to the machine; answers the emits (empty when the event was ignored). */
    @Synchronized
    public fun send(event: BootEvent): List<BootEmit> {
        val transition = bootTransition(_ui.value.state, event)
        if (transition.emits.isEmpty()) return emptyList()
        _ui.value = _ui.value.reduce(transition)
        return transition.emits
    }

    /** Answer a pending consent request (the consent card's buttons). */
    public fun answerConsent(accept: Boolean) {
        consentAnswer?.complete(accept)
    }

    /** Retry from a stop or a waiting gate. */
    public fun retry() {
        send(BootEvent.Retry)
    }

    /** Continue offline from a playable offline stop. */
    public fun playOffline() {
        send(BootEvent.PlayOffline)
    }

    /**
     * Run the boot with [host] in [scope]: start the machine and, at every working stage, do that
     * stage's work and send its result. Waits at stops and at a waiting gate until a retry (or the
     * licence becoming usable, for the gate) moves the machine on; returns at `ready`.
     */
    public fun launch(scope: CoroutineScope, host: PolarisBootHost): Job = scope.launch {
        send(BootEvent.Start)
        while (isActive) {
            val ui = _ui.value
            val state = ui.state
            if (state.stage == BootStage.ready || state.stage == BootStage.background) return@launch
            if (state.outcome != BootOutcome.running) {
                _ui.first { it.state != state }
                continue
            }
            val event = try {
                work(state.stage, host)
            } catch (e: CancellationException) {
                throw e
            } catch (e: PolarisException) {
                BootEvent.Fail(e.code)
            } catch (e: Exception) {
                BootEvent.Fail(ErrorCode.internalError)
            } ?: return@launch
            if (send(event).isEmpty()) _ui.first { it.state != state }
        }
    }

    private suspend fun work(stage: BootStage, host: PolarisBootHost): BootEvent? = when (stage) {
        BootStage.idle -> BootEvent.Start
        BootStage.shell -> {
            host.shell()
            BootEvent.ShellDone
        }
        BootStage.guard -> BootEvent.GuardDone(host.guard())
        BootStage.sync -> BootEvent.SyncDone(host.sync())
        BootStage.gate -> BootEvent.GateStatus(host.gate())
        BootStage.decide -> BootEvent.DecideDone(host.decide())
        BootStage.fetch -> {
            val (result, installed) = host.fetch(reporter)
            BootEvent.FetchDone(result, installed)
        }
        BootStage.mount -> {
            host.mount()
            BootEvent.MountDone
        }
        BootStage.ready, BootStage.background, BootStage.offline, BootStage.blocked, BootStage.error -> null
    }

    private val reporter = object : PolarisFetchReporter {
        override fun progress(done: Long, total: Long) {
            send(BootEvent.FetchProgress(done, total))
        }

        override suspend fun consent(bytes: Long, metered: Boolean): Boolean {
            val answer = CompletableDeferred<Boolean>()
            consentAnswer = answer
            if (send(BootEvent.FetchConsent(bytes, metered)).isEmpty()) return true
            val accepted = answer.await()
            consentAnswer = null
            // Back to running: the fetch goes ahead from zero.
            if (accepted) send(BootEvent.FetchProgress(0, bytes))
            return accepted
        }
    }
}

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/**
 * The boot shell over [state]. Renders each stage in place and [content] once the boot is ready.
 *
 * @param gate the gate's state holder, so a waiting gate shows the real activation form; when it
 *   reports a usable licence the boot retries on its own. Null shows the gate's message with Try
 *   again.
 * @param packs pack progress for the fetch stage; null shows the overall fetch progress.
 * @param onSignIn starts sign-in from the activation screen; null hides the button.
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
