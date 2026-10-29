// WIRE-CONTRACT-V5 sections 15.5 and 15.6: one `pkey-peer/1` session per mode: `a` (account), `v`
// (approver) and `p` (pair) (CC-12.8, CC-12.9). Mirrors client-core's `peer/session.ts` and the
// Python engine.
//
// The engine owns no socket and starts no timer: Noise messages come in through [PeerChannel.receive]
// (already de-framed) and go out through the `send` callback; the host's loop calls
// [PeerChannel.tick] when [PeerChannel.wakeIn] says a deadline is due. Clocks are injected. Calls are
// serialised by one mutex, so an event callback must not call back into the session from its own
// thread (launch a coroutine instead).
//
// Order: Noise XXpsk0 with the payload rules of section 15.5; each side verifies the other's
// certificate against the remote static key and the held roster; then HELLO each way, which must be
// the first record. Nothing is delivered to the host before that. Every failure ends the session;
// before the transport exists nothing is sent, after it a CLOSE record names the code.
//
// Modes v and p: after HELLO the initiator (the device) commits to a nonce, the responder (the
// approver) answers with its own, the initiator reveals, and both show the same six-digit code. The
// host calls [PeerChannel.confirmSas] when the person agrees; until then host records from the peer
// are held (at most 16), and HELLO display data is unauthenticated. A responder in these modes needs a
// [HandshakeLimiter].
//
// Keys: the static private key is reached only through a [NoiseStatic] whose `dh` runs the static
// operations (G1). Nothing here prints a key, certificate or record body (G19).

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.Peer
import im.plrs.key.core.PeerAdmission
import im.plrs.key.core.RingReplacement
import im.plrs.key.core.RingResult
import im.plrs.key.core.StrictJson
import im.plrs.key.core.StrictParse
import im.plrs.key.core.TrustSet
import im.plrs.key.core.longValue
import im.plrs.key.core.normalizeDeviceLabel
import im.plrs.key.core.stringValue
import im.plrs.key.core.wireInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.Normalizer
import im.plrs.key.core.PeerSession as CertSession

/** Seconds from the first byte to the transport. */
public const val TRANSPORT_DEADLINE_SECONDS: Int = 30

/** Seconds from the first byte to the person's confirmation (modes v and p). */
public const val SAS_DEADLINE_SECONDS: Int = 120

/** The code a session closes with when its handshake fails; nothing is sent. */
public const val HANDSHAKE_FAILED: String = "handshake_failed"

private const val MAX_QUEUED = 16

/** Bytes of bodies held before this side's person confirms the code (modes v and p, section 15.6). */
private const val MAX_QUEUED_BYTES = 16 * 1024

/** The largest HELLO from a peer that is not yet verified (modes v and p, section 15.6). */
private const val MAX_UNVERIFIED_HELLO = 4096

/** What a HELLO field that fails cleaning is shown as. */
private const val UNKNOWN_DISPLAY = "Unknown"

/** Section 15.6: `platform` is shown as sent only when it is up to 32 of these characters. */
private val PLATFORM_DISPLAY = Regex("[A-Za-z0-9 ._+-]{1,32}")

/** NFC, then the device-label cleaning (section 12.7.1): null when nothing is left. */
private fun cleanDisplay(raw: String): String? = normalizeDeviceLabel(Normalizer.normalize(raw, Normalizer.Form.NFC))
private const val SAS_NONCE_BYTES = 32
private const val RATE_WINDOW_SECONDS = 60.0
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val DEFAULT_REKEY_MESSAGES = 1 shl 20
private const val DEFAULT_REKEY_SECONDS = 3600.0

/** The roster the session reads at use. */
public class HeldRing(public val jws: String, public val epoch: Long) {
    override fun toString(): String = "HeldRing(epoch=$epoch)"
}

/** What mode a needs: this device's certificate, roster view and trust. */
public class AccountContext(
    public val trust: TrustSet,
    /** `aud`: the product slug. */
    public val expectedAud: String,
    /** This device's `pkey-peer+jws`. */
    public val certJws: String,
    public val ownSub: String,
    public val ownDeviceId: String,
    /** The held roster and its epoch, read at use. */
    public val heldRing: () -> HeldRing?,
    /** The delivered discovery keys, newest first; the initiator uses the first, the responder tries the first two. */
    public val discKeys: List<ByteArray?>,
) {
    override fun toString(): String = "AccountContext"
}

/** The peer's HELLO: display data (authenticated in mode a, by the certificate that opened the session). */
public data class PeerHello(val platform: String, val app: String, val maxMessage: Long, val label: String? = null)

/** What this side says about itself in its HELLO. */
public data class HelloInfo(val platform: String, val app: String, val label: String? = null, val maxMessage: Long = MAX_PEER_MESSAGE_BYTES.toLong())

/** Everything a session tells its host. */
public sealed class SessionEvent {
    /** The handshake and the HELLO exchange are done (modes v and p still need the SAS). */
    public class Established(
        public val caps: List<String>,
        public val hello: PeerHello,
        public val helloAuthenticated: Boolean,
        public val remoteStatic: ByteArray,
        public val peerDeviceId: String?,
    ) : SessionEvent() {
        override fun toString(): String = "Established(caps=${caps.size})"
    }

    /** A record the host owns. The host must close on an APP_CRITICAL type (0x8100 to 0xFFFD) it does not understand. */
    public class Record(public val recordType: Int, public val body: ByteArray) : SessionEvent() {
        override fun toString(): String = "Record(type=$recordType, ${body.size} bytes)"
    }

    /** A roster that replaced the held one at [epoch]; the host stores it. */
    public class RingReceived(public val jws: String, public val epoch: Long) : SessionEvent() {
        override fun toString(): String = "RingReceived(epoch=$epoch)"
    }

    /** A `TRUST` document the peer sent. Not verified here; the host verifies it (V4 section 1). */
    public class TrustUnverified(public val jws: String) : SessionEvent() {
        override fun toString(): String = "TrustUnverified"
    }

    /** The peer is on a newer roster than the held one, or none is held: fetch it. */
    public object RingWanted : SessionEvent()

    /** Modes v and p: the code both screens show; the host calls [PeerChannel.confirmSas] when the person agrees. */
    public class Sas(public val code: Int, public val display: String) : SessionEvent() {
        override fun toString(): String = "Sas"
    }

    /** The session ended. [code] is a [PeerCloseCode] name or [HANDSHAKE_FAILED]. */
    public data class Closed(val code: String, val byPeer: Boolean) : SessionEvent()
}

private class Fail(val code: String) : Exception(code)

/**
 * The approver's admission: at most [maxPerMinute] handshakes a minute (default 5) and at most
 * [maxPending] sessions waiting on a code (default 4), on a monotonic clock. An attempt counts only
 * when [begin] is called, which a session does when its first byte arrives.
 */
public class HandshakeLimiter(
    private val maxPerMinute: Int = 5,
    private val maxPending: Int = 4,
    private val mono: () -> Double = { System.nanoTime() / 1e9 },
) {
    private val lock = Any()
    private val stamps = ArrayList<Double>()
    private var pending = 0

    /** A release function when one more session may start now; null when refused. */
    public fun begin(): (() -> Unit)? {
        synchronized(lock) {
            val t = mono()
            stamps.removeAll { t - it >= RATE_WINDOW_SECONDS }
            if (stamps.size >= maxPerMinute || pending >= maxPending) return null
            stamps += t
            pending++
        }
        var done = false
        return {
            synchronized(lock) {
                if (!done) {
                    done = true
                    pending--
                }
            }
        }
    }

    override fun toString(): String = "HandshakeLimiter"
}

private class Pending(val remote: ByteArray, val peerDeviceId: String?)

/**
 * One session. [mode] is `a` ([account] required), or `v` / `p` (a one-time [staticKey]; a responder
 * also needs [admission]). [staticKey] is the device's agreement key (a [NoiseStatic]); [send] takes
 * one Noise message (the host frames it); [onEvent] runs inside whichever call produced the event.
 */
public class PeerChannel(
    private val role: NoiseRole,
    private val slug: String,
    private val staticKey: NoiseStatic,
    private val account: AccountContext?,
    private val hello: HelloInfo,
    private val send: (ByteArray) -> Unit,
    private val onEvent: (SessionEvent) -> Unit,
    caps: List<String> = emptyList(),
    private val ports: NoisePorts = NoisePorts(),
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    private val mono: () -> Double = { System.nanoTime() / 1e9 },
    private val rekeyMessages: Int = DEFAULT_REKEY_MESSAGES,
    private val rekeySeconds: Double = DEFAULT_REKEY_SECONDS,
    private val mode: PeerMode = PeerMode.a,
    private val admission: HandshakeLimiter? = null,
) {
    private val lock = Mutex()
    private val asm = RecordAssembler(RecordMode.valueOf(mode.name))
    private var caps: List<String> = caps.toList()
    private var hs: NoiseHandshake? = null
    private var hsStep = 0
    private var phase = "hs" // hs | hello | sas | sas-shown | open | closed
    private var sasDue: Double? = null
    private var nD: ByteArray? = null
    private var nM: ByteArray? = null
    private var commit: String? = null
    private var sasDone = false
    private var sasStep = 0
    private val queued = ArrayList<Pair<Int, ByteArray>>()
    private var release: (() -> Unit)? = null
    private var tp: NoiseTransport? = null
    private var peerCaps: List<String> = emptyList()
    private var peerRing = 0L
    private var sent = 0
    private var keyedAt = mono()
    private var maxSend = MAX_PEER_MESSAGE_BYTES.toLong()
    private var started = false
    private var transportDue: Double? = null
    private var certExpires: Long? = null
    private var peerCertJws = ""
    private var peerRemote: ByteArray? = null
    private var pending: Pending? = null

    init {
        require((mode == PeerMode.a) == (account != null)) { "account context" }
        require(mode == PeerMode.a || role != NoiseRole.responder || admission != null) { "an approver needs an admission limiter" }
    }

    override fun toString(): String = "PeerChannel(mode=${mode.name}, role=$role, phase=$phase)"

    /** True once HELLO has been exchanged and until the session closes. */
    public val isOpen: Boolean get() = phase == "open"

    /** True once the session has ended. */
    public val closed: Boolean get() = phase == "closed"

    /** The transport, for tests that speak the wire by hand. */
    internal val transportForTest: NoiseTransport? get() = tp

    /**
     * Seconds until the next deadline (the transport's, the peer certificate's expiry), 0 when one
     * is due, null when there is none. The host calls [tick] then.
     */
    public suspend fun wakeIn(): Double? = lock.withLock {
        if (phase == "closed") return@withLock null
        val waits = ArrayList<Double>()
        transportDue?.let { waits += it - mono() }
        sasDue?.let { waits += it - mono() }
        certExpires?.let { waits += (it - now()).toDouble() }
        waits.minOrNull()?.coerceAtLeast(0.0)
    }

    /**
     * Enforce the deadlines: `peer_timeout` when the transport took over 30 s (or, in modes v and p,
     * the person took over 120 s), `peer_expired` when the peer's certificate ran out.
     */
    public suspend fun tick(): Unit = lock.withLock {
        if (phase == "closed") return@withLock
        val expires = certExpires
        if (deadlinePassed(transportDue) || deadlinePassed(sasDue)) {
            fail(PeerCloseCode.peer_timeout.name, false)
        } else if (expires != null && now() >= expires) {
            fail(PeerCloseCode.peer_expired.name, false)
        }
    }

    private fun deadlinePassed(due: Double?): Boolean = due != null && mono() >= due

    /** Initiator only: write message 1. */
    public suspend fun start(): Unit = guarded {
        if (role != NoiseRole.initiator || hs != null || phase != "hs") throw Fail(HANDSHAKE_FAILED)
        val key = account?.let { it.discKeys.firstOrNull() ?: throw Fail(HANDSHAKE_FAILED) }
        startClock()
        val h = newHandshake(key)
        hs = h
        send(h.writeMessage(payload1()))
        hsStep = 1
    }

    /** One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). */
    public suspend fun receive(noise: ByteArray): Unit = guarded {
        if (phase == "closed") return@guarded
        if (!started && role == NoiseRole.responder) {
            // An approver counts the attempt only now that a session starts.
            if (admission != null) {
                release = admission.begin() ?: throw Fail(PeerCloseCode.peer_busy.name)
            }
            startClock()
        }
        if (phase == "hs") onHandshake(noise) else onTransport(noise)
    }

    /** Send one message of the host's, split into records. Only once the session is open. */
    public suspend fun sendRecord(type: Int, body: ByteArray): Unit = lock.withLock {
        check(phase == "open") { "session not open" }
        require(type !in OWNED && !(type == RecordType.CONFIRM && mode == PeerMode.p)) { "record owned by the session" }
        require(body.size <= maxSend) { "message too large" }
        emit(type, body)
    }

    /**
     * Modes v and p: the person confirmed the code. Opens the session, sends `CONFIRM` in mode p and
     * delivers the host records held meanwhile.
     */
    public suspend fun confirmSas(): Unit = guarded {
        if (phase != "sas-shown") throw Fail(PeerCloseCode.peer_not_allowed.name)
        phase = "open"
        settle()
        if (mode == PeerMode.p) emit(RecordType.CONFIRM, "{}".toByteArray(Charsets.UTF_8))
        val q = ArrayList(queued)
        queued.clear()
        for ((t, b) in q) onEvent(SessionEvent.Record(t, b))
    }

    /** Close with a code; sends CLOSE when the transport exists. */
    public suspend fun close(code: PeerCloseCode = PeerCloseCode.peer_bye): Unit = guarded { fail(code.name, false) }

    // -- internals -------------------------------------------------------------------------------

    private suspend fun guarded(fn: suspend () -> Unit) = lock.withLock {
        try {
            fn()
        } catch (e: Fail) {
            fail(e.code, false)
        } catch (e: NoiseException) {
            fail(if (tp == null) HANDSHAKE_FAILED else PeerCloseCode.peer_bad_frame.name, false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(HANDSHAKE_FAILED, false)
        }
    }

    private suspend fun fail(code: String, byPeer: Boolean) {
        if (phase == "closed") return
        val wasUp = tp != null
        phase = "closed"
        transportDue = null
        certExpires = null
        settle()
        queued.clear()
        if (wasUp && !byPeer && code != HANDSHAKE_FAILED) {
            try {
                emit(RecordType.CLOSE, JsonObject(mapOf("code" to JsonPrimitive(code))).toString().toByteArray(Charsets.UTF_8))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // the connection is gone anyway
            }
        }
        wipe()
        try {
            onEvent(SessionEvent.Closed(code, byPeer))
        } catch (e: Exception) {
            // a host bug must not wedge the close
        }
    }

    /** The person confirmed, or the session ended: the code deadline and the limiter slot end. */
    private fun settle() {
        sasDue = null
        release?.invoke()
        release = null
    }

    private fun wipe() {
        tp?.wipe()
    }

    private fun startClock() {
        if (started) return
        started = true
        transportDue = mono() + TRANSPORT_DEADLINE_SECONDS
        if (mode != PeerMode.a) sasDue = mono() + SAS_DEADLINE_SECONDS
    }

    private suspend fun newHandshake(discKey: ByteArray?): NoiseHandshake = NoiseHandshake(
        NoiseHandshakeOptions(
            role = role,
            protocol = peerNoiseProtocol(mode),
            prologue = peerPrologue(slug, mode),
            psk = if (mode == PeerMode.a && discKey != null) peerPsk(discKey, slug) else null,
            staticKey = staticKey,
            ports = ports,
        ),
    )

    private fun ownPayload(): ByteArray {
        val a = account ?: return payload23(mode, caps)
        val held = a.heldRing()
        return payload23(mode, caps, AccountPayload(a.certJws, held?.epoch ?: 1))
    }

    private fun admit(certJws: String, ringJws: String?, remote: ByteArray): PeerAdmission {
        val a = account!!
        return Peer.admitPeer(
            certJws,
            ringJws,
            a.trust,
            a.expectedAud,
            now(),
            CertSession("a", Base64Url.encode(remote), a.ownSub, a.ownDeviceId),
        )
    }

    private suspend fun onHandshake(noise: ByteArray) {
        if (role == NoiseRole.responder && hs == null) {
            onFirstMessage(noise)
            return
        }
        val h = hs ?: throw Fail(HANDSHAKE_FAILED)
        val message = if (role == NoiseRole.initiator) 2 else 3
        if (hsStep != (if (role == NoiseRole.initiator) 1 else 2)) throw Fail(HANDSHAKE_FAILED)
        val verdict = parseHandshakePayload(mode, message, h.readMessage(noise)) as? PayloadVerdict.Accepted ?: throw Fail(HANDSHAKE_FAILED)
        val remote = h.remoteStatic ?: throw Fail(HANDSHAKE_FAILED)
        var peerDeviceId: String? = null
        if (mode == PeerMode.a) {
            val cert = verdict.cert
            val ring = verdict.ring
            if (cert == null || ring == null) throw Fail(HANDSHAKE_FAILED)
            peerDeviceId = admitAccount(cert, ring, remote)
        }
        peerCaps = verdict.caps
        if (role == NoiseRole.initiator) send(h.writeMessage(ownPayload()))
        tp = h.transport()
        transportDue = null
        keyedAt = mono()
        phase = "hello"
        pending = Pending(remote, peerDeviceId)
        sendHello()
    }

    private suspend fun admitAccount(cert: String, ring: Long, remote: ByteArray): String {
        val a = account!!
        val held = a.heldRing()
        if (held != null) {
            // A held roster that is expired, unverifiable or another account's must not admit: ask for
            // a fresh one and refuse. Only a device with no roster at all (first run) admits.
            val v = Peer.verifyRing(held.jws, a.trust, a.expectedAud) as? RingResult.Ok
            if (v == null || Peer.ringExpired(v.ring, now()) || v.ring.sub != a.ownSub) {
                onEvent(SessionEvent.RingWanted)
                throw Fail(HANDSHAKE_FAILED)
            }
        } else {
            onEvent(SessionEvent.RingWanted)
        }
        val adm = admit(cert, held?.jws, remote)
        if (adm !is PeerAdmission.Admit) {
            throw Fail(
                if ((adm as PeerAdmission.Refuse).reason ==
                    PeerAdmission.Refuse.PEER_REVOKED
                ) {
                    PeerCloseCode.peer_revoked.name
                } else {
                    HANDSHAKE_FAILED
                },
            )
        }
        peerCertJws = cert
        peerRemote = remote
        if (adm.cert.expiresAt - now() <= 0) throw Fail(PeerCloseCode.peer_expired.name)
        certExpires = adm.cert.expiresAt
        peerRing = ring
        if (adm.ringSync == im.plrs.key.core.RingSync.request) onEvent(SessionEvent.RingWanted)
        return adm.cert.deviceId
    }

    /** Message 1: try the current then the previous discovery key; a failed tag closes silently. */
    private suspend fun onFirstMessage(noise: ByteArray) {
        var payload: ByteArray? = null
        val acct = account
        for (k in if (acct != null) acct.discKeys.take(2) else listOf<ByteArray?>(null)) {
            if (acct != null && k == null) continue
            try {
                val h = newHandshake(k)
                payload = h.readMessage(noise)
                hs = h
                break
            } catch (e: NoiseException) {
                continue
            }
        }
        val h = hs
        if (h == null || payload == null) throw Fail(HANDSHAKE_FAILED)
        if (parseHandshakePayload(mode, 1, payload) !is PayloadVerdict.Accepted) throw Fail(HANDSHAKE_FAILED)
        send(h.writeMessage(ownPayload()))
        hsStep = 2
    }

    private suspend fun sendHello() {
        val members = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        hello.label?.let { members["label"] = JsonPrimitive(it) }
        members["platform"] = JsonPrimitive(hello.platform)
        members["app"] = JsonPrimitive(hello.app)
        members["maxMessage"] = JsonPrimitive(hello.maxMessage)
        emit(RecordType.HELLO, JsonObject(members).toString().toByteArray(Charsets.UTF_8))
    }

    private suspend fun onTransport(noise: ByteArray) {
        val t = tp ?: throw Fail(HANDSHAKE_FAILED)
        val rec = parseRecord(t.receive.decrypt(ByteArray(0), noise)) ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
        when (val r = asm.push(rec)) {
            is AssembleResult.Close -> throw Fail(r.code.name)
            is AssembleResult.Message -> onMessage(r.type, r.body)
            else -> Unit
        }
    }

    private fun parseHello(body: ByteArray): PeerHello? {
        // Modes v and p take a HELLO from a peer that is not yet verified: 4 KiB at most (section 15.6).
        val tooBig = mode != PeerMode.a && body.size > MAX_UNVERIFIED_HELLO
        return if (tooBig) null else StrictJson.validate(body)?.let(::helloOf)
    }

    private fun helloOf(parsed: StrictParse): PeerHello? {
        val o = parsed.value
        val platform = o["platform"].stringValue
        val app = o["app"].stringValue
        val rawLabel = o["label"]
        val labelOk = "label" !in o || rawLabel.stringValue != null
        val mm = o["maxMessage"].longValue
        val mmOk = wireInteger(mm, "/maxMessage", 1, parsed.nonWireIntegers) && mm!! <= MAX_SAFE_INTEGER
        val shapeOk = labelOk && mmOk
        // Display data from an unauthenticated peer: NFC, controls and bidi stripped, 64 code points; a
        // platform only in its plain spelling. What fails cleaning shows as "Unknown".
        return if (platform == null || app == null || !shapeOk) {
            null
        } else {
            PeerHello(
                platform = if (PLATFORM_DISPLAY.matches(platform)) platform else UNKNOWN_DISPLAY,
                app = cleanDisplay(app) ?: UNKNOWN_DISPLAY,
                maxMessage = mm!!,
                label = rawLabel.stringValue?.let(::cleanDisplay),
            )
        }
    }

    private suspend fun onMessage(type: Int, body: ByteArray) {
        if (phase == "hello") {
            // The first record each way is HELLO; anything else is refused and closed.
            if (type != RecordType.HELLO) throw Fail(PeerCloseCode.peer_bad_frame.name)
            val h = parseHello(body)
            val p = pending
            if (h == null || p == null) throw Fail(PeerCloseCode.peer_bad_frame.name)
            maxSend = minOf(MAX_PEER_MESSAGE_BYTES.toLong(), h.maxMessage)
            caps = capsIntersection(caps, peerCaps)
            pending = null
            val acctMode = mode == PeerMode.a
            phase = if (acctMode) "open" else "sas"
            onEvent(SessionEvent.Established(caps.toList(), h, acctMode, p.remote, p.peerDeviceId))
            if (acctMode) {
                pushRing()
            } else if (role == NoiseRole.initiator) {
                // The device commits first.
                val n = ports.random(SAS_NONCE_BYTES)
                nD = n
                emit(RecordType.SAS_COMMIT, sasBody(SasMember.c, sasCommit(n)))
                sasStep = 1
            }
            return
        }
        when (type) {
            RecordType.HELLO -> throw Fail(PeerCloseCode.peer_bad_frame.name)

            RecordType.PING -> emit(RecordType.PONG, body)

            RecordType.PONG -> Unit

            RecordType.REKEY -> tp!!.receive.rekey()

            RecordType.CLOSE -> onPeerClose(body)

            RecordType.TRUST -> {
                val jws = parseStrictObject(body)?.get("trust").stringValue ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
                onEvent(SessionEvent.TrustUnverified(jws))
            }

            RecordType.RING -> onRing(body)

            RecordType.SAS_COMMIT, RecordType.SAS_NONCE, RecordType.SAS_REVEAL -> onSas(type, body)

            else -> {
                // Everything else belongs to the host, and only once the code is settled.
                if (phase == "sas-shown") {
                    // The peer may confirm first: hold the record (bounded) until this side's person does.
                    val held = queued.sumOf { it.second.size }
                    if (queued.size >= MAX_QUEUED || held + body.size > MAX_QUEUED_BYTES) throw Fail(PeerCloseCode.peer_busy.name)
                    queued += type to body
                } else if (phase != "open") {
                    throw Fail(PeerCloseCode.peer_not_allowed.name)
                } else {
                    onEvent(SessionEvent.Record(type, body))
                }
            }
        }
    }

    private suspend fun onSas(type: Int, body: ByteArray) {
        if (phase != "sas" || sasDone) throw Fail(PeerCloseCode.peer_bad_frame.name)
        val initiator = role == NoiseRole.initiator
        // Responder (the approver): COMMIT then REVEAL. Initiator (the device): NONCE.
        if (type == RecordType.SAS_COMMIT && !initiator && sasStep == 0) {
            val c = parseSasBody(SasMember.c, body) ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
            commit = encodeSasValue(c)
            val n = ports.random(SAS_NONCE_BYTES)
            nM = n
            emit(RecordType.SAS_NONCE, sasBody(SasMember.nM, n))
            sasStep = 1
            return
        }
        if (type == RecordType.SAS_NONCE && initiator && sasStep == 1) {
            val m = parseSasBody(SasMember.nM, body)
            val d = nD
            if (m == null || d == null) throw Fail(PeerCloseCode.peer_bad_frame.name)
            nM = m
            emit(RecordType.SAS_REVEAL, sasBody(SasMember.nD, d))
            finishSas()
            return
        }
        if (type == RecordType.SAS_REVEAL && !initiator && sasStep == 1) {
            val d = parseSasBody(SasMember.nD, body)
            val c = commit
            // sasRevealOk compares the commitment in constant time.
            if (d == null || c == null || !sasRevealOk(c, encodeSasValue(d))) throw Fail(PeerCloseCode.peer_bad_frame.name)
            nD = d
            finishSas()
            return
        }
        throw Fail(PeerCloseCode.peer_bad_frame.name)
    }

    private fun finishSas() {
        val code = sasValue(hs!!.handshakeHash, nD!!, nM!!, mode)
        sasDone = true
        phase = "sas-shown"
        onEvent(SessionEvent.Sas(code, sasDisplay(code)))
    }

    private fun onPeerClose(body: ByteArray) {
        val code = parseStrictObject(body)?.get("code").stringValue
        phase = "closed"
        transportDue = null
        certExpires = null
        wipe()
        val known = PeerCloseCode.values().any { it.name == code }
        onEvent(SessionEvent.Closed(if (known) code!! else PeerCloseCode.peer_bad_frame.name, true))
    }

    private suspend fun pushRing() {
        val held = account?.heldRing() ?: return
        if (held.epoch > peerRing) emit(RecordType.RING, JsonObject(mapOf("ring" to JsonPrimitive(held.jws))).toString().toByteArray(Charsets.UTF_8))
    }

    private fun onRing(body: ByteArray) {
        val ring = parseStrictObject(body)?.get("ring").stringValue ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
        val a = account ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
        val r = Peer.replaceRing(a.heldRing()?.jws, ring, a.trust, a.expectedAud, now())
        // A roster that is stale, older or another account's changes nothing.
        if (r !is RingReplacement.Replace || r.ring.sub != a.ownSub) return
        onEvent(SessionEvent.RingReceived(ring, r.ring.epoch))
        // The new roster may have dropped this peer.
        if (admit(peerCertJws, ring, peerRemote!!) !is PeerAdmission.Admit) throw Fail(PeerCloseCode.peer_revoked.name)
    }

    /** Seal records onto the wire, in order, so a REKEY never interleaves (callers hold the lock). */
    private suspend fun emit(type: Int, body: ByteArray) {
        val t = tp
        if (t == null || (phase == "closed" && type != RecordType.CLOSE)) throw IllegalStateException("closed")
        maybeRekey(t)
        for (plain in splitMessage(type, body)) {
            send(t.send.encrypt(ByteArray(0), plain))
            sent++
        }
    }

    private suspend fun maybeRekey(t: NoiseTransport) {
        if (sent < rekeyMessages && mono() - keyedAt < rekeySeconds) return
        send(t.send.encrypt(ByteArray(0), encodeRecord(PeerRecord(RecordType.REKEY, 0, ByteArray(0)))))
        t.send.rekey()
        sent = 0
        keyedAt = mono()
    }

    private companion object {
        val OWNED = setOf(
            RecordType.HELLO,
            RecordType.CLOSE,
            RecordType.REKEY,
            RecordType.SAS_COMMIT,
            RecordType.SAS_NONCE,
            RecordType.SAS_REVEAL,
        )
    }
}
