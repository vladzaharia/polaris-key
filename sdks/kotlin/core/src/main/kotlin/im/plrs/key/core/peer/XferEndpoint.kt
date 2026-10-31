// WIRE-CONTRACT-V5 section 15.11: runs an [XferMachine] over a session. The machine decides; this layer performs
// what it asks, in order: effects on the partial files, then the records, then the events for the host. It reads
// the sender's bytes and stores the receiver's through ports. A source failure cancels the transfer without a
// `DONE`; a store failure closes the session `peer_bye` and keeps the partials. Mirrors client-core's
// `peer/xferEndpoint.ts`. The host API (`cloudConnect.transfer`) is the SDK's, on top of this.

package im.plrs.key.core.peer

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the host sees of a transfer. The callbacks run on the endpoint's worker, in order. */
public interface XferEvents {
    /** The host is asked about an `OFFER`; it answers with [XferEndpoint.consent]. */
    public fun ask(a: XferAsk)

    /** The question for this id is withdrawn (the peer or a timer ended the transfer). */
    public fun withdraw(id: String)

    public fun result(r: XferResult)

    /** The host's own `offer` was refused locally: too many live transfers. */
    public fun refused(id: String)

    /** A port failed; the session is being closed and the partials are kept. */
    public fun error(err: Throwable)
}

/** The ports an endpoint performs through. */
public class XferPorts(
    /** The writer [PeerLinkPort.attachXfer] returned. */
    public val send: suspend (type: Int, body: ByteArray) -> Unit,
    /** Close the session with a code (non-suspending). */
    public val close: (PeerCloseCode) -> Unit,
    /** The sender's source: [length] bytes at [offset] of the transfer [id]. */
    public val read: suspend (id: String, offset: Long, length: Int) -> ByteArray,
    /** The receiver's store: an effect on the partial files, or a write into one. */
    public val apply: suspend (XferEffect) -> Unit,
    public val events: XferEvents,
)

/** An endpoint over one session. Thread-safe: every call is queued and performed in order on one worker. */
public class XferEndpoint(
    private val machine: XferMachine,
    private val ports: XferPorts,
    private val scope: CoroutineScope,
    /** Seconds on the machine's clock (must not run backwards). */
    private val now: () -> Double,
    /** How many times faster than real time [now] runs (tests only); a wait of w machine seconds lasts w / speed. */
    private val speed: Double = 1.0,
) {
    private val lock = Any()
    private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private val chunks = HashMap<String, Int>()

    /** Outgoing transfers the host cancelled: what they still have queued is not sent. */
    private val stopped = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private var timer: Job? = null
    private var dead = false

    private val worker: Job = scope.launch {
        for (job in queue) {
            try {
                job()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // a host callback never ends the worker
            }
        }
    }

    /** A record of the session: one of the six types. */
    public fun receive(type: Int, body: ByteArray) {
        synchronized(lock) {
            if (dead || !isXferType(type)) return
            guarded { handle(machine.receive(now(), type, body)) }
        }
    }

    /** The host sends an `OFFER`. */
    public fun offer(a: XferOfferArgs) {
        synchronized(lock) {
            val out = machine.offer(now(), a)
            if (!out.refused) chunks[a.id] = a.chunk
            handle(out, a.id)
        }
    }

    /** The host's answer to an `ask`. */
    public fun consent(id: String, accept: Boolean) {
        synchronized(lock) { guarded { handle(machine.consent(now(), id, accept)) } }
    }

    /** The host cancels a transfer. */
    public fun cancel(id: String) {
        synchronized(lock) {
            guarded {
                val out = machine.cancel(now(), id)
                if (out.send.any { it is XferSend.Cancel && it.id == id }) stopped += id
                handle(out)
            }
        }
    }

    /** The session closed: every live transfer ends `closed` and the partials stay. */
    public fun closed() {
        synchronized(lock) {
            if (dead) return
            handle(machine.abandon(now()))
            dead = true
            timer?.cancel()
            timer = null
            queue.close()
        }
    }

    /** Resolves when everything queued so far has been performed. */
    public suspend fun idle() {
        val d = CompletableDeferred<Unit>()
        val ok = synchronized(lock) { queue.trySend { d.complete(Unit) }.isSuccess }
        if (ok) d.await() else worker.join()
    }

    // -- internals -------------------------------------------------------------------------------------------

    /**
     * A failure inside the machine or a host callback it calls ends this session (`peer_bye`, partials kept), never
     * the caller: the transport's thread, or the SDK's scope.
     */
    private fun guarded(f: () -> Unit) {
        try {
            f()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            queue.trySend { ports.events.error(e) }
            ports.close(PeerCloseCode.peer_bye)
            handle(machine.abandon(now()))
            dead = true
            queue.close()
        }
    }

    private fun handle(out: XferOut, offered: String? = null) {
        val failed = LinkedHashSet<String>()
        queue.trySend {
            try {
                for (e in out.partial) ports.apply(e)
                for (s in out.send) perform(s, failed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ports.events.error(e)
                ports.close(PeerCloseCode.peer_bye)
                return@trySend
            }
            for (id in out.withdraw) ports.events.withdraw(id)
            out.ask?.let { ports.events.ask(it) }
            if (out.refused && offered != null) ports.events.refused(offered)
            for (r in out.results) ports.events.result(r)
            for (id in failed) synchronized(lock) { if (!dead) handle(machine.fail(now(), id)) }
        }
        val c = out.close
        if (c != null) {
            ports.close(c)
            handle(machine.abandon(now()))
            dead = true
            queue.close()
        }
        arm()
    }

    private suspend fun perform(s: XferSend, failed: MutableSet<String>) {
        when (s) {
            is XferSend.Offer -> ports.send(
                XferType.OFFER,
                xferOfferBody(XferOfferBody(s.id, s.size, s.sha256, s.chunk, s.name, s.type, s.cat)),
            )

            is XferSend.Accept -> ports.send(XferType.ACCEPT, xferOffsetBody(s.id, s.offset))

            is XferSend.Ack -> ports.send(XferType.ACK, xferOffsetBody(s.id, s.offset))

            is XferSend.Done -> if (s.id !in failed && s.id !in stopped) ports.send(XferType.DONE, xferDoneBody(s.id, s.sha256))

            is XferSend.Cancel -> ports.send(XferType.CANCEL, xferCancelBody(s.id, s.reason))

            is XferSend.Chunks -> {
                if (s.id in failed || s.id in stopped) return
                val chunk = chunks[s.id] ?: return
                var at = s.offset
                while (at < s.offset + s.bytes) {
                    if (s.id in stopped) return
                    val len = minOf(chunk.toLong(), s.offset + s.bytes - at).toInt()
                    val data = try {
                        ports.read(s.id, at, len).also { check(it.size == len) { "source length" } }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // The source failed: the transfer ends here, and its `DONE` never goes out.
                        failed += s.id
                        return
                    }
                    ports.send(XferType.CHUNK, xferChunkBody(s.id, at, data))
                    at += chunk
                }
            }
        }
    }

    /** One timer, set for the machine's next wait (callers hold the lock). */
    private fun arm() {
        timer?.cancel()
        timer = null
        if (dead) return
        val at = machine.nextDeadline() ?: return
        val ms = (maxOf(0.0, at - now()) * 1000 / speed).toLong() + 1
        timer = scope.launch {
            delay(ms)
            synchronized(lock) {
                timer = null
                if (!dead) handle(machine.tick(now()))
            }
        }
    }
}
