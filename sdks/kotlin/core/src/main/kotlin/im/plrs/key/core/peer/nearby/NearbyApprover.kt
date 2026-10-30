// The approver half of nearby approval (CC-15.K2; WIRE-CONTRACT-V5 sections 15.4 and 15.6.1): a signed-in
// device (M) advertises under a random instance, lets a nearby device (D) with no sign-in connect in mode
// v, shows three codes and, when the person picks the one D shows, hands the verified `VOUCH_REQ` to the
// host. The host calls `nearby/approve` and gives the answer back; this module maps it to `VOUCH_RESULT`.
// It calls no route. Mirrors sdk-node's `connect/nearbyApprover.ts` (with its red-team fixes).
//
// Rules this module keeps:
//  - the advert is `p1-` + 10 random bytes in base32 with `v=1`, `m=v` and the product tag; it has a
//    listener of its own, and the instance and the port are both new at every listen and every 300 s (the
//    old listener closes at once; a session past the transport stays);
//  - it stands only while the device is signed in, discovery names `nearby` and `nearbyApprove`, and the
//    host opened the prompt or allowed background approval (`background`, required with `prompt` off); it
//    stops on `pause()`, on `stop()`, when the device signs out, when discovery loses `nearby`, when a
//    renewal fails and when the failure budget is spent (two prompted failures in 10 minutes). `stop()`, a
//    sign-out, a lost discovery and a failed renewal are final: no later call brings the advert back. A
//    budget stop is cleared by `reopen()` or `setPrompt(true)` only; `pause()` works from `Advertising`
//    only, and `resume()` only from the host's own pause, after signedIn and discovery are read again;
//  - `stop()` and the sign-out do not wait for a renewal or a queued call: the state, the listener, the
//    advert and the sessions go down at once, and `destroy()` drops the sockets;
//  - accept is the mode-a gate (`AcceptGate`: the same verdict on the socket's own addresses, the same
//    pending limits), and here one waiting session per source address;
//  - one prompt at a time, held until the picked session finishes or closes. A session that reaches the
//    code stage meanwhile waits with no code shown and its 120 s deadline running. With the prompt closed
//    a session only raises a notice. A prompt that was shown and whose peer then closes before the person
//    answered counts as a failure;
//  - the host's callbacks (`onNotice`, `onStopped`, `onClose`) are called inside a guard: a throw cannot
//    skip the cleanup that follows;
//  - a wrong pick, "None of these match", the host's close and the deadline end the session before
//    `VOUCH_REQ` is delivered, and no route is called;
//  - `finish()` is refused unless the person picked the right code on this session and `VOUCH_REQ`
//    verified (no silent approval); records for Sync go out only after `approved`;
//  - the request handle, `sig`, `h`, the nonces and the one-time keys are in no message, repr or error; the
//    one-time static key is wiped when the handshake ends.
//
// Threads: every piece of state lives on one single-threaded dispatcher, so the logic reads like the
// reference's single event loop. Callbacks to the host (`handler`, `onNotice`, `onStopped`, `onClose`) run
// on that thread: keep them short, and call back into the session from a coroutine of your own. `stop()`
// and `destroy()` never wait for a host callback that blocks.

package im.plrs.key.core.peer.nearby

import im.plrs.key.core.peer.AbandonReason
import im.plrs.key.core.peer.ApproveAnswer
import im.plrs.key.core.peer.FinishAction
import im.plrs.key.core.peer.HandshakeLimiter
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.LinkHandlers
import im.plrs.key.core.peer.NoisePorts
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerChannel
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerHello
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.RecordType
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.VOUCH_REQ_MAX
import im.plrs.key.core.peer.VouchFailureBudget
import im.plrs.key.core.peer.VouchFlow
import im.plrs.key.core.peer.VouchHello
import im.plrs.key.core.peer.VouchMessage
import im.plrs.key.core.peer.VouchRequest
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.VouchVerdict
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.approverInstance
import im.plrs.key.core.peer.buildVouchResult
import im.plrs.key.core.peer.decoyCodes
import im.plrs.key.core.peer.finishMap
import im.plrs.key.core.peer.lan.AcceptGate
import im.plrs.key.core.peer.lan.GateSlot
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.lan.inetAddressOfLiteral
import im.plrs.key.core.peer.peerHostPlatform
import im.plrs.key.core.peer.productTag
import im.plrs.key.core.peer.sasDisplay
import im.plrs.key.core.peer.verifyVouchRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** What the approver reads of the client, at start and at each renewal. */
public interface ApproverSource {
    /** The product slug. */
    public val slug: String

    /** Seconds since the epoch. */
    public fun now(): Long

    /** This device is signed in on the product. */
    public suspend fun signedIn(): Boolean

    /** A fresh read of discovery: it names `nearby` and `nearbyApprove` (section 12.11.6). */
    public suspend fun nearbyServed(): Boolean
}

/** What a session that wants approval shows while the prompt is closed: no code, no pick. */
public class ApprovalNotice(public val label: String?, public val platform: String) {
    override fun toString(): String = "ApprovalNotice"
}

/** Why an advert is not standing. */
public enum class NearbyStopReason { budget, signed_out, discovery, host }

/** Where the advert stands. */
public enum class NearbyState { advertising, paused, stopped }

/** The approver's state, its reason when it is not advertising, and whether the prompt is open. */
public class NearbyApproverStatus(public val state: NearbyState, public val reason: NearbyStopReason?, public val prompt: Boolean) {
    override fun toString(): String = "NearbyApproverStatus($state, $reason, prompt=$prompt)"
}

/** The answer of `nearby/approve` as the host read it (rule 6). */
public class ApproveAnswerInput(
    /** The HTTP status, or null when there was no answer. */
    public val http: Int?,
    /** The body text, or null. */
    public val body: String?,
    /** The host's fresh read of discovery: does it still name `nearby` and `nearbyApprove`? */
    public val discoveryNearby: Boolean,
) {
    override fun toString(): String = "ApproveAnswerInput(http=$http)"
}

/** What `pick` answers. */
public sealed class PickOutcome {
    /** The right code: exactly what `nearby/approve` gets. */
    public class Verified(public val request: VouchRequest) : PickOutcome() {
        override fun toString(): String = "Verified"
    }

    /** A wrong code: the session closed, nothing was delivered and no route is to be called. */
    public object Mismatch : PickOutcome()

    /** The right code but the request did not verify, or the session ended: it closed. */
    public object Invalid : PickOutcome()
}

/** What `finish` answers. */
public sealed class FinishOutcome {
    /** `VOUCH_RESULT` went out with this status. After `approved` the session stays open for records. */
    public class Sent(public val status: VouchStatus) : FinishOutcome()

    /** Nothing sent yet: show the choice (`choice`), or register this device's keys (`keys`), then call `finish` again. */
    public class Wait(public val what: String) : FinishOutcome()

    /** Nothing sent; the session closed `peer_bye`. */
    public object Closed : FinishOutcome()
}

/** One session asking for approval, as the host's handler sees it. */
public interface NearbyApproval {
    /**
     * What D's `HELLO` showed. Unauthenticated display data: any device on the network can send any label,
     * and the cleaning leaves some invisible blanks, so a label can look empty or like another device's.
     * Show it as "reported by the device" beside the platform and the codes, never as proof of who is
     * asking; the person's pick of the matching code is the only check.
     */
    public val label: String?
    public val platform: String

    /** The three codes, in the order to show them, each like `123 456`. */
    public val codes: List<String>

    /**
     * The person picked this code. The right one delivers D's `VOUCH_REQ`, which is verified here: the
     * result is exactly what `nearby/approve` gets. A wrong code closes the session, calls no route and
     * answers [PickOutcome.Mismatch]; a request that does not verify closes it and answers [PickOutcome.Invalid].
     */
    public suspend fun pick(code: String): PickOutcome

    /** "None of these match": the session closes, nothing is delivered and no route is called. */
    public suspend fun decline()

    /** Give the answer of `nearby/approve` back; sends `VOUCH_RESULT` (rule 6). */
    public suspend fun finish(answer: ApproveAnswerInput): FinishOutcome

    /** After `approved`: a Sync record (`0x0030` to `0x003F`) to D. */
    public suspend fun sendRecord(type: Int, body: ByteArray)

    /** The host leaves: the session closes `peer_bye`. Before a pick this counts for nothing. */
    public suspend fun close()

    /** Called once when the session ends (at once, when it already has). Returns the unsubscribe. */
    public fun onClose(fn: (SessionEvent.Closed) -> Unit): () -> Unit
}

/** Called with each session that reaches the code stage while the prompt is open. A fun interface, so Java passes a lambda too. */
public fun interface NearbyApprovalHandler {
    public fun onApproval(approval: NearbyApproval)
}

/** The handle of a running approver. */
public interface NearbyApproverHandle {
    /** Stop for good: the advert, the listener and every session. Nothing brings them back. */
    public suspend fun stop()

    /** Stop advertising and close live sessions until [resume]. Works from `advertising` only. */
    public suspend fun pause()

    /**
     * Start again after the host's own [pause]. It reads sign-in and discovery again first, and does nothing
     * after a stop, a sign-out or a spent budget.
     */
    public suspend fun resume()

    /**
     * The "Approve a nearby device" screen opens (true) or closes (false). Opening it also counts the failure
     * budget from zero and starts a stopped (budget) or paused advert again; closing it ends the prompt that
     * is showing and, without `background`, pauses the advert.
     */
    public suspend fun setPrompt(open: Boolean)

    /** Count the failure budget from zero and start a budget-stopped advert again. */
    public suspend fun reopen()

    public fun status(): NearbyApproverStatus

    /** Drop everything now, with no goodbye (the sign-out bound's force path). Never waits. */
    public fun destroy()
}

/** Options of the approver. */
public class NearbyApproverOptions(
    /** The "Approve a nearby device" screen is open. Without it a session raises [onNotice] only. */
    public val prompt: Boolean,
    /**
     * The person allowed background approval (and the system permission is granted). Required with
     * `prompt = false`; with it the advert stands while the screen is closed and a session raises
     * [onNotice]. Without it, closing the screen (`setPrompt(false)`) pauses the advert.
     */
    public val background: Boolean = false,
    /**
     * This device's label in `HELLO` (display data; optional). It is shown on the other device, so name the
     * device ("Ana's laptop"); never use an account identifier (an email address, a user id) as the label.
     */
    public val label: String? = null,
    /** Called with a session that wants approval while the prompt is closed: no code, no pick. */
    public val onNotice: ((ApprovalNotice) -> Unit)? = null,
    /** Called when the advert stops on its own (everything but the host's own `pause`/`stop`). */
    public val onStopped: ((NearbyStopReason) -> Unit)? = null,
    public val mdns: MdnsAdapter? = null,
    /** Where to listen, as a literal. Default `::` (both families on one port), or 0.0.0.0. */
    public val host: String? = null,
    /** Accept loopback peers. For tests and same-host use only. */
    public val allowLoopback: Boolean = false,
    /** The IPv4 addresses of the networks the default adapter uses (the `lan.interfaces` override). */
    public val interfaces: List<String>? = null,
    public val handshakeSeconds: Double = HANDSHAKE_WINDOW_SECONDS,
    /** Seconds between advert renewals (default 300). */
    public val renewSeconds: Double = RENEW_SECONDS,
    /** Seconds a session stays open after the person's pick (default 300, rule 8). */
    public val keepOpenSeconds: Double = KEEP_OPEN_SECONDS,
    /** Seconds to wait for `VOUCH_REQ` after the right pick (default 30). */
    public val requestWaitSeconds: Double = HELD_REQUEST_SECONDS,
    /** Sessions at once (default 8). */
    public val maxSessions: Int = MAX_SESSIONS,
    /** Waiting sessions from one source address (default 1, rule 2). For tests that share one. */
    public val maxPendingPerAddress: Int = 1,
    /** Schedule `fn` after `seconds`; returns the cancel. Default: a delay in the approver's scope. */
    public val timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
    /** Monotonic seconds (limiter, failure budget). */
    public val mono: () -> Double = { System.nanoTime() / NANOS },
    /** CSPRNG bytes (instance, decoys, one-time keys). */
    public val random: (Int) -> ByteArray = NoisePorts.defaultRandom,
    /** The platform shown to D in `HELLO`. */
    public val platform: String = peerHostPlatform(),
) {
    override fun toString(): String = "NearbyApproverOptions"

    public companion object {
        internal const val HANDSHAKE_WINDOW_SECONDS: Double = 30.0
        internal const val RENEW_SECONDS: Double = 300.0
        internal const val KEEP_OPEN_SECONDS: Double = 300.0
        internal const val HELD_REQUEST_SECONDS: Double = 30.0
        internal const val MAX_SESSIONS: Int = 8
        internal const val NANOS: Double = 1e9
    }
}

/** The most a renewal waits on the host's sign-in or discovery read. */
private const val CHECK_SECONDS = 15.0

/** Waiting sessions from one /24 or /64 (rule 2). */
private const val PER_GROUP = 2

/** Waiting sessions at once, and handshakes a minute (rule 2). */
private const val WAITING = 4
private const val PER_MINUTE = 5
private const val BACKLOG = 16
private const val MILLIS = 1000
private const val CODE_DIGITS = 6
private const val CODE_LIMIT = 1_000_000
private const val CRITICAL_FIRST = 0x8100
private const val CRITICAL_LAST = 0xfffd
private const val SYNC_FIRST = 0x0030
private const val SYNC_LAST = 0x003f

/** A code the person picked: `123 456`, `123456`; null when it is neither. */
private fun codeValue(code: String): Int? {
    val digits = code.filter { !it.isWhitespace() }
    return if (digits.length == CODE_DIGITS && digits.all { it in '0'..'9' }) digits.toInt().takeIf { it < CODE_LIMIT } else null
}

private class Generation(val server: ServerSocket, val gate: AcceptGate, val limiter: HandshakeLimiter, val adv: MdnsHandle) {
    @Volatile var retired = false
}

/** One inbound session of the approver. */
private class Live(val socket: Socket, val slot: GateSlot, val st: RawNoiseStatic, val flow: VouchFlow<VouchMessage>) {
    lateinit var link: PeerLink<Unit>
    val channel: PeerChannel get() = link.channel
    var hello: PeerHello? = null
    var sas: Int? = null
    var noticed = false
    var shown = false
    var picked = false
    var keysRetried = false
    var dead = false

    /** This module ended the session (a pick, a close, the host, a pause): not the peer's doing. */
    var local = false
    var pick: Deferred<PickOutcome>? = null
    val request = CompletableDeferred<VouchRequest?>()
    val closers = ArrayList<(SessionEvent.Closed) -> Unit>()
    val cancels = ArrayList<() -> Unit>()
    var closed: SessionEvent.Closed? = null
}

public class NearbyApprover private constructor(
    private val src: ApproverSource,
    private val handler: NearbyApprovalHandler,
    private val o: NearbyApproverOptions,
    parent: CoroutineScope?,
) : NearbyApproverHandle {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob(parent?.coroutineContext?.get(Job)) + dispatcher)
    private val mdns: MdnsAdapter = o.mdns ?: JvmMdns(scope, allowLoopback = o.allowLoopback, interfaces = o.interfaces)
    private val budget = VouchFailureBudget(o.mono)
    private val live = LinkedHashSet<Live>()
    private var queue = ArrayList<Live>()
    private var active: Live? = null
    private var gen: Generation? = null
    private var cancelRenew: (() -> Unit)? = null
    private val work = Mutex()
    private val ports = NoisePorts(random = o.random)

    /** Sockets to drop when [destroy] cannot wait for the dispatcher. */
    private val sockets = ConcurrentHashMap.newKeySet<java.io.Closeable>()

    @Volatile private var prompt: Boolean = o.prompt

    @Volatile private var state = NearbyState.stopped

    @Volatile private var reason: NearbyStopReason? = null

    /** A stop that nothing undoes: `stop()`, a sign-out, lost discovery, a failed renewal. */
    @Volatile private var final = false

    /** Bumped by every halt; an `advertise` or a check that began before it gives up. */
    private val epoch = AtomicInteger()

    override fun toString(): String = "NearbyApprover(${state.name})"

    override fun status(): NearbyApproverStatus = NearbyApproverStatus(state, reason, prompt)

    // -- the handle ------------------------------------------------------------------------------

    /**
     * Final, and not queued: the state, the listener, the advert and the sessions go down at once, so a
     * renewal that hangs on the host's reads cannot hold a sign-out back.
     */
    override suspend fun stop() {
        final = true
        onScope { halt(NearbyState.stopped, NearbyStopReason.host) }
    }

    /** Drop everything now, with no goodbye. Callable from any thread; waits for nothing. */
    override fun destroy() {
        final = true
        epoch.incrementAndGet()
        state = NearbyState.stopped
        reason = NearbyStopReason.host
        for (c in sockets) {
            try {
                c.close()
            } catch (e: IOException) {
                // already closed
            }
        }
        scope.cancel()
    }

    override suspend fun pause() {
        serial {
            if (!final && state == NearbyState.advertising) halt(NearbyState.paused, NearbyStopReason.host)
        }
    }

    override suspend fun resume() {
        serial {
            if (!final && state == NearbyState.paused && reason == NearbyStopReason.host) restart()
        }
    }

    override suspend fun setPrompt(open: Boolean) {
        serial {
            if (final || open == prompt) return@serial
            prompt = open
            if (!open) {
                // The screen closed: the prompt that is showing ends, and the others go passive.
                val shown = active
                active = null
                if (shown != null && !shown.picked) endNow(shown, PeerCloseCode.peer_bye)
                for (l in queue) l.noticed = false
                // Without background approval nothing stands for a closed screen.
                if (!o.background && state == NearbyState.advertising) halt(NearbyState.paused, NearbyStopReason.host)
                pump()
                return@serial
            }
            budget.reopen()
            if ((state == NearbyState.stopped && reason == NearbyStopReason.budget) ||
                (state == NearbyState.paused && reason == NearbyStopReason.host)
            ) {
                restart()
            }
            pump()
        }
    }

    override suspend fun reopen() {
        serial {
            if (final) return@serial
            budget.reopen()
            if (state == NearbyState.stopped && reason == NearbyStopReason.budget) restart()
        }
    }

    // -- the scope -------------------------------------------------------------------------------

    private suspend fun <T> onScope(block: suspend () -> T): T = withContext(dispatcher) { block() }

    /** Pause, resume and the like run one at a time, in order, on the approver's thread. */
    private suspend fun serial(block: suspend () -> Unit) {
        onScope { work.withLock { block() } }
    }

    /** Schedule [fn] on the approver's thread after [seconds]; returns the cancel. */
    private fun after(seconds: Double, fn: () -> Unit): () -> Unit {
        val custom = o.timer
        if (custom != null) return custom(seconds) { scope.launch { fn() } }
        val job = scope.launch {
            delay((seconds * MILLIS).toLong())
            fn()
        }
        return { job.cancel() }
    }

    private inline fun guarded(fn: () -> Unit) {
        try {
            fn()
        } catch (e: Exception) {
            // The host's bug is the host's; the module's own state is already settled.
        }
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

    /** A host read that may hang or fail: past [CHECK_SECONDS], or on a throw, it reads as "no". */
    private suspend fun check(read: suspend () -> Boolean): Boolean {
        val out = CompletableDeferred<Boolean>()
        // A destroyed approver reads as "no", and so does a read that outlives the timer.
        val gone = scope.coroutineContext[Job]?.invokeOnCompletion { out.complete(false) }
        val cancel = after(CHECK_SECONDS) { out.complete(false) }
        val job = scope.launch(Dispatchers.IO) {
            val v = try {
                read()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            out.complete(v)
        }
        try {
            return out.await()
        } finally {
            gone?.dispose()
            cancel()
            job.cancel()
        }
    }

    /**
     * Start the advert again from a pause or a budget stop, after reading sign-in and discovery again. A
     * stop, or a halt that landed meanwhile, wins.
     */
    private suspend fun restart() {
        if (budget.stopped) {
            if (state == NearbyState.paused) halt(NearbyState.stopped, NearbyStopReason.budget)
            return
        }
        val ep = epoch.get()
        val signed = check { src.signedIn() }
        if (final || ep != epoch.get()) return
        if (!signed) return halt(NearbyState.stopped, NearbyStopReason.signed_out)
        val served = check { src.nearbyServed() }
        if (final || ep != epoch.get()) return
        if (!served) return halt(NearbyState.stopped, NearbyStopReason.discovery)
        advertise()
    }

    // -- the advert ------------------------------------------------------------------------------

    private fun bind(): ServerSocket {
        val host = o.host
        val any6 = inetAddressOfLiteral("::")
        val any4 = inetAddressOfLiteral("0.0.0.0")
        return when {
            host != null -> ServerSocket(0, BACKLOG, requireNotNull(inetAddressOfLiteral(host)) { "nearby host: not an address" })
            else -> runCatching { ServerSocket(0, BACKLOG, any6) }.getOrElse { ServerSocket(0, BACKLOG, any4) }
        }
    }

    /** A new listener, port and instance; the old generation retires. Starts the renewal clock. */
    private suspend fun advertise() {
        val ep = epoch.get()
        val gate = AcceptGate(
            allowLoopback = o.allowLoopback,
            // One waiting session per source address (rule 2); the limiter below caps the waiting ones.
            maxPending = WAITING * 2,
            maxPendingPerAddress = o.maxPendingPerAddress,
            maxPendingPerGroup = PER_GROUP,
            handshakeSeconds = o.handshakeSeconds,
            schedule = ::after,
        )
        val limiter = HandshakeLimiter(PER_MINUTE, WAITING, o.mono)
        val server = bind()
        sockets += server
        val adv: MdnsHandle
        try {
            val instance = approverInstance(o.random)
            val h = productTag(src.slug, advertEpoch(src.now()))
            adv = mdns.advertise(MdnsAdvert(instance, server.localPort, listOf("v=1", "m=v", "h=$h")))
        } catch (e: Throwable) {
            closeServer(server)
            throw e
        }
        val g = Generation(server, gate, limiter, adv)
        if (ep != epoch.get()) {
            // A stop landed while this was starting: what it made is torn down, not kept.
            g.retired = true
            closeServer(server)
            gate.destroyPending()
            quiet { adv.stop() }
            return
        }
        val old = gen
        gen = g
        state = NearbyState.advertising
        reason = null
        scope.launch(Dispatchers.IO) { acceptLoop(g) }
        if (old != null) retire(old)
        cancelRenew?.invoke()
        cancelRenew = after(o.renewSeconds) { scope.launch { quiet { renew() } } }
    }

    private fun closeServer(s: ServerSocket) {
        sockets -= s
        try {
            s.close()
        } catch (e: IOException) {
            // already closed
        }
    }

    private suspend fun acceptLoop(g: Generation) {
        while (true) {
            val s = try {
                g.server.accept()
            } catch (e: IOException) {
                break
            }
            sockets += s
            scope.launch { accept(g, s) }
        }
    }

    private suspend fun renew() {
        serial {
            if (state != NearbyState.advertising) return@serial
            val ep = epoch.get()
            val signed = check { src.signedIn() }
            if (ep != epoch.get()) return@serial
            if (!signed) return@serial halt(NearbyState.stopped, NearbyStopReason.signed_out)
            val served = check { src.nearbyServed() }
            if (ep != epoch.get()) return@serial
            if (!served) return@serial halt(NearbyState.stopped, NearbyStopReason.discovery)
            try {
                advertise()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The advert cannot be renewed (the network interface went away, the port is gone): it must
                // not stand on, unrenewed and unchecked. It stops, and the host hears why.
                if (ep == epoch.get()) halt(NearbyState.stopped, NearbyStopReason.discovery)
            }
        }
    }

    /** The old listener accepts nothing more; a connection short of the transport is closed. */
    private suspend fun retire(g: Generation) {
        g.retired = true
        closeServer(g.server)
        g.gate.destroyPending(keepUp = true)
        quiet { g.adv.stop() }
    }

    /**
     * Take everything down. The state, the listener and the session closes happen before the first
     * suspension, so a caller that does not wait still has them done.
     */
    private suspend fun halt(newState: NearbyState, why: NearbyStopReason) {
        epoch.incrementAndGet()
        if (newState == NearbyState.stopped && why != NearbyStopReason.budget) final = true
        cancelRenew?.invoke()
        cancelRenew = null
        val g = gen
        gen = null
        state = newState
        reason = why
        val jobs = ArrayList<Job>()
        if (g != null) {
            g.retired = true
            closeServer(g.server)
            // A connection short of the transport is dropped; the sessions past it hear `peer_bye`.
            g.gate.destroyPending(keepUp = true)
            jobs += scope.launch(start = CoroutineStart.UNDISPATCHED) { quiet { g.adv.stop() } }
        }
        for (l in live.toList()) jobs += scope.launch(start = CoroutineStart.UNDISPATCHED) { endNow(l, PeerCloseCode.peer_bye) }
        queue = ArrayList()
        active = null
        jobs.joinAll()
        // The host's own stop and pause need no word back.
        if (why != NearbyStopReason.host) guarded { o.onStopped?.invoke(why) }
    }

    // -- sessions --------------------------------------------------------------------------------

    private fun accept(g: Generation, socket: Socket) {
        val slot = g.gate.admit(socket, g.retired || state != NearbyState.advertising || live.size >= o.maxSessions)
        if (slot == null) {
            sockets -= socket
            return
        }
        val key = o.random(KEY_BYTES)
        val st = RawNoiseStatic(key)
        key.fill(0)
        // No event can reach the session before `run()` starts below, by which time the holder is filled.
        val holder = arrayOfNulls<Live>(1)
        val l: Live
        try {
            val handlers = LinkHandlers<Unit>(
                onEstablished = { _, e -> holder[0]?.let { established(it, e) } },
                onRecord = { _, type, body -> holder[0]?.let { record(it, type, body) } },
                onClosed = { c -> holder[0]?.let { closed(it, c) } },
                onSas = { _, e -> holder[0]?.let { sas(it, e) } },
                anonymous = true,
            )
            val link = PeerLink(TcpPipe(socket), scope, handlers, o.handshakeSeconds) { send, onEvent ->
                PeerChannel(
                    NoiseRole.responder, src.slug, st, null,
                    HelloInfo(o.platform, src.slug, o.label),
                    send, onEvent,
                    ports = ports, mono = o.mono, mode = PeerMode.v, admission = g.limiter,
                )
            }
            l = Live(socket, slot, st, checkNotNull(link.channel.vouch) { "mode v has an order guard" })
            l.link = link
        } catch (e: Exception) {
            st.wipe()
            slot.settle()
            sockets -= socket
            try {
                socket.close()
            } catch (c: IOException) {
                // already closed
            }
            return
        }
        holder[0] = l
        live.add(l)
        scope.launch { l.link.run() }
    }

    private fun established(l: Live, e: SessionEvent.Established) {
        l.slot.established()
        // The one-time static key has done its work.
        l.st.wipe()
        l.hello = e.hello
    }

    private fun sas(l: Live, e: SessionEvent.Sas) {
        l.sas = e.code
        queue.add(l)
        pump()
    }

    private fun record(l: Live, type: Int, body: ByteArray) {
        when (val v = l.flow.receive(VouchMessage(type, body))) {
            is VouchVerdict.Closed -> endAsync(l, v.close)

            is VouchVerdict.Ok -> for (r in v.deliver) {
                if (r.type == RecordType.VOUCH_REQ) {
                    scope.launch { verify(l, r.body) }
                } else if (r.type in CRITICAL_FIRST..CRITICAL_LAST) {
                    endAsync(l, PeerCloseCode.peer_unknown_critical)
                }
            }
        }
    }

    private suspend fun verify(l: Live, body: ByteArray) {
        val hello = l.hello
        var ok: VouchRequest? = null
        if (hello != null && body.size <= VOUCH_REQ_MAX) {
            ok = try {
                verifyVouchRequest(
                    src.slug,
                    l.channel.handshakeHash(),
                    // `HELLO` was cleaned when the session read it; cleaning it again is not idempotent.
                    VouchHello(hello.label, hello.platform),
                    body,
                    helloCleaned = true,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
        }
        if (ok == null) {
            l.request.complete(null)
            endNow(l, PeerCloseCode.peer_bad_frame)
            return
        }
        l.flow.verified()
        l.request.complete(ok)
    }

    private fun closed(l: Live, c: SessionEvent.Closed) {
        if (l.dead) return
        l.dead = true
        l.closed = c
        l.st.wipe()
        l.slot.settle()
        for (f in l.cancels.toList()) f()
        l.cancels.clear()
        live.remove(l)
        queue.remove(l)
        l.request.complete(null)
        sockets -= l.socket
        // A prompt that was shown and ended before the person answered, by anything but this module (the
        // 120 s deadline, the peer closing or the connection dropping), counts (rule 2).
        if (l.shown && !l.picked && !l.local) failure()
        for (f in l.closers.toList()) guarded { f(c) }
        if (active === l) {
            active = null
            pump()
        }
    }

    /** Close a session with [code]; resolves when it is down. */
    private suspend fun endNow(l: Live, code: PeerCloseCode) {
        if (l.dead) return
        l.local = true
        quiet { l.channel.close(code) }
    }

    /** The same from inside a channel callback, where the channel is locked: it runs once the callback returns. */
    private fun endAsync(l: Live, code: PeerCloseCode) {
        if (l.dead) return
        l.local = true
        scope.launch { endNow(l, code) }
    }

    /** Count one prompted failure; the second in the window stops the advert. */
    private fun failure() {
        if (!budget.fail()) return
        scope.launch {
            serial {
                if (state == NearbyState.advertising) halt(NearbyState.stopped, NearbyStopReason.budget)
            }
        }
    }

    // -- the prompt, one at a time ---------------------------------------------------------------

    private fun pump() {
        if (state != NearbyState.advertising) return
        if (!prompt) {
            for (l in queue.toList()) {
                if (!l.noticed) {
                    l.noticed = true
                    guarded { o.onNotice?.invoke(ApprovalNotice(l.hello?.label, l.hello?.platform ?: "")) }
                }
            }
            return
        }
        if (active != null) return
        val next = queue.firstOrNull { !it.shown && !it.dead } ?: return
        active = next
        next.shown = true
        next.flow.codeShown()
        val codes = decoyCodes(checkNotNull(next.sas), o.random).codes.map(::sasDisplay)
        val approval = approval(next, codes)
        try {
            handler.onApproval(approval)
        } catch (e: Exception) {
            endAsync(next, PeerCloseCode.peer_bye)
        }
    }

    private fun approval(l: Live, codes: List<String>): NearbyApproval = object : NearbyApproval {
        override val label: String? = l.hello?.label
        override val platform: String = l.hello?.platform ?: ""
        override val codes: List<String> = codes

        override suspend fun pick(code: String): PickOutcome = onScope {
            l.pick ?: scope.async { doPick(l, code) }.also { l.pick = it }
        }.await()

        override suspend fun decline(): Unit = onScope { doDecline(l) }

        override suspend fun finish(answer: ApproveAnswerInput): FinishOutcome = onScope { doFinish(l, answer) }

        override suspend fun sendRecord(type: Int, body: ByteArray): Unit = onScope { doSend(l, type, body) }

        override suspend fun close(): Unit = onScope { endNow(l, PeerCloseCode.peer_bye) }

        override fun onClose(fn: (SessionEvent.Closed) -> Unit): () -> Unit {
            scope.launch { register(l, fn) }
            return { scope.launch { l.closers.remove(fn) } }
        }

        override fun toString(): String = "NearbyApproval"
    }

    private fun register(l: Live, fn: (SessionEvent.Closed) -> Unit) {
        l.closers.add(fn)
        l.closed?.let { c -> guarded { fn(c) } }
    }

    /** The prompt is over (a pick, a decline): the next waiting session may show its codes. */
    private fun release(l: Live) {
        queue.remove(l)
        if (active === l) active = null
        pump()
    }

    /** A session ended before the right pick: nothing is delivered and no route is called. */
    private suspend fun abandon(l: Live, why: AbandonReason) {
        val v = l.flow.abandon(why)
        release(l)
        if (l.dead) return
        // `abandon` always closes: peer_bye here (timeouts come from the engine).
        endNow(l, (v as? VouchVerdict.Closed)?.close ?: PeerCloseCode.peer_bye)
    }

    private suspend fun doPick(l: Live, code: String): PickOutcome {
        if (l.dead) throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        val sas = l.sas
        if (sas == null || l.picked) throw NearbyException(NearbyErrorReason.not_picked, "There is no code to pick.")
        if (codeValue(code) != sas) {
            failure()
            abandon(l, AbandonReason.WrongPick)
            return PickOutcome.Mismatch
        }
        val v = l.flow.picked()
        if (v is VouchVerdict.Closed) {
            endNow(l, v.close)
            return PickOutcome.Invalid
        }
        l.picked = true
        l.slot.settle()
        // The prompt slot stays with this session until it finishes or closes: the next waiting session
        // shows no code meanwhile. The session stays for records after `approved`, and no longer than 300 s
        // past the pick.
        l.cancels.add(after(o.keepOpenSeconds) { scope.launch { endNow(l, PeerCloseCode.peer_bye) } })
        // The person's pick is M's confirmation; the held `VOUCH_REQ` is delivered from here on.
        l.channel.confirmSas()
        if (l.dead) return PickOutcome.Invalid
        val wait = after(o.requestWaitSeconds) { scope.launch { endNow(l, PeerCloseCode.peer_timeout) } }
        try {
            val r = l.request.await()
            return if (r != null) PickOutcome.Verified(r) else PickOutcome.Invalid
        } finally {
            wait()
        }
    }

    private suspend fun doDecline(l: Live) {
        if (l.dead || l.picked) return
        failure()
        abandon(l, AbandonReason.NoneMatch)
    }

    private suspend fun doFinish(l: Live, a: ApproveAnswerInput): FinishOutcome {
        if (l.dead) throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        // No silent approval: the right pick on this session and a verified request, or nothing.
        if (!l.flow.mayFinish) throw NearbyException(NearbyErrorReason.not_picked, "The person has not picked the code on this session.")
        return when (val act = finishMap(ApproveAnswer(a.http, a.body, a.discoveryNearby, l.keysRetried))) {
            is FinishAction.Send -> sendResult(l, act.status)

            is FinishAction.Wait -> {
                if (act.what == FinishAction.Wait.KEYS) l.keysRetried = true
                FinishOutcome.Wait(act.what)
            }

            is FinishAction.Close -> {
                release(l)
                endNow(l, PeerCloseCode.peer_bye)
                if (act.stopAdvert) scope.launch { serial { halt(NearbyState.stopped, NearbyStopReason.discovery) } }
                FinishOutcome.Closed
            }
        }
    }

    private suspend fun sendResult(l: Live, status: VouchStatus): FinishOutcome {
        val rec = VouchMessage(RecordType.VOUCH_RESULT, buildVouchResult(status))
        val v = l.flow.send(rec)
        if (v is VouchVerdict.Closed) {
            endNow(l, v.close)
            throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        }
        try {
            l.channel.sendRecord(rec.type, rec.body)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        }
        // Finished: the next waiting session may show its codes.
        release(l)
        if (status != VouchStatus.approved) endNow(l, PeerCloseCode.peer_bye)
        return FinishOutcome.Sent(status)
    }

    private suspend fun doSend(l: Live, type: Int, body: ByteArray) {
        if (l.dead) throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        if (type !in SYNC_FIRST..SYNC_LAST) throw NearbyException(NearbyErrorReason.bad_type, "Sync records are 0x0030 to 0x003F.")
        val v = l.flow.send(VouchMessage(type, body))
        if (v is VouchVerdict.Closed) {
            endNow(l, v.close)
            throw NearbyException(NearbyErrorReason.not_picked, "A record needs an approved vouch.")
        }
        try {
            l.channel.sendRecord(type, body)
        } catch (e: CancellationException) {
            throw e
        } catch (e: IllegalArgumentException) {
            throw NearbyException(NearbyErrorReason.too_large, "The message is larger than D accepts.")
        } catch (e: Exception) {
            throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        }
    }

    public companion object {
        private const val KEY_BYTES = 32

        /**
         * Start advertising. The caller has checked that the device is signed in and that discovery names
         * `nearby`; both are read again at every renewal. Throws [NearbyException] `bad_input` for `prompt =
         * false` without `background`, and what the mDNS adapter throws (`MdnsUnavailableException`).
         */
        public suspend fun start(
            src: ApproverSource,
            handler: NearbyApprovalHandler,
            options: NearbyApproverOptions,
            parent: CoroutineScope? = null,
        ): NearbyApprover {
            if (!options.prompt && !options.background) {
                throw NearbyException(NearbyErrorReason.bad_input, "Without the prompt, background approval must be allowed (background = true).")
            }
            val a = NearbyApprover(src, handler, options, parent)
            try {
                a.onScope { a.advertise() }
            } catch (e: Throwable) {
                a.destroy()
                throw e
            }
            return a
        }
    }
}
