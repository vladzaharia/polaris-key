// The shower of a pairing window, `client.cloudConnect.localLinks.pair` (CC-29.13; WIRE-CONTRACT-V5 section 15.12, "The pairing
// window"): it shows the code and the QR, advertises `m=q` on a listener of its own and answers one CPace attempt at a time.
// The window's accounting is :core's `PairingWindow`; this file wires it. Mirrors sdk-node's `connect/localShower.ts`:
//  - the session is given `window.beginGuess` as its required permit, so a guess is counted before its tag is tried, and the
//    session's guess event is the verdict (`guessOpened` / `guessFailed`);
//  - `rotated` is told only after the new password, the new QR secret and both generators exist (the Elligator map is made
//    here, off the network path, never inside the reply to a C1);
//  - the password, the QR secret, the generators, the scalars and the ISK are wiped when the attempt or the window ends. (A
//    password is a short string and is dropped, not overwritten);
//  - the nameplate of a window that closes goes into the product's [NameplateMemory], and the next window's draw skips it for
//    300 s (a renewed window is new in every respect); the draw looks at nothing on the network;
//  - `onEnd` is told once per window, after the advert is withdrawn; a window a `renew()` replaces ends silently (`close(null)`).

@file:Suppress(
    "CyclomaticComplexMethod",
    "ReturnCount",
    "SwallowedException",
    "TooGenericExceptionCaught",
    "TooManyFunctions",
)

package im.plrs.key.sdk

import im.plrs.key.core.peer.DrawSource
import im.plrs.key.core.peer.FrameReader
import im.plrs.key.core.peer.FrameVerdict
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.LOCAL_ATTEMPT_SECONDS
import im.plrs.key.core.peer.LOCAL_PAIR_SECONDS
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.NameplateMemory
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PairingOptions
import im.plrs.key.core.peer.PairingWindow
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.RenewEnd
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.WindowOutcome
import im.plrs.key.core.peer.WindowResult
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.cpaceGenerator
import im.plrs.key.core.peer.cpaceIsk
import im.plrs.key.core.peer.cpacePrsCode
import im.plrs.key.core.peer.cpacePrsQr
import im.plrs.key.core.peer.cpacePsk
import im.plrs.key.core.peer.cpaceScalar
import im.plrs.key.core.peer.cpaceShare
import im.plrs.key.core.peer.displayCode
import im.plrs.key.core.peer.drawPassword
import im.plrs.key.core.peer.encodeC2
import im.plrs.key.core.peer.encodeFrame
import im.plrs.key.core.peer.lan.AcceptGate
import im.plrs.key.core.peer.lan.GateSlot
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.makeQr
import im.plrs.key.core.peer.pairingInstance
import im.plrs.key.core.peer.parseC1
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.productTag
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket

private const val WAITING = 4
private const val MILLIS = 1000
private const val SID_BYTES = 10
private const val QR_SECRET_BYTES = 16
private const val KEY_BYTES = 32
private const val END_MILLIS = 2_000L
private const val INTERRUPT_GAP_SECONDS = 1.0

private class Gens(val code: ByteArray, val qr: ByteArray) {
    fun wipe() {
        code.fill(0)
        qr.fill(0)
    }
}

internal class LocalShower private constructor(
    private val src: LocalSource,
    private val o: LocalPairOptions,
    private val memory: NameplateMemory,
    private val onEnd: (RenewEnd?, Double) -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()
    private val window = PairingWindow()
    private val attempts = HashSet<LocalAttempt>()
    private val cats: List<String> = o.categories.toList()
    private val mdns: MdnsAdapter = o.mdns ?: JvmMdns(scope, allowLoopback = o.allowLoopback)
    private val draw = DrawSource { n -> o.random(n) }
    private val sid: ByteArray = o.random(SID_BYTES)
    private val instance: String = pairingInstance(sid)
    private val ci: ByteArray = peerPrologue(src.slug, PeerMode.q)
    private var nameplate = ""
    private var password: String? = null
    private var qrSecret: ByteArray? = null
    private var gens: Gens? = null
    private var shown: LocalCode? = null
    private var expiresAt = 0L

    /** Connections closed without counting a guess since the code last changed ([LocalPairOptions.onInterrupted]). */
    private var interrupted = 0

    /** When `onInterrupted` was last called (monotonic seconds): at most one call a second. */
    private var interruptedAt = Double.NEGATIVE_INFINITY
    private var server: ServerSocket? = null
    private var gate: AcceptGate? = null
    private var adv: MdnsHandle? = null
    private var expiry: Job? = null

    @Volatile
    private var stopped = false

    val open: Boolean get() = !stopped

    fun code(): LocalCode? = synchronized(lock) { if (stopped) null else shown }

    override fun toString(): String = "LocalShower(open=$open)"

    private suspend fun begin() {
        window.open(o.mono())
        // Two tiers, from this device's own memory only: the adverts of other windows are not authenticated, so they do not
        // steer the draw.
        val np = memory.draw(draw, o.mono()) ?: throw localBad("No random source.")
        nameplate = np
        newSecrets()
        gate = AcceptGate(o.allowLoopback, WAITING * 2, 1, 2, o.handshakeSeconds, ::schedule)
        val s = bindServer(o.host)
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
        adv = mdns.advertise(MdnsAdvert(instance, s.localPort, listOf("v=1", "m=q", "h=${tags()[0]}", "n=$nameplate")))
        val seconds = minOf(o.seconds, LOCAL_PAIR_SECONDS.toDouble())
        expiry = scope.launch {
            delay((seconds * MILLIS).toLong())
            shutdown(true, LocalWindowEnd.Expired)
        }
        expiresAt = src.now() + seconds.toLong()
    }

    /** Show the first code (reason `opened`): the caller does so once the gate has been checked. */
    fun reveal() {
        show(LocalCodeReason.Opened)
    }

    private fun schedule(seconds: Double, fn: () -> Unit): () -> Unit {
        val job = scope.launch {
            delay((seconds * MILLIS).toLong())
            fn()
        }
        return { job.cancel() }
    }

    private fun tags(): List<String> {
        val epoch = advertEpoch(src.now())
        return listOf(epoch, epoch - 1).map { productTag(src.slug, it) }
    }

    /** A new password and QR secret, and both generators made from them. */
    private fun newSecrets() {
        val pw = drawPassword(draw) ?: throw localBad("No random source.")
        val secret = o.random(QR_SECRET_BYTES)
        val made = Gens(cpaceGenerator(cpacePrsCode(pw), ci, sid), cpaceGenerator(cpacePrsQr(secret), ci, sid))
        // Stopped while the generators were made: nothing new is kept (and nothing is left behind to be collected).
        synchronized(lock) {
            if (stopped) {
                secret.fill(0)
                made.wipe()
                return
            }
            qrSecret?.fill(0)
            gens?.wipe()
            password = pw
            qrSecret = secret
            gens = made
        }
    }

    private fun show(reason: LocalCodeReason) {
        val c = synchronized(lock) {
            val pw = password
            val qs = qrSecret
            if (stopped || pw == null || qs == null) return
            interrupted = 0
            interruptedAt = Double.NEGATIVE_INFINITY
            LocalCode(displayCode(nameplate, pw), makeQr(src.slug, instance, qs), nameplate, reason, expiresAt, window.state.failures)
                .also { shown = it }
        }
        try {
            o.onCode(c)
        } catch (e: Exception) {
            // a host callback never ends the window
        }
    }

    /**
     * Make the next code, then tell the window. `rotated` comes only after the new password, the new QR secret and both
     * generators exist; until then a C1 meets a busy window.
     */
    private suspend fun rotate(why: LocalCodeReason) {
        try {
            newSecrets()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            quiet { stop() }
            return
        }
        if (stopped) return
        show(why)
        window.rotated(o.mono())
    }

    /** [why] is the reason the next code carries when the outcome rotates it. */
    private fun applyOutcome(out: WindowOutcome, why: LocalCodeReason) {
        if (out.rotate) scope.launch { rotate(why) }
        if (out.result == WindowResult.TooManyTries) {
            try {
                o.onFailed?.invoke(LocalPairFailure(LocalPairFailureReason.TooManyTries, null))
            } catch (e: Exception) {
                // a host callback never ends the window
            }
            scope.launch { shutdown(false, LocalWindowEnd.TooManyTries) }
        }
    }

    /** A connection closed without counting a guess. */
    private fun interrupt() {
        val n = synchronized(lock) {
            if (stopped) return
            interrupted++
            val t = o.mono()
            // Counted every time, told at most once a second: a flood does not flood the host.
            if (t - interruptedAt < INTERRUPT_GAP_SECONDS) return
            interruptedAt = t
            interrupted
        }
        try {
            o.onInterrupted?.invoke(n)
        } catch (e: Exception) {
            // a host callback never ends the window
        }
    }

    suspend fun stop() = shutdown(false, LocalWindowEnd.Person)

    /**
     * Close the window, telling `onEnd` why (null: tell no one, for a window a renewal replaces). The nameplate, the secrets
     * and the advert go either way.
     */
    suspend fun close(end: LocalWindowEnd?) = shutdown(false, end)

    /** Close the window: the advert, the listener and the connections ([keepSessions] spares those past the transport). */
    private suspend fun shutdown(keepSessions: Boolean, end: LocalWindowEnd?) {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        // The expiry job is the caller of an `Expired` end: it does not cancel itself.
        if (end != LocalWindowEnd.Expired) expiry?.cancel()
        expiry = null
        val t = o.mono()
        // For the SDK's renewal floor: how this window ended, and whether it had counted a failed guess.
        val failures = window.state.failures
        window.close(t)
        // The next window of this product does not draw this nameplate for 300 s.
        if (nameplate != "") memory.shown(nameplate, t)
        try {
            server?.close()
        } catch (e: IOException) {
            // already closed
        }
        gate?.destroyPending(keepSessions)
        val a = adv
        adv = null
        quiet { a?.stop() }
        val ending = synchronized(lock) { attempts.filter { !keepSessions || it.phase != "session" } }
        // The code, the QR secret and the generators are of no use to anyone now.
        synchronized(lock) {
            qrSecret?.fill(0)
            gens?.wipe()
            qrSecret = null
            gens = null
            password = null
            shown = null
        }
        onEnd(
            when {
                end == LocalWindowEnd.TooManyTries -> RenewEnd.TooManyTries
                end != LocalWindowEnd.Stored && failures > 0 -> RenewEnd.WrongCode
                else -> null
            },
            t,
        )
        // The host hears the end once the advert is withdrawn and the listener has stopped.
        if (end != null) {
            try {
                o.onEnd?.invoke(end)
            } catch (e: Exception) {
                // a host callback never ends the window
            }
        }
        for (x in ending) {
            quiet { endAttempt(x) }
            x.linkKey.fill(0)
        }
        if (!keepSessions || synchronized(lock) { attempts.isEmpty() }) scope.cancel()
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

    // -- connections ---------------------------------------------------------------------------------

    private suspend fun accept(sock: Socket) {
        val slot = gate?.admit(sock, stopped || !src.allowed())
        if (slot == null) {
            // Refused at admission (the gate's own limits closed it): nothing is counted, but the host may want to know.
            interrupt()
            return
        }
        val at = o.mono()
        val a = LocalAttempt()
        synchronized(lock) { attempts += a }
        var handed = false
        try {
            handed = c1(a, sock, slot, at)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // an attempt that faults is closed silently
        } finally {
            if (!handed) {
                // Closed before a session took the socket: a permitted guess has none, so nothing is counted unless the attempt's
                // own C1 was admitted (then the window frees it).
                try {
                    sock.close()
                } catch (e: IOException) {
                    // already closed
                }
                slot.settle()
                over(a, true)
            }
        }
    }

    /** Reads C1, answers C2 and hands the socket to a session. True once a session owns it. */
    private suspend fun c1(a: LocalAttempt, sock: Socket, slot: GateSlot, at: Double): Boolean {
        val pipe = TcpPipe(sock)
        val reader = FrameReader()
        var frame: ByteArray? = null
        // A zero-length frame, or a peer that sent past its C1 before it had C2: closed silently.
        while (frame == null) {
            val chunk = pipe.read() ?: return false
            val frames = reader.push(chunk) ?: return false
            if (frames.size > 1) return false
            if (frames.size == 1) frame = frames[0]
        }
        val v = parseC1(frame)
        val out = window.c1(o.mono(), v is FrameVerdict.Ok)
        // Closed, busy, limited and refused: closed silently; none of them counts a failure.
        if (out.result != WindowResult.Attempt || v !is FrameVerdict.Ok || v.kind == null) {
            interrupt()
            return false
        }
        val id = out.id!!
        a.id = id
        val isCode = v.kind == im.plrs.key.core.peer.CpaceKind.Code
        val g = synchronized(lock) { gens?.let { if (isCode) it.code.copyOf() else it.qr.copyOf() } } ?: return false
        val y = cpaceScalar(o.random)
        var isk: ByteArray? = null
        var psk: ByteArray? = null
        var owned = false
        try {
            val yb = cpaceShare(y, g) ?: return false
            g.fill(0)
            pipe.write(encodeFrame(encodeC2(yb)))
            isk = cpaceIsk(sid, y, v.share, yb, initiator = false) ?: return false
            psk = cpacePsk(isk, src.slug)
            owned = startSession(a, SessionKeys(pipe, slot, psk, isk), id, at)
            return owned
        } finally {
            // Whatever the path: the scalar and the generator go, and so does a key pair no session took over.
            y.fill(0)
            g.fill(0)
            if (!owned) {
                isk?.fill(0)
                psk?.fill(0)
                a.linkKey.fill(0)
            }
        }
    }

    /** What the session of one attempt starts from. */
    private class SessionKeys(val pipe: TcpPipe, val slot: GateSlot, val psk: ByteArray, val isk: ByteArray) {
        override fun toString(): String = "SessionKeys"
    }

    /** Starts the session under [k]. False when the window closed first; the caller then wipes the keys. */
    private suspend fun startSession(a: LocalAttempt, k: SessionKeys, id: Int, at: Double): Boolean {
        val held = src.store.count()
        if (stopped) return false
        val key = o.random(KEY_BYTES)
        a.linkKey = key
        val elapsed = o.mono() - at
        val handlers = LinkHandlers<Unit>(
            onEstablished = { _, e ->
                k.slot.established()
                a.hello = e.hello
                offer(a)
            },
            onClosed = { c -> scope.launch { closed(a, SessionClosed(c.code, c.byPeer)) } },
            onEnded = { k.slot.settle() },
            onGuess = { g2 -> guess(a, g2) },
            onLocalLink = { e -> a.storing = scope.launch { store(a, e) } },
            anonymous = true,
        )
        val remaining = maxOf(1.0, LOCAL_ATTEMPT_SECONDS - elapsed)
        val link = PeerLink(k.pipe, scope, handlers, remaining) { send, onEvent ->
            PeerChannel(
                NoiseRole.responder, src.slug, RawNoiseStatic(key), null, HelloInfo(pairingPlatform(), src.slug, o.label), send, onEvent,
                caps = emptyList(), mode = PeerMode.q,
                // The required permit: it counts the guess before the tag is tried.
                pair = PairingOptions(k.psk, k.isk, held, cats, o.label, elapsed) {
                    window.beginGuess(id, o.mono()).also { ok -> if (ok) a.permitted = true }
                },
            )
        }
        a.link = link
        scope.launch { link.run() }
        return true
    }

    private fun guess(a: LocalAttempt, e: SessionEvent.Guess) {
        val id = a.id
        val t = o.mono()
        // The verdict of the permitted guess: opened (the count is refunded and the attempt is the session) or failed (the
        // code rotates).
        val out = if (id == null) {
            null
        } else if (e.opens) {
            window.guessOpened(id, t)
        } else {
            window.guessFailed(id, t)
        }
        a.phase = if (e.opens) "session" else "done"
        if (out != null) applyOutcome(out, LocalCodeReason.WrongCode)
    }

    private fun offer(a: LocalAttempt) {
        val hello = a.hello
        if (a.shown || stopped || hello == null) return
        a.shown = true
        synchronized(lock) {
            interrupted = 0
            interruptedAt = Double.NEGATIVE_INFINITY
        }
        val offer = offerOf(a, cats, hello)
        try {
            o.onConfirm(offer)
        } catch (e: Exception) {
            // a host callback never ends the window
        }
    }

    private suspend fun store(a: LocalAttempt, e: SessionEvent.LocalLinked) {
        try {
            val paired = storeLocalLink(src, a, e)
            if (paired != null) {
                try {
                    o.onLinked?.invoke(paired)
                } catch (x: Exception) {
                    // a host callback never ends the window
                }
            }
        } catch (x: CancellationException) {
            throw x
        } catch (x: Exception) {
            a.failure = LocalPairFailureReason.Closed
        }
    }

    private suspend fun closed(a: LocalAttempt, c: SessionClosed) {
        if (a.closed != null) return
        a.closed = c
        // The store runs beside the close: judge the window on its result.
        a.storing?.join()
        val t = o.mono()
        var out = WindowOutcome()
        val id = a.id
        // What the next code says when this end rotates it ([LocalCode.reason]).
        var why = LocalCodeReason.WrongCode
        val reason = a.failure ?: if (c.code == PeerCloseCode.peer_timeout.name) LocalPairFailureReason.Timeout else LocalPairFailureReason.Closed
        if (a.phase == "session") {
            out = window.sessionEnd(t, a.linked)
            why = when (reason) {
                LocalPairFailureReason.Declined -> LocalCodeReason.Declined
                LocalPairFailureReason.Timeout -> LocalCodeReason.Timeout
                else -> LocalCodeReason.Closed
            }
        } else if (id != null && a.phase != "done") {
            // A permitted guess that has no verdict is a failed guess; one that never reached its guess counts nothing.
            out = window.abandon(id, t)
            if (!a.permitted) interrupt()
        }
        over(a, false)
        a.closers.fire(c)
        if (a.shown && !a.linked && !stopped) {
            try {
                o.onFailed?.invoke(LocalPairFailure(reason, c))
            } catch (x: Exception) {
                // a host callback never ends the window
            }
        }
        if (a.linked) shutdown(false, LocalWindowEnd.Stored) else applyOutcome(out, why)
    }

    /** The attempt is over: its key and its place go; [pre] is a socket that closed before its session began. */
    private fun over(a: LocalAttempt, pre: Boolean) {
        val last = synchronized(lock) {
            attempts -= a
            stopped && attempts.isEmpty()
        }
        a.linkKey.fill(0)
        val id = a.id
        if (pre && id != null && a.phase == "c1") {
            applyOutcome(window.abandon(id, o.mono()), LocalCodeReason.WrongCode)
            interrupt()
        }
        if (last) scope.cancel()
    }

    private suspend fun endAttempt(a: LocalAttempt) {
        a.local = true
        val l = a.link
        if (l != null) withTimeoutOrNull(END_MILLIS) { l.close(PeerCloseCode.peer_bye) }
    }

    companion object {
        /** Validate, listen and advertise. Throws [LanException] `bad_type` for options that break a rule. */
        suspend fun start(src: LocalSource, o: LocalPairOptions, memory: NameplateMemory, onEnd: (RenewEnd?, Double) -> Unit): LocalShower {
            checkLocalOptions(o)
            if (!(o.seconds > 0)) throw localBad("seconds must be above 0.")
            val s = LocalShower(src, o, memory, onEnd)
            try {
                s.begin()
            } catch (e: Throwable) {
                s.quiet { s.close(null) }
                throw e
            }
            return s
        }
    }
}
