// One Cloud Connect session as the host sees it (CC-12.10; WIRE-CONTRACT-V5 sections 15.5 and 15.6).
// Mirrors `ConnectSession` and `routeRecord` in sdk-node's `connect/session.ts` and the Python
// `connect/session.py`.
//
// The channel ([im.plrs.key.core.peer.PeerChannel]) and its pipe binding
// ([im.plrs.key.core.peer.PeerLink]) are driven by the transport; this class is the thread-safe handle
// the host holds: `send`, `receive`, `onMessage`, `onClose` and `close`.
//
// Rules this file keeps:
// - the host sees only the APP range (0x0100 to 0x7FFF). An APP-critical type (0x8100 to 0xFFFD) it
//   cannot understand closes the session with `peer_unknown_critical`; other types the session does not
//   own are ignored (G9);
// - messages the host has not read yet are bounded (G10): the pipe pauses at 4 MiB queued and resumes
//   under 1 MiB; at 8 MiB, or at 256 queued messages, the session closes with `peer_busy`; all sessions
//   together hold at most 32 MiB ([QueueBudget]);
// - every failure is a typed [LanException]; nothing reaches the host before the session is open;
// - a session's toString names its peer and path, never its keys.

package im.plrs.key.sdk

import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.LinkRefused
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerHello
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerLinkPort
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.XFER_CAP
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeoutException

/** The first APP record type; `send` defaults to it. */
public const val APP_DEFAULT_TYPE: Int = 0x0100

private const val APP_LAST = 0x7FFF
private const val CRITICAL_FIRST = 0x8100
private const val CRITICAL_LAST = 0xFFFD
private const val MIB = 1024 * 1024

/** Transfer records held for the transfer layer before it binds. */
private const val XFER_EARLY_RECORDS = 16
private const val XFER_EARLY_BYTES = 2 * MIB

/** Messages a session holds unread. */
public const val MAX_QUEUED_MESSAGES: Int = 256

/** The queue size at which the pipe stops being read. */
public const val QUEUE_PAUSE_BYTES: Int = 4 * MIB

/** The queue size under which a paused pipe is read again. */
public const val QUEUE_RESUME_BYTES: Int = MIB

/** The queue size at which the session closes `peer_busy`. */
public const val QUEUE_MAX_BYTES: Int = 8 * MIB

/** The bytes all sessions of a process hold unread together. */
public const val TOTAL_QUEUE_BYTES: Int = 32 * MIB

/** One message of the application. */
public class SessionMessage(public val type: Int, public val body: ByteArray) {
    override fun toString(): String = "SessionMessage(type=$type, ${body.size} bytes)"
}

/**
 * Who a session is with: a device of the person's, a contact (section 15.10) or a local link (section 15.12). A link is named
 * by its id on this device, never by a key.
 */
public sealed class TransferOrigin {
    public class Device(public val deviceId: String) : TransferOrigin() {
        override fun toString(): String = "Device($deviceId)"
    }

    public class Contact(public val linkId: String, public val label: String?) : TransferOrigin() {
        override fun toString(): String = "Contact($linkId)"
    }

    public class Local(public val linkId: String, public val label: String?) : TransferOrigin() {
        override fun toString(): String = "Local($linkId)"
    }
}

/** Why a session ended: a close code (`peer_bye`, `peer_revoked`, ...), or `connection_lost` when the pipe went away. */
public data class SessionClosed(val code: String, val byPeer: Boolean)

/** The bytes all sessions together may hold unread. */
public class QueueBudget(private val limit: Int = TOTAL_QUEUE_BYTES) {
    private val lock = Any()
    private var usedBytes = 0

    /** Bytes reserved now. */
    public val used: Int get() = synchronized(lock) { usedBytes }

    /** Reserve [n] bytes; false when the budget cannot hold them. */
    public fun reserve(n: Int): Boolean = synchronized(lock) {
        if (usedBytes + n > limit) {
            false
        } else {
            usedBytes += n
            true
        }
    }

    /** Give back [n] bytes. */
    public fun release(n: Int) {
        synchronized(lock) { usedBytes = maxOf(0, usedBytes - n) }
    }

    override fun toString(): String = "QueueBudget"
}

private val sharedBudget = QueueBudget()

/**
 * An open session with one peer device. Thread-safe. [link] is anything with the [PeerLinkPort] shape (a
 * [PeerLink], or a relay session). The callbacks of [onMessage] and [onClose] run inside the transport's
 * call: they must not call back into the session on that stack.
 */
public class ConnectSession internal constructor(
    internal val link: PeerLinkPort,
    public val peerDeviceId: String,
    caps: List<String>,
    public val hello: PeerHello,
    public val role: NoiseRole,
    public val remoteAddress: String,
    public val path: String = "lan",
    private val budget: QueueBudget = sharedBudget,
    /** The link a mode-`c` session runs over (section 15.10); null for the person's own devices. */
    public val contact: ContactRef? = null,
    /** The peer's static key (32 raw bytes, a public key): what a partially received transfer is kept under. */
    internal val peerKey: ByteArray? = null,
    /** The local link a mode-`l` session runs over (section 15.12); null for the person's own devices and for contacts. */
    public val local: LocalRef? = null,
) {
    private val lock = Any()
    private val inbox = Channel<SessionMessage>(Channel.UNLIMITED)
    private var queuedBytes = 0
    private var queuedCount = 0
    private var paused = false
    private var ended: SessionClosed? = null
    private val messageListeners = CopyOnWriteArrayList<(SessionMessage) -> Unit>()
    private val closeListeners = CopyOnWriteArrayList<(SessionClosed) -> Unit>()

    /** The capabilities both sides listed. */
    public val caps: List<String> = caps.toList()

    // -- the transfer port (section 15.11) ----------------------------------------------------------------------
    //
    // The channel hands the six transfer record types to the port attached here, at once and in order, from the
    // moment the session is open. Until the transfer layer binds ([bindTransfer]) they wait in a small buffer, so
    // a peer that offers the instant it connects is heard.

    private val xferLock = Any()
    private var xferSink: ((Int, ByteArray) -> Unit)? = null
    private val xferEarly = ArrayList<Pair<Int, ByteArray>>()
    private var xferEarlyBytes = 0
    private var xferWriter: (suspend (Int, ByteArray) -> Unit)? = null

    init {
        if (XFER_CAP in this.caps) {
            xferWriter = try {
                link.attachXfer(::xferIn)
            } catch (e: UnsupportedOperationException) {
                null
            } catch (e: IllegalStateException) {
                null
            }
        }
    }

    private fun xferIn(type: Int, body: ByteArray) {
        var over = false
        synchronized(xferLock) {
            val sink = xferSink
            if (sink != null) {
                sink(type, body)
            } else if (xferEarly.size >= XFER_EARLY_RECORDS || xferEarlyBytes + body.size > XFER_EARLY_BYTES) {
                over = true
            } else {
                xferEarly += type to body
                xferEarlyBytes += body.size
            }
        }
        if (over) link.closeNow(PeerCloseCode.peer_busy)
    }

    /** End the session with any close code, at once (the transfer layer's faults are `peer_bad_frame` and `peer_not_allowed`). */
    internal fun closeWith(code: PeerCloseCode) = link.closeNow(code)

    /** True when this session can carry transfers: both sides listed `xfer/1` and the link has a transfer port. */
    internal val canTransfer: Boolean get() = xferWriter != null

    /** Bind the transfer layer: the records that waited are delivered first, in order. Returns the writer. */
    internal fun bindTransfer(sink: (Int, ByteArray) -> Unit): (suspend (Int, ByteArray) -> Unit)? {
        val w = xferWriter ?: return null
        synchronized(xferLock) {
            check(xferSink == null) { "already bound" }
            xferSink = sink
            for ((t, b) in xferEarly) sink(t, b)
            xferEarly.clear()
            xferEarlyBytes = 0
        }
        return w
    }

    override fun toString(): String = when {
        contact != null -> "ConnectSession(contact=${contact.id}, path=$path, role=$role)"
        local != null -> "ConnectSession(local=${local.id}, path=$path, role=$role)"
        else -> "ConnectSession(peer=$peerDeviceId, path=$path, role=$role)"
    }

    /** Who the session is with: a device of the person's, a contact or a local link (with the link's id, not an empty device id). */
    public val origin: TransferOrigin
        get() = when {
            contact != null -> TransferOrigin.Contact(contact.id, contact.label)
            local != null -> TransferOrigin.Local(local.id, local.label)
            else -> TransferOrigin.Device(peerDeviceId)
        }

    /** Why the session ended, or null while it is open. */
    public val closed: SessionClosed? get() = synchronized(lock) { ended }

    // -- host calls (any thread) -----------------------------------------------------------------

    /** Send one message (up to the peer's `maxMessage`, at most 1 MiB) as an APP record. */
    public suspend fun send(body: ByteArray, type: Int = APP_DEFAULT_TYPE) {
        if (type < APP_DEFAULT_TYPE || type > APP_LAST) throw LanException(LanErrorReason.bad_type, "Application types are 0x0100 to 0x7FFF.")
        if (closed != null) throw LanException(LanErrorReason.closed, "The session is closed.")
        sendOrRefuse(type, body)
    }

    /**
     * Send a record of any type the session does not own (a peer document, a later transfer type). The
     * channel refuses HELLO, CLOSE, REKEY and SAS records.
     */
    internal suspend fun sendRecord(type: Int, body: ByteArray) {
        link.sendRecord(type, body.copyOf())
    }

    private suspend fun sendOrRefuse(type: Int, body: ByteArray) {
        try {
            link.sendRecord(type, body.copyOf())
        } catch (e: IllegalArgumentException) {
            if (e.message == "message too large") {
                throw LanException(LanErrorReason.too_large, "The message is larger than the peer accepts.")
            }
            throw LanException(LanErrorReason.closed, "The session is closed.", e)
        } catch (e: IllegalStateException) {
            throw LanException(LanErrorReason.closed, "The session is closed.", e)
        }
    }

    /**
     * The next message. Suspends until one arrives; throws [LanException] (`closed`) when the session
     * closes with none waiting, and [TimeoutException] after [timeoutMillis].
     */
    public suspend fun receive(timeoutMillis: Long? = null): SessionMessage {
        val got = try {
            if (timeoutMillis == null) inbox.receiveCatching() else withTimeout(timeoutMillis) { inbox.receiveCatching() }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw TimeoutException("no message")
        }
        val m = got.getOrNull() ?: throw LanException(LanErrorReason.closed, "The session is closed.")
        val resume = synchronized(lock) {
            queuedBytes -= m.body.size
            queuedCount--
            (paused && queuedBytes < QUEUE_RESUME_BYTES).also { if (it) paused = false }
        }
        budget.release(m.body.size)
        if (resume) link.pause(false)
        return m
    }

    /** Called for each message instead of queueing it. Returns the unsubscribe. */
    public fun onMessage(fn: (SessionMessage) -> Unit): () -> Unit {
        messageListeners += fn
        return { messageListeners -= fn }
    }

    /** Called once when the session ends (at once when it already has). Returns the unsubscribe. */
    public fun onClose(fn: (SessionClosed) -> Unit): () -> Unit {
        closeListeners += fn
        val done = closed
        if (done != null) fn(done)
        return { closeListeners -= fn }
    }

    /** Close with `peer_bye` (or `peer_busy`, or `peer_revoked` for a deleted contact); the CLOSE record is sent first. */
    public suspend fun close(code: String = "peer_bye") {
        require(code == "peer_bye" || code == "peer_busy" || code == "peer_revoked") { "close code" }
        try {
            link.close(PeerCloseCode.valueOf(code))
        } catch (e: IllegalStateException) {
            // the transport is already gone: the session is over
        }
    }

    // -- the transport's calls ------------------------------------------------------------------

    internal fun deliver(m: SessionMessage) {
        var full = false
        var pause = false
        val subs = messageListeners.toList()
        synchronized(lock) {
            if (ended != null) return
            if (subs.isEmpty()) {
                val over = queuedCount >= MAX_QUEUED_MESSAGES ||
                    queuedBytes + m.body.size > QUEUE_MAX_BYTES ||
                    !budget.reserve(m.body.size)
                if (over) {
                    full = true
                } else {
                    inbox.trySend(m)
                    queuedBytes += m.body.size
                    queuedCount++
                    pause = !paused && queuedBytes > QUEUE_PAUSE_BYTES
                    if (pause) paused = true
                }
            }
        }
        if (subs.isNotEmpty()) {
            for (f in subs) {
                try {
                    f(m)
                } catch (e: Exception) {
                    // a host callback never ends the session
                }
            }
            return
        }
        if (full) {
            link.closeNow(PeerCloseCode.peer_busy)
        } else if (pause) {
            link.pause(true)
        }
    }

    internal fun ended(c: SessionClosed) {
        val dropped: Int
        synchronized(lock) {
            if (ended != null) return
            ended = c
            dropped = queuedBytes
            queuedBytes = 0
            queuedCount = 0
            while (inbox.tryReceive().isSuccess) {
                // the unread messages are dropped with the session
            }
            inbox.close()
        }
        budget.release(dropped)
        for (f in closeListeners.toList()) {
            try {
                f(c)
            } catch (e: Exception) {
                // a host callback never ends the session
            }
        }
    }
}

/**
 * A record the channel hands up: the APP range goes to the host's session; an APP-critical type
 * (0x8100 to 0xFFFD) the host cannot understand closes the session; the rest is ignored.
 */
internal fun routeRecord(link: PeerLinkPort, session: ConnectSession?, type: Int, body: ByteArray) {
    if (type in APP_DEFAULT_TYPE..APP_LAST) {
        session?.deliver(SessionMessage(type, body))
    } else if (type in CRITICAL_FIRST..CRITICAL_LAST) {
        link.closeNow(PeerCloseCode.peer_unknown_critical)
    }
}

/** Await a link's admission: the [ConnectSession], or a [LanException] (`handshake_failed` with its close code) when the peer was not admitted. */
internal suspend fun <H> waitOpened(opened: CompletableDeferred<H>, timeoutMillis: Long? = null): H {
    try {
        return if (timeoutMillis != null) withTimeout(timeoutMillis) { opened.await() } else opened.await()
    } catch (e: LinkRefused) {
        throw LanException(LanErrorReason.handshake_failed, "The peer was not admitted.", closeCode = e.closeCode)
    }
}

/**
 * The link handlers that make a [ConnectSession]: it is built when the peer is admitted, APP records
 * are routed to it, and the link's close ends it.
 */
internal fun sessionHandlers(
    role: NoiseRole,
    docs: PeerDocs? = null,
    onEstablished: (ConnectSession) -> Unit = {},
    onEnded: () -> Unit = {},
    budget: QueueBudget? = null,
    path: String = "lan",
    /** The contacts the channel was given (same order): a mode-`c` session names the one that opened it by index. */
    contacts: List<ContactRef> = emptyList(),
    /** The local links the channel was given (same order): a mode-`l` session names the one that opened it by index. */
    locals: List<LocalRef> = emptyList(),
): LinkHandlers<ConnectSession> {
    var box: ConnectSession? = null
    return LinkHandlers(
        onEstablished = { link: PeerLinkPort, e: SessionEvent.Established ->
            // Mode c has no device id: the contact that opened the session names the peer.
            val ref = e.contactIndex?.let { contacts.getOrNull(it) }
            val local = e.localIndex?.let { locals.getOrNull(it) }
            val s = ConnectSession(
                link, e.peerDeviceId ?: "", e.caps, e.hello, role, link.remoteAddress, path, budget ?: sharedBudget, ref, e.remoteStatic.copyOf(),
                local,
            )
            box = s
            onEstablished(s)
            s
        },
        onRecord = { link, type, body -> routeRecord(link, box, type, body) },
        onRing = { jws, epoch -> docs?.onRing(jws, epoch) },
        onTrust = { jws -> docs?.onTrust(jws) },
        onRingWanted = { docs?.onRingWanted() },
        onClosed = { c -> box?.ended(SessionClosed(c.code, c.byPeer)) },
        onEnded = onEnded,
    )
}
