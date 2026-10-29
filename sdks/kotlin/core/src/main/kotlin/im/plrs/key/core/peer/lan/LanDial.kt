// Dialling several learned addresses for one device (WIRE-CONTRACT-V5 section 15.4.1, RFC 8305;
// CC-IPV6.5b): the addresses are tried in first-seen order, at most two attempts in flight, a new one
// every 250 ms (at once when one fails). The text of an address is judged before a socket exists; the
// first connection that passes the verdict on its own addresses wins; every other socket is closed
// before a byte is sent on it. Mirrors sdk-node's `connect/dial.ts`. Only the standard library, so it
// runs on Android API 24.

package im.plrs.key.core.peer.lan

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/** Milliseconds between attempts. */
public const val LAN_DIAL_STAGGER_MILLIS: Long = 250

/** Attempts in flight at once. */
public const val LAN_DIAL_MAX_IN_FLIGHT: Int = 2

/**
 * What a dial needs: [allowLoopback] is for tests only; [timeoutMillis] bounds the whole race and each
 * connect; [staggerMillis] is the gap between attempts; [connector] opens one connection (a test replaces it).
 */
public class LanDialOptions(
    public val allowLoopback: Boolean = false,
    public val timeoutMillis: Int,
    public val staggerMillis: Long = LAN_DIAL_STAGGER_MILLIS,
    public val connector: (Socket, InetSocketAddress, Int) -> Unit = { s, a, t -> s.connect(a, t) },
) {
    override fun toString(): String = "LanDialOptions"
}

/** One race: the state the attempts share. */
private class Race(val hosts: List<String>, val port: Int, val o: LanDialOptions) {
    val lock = Any()
    val live = ArrayList<Socket>()
    val result = CompletableDeferred<Socket>()
    var next = 0
    var inFlight = 0

    @Volatile
    var over = false
    var last: Exception = IOException("no address")

    /** True while an attempt could still be started. */
    fun more(): Boolean = !over && synchronized(lock) { next < hosts.size }

    /** The next host to try, or null at the cap, at the end, or when the race is over. */
    fun take(): String? = synchronized(lock) {
        if (over || next >= hosts.size || inFlight >= LAN_DIAL_MAX_IN_FLIGHT) {
            null
        } else {
            inFlight++
            hosts[next++]
        }
    }

    /** Register a socket; false (and it is closed) when the race is over. */
    fun register(s: Socket): Boolean = synchronized(lock) {
        if (!over) live += s
        !over
    }.also { if (!it) closeQuietly(s) }

    fun win(s: Socket) {
        val others = synchronized(lock) {
            if (over) {
                listOf(s)
            } else {
                over = true
                live.remove(s)
                result.complete(s)
                live.toList().also { live.clear() }
            }
        }
        others.forEach(::closeQuietly)
    }

    /** An attempt ended without a connection; true when another should start at once. */
    fun lose(s: Socket, e: Exception): Boolean {
        closeQuietly(s)
        return synchronized(lock) {
            live.remove(s)
            last = e
            inFlight--
            val exhausted = next >= hosts.size && inFlight == 0
            if (!over && exhausted) {
                over = true
                result.completeExceptionally(last)
            }
            !over && next < hosts.size
        }
    }

    fun end() {
        val rest = synchronized(lock) {
            over = true
            live.toList().also { live.clear() }
        }
        rest.forEach(::closeQuietly)
    }
}

private fun closeQuietly(s: Socket) {
    runCatching { s.close() }
}

/** Connect [s] to [host] and judge the connected socket's own addresses before anything is written; throws on any failure. */
private fun connectJudged(r: Race, s: Socket, host: String) {
    val address = inetAddressOfLiteral(host)?.takeIf { r.register(s) } ?: throw IOException("address refused")
    r.o.connector(s, InetSocketAddress(address, r.port), r.o.timeoutMillis)
    val verdict = socketVerdict(literalOfInetAddress(s.inetAddress), literalOfInetAddress(s.localAddress), r.o.allowLoopback)
    if (!verdict.dial) throw IOException("address refused")
}

private fun CoroutineScope.launchAttempt(r: Race, host: String) {
    launch(Dispatchers.IO) {
        val s = Socket()
        val failure = runCatching { connectJudged(r, s, host) }.exceptionOrNull()
        if (failure == null) {
            r.win(s)
        } else if (r.lose(s, failure as? Exception ?: IOException(failure))) {
            r.take()?.let { launchAttempt(r, it) }
        }
    }
}

/**
 * Race [hosts] on [port]; resolves with the winning connected socket. Throws [IOException] when no
 * address connects (the last failure), when none is a LAN address, or after [LanDialOptions.timeoutMillis].
 */
public suspend fun lanDialRace(hosts: List<String>, port: Int, o: LanDialOptions): Socket {
    val tried = hosts.filter { textVerdict(it, o.allowLoopback) }
    if (tried.isEmpty()) throw IOException("address refused")
    val r = Race(tried, port, o)
    return try {
        withTimeout(o.timeoutMillis.toLong()) {
            coroutineScope {
                r.take()?.let { launchAttempt(r, it) }
                val ticker = launch {
                    while (r.more()) {
                        delay(o.staggerMillis)
                        r.take()?.let { launchAttempt(r, it) }
                    }
                }
                try {
                    r.result.await()
                } finally {
                    ticker.cancel()
                    r.end() // every socket but the winner closes before a byte is sent on it
                }
            }
        }
    } catch (e: TimeoutCancellationException) {
        throw IOException("timeout", e)
    }
}
