// The Compose-free boot state holder. Renderers map this state to progress, gate, consent and
// stop screens while every Kotlin UI host shares :core's stage machine and :sdk's driver.
package im.plrs.key.ui

import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootStage
import im.plrs.key.core.BootState
import im.plrs.key.core.BootTransition
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.initialBootState
import im.plrs.key.sdk.BootDriver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The boot as renderers present it: the machine's state and what its emits reported. */
public data class PolarisBootUi(
    val state: BootState = initialBootState(),
    /** The license status the gate is waiting on (stage gate, outcome waiting). */
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
        public val fraction: Float? get() = if (total <= 0) null else (done.toFloat() / total).coerceIn(0f, 1f)
    }

    public val stage: BootStage get() = state.stage

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

/** Each stage's work (`im.plrs.key.sdk.PolarisBootHost`); `client.bootHost()` is one over the umbrella client. */
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
     * until a retry (or the license becoming usable, for the gate) moves the machine on; returns at
     * `ready`.
     */
    public fun launch(scope: CoroutineScope, host: PolarisBootHost): Job = driver.launch(scope, host)
}
