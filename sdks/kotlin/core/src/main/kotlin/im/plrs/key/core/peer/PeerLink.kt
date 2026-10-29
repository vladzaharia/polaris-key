// WIRE-CONTRACT-V5 section 15.6: a [PeerChannel] bound to one byte pipe (CC-12.10). Mirrors
// `SocketLink` in sdk-node's `connect/session.ts` and the Python engine's `core/peer_link.py`.
//
// The channel owns the handshake, admission, records, MORE reassembly and rekey; this class owns the
// bytes: it cuts TCP frames with [FrameReader], writes the channel's Noise messages as frames in
// order, drives its deadlines from the coroutine clock, and turns its events into handler calls.
//
// Rules this class keeps:
// - a frame is at most 65,535 bytes; before the channel is admitted a frame over [HANDSHAKE_FRAME_MAX]
//   (16 KiB) ends the link, and so does a pipe still unadmitted after the handshake deadline (30 s);
// - every failure ends the link and says why; nothing reaches the host before the channel is open;
// - [PeerLinkPort.pause] stops reading from the pipe, so a peer that sends faster than the host reads
//   is held back by TCP (the host-side queue caps live in the SDK's `ConnectSession`);
// - nothing here knows an error taxonomy: a refused handshake fails [PeerLink.opened] with
//   [LinkRefused] and the code the channel closed with.
//
// Handlers run inside the call that produced the event, with the channel's lock held: they must not
// call back into the channel on that stack ([PeerLinkPort.closeNow] is the safe way to end a session).

package im.plrs.key.core.peer

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.IOException

/** The largest frame a peer may send before it is admitted. */
public const val HANDSHAKE_FRAME_MAX: Int = 16_384

/** Bytes a link may hold unsent before it closes `peer_busy` (a peer that never reads). */
public const val LINK_WRITE_CAP: Long = 8L * 1024 * 1024

/** Seconds from accept (or connect) to an admitted channel. */
public const val HANDSHAKE_SECONDS: Double = 30.0

private const val MILLIS = 1000.0

/** How long an ended link gives the writer to flush its CLOSE record before the pipe is closed. */
private const val CLOSE_GRACE_MILLIS = 3000L
private const val BUSY_FLUSH_MILLIS = 250L

/** The least a deadline timer waits, so a deadline that is due now cannot spin. */
private const val MIN_WAKE_SECONDS = 0.05

/** One byte pipe: a TCP socket, or anything that moves bytes in order. */
public interface PeerPipe {
    /** The next bytes, or null at the end of the stream. Throws [IOException] when the pipe fails. */
    public suspend fun read(): ByteArray?

    /** Write [bytes], in order. */
    public suspend fun write(bytes: ByteArray)

    /** Close the pipe, flushing what [write] accepted when it can. Idempotent. */
    public fun close()

    /** The remote address as text (never a key). */
    public val remoteAddress: String
}

/** What a host-side session needs from the thing under it: a [PeerLink], or a relay session. */
public interface PeerLinkPort {
    public val remoteAddress: String

    /** Send one record message. Throws [IllegalStateException] when the session is not open. */
    public suspend fun sendRecord(type: Int, body: ByteArray)

    /** End the session with [code] (a CLOSE record when the transport exists). */
    public suspend fun close(code: PeerCloseCode = PeerCloseCode.peer_bye)

    /** The non-suspending form of [close], for a handler that runs inside the channel's call. */
    public fun closeNow(code: PeerCloseCode)

    /** Stop (true) or resume (false) reading from the pipe. Safe from any thread. */
    public fun pause(on: Boolean)
}

/** The peer was not admitted. [closeCode] is the channel's close code. */
public class LinkRefused(public val closeCode: String) : Exception("peer not admitted")

/** What a link reports. [onEstablished] returns the host object that [PeerLink.opened] resolves to. */
public class LinkHandlers<H>(
    public val onEstablished: (PeerLinkPort, SessionEvent.Established) -> H,
    public val onRecord: (PeerLinkPort, Int, ByteArray) -> Unit = { _, _, _ -> },
    public val onRing: (String, Long) -> Unit = { _, _ -> },
    public val onTrust: (String) -> Unit = {},
    public val onRingWanted: () -> Unit = {},
    public val onClosed: (SessionEvent.Closed) -> Unit = {},
    public val onEnded: () -> Unit = {},
)

/** The frame-and-event glue between one [PeerChannel] and one [PeerPipe]. */
public class PeerLink<H>(
    private val pipe: PeerPipe,
    private val scope: CoroutineScope,
    private val handlers: LinkHandlers<H>,
    handshakeSeconds: Double = HANDSHAKE_SECONDS,
    build: (send: (ByteArray) -> Unit, onEvent: (SessionEvent) -> Unit) -> PeerChannel,
) : PeerLinkPort {
    private val lock = Any()
    private val frames = FrameReader()
    private val outbound = Channel<ByteArray>(Channel.UNLIMITED)
    private var gate = CompletableDeferred<Unit>().also { it.complete(Unit) }
    private var wake: Job? = null
    private var deadline: Job? = null
    private var ended = false
    @Volatile private var lost = false

    // True once the host asked to end the link ([close], [closeNow]). Sdk-node and the Python engine run on
    // one thread, so a local close reaches its Closed event before any socket event can mark the pipe lost.
    // Here the reader runs on another thread: the CLOSE record can be flushed, the peer can hang up, and the
    // reader can see the end of the stream while the close still holds the channel's lock. The close the host
    // began first keeps its code; the pipe going away after it is its consequence, not connection_lost.
    @Volatile private var closing = false
    private var open = false
    private val queuedBytes = java.util.concurrent.atomic.AtomicLong()

    /** Resolves to the host object once the peer is admitted; fails with [LinkRefused] when it is not. */
    public val opened: CompletableDeferred<H> = CompletableDeferred()

    /** The channel this link drives. */
    public val channel: PeerChannel = build(::enqueue, ::onEvent)

    override val remoteAddress: String get() = pipe.remoteAddress

    /** True once the link has ended. */
    public val isEnded: Boolean get() = ended

    /** True once the reader has seen the pipe end (the link's tests wait on it to order a close against it). */
    internal val sawPipeEnd: Boolean get() = lost

    init {
        scope.launch {
            try {
                for (noise in outbound) {
                    pipe.write(encodeFrame(noise))
                    queuedBytes.addAndGet(-noise.size.toLong())
                }
            } catch (e: IOException) {
                outbound.close()
            } finally {
                pipe.close()
            }
        }
        deadline = scope.launch {
            delay((handshakeSeconds * MILLIS).toLong())
            fail(HANDSHAKE_FAILED)
        }
    }

    override fun toString(): String = "PeerLink"

    /** Read until the pipe ends. The caller starts it as a coroutine; for an initiator call [start] first. */
    public suspend fun run() {
        try {
            while (!ended) {
                val g = synchronized(lock) { gate }
                g.await()
                val chunk = pipe.read() ?: break
                data(chunk)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            // the pipe failed: the same as the end of the stream
        } finally {
            withContext(NonCancellable) {
                lost = true
                // Frames that arrived before the end were handled above; now end the channel.
                channel.close(PeerCloseCode.peer_bye)
                finish(SessionEvent.Closed("connection_lost", false))
            }
        }
    }

    /** Initiator: write message 1. */
    public suspend fun start() {
        channel.start()
        arm()
    }

    override fun pause(on: Boolean) {
        synchronized(lock) {
            if (on) {
                if (gate.isCompleted) gate = CompletableDeferred()
            } else {
                gate.complete(Unit)
            }
        }
    }

    override suspend fun sendRecord(type: Int, body: ByteArray): Unit = channel.sendRecord(type, body)

    override suspend fun close(code: PeerCloseCode) {
        closing = true
        channel.close(code)
    }

    override fun closeNow(code: PeerCloseCode) {
        closing = true
        scope.launch { channel.close(code) }
    }

    // -- internals -------------------------------------------------------------------------------

    /** The channel's output: queued for the writer, and the link closes `peer_busy` when the peer does not read. */
    private fun enqueue(noise: ByteArray) {
        if (queuedBytes.addAndGet(noise.size.toLong()) > LINK_WRITE_CAP && !ended) closeNow(PeerCloseCode.peer_busy)
        outbound.trySend(noise)
    }

    private suspend fun data(chunk: ByteArray) {
        if (ended) return
        val cut = frames.push(chunk)
        if (cut == null) {
            fail(PeerCloseCode.peer_bad_frame.name)
            return
        }
        for (f in cut) {
            if (ended) return
            if (!open && f.size > HANDSHAKE_FRAME_MAX) {
                fail(HANDSHAKE_FAILED)
                return
            }
            channel.receive(f)
        }
        arm()
    }

    private suspend fun arm() {
        synchronized(lock) {
            wake?.cancel()
            wake = null
        }
        if (ended) return
        val w = channel.wakeIn() ?: return
        val job = scope.launch {
            delay((maxOf(w, MIN_WAKE_SECONDS) * MILLIS).toLong())
            synchronized(lock) { wake = null }
            channel.tick()
            arm()
        }
        synchronized(lock) {
            wake?.cancel()
            wake = job
        }
    }

    private suspend fun fail(code: String) {
        if (ended) return
        // Not a live session: the channel has nothing to send.
        if (!open) finish(SessionEvent.Closed(code, false))
        channel.close(PeerCloseCode.peer_bye)
    }

    private fun onEvent(e: SessionEvent) {
        when (e) {
            is SessionEvent.Established -> {
                if (e.peerDeviceId == null) return
                deadline?.cancel()
                deadline = null
                open = true
                opened.complete(handlers.onEstablished(this, e))
            }

            is SessionEvent.Record -> handlers.onRecord(this, e.recordType, e.body)

            is SessionEvent.RingReceived -> handlers.onRing(e.jws, e.epoch)

            is SessionEvent.TrustUnverified -> handlers.onTrust(e.jws)

            SessionEvent.RingWanted -> handlers.onRingWanted()

            is SessionEvent.Sas -> Unit

            is SessionEvent.Closed -> finish(if (lost && !closing && !e.byPeer) SessionEvent.Closed("connection_lost", false) else e)
        }
    }

    private fun finish(c: SessionEvent.Closed) {
        synchronized(lock) {
            if (ended) return
            ended = true
            deadline?.cancel()
            wake?.cancel()
            deadline = null
            wake = null
            gate.complete(Unit)
        }
        handlers.onClosed(c)
        opened.completeExceptionally(LinkRefused(c.code))
        // Closing the queue flushes what the CLOSE record wrote, then the writer drops the pipe.
        outbound.close()
        closePipeSoon(c.code == PeerCloseCode.peer_busy.name)
        handlers.onEnded()
    }

    /**
     * A link that ends closes its socket (G10): a writer blocked on a peer that never reads, and a reader
     * blocked in a read, are released when the pipe closes. `peer_busy` does not linger (the peer is not
     * reading, so it waits only [BUSY_FLUSH_MILLIS], long enough for a writer that is not blocked to put the CLOSE
     * record on the pipe first); any other end waits [CLOSE_GRACE_MILLIS] for the CLOSE record.
     */
    private fun closePipeSoon(now: Boolean) {
        val job = scope.launch {
            delay(if (now) BUSY_FLUSH_MILLIS else CLOSE_GRACE_MILLIS)
            pipe.close()
        }
        // A scope that is cancelled before the grace runs out still closes the pipe.
        job.invokeOnCompletion { pipe.close() }
    }
}

/** Start an initiator link and wait for it to be admitted (or refused); [timeoutMillis] bounds the wait. */
public suspend fun <H> openInitiator(link: PeerLink<H>, timeoutMillis: Long? = null): H {
    link.start()
    return if (timeoutMillis != null) withTimeout(timeoutMillis) { link.opened.await() } else link.opened.await()
}
