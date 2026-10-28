// Outgoing pacing for the relay socket (CC-12.14, decision D-9; WIRE-CONTRACT-V5 section 15.7, G17).
// The room allows a client 200 messages a second with a burst of 400 and answers a client that exceeds
// it with LIMIT 1 and, if it persists, a close; this client stays under it:
// - a token bucket on every outgoing envelope: 180 a second with a burst of 360 (0.9 of the room's);
// - LIMIT 1 halves the rate for 10 seconds;
// - the queue behind the socket holds at most 8 MiB. A host send that would go beyond it is refused
//   with `rate_limited` before anything is encrypted, so the session's keys never advance for a message
//   that was not queued.
// Mirrors the Python `connect/pacer.py`. Pure bookkeeping over an injected clock and sleep: nothing here
// touches a socket.

package im.plrs.key.sdk

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Envelopes a second the client sends. */
internal const val PACER_RATE: Double = 180.0

/** Envelopes it may send at once after a quiet spell. */
internal const val PACER_BURST: Double = 360.0

/** Seconds a LIMIT 1 halves the rate for. */
internal const val PACER_HALVED_SECONDS: Double = 10.0

/** Bytes the queue behind the socket may hold. */
internal const val OUTBOX_MAX_BYTES: Long = 8L * 1024 * 1024

private const val MILLIS = 1000
private const val DRAIN_POLL_MILLIS = 5L

/** A token bucket. [acquire] waits until one token is available. */
internal class Pacer(
    private val rate: Double = PACER_RATE,
    private val burst: Double = PACER_BURST,
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
    private val sleep: suspend (Double) -> Unit = { s -> delay((s * MILLIS).toLong()) },
) {
    private val lock = Any()
    private var tokens = burst
    private var at = clock()
    private var halvedUntil = Double.NEGATIVE_INFINITY

    /** The rate in force now: half the base rate while a LIMIT 1 is being honoured. */
    val currentRate: Double get() = if (clock() < halvedUntil) rate / 2 else rate

    /** LIMIT 1: send at half the rate for [seconds]. */
    fun halve(seconds: Double = PACER_HALVED_SECONDS) {
        synchronized(lock) {
            refill()
            halvedUntil = clock() + seconds
            tokens = minOf(tokens, burst / 2)
        }
    }

    private fun refill() {
        val now = clock()
        if (now > at) tokens = minOf(burst, tokens + (now - at) * currentRate)
        at = now
    }

    /** 0.0 when a token was taken; else how many seconds until one is available. */
    fun tryTake(): Double = synchronized(lock) {
        refill()
        if (tokens >= 1) {
            tokens -= 1
            0.0
        } else {
            (1 - tokens) / currentRate
        }
    }

    suspend fun acquire() {
        while (true) {
            val wait = tryTake()
            if (wait <= 0) return
            sleep(wait)
        }
    }

    override fun toString(): String = "Pacer"
}

/**
 * The envelopes waiting for the socket, with their byte count. [put] refuses (false) a non-forced item
 * that would take the queue past [maxBytes]; handshake and control envelopes are forced, since refusing
 * one would stall a session without telling the host.
 */
internal class Outbox(val maxBytes: Long = OUTBOX_MAX_BYTES) {
    private val q = Channel<ByteArray>(Channel.UNLIMITED)
    private val bytes = AtomicLong()
    private val inflight = AtomicBoolean()

    /** Bytes queued. */
    val queued: Long get() = bytes.get()

    fun roomFor(n: Int): Boolean = bytes.get() + n <= maxBytes

    fun put(data: ByteArray, force: Boolean = false): Boolean {
        if (!force && !roomFor(data.size)) return false
        bytes.addAndGet(data.size.toLong())
        return q.trySend(data).isSuccess
    }

    /** The next item, or null once the box is closed and empty. */
    suspend fun get(): ByteArray? {
        val d = q.receiveCatching().getOrNull() ?: return null
        bytes.addAndGet(-d.size.toLong())
        inflight.set(true)
        return d
    }

    /** The item [get] returned has been written (or given up on). */
    fun sent() = inflight.set(false)

    fun close() {
        q.close()
    }

    /** Wait (polling) until nothing is queued, or [timeoutMillis]. */
    suspend fun drained(timeoutMillis: Long): Boolean {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (bytes.get() > 0 || inflight.get()) {
            if (System.nanoTime() >= end) return false
            delay(DRAIN_POLL_MILLIS)
        }
        return true
    }

    override fun toString(): String = "Outbox"
}
