// The shower of a pairing window, `client.cloudConnect.localLinks.pair` (CC-29.13; WIRE-CONTRACT-V5 section 15.12, "The pairing
// window"): it shows the code and the QR, advertises `m=q` on a listener of its own and answers one CPace attempt at a time.
// The window's accounting is :core's `PairingWindow`; this file wires it. Mirrors sdk-node's `connect/localShower.ts`:
//  - the session is given `window.beginGuess` as its required permit, so a guess is counted before its tag is tried, and the
//    session's guess event is the verdict (`guessOpened` / `guessFailed`);
//  - `rotated` is told only after the new password, the new QR secret and both generators exist (the Elligator map is made
//    here, off the network path, never inside the reply to a C1);
//  - the password, the QR secret, the generators, the scalars and the ISK are wiped when the attempt or the window ends. (A
//    password is a short string and is dropped, not overwritten.)

package im.plrs.key.sdk

import im.plrs.key.core.peer.FrameReader
import im.plrs.key.core.peer.FrameVerdict
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.LOCAL_ATTEMPT_SECONDS
import im.plrs.key.core.peer.LOCAL_PAIR_SECONDS
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PairingOptions
import im.plrs.key.core.peer.PairingWindow
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
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
import im.plrs.key.core.peer.drawNameplate
import im.plrs.key.core.peer.drawPassword
import im.plrs.key.core.peer.DrawSource
import im.plrs.key.core.peer.encodeC2
import im.plrs.key.core.peer.encodeFrame
import im.plrs.key.core.peer.isInstanceName
import im.plrs.key.core.peer.lan.AcceptGate
import im.plrs.key.core.peer.lan.GateSlot
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.makeQr
import im.plrs.key.core.peer.pairingInstance
import im.plrs.key.core.peer.parseC1
import im.plrs.key.core.peer.parseTxt
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.productTag
import im.plrs.key.core.peer.TxtResult
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
private const val MAX_IN_USE = 64

private class Gens(val code: ByteArray, val qr: ByteArray) {
    fun wipe() {
        code.fill(0)
        qr.fill(0)
    }
}

internal class LocalShower private constructor(
    private val src: LocalSource,
    private val o: LocalPairOptions,
    private val onEnd: () -> Unit,
) : LocalPairHandle {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()
    private val window = PairingWindow()
    private val attempts = HashSet<LocalAttempt>()
    private val inUse = LinkedHashMap<String, String>()
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
    private var server: ServerSocket? = null
    private var gate: AcceptGate? = null
    private var adv: MdnsHandle? = null
    private var browse: MdnsHandle? = null
    private var expiry: Job? = null

    @Volatile
    private var stopped = false

    override val open: Boolean get() = !stopped

    override fun code(): LocalCode? = synchronized(lock) { if (stopped) null else shown }

    override fun toString(): String = "LocalShower(open=$open)"

    private suspend fun begin() {
        window.open(o.mono())
        // The nameplates other windows of this product are using on the link: best effort, from what the browse has seen.
        val tags = tags()
        browse = mdns.browse({ f -> scope.launch { quiet { seen(f, tags) } } }, { synchronized(lock) { inUse.remove(it) } }, { isInstanceName(it) })
        val np = drawNameplate(draw, synchronized(lock) { inUse.values.toList() }) ?: throw localBad("No random source.")
        nameplate = np
        renew()
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
            shutdown(true)
        }
        show()
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

    private fun seen(f: MdnsFound, tags: List<String>) {
        if (stopped || f.instance == instance) return
        val txt = parseTxt(f.txt)
        if (txt !is TxtResult.Ok || txt.mode != PeerMode.q || txt.h !in tags) return
        synchronized(lock) { if (inUse.size < MAX_IN_USE) inUse[f.instance] = txt.n.orEmpty() }
    }

    /** A new password and QR secret, and both generators made from them. */
    private fun renew() {
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

    private fun show() {
        val c = synchronized(lock) {
            val pw = password
            val qs = qrSecret
            if (stopped || pw == null || qs == null) return
            LocalCode(displayCode(nameplate, pw), makeQr(src.slug, instance, qs), nameplate).also { shown = it }
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
    private suspend fun rotate() {
        try {
            renew()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            quiet { stop() }
            return
        }
        if (stopped) return
        show()
        window.rotated(o.mono())
    }

    private fun applyOutcome(out: WindowOutcome) {
        if (out.rotate) scope.launch { rotate() }
        if (out.result == WindowResult.TooManyTries) {
            try {
                o.onFailed?.invoke(LocalPairFailure(LocalPairFailureReason.TooManyTries, null))
            } catch (e: Exception) {
                // a host callback never ends the window
            }
            scope.launch { shutdown(false) }
        }
    }

    override suspend fun stop() = shutdown(false)

    /** Close the window: the advert, the listener and the connections ([keepSessions] spares those past the transport). */
    private suspend fun shutdown(keepSessions: Boolean) {
        synchronized(lock) {
            if (stopped) return
            stopped = true
        }
        expiry?.cancel()
        expiry = null
        window.close(o.mono())
        try {
            server?.close()
        } catch (e: IOException) {
            // already closed
        }
        gate?.destroyPending(keepSessions)
        val a = adv
        val b = browse
        adv = null
        browse = null
        quiet { a?.stop() }
        quiet { b?.stop() }
        val ending = synchronized(lock) { attempts.filter { !keepSessions || it.phase != "session" } }
        for (x in ending) quiet { end(x) }
        // The code, the QR secret and the generators are of no use to anyone now.
        synchronized(lock) {
            qrSecret?.fill(0)
            gens?.wipe()
            qrSecret = null
            gens = null
            password = null
            shown = null
            inUse.clear()
        }
        onEnd()
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
        val slot = gate?.admit(sock, stopped || !src.allowed()) ?: return
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
        if (out.result != WindowResult.Attempt || v !is FrameVerdict.Ok || v.kind == null) return false
        val id = out.id!!
        a.id = id
        val isCode = v.kind == im.plrs.key.core.peer.CpaceKind.code
        val g = synchronized(lock) { gens?.let { if (isCode) it.code.copyOf() else it.qr.copyOf() } } ?: return false
        val y = cpaceScalar(o.random)
        val yb = cpaceShare(y, g) ?: return false
        g.fill(0)
        pipe.write(encodeFrame(encodeC2(yb)))
        val isk = cpaceIsk(sid, y, v.share, yb, initiator = false) ?: return false
        val psk = cpacePsk(isk, src.slug)
        val held = src.store.count()
        if (stopped) {
            isk.fill(0)
            psk.fill(0)
            return false
        }
        val key = o.random(KEY_BYTES)
        a.linkKey = key
        val elapsed = o.mono() - at
        val handlers = LinkHandlers<Unit>(
            onEstablished = { _, e ->
                slot.established()
                a.hello = e.hello
                offer(a)
            },
            onClosed = { c -> scope.launch { closed(a, SessionClosed(c.code, c.byPeer)) } },
            onEnded = { slot.settle() },
            onGuess = { g2 -> guess(a, g2) },
            onLocalLink = { e -> a.storing = scope.launch { store(a, e) } },
            anonymous = true,
        )
        val remaining = maxOf(1.0, LOCAL_ATTEMPT_SECONDS - elapsed)
        val link = PeerLink(pipe, scope, handlers, remaining) { send, onEvent ->
            PeerChannel(
                NoiseRole.responder, src.slug, RawNoiseStatic(key), null, HelloInfo(hostPlatform(), src.slug, o.label), send, onEvent,
                caps = emptyList(), mode = PeerMode.q,
                // The required permit: it counts the guess before the tag is tried.
                pair = PairingOptions(psk, isk, held, cats, o.label, elapsed) { window.beginGuess(id, o.mono()) },
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
        val out = if (id == null) null else if (e.opens) window.guessOpened(id, t) else window.guessFailed(id, t)
        a.phase = if (e.opens) "session" else "done"
        if (out != null) applyOutcome(out)
    }

    private fun offer(a: LocalAttempt) {
        val hello = a.hello
        if (a.shown || stopped || hello == null) return
        a.shown = true
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
        if (a.phase == "session") {
            out = window.sessionEnd(t, a.linked)
        } else if (id != null && a.phase != "done") {
            // A permitted guess that has no verdict is a failed guess; one that never reached its guess counts nothing.
            out = window.abandon(id, t)
        }
        over(a, false)
        a.closers.fire(c)
        if (a.shown && !a.linked && !stopped) {
            val reason = a.failure ?: if (c.code == PeerCloseCode.peer_timeout.name) LocalPairFailureReason.Timeout else LocalPairFailureReason.Closed
            try {
                o.onFailed?.invoke(LocalPairFailure(reason, c))
            } catch (x: Exception) {
                // a host callback never ends the window
            }
        }
        if (a.linked) shutdown(false) else applyOutcome(out)
    }

    /** The attempt is over: its key and its place go; [pre] is a socket that closed before its session began. */
    private fun over(a: LocalAttempt, pre: Boolean) {
        val last = synchronized(lock) {
            attempts -= a
            stopped && attempts.isEmpty()
        }
        a.linkKey.fill(0)
        val id = a.id
        if (pre && id != null && a.phase == "c1") applyOutcome(window.abandon(id, o.mono()))
        if (last) scope.cancel()
    }

    private suspend fun end(a: LocalAttempt) {
        a.local = true
        val l = a.link
        if (l != null) withTimeoutOrNull(END_MILLIS) { l.close(PeerCloseCode.peer_bye) }
    }

    companion object {
        /** Validate, listen, advertise and browse. Throws [LanException] `bad_type` for options that break a rule. */
        suspend fun start(src: LocalSource, o: LocalPairOptions, onEnd: () -> Unit): LocalShower {
            checkLocalOptions(o)
            if (!(o.seconds > 0)) throw localBad("seconds must be above 0.")
            val s = LocalShower(src, o, onEnd)
            try {
                s.begin()
            } catch (e: Throwable) {
                s.quiet { s.stop() }
                throw e
            }
            return s
        }
    }
}
