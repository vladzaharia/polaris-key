// @pkey-feature connect.local
// The narrow driver under Pair with a Code (CC-29K): what [PolarisLocalPairingState] and [PolarisPairedDevicesState] call, so a host
// binds `client.cloudConnect.localLinks` ([PolarisKeyClient.localLinksDriver]) and a test binds a fake. The reference is
// packages/ui-core/src/localPairingModel.ts (`LocalLinksLike`).
@file:Suppress("TooGenericExceptionCaught", "SwallowedException")

package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.sdk.LanErrorReason
import im.plrs.key.sdk.LanException
import im.plrs.key.sdk.LocalCode
import im.plrs.key.sdk.LocalJoinOptions
import im.plrs.key.sdk.LocalOffer
import im.plrs.key.sdk.LocalPairOptions
import im.plrs.key.sdk.LocalPairingException
import im.plrs.key.sdk.LocalPairingOffException
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException

/** A rejection, read by what a typed error carries: its registered code, the reason and the cap. */
public class PolarisLocalFailure(public val code: String, public val reason: String? = null, public val cap: String? = null) :
    Exception("$code${reason?.let { " ($it)" }.orEmpty()}") {
    override fun toString(): String = "PolarisLocalFailure($code)"
}

/** The code a shower shows now. [reason] is one of `opened`, `wrong-code`, `declined`, `timeout`, `closed` (`LocalCodeReason`). */
public data class PolarisLocalCode(val code: String, val qr: String, val reason: String, val expiresAt: Long)

/** The other device at consent. */
public interface PolarisLocalOffer {
    public val label: String?
    public val categories: List<String>

    public suspend fun confirm()

    public suspend fun decline()
}

/** A pairing that was stored. */
public data class PolarisLocalPaired(val id: String, val label: String?)

/** The open pairing window. */
public interface PolarisLocalWindow {
    public suspend fun stop()

    public suspend fun renew(): PolarisLocalCode
}

/** What a pairing window tells the state holder. [onEnd] gets `expired`, `too-many-tries`, `stored`, `person` or `off`. */
public class PolarisLocalEvents(
    public val onCode: (PolarisLocalCode) -> Unit,
    public val onConfirm: (PolarisLocalOffer) -> Unit,
    public val onLinked: (PolarisLocalPaired) -> Unit,
    public val onInterrupted: (Int) -> Unit,
    public val onEnd: (String) -> Unit,
)

/** One paired device (`LocalLinkInfo`). */
public data class PolarisPairedDevice(
    val id: String,
    val label: String?,
    val lastSeen: Long?,
    val reachable: Boolean,
    val platform: String? = null,
)

/** `client.cloudConnect.localLinks` as far as the two state holders need it. Calls throw [PolarisLocalFailure] or a cancellation. */
public interface PolarisLocalLinks {
    /** The cached discovery answer: false while pairing is off for this app. */
    public fun localPairing(): Boolean

    public suspend fun list(): List<PolarisPairedDevice>

    public suspend fun rename(id: String, label: String)

    public suspend fun remove(id: String)

    public suspend fun setReachable(id: String, reachable: Boolean)

    /** Fires after any change to the links or the gate. Returns the unsubscribe. */
    public fun onChange(fn: () -> Unit): () -> Unit

    /** Dials left for the typed code's first two digits (0, 1 or 2); null until two are typed. */
    public fun dialsLeft(text: String): Int?

    public suspend fun pair(categories: List<String>, label: String?, events: PolarisLocalEvents): PolarisLocalWindow

    public suspend fun join(code: String, categories: List<String>, label: String?, onConfirm: (PolarisLocalOffer) -> Unit): PolarisLocalPaired
}

/** An SDK rejection as the fields the state holders read. */
internal fun Throwable.asLocalFailure(): Throwable = when (this) {
    is CancellationException, is PolarisLocalFailure -> this
    is LocalPairingException -> PolarisLocalFailure(code, reason, cap)
    is LocalPairingOffException -> PolarisLocalFailure(ErrorCode.localPairingOff)
    is LanException -> PolarisLocalFailure(code, if (reason == LanErrorReason.bad_type) "bad_input" else null)
    else -> PolarisLocalFailure("unknown")
}

private fun LocalCode.toKit() = PolarisLocalCode(code, qr, reason.wire, expiresAt)

private class SdkLocalOffer(private val offer: LocalOffer) : PolarisLocalOffer {
    override val label: String? get() = offer.label
    override val categories: List<String> get() = offer.categories

    override suspend fun confirm() = offer.confirm()

    override suspend fun decline() = offer.decline()
}

/** The umbrella client's `cloudConnect.localLinks` as the driver. */
public fun PolarisKeyClient.localLinksDriver(): PolarisLocalLinks {
    val links = cloudConnect.localLinks
    suspend fun <T> mapped(block: suspend () -> T): T = try {
        block()
    } catch (e: Throwable) {
        throw e.asLocalFailure()
    }
    return object : PolarisLocalLinks {
        override fun localPairing(): Boolean = links.localPairing()

        override suspend fun list(): List<PolarisPairedDevice> = mapped {
            links.list().map { PolarisPairedDevice(it.id, it.label, it.lastSeen, it.reachable, it.platform) }
        }

        override suspend fun rename(id: String, label: String) = mapped { links.rename(id, label); Unit }

        override suspend fun remove(id: String) = mapped { links.remove(id); Unit }

        override suspend fun setReachable(id: String, reachable: Boolean) = mapped { links.setReachable(id, reachable); Unit }

        override fun onChange(fn: () -> Unit): () -> Unit = links.onChange(fn)

        override fun dialsLeft(text: String): Int? = links.dialsLeft(text)

        override suspend fun pair(categories: List<String>, label: String?, events: PolarisLocalEvents): PolarisLocalWindow = mapped {
            val handle = links.pair(
                LocalPairOptions(
                    categories = categories,
                    onCode = { events.onCode(it.toKit()) },
                    onConfirm = { events.onConfirm(SdkLocalOffer(it)) },
                    label = label,
                    onLinked = { events.onLinked(PolarisLocalPaired(it.id, it.label)) },
                    onInterrupted = { events.onInterrupted(it) },
                    onEnd = { events.onEnd(it.wire) },
                ),
            )
            object : PolarisLocalWindow {
                override suspend fun stop() = handle.stop()

                override suspend fun renew(): PolarisLocalCode = mapped { handle.renew().toKit() }
            }
        }

        override suspend fun join(
            code: String,
            categories: List<String>,
            label: String?,
            onConfirm: (PolarisLocalOffer) -> Unit,
        ): PolarisLocalPaired = mapped {
            val paired = links.join(LocalJoinOptions(categories, { onConfirm(SdkLocalOffer(it)) }, code = code, label = label))
            PolarisLocalPaired(paired.id, paired.label)
        }
    }
}
