// The requester half of nearby approval (CC-15.K3; WIRE-CONTRACT-V5 section 15.6.1): a device with no
// sign-in (D) browses for approvers, dials a few, lists them by their `HELLO` and lets its person tap one.
// Only then does the code run on that session; the others close `peer_bye` before any code record, so no
// other approver ever prompts. D shows its code, sends `VOUCH_REQ` and reads `VOUCH_RESULT`. It calls no
// route: the host holds the request from `nearby/start` and polls. Mirrors sdk-node's
// `connect/nearbyRequester.ts` (with its red-team fixes).
//
// Rules this module keeps:
//  - D connects out and never listens; it browses `_pkeypeer._tcp` for `m=v` with the product tag of the
//    current or the previous epoch, judged by the mode-a address rule ([textVerdict]);
//  - at most 4 approvers are dialled at once, picked at random and never in arrival order, each with a
//    one-time X25519 key that is wiped when the handshake ends; a session that ends before the choice is
//    replaced while the request lives (a bounded number of times per advert);
//  - every session stops after `HELLO` (`holdSas`); the list has at most 8 entries, shows the reported
//    label and platform only, and is never chosen from for the person;
//  - the code on D's screen is D's confirmation, then `VOUCH_REQ` goes out;
//  - `0x0030` to `0x003F` are held, 16 records and 16 KiB, until the person confirms the signed-in account
//    (`confirmAccount`, rule 12); a decline or a close drops them all;
//  - a session held and not chosen for 20 s is closed `peer_bye` and replaced, so one approver cannot sit
//    on a dial slot;
//  - one answer per request: once `VOUCH_RESULT` said `approved`, or `confirmAccount()` ran, no other
//    approver is dialled or chosen. `confirmAccount()` is for the session that was chosen;
//  - the request and the label are checked when the request starts; `expiresIn` is at most 300 s;
//  - the host's callbacks run inside a guard: a throw cannot skip the cleanup that follows;
//  - the browse and the wait for `VOUCH_RESULT` end at `expiresIn` (300 s), then every session closes
//    `peer_bye`; the request handle, `sig`, `h` and the nonces are in no message.
//
// Threads: every piece of state lives on one single-threaded dispatcher. Callbacks to the host run on that
// thread: keep them short, and call back into the request from a coroutine of your own.

package im.plrs.key.core.peer.nearby

import im.plrs.key.core.DeviceKeyPort
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
import im.plrs.key.core.peer.TxtResult
import im.plrs.key.core.peer.VouchFlow
import im.plrs.key.core.peer.VouchHello
import im.plrs.key.core.peer.VouchMessage
import im.plrs.key.core.peer.VouchResultRead
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.VouchVerdict
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.buildVouchRequest
import im.plrs.key.core.peer.lan.JvmMdns
import im.plrs.key.core.peer.lan.LanDialOptions
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.TcpPipe
import im.plrs.key.core.peer.lan.lanDialRaceTo
import im.plrs.key.core.peer.lan.textVerdict
import im.plrs.key.core.peer.parseTxt
import im.plrs.key.core.peer.parseVouchResult
import im.plrs.key.core.peer.peerHostPlatform
import im.plrs.key.core.peer.productTag
import im.plrs.key.core.peer.sasDisplay
import im.plrs.key.core.peer.uniformBelow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** D's device keys (made when none exist) and its `X-PKey-Device` value. */
public class RequesterSigner(public val port: DeviceKeyPort, public val deviceId: String) {
    override fun toString(): String = "RequesterSigner"
}

/** What the requester reads of the client. */
public interface RequesterSource {
    /** The product slug. */
    public val slug: String

    /** Seconds since the epoch. */
    public fun now(): Long

    /** D's device keys (made when none exist) and its `X-PKey-Device` value. */
    public suspend fun signer(): RequesterSigner
}

/** Options of a nearby request. */
public class NearbyRequestOptions(
    /** The handle from `nearby/start` (`nr_` and 22 characters). */
    public val request: String,
    /**
     * This device's label in `HELLO` and `VOUCH_REQ` (display data; optional; a string of at most 256
     * characters). It is shown on the approving device: name the device, and never use an account
     * identifier (an email address, a user id) as the label.
     */
    public val label: String? = null,
    /** Cancelling this job closes the request. */
    public val signal: Job? = null,
    /** Seconds the request lives (default and most 300, from `nearby/start`'s `expiresIn`). */
    public val expiresIn: Double = EXPIRES_SECONDS,
    public val mdns: MdnsAdapter? = null,
    /** Accept and dial loopback peers. For tests and same-host use only. */
    public val allowLoopback: Boolean = false,
    /** The IPv4 addresses of the networks the default adapter uses (the `lan.interfaces` override). */
    public val interfaces: List<String>? = null,
    public val handshakeSeconds: Double = HANDSHAKE_WINDOW_SECONDS,
    public val dialSeconds: Double = DIAL_SECONDS,
    /** Schedule `fn` after `seconds`; returns the cancel. Default: a delay in the request's scope. */
    public val timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
    /** Monotonic seconds. */
    public val mono: () -> Double = { System.nanoTime() / NANOS },
    /** CSPRNG bytes (one-time keys, ids, the dial order). */
    public val random: (Int) -> ByteArray = NoisePorts.defaultRandom,
    /** The platform shown to the approver in `HELLO` and `VOUCH_REQ`. */
    public val platform: String = peerHostPlatform(),
) {
    override fun toString(): String = "NearbyRequestOptions"

    public companion object {
        internal const val EXPIRES_SECONDS: Double = 300.0
        internal const val HANDSHAKE_WINDOW_SECONDS: Double = 30.0
        internal const val DIAL_SECONDS: Double = 10.0
        internal const val NANOS: Double = 1e9
    }
}

/** One approver in the list. Unauthenticated display data: any device on the LAN can be listed. */
public class NearbyApproverInfo(public val id: String, public val label: String?, public val platform: String) {
    override fun toString(): String = "NearbyApproverInfo($id)"
}

/** A Sync record the approver sent, `0x0030` to `0x003F`. */
public class NearbyRecord(public val type: Int, public val body: ByteArray) {
    override fun toString(): String = "NearbyRecord(type=$type, ${body.size} bytes)"
}

/** The chosen approver, D's code to show. */
public class ChosenCode(public val code: String) {
    override fun toString(): String = "ChosenCode"
}

/** A nearby request D holds. */
public interface NearbyRequest {
    /** The approvers that said `HELLO`, at most 8. Empty once the person chose. */
    public val approvers: List<NearbyApproverInfo>

    /** What `VOUCH_RESULT` said. For display only: the host's poll is the authority. */
    public val result: VouchStatus?
    public val closed: Boolean

    public fun onApprovers(fn: (List<NearbyApproverInfo>) -> Unit): () -> Unit

    public fun onResult(fn: (VouchStatus) -> Unit): () -> Unit

    /** Sync records, once the person confirmed the account. */
    public fun onRecord(fn: (NearbyRecord) -> Unit): () -> Unit

    /** The chosen session ended (or the request expired, code `expired`); with why. */
    public fun onClose(fn: (String) -> Unit): () -> Unit

    /**
     * The person tapped this approver. Starts the code on that session only and closes the others `peer_bye`;
     * answers D's code to show, and sends `VOUCH_REQ` once it is shown.
     */
    public suspend fun choose(id: String): ChosenCode

    /**
     * The person confirmed that the signed-in account is theirs: held records go to [onRecord]. It counts
     * for the session that was chosen and answered `approved`; it is not a standing consent, and after it
     * (or after `approved`) no other approver can be chosen.
     */
    public suspend fun confirmAccount()

    /** The person declined, or the screen timed out: every held record is dropped and the session closes. */
    public suspend fun declineAccount()

    /** End the request: the browse stops and every session closes `peer_bye`. */
    public suspend fun close()

    /** Drop every socket now, with no goodbye (the sign-out bound's force path). Never waits. */
    public fun destroy()
}

private const val MAX_DIALS = 4
private const val MAX_LIST = 8
private const val TRIES_PER_ADVERT = 3
private const val REDIAL_SECONDS = 0.25

/** A held session nobody chose is replaced after this long. */
private const val IDLE_SECONDS = 20.0
private const val LABEL_MAX = 256
private const val MILLIS = 1000
private const val ID_BYTES = 6
private const val BYTE_MASK = 0xff
private const val KEY_BYTES = 32
private const val SYNC_FIRST = 0x0030
private const val SYNC_LAST = 0x003f

/** `nearby/start`'s handle (the same pattern the vouch codecs check in a `VOUCH_REQ`). */
private val REQUEST_RE = Regex("nr_[A-Za-z0-9_-]{22}")

private class Candidate(val instance: String, val hosts: List<String>, val port: Int, var tries: Int)

private class Entry(val id: String, val instance: String, val st: RawNoiseStatic) {
    lateinit var link: PeerLink<Unit>
    val channel: PeerChannel get() = link.channel
    var hello: PeerHello? = null
    var code: Int? = null
    var codeWait: CompletableDeferred<Int>? = null
    var closed = false
    var socket: Socket? = null

    /** Cancels the idle clock. */
    var idle: (() -> Unit)? = null
}

public class NearbyRequester private constructor(private val src: RequesterSource, private val o: NearbyRequestOptions, parent: CoroutineScope?) :
    NearbyRequest {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob(parent?.coroutineContext?.get(Job)) + dispatcher)
    private val mdns: MdnsAdapter = o.mdns ?: JvmMdns(scope, allowLoopback = o.allowLoopback, interfaces = o.interfaces)
    private val ports = NoisePorts(random = o.random)
    private val candidates = LinkedHashMap<String, Candidate>()
    private val entries = LinkedHashMap<String, Entry>()

    /** Instances with a dial or a session in flight. */
    private val active = HashSet<String>()
    private var browse: MdnsHandle? = null
    private var chosen: Entry? = null
    private var flow: VouchFlow<VouchMessage>? = null
    private var signer: RequesterSigner? = null
    private val cancels = ArrayList<() -> Unit>()
    private val sockets = ConcurrentHashMap.newKeySet<java.io.Closeable>()
    private val onApproversFns = CopyOnWriteArrayList<(List<NearbyApproverInfo>) -> Unit>()
    private val onResultFns = CopyOnWriteArrayList<(VouchStatus) -> Unit>()
    private val onRecordFns = CopyOnWriteArrayList<(NearbyRecord) -> Unit>()
    private val onCloseFns = CopyOnWriteArrayList<(String) -> Unit>()

    @Volatile private var list: List<NearbyApproverInfo> = emptyList()

    @Volatile private var status: VouchStatus? = null

    @Volatile private var ended = false

    /** `approved` came, or the account was confirmed: this request has its answer. */
    private var answered = false

    override fun toString(): String = "NearbyRequest"

    override val approvers: List<NearbyApproverInfo> get() = list

    override val result: VouchStatus? get() = status

    override val closed: Boolean get() = ended

    override fun onApprovers(fn: (List<NearbyApproverInfo>) -> Unit): () -> Unit {
        onApproversFns += fn
        return { onApproversFns -= fn }
    }

    override fun onResult(fn: (VouchStatus) -> Unit): () -> Unit {
        onResultFns += fn
        return { onResultFns -= fn }
    }

    override fun onRecord(fn: (NearbyRecord) -> Unit): () -> Unit {
        onRecordFns += fn
        return { onRecordFns -= fn }
    }

    override fun onClose(fn: (String) -> Unit): () -> Unit {
        onCloseFns += fn
        return { onCloseFns -= fn }
    }

    // -- the scope -------------------------------------------------------------------------------

    private suspend fun <T> onScope(block: suspend () -> T): T = withContext(dispatcher) { block() }

    private fun after(seconds: Double, fn: () -> Unit): () -> Unit {
        val custom = o.timer
        if (custom != null) return custom(seconds) { scope.launch { fn() } }
        val job = scope.launch {
            delay((seconds * MILLIS).toLong())
            fn()
        }
        return { job.cancel() }
    }

    private fun <T> each(fns: List<(T) -> Unit>, v: T) {
        for (f in fns.toList()) {
            try {
                f(v)
            } catch (e: Exception) {
                // The host's bug is the host's; the module's own state is already settled.
            }
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

    // -- browse and dial -------------------------------------------------------------------------

    private fun found(f: MdnsFound) {
        if (ended || answered || chosen != null) return
        val txt = parseTxt(f.txt) as? TxtResult.Ok ?: return
        if (txt.mode != PeerMode.v) return
        // The product tag of this epoch or the last: an advert of another product is not ours.
        val epoch = advertEpoch(src.now())
        val tags = listOf(epoch, epoch - 1).map { productTag(src.slug, it) }
        if (txt.h == null || txt.h !in tags) return
        val hosts = f.hosts.filter { textVerdict(it, o.allowLoopback) }
        if (hosts.isEmpty()) return
        val had = candidates[f.instance]
        candidates[f.instance] = Candidate(f.instance, hosts, f.port, had?.tries ?: 0)
        pump()
    }

    private fun gone(instance: String) {
        candidates.remove(instance)
    }

    /** Dial candidates at random until 4 are in flight. */
    private fun pump() {
        while (!ended && !answered && chosen == null && active.size < MAX_DIALS) {
            val free = candidates.values.filter { it.instance !in active && it.tries < TRIES_PER_ADVERT }
            if (free.isEmpty()) return
            val c = free[uniformBelow(free.size, o.random)]
            c.tries++
            active += c.instance
            scope.launch { dial(c) }
        }
    }

    private suspend fun dial(c: Candidate) {
        val sock: Socket = try {
            lanDialRaceTo(c.hosts, c.port, LanDialOptions(o.allowLoopback, (o.dialSeconds * MILLIS).toInt())).first
        } catch (e: IOException) {
            active -= c.instance
            later()
            return
        }
        if (ended || answered || chosen != null) {
            quiet { sock.close() }
            active -= c.instance
            return
        }
        val key = o.random(KEY_BYTES)
        val st = RawNoiseStatic(key)
        key.fill(0)
        val id = "ap_" + o.random(ID_BYTES).joinToString("") { "%02x".format(it.toInt() and BYTE_MASK) }
        val e = Entry(id, c.instance, st)
        e.socket = sock
        sockets += sock
        val handlers = LinkHandlers<Unit>(
            onEstablished = { _, ev -> established(e, ev) },
            onRecord = { _, type, body -> if (e === chosen) record(type, body) },
            onClosed = { cl -> sessionEnded(e, cl) },
            onSas = { _, ev -> sas(e, ev) },
            anonymous = true,
        )
        e.link = PeerLink(TcpPipe(sock), scope, handlers, o.handshakeSeconds) { send, onEvent ->
            PeerChannel(
                NoiseRole.initiator, src.slug, st, null,
                HelloInfo(o.platform, src.slug, o.label), send, onEvent,
                ports = ports, mono = o.mono, mode = PeerMode.v, holdSas = true,
            )
        }
        entries[id] = e
        scope.launch { e.link.run() }
        quiet { e.link.start() }
    }

    /** A short pause before a replacement dial, so a refusing approver is not hammered. */
    private fun later() {
        cancels += after(REDIAL_SECONDS) { pump() }
    }

    private fun refresh(notify: Boolean) {
        list = if (chosen != null) {
            emptyList()
        } else {
            entries.values.filter { it.hello != null && !it.closed }.take(MAX_LIST).map {
                NearbyApproverInfo(it.id, it.hello?.label, it.hello?.platform ?: "")
            }
        }
        if (notify) each(onApproversFns, list)
    }

    // -- a session's events ----------------------------------------------------------------------

    private fun established(e: Entry, ev: SessionEvent.Established) {
        // The one-time static key has done its work.
        e.st.wipe()
        e.hello = ev.hello
        // Held and not chosen for 20 s: replaced, so one approver cannot sit on a dial slot.
        e.idle = after(IDLE_SECONDS) { replace(e) }
        refresh(true)
    }

    private fun sas(e: Entry, ev: SessionEvent.Sas) {
        e.code = ev.code
        e.codeWait?.complete(ev.code)
        e.codeWait = null
    }

    private fun replace(e: Entry) {
        e.idle = null
        if (e === chosen || e.closed || ended) return
        // The advert gets its try back: this is not a failure of the approver.
        candidates[e.instance]?.let { if (it.tries > 0) it.tries-- }
        scope.launch { quiet { e.channel.close(PeerCloseCode.peer_bye) } }
    }

    private fun record(type: Int, body: ByteArray) {
        val fl = flow ?: return
        when (val v = fl.receive(VouchMessage(type, body))) {
            is VouchVerdict.Closed -> chosen?.let { c -> scope.launch { quiet { c.channel.close(v.close) } } }
            is VouchVerdict.Ok -> for (r in v.deliver) deliver(r)
        }
    }

    private fun deliver(r: VouchMessage) {
        if (r.type == RecordType.VOUCH_RESULT) {
            // Display only: an unknown status reads as `denied` (rule 6).
            val got = parseVouchResult(r.body) as? VouchResultRead.Status ?: return
            status = got.status
            if (got.status == VouchStatus.approved) answered = true
            each(onResultFns, got.status)
        } else if (r.type in SYNC_FIRST..SYNC_LAST) {
            each(onRecordFns, NearbyRecord(r.type, r.body))
        }
    }

    private fun sessionEnded(e: Entry, c: SessionEvent.Closed) {
        if (e.closed) return
        e.closed = true
        e.idle?.invoke()
        e.idle = null
        e.st.wipe()
        e.socket?.let { sockets -= it }
        entries.remove(e.id)
        active -= e.instance
        e.codeWait?.completeExceptionally(NearbyException(NearbyErrorReason.closed, "The session is closed."))
        e.codeWait = null
        if (e === chosen) {
            // The chosen session is over. Without an answer the request goes on: the person may choose
            // again from a fresh list.
            chosen = null
            flow = null
            refresh(false)
            if (!ended) {
                each(onCloseFns, c.code)
                if (status == null && !answered) later()
            }
        } else {
            refresh(true)
            if (!ended && !answered) later()
        }
    }

    // -- the person's choices --------------------------------------------------------------------

    override suspend fun choose(id: String): ChosenCode = onScope {
        if (ended) throw NearbyException(NearbyErrorReason.closed, "The request is closed.")
        if (answered) throw NearbyException(NearbyErrorReason.closed, "The request has its answer.")
        if (chosen != null) throw NearbyException(NearbyErrorReason.not_started, "An approver is already chosen.")
        val e = entries[id]
        if (e == null || e.hello == null || e.closed) throw NearbyException(NearbyErrorReason.unknown_peer, "That approver is no longer on the list.")
        val sg = signer ?: throw NearbyException(NearbyErrorReason.not_started, "Not started.")
        chosen = e
        e.idle?.invoke()
        e.idle = null
        val fl = e.channel.vouch ?: throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        flow = fl
        // The others close before any code record is sent on them: no other approver ever prompts.
        for (other in entries.values.toList()) {
            if (other !== e) scope.launch { quiet { other.channel.close(PeerCloseCode.peer_bye) } }
        }
        refresh(true)
        val wait = CompletableDeferred<Int>()
        val have = e.code
        if (have != null) wait.complete(have) else e.codeWait = wait
        e.channel.startSas()
        val code = wait.await()
        // Showing the code is D's confirmation; then the request goes to the chosen approver.
        fl.codeShown()
        e.channel.confirmSas()
        val body = buildVouchRequest(sg.port, src.slug, e.channel.handshakeHash(), o.request, sg.deviceId, VouchHello(o.label, o.platform))
        val v = fl.send(VouchMessage(RecordType.VOUCH_REQ, body))
        if (v is VouchVerdict.Closed) {
            e.channel.close(v.close)
            throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        }
        try {
            e.channel.sendRecord(RecordType.VOUCH_REQ, body)
        } catch (c: CancellationException) {
            throw c
        } catch (c: Exception) {
            throw NearbyException(NearbyErrorReason.closed, "The session is closed.")
        }
        ChosenCode(sasDisplay(code))
    }

    override suspend fun confirmAccount(): Unit = onScope {
        val fl = flow ?: throw NearbyException(NearbyErrorReason.not_started, "Nobody is chosen.")
        answered = true
        when (val v = fl.confirmAccount()) {
            is VouchVerdict.Closed -> quiet { chosen?.channel?.close(v.close) }
            is VouchVerdict.Ok -> for (r in v.deliver) deliver(r)
        }
    }

    override suspend fun declineAccount(): Unit = onScope {
        val fl = flow ?: return@onScope
        val v = fl.declineAccount()
        quiet { chosen?.channel?.close(if (v is VouchVerdict.Closed) v.close else PeerCloseCode.peer_bye) }
    }

    // -- the end ---------------------------------------------------------------------------------

    private suspend fun stopNow(why: String?) {
        if (ended) return
        val hadChosen = chosen != null
        ended = true
        for (c in cancels.toList()) c()
        cancels.clear()
        if (why != null || hadChosen) each(onCloseFns, why ?: PeerCloseCode.peer_bye.name)
        val b = browse
        browse = null
        // The sessions close before the browse is awaited: a browse that hangs cannot hold them up.
        val jobs = ArrayList<Job>()
        for (e in entries.values.toList()) {
            jobs +=
                scope.launch(start = CoroutineStart.UNDISPATCHED) { quiet { e.channel.close(PeerCloseCode.peer_bye) } }
        }
        if (b != null) jobs += scope.launch(start = CoroutineStart.UNDISPATCHED) { quiet { b.stop() } }
        jobs.joinAll()
    }

    override suspend fun close() {
        onScope { stopNow(null) }
    }

    override fun destroy() {
        ended = true
        for (c in sockets) {
            try {
                c.close()
            } catch (e: IOException) {
                // already closed
            }
        }
        scope.cancel()
    }

    public companion object {
        /** The request and the label are the host's input: refuse a bad one now, not at the tap. */
        private fun checked(o: NearbyRequestOptions): Double {
            if (!REQUEST_RE.matches(o.request)) throw NearbyException(NearbyErrorReason.bad_input, "The request handle is not valid.")
            if (o.label != null && o.label.length > LABEL_MAX) throw NearbyException(NearbyErrorReason.bad_input, "The label is not valid.")
            val n = o.expiresIn
            if (n.isNaN() || n.isInfinite() || n <= 0) throw NearbyException(NearbyErrorReason.bad_input, "expiresIn must be above 0.")
            return minOf(n, NearbyRequestOptions.EXPIRES_SECONDS)
        }

        /**
         * Start browsing and dialling. The caller holds the request from `nearby/start`. Throws
         * [NearbyException] `bad_input` for a bad handle, label or `expiresIn`, and what the mDNS adapter throws
         * (`MdnsUnavailableException`).
         */
        public suspend fun start(src: RequesterSource, options: NearbyRequestOptions, parent: CoroutineScope? = null): NearbyRequester {
            val expires = checked(options)
            val r = NearbyRequester(src, options, parent)
            try {
                r.onScope { r.begin(expires) }
            } catch (e: Throwable) {
                r.destroy()
                throw e
            }
            return r
        }
    }

    private suspend fun begin(expires: Double) {
        signer = src.signer()
        cancels += after(expires) { scope.launch { stopNow("expired") } }
        val signal = o.signal
        if (signal != null) {
            if (!signal.isActive) {
                stopNow(null)
                return
            }
            val reg = signal.invokeOnCompletion { scope.launch { stopNow(null) } }
            cancels += { reg.dispose() }
        }
        try {
            browse = mdns.browse({ f -> scope.launch { found(f) } }, { instance -> scope.launch { gone(instance) } }, { true })
        } catch (e: Throwable) {
            stopNow(null)
            throw e
        }
    }
}
