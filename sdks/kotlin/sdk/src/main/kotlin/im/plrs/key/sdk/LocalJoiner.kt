// The joiner of a pairing, `client.cloudConnect.localLinks.join` (CC-29.13; WIRE-CONTRACT-V5 section 15.12, "The joiner"): it
// reads the typed code or the scanned QR, browses for the matching `m=q` advert and dials it, at most 2 dials a join and, for
// a typed code, at most 2 per nameplate in 300 s across joins (the process-wide [DialBudget], taken in one step when the dial
// is made). It never retries a failed code by itself, and a QR is never limited. The choices over one browse are :core's
// `JoinPlan`. Mirrors sdk-node's `connect/localJoiner.ts`.
//
// A typed code's Elligator map runs per dial, between a chosen advert and its connection (at most twice per code in 300 s,
// the accepted case of the spec); a QR's is made before anything is dialled.

@file:Suppress(
    "CyclomaticComplexMethod",
    "ReturnCount",
    "SwallowedException",
    "TooGenericExceptionCaught",
    "TooManyFunctions",
)

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.CodeVerdict
import im.plrs.key.core.peer.CpaceKind
import im.plrs.key.core.peer.DialBudget
import im.plrs.key.core.peer.DialOutcome
import im.plrs.key.core.peer.FrameReader
import im.plrs.key.core.peer.FrameVerdict
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.JoinInput
import im.plrs.key.core.peer.JoinPlan
import im.plrs.key.core.peer.JoinResult
import im.plrs.key.core.peer.LOCAL_ATTEMPT_SECONDS
import im.plrs.key.core.peer.LOCAL_JOIN_BROWSE_SECONDS
import im.plrs.key.core.peer.LOCAL_JOIN_CANDIDATES
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PairingOptions
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.QrVerdict
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.TxtResult
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.cpaceGenerator
import im.plrs.key.core.peer.cpaceIsk
import im.plrs.key.core.peer.cpacePrsCode
import im.plrs.key.core.peer.cpacePrsQr
import im.plrs.key.core.peer.cpacePsk
import im.plrs.key.core.peer.cpaceScalar
import im.plrs.key.core.peer.cpaceShare
import im.plrs.key.core.peer.encodeC1
import im.plrs.key.core.peer.encodeFrame
import im.plrs.key.core.peer.isInstanceName
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.LanDialOptions
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.lan.lanDialRaceTo
import im.plrs.key.core.peer.lan.textVerdict
import im.plrs.key.core.peer.pairingSid
import im.plrs.key.core.peer.parseC2
import im.plrs.key.core.peer.parseCode
import im.plrs.key.core.peer.parseQr
import im.plrs.key.core.peer.parseTxt
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.productTag
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import javax.net.SocketFactory

private const val MILLIS = 1000
private const val DIAL_MILLIS = 10_000
private const val KEY_BYTES = 32
private const val CLOSE_WAIT_MILLIS = 2_000L
private const val SPENT = "That code did not work. Wait a few minutes, or ask the other device for a new code."

private class Candidate(val hosts: List<String>, val port: Int, val socketFactory: SocketFactory?)

internal class LocalJoiner(private val src: LocalSource, private val budget: DialBudget, private val o: LocalJoinOptions) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()
    private val mdns: MdnsAdapter = o.mdns ?: JvmMdns(scope, allowLoopback = o.allowLoopback)
    private val ci: ByteArray = peerPrologue(src.slug, PeerMode.q)
    private val cats: List<String> = o.categories.toList()
    private val plan: JoinPlan
    private val cands = LinkedHashMap<String, Candidate>()
    private var password: String? = null
    private var nameplate: String? = null
    private var qrInstance: String? = null
    private var qrSecret: ByteArray? = null
    private var qrGen: ByteArray? = null
    private var browse: MdnsHandle? = null
    private var cancelTimer: Job? = null
    private var busy = false
    private var dials = 0
    private var browseOver = false
    private var done = false
    private var current: LocalAttempt? = null
    private val result = CompletableDeferred<LocalPaired>()
    private var qrInvalidDetail: String? = null

    /** A code whose dials are spent answers with the hint to wait or ask for a new code. */
    private var budgetSpent = false

    init {
        var input: JoinInput = JoinInput.Invalid
        val code = o.code
        if (code != null) {
            val c = parseCode(code)
            if (c is CodeVerdict.Ok) {
                input = JoinInput.Code(c.nameplate)
                password = c.password
                nameplate = c.nameplate
            }
        } else {
            when (val q = parseQr(o.qr.orEmpty(), src.slug)) {
                is QrVerdict.Ok -> {
                    input = JoinInput.Qr(q.instance)
                    qrInstance = q.instance
                    qrSecret = q.secret
                }

                QrVerdict.OtherApp -> qrInvalidDetail = "This code is for another app."

                QrVerdict.Invalid -> Unit
            }
        }
        plan = JoinPlan(input)
    }

    override fun toString(): String = "LocalJoiner"

    /** Stop the join: it answers `peer-closed` and every connection in flight closes. */
    fun cancel() {
        finish(PolarisException(ErrorCode.peerClosed, "The pairing was closed."))
    }

    suspend fun run(): LocalPaired {
        try {
            start()
            return result.await()
        } finally {
            // A session that is closing gets a moment to flush its CLOSE record.
            if (synchronized(lock) { current } != null) withTimeoutOrNull(CLOSE_WAIT_MILLIS) { sessionOver.await() }
            scope.cancel()
        }
    }

    private suspend fun start() {
        if (!synchronized(lock) { plan.browses }) {
            finish(failed(false))
            return
        }
        // A code whose dials are spent answers at once and browses nothing; a QR is never limited.
        val np = nameplate
        if (np != null && !budget.check(np, o.mono()).allowed) {
            budgetSpent = true
            finish(failed(false))
            return
        }
        try {
            // A QR's generator is made before anything is dialled.
            val qs = qrSecret
            val qi = qrInstance
            if (qs != null && qi != null) qrGen = cpaceGenerator(cpacePrsQr(qs), ci, requireNotNull(pairingSid(qi)))
            val epoch = advertEpoch(src.now())
            val tags = listOf(epoch, epoch - 1).map { productTag(src.slug, it) }
            browse = mdns.browse({ f -> found(f, tags) }, { synchronized(lock) { cands.remove(it) } }, { isInstanceName(it) })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            finish(e)
            return
        }
        if (synchronized(lock) { done }) return
        val seconds = minOf(o.browseSeconds, LOCAL_JOIN_BROWSE_SECONDS.toDouble())
        cancelTimer = scope.launch {
            delay((seconds * MILLIS).toLong())
            synchronized(lock) { browseOver = true }
            val b = browse
            browse = null
            try {
                b?.stop()
            } catch (e: Exception) {
                // best effort
            }
            maybeEnd()
        }
    }

    private fun failed(notFound: Boolean): PolarisException = if (notFound) {
        PolarisException(ErrorCode.pairingNotFound, "The other device was not found on this network.")
    } else {
        PolarisException(
            ErrorCode.pairingCodeFailed,
            qrInvalidDetail
                ?: if (budgetSpent) SPENT else "That code did not work.",
        )
    }

    /** Browse over and nothing is dialling: the answer is the plan's. */
    private fun maybeEnd() {
        val r: JoinResult
        synchronized(lock) {
            if (done || busy || !browseOver) return
            r = plan.result()
        }
        finish(failed(r == JoinResult.PairingNotFound))
    }

    private fun found(f: MdnsFound, tags: List<String>) {
        if (synchronized(lock) { done || browseOver }) return
        val txt = parseTxt(f.txt)
        if (txt !is TxtResult.Ok || txt.mode != PeerMode.q) return
        val hosts = f.hosts.filter { textVerdict(it, o.allowLoopback) }
        if (hosts.isEmpty()) return
        synchronized(lock) {
            if (plan.see(f.instance, txt.h in tags, txt.n.orEmpty())) cands[f.instance] = Candidate(hosts, f.port, f.socketFactory)
        }
        pump()
    }

    private fun pump() {
        var exhausted = false
        val pick: Pair<String, Candidate>? = synchronized(lock) {
            if (done || busy) return
            val next = plan.next()
            val c = next?.let { cands[it] }
            when {
                next == null -> {
                    exhausted = true
                    null
                }

                c == null -> null

                else -> next to c
            }
        }
        if (pick == null) {
            // No dial is left: the answer is the plan's, without waiting out the browse.
            if (exhausted) maybeEnd()
            return
        }
        if (!src.allowed()) {
            cancel()
            return
        }
        synchronized(lock) {
            if (done || busy) return
            busy = true
        }
        scope.launch {
            try {
                dial(pick.first, pick.second)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // a dial that faults ended before its C2
            } finally {
                synchronized(lock) {
                    busy = false
                    // A QR names one instance, so one dial is all there can be.
                    if (dials >= LOCAL_JOIN_CANDIDATES || qrInstance != null) browseOver = true
                }
                if (!synchronized(lock) { done }) pump()
                maybeEnd()
            }
        }
    }

    private fun ended(outcome: DialOutcome) = synchronized(lock) { plan.ended(outcome) }

    /** One dial. It ends the plan's turn as before-C2, after-C2 or transport. */
    private suspend fun dial(instance: String, c: Candidate) {
        synchronized(lock) { dials++ }
        val t = o.mono()
        val np = nameplate
        if (np != null) {
            // Taken in one step when the dial is made, so joins that overlap (on any thread) cannot multiply the dials.
            if (!budget.takeIfAllowed(np, t, 1).allowed) {
                budgetSpent = true
                ended(DialOutcome.BeforeC2)
                synchronized(lock) { browseOver = true }
                return
            }
        }
        val sid = pairingSid(instance)
        if (sid == null) {
            ended(DialOutcome.BeforeC2)
            return
        }
        // A typed code's map runs now, once per dial and at most twice per code in 300 s.
        val gen = qrGen?.copyOf() ?: cpaceGenerator(cpacePrsCode(requireNotNull(password)), ci, sid)
        val y = cpaceScalar(o.random)
        try {
            dialWith(y, gen, sid, c)
        } finally {
            y.fill(0)
            gen.fill(0)
        }
    }

    private suspend fun dialWith(y: ByteArray, gen: ByteArray, sid: ByteArray, c: Candidate) {
        val ya = cpaceShare(y, gen)
        gen.fill(0)
        if (ya == null) {
            ended(DialOutcome.BeforeC2)
            return
        }
        val socket = try {
            lanDialRaceTo(c.hosts, c.port, LanDialOptions(o.allowLoopback, DIAL_MILLIS).withSocketFactory(c.socketFactory)).first
        } catch (e: IOException) {
            ended(DialOutcome.BeforeC2)
            return
        }
        // The gate was cleared, or the join ended, while the socket was opening.
        if (synchronized(lock) { done }) {
            socket.close()
            return
        }
        if (!src.allowed()) {
            socket.close()
            cancel()
            return
        }
        val pipe = TcpPipe(socket)
        val at = o.mono()
        val kind = if (qrInstance != null) CpaceKind.Qr else CpaceKind.Code
        val reply = c2(pipe, encodeC1(kind, ya))
        if (reply == null) {
            pipe.close()
            ended(DialOutcome.BeforeC2)
            return
        }
        val isk = cpaceIsk(sid, y, ya, reply, initiator = true)
        if (isk == null || synchronized(lock) { done }) {
            isk?.fill(0)
            pipe.close()
            ended(DialOutcome.BeforeC2)
            return
        }
        val psk = cpacePsk(isk, src.slug)
        try {
            session(pipe, psk, isk, src.store.count(), o.mono() - at)
        } finally {
            // The session is over: its channel needed the keys for the handshake only.
            isk.fill(0)
            psk.fill(0)
        }
    }

    /** Send C1 and read C2 within the attempt's 30 s; null for anything but a valid C2. */
    private suspend fun c2(pipe: TcpPipe, c1: ByteArray): ByteArray? {
        return try {
            withTimeoutOrNull(LOCAL_ATTEMPT_SECONDS * MILLIS.toLong()) {
                pipe.write(encodeFrame(c1))
                val reader = FrameReader()
                var frame: ByteArray? = null
                while (frame == null) {
                    val chunk = pipe.read() ?: return@withTimeoutOrNull null
                    val frames = reader.push(chunk) ?: return@withTimeoutOrNull null
                    if (frames.size > 1) return@withTimeoutOrNull null
                    if (frames.size == 1) frame = frames[0]
                }
                (parseC2(frame) as? FrameVerdict.Ok)?.share
            }
        } catch (e: IOException) {
            null
        }
    }

    private suspend fun session(pipe: TcpPipe, psk: ByteArray, isk: ByteArray, held: Int, elapsed: Double) {
        val a = LocalAttempt()
        synchronized(lock) { current = a }
        val key = o.random(KEY_BYTES)
        a.linkKey = key
        var up = false
        val handlers = LinkHandlers<Unit>(
            onEstablished = { _, e ->
                up = true
                // The first session that reaches the transport ends the dial.
                ended(DialOutcome.Transport)
                a.hello = e.hello
                a.shown = true
                val offer = offerOf(a, cats, e.hello)
                try {
                    o.onConfirm(offer)
                } catch (x: Exception) {
                    // a host callback never ends the join
                }
            },
            onLocalLink = { e -> a.storing = scope.launch { store(a, e) } },
            onClosed = { c ->
                scope.launch {
                    a.closed = SessionClosed(c.code, c.byPeer)
                    a.storing?.join()
                    a.linkKey.fill(0)
                    a.closers.fire(SessionClosed(c.code, c.byPeer))
                    if (!up) ended(DialOutcome.AfterC2)
                    if (!a.linked && !synchronized(lock) { done }) {
                        if (up) {
                            finish(
                                if (a.failure == LocalPairFailureReason.Full) {
                                    localFull()
                                } else {
                                    PolarisException(
                                        ErrorCode.peerClosed,
                                        if (a.declined) "The pairing was declined." else "The pairing ended before it finished.",
                                    )
                                },
                            )
                        }
                    }
                    sessionOver.complete(Unit)
                }
            },
            anonymous = true,
        )
        val link = PeerLink(pipe, scope, handlers, maxOf(1.0, LOCAL_ATTEMPT_SECONDS - elapsed)) { send, onEvent ->
            PeerChannel(
                NoiseRole.initiator, src.slug, RawNoiseStatic(key), null, HelloInfo(hostPlatform(), src.slug, o.label), send, onEvent,
                caps = emptyList(), mode = PeerMode.q,
                pair = PairingOptions(psk, isk, held, cats, o.label, elapsed),
            )
        }
        a.link = link
        scope.launch { link.run() }
        link.start()
        sessionOver.await()
    }

    private val sessionOver = CompletableDeferred<Unit>()

    private suspend fun store(a: LocalAttempt, e: SessionEvent.LocalLinked) {
        try {
            val paired = storeLocalLink(src, a, e)
            if (paired != null) finish(null, paired)
        } catch (x: CancellationException) {
            throw x
        } catch (x: Exception) {
            a.failure = LocalPairFailureReason.Closed
            finish(x)
        }
    }

    private fun finish(err: Exception?, ok: LocalPaired? = null) {
        synchronized(lock) {
            if (done) return
            done = true
        }
        cancelTimer?.cancel()
        val b = browse
        browse = null
        scope.launch {
            try {
                b?.stop()
            } catch (e: Exception) {
                // best effort
            }
        }
        qrSecret?.fill(0)
        qrGen?.fill(0)
        current?.linkKey?.fill(0)
        if (ok != null) {
            result.complete(ok)
        } else {
            result.completeExceptionally(err ?: PolarisException(ErrorCode.peerClosed, "pairing failed"))
            // A connection still in flight is closed; a stored link has closed itself.
            val a = current
            val l = a?.link
            if (a != null && l != null && !a.linked) scope.launch { l.close(PeerCloseCode.peer_bye) }
        }
    }
}
