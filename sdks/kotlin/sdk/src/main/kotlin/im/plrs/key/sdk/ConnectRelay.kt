// The relay half of Cloud Connect, socket side (CC-12.13; WIRE-CONTRACT-V5 section 15.7). One WebSocket
// to the account room carries envelopes. Mirrors the socket half of sdk-node's `connect/relay.ts` and the
// Python `connect/relay.py`. The peer sessions that ride the socket are CC-12.14.
//
// WebSocket API: OkHttp 4.12 (plan section 3; `:core` already depends on it), so the same code runs on
// the JVM and on Android. The JDK's `java.net.http.WebSocket` is not available on Android API 24.
//
// Rules this file keeps:
// - a ticket is single use and lives 60 seconds, so every connect fetches a new one. The socket is
//   opened offering `pkey-relay.1` and then the ticket as subprotocols, and the client requires
//   `pkey-relay.1` echoed back (G14). The ticket is never logged, stored past the open or put in an
//   error: the client has no interceptors or event listener of the host, and a failed open reports no
//   cause (G13);
// - the socket never follows a redirect, so the ticket goes only to the host it was issued for, and it
//   offers no compression (R-6P B1); the TLS settings are the platform's and are never turned off;
// - a message is at most 65,564 bytes; an envelope that fails its layout, or a text frame, closes the
//   socket with 1002 and is never answered (G14); each running service has one socket;
// - the room stamps `from`; this file never uses it for identity;
// - reconnects back off exponentially with equal jitter and a floor, and the backoff resets only after
//   the socket stayed up 30 seconds. `Retry-After` is capped at 3,600 seconds. A product that turned the
//   relay off, or a spent quota, ends the loop with a typed error; 4009 (replaced) stops without
//   fighting back; 4003 fetches the roster once and stops after three in a row; 4001 simply gets a new
//   ticket; after five attempts that never open the status is `unavailable` and a retry waits at least
//   five minutes (G15);
// - `stop()` is bounded: it gives up waiting after 15 seconds (R-6P S6).

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.RELAY_MAX_MESSAGE
import im.plrs.key.core.peer.RelayDirection
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.decodeRelay
import im.plrs.key.core.peer.encodeRelay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.EventListener
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList

/** The only mode that may cross the relay (G16). */
internal val RELAY_MODES: List<String> = listOf("a")

private const val MAX_RETRY_AFTER_S = 3600.0

/** After this many attempts that never opened, the status is `unavailable` and retries slow down. */
private const val UNAVAILABLE_AFTER = 5
private const val UNAVAILABLE_RETRY_S = 300.0
private const val IDENTITY_TTL_S = 30L
private const val CERT_MARGIN_S = 60L
private const val MILLIS = 1000
private const val STOP_TIMEOUT_MILLIS = 15_000L
private const val PING_BYTES = 8
private const val MAX_BACKOFF_EXPONENT = 16
private const val NOT_MEMBER_LIMIT = 3
private const val CLOSE_REPLACED = 4009
private const val CLOSE_NOT_MEMBER = 4003
private const val CLOSE_LIMIT = 4008
private const val CLOSE_BAD_FRAME = 1002
private const val CLOSE_TOO_BIG = 1009
private const val CLOSE_NORMAL = 1000
private const val LIMIT_RATE = 1
private const val LIMIT_PERSON = 2
private const val LIMIT_PRODUCT = 3
private const val LIMIT_PAUSED = 4

/** Bytes a socket may hold unsent before it is closed (R-6P S5). */
internal const val RELAY_WRITE_CAP: Long = 8L * 1024 * 1024

/** Throws [RelayException] (`mode_not_allowed`) for a mode the relay must never carry. */
internal fun assertRelayMode(mode: String): String {
    if (mode != "a") throw RelayException(RelayErrorReason.mode_not_allowed, "Mode $mode never crosses the relay; it is LAN only.")
    return "a"
}

/** Where the relay loop is. */
internal enum class RelayState { idle, connecting, open, backoff, unavailable, blocked, off, stopped }

internal data class RelayStatus(val state: RelayState, val error: RelayException?, val attempts: Int, val reason: String? = null)

/** The socket closed (or could not open). [code] is the close code; null when there was none. */
internal class SocketClosed(val code: Int?) : Exception("socket closed")

/** One WebSocket message in. */
internal sealed class RelayFrame {
    class Binary(val bytes: ByteArray) : RelayFrame()

    object Text : RelayFrame()
}

/** What the service uses of a WebSocket: binary messages in and out. [receive] throws [SocketClosed]. */
internal interface RelaySocket {
    suspend fun send(data: ByteArray)

    suspend fun receive(): RelayFrame

    suspend fun close(code: Int = CLOSE_NORMAL)
}

internal typealias RelayOpener = suspend (url: String, protocols: List<String>) -> RelaySocket

internal class RelayOptions(
    /** Opens a socket; default [okHttpOpener]. */
    val opener: RelayOpener? = null,
    /** Sleeps; tests pass a manual one. */
    val sleep: (suspend (Double) -> Unit)? = null,
    val random: (() -> Double)? = null,
    /** Monotonic seconds. */
    val clock: () -> Double = { System.nanoTime() / 1e9 },
    val caps: List<String> = listOf("app/1"),
    val label: String? = null,
    /** Reconnect backoff: base 1 s, doubling to 60 s, with equal jitter; never under [backoffMin]. */
    val backoffBase: Double = 1.0,
    val backoffMax: Double = 60.0,
    val backoffMin: Double = 0.5,
    /** How long a socket must stay open before the backoff resets. */
    val stableSeconds: Double = 30.0,
    val pingSeconds: Double = 25.0,
    /** Wait for the socket to open. */
    val openSeconds: Double = 15.0,
    val maxSessions: Int = 64,
    val maxPendingPerPeer: Int = 4,
    val handshakeSeconds: Double = 30.0,
    val rekeyMessages: Int? = null,
    val rekeySeconds: Double? = null,
)

// -- the default opener (OkHttp) ---------------------------------------------------------------------

private class OkSocket(private val ws: WebSocket) : RelaySocket {
    val incoming = Channel<RelayFrame>(Channel.UNLIMITED)

    @Volatile
    var endCode: Int? = null

    override suspend fun send(data: ByteArray) {
        if (ws.queueSize() + data.size > RELAY_WRITE_CAP || !ws.send(data.toByteString())) {
            // A peer that never reads: drop the socket rather than grow the buffer.
            ws.cancel()
            throw SocketClosed(endCode)
        }
    }

    override suspend fun receive(): RelayFrame {
        val f = incoming.receiveCatching().getOrNull()
        if (f != null) return f
        throw SocketClosed(endCode)
    }

    override suspend fun close(code: Int) {
        if (endCode == null) endCode = code
        try {
            ws.close(code, null)
        } catch (e: IllegalArgumentException) {
            ws.close(CLOSE_NORMAL, null)
        }
    }

    override fun toString(): String = "RelaySocket"
}

/**
 * The default opener over OkHttp. It offers `["pkey-relay.1", <ticket>]`, requires `pkey-relay.1` echoed
 * back and no negotiated extension, caps messages at 65,564 bytes, follows no redirect, runs none of the
 * host's interceptors and never turns TLS verification off. [allowPlainLoopback] accepts `ws://` to a
 * loopback host, for tests only.
 */
internal fun okHttpOpener(client: OkHttpClient? = null, openSeconds: Double = 15.0, allowPlainLoopback: Boolean = false): RelayOpener {
    val http = (client ?: OkHttpClient()).newBuilder().apply {
        interceptors().clear()
        networkInterceptors().clear()
        eventListener(EventListener.NONE)
        followRedirects(false)
        followSslRedirects(false)
        retryOnConnectionFailure(false)
        readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
        pingInterval(0, java.util.concurrent.TimeUnit.MILLISECONDS)
        // Ciphertext does not compress: never offer permessage-deflate. (OkHttp runs no network
        // interceptor for a WebSocket, so this is an application interceptor.)
        addInterceptor(
            Interceptor { chain -> chain.proceed(chain.request().newBuilder().removeHeader("Sec-WebSocket-Extensions").build()) },
        )
    }.build()
    return { url, protocols ->
        val plain = allowPlainLoopback && url.startsWith("ws://127.")
        if (!url.startsWith("wss:") && !plain) throw SocketClosed(null)
        val request = try {
            Request.Builder().url(url).header("Sec-WebSocket-Protocol", protocols.joinToString(", ")).build()
        } catch (e: IllegalArgumentException) {
            throw SocketClosed(null) // no cause: the message could name the URL
        }
        val opened = CompletableDeferred<OkSocket>()
        var sock: OkSocket? = null
        val ws = http.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val echoed = response.header("Sec-WebSocket-Protocol")
                    if (echoed != RELAY_PROTOCOL || response.header("Sec-WebSocket-Extensions") != null) {
                        webSocket.close(CLOSE_BAD_FRAME, null)
                        opened.completeExceptionally(SocketClosed(CLOSE_BAD_FRAME))
                        return
                    }
                    val s = OkSocket(webSocket)
                    sock = s
                    opened.complete(s)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    sock?.incoming?.trySend(RelayFrame.Text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    val s = sock ?: return
                    if (bytes.size > RELAY_MAX_MESSAGE) {
                        s.endCode = CLOSE_TOO_BIG
                        webSocket.close(CLOSE_TOO_BIG, null)
                        s.incoming.close()
                        return
                    }
                    s.incoming.trySend(RelayFrame.Binary(bytes.toByteArray()))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    sock?.let {
                        if (it.endCode == null) it.endCode = code
                        it.incoming.close()
                    }
                    try {
                        webSocket.close(CLOSE_NORMAL, null)
                    } catch (e: IllegalArgumentException) {
                        webSocket.cancel()
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    sock?.let {
                        if (it.endCode == null) it.endCode = code
                        it.incoming.close()
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    // No cause is kept: a handshake error could carry the request.
                    opened.completeExceptionally(SocketClosed(null))
                    sock?.incoming?.close()
                }
            },
        )
        try {
            withTimeout((openSeconds * MILLIS).toLong()) { opened.await() }
        } catch (e: TimeoutCancellationException) {
            ws.cancel()
            throw SocketClosed(null)
        } catch (e: CancellationException) {
            ws.cancel()
            throw e
        }
    }
}

// -- the service -------------------------------------------------------------------------------------

private class HeldIdentity(val at: Long, val source: PeerSource)

internal class RelayService(
    private val src: LanSource,
    private val ticket: suspend () -> RelayGrant,
    private val o: RelayOptions = RelayOptions(),
    scope: CoroutineScope? = null,
) {
    private val ownsScope = scope == null
    private val scope: CoroutineScope = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val opener: RelayOpener = o.opener ?: okHttpOpener(null, o.openSeconds)
    private val sleeper: suspend (Double) -> Unit = o.sleep ?: { s -> delay((s * MILLIS).toLong()) }
    private val rand: () -> Double = o.random ?: { Math.random() }
    private val rng = SecureRandom()
    private val lock = Any()

    @Volatile
    private var stateNow = RelayState.idle

    @Volatile
    private var errorNow: RelayException? = null
    private var reasonNow: String? = null

    @Volatile
    private var attempts = 0

    @Volatile
    private var stopped = false
    private var started = false

    @Volatile
    private var ws: RelaySocket? = null

    @Volatile
    private var openNow = false
    private val memberSet = HashSet<String>()
    private val stateFns = CopyOnWriteArrayList<(RelayStatus) -> Unit>()
    private val memberFns = CopyOnWriteArrayList<(List<String>) -> Unit>()
    private val waiters = ArrayList<CompletableDeferred<Unit>>()

    @Volatile
    private var sleeping: CompletableDeferred<Unit>? = null
    private var lastLimit: Int? = null
    private var notMember = 0
    private var task: Job? = null
    private val idLock = kotlinx.coroutines.sync.Mutex()

    @Volatile
    private var held: HeldIdentity? = null

    @Volatile
    private var outbox: Channel<ByteArray>? = null
    private val docs = PeerDocs(
        PeerDocsSource(src.now, src.refresh, src.adoptRing, src.applyTrust),
        onStored = { held = null },
        scope = this.scope,
    )

    override fun toString(): String = "RelayService(state=${stateNow.name})"

    // -- the surface -------------------------------------------------------------------------------

    /** Begin connecting; use [ready] to wait for the socket. */
    fun start() {
        synchronized(lock) {
            if (started || stopped) return
            started = true
        }
        task = scope.launch { loop() }
    }

    val status: RelayStatus get() = RelayStatus(stateNow, errorNow, attempts, reasonNow)

    fun onState(fn: (RelayStatus) -> Unit): () -> Unit {
        stateFns += fn
        return { stateFns -= fn }
    }

    /** Called when the room's member list changes (device ids of this person's online devices). */
    fun onMembers(fn: (List<String>) -> Unit): () -> Unit {
        memberFns += fn
        return { memberFns -= fn }
    }

    fun onNotice(fn: (ConnectNotice) -> Unit): () -> Unit = docs.onNotice(fn)

    /** The person's devices online in the room, as of the last MEMBERS (this device included). */
    fun members(): List<String> = synchronized(lock) { memberSet.sorted() }

    /**
     * Ask the room who is online now (a LIST); returns on the answer or after [timeoutMillis]. The room
     * never pushes joins, so this is how a device learns of a new arrival.
     */
    suspend fun refreshMembers(timeoutMillis: Long = 2000): List<String> {
        if (!openNow) return members()
        val done = CompletableDeferred<Unit>()
        val off = onMembers { done.complete(Unit) }
        try {
            sendEnv(RelayMessage.List)
            withTimeoutOrNull(timeoutMillis) { done.await() }
        } finally {
            off()
        }
        return members()
    }

    /** Resolves once the socket is open; throws the typed error when the loop is blocked. */
    suspend fun ready(timeoutMillis: Long? = null) {
        if (openNow) return
        if (stateNow == RelayState.blocked || stateNow == RelayState.stopped || stateNow == RelayState.off) {
            throw errorNow ?: stoppedError()
        }
        if (!started) start()
        val w = CompletableDeferred<Unit>()
        synchronized(lock) { waiters += w }
        try {
            val ok = withTimeoutOrNull(timeoutMillis ?: (o.openSeconds * MILLIS).toLong()) { w.await() }
            if (ok == null) throw errorNow ?: RelayException(RelayErrorReason.not_connected, "The relay is not connected.")
        } finally {
            synchronized(lock) { waiters -= w }
        }
    }

    /** After a block (a quota), try again now; otherwise cut a backoff short. */
    fun resume() {
        if (stopped) return
        if (stateNow == RelayState.blocked) {
            errorNow = null
            attempts = 0
            started = true
            set(RelayState.connecting)
            task = scope.launch { loop() }
        } else {
            sleeping?.complete(Unit)
        }
    }

    /** Stop the loop, close the socket and end every session. Gives up waiting after 15 seconds. */
    suspend fun stop() {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        docs.close()
        set(RelayState.stopped)
        loseLinks()
        val s = ws
        ws = null
        openNow = false
        sleeping?.complete(Unit)
        withTimeoutOrNull(STOP_TIMEOUT_MILLIS) {
            if (s != null) quiet { s.close(CLOSE_NORMAL) }
            val t = task
            if (t != null) {
                t.cancel()
                t.join()
            }
        }
        task?.cancel()
        flush(stoppedError())
        if (ownsScope) scope.cancel()
    }

    // -- the connect loop --------------------------------------------------------------------------

    private suspend fun loop() {
        while (!stopped) {
            set(RelayState.connecting)
            var code: Int? = null
            var waitS = 0.0
            try {
                val grant = ticket()
                if (stopped) return
                code = session(grant)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (stopped) return
                val err = e as? RelayException ?: RelayException(RelayErrorReason.unavailable, "The relay could not be reached.")
                errorNow = err
                if (err.reason == RelayErrorReason.disabled || err.reason == RelayErrorReason.quota) {
                    block(err)
                    return
                }
                waitS = ((e as? PolarisException)?.retryAfterSeconds ?: 0).toDouble()
            }
            if (stopped) return
            val end = afterClose(code)
            if (end != null) {
                block(end)
                return
            }
            attempts++
            var wait = maxOf(backoff(), minOf(waitS, MAX_RETRY_AFTER_S))
            if (attempts >= UNAVAILABLE_AFTER) {
                set(RelayState.unavailable)
                wait = maxOf(wait, UNAVAILABLE_RETRY_S)
            } else {
                set(RelayState.backoff)
            }
            nap(wait)
        }
    }

    private suspend fun nap(seconds: Double) {
        val gate = CompletableDeferred<Unit>()
        sleeping = gate
        val j = scope.launch {
            sleeper(seconds)
            gate.complete(Unit)
        }
        try {
            gate.await()
        } finally {
            j.cancel()
            sleeping = null
        }
    }

    /** What a close means for the loop: null to reconnect, else the error that ends it. */
    private fun afterClose(code: Int?): RelayException? {
        val limit = lastLimit
        lastLimit = null
        if (code == null) return null
        if (code == CLOSE_REPLACED) {
            return RelayException(RelayErrorReason.replaced, "Another connection of this device took the relay socket.", closeCode = code.toString())
        }
        if (code == CLOSE_NOT_MEMBER) {
            // The roster this device holds is out of date: fetch it, and stop if it keeps happening.
            wantRing()
            notMember++
            return if (notMember >= NOT_MEMBER_LIMIT) {
                RelayException(RelayErrorReason.not_member, "The room does not know this device.", closeCode = code.toString())
            } else {
                null
            }
        }
        notMember = 0
        if (code == CLOSE_LIMIT && (limit == LIMIT_PERSON || limit == LIMIT_PRODUCT)) {
            return RelayException(
                RelayErrorReason.quota,
                "The relay quota is spent.",
                closeCode = code.toString(),
                scope = if (limit == LIMIT_PRODUCT) RelayQuotaScope.product else RelayQuotaScope.person,
            )
        }
        return null
    }

    private fun block(e: RelayException) {
        errorNow = e
        openNow = false
        set(RelayState.blocked)
        flush(e)
    }

    private fun backoff(): Double {
        val cap = minOf(o.backoffMax, o.backoffBase * Math.pow(2.0, minOf(maxOf(attempts - 1, 0), MAX_BACKOFF_EXPONENT).toDouble()))
        // Equal jitter: half fixed, half random, never under the floor.
        return maxOf(o.backoffMin, cap / 2 + rand() * cap / 2)
    }

    // -- one socket --------------------------------------------------------------------------------

    /** Open one socket and run it to its close. Returns the close code. */
    private suspend fun session(grant: RelayGrant): Int? {
        val s = try {
            withTimeoutOrNull(((o.openSeconds + 1) * MILLIS).toLong()) { opener(grant.url, listOf(RELAY_PROTOCOL, grant.ticket)) }
        } catch (e: SocketClosed) {
            return e.code
        } ?: return null
        if (stopped) {
            quiet { s.close(CLOSE_NORMAL) }
            return null
        }
        ws = s
        openNow = true
        val openedAt = o.clock()
        lastLimit = null
        errorNow = null
        val q = Channel<ByteArray>(Channel.UNLIMITED)
        outbox = q
        set(RelayState.open)
        val ready = synchronized(lock) { waiters.toList().also { waiters.clear() } }
        for (w in ready) w.complete(Unit)
        val writer = scope.launch {
            try {
                for (b in q) s.send(b)
            } catch (e: SocketClosed) {
                // the reader sees the close
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // the reader sees the close
            }
        }
        val pinger = scope.launch { ping(s) }
        sendEnv(RelayMessage.List)
        var code: Int? = null
        try {
            while (true) {
                val f = s.receive()
                if (f !is RelayFrame.Binary) {
                    code = refuse(s)
                    break
                }
                try {
                    handle(f.bytes)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    code = refuse(s)
                    break
                }
            }
        } catch (e: SocketClosed) {
            code = e.code
        } finally {
            writer.cancel()
            pinger.cancel()
            q.close()
            val was = openNow
            if (was && o.clock() - openedAt >= o.stableSeconds) attempts = 0
            openNow = false
            if (ws === s) ws = null
            outbox = null
            synchronized(lock) { memberSet.clear() }
            loseLinks()
            if (was) emitMembers()
        }
        return code
    }

    /** A refused envelope: close 1002 and answer nothing. */
    private suspend fun refuse(s: RelaySocket): Int {
        withContext(NonCancellable) { quiet { s.close(CLOSE_BAD_FRAME) } }
        return CLOSE_BAD_FRAME
    }

    private suspend fun ping(s: RelaySocket) {
        while (ws === s && !stopped) {
            sleeper(o.pingSeconds)
            if (ws !== s) return
            sendEnv(RelayMessage.Ping(ByteArray(PING_BYTES).also { rng.nextBytes(it) }))
            sendEnv(RelayMessage.List)
        }
    }

    /** Queue one envelope for the room; dropped when no socket is open or it cannot be encoded. */
    internal fun sendEnv(m: RelayMessage) {
        val q = outbox ?: return
        if (!openNow) return
        try {
            q.trySend(encodeRelay(m))
        } catch (e: IllegalArgumentException) {
            // a value the layout cannot hold is never sent
        }
    }

    private suspend fun handle(data: ByteArray) {
        val m = decodeRelay(RelayDirection.toClient, data) ?: throw IllegalArgumentException("relay envelope")
        when (m) {
            is RelayMessage.Recv -> onRecv(m.from, m.session, m.noise)

            is RelayMessage.Members -> {
                synchronized(lock) {
                    memberSet.clear()
                    m.devices.mapTo(memberSet) { Base64Url.encode(it) }
                }
                emitMembers()
            }

            is RelayMessage.Ring -> {
                // The roster changed. Fetch the newer one under the normal replacement rules; the epoch
                // is only a hint of whether it is newer than the one held.
                val ident = identity(false, quiet = true)
                if (ident == null || m.epoch > ident.ringEpoch) wantRing()
            }

            is RelayMessage.Gone -> {
                synchronized(lock) { memberSet.remove(Base64Url.encode(m.device)) }
                onGone(m.device)
                emitMembers()
            }

            is RelayMessage.Limit -> limit(m.reason)

            else -> Unit // pong: nothing to do
        }
    }

    private fun limit(reason: Int) {
        lastLimit = reason
        val why = when (reason) {
            LIMIT_RATE -> RelayErrorReason.rate_limited
            LIMIT_PAUSED -> RelayErrorReason.paused
            else -> RelayErrorReason.quota
        }
        val msg = when (why) {
            RelayErrorReason.paused -> "The relay is paused."
            RelayErrorReason.quota -> "The relay quota is spent."
            else -> "Slow down: the relay is rate limiting this device."
        }
        val scope = when (reason) {
            LIMIT_PERSON -> RelayQuotaScope.person
            LIMIT_PRODUCT -> RelayQuotaScope.product
            else -> null
        }
        errorNow = RelayException(why, msg, scope = scope)
        set(stateNow)
    }

    // -- sessions (CC-12.14) -----------------------------------------------------------------------

    /** A RECV envelope. Peer sessions are CC-12.14; until then it is dropped. */
    @Suppress("UNUSED_PARAMETER")
    private suspend fun onRecv(from: ByteArray, session: Long, noise: ByteArray) {
    }

    /** The room dropped a device: its sessions end (CC-12.14). */
    @Suppress("UNUSED_PARAMETER")
    private fun onGone(device: ByteArray) {
    }

    /** The socket is gone: every session ends without a word (CC-12.14). */
    private fun loseLinks() {
    }

    // -- identity and documents --------------------------------------------------------------------

    private suspend fun identity(force: Boolean, quiet: Boolean = false): PeerSource? = idLock.withLock {
        val now = src.now()
        val h = held
        if (!force && h != null && now - h.at < IDENTITY_TTL_S && h.source.certificateExpiresAt - now > CERT_MARGIN_S) {
            return@withLock h.source
        }
        val v = try {
            src.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (quiet) return@withLock null
            throw e
        }
        held = HeldIdentity(now, v)
        val pushed = docs.pushed
        if (pushed != null && pushed.epoch <= v.ringEpoch) docs.clearPushed()
        v
    }

    private fun wantRing() {
        // The refresh calls the Worker: never on the socket's reader.
        scope.launch { docs.wantRing() }
    }

    // -- bookkeeping -------------------------------------------------------------------------------

    private fun set(s: RelayState) {
        stateNow = s
        val st = status
        for (f in stateFns) {
            try {
                f(st)
            } catch (e: Exception) {
                // a host callback never stops the loop
            }
        }
    }

    private fun emitMembers() {
        val m = members()
        for (f in memberFns) {
            try {
                f(m)
            } catch (e: Exception) {
                // a host callback never stops the loop
            }
        }
    }

    private fun flush(e: RelayException) {
        val ws = synchronized(lock) { waiters.toList().also { waiters.clear() } }
        for (w in ws) w.completeExceptionally(e)
    }

    private suspend inline fun quiet(f: () -> Unit) {
        try {
            f()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // best effort
        }
    }

    private fun stoppedError() = RelayException(RelayErrorReason.stopped, "The relay is stopped.")
}
