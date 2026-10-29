// The relay half of Cloud Connect, socket side (CC-12.13; WIRE-CONTRACT-V5 section 15.7). One WebSocket
// to the account room carries envelopes. Mirrors the socket half of sdk-node's `connect/relay.ts` and the
// Python `connect/relay.py`. Peer sessions (`dial`, inbound RECV) and outgoing pacing (D-9) ride the socket (CC-12.14).
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
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerLinkPort
import im.plrs.key.core.peer.RELAY_MAX_MESSAGE
import im.plrs.key.core.peer.RelayDirection
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.decodeRelay
import im.plrs.key.core.peer.deviceIdBytes
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

/** Ended sessions remembered, so a late message for one is dropped without work. */
internal const val ENDED_MEMORY: Int = 256
private const val MAX_SESSION_ID = 0xFFFFFFFFL
private const val DRAIN_MILLIS = 1000L

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

/** How long an abort waits for a socket or an advert to let go. */
private const val ABORT_CLOSE_MILLIS = 1_000L
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
    /** Makes the outgoing pacer of each socket (default [Pacer]). */
    val pacer: (() -> Pacer)? = null,
    /** Bytes the queue behind the socket may hold (8 MiB). */
    val outboxBytes: Long = OUTBOX_MAX_BYTES,
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
    private var outbox: Outbox? = null

    @Volatile
    private var pacer: Pacer? = null
    private val links = LinkedHashMap<String, RelayLink>()
    private val endedKeys = java.util.ArrayDeque<String>()
    private val sessionFns = CopyOnWriteArrayList<(ConnectSession) -> Unit>()
    private val docs = PeerDocs(
        PeerDocsSource(src.now, src.refresh, src.adoptRing, src.applyTrust, src.mono),
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

    /** Sessions open or still shaking hands. */
    val sessionCount: Int get() = synchronized(lock) { links.size }

    /** Called for each inbound session once it is open and admitted. */
    fun onSession(fn: (ConnectSession) -> Unit): () -> Unit {
        sessionFns += fn
        return { sessionFns -= fn }
    }

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
        // Register first, then look again: session() sets openNow and drains the waiters under the same lock.
        val w = CompletableDeferred<Unit>()
        synchronized(lock) { waiters += w }
        if (openNow) w.complete(Unit)
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

    /** Last resort after a stop that ran out of time: cancel the socket and the scope; waits for nothing. */
    suspend fun abort() {
        synchronized(lock) { stopped = true }
        val s = ws
        ws = null
        openNow = false
        stateNow = RelayState.stopped
        if (ownsScope) scope.cancel()
        withTimeoutOrNull(ABORT_CLOSE_MILLIS) { if (s != null) quiet { s.close(CLOSE_NORMAL) } }
    }

    /** Stop the loop, close the socket and end every session. Gives up waiting after 15 seconds. */
    suspend fun stop() {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        docs.close()
        val q = outbox
        val open = synchronized(lock) { links.values.toList() }
        set(RelayState.stopped)
        withTimeoutOrNull(STOP_TIMEOUT_MILLIS) {
            // Say goodbye to open sessions before the socket goes.
            for (l in open) quiet { withTimeoutOrNull(SESSION_CLOSE_MILLIS) { l.close(PeerCloseCode.peer_bye) } }
            if (q != null && openNow) q.drained(DRAIN_MILLIS)
        }
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
        // The last LIMIT and error are cleared before the socket counts as open: a caller released
        // by ready() must never read the previous socket's error as this one's.
        lastLimit = null
        errorNow = null
        ws = s
        openNow = true
        val openedAt = o.clock()
        val q = Outbox(o.outboxBytes)
        outbox = q
        val pc = (o.pacer ?: { Pacer() })()
        pacer = pc
        set(RelayState.open)
        val ready = synchronized(lock) { waiters.toList().also { waiters.clear() } }
        for (w in ready) w.complete(Unit)
        val writer = scope.launch {
            try {
                while (true) {
                    val data = q.get() ?: break
                    pc.acquire()
                    s.send(data)
                    q.sent()
                }
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
            pacer = null
            synchronized(lock) { memberSet.clear() }
            withContext(NonCancellable) { loseLinks() }
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
            q.put(encodeRelay(m), force = true)
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
        if (reason == LIMIT_RATE) pacer?.halve()
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

    /**
     * Dial a device of the person over the relay and run the handshake. Throws [RelayException]:
     * `unknown_peer`, `busy`, `handshake_failed`, `wrong_peer`, or the reason the relay is not connected.
     */
    suspend fun dial(deviceId: String): ConnectSession {
        ready()
        val peer = try {
            deviceIdBytes(deviceId)
        } catch (e: IllegalArgumentException) {
            throw RelayException(RelayErrorReason.unknown_peer, "That is not a device id.")
        }
        val ident = identity(false) ?: throw RelayException(RelayErrorReason.not_connected, "The relay is not connected.")
        if (deviceId == ident.deviceId || deviceId !in ident.roster) {
            throw RelayException(RelayErrorReason.unknown_peer, "That device is not one of this person's devices.")
        }
        val link = makeLink(peer, newSessionId(peer), NoiseRole.initiator, ident)
            ?: throw RelayException(RelayErrorReason.busy, "Too many relay sessions are open.")
        link.start()
        try {
            return link.opened.await()
        } catch (e: RelayException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw RelayException(RelayErrorReason.handshake_failed, "The handshake failed.")
        }
    }

    /** A RECV envelope: a message of a known session, or the first message of one a peer opened. */
    private suspend fun onRecv(from: ByteArray, session: Long, noise: ByteArray) {
        val key = sessionKey(from, session)
        val known = synchronized(lock) { links[key] }
        if (known != null) {
            known.receive(noise)
            return
        }
        if (synchronized(lock) { key in endedKeys }) return
        // A first message of a session the peer opened. Only the person's own devices may.
        val ident = identity(false, quiet = true)
        if (ident == null || stopped || !openNow) return
        val fromId = Base64Url.encode(from)
        if (fromId == ident.deviceId || fromId !in ident.roster) return
        val pending = synchronized(lock) { links.values.count { !it.ended && it.peer.contentEquals(from) } }
        if (pending >= o.maxPendingPerPeer) return
        makeLink(from, session, NoiseRole.responder, ident)?.receive(noise)
    }

    private fun sessionKey(peer: ByteArray, session: Long): String = peer.joinToString("") { "%02x".format(it) } + ":" + session

    private fun makeLink(peer: ByteArray, sessionId: Long, role: NoiseRole, ident: PeerSource): RelayLink? {
        val key = sessionKey(peer, sessionId)
        val handlers = sessionHandlers(
            role,
            docs,
            onEstablished = { s ->
                if (role == NoiseRole.responder) {
                    for (f in sessionFns) {
                        try {
                            f(s)
                        } catch (e: Exception) {
                            // a host callback never ends a session
                        }
                    }
                }
            },
            path = "relay",
        )
        val base = ChannelBase(ident, o.caps, o.label, { docs.pushed }, src.floored, o.rekeyMessages, o.rekeySeconds)
        assertRelayMode("a")
        synchronized(lock) {
            if (links.size >= o.maxSessions) return null
            val link = RelayLink(this, peer, sessionId, key, role, base, handlers, o.handshakeSeconds, scope)
            links[key] = link
            return link
        }
    }

    internal fun linkEnded(link: RelayLink) {
        synchronized(lock) {
            if (links[link.key] === link) links.remove(link.key)
            endedKeys.addLast(link.key)
            while (endedKeys.size > ENDED_MEMORY) endedKeys.removeFirst()
        }
    }

    private fun newSessionId(peer: ByteArray): Long {
        while (true) {
            val n = rng.nextLong() and MAX_SESSION_ID
            val k = sessionKey(peer, n)
            if (synchronized(lock) { k !in links && k !in endedKeys }) return n
        }
    }

    /** The room dropped a device: its sessions end. */
    private suspend fun onGone(device: ByteArray) {
        val gone = synchronized(lock) { links.values.filter { it.peer.contentEquals(device) } }
        for (l in gone) l.lost()
    }

    /** The socket is gone: every session ends without a word. */
    private suspend fun loseLinks() {
        val all = synchronized(lock) { links.values.toList() }
        for (l in all) l.lost()
    }

    internal fun sendSession(peer: ByteArray, session: Long, noise: ByteArray) {
        // Handshake and PONG envelopes are not held to the outbox cap (they must go out); a session that
        // keeps asking for them while the box is over twice the cap is closed instead.
        val q = outbox
        if (q != null && q.queued > 2 * q.maxBytes) {
            val l = synchronized(lock) { links[sessionKey(peer, session)] }
            if (l != null) {
                l.closeNow(PeerCloseCode.peer_busy)
                return
            }
        }
        sendEnv(RelayMessage.Send(peer, session, noise))
    }

    internal fun hasRoom(n: Int): Boolean = outbox?.roomFor(n) == true

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

/**
 * One session inside the room: a mode-a channel whose Noise messages ride SEND and RECV envelopes. It has
 * the surface [ConnectSession] needs of a link. The room has no flow control, so there is no pause: a peer
 * that sends faster than the host reads ends with `peer_busy` at the byte caps (G10).
 */
internal class RelayLink(
    private val svc: RelayService,
    val peer: ByteArray,
    val sessionId: Long,
    val key: String,
    private val role: NoiseRole,
    base: ChannelBase,
    private val handlers: LinkHandlers<ConnectSession>,
    handshakeSeconds: Double,
    private val scope: CoroutineScope,
) : PeerLinkPort {
    @Volatile
    var ended = false
        private set
    private val lock = Any()
    private var lostAlready = false
    private var open = false
    private var why = RelayErrorReason.handshake_failed
    private var wake: Job? = null
    private var deadline: Job? = null
    val opened: CompletableDeferred<ConnectSession> = CompletableDeferred()
    val channel = base.channel(role, { svc.sendSession(peer, sessionId, it) }, ::onEvent)

    override val remoteAddress: String = "relay"

    init {
        deadline = scope.launch {
            delay((handshakeSeconds * MILLIS).toLong())
            fail()
        }
    }

    override fun toString(): String = "RelayLink(session=$sessionId)"

    /** Initiator: write message 1. */
    suspend fun start() {
        channel.start()
        arm()
    }

    suspend fun receive(noise: ByteArray) {
        if (ended) return
        channel.receive(noise)
        arm()
    }

    /** The socket is gone or the room dropped the peer: end without a word. */
    suspend fun lost() {
        if (ended) return
        lostAlready = true
        channel.close(PeerCloseCode.peer_bye)
        finish(SessionEvent.Closed("connection_lost", false))
    }

    override suspend fun sendRecord(type: Int, body: ByteArray) {
        // Refuse before the channel encrypts: a message dropped after encryption would break the stream.
        if (!svc.hasRoom(body.size + OVERHEAD * (body.size / CHUNK + 1))) {
            // D-9: a full send queue ends this session `peer_busy`; the host sees the close, not an error.
            channel.close(PeerCloseCode.peer_busy)
            return
        }
        channel.sendRecord(type, body)
    }

    override suspend fun close(code: PeerCloseCode) {
        channel.close(code)
    }

    override fun closeNow(code: PeerCloseCode) {
        scope.launch { channel.close(code) }
    }

    override fun pause(on: Boolean) = Unit

    // -- internals ---------------------------------------------------------------------------------

    private suspend fun arm() {
        synchronized(lock) {
            wake?.cancel()
            wake = null
        }
        if (ended) return
        val w = channel.wakeIn() ?: return
        val job = scope.launch {
            delay((maxOf(w, MIN_WAKE) * MILLIS).toLong())
            synchronized(lock) { wake = null }
            channel.tick()
            arm()
        }
        synchronized(lock) {
            wake?.cancel()
            wake = job
        }
    }

    private suspend fun fail() {
        if (ended || open) return
        channel.close(PeerCloseCode.peer_bye)
        finish(SessionEvent.Closed(HANDSHAKE, false))
    }

    private fun onEvent(e: SessionEvent) {
        when (e) {
            is SessionEvent.Established -> {
                val id = e.peerDeviceId ?: return
                // The certificate, not the room's stamp, names the peer; they must agree (G8).
                if (id != Base64Url.encode(peer)) {
                    why = RelayErrorReason.wrong_peer
                    scope.launch { channel.close(PeerCloseCode.peer_bye) }
                    finish(SessionEvent.Closed(HANDSHAKE, false))
                    return
                }
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

            is SessionEvent.Closed -> finish(if (lostAlready && !e.byPeer) SessionEvent.Closed("connection_lost", false) else e)
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
        }
        handlers.onClosed(c)
        opened.completeExceptionally(RelayException(why, "The peer was not admitted over the relay.", closeCode = c.code))
        svc.linkEnded(this)
        handlers.onEnded()
    }

    private companion object {
        const val MILLIS = 1000
        const val MIN_WAKE = 0.05
        const val OVERHEAD = 128
        const val CHUNK = 60_000
        const val HANDSHAKE = "handshake_failed"
    }
}
