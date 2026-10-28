// What the LAN and relay transports share (CC-12.10; WIRE-CONTRACT-V5 sections 15.3 and 15.5). Mirrors
// sdk-node's `connect/channel.ts` and the Python `connect/channel.py`: the account context and channel
// options a `PeerChannel` is built from, and the handling of the two documents a peer may push on an
// open session, `RING` and `TRUST`.
//
// Rules this file keeps:
// - the device's X25519 private key never leaves the key port: the channel is given the port's
//   `noiseStatic()`, whose `dh` calls it (G1);
// - a pushed document is never trusted because a peer sent it. `RING` is re-verified and stored by the
//   identity client under its replacement rules; `TRUST` is verified against the usable pins and applied
//   by the trust custodian. Each outcome, stored or refused, is reported as a [ConnectNotice]; none is
//   dropped silently (G11);
// - the suspending calls into the client (store a roster, apply trust, refresh identity) never run on
//   the transport's thread: `spawn` runs them one at a time, in order;
// - at most 8 documents wait at once and the last slot is kept for a `RING`; a busy refusal is reported
//   once a second per kind at most.

package im.plrs.key.sdk

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.PeerTrustResult
import im.plrs.key.core.peer.AccountContext
import im.plrs.key.core.peer.HeldRing
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.NoisePorts
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.noiseStatic
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.CopyOnWriteArrayList

/** Seconds between two identity refreshes a pushed roster or a newer-roster hint may cause. */
internal const val REFRESH_GAP_SECONDS: Long = 60

/** Pushed documents handled at once; the rest are refused as `busy`. */
internal const val MAX_DOCS_QUEUED: Int = 8
private const val MAX_RETRIES = 5
private const val MILLIS = 1000.0

/** Which document a notice is about. */
public enum class NoticeType { ring, trust }

/** What became of it. */
public enum class NoticeOutcome { stored, applied, refused }

/**
 * A pushed document's outcome. A roster is `stored` (with its [epoch]); a trust manifest is `applied`;
 * either may be `refused` with a [reason] (a registered word, or `busy`, `unsupported`, `failed`).
 */
public data class ConnectNotice(val type: NoticeType, val outcome: NoticeOutcome, val epoch: Long? = null, val reason: String? = null)

/**
 * The client calls pushed documents need. Every member but [now] may be null: the document is then
 * refused as `unsupported`, or no refresh is made.
 */
internal class PeerDocsSource(
    val now: () -> Long,
    /** Ask the Worker for a newer roster; throws on failure. */
    val refresh: (suspend () -> Unit)? = null,
    /** Verify and store a pushed roster. */
    val adoptRing: (suspend (String) -> RingAdoption)? = null,
    /** Verify and apply a pushed trust manifest. */
    val applyTrust: (suspend (String) -> PeerTrustResult)? = null,
)

/** The account context of a session. [ring] is the newest roster a session handed up, if any. */
internal fun peerAccount(src: PeerSource, ring: () -> HeldRing? = { null }): AccountContext = AccountContext(
    trust = src.trust,
    expectedAud = src.slug,
    certJws = src.certificate,
    ownSub = src.sub,
    ownDeviceId = src.deviceId,
    heldRing = { ring() ?: HeldRing(src.ring, src.ringEpoch) },
    discKeys = listOf(src.discovery.current, src.discovery.previous),
)

private fun hostPlatform(): String {
    if (System.getProperty("java.vendor").orEmpty().contains("Android")) return "android"
    val os = System.getProperty("os.name").orEmpty().lowercase()
    return when {
        os.startsWith("mac") -> "darwin"
        os.startsWith("win") -> "win32"
        else -> "linux"
    }
}

/** What every `PeerChannel` of a transport shares; the same for LAN and relay. */
internal class ChannelBase(
    val src: PeerSource,
    val caps: List<String> = listOf("app/1"),
    val label: String? = null,
    val ring: () -> HeldRing? = { null },
    val now: (() -> Long)? = null,
    val rekeyMessages: Int? = null,
    val rekeySeconds: Double? = null,
    val ports: NoisePorts? = null,
) {
    private val staticKey: DeviceKeyPort = src.keys

    /** A mode-a channel for [role]; [send] takes Noise messages, [onEvent] its events. */
    fun channel(role: NoiseRole, send: (ByteArray) -> Unit, onEvent: (SessionEvent) -> Unit): PeerChannel {
        val clock = now ?: { System.currentTimeMillis() / 1000 }
        return PeerChannel(
            role, src.slug, staticKey.noiseStatic(), peerAccount(src, ring),
            HelloInfo(hostPlatform(), src.slug, label),
            send, onEvent,
            caps = caps, ports = ports ?: NoisePorts(), now = clock,
            rekeyMessages = rekeyMessages ?: (1 shl 20), rekeySeconds = rekeySeconds ?: 3600.0,
            mode = PeerMode.a,
        )
    }

    override fun toString(): String = "ChannelBase"
}

/**
 * Handles `RING`, `TRUST` and "a peer is on a newer roster". [spawn] runs a job off the caller's
 * stack, in order (default: one coroutine in [scope] draining a queue); [timer] schedules a deferred
 * retry and returns its cancel (default: a delay in [scope]). Tests pass a spawn that runs the job
 * inline.
 */
internal class PeerDocs(
    private val src: PeerDocsSource,
    private val onStored: () -> Unit = {},
    scope: CoroutineScope? = null,
    spawn: ((suspend () -> Unit) -> Unit)? = null,
    private val timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
) {
    private val lock = Any()
    private val jobs = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private val spawnJob: (suspend () -> Unit) -> Unit
    private val timerScope: CoroutineScope? = scope
    private val queued = HashSet<String>()
    private val lastBusy = HashMap<NoticeType, Long>()
    private var lastRefresh = Long.MIN_VALUE
    private var retry: (() -> Unit)? = null
    private var tries = 0
    private val listeners = CopyOnWriteArrayList<(ConnectNotice) -> Unit>()

    /** The newest roster a session handed up, held until an identity load catches up. */
    @Volatile
    var pushed: HeldRing? = null
        private set

    init {
        if (spawn != null) {
            spawnJob = spawn
        } else {
            requireNotNull(scope) { "a scope or a spawn" }
            scope.launch { for (j in jobs) runCatching { j() } }
            spawnJob = { jobs.trySend(it) }
        }
    }

    override fun toString(): String = "PeerDocs"

    /** Subscribe to notices; returns the unsubscribe. */
    fun onNotice(fn: (ConnectNotice) -> Unit): () -> Unit {
        listeners += fn
        return { listeners -= fn }
    }

    /** Stop a pending retry and the worker. */
    fun close() {
        val cancel = synchronized(lock) { retry.also { retry = null } }
        cancel?.invoke()
        jobs.close()
    }

    // What a link reports; hand these to `LinkHandlers`.

    fun onRing(jws: String, epoch: Long) {
        val held = pushed
        if (held == null || epoch > held.epoch) pushed = HeldRing(jws, epoch)
        ring(jws)
    }

    fun onTrust(jws: String) = trust(jws)

    fun onRingWanted() = spawnJob { want(false) }

    /** A roster a peer pushed (already verified once by the session). */
    fun ring(jws: String) {
        queue(NoticeType.ring, jws) {
            val adopt = src.adoptRing
            if (adopt == null) {
                emit(ConnectNotice(NoticeType.ring, NoticeOutcome.refused, reason = "unsupported"))
                return@queue
            }
            when (val r = adopt(jws)) {
                is RingAdoption.Refused -> emit(ConnectNotice(NoticeType.ring, NoticeOutcome.refused, reason = r.reason))

                is RingAdoption.Stored -> {
                    emit(ConnectNotice(NoticeType.ring, NoticeOutcome.stored, epoch = r.epoch))
                    onStored()
                    // The certificate and K_disc that go with the new roster come from the Worker. If the
                    // minute's slot is taken, or the fetch fails, it is tried again.
                    want(true)
                }
            }
        }
    }

    /** A trust manifest a peer pushed (not verified by the session). */
    fun trust(jws: String) {
        queue(NoticeType.trust, jws) {
            val apply = src.applyTrust
            if (apply == null) {
                emit(ConnectNotice(NoticeType.trust, NoticeOutcome.refused, reason = "unsupported"))
                return@queue
            }
            val r = apply(jws)
            emit(
                if (r.applied) {
                    ConnectNotice(NoticeType.trust, NoticeOutcome.applied)
                } else {
                    ConnectNotice(NoticeType.trust, NoticeOutcome.refused, reason = r.reason)
                },
            )
        }
    }

    /**
     * A peer is on a newer roster, or the relay said the roster changed: fetch it (a fresh
     * `identity(refresh = true)`, verified under the normal replacement rules). At most one a minute.
     * True when a fetch started.
     */
    suspend fun wantRing(): Boolean = want(false)

    private suspend fun want(retry: Boolean): Boolean {
        val refresh = src.refresh ?: return false
        val t = src.now()
        var gap = 0L
        val started = synchronized(lock) {
            if (lastRefresh != Long.MIN_VALUE && t - lastRefresh < REFRESH_GAP_SECONDS) {
                gap = lastRefresh + REFRESH_GAP_SECONDS - t
                false
            } else {
                lastRefresh = t
                true
            }
        }
        if (!started) {
            if (retry) defer(gap.toDouble())
            return false
        }
        try {
            refresh()
            tries = 0
            onStored()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            tries++
            if (retry && tries <= MAX_RETRIES) defer(REFRESH_GAP_SECONDS.toDouble())
        }
        return true
    }

    private fun defer(seconds: Double) {
        synchronized(lock) {
            if (retry != null) return
            val fire = {
                synchronized(lock) { retry = null }
                spawnJob { want(true) }
            }
            retry = schedule(maxOf(1.0, seconds), fire)
        }
    }

    private fun schedule(seconds: Double, fn: () -> Unit): () -> Unit {
        timer?.let { return it(seconds, fn) }
        val job = requireNotNull(timerScope) { "a scope or a timer" }.launch {
            delay((seconds * MILLIS).toLong())
            fn()
        }
        return { job.cancel() }
    }

    /**
     * One at a time, at most [MAX_DOCS_QUEUED] waiting (the last slot is kept for a roster), and a
     * document already waiting is not queued twice: the excess is refused visibly, not worked on.
     */
    private fun queue(kind: NoticeType, jws: String, job: suspend () -> Unit) {
        val key = kind.name + ":" + jws
        val limit = if (kind == NoticeType.ring) MAX_DOCS_QUEUED else MAX_DOCS_QUEUED - 1
        val busy = synchronized(lock) {
            if (key in queued || queued.size >= limit) {
                true
            } else {
                queued += key
                false
            }
        }
        if (busy) {
            emitBusy(kind)
            return
        }
        spawnJob {
            try {
                job()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                emit(ConnectNotice(kind, NoticeOutcome.refused, reason = "failed"))
            } finally {
                synchronized(lock) { queued.remove(key) }
            }
        }
    }

    /** A busy refusal is one notice a second per kind: a flood does not become a flood of notices. */
    private fun emitBusy(kind: NoticeType) {
        val t = src.now()
        val first = synchronized(lock) {
            val last = lastBusy[kind]
            if (last != null && t - last < 1) false else true.also { lastBusy[kind] = t }
        }
        if (first) emit(ConnectNotice(kind, NoticeOutcome.refused, reason = "busy"))
    }

    private fun emit(n: ConnectNotice) {
        for (f in listeners) {
            try {
                f(n)
            } catch (e: Exception) {
                // a host callback never ends a session or a document's handling
            }
        }
    }
}
