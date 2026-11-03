// @pkey-feature connect.links
// The Compose-free state holder behind LinkPairing (CC-19.10; WIRE-CONTRACT-V5 section 15.10), the Kotlin twin of ui-core's
// LinkPairingModel: open, then code, confirm, and linked or failed (unavailable: links are off for the product).
//
// What it keeps:
//  - one device at a time: a second device that reaches the code while one is on screen is declined, not left waiting;
//  - [confirm] waits for the other person; [decline] closes that session and the window stays open for the next device;
//    [cancel] closes the window;
//  - a failure of a session the person never saw (no code was shown) changes nothing on screen;
//  - an epoch is bumped whenever a window ends, so a late callback from an old window is dropped.
@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "TooManyFunctions")

package im.plrs.key.ui

import im.plrs.key.sdk.LinkOffer
import im.plrs.key.sdk.LinkPairHandle
import im.plrs.key.sdk.LinkPairOptions
import im.plrs.key.sdk.LinksDisabledException
import im.plrs.key.sdk.PairFailureReason
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A nearby device at the code stage. [label] is what that device calls itself (unauthenticated display data). */
public interface PolarisLinkOffer {
    public val label: String?
    public val code: String
    public val categories: List<String>

    public suspend fun confirm()

    public suspend fun decline()
}

/** The open pairing window. */
public interface PolarisLinkWindow {
    public suspend fun stop()
}

/** Why a session that reached the code ended without a link. */
public enum class PolarisLinkFailure(public val id: String) {
    Declined("declined"),
    Timeout("timeout"),
    Full("full"),
    Closed("closed"),
}

/** The SDK calls the pairing screen makes. [PolarisKeyClient.linkPairingActions] adapts `cloudConnect.links.pair`. */
public interface PolarisLinkPairingActions {
    /** Open the window; throws what the SDK throws (the typed N/A while links are off, see [isUnavailable]). */
    public suspend fun pair(
        categories: List<String>,
        label: String?,
        seconds: Double?,
        onCode: (PolarisLinkOffer) -> Unit,
        onLinked: (label: String?, categories: List<String>) -> Unit,
        onFailed: (PolarisLinkFailure) -> Unit,
    ): PolarisLinkWindow

    /** True for the error that means links are off for this product (`connect_links_disabled`). */
    public fun isUnavailable(error: Throwable): Boolean
}

/** Where the pairing screen is, by the UI matrix's `LinkPairing` step names. */
public enum class PolarisLinkStep(public val id: String) {
    Idle("idle"),
    Open("open"),
    Code("code"),
    Confirm("confirm"),
    Linked("linked"),
    Failed("failed"),
    Unavailable("unavailable"),
}

/** What the pairing screen shows. */
public data class PolarisLinkPairingUi(
    public val step: PolarisLinkStep = PolarisLinkStep.Idle,
    /** What the other device calls itself; null when it gave no name. */
    public val device: String? = null,
    public val code: String? = null,
    public val categories: List<String> = emptyList(),
    public val reason: PolarisLinkFailure? = null,
)

/** The pairing window's state holder. [scope] runs the SDK calls; [cleanup] outlives a renderer and ends sessions. */
public class PolarisLinkPairingState(
    private val actions: PolarisLinkPairingActions,
    private val categories: List<String>,
    private val label: String? = null,
    private val seconds: Double? = null,
    private val scope: CoroutineScope,
    private val cleanup: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val _ui = MutableStateFlow(PolarisLinkPairingUi(categories = categories.toList()))
    public val ui: StateFlow<PolarisLinkPairingUi> = _ui.asStateFlow()

    private val lock = Any()
    private var epoch = 0
    private var offer: PolarisLinkOffer? = null
    private var window: PolarisLinkWindow? = null

    /** Open the pairing window (also Try again). */
    public fun start() {
        val (old, mine) = synchronized(lock) { end() to epoch }
        release(old.first, old.second)
        _ui.value = PolarisLinkPairingUi(PolarisLinkStep.Open, categories = categories.toList())
        scope.launch {
            val live = { synchronized(lock) { mine == epoch } }
            try {
                val opened = actions.pair(
                    categories, label, seconds,
                    onCode = { arrived -> onCode(mine, arrived) },
                    onLinked = { who, cats -> onLinked(mine, who, cats) },
                    onFailed = { why -> onFailed(mine, why) },
                )
                val stale = synchronized(lock) {
                    if (mine == epoch) {
                        window = opened
                        false
                    } else {
                        true
                    }
                }
                if (stale) cleanup.launch { runCatching { opened.stop() } }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (!live()) return@launch
                val off = actions.isUnavailable(e)
                _ui.value = PolarisLinkPairingUi(
                    if (off) PolarisLinkStep.Unavailable else PolarisLinkStep.Failed,
                    categories = categories.toList(),
                    reason = if (off) null else PolarisLinkFailure.Closed,
                )
            }
        }
    }

    private fun onCode(mine: Int, arrived: PolarisLinkOffer) {
        val declined = synchronized(lock) {
            if (mine != epoch) return
            if (offer != null) {
                true
            } else {
                offer = arrived
                false
            }
        }
        if (declined) {
            cleanup.launch { runCatching { arrived.decline() } }
            return
        }
        _ui.value = PolarisLinkPairingUi(
            PolarisLinkStep.Code,
            device = arrived.label?.takeIf { it.isNotBlank() },
            code = arrived.code,
            categories = categories.toList(),
        )
    }

    private fun onLinked(mine: Int, who: String?, cats: List<String>) {
        synchronized(lock) {
            if (mine != epoch) return
            offer = null
        }
        _ui.value = PolarisLinkPairingUi(PolarisLinkStep.Linked, device = who?.takeIf { it.isNotBlank() }, categories = cats.toList())
    }

    private fun onFailed(mine: Int, why: PolarisLinkFailure) {
        synchronized(lock) {
            // A session nobody saw (no code shown) fails silently.
            if (mine != epoch || offer == null) return
            offer = null
        }
        _ui.value = PolarisLinkPairingUi(PolarisLinkStep.Failed, categories = categories.toList(), reason = why)
    }

    /** Codes match: confirm on this device. The link is made when the other person does too. */
    public fun confirm() {
        val (current, shown) = synchronized(lock) { offer to _ui.value }
        if (current == null || shown.step != PolarisLinkStep.Code) return
        _ui.value = shown.copy(step = PolarisLinkStep.Confirm)
        scope.launch {
            try {
                current.confirm()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // The window ended meanwhile (the session is no longer ours): nothing to show.
                val ours = synchronized(lock) { (offer === current).also { if (it) offer = null } }
                if (ours) {
                    _ui.value = PolarisLinkPairingUi(PolarisLinkStep.Failed, categories = categories.toList(), reason = PolarisLinkFailure.Closed)
                }
            }
        }
    }

    /** Not a match: close that session; the window stays open for the next device. */
    public fun decline() {
        val current = synchronized(lock) {
            val shown = _ui.value
            if (offer == null || shown.step != PolarisLinkStep.Code) return
            offer.also { offer = null }
        } ?: return
        _ui.value = PolarisLinkPairingUi(PolarisLinkStep.Open, categories = categories.toList())
        cleanup.launch { runCatching { current.decline() } }
    }

    /** Close the window and let go of any session (Cancel, and Done on any outcome). */
    public fun cancel() {
        val (declined, stopped) = synchronized(lock) { end() }
        _ui.value = PolarisLinkPairingUi(PolarisLinkStep.Idle, categories = categories.toList())
        release(declined, stopped)
    }

    private fun release(declined: PolarisLinkOffer?, stopped: PolarisLinkWindow?) {
        if (declined == null && stopped == null) return
        cleanup.launch {
            withContext(NonCancellable) {
                declined?.let { runCatching { it.decline() } }
                stopped?.let { runCatching { it.stop() } }
            }
        }
    }

    /** Bump the epoch and take the session and the window; the caller holds [lock]. */
    private fun end(): Pair<PolarisLinkOffer?, PolarisLinkWindow?> {
        epoch++
        val result = offer to window
        offer = null
        window = null
        return result
    }

    public companion object {
        /** The kit's inputs for [ui] (the UI matrix's `LinkPairing`), or null while idle: the screen is hidden. */
        public fun inputsFor(ui: PolarisLinkPairingUi): KitInputs? = linkPairingInputs(ui)
    }
}

/** The inputs of one `LinkPairing` step; null for [PolarisLinkStep.Idle]. */
public fun linkPairingInputs(ui: PolarisLinkPairingUi): KitInputs? {
    if (ui.step == PolarisLinkStep.Idle) return null
    val members = buildMap<String, JsonElement> {
        put("step", JsonPrimitive(ui.step.id))
        put("categories", JsonArray(ui.categories.map(::JsonPrimitive)))
        ui.device?.let { put("device", JsonPrimitive(it)) }
        ui.code?.let { put("code", JsonPrimitive(it)) }
        ui.reason?.let { put("reason", JsonPrimitive(it.id)) }
    }
    return KitInputs.of(mapOf("linkPairing" to JsonObject(members)))
}

private class SdkOffer(private val offer: LinkOffer) : PolarisLinkOffer {
    override val label: String? get() = offer.label
    override val code: String get() = offer.code
    override val categories: List<String> get() = offer.categories

    override suspend fun confirm() = offer.confirm()

    override suspend fun decline() = offer.decline()
}

/** The umbrella client as pairing actions: `cloudConnect.links.pair`. [label] names this device to the other one (never an account id). */
public fun PolarisKeyClient.linkPairingActions(): PolarisLinkPairingActions {
    val client = this
    return object : PolarisLinkPairingActions {
        override suspend fun pair(
            categories: List<String>,
            label: String?,
            seconds: Double?,
            onCode: (PolarisLinkOffer) -> Unit,
            onLinked: (label: String?, categories: List<String>) -> Unit,
            onFailed: (PolarisLinkFailure) -> Unit,
        ): PolarisLinkWindow {
            val options = LinkPairOptions(
                categories = categories,
                onCode = { onCode(SdkOffer(it)) },
                label = label,
                onLinked = { onLinked(it.label, it.categories) },
                onFailed = {
                    onFailed(
                        when (it.reason) {
                            PairFailureReason.Declined -> PolarisLinkFailure.Declined
                            PairFailureReason.Timeout -> PolarisLinkFailure.Timeout
                            PairFailureReason.Full -> PolarisLinkFailure.Full
                            PairFailureReason.Closed -> PolarisLinkFailure.Closed
                        },
                    )
                },
                seconds = seconds ?: im.plrs.key.sdk.LINK_PAIR_WINDOW_SECONDS,
            )
            val handle: LinkPairHandle = client.cloudConnect.links.pair(options)
            return object : PolarisLinkWindow {
                override suspend fun stop() = handle.stop()
            }
        }

        override fun isUnavailable(error: Throwable): Boolean = error is LinksDisabledException
    }
}
