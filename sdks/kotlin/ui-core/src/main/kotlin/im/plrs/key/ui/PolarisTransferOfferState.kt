// @pkey-feature connect.transfer
// The Compose-free state holder behind TransferOffer (CC-19.10; WIRE-CONTRACT-V5 section 15.11, D-8): a contact offers to send
// something, and nothing is received until the person presses Accept. Ask, then receiving, then done or failed.
//
// What it keeps:
//  - consent per transfer: [accept] and [decline] each answer the host's offer once, a second answer is ignored;
//  - the contact's label and the name it chose are text the contact picked: they are display data, never proof of who is sending;
//  - [cancel] stops a transfer in flight and it ends as failed, nothing kept; a late result from the SDK is dropped.
@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "TooManyFunctions", "LongParameterList")

package im.plrs.key.ui

import im.plrs.key.sdk.CloudTransfer
import im.plrs.key.sdk.OfferDecision
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.TransferOffer
import im.plrs.key.sdk.TransferOutcome
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** The SDK calls the offer prompt makes. */
public interface PolarisTransferOfferActions {
    /** Accept: returns when everything arrived and was saved; throws when it did not. */
    public suspend fun accept()

    /** Decline: nothing is received. */
    public suspend fun decline()

    /** Stop a transfer in flight. */
    public suspend fun cancel() {}
}

/** Where the offer prompt is, by the UI matrix's `TransferOffer` step names; [Closed] draws nothing. */
public enum class PolarisTransferOfferStep(public val id: String) {
    Ask("ask"),
    Receiving("receiving"),
    Done("done"),
    Failed("failed"),
    Closed("closed"),
}

/** What the offer prompt shows. [name] and [device] are text the contact chose. */
public data class PolarisTransferOfferUi(
    public val step: PolarisTransferOfferStep,
    public val name: String,
    public val device: String? = null,
    public val size: Long? = null,
    public val type: String? = null,
)

/** One offer's state holder. */
public class PolarisTransferOfferState(
    private val actions: PolarisTransferOfferActions,
    name: String,
    device: String? = null,
    size: Long? = null,
    type: String? = null,
    private val scope: CoroutineScope,
    private val onClosed: () -> Unit = {},
) {
    private val _ui = MutableStateFlow(
        PolarisTransferOfferUi(PolarisTransferOfferStep.Ask, name, device?.takeIf { it.isNotBlank() }, size, type?.takeIf { it.isNotBlank() }),
    )
    public val ui: StateFlow<PolarisTransferOfferUi> = _ui.asStateFlow()

    private val lock = Any()
    private var answered = false

    /** Accept the offer. Answered once: a second press does nothing. */
    public fun accept() {
        synchronized(lock) {
            if (answered || _ui.value.step != PolarisTransferOfferStep.Ask) return
            answered = true
        }
        _ui.value = _ui.value.copy(step = PolarisTransferOfferStep.Receiving)
        scope.launch {
            try {
                actions.accept()
                settle(PolarisTransferOfferStep.Done)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                settle(PolarisTransferOfferStep.Failed)
            }
        }
    }

    /** Decline the offer, and close. */
    public fun decline() {
        synchronized(lock) {
            if (answered || _ui.value.step != PolarisTransferOfferStep.Ask) return
            answered = true
        }
        _ui.value = _ui.value.copy(step = PolarisTransferOfferStep.Closed)
        scope.launch { runCatching { actions.decline() } }
        onClosed()
    }

    /** The contact (or the SDK's own clock) withdrew the offer before it was answered: the prompt goes, nothing is sent. */
    internal fun withdrawn() {
        synchronized(lock) {
            if (answered || _ui.value.step != PolarisTransferOfferStep.Ask) return
            answered = true
        }
        _ui.value = _ui.value.copy(step = PolarisTransferOfferStep.Closed)
        onClosed()
    }

    /** Stop the transfer in flight: it ends as failed, nothing kept. */
    public fun cancel() {
        if (!settle(PolarisTransferOfferStep.Failed)) return
        scope.launch { runCatching { actions.cancel() } }
    }

    /** Done: close the prompt. */
    public fun close() {
        if (_ui.value.step == PolarisTransferOfferStep.Closed) return
        _ui.value = _ui.value.copy(step = PolarisTransferOfferStep.Closed)
        onClosed()
    }

    /** Move a receiving transfer to [step]; false when it was not receiving (a late answer is dropped). */
    private fun settle(step: PolarisTransferOfferStep): Boolean = synchronized(lock) {
        if (_ui.value.step != PolarisTransferOfferStep.Receiving) return@synchronized false
        _ui.value = _ui.value.copy(step = step)
        true
    }

    public companion object {
        /** The kit's inputs for [ui] (the UI matrix's `TransferOffer`), or null once closed: the prompt is hidden. */
        public fun inputsFor(ui: PolarisTransferOfferUi): KitInputs? = transferOfferInputs(ui)
    }
}

/** The inputs of one `TransferOffer` step; null for [PolarisTransferOfferStep.Closed]. */
public fun transferOfferInputs(ui: PolarisTransferOfferUi): KitInputs? {
    if (ui.step == PolarisTransferOfferStep.Closed) return null
    val members = buildMap<String, JsonElement> {
        put("step", JsonPrimitive(ui.step.id))
        put("name", JsonPrimitive(ui.name))
        ui.device?.let { put("device", JsonPrimitive(it)) }
        ui.size?.let { put("size", JsonPrimitive(it)) }
        ui.type?.let { put("type", JsonPrimitive(it)) }
    }
    return KitInputs.of(mapOf("transferOffer" to JsonObject(members)))
}

/**
 * Offers from contacts, one prompt at a time. Bind it with [PolarisKeyClient.transferOffers]; draw [current] with
 * `PolarisTransferOffer`. An offer that arrives while one is on screen waits behind it and shows when the first closes.
 */
public class PolarisTransferOffers internal constructor() {
    private val _current = MutableStateFlow<PolarisTransferOfferState?>(null)

    /** The prompt on screen, or null. */
    public val current: StateFlow<PolarisTransferOfferState?> = _current.asStateFlow()

    private val lock = Any()
    private val waiting = ArrayDeque<PolarisTransferOfferState>()

    internal fun present(state: PolarisTransferOfferState) {
        synchronized(lock) { waiting.addLast(state) }
        advance()
    }

    /** Show the next waiting offer when none is on screen. */
    internal fun advance() {
        synchronized(lock) {
            val shown = _current.value
            if (shown != null && shown.ui.value.step != PolarisTransferOfferStep.Closed) return
            var next = waiting.removeFirstOrNull()
            // An offer withdrawn while it waited is not shown.
            while (next != null && next.ui.value.step == PolarisTransferOfferStep.Closed) next = waiting.removeFirstOrNull()
            _current.value = next
        }
    }
}

/**
 * Bind Direct Transfer to the kit: every offer goes to a prompt (D-8, consent per transfer) and nothing is written until the
 * person presses Accept. [destination] picks the file an accepted offer is written to; it must not exist yet. The SDK declines
 * on its own after 120 seconds unanswered, and an offer withdrawn meanwhile closes its prompt.
 */
public fun PolarisKeyClient.transferOffers(scope: CoroutineScope, destination: (id: String, name: String?) -> File): PolarisTransferOffers {
    val host = PolarisTransferOffers()
    val transfer = cloudConnect.transfer
    val results = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
    transfer.onResult { r ->
        if (r.incoming) results.remove(r.id)?.complete(r.outcome == TransferOutcome.delivered)
    }
    transfer.onOffer { offer ->
        val state = PolarisTransferOfferState(
            SdkTransferOffer(transfer, offer, destination, results),
            name = offer.name.orEmpty(),
            device = offer.peer.contact?.label,
            size = offer.size,
            type = offer.type,
            scope = scope,
            onClosed = host::advance,
        )
        // The peer withdrew it, or the SDK's own clock declined it: the prompt goes.
        offer.onWithdrawn { state.withdrawn() }
        host.present(state)
        OfferDecision.Ask
    }
    return host
}

private class SdkTransferOffer(
    private val transfer: CloudTransfer,
    private val offer: TransferOffer,
    private val destination: (String, String?) -> File,
    private val results: ConcurrentHashMap<String, CompletableDeferred<Boolean>>,
) : PolarisTransferOfferActions {
    override suspend fun accept() {
        val done = CompletableDeferred<Boolean>()
        results[offer.id] = done
        try {
            offer.accept(destination(offer.id, offer.name))
        } catch (e: Throwable) {
            results.remove(offer.id)
            throw e
        }
        check(done.await()) { "The transfer did not arrive." }
    }

    override suspend fun decline() = offer.decline()

    override suspend fun cancel() {
        results.remove(offer.id)?.complete(false)
        transfer.cancel(offer.peer, offer.id)
    }
}
