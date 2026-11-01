// `client.cloudConnect.transfer` -- Direct Transfer between two devices (CC-20.7; WIRE-CONTRACT-V5 section 15.11).
// Mirrors the Node `cloudConnect.transfer` (packages/sdk-node, CC-20.3) in spirit; the spellings are Kotlin's.
//
//   send(peer, source, options)   offer [source] to the device on [peer] (a session) and return a handle
//   onOffer(handler)              consent per transfer: the handler answers each offer, at once or later
//   onResult(fn)                  how every transfer, either way, ended
//   cancel(peer, id)              end a transfer from this side
//   discardPartials()             delete every kept partial file
//
// Rules this file keeps:
//  - consent per transfer: every offer goes to the handler; without one the SDK declines. A handler answers
//    [OfferDecision.Accept] with the file the content is delivered to (the SDK never picks a path, and never uses
//    the sender's `name` for one), [OfferDecision.Decline], or [OfferDecision.Ask] and answers later through
//    [TransferOffer.accept] / [TransferOffer.decline]. In a contact session the offer must name one of the link's
//    categories, and that is checked before the handler is asked;
//  - the sender's `name` and `type` are display data. They are cleaned for display and never reach a file name;
//  - a transfer runs only in a session that both sides opened with `xfer/1` (the SDK lists it unless
//    `CloudConnectOptions.transfers` is false); a session without it throws [TransferUnavailableException];
//  - a receive is kept as a partial file under the state directory and resumes after a dropped session when the
//    sender offers the same [TransferSendOptions.id] again; sign-out and a deleted contact purge them;
//  - the handler and `onResult` callbacks run on the session's worker: keep them short, and do not call back into
//    `transfer` from inside the handler (answer with the return value).

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.MAX_PEER_MESSAGE_BYTES
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.RecordMode
import im.plrs.key.core.peer.XFER_CHUNK_HEAD
import im.plrs.key.core.peer.XFER_DEFAULT_CHUNK
import im.plrs.key.core.peer.XFER_MAX_SIZE
import im.plrs.key.core.peer.XferAnswer
import im.plrs.key.core.peer.XferAsk
import im.plrs.key.core.peer.XferEffect
import im.plrs.key.core.peer.XferEndpoint
import im.plrs.key.core.peer.XferEvents
import im.plrs.key.core.peer.XferHandler
import im.plrs.key.core.peer.XferMachine
import im.plrs.key.core.peer.XferMachineOptions
import im.plrs.key.core.peer.XferOfferArgs
import im.plrs.key.core.peer.XferOfferBody
import im.plrs.key.core.peer.XferPorts
import im.plrs.key.core.peer.XferReason
import im.plrs.key.core.peer.XferResult
import im.plrs.key.core.peer.XferType
import im.plrs.key.core.peer.parseXferDone
import im.plrs.key.core.peer.parseXferOffer
import im.plrs.key.core.peer.xferHex
import im.plrs.key.core.peer.xferOfferBody
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

private const val ID_BYTES = 16
private const val MILLIS = 1000.0
private const val HASH_BLOCK = 64 * 1024

/** The session carries no transfers: the peer did not list `xfer/1`, or the host turned transfers off. */
public class TransferUnavailableException(message: String) : PolarisException(ErrorCode.connectUnavailable, message) {
    override fun toString(): String = "TransferUnavailableException"
}

/** A transfer ended without delivering the content. [reason] is the `CANCEL` reason sent or received. */
public class TransferCancelledException(public val reason: XferReason) :
    PolarisException(ErrorCode.transferCancelled, "The transfer ended without delivering the content: ${reason.name}.") {
    override fun toString(): String = "TransferCancelledException(${reason.name})"
}

/** What the host sends: the bytes of one thing, whose hash is known before the offer. */
public interface TransferSource : AutoCloseable {
    public val size: Long

    /** 64 lower-case hex characters. */
    public val sha256: String

    /** Display data for the receiver; never a path. */
    public val name: String? get() = null

    /** A media type such as `image/png`, passed on as given. */
    public val type: String? get() = null

    /** False when [read] cannot restart at an offset above 0 (a resumed transfer is then cancelled). */
    public val seekable: Boolean get() = true

    /** Exactly [length] bytes at [offset]. */
    public suspend fun read(offset: Long, length: Int): ByteArray

    override fun close() {}

    public companion object {
        /** A source over [bytes]. */
        @JvmStatic
        @JvmOverloads
        public fun ofBytes(bytes: ByteArray, name: String? = null, type: String? = null): TransferSource {
            val sha = xferHex(MessageDigest.getInstance("SHA-256").digest(bytes))
            return object : TransferSource {
                override val size: Long = bytes.size.toLong()
                override val sha256: String = sha
                override val name: String? = name
                override val type: String? = type
                override suspend fun read(offset: Long, length: Int): ByteArray = bytes.copyOfRange(offset.toInt(), offset.toInt() + length)
            }
        }

        /** A source over [file], hashed now (this reads the whole file once). [name] defaults to the file's name. */
        @JvmStatic
        @JvmOverloads
        public suspend fun ofFile(file: File, name: String? = file.name, type: String? = null): TransferSource {
            val d = MessageDigest.getInstance("SHA-256")
            val total = withContext(Dispatchers.IO) {
                RandomAccessFile(file, "r").use { f ->
                    val buf = ByteArray(HASH_BLOCK)
                    while (true) {
                        val n = f.read(buf)
                        if (n < 0) break
                        d.update(buf, 0, n)
                    }
                    f.length()
                }
            }
            val sha = xferHex(d.digest())
            return object : TransferSource {
                override val size: Long = total
                override val sha256: String = sha
                override val name: String? = name
                override val type: String? = type
                override suspend fun read(offset: Long, length: Int): ByteArray = withContext(Dispatchers.IO) {
                    RandomAccessFile(file, "r").use { f ->
                        f.seek(offset)
                        ByteArray(length).also { f.readFully(it) }
                    }
                }
            }
        }
    }
}

/**
 * Options of one send. [id] is a transfer id (22 base64url characters): leave it out for a new transfer, or give
 * the [TransferHandle.id] of one that ended `closed` to resume it. [name] and [type] override the source's;
 * [category] is required in a contact session (the link's categories, section 15.10).
 */
public class TransferSendOptions @JvmOverloads constructor(
    public val category: String? = null,
    public val name: String? = null,
    public val type: String? = null,
    public val id: String? = null,
) {
    override fun toString(): String = "TransferSendOptions"
}

/** How a transfer ended. */
public enum class TransferOutcome { delivered, cancelled, closed }

/** The end of one transfer, either way. [destination] is where a delivered incoming transfer was written. */
public class TransferResult(
    public val id: String,
    public val incoming: Boolean,
    public val outcome: TransferOutcome,
    public val reason: XferReason?,
    public val destination: File?,
    public val peer: ConnectSession,
) {
    override fun toString(): String = "TransferResult($id, ${if (incoming) "in" else "out"}, ${outcome.name})"
}

/** An outgoing transfer. */
public class TransferHandle internal constructor(
    public val id: String,
    public val peer: ConnectSession,
    private val cancelFn: () -> Unit,
    internal val done: CompletableDeferred<TransferResult>,
) {
    /** End the transfer from this side (`CANCEL cancelled`). */
    public fun cancel(): Unit = cancelFn()

    /**
     * Wait for the end. Returns the delivered result; throws [TransferCancelledException] when the content was not
     * delivered because of a `CANCEL` (its reason says which), and [LanException] (`closed`) when the session ended
     * first: send again with `TransferSendOptions(id = handle.id)` to resume.
     */
    public suspend fun await(): TransferResult {
        val r = done.await()
        return when (r.outcome) {
            TransferOutcome.delivered -> r
            TransferOutcome.cancelled -> throw TransferCancelledException(r.reason ?: XferReason.cancelled)
            TransferOutcome.closed -> throw LanException(LanErrorReason.closed, "The session ended before the transfer finished.")
        }
    }

    override fun toString(): String = "TransferHandle($id)"
}

/** The host's answer to an offer. */
public sealed class OfferDecision {
    /** Take it: write the content to [destination] (a file that does not exist yet) when it is complete and verified. */
    public class Accept(public val destination: File) : OfferDecision()

    /** Refuse it (`CANCEL declined`). */
    public object Decline : OfferDecision()

    /** Answer later through [TransferOffer.accept] or [TransferOffer.decline]; the SDK waits 120 seconds. */
    public object Ask : OfferDecision()
}

/**
 * An offer the peer made. [name] is cleaned display data (it may be null and is never a path), [type] is passed on
 * as given, [category] is the sender's. Nothing is written anywhere until the host accepts with a destination.
 */
public class TransferOffer internal constructor(
    public val id: String,
    public val peer: ConnectSession,
    public val size: Long,
    public val name: String?,
    public val type: String?,
    public val category: String?,
    private val answer: (Boolean, File?) -> Unit,
) {
    @Volatile
    private var gone = false
    private val goneFns = CopyOnWriteArrayList<() -> Unit>()

    /** True once the peer or a timer ended the offer before it was answered. */
    public val isWithdrawn: Boolean get() = gone

    /** Take it (after an [OfferDecision.Ask]); the content is written to [destination], which must not exist yet. */
    public fun accept(destination: File) {
        require(!destination.exists()) { "the destination exists" }
        answer(true, destination)
    }

    /** Refuse it (after an [OfferDecision.Ask]). */
    public fun decline(): Unit = answer(false, null)

    /** Called once when the offer is withdrawn unanswered. Returns the unsubscribe. */
    public fun onWithdrawn(fn: () -> Unit): () -> Unit {
        goneFns += fn
        if (gone) fn()
        return { goneFns -= fn }
    }

    internal fun withdraw() {
        gone = true
        for (f in goneFns.toList()) {
            try {
                f()
            } catch (e: Exception) {
                // a host callback never ends a transfer
            }
        }
    }

    override fun toString(): String = "TransferOffer($id, $size bytes)"
}

/** Direct Transfer. Reach it as `client.cloudConnect.transfer`. */
public class CloudTransfer internal constructor(
    private val stateDirectory: () -> File?,
    private val enabled: () -> Boolean,
    /** Test seam: the transfer clock runs this many times faster than real time. */
    private val speed: Double = 1.0,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val rng = SecureRandom()
    private val bound = ConcurrentHashMap<ConnectSession, Bound>()
    private val resultFns = CopyOnWriteArrayList<(TransferResult) -> Unit>()

    @Volatile
    private var handler: ((TransferOffer) -> OfferDecision)? = null

    @Volatile
    private var last = 0.0
    private val base = System.currentTimeMillis() / MILLIS

    @Volatile
    private var tempRoot: File? = null

    /** The most bytes this device takes in one transfer; larger offers are refused (`size`). Null for no limit of its own. */
    @Volatile
    public var maxIncomingBytes: Long? = null

    /**
     * The most the kept partials and the space reserved for transfers in flight may add up to, in bytes. Space is
     * reserved when an offer is accepted and held until the transfer ends; an offer that does not fit is refused
     * with `quota`. Applies at once.
     */
    @Volatile
    public var storeQuotaBytes: Long = TRANSFER_QUOTA_BYTES

    private val store: TransferStore by lazy {
        val dir = stateDirectory() ?: Files.createTempDirectory("pkey-transfer").toFile().also { tempRoot = it }
        TransferStore(dir, ::clock, { storeQuotaBytes })
    }

    override fun toString(): String = "CloudTransfer"

    /** Seconds on a clock that never runs backwards. */
    private fun clock(): Double = synchronized(this) {
        val t = base + (System.currentTimeMillis() / MILLIS - base) * speed
        if (t > last) last = t
        last
    }

    // -- the API ------------------------------------------------------------------------------------------------

    /**
     * Set the handler that answers every offer; it replaces the previous one. Without a handler every offer is
     * declined. Returns the unsubscribe.
     */
    public fun onOffer(handler: (TransferOffer) -> OfferDecision): () -> Unit {
        this.handler = handler
        return { if (this.handler === handler) this.handler = null }
    }

    /** Called with how each transfer ended, either way. Returns the unsubscribe. */
    public fun onResult(fn: (TransferResult) -> Unit): () -> Unit {
        resultFns += fn
        return { resultFns -= fn }
    }

    /** True while a handler is set, so a device with no `onChannel` listener still keeps its inbound sessions. */
    internal val accepting: Boolean get() = handler != null

    /**
     * Offer [source] to the device on [peer] and return at once with the handle. Throws [TransferUnavailableException]
     * when the session has no `xfer/1`, and [IllegalArgumentException] for a name, type or category the peer would
     * refuse, or an id already used in this session. In a contact session set [TransferSendOptions.category].
     */
    @JvmOverloads
    public suspend fun send(peer: ConnectSession, source: TransferSource, options: TransferSendOptions = TransferSendOptions()): TransferHandle {
        val b = boundFor(peer) ?: throw TransferUnavailableException("This session does not carry transfers.")
        val chunk = minOf(XFER_DEFAULT_CHUNK.toLong(), peer.hello.maxMessage - XFER_CHUNK_HEAD).toInt()
        require(chunk >= 1) { "the peer accepts no transfer chunk" }
        require(source.size in 0..XFER_MAX_SIZE) { "size" }
        val id = options.id ?: Base64Url.encode(ByteArray(ID_BYTES).also { rng.nextBytes(it) })
        val name = options.name ?: source.name
        val type = options.type ?: source.type
        // What the peer would fault on is refused here, before anything is sent.
        val body = XferOfferBody(id, source.size, source.sha256, chunk, name, type, options.category)
        requireNotNull(parseXferOffer(xferOfferBody(body), MAX_PEER_MESSAGE_BYTES.toLong())) { "the offer is not valid" }
        return b.send(id, source, chunk, options.category, name, type)
    }

    /** End the transfer [id] in [peer] from this side. */
    public fun cancel(peer: ConnectSession, id: String) {
        bound[peer]?.endpoint?.cancel(id)
    }

    /** End the transfer [id] from this side, whichever session carries it (a no-op for an id that is not live). */
    public fun cancel(id: String) {
        for (b in bound.values.toList()) b.endpoint.cancel(id)
    }

    /** Delete every kept partial file. */
    public fun discardPartials() {
        store.purgeAll()
    }

    // -- the SDK's calls ----------------------------------------------------------------------------------------

    /** Bind the transfer layer to a session the SDK holds (idempotent). Safe on a session with no transfer port. */
    internal fun bind(session: ConnectSession) {
        boundFor(session)
    }

    private fun boundFor(session: ConnectSession): Bound? {
        if (!enabled() || !session.canTransfer || session.peerKey == null) return null
        bound[session]?.let { return it }
        return synchronized(bound) {
            bound[session] ?: Bound(session).also {
                bound[session] = it
                it.start()
            }
        }
    }

    /**
     * Sign-out and leaving the roster: the sessions with a transfer layer are closed, every partial goes, and an
     * effect of an old session that arrives late is refused by the store (it does not bring the directory back).
     */
    internal fun purgeAll() {
        for (b in bound.values.toList()) b.stop()
        bound.clear()
        if (stateDirectory() != null || tempRoot != null) runCatching { store.purgeAll() }
    }

    /** A deleted contact: its partials go. [agreeKey] is the contact's key as 43 base64url characters. */
    internal fun purgePeer(agreeKey: String) {
        val key = Base64Url.decodeStrict(agreeKey) ?: return
        runCatching { store.purgePeer(key) }
    }

    internal fun shutdown() {
        for (b in bound.values.toList()) b.endpoint.closed()
        bound.clear()
        scope.cancel()
        tempRoot?.deleteRecursively()
    }

    // -- one session --------------------------------------------------------------------------------------------

    private class Outgoing(val source: TransferSource, val done: CompletableDeferred<TransferResult>)

    private inner class Bound(val session: ConnectSession) : XferEvents {
        private val key: ByteArray = session.peerKey!!
        private val epoch = store.epoch
        private val writer = CompletableDeferred<suspend (Int, ByteArray) -> Unit>()
        private val dest = ConcurrentHashMap<String, File>()
        private val finalized = ConcurrentHashMap.newKeySet<String>()
        private val offers = ConcurrentHashMap<String, TransferOffer>()
        private val outgoing = ConcurrentHashMap<String, Outgoing>()

        private val machine = XferMachine(
            XferMachineOptions(
                mode = if (session.contact != null) RecordMode.c else RecordMode.a,
                caps = session.caps,
                maxMessage = MAX_PEER_MESSAGE_BYTES.toLong(),
                peerKey = key,
                handler = XferHandler { decide(it) },
                hostLimit = maxIncomingBytes,
                free = { store.free() },
                categories = session.contact?.categories.orEmpty(),
                partials = store.partialsFor(key),
                rehash = { ref, offset -> store.rehash(ref, offset) },
            ),
        )

        val endpoint = XferEndpoint(
            machine,
            XferPorts(
                send = { t, b ->
                    if (t == XferType.DONE) deliverEmptyBeforeEcho(b)
                    writer.await()(t, b)
                },
                close = { code -> session.closeWith(code) },
                read = { id, off, len -> (outgoing[id] ?: error("no source")).source.read(off, len) },
                apply = { e -> applyEffect(e) },
                events = this,
            ),
            scope,
            ::clock,
            speed,
        )

        init {
            session.onClose {
                endpoint.closed()
                bound.remove(session)
            }
        }

        /** End the transfer layer of this session and the session with it. */
        fun stop() {
            endpoint.closed()
            bound.remove(session)
            session.closeWith(PeerCloseCode.peer_bye)
        }

        fun start() {
            val w = session.bindTransfer(endpoint::receive) ?: return
            writer.complete(w)
        }

        /** A transfer of no bytes has no partial file: its empty file is written before the receiver's `DONE` goes out. */
        private suspend fun deliverEmptyBeforeEcho(body: ByteArray) {
            val id = parseXferDone(body, false)?.id ?: return
            val file = dest[id] ?: return
            if (outgoing.containsKey(id) || !finalized.add(id)) return
            withContext(Dispatchers.IO) { store.deliverEmpty(file) }
        }

        private suspend fun applyEffect(e: XferEffect) {
            withContext(Dispatchers.IO) { store.apply(e, this@Bound, key, epoch) { dest[it] } }
            if (e is XferEffect.Finalize) finalized += e.id
        }

        private fun decide(ask: XferAsk): XferAnswer {
            val h = handler ?: return XferAnswer.decline
            val offer = TransferOffer(ask.id, session, ask.size, ask.name, ask.type, ask.cat) { accept, file ->
                // Whatever goes wrong while answering ends this session, never the host's thread or the SDK's scope.
                try {
                    if (accept) dest[ask.id] = file!!
                    endpoint.consent(ask.id, accept)
                } catch (e: Exception) {
                    stop()
                }
            }
            val d = try {
                h(offer)
            } catch (e: Exception) {
                OfferDecision.Decline
            }
            return when (d) {
                is OfferDecision.Accept -> if (d.destination.exists()) {
                    XferAnswer.decline
                } else {
                    dest[ask.id] = d.destination
                    XferAnswer.accept
                }

                OfferDecision.Decline -> XferAnswer.decline

                OfferDecision.Ask -> {
                    offers[ask.id] = offer
                    XferAnswer.ask
                }
            }
        }

        fun send(id: String, source: TransferSource, chunk: Int, cat: String?, name: String?, type: String?): TransferHandle {
            val done = CompletableDeferred<TransferResult>()
            check(outgoing.putIfAbsent(id, Outgoing(source, done)) == null) { "transfer id already used" }
            try {
                endpoint.offer(XferOfferArgs(id, source.size, chunk, source.sha256, cat, name, type, source.seekable))
            } catch (e: RuntimeException) {
                outgoing.remove(id)
                throw IllegalArgumentException("transfer id already used", e)
            }
            return TransferHandle(id, session, { endpoint.cancel(id) }, done)
        }

        // -- XferEvents ----------------------------------------------------------------------------------------

        override fun ask(a: XferAsk) = Unit

        override fun withdraw(id: String) {
            offers.remove(id)?.withdraw()
            dest.remove(id)
        }

        override fun refused(id: String) {
            val o = outgoing.remove(id) ?: return
            o.source.close()
            o.done.complete(TransferResult(id, false, TransferOutcome.cancelled, XferReason.busy, null, session))
        }

        override fun error(err: Throwable) = Unit

        override fun result(r: XferResult) {
            offers.remove(r.id)
            val out = outgoing.remove(r.id)
            out?.source?.close()
            val file = dest.remove(r.id)
            val outcome = when (r) {
                is XferResult.Delivered -> TransferOutcome.delivered
                is XferResult.Cancelled -> TransferOutcome.cancelled
                is XferResult.Closed -> TransferOutcome.closed
            }
            val reason = (r as? XferResult.Cancelled)?.reason
            finalized.remove(r.id)
            val res = TransferResult(r.id, out == null, outcome, reason, if (out == null && outcome == TransferOutcome.delivered) file else null, session)
            out?.done?.complete(res)
            for (f in resultFns.toList()) {
                try {
                    f(res)
                } catch (e: Exception) {
                    // a host callback never ends a transfer
                }
            }
        }
    }
}
