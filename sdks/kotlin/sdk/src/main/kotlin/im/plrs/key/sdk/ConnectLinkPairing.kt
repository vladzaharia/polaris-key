// Pairing two devices of two accounts (CC-19.8; WIRE-CONTRACT-V5 section 15.10): `cloudConnect.links.pair`. Both
// people open pairing; each device advertises a pair instance (`m=p`) and browses for the other's, the two run mode
// `p` to the code (commit-reveal), each person confirms it, and the session's contact exchange stores a link on
// both devices. Mirrors sdk-node's `connect/pairing.ts`.
//
// Rules this file keeps:
// - the advert is `p1-` + 16 random base32 characters with `v=1`, `m=p` and the product tag, on a listener of its
//   own, for at most 300 s and only while the screen is open ([LinkPairHandle.stop]);
// - who dials: both sides advertise and browse, so the one whose instance name sorts lower dials and the other
//   answers. Both apply the same rule, so a pair of devices opens one session;
// - the code is the person's check. A [LinkOffer] is shown only once the session reached the code; its `label` and
//   `platform` are display data from a device on the LAN that nothing has authenticated, to be shown as "reported
//   by the device", never as proof of who it is;
// - nothing is stored before both people confirm and both `CONTACT`s are read in order; a session that ends first
//   stores nothing on either side;
// - the one-time static key is zeroed when the session ends; the contact secret is handed to the store and zeroed;
//   no key, secret, nonce or handshake hash is in any message, `toString` or error;
// - the sessions at once are bounded (4), per address and group by the pending limiter, and by the approver
//   limiter of section 15.6 (5 handshakes a minute, 4 waiting a code).

package im.plrs.key.sdk

import im.plrs.key.core.peer.ContactOffer
import im.plrs.key.core.peer.HandshakeLimiter
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.MAX_CONTACT_CATS
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerHello
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.TxtResult
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.base32Lower
import im.plrs.key.core.peer.contactCategories
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.LanDialOptions
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.PendingLimiter
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.lan.inetAddressOfLiteral
import im.plrs.key.core.peer.lan.lanDialRaceTo
import im.plrs.key.core.peer.lan.literalOfInetAddress
import im.plrs.key.core.peer.lan.socketVerdict
import im.plrs.key.core.peer.lan.textVerdict
import im.plrs.key.core.peer.parseTxt
import im.plrs.key.core.peer.productTag
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList

/** The pairing window: it closes by itself after this many seconds (section 15.4). */
public const val LINK_PAIR_WINDOW_SECONDS: Double = 300.0

private const val MAX_PAIR_SESSIONS = 4
private const val WAITING = 4
private const val PER_MINUTE = 5
private const val TRIES_PER_ADVERT = 2
private const val LABEL_MAX = 64
private const val INSTANCE_RANDOM_BYTES = 10
private const val INSTANCE_CHARS = 16
private const val KEY_BYTES = 32
private const val MILLIS = 1000
private const val BACKLOG = 16
private const val DIAL_MILLIS = 10_000
private val CAT = Regex("[a-z0-9-]{1,32}")

/** A nearby device at the code stage. */
public class LinkOffer internal constructor(
    /** What the other device sent as its label. Unauthenticated display data: show it as "reported by the device" beside the code. */
    public val label: String?,
    public val platform: String,
    /** The code both screens show, like `123 456`. The people compare it before anyone confirms. */
    public val code: String,
    /** The categories this app asked for: list them before the person confirms. */
    public val categories: List<String>,
    private val onConfirm: suspend () -> Unit,
    private val onDecline: suspend () -> Unit,
    private val closes: CloseSubscribers,
) {
    /** The person confirmed the code on this device. The link is made when the other person does too. */
    public suspend fun confirm() {
        onConfirm()
    }

    /** The person declined: the session closes and nothing is stored. */
    public suspend fun decline() {
        onDecline()
    }

    /** Called once when the session ends (at once if it already has). Returns the unsubscribe. */
    public fun onClose(fn: (SessionClosed) -> Unit): () -> Unit = closes.add(fn)

    override fun toString(): String = "LinkOffer"
}

internal class CloseSubscribers {
    private val lock = Any()
    private val fns = ArrayList<(SessionClosed) -> Unit>()
    private var done: SessionClosed? = null

    fun add(fn: (SessionClosed) -> Unit): () -> Unit {
        val d = synchronized(lock) {
            if (done == null) fns += fn
            done
        }
        if (d != null) fn(d)
        return { synchronized(lock) { fns -= fn } }
    }

    fun fire(c: SessionClosed) {
        val list = synchronized(lock) {
            if (done != null) return
            done = c
            fns.toList()
        }
        for (f in list) {
            try {
                f(c)
            } catch (e: Exception) {
                // a host callback never ends the window
            }
        }
    }
}

/** A link just made. */
public class PairedLink(
    /** The link's id on this device (`links.list()` has the rest). */
    public val id: String,
    public val label: String?,
    /** The categories both people approved. */
    public val categories: List<String>,
    /** The peer was already linked: the new pairing waits for its first handshake. */
    public val rePair: Boolean,
) {
    override fun toString(): String = "PairedLink($id)"
}

/** Why a session that reached the code ended without a link: declined, timed out, full (the cap of 64) or closed. */
public enum class PairFailureReason { Declined, Timeout, Full, Closed }

public class PairFailure(public val reason: PairFailureReason, public val close: SessionClosed?) {
    override fun toString(): String = "PairFailure(${reason.name})"
}

/** What pairing needs to be told. Callbacks run on a service thread: keep them short, never block in one. */
public class LinkPairOptions @JvmOverloads constructor(
    /**
     * The data categories this app asks both people to approve (at most 8, each `[a-z0-9-]{1,32}`, no repeat). Show
     * them next to the code. A link keeps the ones both sides listed (D-7).
     */
    public val categories: List<String>,
    /** Called with each nearby device that reached the code. Show it, and call [LinkOffer.confirm] or [LinkOffer.decline]. */
    public val onCode: (LinkOffer) -> Unit,
    /**
     * This device's label, sent in `HELLO` and stored on the other device as the name of the link. Name the device
     * or the person ("Ana's laptop"); never an account identifier.
     */
    public val label: String? = null,
    /** Called once with the link made (both people confirmed and both devices stored it). */
    public val onLinked: ((PairedLink) -> Unit)? = null,
    /** Called when a session that reached the code ends without a link. */
    public val onFailed: ((PairFailure) -> Unit)? = null,
    /** Seconds the window stays open (default and most 300). */
    public val seconds: Double = LINK_PAIR_WINDOW_SECONDS,
    public val mdns: MdnsAdapter? = null,
    /** Where to listen: a literal, by default `::` (both families on one port), else 0.0.0.0. */
    public val host: String? = null,
    /** Accept and dial loopback peers. For tests and same-host use only. */
    public val allowLoopback: Boolean = false,
    public val handshakeSeconds: Double = 30.0,
    public val maxPendingPerAddress: Int = 1,
) {
    override fun toString(): String = "LinkPairOptions"
}

/** The open pairing window. */
public interface LinkPairHandle {
    /** Close the window: the advert, the listener and every session. */
    public suspend fun stop()

    /** Still advertising. */
    public val open: Boolean
}

/** What pairing reads of the client. */
internal class PairSource(
    val slug: String,
    val now: () -> Long,
    val agreeKey: suspend () -> String,
    /** The agreeKey of every active contact (a peer in it is a re-pair, section 15.10). */
    val held: suspend () -> List<String>,
    /** Store the contact the exchange produced. [secret] is zeroed by the caller after this returns. Null at the cap. */
    val store: suspend (agreeKey: String, secret: ByteArray, label: String?, cats: List<String>) -> StoredLink?,
    /** The cached discovery answer is still true: links stay on (section 15.10 "Gates"). */
    val allowed: suspend () -> Boolean,
)

internal class StoredLink(val id: String, val pending: Boolean)

private class Live(val key: RawNoiseStatic) {
    var link: PeerLink<Unit>? = null
    var hello: PeerHello? = null
    var confirmed = false
    var linked = false
    var dead = false
    var shown = false
    var failure: PairFailureReason? = null
    val closers = CloseSubscribers()
}

internal class LinkPairing private constructor(private val src: PairSource, private val o: LinkPairOptions) : LinkPairHandle {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val rng = SecureRandom()
    private val lock = Any()
    private val mdns: MdnsAdapter = o.mdns ?: JvmMdns(scope, allowLoopback = o.allowLoopback)
    private val cats: List<String> = o.categories.toList()
    private val limiter = HandshakeLimiter(PER_MINUTE, WAITING)
    private val pendingLimiter = PendingLimiter(WAITING * 2, o.maxPendingPerAddress, 2)
    private val live = HashSet<Live>()
    private val candidates = LinkedHashMap<String, Candidate>()
    private val dialing = HashSet<String>()
    private var server: ServerSocket? = null
    private var advert: MdnsHandle? = null
    private var browse: MdnsHandle? = null
    private var instance = ""
    private var agreeKey = ""
    private var held: List<String> = emptyList()
    private var window: Job? = null

    @Volatile
    private var stopped = false

    private class Candidate(val instance: String, val hosts: List<String>, val port: Int, var tries: Int = 0)

    override val open: Boolean get() = !stopped

    override fun toString(): String = "LinkPairing(open=$open)"

    override suspend fun stop() {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        window?.cancel()
        try {
            server?.close()
        } catch (e: IOException) {
            // already closed
        }
        quiet { advert?.stop() }
        quiet { browse?.stop() }
        val all = synchronized(lock) { live.toList() }
        for (l in all) end(l, PeerCloseCode.peer_bye)
        synchronized(lock) { candidates.clear() }
        scope.cancel()
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

    private suspend fun begin() {
        agreeKey = src.agreeKey()
        held = src.held()
        val any6 = inetAddressOfLiteral("::")
        val any4 = inetAddressOfLiteral("0.0.0.0")
        val s = o.host?.let { ServerSocket(0, BACKLOG, requireNotNull(inetAddressOfLiteral(it)) { "host" }) }
            ?: runCatching { ServerSocket(0, BACKLOG, any6) }.getOrElse { ServerSocket(0, BACKLOG, any4) }
        server = s
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
        instance = "p1-" + base32Lower(ByteArray(INSTANCE_RANDOM_BYTES).also { rng.nextBytes(it) }).substring(0, INSTANCE_CHARS)
        val tag = productTag(src.slug, advertEpoch(src.now()))
        advert = mdns.advertise(MdnsAdvert(instance, s.localPort, listOf("v=1", "m=p", "h=$tag")))
        browse = mdns.browse({ f -> scope.launch { quiet { found(f) } } }, { synchronized(lock) { candidates.remove(it) } })
        val seconds = minOf(o.seconds, LINK_PAIR_WINDOW_SECONDS)
        window = scope.launch {
            delay((seconds * MILLIS).toLong())
            stop()
        }
    }

    // -- advert and browse -------------------------------------------------------------------------

    private suspend fun found(f: MdnsFound) {
        if (stopped || f.instance == instance) return
        val txt = parseTxt(f.txt)
        if (txt !is TxtResult.Ok || txt.mode != PeerMode.p) return
        // The product tag of this epoch or the last: a pair advert of another product is not ours.
        val epoch = advertEpoch(src.now())
        if (txt.h != productTag(src.slug, epoch) && txt.h != productTag(src.slug, epoch - 1)) return
        val hosts = f.hosts.filter { textVerdict(it, o.allowLoopback) }
        if (hosts.isEmpty()) return
        synchronized(lock) {
            val had = candidates[f.instance]
            candidates[f.instance] = Candidate(f.instance, hosts, f.port, had?.tries ?: 0)
        }
        pump()
    }

    /** Dial the adverts that sort above this device's own (the other side dials the rest). */
    private suspend fun pump() {
        // The cached discovery answer can move under an open window (section 15.10 "Gates").
        if (stopped || !src.allowed()) return
        val todo = synchronized(lock) {
            val out = ArrayList<Candidate>()
            for (c in candidates.values) {
                if (live.size + dialing.size + out.size >= MAX_PAIR_SESSIONS) break
                if (instance >= c.instance || c.instance in dialing || c.tries >= TRIES_PER_ADVERT) continue
                c.tries++
                dialing += c.instance
                out += c
            }
            out
        }
        for (c in todo) {
            scope.launch {
                try {
                    dial(c)
                } finally {
                    synchronized(lock) { dialing -= c.instance }
                }
            }
        }
    }

    private suspend fun dial(c: Candidate) {
        val (socket, _) = try {
            lanDialRaceTo(c.hosts, c.port, LanDialOptions(o.allowLoopback, DIAL_MILLIS))
        } catch (e: IOException) {
            return
        }
        if (stopped) {
            socket.close()
            return
        }
        val l = makeLive(TcpPipe(socket), NoiseRole.initiator, null)
        l.link?.start()
    }

    // -- sessions ----------------------------------------------------------------------------------

    private suspend fun accept(sock: Socket) {
        val verdict = socketVerdict(literalOfInetAddress(sock.inetAddress), literalOfInetAddress(sock.localAddress), o.allowLoopback)
        val key = verdict.key
        val release = if (!stopped && verdict.dial && key != null && synchronized(lock) { live.size } < MAX_PAIR_SESSIONS) {
            synchronized(lock) { pendingLimiter.take(key) }
        } else {
            null
        }
        if (release == null || !src.allowed()) {
            release?.invoke()
            sock.close()
            return
        }
        val l = makeLive(TcpPipe(sock), NoiseRole.responder, release)
        l.link?.let { launchRun(it) }
    }

    private fun launchRun(link: PeerLink<Unit>) {
        scope.launch { link.run() }
    }

    private fun makeLive(pipe: TcpPipe, role: NoiseRole, release: (() -> Unit)?): Live {
        val priv = ByteArray(KEY_BYTES).also { rng.nextBytes(it) }
        val l = Live(RawNoiseStatic(priv))
        priv.fill(0)
        synchronized(lock) { live += l }
        val handlers = LinkHandlers<Unit>(
            onEstablished = { _, e ->
                release?.invoke()
                // The one-time static key has done its work.
                l.key.wipe()
                l.hello = e.hello
            },
            onClosed = { c ->
                release?.invoke()
                scope.launch { closed(l, SessionClosed(c.code, c.byPeer)) }
            },
            onContact = { e -> scope.launch { store(l, e) } },
            onSas = { e -> show(l, e.display) },
        )
        val link = PeerLink(pipe, scope, handlers, o.handshakeSeconds) { send, onEvent -> channel(l, role, send, onEvent) }
        l.link = link
        if (role == NoiseRole.initiator) launchRun(link)
        return l
    }

    private fun channel(l: Live, role: NoiseRole, send: (ByteArray) -> Unit, onEvent: (SessionEvent) -> Unit): PeerChannel = PeerChannel(
        role, src.slug, l.key, null, HelloInfo(hostPlatform(), src.slug, o.label), send, onEvent,
        caps = emptyList(), now = src.now, mode = PeerMode.p,
        admission = if (role == NoiseRole.responder) limiter else null,
        exchange = ContactOffer(agreeKey, held, o.label, cats),
    )

    private fun show(l: Live, display: String) {
        if (l.shown || stopped) return
        l.shown = true
        val hello = l.hello
        val offer = LinkOffer(
            hello?.label,
            hello?.platform.orEmpty(),
            display,
            cats,
            onConfirm = { confirm(l) },
            onDecline = {
                l.failure = PairFailureReason.Declined
                end(l, PeerCloseCode.peer_bye)
            },
            closes = l.closers,
        )
        try {
            o.onCode(offer)
        } catch (e: Exception) {
            // a host callback never ends the window
        }
    }

    private suspend fun confirm(l: Live) {
        if (l.dead || l.confirmed) return
        l.confirmed = true
        // One link per window: the other devices that reached the code are closed.
        val others = synchronized(lock) { live.filter { it !== l && !it.confirmed } }
        for (other in others) end(other, PeerCloseCode.peer_bye)
        l.link?.channel?.confirmSas()
    }

    private suspend fun store(l: Live, e: SessionEvent.Contact) {
        val secret = e.secret
        try {
            val agreed = contactCategories(cats, e.body.cats)
            val r = src.store(e.body.agreeKey, secret, e.body.label, agreed)
            if (r == null) {
                l.failure = PairFailureReason.Full
                end(l, PeerCloseCode.peer_not_allowed)
                return
            }
            l.linked = true
            try {
                o.onLinked?.invoke(PairedLink(r.id, e.body.label, agreed, r.pending))
            } catch (x: Exception) {
                // a host callback never ends the window
            }
            // Both CONTACTs are in: the exchange is over (section 15.10).
            end(l, PeerCloseCode.peer_bye)
        } catch (x: CancellationException) {
            throw x
        } catch (x: Exception) {
            l.failure = PairFailureReason.Closed
            end(l, PeerCloseCode.peer_bye)
        } finally {
            secret.fill(0)
        }
    }

    private suspend fun closed(l: Live, c: SessionClosed) {
        if (l.dead) return
        l.dead = true
        l.key.wipe()
        synchronized(lock) { live -= l }
        l.closers.fire(c)
        if (l.shown && !l.linked && !stopped) {
            val reason = l.failure ?: if (c.code == PeerCloseCode.peer_timeout.name) PairFailureReason.Timeout else PairFailureReason.Closed
            try {
                o.onFailed?.invoke(PairFailure(reason, c))
            } catch (x: Exception) {
                // a host callback never ends the window
            }
        }
        if (l.linked && !stopped) stop() else pump()
    }

    private fun end(l: Live, code: PeerCloseCode) {
        val link = l.link ?: return
        scope.launch { link.close(code) }
    }

    companion object {
        /** Validate, listen, advertise and browse. Throws [LanException] `bad_type` for options that break a rule. */
        suspend fun start(src: PairSource, o: LinkPairOptions): LinkPairing {
            check(o)
            val p = LinkPairing(src, o)
            try {
                p.begin()
            } catch (e: Throwable) {
                p.stop()
                throw e
            }
            return p
        }

        private fun check(o: LinkPairOptions) {
            fun bad(m: String): Nothing = throw LanException(LanErrorReason.bad_type, m)
            val c = o.categories
            if (c.size > MAX_CONTACT_CATS || !c.all { CAT.matches(it) } || c.toSet().size != c.size) {
                bad("categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
            }
            if (o.label != null && o.label.codePointCount(0, o.label.length) > LABEL_MAX) bad("The label is not valid.")
            if (!(o.seconds > 0)) bad("seconds must be above 0.")
        }
    }
}
