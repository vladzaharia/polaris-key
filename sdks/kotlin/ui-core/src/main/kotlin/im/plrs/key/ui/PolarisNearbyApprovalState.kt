// @pkey-feature identity.nearby
// The Compose-free state holder for the approving device M (I-45.13; V5 section 15.6.1): "Approve a nearby device" in the account
// menu opens it. While it is open the device advertises; each session that reaches the code stage becomes an ask with the three
// codes, and the person taps the one the other device shows. A matched code sends the approval; a licence choice follows where the
// account has more than one; every outcome has a title and one way on.
//
// What it keeps:
//  - the codes are the only way to approve: there is no "Approve" control, and Deny is the other way out;
//  - leaving the ask or the licence choice by ANY route ([close], the window closing) answers Deny; the advert stops with the screen;
//  - one licence is one click ([choose]); the licences are the account's free seats, at most nine, and "create" where offered;
//  - a second ask waits behind the first (the SDK hands over one at a time) and shows when the first is done;
//  - the labels are display data from an unverified peer: the SDK has cleaned them, and they are never proof of who is asking.
@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "TooManyFunctions", "ReturnCount", "ComplexCondition")

package im.plrs.key.ui

import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.stringValue
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.NearbyApprovalStep
import im.plrs.key.identity.NearbyAsk
import im.plrs.key.identity.NearbyAskHandler
import im.plrs.key.identity.NearbyRole
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** One licence the account can run the new device on: its id, and the name to show. */
public data class PolarisApprovalRow(val id: String, val name: String)

/** What the approver screen shows. [Closed] and [Unavailable] draw nothing of their own. */
public sealed interface PolarisApprovalUi {
    public data object Closed : PolarisApprovalUi

    /** Nothing nearby can be approved here: the product serves no nearby approval, or this runtime cannot discover devices. */
    public data object Unavailable : PolarisApprovalUi

    /** Advertising; waiting for a device to ask. */
    public data object Listening : PolarisApprovalUi

    /** The three codes; the person taps the one the other device shows. [device] is what that device calls itself. */
    public data class Ask(val device: String?, val codes: List<String>) : PolarisApprovalUi

    /** A tap is being answered. */
    public data class Working(val device: String?) : PolarisApprovalUi

    /** One tap per licence ([rows], the free seats); [canCreate] adds "create". Deny leaves. */
    public data class Choose(val device: String?, val rows: List<PolarisApprovalRow>, val canCreate: Boolean) : PolarisApprovalUi

    /** An outcome, by the UI matrix's `NearbyApproval` step name (`approved`, `not-nearby`, `mismatch`, `denied`, `expired`, ...). */
    public data class Result(val step: String, val device: String?) : PolarisApprovalUi
}

/** Where a tap ended: a result, or a licence to choose. */
public sealed interface PolarisApprovalOutcome {
    public data class Done(val step: String) : PolarisApprovalOutcome

    public class NeedsLicense(
        public val rows: List<PolarisApprovalRow>,
        public val canCreate: Boolean,
        private val onChoose: suspend (String?) -> PolarisApprovalOutcome,
        private val onCancel: suspend () -> PolarisApprovalOutcome,
    ) : PolarisApprovalOutcome {
        /** Approve with licence [id], or a new one when null. */
        public suspend fun choose(id: String?): PolarisApprovalOutcome = onChoose(id)

        public suspend fun cancel(): PolarisApprovalOutcome = onCancel()
    }
}

/** One session asking for approval, as the state holder sees it. [PolarisKeyClient.nearbyApprovalActions] adapts the SDK's. */
public interface PolarisApprovalAsk {
    public val device: String?
    public val codes: List<String>

    public suspend fun pick(code: String): PolarisApprovalOutcome

    public suspend fun deny(): PolarisApprovalOutcome
}

/** A running approver. */
public interface PolarisApprovalHandle {
    public suspend fun stop()
}

/** The SDK calls the approving device makes. */
public interface PolarisApprovalActions {
    /** Whether nearby approval can run here: the product serves it, this runtime can discover devices and the device is signed in. Never throws. */
    public suspend fun available(): Boolean

    /** Advertise (the prompt is open) and call [onAsk] with each session that reaches the code stage. Throws what the SDK throws. */
    public suspend fun listen(onAsk: (PolarisApprovalAsk) -> Unit): PolarisApprovalHandle
}

private fun stepName(s: NearbyApprovalStep): String = when (s) {
    is NearbyApprovalStep.Approved -> "approved"
    NearbyApprovalStep.Mismatch -> "mismatch"
    NearbyApprovalStep.NotNearby -> "not-nearby"
    NearbyApprovalStep.Denied -> "denied"
    NearbyApprovalStep.Expired -> "expired"
    NearbyApprovalStep.DeviceLimit -> "device-limit"
    NearbyApprovalStep.AccountRequired -> "account-required"
    is NearbyApprovalStep.RateLimited -> "rate-limited"
    is NearbyApprovalStep.Choose -> "choose"
}

private const val MAX_ROWS = 9

private fun outcomeOf(s: NearbyApprovalStep): PolarisApprovalOutcome {
    if (s !is NearbyApprovalStep.Choose) return PolarisApprovalOutcome.Done(stepName(s))
    val free = s.choices.choices.filter { it["state"].stringValue == "free" }.take(MAX_ROWS)
    val rows = free.mapNotNull { c ->
        val id = c["id"].stringValue ?: return@mapNotNull null
        PolarisApprovalRow(id, (c["name"].stringValue ?: c["tierName"].stringValue).orEmpty())
    }
    val create = s.choices.raw["create"].let { it != null && it !is JsonNull }
    return PolarisApprovalOutcome.NeedsLicense(
        rows,
        create,
        onChoose = { id -> outcomeOf(s.choose(if (id == null) LicenseChoice.Create else LicenseChoice.License(id))) },
        onCancel = { outcomeOf(s.cancel()) },
    )
}

private class SdkAsk(private val ask: NearbyAsk) : PolarisApprovalAsk {
    override val device: String? get() = ask.device
    override val codes: List<String> get() = ask.codes

    override suspend fun pick(code: String): PolarisApprovalOutcome = outcomeOf(ask.pick(code))

    override suspend fun deny(): PolarisApprovalOutcome = outcomeOf(ask.deny())
}

/** The umbrella client as nearby approval actions. [label] is this device's name shown on the other device (never an account id). */
public fun PolarisKeyClient.nearbyApprovalActions(label: String? = null): PolarisApprovalActions {
    val client = this
    return object : PolarisApprovalActions {
        override suspend fun available(): Boolean = client.core.token() != null && client.identity.nearby.available(NearbyRole.Approver)

        override suspend fun listen(onAsk: (PolarisApprovalAsk) -> Unit): PolarisApprovalHandle {
            val h = client.identity.nearby.onRequest(NearbyAskHandler { onAsk(SdkAsk(it)) }, NearbyApproverOptions(prompt = true, label = label))
            return object : PolarisApprovalHandle {
                override suspend fun stop() = h.stop()
            }
        }
    }
}

/**
 * The approver state holder. [open] starts it when the person opens "Approve a nearby device"; [close] ends it however the
 * person leaves. [scope] runs the taps; the cleanup after [close] runs on [cleanup], which outlives a renderer.
 */
public class PolarisNearbyApprovalState(
    private val actions: PolarisApprovalActions,
    private val scope: CoroutineScope,
    private val onClose: () -> Unit = {},
    private val cleanup: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val _ui = MutableStateFlow<PolarisApprovalUi>(PolarisApprovalUi.Closed)
    public val ui: StateFlow<PolarisApprovalUi> = _ui.asStateFlow()

    private val lock = Any()
    private var handle: PolarisApprovalHandle? = null
    private var opened = false
    private var current: PolarisApprovalAsk? = null
    private var choosing: PolarisApprovalOutcome.NeedsLicense? = null
    private val waiting = ArrayDeque<PolarisApprovalAsk>()

    /** Whether the account menu offers the entry: nearby approval can run here. Reads the SDK; never throws. */
    public suspend fun available(): Boolean = try {
        actions.available()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        false
    }

    /** "Approve a nearby device" opens: advertise. Does nothing while it is open. */
    public fun open() {
        synchronized(lock) {
            if (opened) return
            opened = true
        }
        _ui.value = PolarisApprovalUi.Listening
        scope.launch {
            if (!available()) return@launch fail()
            val h = try {
                actions.listen { ask -> arrived(ask) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return@launch fail()
            }
            val stale = synchronized(lock) {
                if (opened) {
                    handle = h
                    false
                } else {
                    true
                }
            }
            if (stale) cleanup.launch { runCatching { h.stop() } }
        }
    }

    private fun fail() {
        synchronized(lock) { opened = false }
        _ui.value = PolarisApprovalUi.Unavailable
    }

    private fun arrived(ask: PolarisApprovalAsk) {
        synchronized(lock) {
            if (!opened) return
            waiting.addLast(ask)
        }
        advance()
    }

    /** Show the next waiting ask when none is on screen. */
    private fun advance() {
        val next = synchronized(lock) {
            if (!opened || current != null) return
            waiting.removeFirstOrNull()?.also { current = it }
        } ?: return
        _ui.value = PolarisApprovalUi.Ask(next.device, next.codes)
    }

    /** The person tapped the numbered code of [PolarisApprovalUi.Ask] (0-based). */
    public fun pick(index: Int) {
        val shown = _ui.value as? PolarisApprovalUi.Ask ?: return
        val ask = synchronized(lock) { current } ?: return
        if (index !in shown.codes.indices) return
        _ui.value = PolarisApprovalUi.Working(shown.device)
        scope.launch { settle(ask, shown.device) { ask.pick(shown.codes[index]) } }
    }

    /** One tap on licence [index] of [PolarisApprovalUi.Choose] (0-based). */
    public fun choose(index: Int) {
        val shown = _ui.value as? PolarisApprovalUi.Choose ?: return
        val step = synchronized(lock) { choosing } ?: return
        val row = shown.rows.getOrNull(index) ?: return
        answerChoice(shown.device) { step.choose(row.id) }
    }

    /** "Create" on [PolarisApprovalUi.Choose], where offered. */
    public fun createLicense() {
        val shown = _ui.value as? PolarisApprovalUi.Choose ?: return
        val step = synchronized(lock) { choosing } ?: return
        if (shown.canCreate) answerChoice(shown.device) { step.choose(null) }
    }

    private fun answerChoice(device: String?, call: suspend () -> PolarisApprovalOutcome) {
        val ask = synchronized(lock) { current.also { choosing = null } } ?: return
        _ui.value = PolarisApprovalUi.Working(device)
        scope.launch { settle(ask, device, call) }
    }

    /** Deny: "None of these match" at the ask, or leaving the licence choice. */
    public fun deny() {
        val ui = _ui.value
        val ask = synchronized(lock) { current } ?: return
        when (ui) {
            is PolarisApprovalUi.Ask -> {
                _ui.value = PolarisApprovalUi.Working(ui.device)
                scope.launch { settle(ask, ui.device) { ask.deny() } }
            }

            is PolarisApprovalUi.Choose -> {
                val step = synchronized(lock) { choosing.also { choosing = null } } ?: return
                _ui.value = PolarisApprovalUi.Working(ui.device)
                scope.launch { settle(ask, ui.device) { step.cancel() } }
            }

            else -> Unit
        }
    }

    private suspend fun settle(ask: PolarisApprovalAsk, device: String?, call: suspend () -> PolarisApprovalOutcome) {
        val outcome = try {
            call()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            PolarisApprovalOutcome.Done("expired")
        }
        if (synchronized(lock) { current !== ask }) return
        when (outcome) {
            is PolarisApprovalOutcome.Done -> _ui.value = PolarisApprovalUi.Result(outcome.step, device)

            is PolarisApprovalOutcome.NeedsLicense -> {
                synchronized(lock) { choosing = outcome }
                _ui.value = PolarisApprovalUi.Choose(device, outcome.rows, outcome.canCreate)
            }
        }
    }

    /** Done on an outcome: the next waiting ask, or the screen closes. */
    public fun done() {
        if (_ui.value !is PolarisApprovalUi.Result && _ui.value !is PolarisApprovalUi.Unavailable) return
        val more = synchronized(lock) {
            current = null
            choosing = null
            waiting.isNotEmpty()
        }
        if (more) advance() else close()
    }

    /** Leaving the screen by any route: the ask or the licence choice on screen is denied, the advert stops, the screen closes. */
    public fun close() {
        val ui = _ui.value
        val (h, asks, step) = synchronized(lock) {
            if (!opened && ui == PolarisApprovalUi.Closed) return
            opened = false
            // The ask on screen and the ones waiting never matched a code: denying them closes the session and sends nothing.
            val unanswered = (if (ui is PolarisApprovalUi.Ask) listOfNotNull(current) else emptyList()) + waiting.toList()
            val out = Triple(handle, unanswered, if (ui is PolarisApprovalUi.Choose) choosing else null)
            handle = null
            current = null
            choosing = null
            waiting.clear()
            out
        }
        _ui.value = PolarisApprovalUi.Closed
        cleanup.launch {
            withContext(NonCancellable) {
                // A licence choice that is left answers Deny (the code matched).
                step?.let { runCatching { it.cancel() } }
                for (a in asks) runCatching { a.deny() }
                h?.let { runCatching { it.stop() } }
            }
        }
        onClose()
    }

    /** The kit's inputs for [ui]'s step (the UI matrix's `NearbyApproval`). */
    public companion object {
        public fun inputsFor(ui: PolarisApprovalUi): KitInputs? {
            val (step, device) = when (ui) {
                is PolarisApprovalUi.Ask -> "ask" to ui.device
                is PolarisApprovalUi.Choose -> "choose" to ui.device
                is PolarisApprovalUi.Result -> ui.step to ui.device
                else -> return null
            }
            return nearbyApprovalInputs(step, device)
        }
    }
}

/** The inputs of one `NearbyApproval` step; [device] is what the other device calls itself. */
public fun nearbyApprovalInputs(step: String, device: String?): KitInputs = KitInputs.of(
    mapOf(
        "nearbyApproval" to JsonObject(
            buildMap {
                put("step", kotlinx.serialization.json.JsonPrimitive(step))
                device?.takeIf { it.isNotBlank() }?.let { put("device", kotlinx.serialization.json.JsonPrimitive(it)) }
            },
        ),
    ),
)
