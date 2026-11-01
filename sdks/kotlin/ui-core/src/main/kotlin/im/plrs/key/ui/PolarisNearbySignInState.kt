// @pkey-feature identity.nearby
// The Compose-free nearby sign-in state holder for the new device D (I-45.12; rung 5 of the automatic ladder, V5
// section 15.6.1). The person presses Sign in; before the code view the gate tries the people nearby: the pre-prompt
// where the platform asks first (macOS Local Network, D-A14), then "Approve on your other device" with the code to tap,
// then "Signed in as ..." to confirm.
//
// What it keeps:
//  - an approver that answers within `listenMillis` keeps it going; a lone one is chosen after `loneMillis`; several are
//    listed to pick from; none within the window hands over to the regular sign-in, as does a product or runtime with no
//    nearby sign-in, "Not now" and "Use a code instead";
//  - the account is shown for the person to confirm (rule 12): Continue confirms, "Not you?" declines and signs the
//    device out; leaving the screen by ANY other route ([cancel], [dismiss]) is the same as a decline, and the
//    session ending on its own (the 300 s deadline) leaves the screen; a confirm that fails leaves it too and is never
//    "signed in";
//  - the approver labels are display data from an unverified peer; the SDK has cleaned them.
@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "TooManyFunctions", "ReturnCount", "ComplexCondition", "SpreadOperator")

package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.identity.NearbyApprover
import im.plrs.key.identity.NearbyRole
import im.plrs.key.identity.NearbySignInOptions
import im.plrs.key.identity.NearbySignInSession
import im.plrs.key.identity.ShownIdentity
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What nearby sign-in shows. [Over] hands the person to the regular sign-in; [Idle] and [Done] draw nothing of their own. */
public sealed interface PolarisNearbyUi {
    public data object Idle : PolarisNearbyUi

    /** The platform asks before it looks (macOS Local Network; Android's local-network permission): Continue or Not now. */
    public data object Prompt : PolarisNearbyUi

    /** The first seconds: looking for an approver. */
    public data object Looking : PolarisNearbyUi

    /** Several approvers answered: the labels, in order, to pick from. */
    public data class Pick(val labels: List<String>) : PolarisNearbyUi

    /** The code to tap on the other device, and its name once one is chosen. */
    public data class Wait(val code: String, val device: String?) : PolarisNearbyUi

    /** The account the other device approved, for the person to confirm. [busy]: a Continue is in flight. */
    public data class Confirm(val identity: ShownIdentity?, val busy: Boolean = false) : PolarisNearbyUi

    /** The person is in. */
    public data object Done : PolarisNearbyUi

    /** Nearby has nothing more to show: the regular sign-in takes over. [failed] says why when it ended on an error or a lapse. */
    public data class Over(val failed: Boolean = false) : PolarisNearbyUi
}

/** One running nearby sign-in, as the state holder sees it. [PolarisKeyClient.nearbySignInActions] adapts the SDK's session. */
public interface PolarisNearbyRun {
    public val approvers: List<NearbyApprover>

    /** The person chose [id]: the code to show. */
    public suspend fun choose(id: String): String

    /** The paced poll; throws [SignInError] for a refusal. */
    public suspend fun wait(): SignInOutcome

    public val identity: ShownIdentity?

    /** Called once when the sign-in ended unconfirmed (a decline, the deadline). Returns the remover. */
    public fun onEnd(fn: () -> Unit): () -> Unit

    public suspend fun confirm()

    public suspend fun decline()

    public fun cancel()
}

/** The SDK calls nearby sign-in makes. */
public interface PolarisNearbyActions {
    /** Whether nearby sign-in can run here: the product serves it and this runtime can discover devices. Never throws. */
    public suspend fun available(): Boolean

    /** Whether the platform asks before looking (the pre-prompt screen). */
    public suspend fun promptNeeded(): Boolean = false

    /** The person pressed Continue on the pre-prompt: ask the platform for what it needs. False hands over. */
    public suspend fun allow(): Boolean = true

    /** `nearby/start` and the LAN request. Throws what the SDK throws. */
    public suspend fun start(): PolarisNearbyRun
}

private class SessionRun(private val s: NearbySignInSession) : PolarisNearbyRun {
    override val approvers: List<NearbyApprover> get() = s.approvers

    override suspend fun choose(id: String): String = s.choose(id).code

    override suspend fun wait(): SignInOutcome = s.wait()

    override val identity: ShownIdentity? get() = s.identity

    override fun onEnd(fn: () -> Unit): () -> Unit = s.onEnd(fn)

    override suspend fun confirm() = s.confirmAccount()

    override suspend fun decline() = s.declineAccount()

    override fun cancel() = s.cancel()
}

/** The umbrella client as nearby sign-in actions. [deviceName] is the label the approver is shown. */
public fun PolarisKeyClient.nearbySignInActions(deviceName: String? = null): PolarisNearbyActions {
    val client = this
    return object : PolarisNearbyActions {
        override suspend fun available(): Boolean = client.identity.nearby.available(NearbyRole.Requester)

        override suspend fun promptNeeded(): Boolean = nearbyPromptNeeded(client)

        override suspend fun start(): PolarisNearbyRun =
            SessionRun(client.identity.signIn.startNearby(NearbySignInOptions(deviceName))).also { markBrowsed(client.core.store.stateDirectory) }
    }
}

/** macOS asks the person before an app browses the network, and nothing has browsed here yet (D-A14): the pre-prompt. */
private suspend fun nearbyPromptNeeded(client: PolarisKeyClient): Boolean {
    if (!System.getProperty("os.name").orEmpty().lowercase().startsWith("mac")) return false
    val dir = client.core.store.stateDirectory ?: return true
    return !java.io.File(dir, "nearby-browsed").exists()
}

/** Remember that a browse worked here (macOS: the Local Network prompt has been answered). */
private fun markBrowsed(dir: java.io.File?) {
    if (dir == null) return
    runCatching {
        dir.mkdirs()
        java.io.File(dir, "nearby-browsed").writeText("1")
    }
}

/**
 * The nearby sign-in state holder. [begin] starts it when the person presses Sign in; hold it where it outlives a
 * renderer. [onSignedIn] runs once after the person confirmed the account (the SDK has stored the sign-in); the gate
 * re-reads the licence.
 */
public class PolarisNearbySignInState(
    private val actions: PolarisNearbyActions,
    private val scope: CoroutineScope,
    private val onSignedIn: () -> Unit = {},
    private val listenMillis: Long = LISTEN_MILLIS,
    private val loneMillis: Long = LONE_MILLIS,
    private val tickMillis: Long = TICK_MILLIS,
) {
    private val _ui = MutableStateFlow<PolarisNearbyUi>(PolarisNearbyUi.Idle)
    public val ui: StateFlow<PolarisNearbyUi> = _ui.asStateFlow()

    private val lock = Any()
    private var run: PolarisNearbyRun? = null
    private var job: Job? = null
    private var waiting: Job? = null
    private var chosen = false
    private var removeEnd: (() -> Unit)? = null

    /** Press Sign in: try the people nearby first. Does nothing while a run is on screen. */
    public fun begin() {
        synchronized(lock) {
            if (job?.isActive == true || run != null || _ui.value is PolarisNearbyUi.Confirm || _ui.value is PolarisNearbyUi.Prompt) return
            _ui.value = PolarisNearbyUi.Looking
        }
        job = scope.launch {
            if (!guarded { actions.available() }.let { it == true }) return@launch over()
            if (guarded { actions.promptNeeded() } == true) {
                _ui.value = PolarisNearbyUi.Prompt
                return@launch
            }
            run()
        }
    }

    /** Continue on the pre-prompt. */
    public fun continuePrompt() {
        if (_ui.value != PolarisNearbyUi.Prompt) return
        _ui.value = PolarisNearbyUi.Looking
        job = scope.launch {
            if (guarded { actions.allow() } != true) return@launch over()
            run()
        }
    }

    /** "Not now" on the pre-prompt: the regular sign-in. */
    public fun notNow() {
        if (_ui.value == PolarisNearbyUi.Prompt) over()
    }

    /** "Use a code instead": give nearby up for the regular sign-in. */
    public fun useCode() {
        endRun()
        over()
    }

    /** The person tapped the numbered approver of [PolarisNearbyUi.Pick] (0-based). */
    public fun pick(index: Int) {
        val r = run ?: return
        val found = r.approvers
        if (index in found.indices) scope.launch { choose(r, found[index]) }
    }

    /** Continue on the confirm screen: the account is the person's. */
    public fun confirm() {
        val now = _ui.value as? PolarisNearbyUi.Confirm ?: return
        val r = run ?: return
        if (now.busy) return
        _ui.value = now.copy(busy = true)
        scope.launch {
            try {
                r.confirm()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A confirm that fails leaves the screen and is never "signed in": the session has ended or the device is out.
                endRun()
                _ui.value = PolarisNearbyUi.Over(failed = true)
                return@launch
            }
            release()
            _ui.value = PolarisNearbyUi.Done
            onSignedIn()
        }
    }

    /** "Not you?": the account is not the person's; every held record is dropped and the device signs out. */
    public fun notYou() {
        val r = run ?: return over()
        scope.launch {
            guarded { r.decline() }
            release()
            over()
        }
    }

    /** Leaving the screen by any other route (Cancel, back, the window closing) is the same as declining. */
    public fun cancel() {
        endRun()
        if (_ui.value !is PolarisNearbyUi.Done) over()
    }

    /** Forget a finished or handed-over run so the next press of Sign in starts again. */
    public fun reset() {
        endRun()
        _ui.value = PolarisNearbyUi.Idle
    }

    private suspend fun run() {
        val started = try {
            actions.start()
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            // The product or the runtime has no nearby sign-in, or the Worker refused: the regular sign-in.
            return over(failed = e.code != ErrorCode.serviceUnavailable && e.code != ErrorCode.nearbyUnsupported)
        } catch (e: Exception) {
            return over(failed = true)
        }
        synchronized(lock) {
            run = started
            chosen = false
            removeEnd = started.onEnd { onSessionEnded() }
        }
        _ui.value = PolarisNearbyUi.Looking
        waiting = scope.launch { settle(started) }
        look(started)
    }

    /** Every [tickMillis]: what the approvers do (see the file comment). */
    private suspend fun look(r: PolarisNearbyRun) {
        var elapsed = 0L
        var lone = 0L
        var shown: List<String> = emptyList()
        while (synchronized(lock) { run === r && !chosen }) {
            val found = r.approvers
            when {
                found.isEmpty() && elapsed >= listenMillis -> {
                    endRun()
                    return over()
                }

                found.size == 1 -> {
                    lone += tickMillis
                    if (lone >= loneMillis) return choose(r, found[0])
                }

                else -> lone = 0
            }
            val labels = found.map { it.label ?: it.platform }
            if (labels != shown) {
                shown = labels
                _ui.value = if (labels.isEmpty()) PolarisNearbyUi.Looking else PolarisNearbyUi.Pick(labels)
            }
            delay(tickMillis)
            elapsed += tickMillis
        }
    }

    private suspend fun choose(r: PolarisNearbyRun, who: NearbyApprover) {
        synchronized(lock) {
            if (run !== r || chosen) return
            chosen = true
        }
        val code = try {
            r.choose(who.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // That approver is gone (or one is already chosen): look again.
            synchronized(lock) { chosen = false }
            return
        }
        _ui.value = PolarisNearbyUi.Wait(code, who.label)
    }

    /** The poll's say: a sign-in to confirm, or the end of nearby. */
    private suspend fun settle(r: PolarisNearbyRun) {
        val outcome = try {
            r.wait()
        } catch (e: CancellationException) {
            throw e
        } catch (e: SignInError) {
            null
        } catch (e: Exception) {
            null
        }
        if (synchronized(lock) { run !== r }) return
        when (outcome) {
            is SignInOutcome.SignedIn -> _ui.value = PolarisNearbyUi.Confirm(r.identity)

            SignInOutcome.Cancelled -> Unit

            else -> {
                endRun()
                over(failed = true)
            }
        }
    }

    /** The SDK ended the sign-in on its own (the confirm screen's deadline, a decline from elsewhere): the screen leaves. */
    private fun onSessionEnded() {
        if (_ui.value is PolarisNearbyUi.Done) return
        synchronized(lock) { run = null }
        _ui.value = PolarisNearbyUi.Over(failed = true)
    }

    private fun over(failed: Boolean = false) {
        _ui.value = PolarisNearbyUi.Over(failed)
    }

    /** Stop the run: the SDK cancels (before the confirmation that signs the device out). Idempotent. */
    private fun endRun() {
        val r: PolarisNearbyRun?
        synchronized(lock) {
            r = run
            run = null
            chosen = false
        }
        removeEnd?.invoke()
        removeEnd = null
        job?.cancel()
        waiting?.cancel()
        r?.cancel()
    }

    /** The confirmed run is finished with: nothing to cancel any more. */
    private fun release() {
        synchronized(lock) { run = null }
        removeEnd?.invoke()
        removeEnd = null
        waiting?.cancel()
    }

    private suspend fun <T> guarded(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    public companion object {
        /** An approver that answers within this keeps nearby going; none hands over to the regular sign-in. */
        public const val LISTEN_MILLIS: Long = 2_000

        /** A lone approver is chosen after this. */
        public const val LONE_MILLIS: Long = 3_000
        public const val TICK_MILLIS: Long = 200
    }
}

// ── The kit's inputs for each step ───────────────────────────────────────────────────────────

private fun nearbyStep(step: String, vararg extra: Pair<String, JsonPrimitive>): KitInputs = KitInputs.of(
    mapOf(
        "signIn" to JsonObject(
            mapOf("presentation" to JsonPrimitive("inline"), "replace" to JsonPrimitive("inline"), "channel" to JsonPrimitive("browser")),
        ),
        "autoSignIn" to JsonObject(mapOf("step" to JsonPrimitive(step)) + extra),
    ),
)

/** The pre-prompt (`nearby-prompt`). */
public fun nearbyPromptInputs(): KitInputs = nearbyStep("nearby-prompt")

/** The code to tap (`nearby-wait`); [device] names the chosen approver. */
public fun nearbyWaitInputs(code: String, device: String?): KitInputs =
    nearbyStep("nearby-wait", *listOfNotNull("code" to JsonPrimitive(code), device?.let { "device" to JsonPrimitive(it) }).toTypedArray())

/** The account to confirm (`nearby-done`): the email the account shows, else its name. */
public fun nearbyDoneInputs(identity: ShownIdentity?): KitInputs =
    nearbyStep("nearby-done", "email" to JsonPrimitive(identity?.email ?: identity?.name ?: ""))
