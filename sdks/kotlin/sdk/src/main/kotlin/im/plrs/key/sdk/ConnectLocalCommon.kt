// Pairing with a code, with no account: the types and the pieces the shower and the joiner share (CC-29.13;
// WIRE-CONTRACT-V5 section 15.12). The window is `LocalShower.kt`, the dialling side is `LocalJoiner.kt`, and
// `ConnectLocalLinks.kt` is the `client.cloudConnect.localLinks` facade. Mirrors sdk-node's `connect/localCommon.ts`.
//
// A password, a QR secret and a link secret are key material: nothing here logs one, prints one or puts one in an error.

@file:Suppress(
    "LongParameterList",
    "MagicNumber",
    "SwallowedException",
    "TooGenericExceptionCaught",
)

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.peer.LocalLink
import im.plrs.key.core.peer.MAX_CONTACT_CATS
import im.plrs.key.core.peer.PeerHello
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.lan.MdnsAdapter
import java.net.ServerSocket
import java.security.SecureRandom

private const val LABEL_MAX = 64
private const val BACKLOG = 16
private val CAT = Regex("[a-z0-9-]{1,32}")
private val rng = SecureRandom()

internal val systemRandom: (Int) -> ByteArray = { n -> ByteArray(n).also { rng.nextBytes(it) } }

internal val systemMono: () -> Double = { System.nanoTime() / 1e9 }

/** The code a shower shows now. It changes after every failed guess. */
public class LocalCode internal constructor(
    /** The 8 digits as two groups of four, like `4812 3456`. */
    public val code: String,
    /** The text of the QR, `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. */
    public val qr: String,
    /** The public two digits of the code, the advert's `n`. */
    public val nameplate: String,
) {
    override fun toString(): String = "LocalCode"
}

/** The other device, at the consent step. */
public interface LocalOffer {
    /** Agree to the pairing. The link exists once the other person agrees too. */
    public suspend fun confirm()

    /** Say no: the session closes and this side stores nothing. */
    public suspend fun decline()

    /** Called once when the session ends (at once if it already has). Returns the unsubscribe. */
    public fun onClose(fn: (SessionClosed) -> Unit): () -> Unit

    /** The label the other device sent. It proved the code, but nothing else about it is authenticated: show it as "reported by the device". */
    public val label: String?
    public val platform: String

    /** The categories this app asked for: list them before the person agrees. */
    public val categories: List<String>
}

/** What `pair` and `join` report once a link is stored. */
public class LocalPaired(
    /** Names the link on this device; `list()` has the rest. */
    public val id: String,
    public val label: String?,
    /** The categories both people approved. */
    public val categories: List<String>,
) {
    override fun toString(): String = "LocalPaired($id)"
}

/** Why a session that reached the consent ended without a link, or the window ended. */
public enum class LocalPairFailureReason { Declined, Timeout, Full, TooManyTries, Closed }

public class LocalPairFailure(public val reason: LocalPairFailureReason, public val close: SessionClosed?) {
    override fun toString(): String = "LocalPairFailure(${reason.name})"
}

/** The open pairing window. */
public interface LocalPairHandle {
    /** Close the window: the advert, the listener and every session. */
    public suspend fun stop()

    /** The window is still open. */
    public val open: Boolean

    /** The code on show now; null once the window has closed. */
    public fun code(): LocalCode?
}

/** The common options of `pair` and `join`. Callbacks run on a service thread: keep them short, never block in one. */
public open class LocalOptions(
    /**
     * The data categories this app asks both people to approve (at most 8, each `[a-z0-9-]{1,32}`, no repeat). Show them
     * next to the consent. A link keeps the ones both sides listed.
     */
    public val categories: List<String>,
    /** Called when a device reaches the consent: show it, then call [LocalOffer.confirm] or [LocalOffer.decline]. */
    public val onConfirm: (LocalOffer) -> Unit,
    /** This device's label, sent in `HELLO` and in `LOCAL_LINK` and stored on the other device. */
    public val label: String?,
    public val mdns: MdnsAdapter?,
    /** Where the shower listens: a literal, by default `::` (both families on one port), else 0.0.0.0. */
    public val host: String?,
    /** Accept and dial loopback peers. For tests and same-host use only. */
    public val allowLoopback: Boolean,
    public val handshakeSeconds: Double,
) {
    /** Test seams: the random source and the monotonic clock. */
    internal var random: (Int) -> ByteArray = systemRandom
    internal var mono: () -> Double = systemMono

    override fun toString(): String = "LocalOptions"
}

/** What [CloudLocalLinks.pair] needs. */
public class LocalPairOptions @JvmOverloads constructor(
    categories: List<String>,
    /** Called with the code when the window opens, and with the new one after every failed guess. */
    public val onCode: (LocalCode) -> Unit,
    onConfirm: (LocalOffer) -> Unit,
    label: String? = null,
    /** Called once with the link made. */
    public val onLinked: ((LocalPaired) -> Unit)? = null,
    /** Called when a session that reached the consent ends without a link, and at the fifth failed guess. */
    public val onFailed: ((LocalPairFailure) -> Unit)? = null,
    /** Seconds the window stays open (default and most 300). */
    public val seconds: Double = 300.0,
    mdns: MdnsAdapter? = null,
    host: String? = null,
    allowLoopback: Boolean = false,
    handshakeSeconds: Double = 30.0,
) : LocalOptions(categories, onConfirm, label, mdns, host, allowLoopback, handshakeSeconds) {
    /** These options with another discovery adapter (the platform's, on Android). */
    internal fun withMdns(adapter: MdnsAdapter?): LocalPairOptions =
        LocalPairOptions(categories, onCode, onConfirm, label, onLinked, onFailed, seconds, adapter, host, allowLoopback, handshakeSeconds).also {
            it.random = random
            it.mono = mono
        }

    override fun toString(): String = "LocalPairOptions"
}

/** What [CloudLocalLinks.join] needs: exactly one of [code] and [qr]. */
public class LocalJoinOptions @JvmOverloads constructor(
    categories: List<String>,
    onConfirm: (LocalOffer) -> Unit,
    /** The code the other device shows, typed (spaces and hyphens are ignored). */
    public val code: String? = null,
    /** The text of the QR the other device shows. */
    public val qr: String? = null,
    label: String? = null,
    /** Seconds to browse for the other device (default and most 15). */
    public val browseSeconds: Double = 15.0,
    mdns: MdnsAdapter? = null,
    allowLoopback: Boolean = false,
    handshakeSeconds: Double = 30.0,
) : LocalOptions(categories, onConfirm, label, mdns, null, allowLoopback, handshakeSeconds) {
    internal fun withMdns(adapter: MdnsAdapter?): LocalJoinOptions =
        LocalJoinOptions(categories, onConfirm, code, qr, label, browseSeconds, adapter, allowLoopback, handshakeSeconds).also {
            it.random = random
            it.mono = mono
        }

    override fun toString(): String = "LocalJoinOptions"
}

/** Pairing with a code is off for this product (the typed N/A, code `local-pairing-off`). */
public class LocalPairingOffException(what: String) :
    PolarisException(
        ErrorCode.localPairingOff,
        "Pairing with a code is off for this product ($what).",
        detail = "Pairing with a code is off for this product ($what).",
        unsupported = Unsupported(Feature.connectLocal, UnsupportedReason.product, "Pairing with a code is off for this product ($what)."),
    ) {
    override fun toString(): String = "LocalPairingOffException($code)"
}

/** This device holds the most local links it can for this app, or eight are reachable already. */
internal fun localFull(detail: String = "This device holds the most local links it can for this app."): PolarisException =
    PolarisException(ErrorCode.localLinksFull, detail)

internal fun localBad(message: String): LanException = LanException(LanErrorReason.bad_type, message)

/** Throws [LanException] `bad_type` for options of `pair` or `join` that break a rule. */
internal fun checkLocalOptions(o: LocalOptions) {
    val c = o.categories
    if (c.size > MAX_CONTACT_CATS || !c.all { CAT.matches(it) } || c.toSet().size != c.size) {
        throw localBad("categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
    }
    if (o.label != null && o.label.codePointCount(0, o.label.length) > LABEL_MAX) throw localBad("The label is not valid.")
}

/** The connection of one attempt, on either side. */
internal class LocalAttempt {
    @Volatile var id: Int? = null

    @Volatile var link: PeerLink<Unit>? = null

    @Volatile var hello: PeerHello? = null

    /** `c1`, `session` (the guess opened) or `done` (the guess failed). */
    @Volatile var phase: String = "c1"

    @Volatile var shown = false

    @Volatile var linked = false

    @Volatile var declined = false

    @Volatile var local = false

    @Volatile var failure: LocalPairFailureReason? = null

    @Volatile var closed: SessionClosed? = null

    @Volatile var storing: kotlinx.coroutines.Job? = null

    /** This attempt's link private key: kept only while the attempt lives. */
    @Volatile var linkKey: ByteArray = ByteArray(0)
    val closers = CloseSubscribers()
}

private class OfferImpl(private val a: LocalAttempt, override val categories: List<String>, hello: PeerHello) : LocalOffer {
    override val label: String? = hello.label
    override val platform: String = hello.platform

    override suspend fun confirm() {
        val l = a.link ?: return
        if (a.local) return
        l.channel.confirmPairing()
    }

    override suspend fun decline() {
        val l = a.link ?: return
        a.declined = true
        a.failure = LocalPairFailureReason.Declined
        try {
            l.channel.declinePairing()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // the session is gone
        }
    }

    override fun onClose(fn: (SessionClosed) -> Unit): () -> Unit = a.closers.add(fn)

    override fun toString(): String = "LocalOffer"
}

internal fun offerOf(a: LocalAttempt, cats: List<String>, hello: PeerHello): LocalOffer = OfferImpl(a, cats, hello)

/**
 * Store the link a session produced. Null at the cap (the attempt's `failure` says `Full`); throws what the store throws.
 * The secret is wiped either way.
 */
internal suspend fun storeLocalLink(src: LocalSource, a: LocalAttempt, e: SessionEvent.LocalLinked): LocalPaired? {
    try {
        // The gate is read again inside the store call: a window that closed while the store waited leaves no link.
        val id = src.store.add(NewLocalLink(a.linkKey, e.ownKey, e.peerKey, e.secret, e.label, e.cats), src.now(), src.allowed)
        if (id == null) {
            a.failure = if (src.allowed()) LocalPairFailureReason.Full else LocalPairFailureReason.Closed
            return null
        }
        a.linked = true
        // The listener starts (a device that held no link) and the new link is advertised.
        src.notify()
        return LocalPaired(id, e.label, e.cats)
    } finally {
        e.secret.fill(0)
    }
}

/** A listener: [host] when given, else `::` (both families), else 0.0.0.0 where IPv6 is unavailable. */
internal fun bindServer(host: String?): ServerSocket {
    val any6 = im.plrs.key.core.peer.lan.inetAddressOfLiteral("::")
    val any4 = im.plrs.key.core.peer.lan.inetAddressOfLiteral("0.0.0.0")
    return if (host != null) {
        ServerSocket(0, BACKLOG, requireNotNull(im.plrs.key.core.peer.lan.inetAddressOfLiteral(host)) { "host" })
    } else {
        runCatching { ServerSocket(0, BACKLOG, any6) }.getOrElse { ServerSocket(0, BACKLOG, any4) }
    }
}

/**
 * A copy of a link's keys for one channel, or null when the copy came out empty because a reload wiped the held ones
 * between the read and the copy (a zero key could not complete a handshake).
 */
internal fun copyLiveLocal(l: LiveLocal): LocalLink? {
    val copy = LocalLink(l.secret.copyOf(), l.ownKey.copyOf(), l.peerKey.copyOf())
    if (copy.secret.any { it != 0.toByte() } && copy.ownKey.any { it != 0.toByte() }) return copy
    copy.secret.fill(0)
    copy.ownKey.fill(0)
    return null
}
