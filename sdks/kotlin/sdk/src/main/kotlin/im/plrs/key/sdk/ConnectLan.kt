// The LAN half of Cloud Connect (CC-12.12; WIRE-CONTRACT-V5 sections 15.4 to 15.6): advertise this
// device under the account instance name, browse for the person's other devices, listen on TCP and
// dial. Mirrors sdk-node's `connect/lan.ts` and the Python `connect/lan.py`.
//
// Rules this file keeps:
// - the advert is `p1-` plus HMAC(K_disc, epoch, deviceId) with `v=1`, `m=a` and nothing else; it is
//   renewed at every 15-minute epoch boundary and when K_disc changes, and uses only the newest key (G4);
// - a browse hit is kept only if it matches a roster device (never this one) under the current or
//   previous epoch and either delivered key; everything else is dropped, and a name that did not match is
//   not worked out twice;
// - the listener starts a handshake only when this device holds a verified identity. The handshake
//   (XXpsk0) and admission (certificate, roster, expiry, revocation) run in the channel; a failed tag
//   closes the socket without a word (G2);
// - sockets that have not been admitted are bounded: at most 32 in total, 4 per source address and 16 per
//   source /64, each living at most 30 seconds, handshake frames at most 16 KiB (G7);
// - one port serves both families: a dual-stack `::` listener, falling back to 0.0.0.0 where IPv6 is
//   unavailable. A socket is judged on its own addresses (`lanVerdict`, V5 15.4.1) before it takes a slot
//   and before a byte is read: a source off the LAN is closed at once, with nothing read or written;
// - the device dials only addresses `lanVerdict` allows (loopback only when the caller opts in, for tests):
//   the text of each address before a socket exists, and the connected socket again before its first byte
//   (G6). Several addresses race (RFC 8305): 250 ms apart, at most two in flight, the first to pass wins. The
//   certificate's device must be the one dialled, or the session closes `wrong_peer` (G8);
// - a refused local-network permission is `permission_denied` (D-8), and nothing is opened;
// - the device's X25519 private key never leaves the key port (G1).

package im.plrs.key.sdk

import im.plrs.key.core.PeerTrustResult
import im.plrs.key.core.peer.ADVERT_EPOCH_SECONDS
import im.plrs.key.core.peer.BrowseIndex
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.TxtResult
import im.plrs.key.core.peer.accountInstance
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING_PER_ADDRESS
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING_PER_GROUP
import im.plrs.key.core.peer.lan.LanDialOptions
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.MdnsUnavailableException
import im.plrs.key.core.peer.lan.PendingLimiter
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.lan.inetAddressOfLiteral
import im.plrs.key.core.peer.lan.lanDialRace
import im.plrs.key.core.peer.lan.literalOfInetAddress
import im.plrs.key.core.peer.lan.socketVerdict
import im.plrs.key.core.peer.lan.textVerdict
import im.plrs.key.core.peer.parseTxt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList

/** Open sessions at once. */
public const val LAN_MAX_SESSIONS: Int = 64

private const val HANDSHAKE_SECONDS = 30.0
private const val DIAL_SECONDS = 10.0
private const val IDENTITY_TTL_S = 30L
private const val CERT_MARGIN_S = 60L
private const val MISS_CACHE = 1024
private const val MILLIS = 1000
private const val OPEN_GRACE_SECONDS = 5
private const val BACKLOG = 128

/** `stop()` gives up waiting after this long, so a blocked host callback cannot hang sign-out. */
private const val STOP_TIMEOUT_MILLIS = 15_000L

/** How long an abort waits for a socket or an advert to let go. */
private const val ABORT_CLOSE_MILLIS = 1_000L

/** A roster device seen on the network. */
public data class LanPeer(
    val deviceId: String,
    val host: String,
    val port: Int,
    /** Other addresses the device announced from; a dial tries them after [host]. */
    val alternates: List<String> = emptyList(),
)

/**
 * LAN options. [mdns] is the discovery adapter (default [JvmMdns], with [interfaces] as the
 * `lan.interfaces` override). [host] is the address to listen on, as a literal: by default `::` (both
 * families on one port), or 0.0.0.0 where IPv6 is unavailable. [port] 0 picks a random port each listen
 * (section 15.4). [allowLoopback] accepts and dials 127.0.0.0/8 and ::1: for tests and same-host use only. [lanPermission] runs once before
 * anything is opened; false means the OS refused local network access.
 */
public class LanOptions(
    public val mdns: MdnsAdapter? = null,
    public val host: String? = null,
    public val port: Int = 0,
    public val caps: List<String> = listOf("app/1"),
    public val label: String? = null,
    public val advertise: Boolean = true,
    public val browse: Boolean = true,
    public val allowLoopback: Boolean = false,
    public val interfaces: List<String>? = null,
    public val maxPending: Int = LAN_MAX_PENDING,
    public val maxPendingPerAddress: Int = LAN_MAX_PENDING_PER_ADDRESS,
    public val maxPendingPerGroup: Int = LAN_MAX_PENDING_PER_GROUP,
    public val maxSessions: Int = LAN_MAX_SESSIONS,
    public val rekeyMessages: Int? = null,
    public val rekeySeconds: Double? = null,
    public val handshakeSeconds: Double = HANDSHAKE_SECONDS,
    public val dialSeconds: Double = DIAL_SECONDS,
    /** Schedule `fn` after `seconds`; returns the cancel. Default: a delay in the service's scope. */
    public val timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
    public val lanPermission: suspend () -> Boolean = { true },
) {
    override fun toString(): String = "LanOptions"
}

/**
 * What the LAN service needs of the client. [load] reads the held identity (it may read the key store and
 * call the Worker); [now] is epoch seconds; [refresh], [adoptRing] and [applyTrust] are as in [PeerDocsSource].
 */
internal class LanSource(
    val load: suspend () -> PeerSource,
    val now: () -> Long,
    val refresh: (suspend () -> Unit)? = null,
    val adoptRing: (suspend (String) -> RingAdoption)? = null,
    val applyTrust: (suspend (String) -> PeerTrustResult)? = null,
    /** Epoch seconds on the trust clock floor (non-suspend): certificate and roster expiry, `peer_expired`. */
    val floored: () -> Long = now,
    /** Monotonic seconds, for the refresh gap. */
    val mono: () -> Long = now,
)

/** The LAN service's source over a [ConnectClient]. */
internal fun lanSource(
    client: ConnectClient,
    now: () -> Long = { System.currentTimeMillis() / MILLIS },
    applyTrust: (suspend (String) -> PeerTrustResult)? = null,
    floored: () -> Long = now,
    mono: () -> Long = { System.nanoTime() / NANOS_PER_SECOND },
): LanSource = LanSource(
    load = { client.peerSource() },
    now = now,
    refresh = { client.identity(refresh = true) },
    adoptRing = { client.adoptRing(it) },
    applyTrust = applyTrust,
    floored = floored,
    mono = mono,
)

private class Held(val at: Long, val source: PeerSource)

/** One running LAN service. Build it with [start]. */
internal class LanService private constructor(
    private val src: LanSource,
    private val o: LanOptions,
    private val scope: CoroutineScope,
    private val ownsScope: Boolean,
) {
    private var server: ServerSocket? = null
    private var listenPort = 0
    private val mdns: MdnsAdapter = o.mdns ?: JvmMdns(scope, allowLoopback = o.allowLoopback, interfaces = o.interfaces)
    private var adv: MdnsHandle? = null
    private var advName = ""
    private var browseHandle: MdnsHandle? = null
    private var cancelEpoch: (() -> Unit)? = null
    private val idLock = Mutex()
    private val rotateLock = Mutex()
    private val lock = Any()
    private var held: Held? = null
    private val peerTable = LinkedHashMap<String, Pair<LanPeer, String>>()
    private val miss = LinkedHashMap<String, Long>()

    // Every name the held roster can announce, worked out once per epoch and identity: a found name is
    // a lookup, never a run of HMACs (F4).
    @Volatile
    private var names: Triple<Long, PeerSource, BrowseIndex>? = null
    private val pending = HashSet<Socket>()
    private val limiter = PendingLimiter(o.maxPending, o.maxPendingPerAddress, o.maxPendingPerGroup)
    private val links = HashSet<PeerLink<ConnectSession>>()
    private val sessions = HashSet<ConnectSession>()
    private val onSession = CopyOnWriteArrayList<(ConnectSession) -> Unit>()
    private val onPeerFns = CopyOnWriteArrayList<(LanPeer) -> Unit>()

    @Volatile
    private var stopped = false
    private val docs = PeerDocs(
        PeerDocsSource(src.now, src.refresh, src.adoptRing, src.applyTrust, src.mono),
        onStored = { storedFromWorker() },
        scope = scope,
    )

    override fun toString(): String = "LanService(port=$listenPort)"

    /** The TCP port this listen uses. */
    val port: Int get() = listenPort

    /** Roster devices seen on the network right now. */
    fun peers(): List<LanPeer> = synchronized(lock) { peerTable.values.map { it.first } }

    /** Sockets that have not been admitted yet (a test hook for the G7 caps). */
    val pendingCount: Int get() = synchronized(lock) { pending.size }

    /** True while the TCP listener is open (a test hook). */
    internal val listening: Boolean get() = server?.isClosed == false

    /** Source addresses with unadmitted sockets (a test hook). */
    val pendingAddresses: Map<String, Int> get() = synchronized(lock) { limiter.perAddressCounts() }

    /** Called for each pushed `RING` or `TRUST` once it is stored, applied or refused. */
    fun onNotice(fn: (ConnectNotice) -> Unit): () -> Unit = docs.onNotice(fn)

    fun onPeer(fn: (LanPeer) -> Unit): () -> Unit {
        onPeerFns += fn
        return { onPeerFns -= fn }
    }

    /** Called for each inbound session once it is open and admitted. */
    fun onSession(fn: (ConnectSession) -> Unit): () -> Unit {
        onSession += fn
        return { onSession -= fn }
    }

    /** Notices for tests that reach for the document handler directly. */
    internal val documents: PeerDocs get() = docs

    /** Last resort after a stop that ran out of time: drop the advert and the listener and cancel the scope; waits for nothing. */
    suspend fun abort() {
        synchronized(lock) { stopped = true }
        val a = adv
        val b = browseHandle
        adv = null
        browseHandle = null
        try {
            server?.close()
        } catch (e: IOException) {
            // already closed
        }
        if (ownsScope) scope.cancel()
        withTimeoutOrNull(ABORT_CLOSE_MILLIS) {
            quiet { a?.stop() }
            quiet { b?.stop() }
        }
    }

    suspend fun stop() {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        withTimeoutOrNull(STOP_TIMEOUT_MILLIS) {
            docs.close()
            cancelEpoch?.invoke()
            cancelEpoch = null
            val socks = synchronized(lock) { pending.toList() }
            for (s in socks) abort(s)
            quiet { adv?.stop() }
            quiet { browseHandle?.stop() }
            try {
                server?.close()
            } catch (e: IOException) {
                // already closed
            }
            adv = null
            browseHandle = null
            // The listener and the advert are down before any session is closed: a host callback that
            // blocks a session's close cannot keep them up. Each close is bounded.
            val open = synchronized(lock) { sessions.toList() }
            for (s in open) quiet { withTimeoutOrNull(SESSION_CLOSE_MILLIS) { s.close() } }
            val ls = synchronized(lock) { links.toList() }
            for (l in ls) quiet { withTimeoutOrNull(SESSION_CLOSE_MILLIS) { l.close() } }
        }
        if (ownsScope) scope.cancel()
    }

    private suspend inline fun quiet(f: () -> Unit) {
        try {
            f()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // best effort on the way out
        }
    }

    // -- dial ------------------------------------------------------------------------------------

    private fun dialable(host: String): Boolean = textVerdict(host, o.allowLoopback)

    /** Dial a discovered device and run the handshake. */
    suspend fun connect(deviceId: String): ConnectSession = connectTo(deviceId, synchronized(lock) { peerTable[deviceId]?.first })

    /** Dial a given address as device [LanPeer.deviceId]. */
    suspend fun connect(peer: LanPeer): ConnectSession = connectTo(peer.deviceId, peer)

    private suspend fun connectTo(want: String, peer: LanPeer?): ConnectSession {
        if (stopped) throw LanException(LanErrorReason.not_listening, "The LAN service is stopped.")
        // The address text is judged before any socket exists (a global IPv6 address is judged again on the
        // connected socket, with its own local address).
        val hosts = peer?.let { (listOf(it.host) + it.alternates).filter(::dialable) }.orEmpty()
        if (peer == null || hosts.isEmpty()) {
            throw LanException(LanErrorReason.unknown_peer, "That device was not found on this network.")
        }
        val ident = identity(false)
        val pipe = dial(hosts, peer.port)
        val link = link(pipe, ident, NoiseRole.initiator)
        val run = scope.launch { link.run() }
        link.start()
        val session = try {
            waitOpened(link.opened, ((o.handshakeSeconds + OPEN_GRACE_SECONDS) * MILLIS).toLong())
        } catch (e: LanException) {
            throw e
        } catch (e: TimeoutCancellationException) {
            run.cancel()
            pipe.close()
            throw LanException(LanErrorReason.handshake_failed, "The handshake failed.", e)
        }
        if (session.peerDeviceId != want) {
            session.close()
            throw LanException(LanErrorReason.wrong_peer, "The device that answered is not the one that advertised.")
        }
        return session
    }

    /** The race of RFC 8305 over every announced address: the first connection that passes the verdict on its own addresses wins (G6). */
    private suspend fun dial(hosts: List<String>, port: Int): TcpPipe {
        val socket = try {
            lanDialRace(hosts, port, LanDialOptions(o.allowLoopback, (o.dialSeconds * MILLIS).toInt()))
        } catch (e: IOException) {
            throw LanException(LanErrorReason.connect_failed, "The device did not answer.", e)
        }
        return TcpPipe(socket)
    }

    // -- identity --------------------------------------------------------------------------------

    suspend fun identity(force: Boolean): PeerSource = idLock.withLock {
        val now = src.now()
        val h = held
        if (!force && h != null && now - h.at < IDENTITY_TTL_S && h.source.certificateExpiresAt - now > CERT_MARGIN_S) {
            return@withLock h.source
        }
        val v = src.load()
        if (h != null && h.source.ringEpoch != v.ringEpoch) synchronized(lock) { miss.clear() }
        held = Held(now, v)
        val pushed = docs.pushed
        if (pushed != null && pushed.epoch <= v.ringEpoch) docs.clearPushed()
        v
    }

    /** A roster or identity was stored: the next read reloads, and the advert follows a new K_disc inside the epoch. */
    internal fun storedFromWorker() {
        held = null
        if (!stopped && adv != null) scope.launch { quiet { rotate() } }
    }

    // -- links -----------------------------------------------------------------------------------

    private fun link(pipe: TcpPipe, ident: PeerSource, role: NoiseRole): PeerLink<ConnectSession> {
        val base = ChannelBase(ident, o.caps, o.label, { docs.pushed }, src.floored, o.rekeyMessages, o.rekeySeconds)
        var self: PeerLink<ConnectSession>? = null
        val handlers = sessionHandlers(
            role,
            docs,
            onEstablished = { s ->
                synchronized(lock) { sessions += s }
                s.onClose { synchronized(lock) { sessions -= s } }
            },
            onEnded = { self?.let { l -> synchronized(lock) { links -= l } } },
        )
        val l = PeerLink(pipe, scope, handlers, o.handshakeSeconds) { send, onEvent -> base.channel(role, send, onEvent) }
        self = l
        synchronized(lock) { links += l }
        return l
    }

    // -- TCP -------------------------------------------------------------------------------------

    /** The listener: [LanOptions.host] when given, else `::` (both families), else 0.0.0.0 where IPv6 is unavailable. */
    private fun bind(): ServerSocket {
        val host = o.host
        val any6 = inetAddressOfLiteral("::")
        val any4 = inetAddressOfLiteral("0.0.0.0")
        return when {
            host != null -> ServerSocket(o.port, BACKLOG, requireNotNull(inetAddressOfLiteral(host)) { "lan host: not an address" })
            else -> runCatching { ServerSocket(o.port, BACKLOG, any6) }.getOrElse { ServerSocket(o.port, BACKLOG, any4) }
        }
    }

    private fun listen() {
        val s = bind()
        server = s
        listenPort = s.localPort
        scope.launch(Dispatchers.IO) {
            while (!stopped) {
                val sock = try {
                    s.accept()
                } catch (e: IOException) {
                    break
                }
                scope.launch { accept(sock) }
            }
        }
    }

    private fun abort(s: Socket) {
        try {
            s.close()
        } catch (e: IOException) {
            // already closed
        }
    }

    /** Take a slot for [sock] under the lock, or null when the service is stopping or full or a limit is met. */
    private fun admit(sock: Socket, key: String): (() -> Unit)? {
        val release = if (!stopped && sessions.size < o.maxSessions) limiter.take(key) else null
        if (release != null) pending += sock
        return release
    }

    private suspend fun accept(sock: Socket) {
        // Judged first, on the socket's own addresses and before a byte is read or written: a source off
        // the LAN is closed at once and costs no slot.
        val verdict = socketVerdict(literalOfInetAddress(sock.inetAddress), literalOfInetAddress(sock.localAddress), o.allowLoopback)
        val key = verdict.key
        val release = if (verdict.dial && key != null) synchronized(lock) { admit(sock, key) } else null
        if (release == null) {
            abort(sock)
            return
        }
        // An unauthenticated socket lives for the handshake window and no longer.
        val deadline = scope.launch {
            delay((o.handshakeSeconds * MILLIS).toLong())
            abort(sock)
        }

        fun done() {
            deadline.cancel()
            synchronized(lock) { if (pending.remove(sock)) release() }
        }
        try {
            // The identity is read before the first byte is handled; the socket buffers meanwhile.
            val ident = identity(false)
            if (stopped) {
                abort(sock)
                return
            }
            val l = link(TcpPipe(sock), ident, NoiseRole.responder)
            l.opened.invokeOnCompletion { cause ->
                if (cause == null) {
                    done()
                    val s = l.opened.getCompleted()
                    for (fn in onSession) {
                        try {
                            fn(s)
                        } catch (e: Exception) {
                            // a host callback never ends a session
                        }
                    }
                }
            }
            l.run()
        } catch (e: CancellationException) {
            abort(sock)
            throw e
        } catch (e: Exception) {
            abort(sock)
        } finally {
            done()
        }
    }

    // -- mDNS ------------------------------------------------------------------------------------

    /** Advertise under the current epoch and key; set the timer for the next boundary. */
    private suspend fun rotate() {
        rotateLock.withLock {
            if (stopped) return
            val ident = identity(true)
            val now = src.now()
            val epoch = advertEpoch(now)
            val name = accountInstance(ident.discovery.current, epoch, ident.deviceId)
            if (name != advName) {
                val old = adv
                adv = mdns.advertise(MdnsAdvert(name, listenPort, listOf("v=1", "m=a")))
                advName = name
                if (old != null) quiet { old.stop() }
            }
            val next = (epoch + 1) * ADVERT_EPOCH_SECONDS - src.now()
            cancelEpoch?.invoke()
            val timer = o.timer ?: ::defaultTimer
            cancelEpoch = timer(maxOf(1L, next).toDouble()) { scope.launch { quiet { rotate() } } }
        }
    }

    private fun defaultTimer(seconds: Double, fn: () -> Unit): () -> Unit {
        val job: Job = scope.launch {
            delay((seconds * MILLIS).toLong())
            fn()
        }
        return { job.cancel() }
    }

    private suspend fun startBrowse() {
        browseHandle = mdns.browse({ f -> scope.launch { quiet { found(f) } } }, { gone(it) }, { nameIndex(src.now())?.lookup(it) != null })
    }

    /** The names of the held identity for the epoch of [now]; built once, then reused. Null before an identity is held. */
    private fun nameIndex(now: Long, ident: PeerSource? = held?.source ?: names?.second): BrowseIndex? {
        val id = ident ?: return null
        val epoch = advertEpoch(now)
        names?.let { if (it.first == epoch && it.second === id) return it.third }
        val keys = listOfNotNull(id.discovery.current, id.discovery.previous)
        val idx = BrowseIndex(keys, epoch, id.roster.filter { it != id.deviceId })
        names = Triple(epoch, id, idx)
        return idx
    }

    private fun gone(instance: String) {
        synchronized(lock) { peerTable.entries.removeAll { it.value.second == instance } }
    }

    private suspend fun found(f: MdnsFound) {
        val hosts = f.hosts.filter(::dialable)
        if (stopped || hosts.isEmpty()) return
        val txt = parseTxt(f.txt)
        if (txt !is TxtResult.Ok || txt.mode != PeerMode.a) return
        if (synchronized(lock) { f.instance in miss }) return
        val ident = identity(false)
        val hit = nameIndex(src.now(), ident)?.lookup(f.instance)
        if (hit == null) {
            // Bounded negative cache: a forged instance is not worked out twice.
            synchronized(lock) {
                if (miss.size >= MISS_CACHE) miss.remove(miss.keys.first())
                miss[f.instance] = src.now()
            }
            return
        }
        val peer = LanPeer(hit.deviceId, hosts[0], f.port, hosts.drop(1))
        synchronized(lock) { peerTable[hit.deviceId] = peer to f.instance }
        for (fn in onPeerFns) {
            try {
                fn(peer)
            } catch (e: Exception) {
                // a host callback never ends discovery
            }
        }
    }

    companion object {
        /**
         * Listen, then advertise and browse; [onSession] is subscribed before the listener opens. Throws [LanException]: `permission_denied` when the OS refused
         * local network access, `no_identity` or `no_keys` when there is no identity to start with.
         */
        suspend fun start(
            src: LanSource,
            options: LanOptions = LanOptions(),
            scope: CoroutineScope? = null,
            onSession: ((ConnectSession) -> Unit)? = null,
        ): LanService {
            val own = scope == null
            val s = LanService(src, options, scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Default), own)
            // Subscribed before the listener opens, so a session admitted at once reaches the host (G9).
            if (onSession != null) s.onSession(onSession)
            try {
                if (!options.lanPermission()) {
                    throw LanException(LanErrorReason.permission_denied, "Local network access was refused.")
                }
                s.identity(true)
                s.listen()
                if (options.advertise) s.rotate()
                if (options.browse) s.startBrowse()
            } catch (e: MdnsUnavailableException) {
                s.stop()
                throw LanException(LanErrorReason.not_listening, "LAN discovery is not available here.", e)
            } catch (e: Throwable) {
                s.stop()
                throw e
            }
            return s
        }
    }
}
