// The contact relay (CC-19.8; WIRE-CONTRACT-V5 section 15.7 "Contact rooms", section 15.10): a room joins the
// two devices of one link, who may belong to two accounts. Each contact has its own room, named by the `rid`
// both sides derive from the contact secret, and each session inside it is a `PeerChannel` in mode `c`.
// Mirrors sdk-node's `connect/contactRelay.ts`.
//
// Rules this file keeps:
// - a contact ticket is asked for with the body `{"room":"c","rid":...}`; the answer must echo `room: "c"`, else
//   the Worker predates contact rooms and nothing is connected (`ConnectClient.relayTicket(room, rid)`);
// - the room speaks aliases, never device ids: `from`, `to` and `MEMBERS` carry SHA-256(rid || deviceId)[0..24].
//   This device computes its own and learns the peer's as the member that is not it; nothing here sees the
//   peer's device id, subject or certificate;
// - the relay carries mode `c` here and nothing else; the Noise pin (the contact's agreeKey) names the peer;
// - a room is kept for each contact marked reachable (at most 8); any other contact gets a short-lived room for
//   one dial, stopped when its last session ends. The Worker allows 30 contact tickets an hour per device, so a
//   reconnect backs off to minutes;
// - an envelope that fails its layout closes the socket with 1002; a SEND to an offline peer is dropped by the
//   room silently, so a dial is made only to a peer `MEMBERS` lists;
// - the contact secret is held as a copy for the room and zeroed when the room stops.

package im.plrs.key.sdk

import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.ContactLink
import im.plrs.key.core.peer.HandshakeLimiter
import im.plrs.key.core.peer.MAX_LIVE_CONTACT_ADVERTS
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.RelayDirection
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.contactAlias
import im.plrs.key.core.peer.contactRid
import im.plrs.key.core.peer.decodeRelay
import im.plrs.key.core.peer.encodeRelay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList

/** What the contact relay needs: the LAN source (identity, contacts) plus a contact ticket. */
internal class ContactRelaySource(
    val lan: LanSource,
    /** `POST relay/ticket` with `{room: "c", rid}`. Throws [RelayException]. */
    val ticket: suspend (rid: String) -> RelayGrant,
)

private const val MILLIS = 1000
private const val MAX_ROOM_SESSIONS = 4
private const val CONTACT_BACKOFF_BASE = 5.0
private const val CONTACT_BACKOFF_MAX = 600.0
private const val MAX_RETRY_AFTER = 3600.0
private const val RATE_LIMITED_WAIT = 60.0
private const val CLOSE_NORMAL = 1000
private const val CLOSE_BAD_FRAME = 1002
private const val CLOSE_REPLACED = 4009
private const val CLOSE_NOT_MEMBER = 4003
private const val CLOSE_LIMIT = 4008
private const val NOT_MEMBER_LIMIT = 3
private const val MAX_DEFERRED = 8
private const val PING_BYTES = 8
private const val MAX_BACKOFF_EXPONENT = 16
private const val ABORT_MILLIS = 1_000L
private const val DRAIN_MILLIS = 1000L

/** The room of one contact: a socket, its members and the sessions inside. */
internal class ContactRoom(
    private val src: ContactRelaySource,
    contact: LiveContact,
    private val o: RelayOptions,
    val transient: Boolean,
    private val onSession: (ConnectSession) -> Unit,
    private val onIdle: (String) -> Unit,
    scope: CoroutineScope? = null,
) : RelayRoomPort {
    private val ownsScope = scope == null
    private val scope: CoroutineScope = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val opener: RelayOpener = o.opener ?: okHttpOpener(null, o.openSeconds)
    private val sleeper: suspend (Double) -> Unit = o.sleep ?: { s -> delay((s * MILLIS).toLong()) }
    private val rand: () -> Double = o.random ?: { Math.random() }
    private val rng = SecureRandom()
    private val lock = Any()
    private val limiter = HandshakeLimiter()

    /** This room's own copy of the contact; zeroed at stop. */
    private val contact: LiveContact = LiveContact(
        contact.id,
        contact.agreeKey,
        contact.agreeKeyBytes.copyOf(),
        contact.secret.copyOf(),
        contact.label,
        contact.cats,
        contact.reachable,
        contact.pending,
    )
    val rid: String = contactRid(contact.secret)
    val contactId: String get() = contact.id
    val isPending: Boolean get() = contact.pending

    @Volatile
    private var stateNow = RelayState.idle

    @Volatile
    private var errorNow: RelayException? = null

    @Volatile
    private var attempts = 0

    @Volatile
    private var stopped = false
    private var started = false

    @Volatile
    private var ws: RelaySocket? = null

    @Volatile
    private var openNow = false

    @Volatile
    private var ownAlias: ByteArray? = null

    @Volatile
    private var peerAlias: ByteArray? = null

    @Volatile
    private var outbox: Outbox? = null

    @Volatile
    private var pacer: Pacer? = null
    private val links = LinkedHashMap<String, RelayLink>()
    private val endedKeys = java.util.ArrayDeque<String>()
    private val waiters = ArrayList<CompletableDeferred<Unit>>()
    private val memberWaiters = CopyOnWriteArrayList<CompletableDeferred<Unit>>()
    private val deferred = ArrayList<Triple<ByteArray, Long, ByteArray>>()

    @Volatile
    private var sleeping: CompletableDeferred<Unit>? = null
    private var lastLimit: Int? = null
    private var notMember = 0
    private var task: Job? = null

    val status: RelayStatus get() = RelayStatus(stateNow, errorNow, attempts)

    /** Whether the room's peer is listed in the room now. */
    val peerOnline: Boolean get() = peerAlias != null

    override fun toString(): String = "ContactRoom(state=${stateNow.name})"

    fun start() {
        synchronized(lock) {
            if (started || stopped) return
            started = true
        }
        task = scope.launch { loop() }
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
        if (openNow) w.complete(Unit)
        try {
            val ok = withTimeoutOrNull(timeoutMillis ?: (o.openSeconds * MILLIS).toLong()) { w.await() }
            if (ok == null) throw errorNow ?: RelayException(RelayErrorReason.not_connected, "The relay is not connected.")
        } finally {
            synchronized(lock) { waiters -= w }
        }
    }

    /** Ask the room who is in it; returns on the answer or after [timeoutMillis]. */
    suspend fun refreshMembers(timeoutMillis: Long = 2000) {
        if (!openNow) return
        val done = CompletableDeferred<Unit>()
        memberWaiters += done
        try {
            sendEnv(RelayMessage.List)
            withTimeoutOrNull(timeoutMillis) { done.await() }
        } finally {
            memberWaiters -= done
        }
    }

    /** Open a session to the contact in this room: the peer must be listed (a SEND to an absent one is dropped). */
    suspend fun dial(): ConnectSession {
        ready()
        if (peerAlias == null) refreshMembers()
        val peer = peerAlias ?: throw RelayException(RelayErrorReason.unknown_peer, "That contact is not online.")
        val ident = try {
            src.lan.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw RelayException(RelayErrorReason.unknown_peer, "No Cloud Connect identity is held.")
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

    suspend fun stop() {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        stateNow = RelayState.stopped
        val q = outbox
        val open = synchronized(lock) { links.values.toList() }
        withTimeoutOrNull(STOP_MILLIS) {
            for (l in open) quiet { withTimeoutOrNull(SESSION_CLOSE_MILLIS) { l.close(PeerCloseCode.peer_bye) } }
            if (q != null && openNow) q.drained(DRAIN_MILLIS)
        }
        loseLinks()
        val s = ws
        ws = null
        openNow = false
        sleeping?.complete(Unit)
        withTimeoutOrNull(STOP_MILLIS) {
            if (s != null) quiet { s.close(CLOSE_NORMAL) }
            task?.let {
                it.cancel()
                it.join()
            }
        }
        task?.cancel()
        flush(stoppedError())
        contact.wipe()
        if (ownsScope) scope.cancel()
    }

    /** Last resort: cancel the socket and the scope; waits for nothing. */
    suspend fun abort() {
        synchronized(lock) { stopped = true }
        val s = ws
        ws = null
        openNow = false
        stateNow = RelayState.stopped
        contact.wipe()
        if (ownsScope) scope.cancel()
        withTimeoutOrNull(ABORT_MILLIS) { if (s != null) quiet { s.close(CLOSE_NORMAL) } }
    }

    // -- the connect loop --------------------------------------------------------------------------

    private suspend fun loop() {
        while (!stopped) {
            stateNow = RelayState.connecting
            var code: Int? = null
            var waitS = 0.0
            try {
                val grant = src.ticket(rid)
                if (stopped) return
                code = session(grant)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (stopped) return
                val err = e as? RelayException ?: RelayException(RelayErrorReason.unavailable, "The relay could not be reached.")
                errorNow = err
                if (err.reason in BLOCKING) {
                    block(err)
                    return
                }
                waitS = ((e as? PolarisException)?.retryAfterSeconds ?: 0).toDouble()
                // Rate limited (30 contact tickets an hour per device): wait a minute at least.
                if ((e as? PolarisException)?.code == "rate_limited" && waitS == 0.0) waitS = RATE_LIMITED_WAIT
            }
            if (stopped) return
            val end = afterClose(code)
            if (end != null) {
                block(end)
                return
            }
            attempts++
            stateNow = RelayState.backoff
            nap(maxOf(backoff(), minOf(waitS, MAX_RETRY_AFTER)))
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

    private fun afterClose(code: Int?): RelayException? {
        val limit = lastLimit
        lastLimit = null
        if (code == null) return null
        if (code == CLOSE_REPLACED) return RelayException(RelayErrorReason.replaced, "Another socket took this room.", closeCode = code.toString())
        if (code == CLOSE_NOT_MEMBER) {
            // The room is full, or links were switched off: a few tries, then stop.
            notMember++
            return if (notMember >= NOT_MEMBER_LIMIT) {
                RelayException(RelayErrorReason.not_member, "The room does not admit this device.", closeCode = code.toString())
            } else {
                null
            }
        }
        notMember = 0
        if (code == CLOSE_LIMIT && (limit == 2 || limit == 3)) {
            return RelayException(
                RelayErrorReason.quota,
                "The relay quota is spent.",
                closeCode = code.toString(),
                scope = if (limit == 3) RelayQuotaScope.product else RelayQuotaScope.person,
            )
        }
        return null
    }

    private fun block(e: RelayException) {
        errorNow = e
        openNow = false
        stateNow = RelayState.blocked
        flush(e)
    }

    private fun backoff(): Double {
        val cap = minOf(CONTACT_BACKOFF_MAX, CONTACT_BACKOFF_BASE * Math.pow(2.0, minOf(maxOf(attempts - 1, 0), MAX_BACKOFF_EXPONENT).toDouble()))
        return maxOf(o.backoffMin, cap / 2 + rand() * cap / 2)
    }

    // -- one socket --------------------------------------------------------------------------------

    private suspend fun session(grant: RelayGrant): Int? {
        val ident = try {
            src.lan.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorNow = RelayException(RelayErrorReason.unavailable, "No Cloud Connect identity is held.")
            return null
        }
        val own = contactAlias(rid, ident.deviceId)
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
        ownAlias = own
        openNow = true
        val openedAt = o.clock()
        lastLimit = null
        errorNow = null
        val q = Outbox(o.outboxBytes)
        outbox = q
        val pc = (o.pacer ?: { Pacer() })()
        pacer = pc
        stateNow = RelayState.open
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
            if (openNow && o.clock() - openedAt >= o.stableSeconds) attempts = 0
            openNow = false
            if (ws === s) ws = null
            outbox = null
            pacer = null
            peerAlias = null
            ownAlias = null
            synchronized(lock) { deferred.clear() }
            withContext(NonCancellable) { loseLinks() }
            for (m in memberWaiters.toList()) m.complete(Unit)
        }
        return code
    }

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

    private fun sendEnv(m: RelayMessage) {
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
            is RelayMessage.Recv -> onRecv(m.from, m.session, m.noise, true)

            is RelayMessage.Members -> {
                // The member that is not this device is the peer.
                val before = peerAlias
                val own = ownAlias
                peerAlias = m.devices.firstOrNull { own == null || !it.contentEquals(own) }
                if (before != null && (peerAlias == null || !before.contentEquals(peerAlias))) loseLinks()
                for (w in memberWaiters.toList()) w.complete(Unit)
                val held = synchronized(lock) { deferred.toList().also { deferred.clear() } }
                for ((from, sess, noise) in held) onRecv(from, sess, noise, false)
            }

            is RelayMessage.Gone -> {
                val p = peerAlias
                if (p != null && p.contentEquals(m.device)) {
                    peerAlias = null
                    loseLinks()
                }
            }

            is RelayMessage.Limit -> limit(m.reason)

            else -> Unit // pong: nothing to do; a contact room never sends RING
        }
    }

    private fun limit(reason: Int) {
        lastLimit = reason
        if (reason == 1) pacer?.halve()
        val why = when (reason) {
            1 -> RelayErrorReason.rate_limited
            4 -> RelayErrorReason.paused
            else -> RelayErrorReason.quota
        }
        val scope = when (reason) {
            2 -> RelayQuotaScope.person
            3 -> RelayQuotaScope.product
            else -> null
        }
        errorNow =
            RelayException(why, if (why == RelayErrorReason.paused) "The relay is paused." else "The relay is limiting this device.", scope = scope)
    }

    // -- sessions ----------------------------------------------------------------------------------

    private fun sessionKey(peer: ByteArray, session: Long): String = peer.joinToString("") { "%02x".format(it) } + ":" + session

    private fun newSessionId(peer: ByteArray): Long {
        while (true) {
            val n = rng.nextLong() and MAX_SESSION_ID_MASK
            val k = sessionKey(peer, n)
            if (synchronized(lock) { k !in links && k !in endedKeys }) return n
        }
    }

    /** A RECV envelope: a message of a known session, or the first message of one the room's other member opened. */
    private suspend fun onRecv(from: ByteArray, session: Long, noise: ByteArray, canDefer: Boolean) {
        val key = sessionKey(from, session)
        val known = synchronized(lock) { links[key] }
        if (known != null) {
            known.receive(noise)
            return
        }
        if (synchronized(lock) { key in endedKeys } || stopped || !openNow) return
        // The room may not have told this device yet that the peer joined: ask, hold the message (bounded) and
        // judge it when MEMBERS comes. Never wait here: the answer arrives on the loop that calls this.
        val peer = peerAlias
        if (peer == null) {
            if (canDefer) {
                val held = synchronized(lock) { if (deferred.size < MAX_DEFERRED) deferred.add(Triple(from, session, noise)) else false }
                if (held) sendEnv(RelayMessage.List)
            }
            return
        }
        if (!from.contentEquals(peer)) return
        val ident = try {
            src.lan.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        makeLink(from, session, NoiseRole.responder, ident)?.receive(noise)
    }

    private fun makeLink(peer: ByteArray, sessionId: Long, role: NoiseRole, ident: PeerSource): RelayLink? {
        val key = sessionKey(peer, sessionId)
        val ref = contact.ref
        val handlers = sessionHandlers(
            role,
            null,
            onEstablished = { s ->
                // The first handshake under a pending contact passed the pin: it replaces the held one.
                if (ref.pending) scope.launch { quiet { src.lan.contactEstablished?.invoke(ref) } }
                if (role == NoiseRole.responder) {
                    try {
                        onSession(s)
                    } catch (e: Exception) {
                        // a host callback never ends a session
                    }
                }
            },
            path = "relay",
            contacts = listOf(ref),
        )
        val base = ChannelBase(ident, o.caps, o.label, { null }, src.lan.floored, o.rekeyMessages, o.rekeySeconds)
        val copy = ContactLink(contact.secret.copyOf(), contact.agreeKey)
        synchronized(lock) {
            if (links.size >= o.maxSessions || links.size >= MAX_ROOM_SESSIONS) return null
            val link = RelayLink(
                this, peer, sessionId, key, role,
                { send, onEvent -> base.contactChannel(role, send, onEvent, listOf(copy), if (role == NoiseRole.responder) limiter else null) },
                handlers, o.handshakeSeconds, scope, contact = true,
            )
            links[key] = link
            return link
        }
    }

    override fun linkEnded(link: RelayLink) {
        val idle = synchronized(lock) {
            if (links[link.key] === link) links.remove(link.key)
            endedKeys.addLast(link.key)
            while (endedKeys.size > ENDED_MEMORY) endedKeys.removeFirst()
            links.isEmpty() && transient
        }
        if (idle) onIdle(contact.id + "|" + contact.pending)
    }

    private suspend fun loseLinks() {
        val all = synchronized(lock) { links.values.toList() }
        for (l in all) l.lost()
    }

    override fun sendSession(peer: ByteArray, session: Long, noise: ByteArray) {
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

    override fun hasRoom(n: Int): Boolean = outbox?.roomFor(n) == true

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

    private companion object {
        const val STOP_MILLIS = 15_000L
        const val MAX_SESSION_ID_MASK = 0xFFFFFFFFL
        val BLOCKING = setOf(
            RelayErrorReason.disabled,
            RelayErrorReason.links_disabled,
            RelayErrorReason.contact_unsupported,
            RelayErrorReason.quota,
        )
    }
}

/**
 * The contact rooms of one device: a room for each contact marked reachable (at most 8) and a short-lived room for
 * a single dial of any other (section 15.7). It follows the contact list and the gate.
 */
internal class ContactRelay(
    private val src: ContactRelaySource,
    private val o: RelayOptions = RelayOptions(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Any()
    private val rooms = LinkedHashMap<String, ContactRoom>()
    private val sessionFns = CopyOnWriteArrayList<(ConnectSession) -> Unit>()
    private val mutex = kotlinx.coroutines.sync.Mutex()

    @Volatile
    private var stopped = false
    private var unContacts: (() -> Unit)? = null

    override fun toString(): String = "ContactRelay"

    /** Called for each inbound session a contact opened to this device through a room. */
    fun onSession(fn: (ConnectSession) -> Unit): () -> Unit {
        sessionFns += fn
        return { sessionFns -= fn }
    }

    /** The room statuses, by link id. */
    fun status(): Map<String, RelayStatus> = synchronized(lock) { rooms.values.associate { it.contactId to it.status } }

    /** Keep a room for each reachable contact now, and follow the list from here on. */
    suspend fun start() {
        if (stopped) return
        unContacts = src.lan.onContacts?.invoke { scope.launch { refresh() } }
        refresh()
    }

    /** Read the contacts again: rooms for new reachable contacts, none for removed or unmarked ones. */
    suspend fun refresh() = mutex.withLock {
        if (stopped) return@withLock
        val contacts = src.lan.contacts?.invoke().orEmpty()
        try {
            if (stopped) return@withLock
            val want = contacts.filter { it.reachable }.take(MAX_LIVE_CONTACT_ADVERTS)
            val keep = HashSet<String>()
            for (c in want) {
                val k = "${c.id}|${c.pending}"
                keep += k
                if (synchronized(lock) { k !in rooms }) open(c, false)
            }
            val have = contacts.map { "${it.id}|${it.pending}" }.toSet()
            val drop = synchronized(lock) {
                rooms.entries.filter { (k, r) -> (k !in keep && !r.transient) || k !in have }.map { it.key to it.value }
                    .also { for ((k, _) in it) rooms.remove(k) }
            }
            for ((_, r) in drop) r.stop()
        } finally {
            for (c in contacts) c.wipe()
        }
    }

    private fun open(c: LiveContact, transient: Boolean): ContactRoom {
        val room = ContactRoom(
            src,
            c,
            o,
            transient,
            { s -> for (f in sessionFns) f(s) },
            { k -> scope.launch { idle(k) } },
            scope,
        )
        synchronized(lock) { rooms["${c.id}|${c.pending}"] = room }
        room.start()
        return room
    }

    private suspend fun idle(key: String) {
        val r = synchronized(lock) { rooms[key]?.takeIf { it.transient }?.also { rooms.remove(key) } } ?: return
        r.stop()
    }

    /**
     * Open a session to a contact through its room (a short-lived one when it is not kept). Throws
     * [RelayException]: `unknown_peer`, `busy`, `handshake_failed`, `links_disabled`, `contact_unsupported`, or the
     * reason the relay is not connected.
     */
    suspend fun dial(id: String, pending: Boolean = false): ConnectSession {
        if (stopped) throw RelayException(RelayErrorReason.stopped, "The relay is stopped.")
        val k = "$id|$pending"
        var room = synchronized(lock) { rooms[k] }
        if (room == null) {
            val contacts = src.lan.contacts?.invoke().orEmpty()
            val c = contacts.firstOrNull { it.id == id && it.pending == pending }
            try {
                if (c == null) throw RelayException(RelayErrorReason.unknown_peer, "That is not a link on this device.")
                room = open(c, true)
            } finally {
                for (x in contacts) x.wipe()
            }
        }
        return room.dial()
    }

    suspend fun stop() {
        if (stopped) return
        stopped = true
        unContacts?.invoke()
        unContacts = null
        val rs = synchronized(lock) { rooms.values.toList().also { rooms.clear() } }
        for (r in rs) r.stop()
    }

    suspend fun abort() {
        stopped = true
        unContacts?.invoke()
        unContacts = null
        val rs = synchronized(lock) { rooms.values.toList().also { rooms.clear() } }
        for (r in rs) r.abort()
    }
}
