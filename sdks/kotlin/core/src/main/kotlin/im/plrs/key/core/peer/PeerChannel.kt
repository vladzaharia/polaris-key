// WIRE-CONTRACT-V5 sections 15.5 and 15.6: one `pkey-peer/1` session, mode `a` (account) (CC-12.8).
// Mirrors client-core's `peer/session.ts` and the Python engine; modes `v` and `p` (the SAS) follow in
// CC-12.9.
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
// Keys: the static private key is reached only through a [NoiseStatic] whose `dh` runs the static
// operations (G1). Nothing here prints a key, certificate or record body (G19).

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.Peer
import im.plrs.key.core.PeerAdmission
import im.plrs.key.core.RingReplacement
import im.plrs.key.core.RingResult
import im.plrs.key.core.StrictJson
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
    /** The handshake and the HELLO exchange are done and the session is open. */
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

    /** The session ended. [code] is a [PeerCloseCode] name or [HANDSHAKE_FAILED]. */
    public data class Closed(val code: String, val byPeer: Boolean) : SessionEvent()
}

private class Fail(val code: String) : Exception(code)

private class Pending(val remote: ByteArray, val peerDeviceId: String?)

/**
 * One session in mode `a`. [staticKey] is the device's agreement key (a [NoiseStatic]); [send] takes
 * one Noise message (the host frames it); [onEvent] runs inside whichever call produced the event.
 */
public class PeerChannel(
    private val role: NoiseRole,
    private val slug: String,
    private val staticKey: NoiseStatic,
    private val account: AccountContext,
    private val hello: HelloInfo,
    private val send: (ByteArray) -> Unit,
    private val onEvent: (SessionEvent) -> Unit,
    caps: List<String> = emptyList(),
    private val ports: NoisePorts = NoisePorts(),
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    private val mono: () -> Double = { System.nanoTime() / 1e9 },
    private val rekeyMessages: Int = DEFAULT_REKEY_MESSAGES,
    private val rekeySeconds: Double = DEFAULT_REKEY_SECONDS,
) {
    private val mode = PeerMode.a
    private val lock = Mutex()
    private val asm = RecordAssembler(RecordMode.a)
    private var caps: List<String> = caps.toList()
    private var hs: NoiseHandshake? = null
    private var hsStep = 0
    private var phase = "hs" // hs | hello | open | closed
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

    override fun toString(): String = "PeerChannel(mode=a, role=$role, phase=$phase)"

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
        certExpires?.let { waits += (it - now()).toDouble() }
        waits.minOrNull()?.coerceAtLeast(0.0)
    }

    /** Enforce the deadlines: `peer_timeout` when the transport took over 30 s, `peer_expired` when the peer's certificate ran out. */
    public suspend fun tick(): Unit = lock.withLock {
        if (phase == "closed") return@withLock
        val due = transportDue
        val expires = certExpires
        if (due != null && mono() >= due) {
            fail(PeerCloseCode.peer_timeout.name, false)
        } else if (expires != null && now() >= expires) {
            fail(PeerCloseCode.peer_expired.name, false)
        }
    }

    /** Initiator only: write message 1. */
    public suspend fun start(): Unit = guarded {
        if (role != NoiseRole.initiator || hs != null || phase != "hs") throw Fail(HANDSHAKE_FAILED)
        val key = account.discKeys.firstOrNull() ?: throw Fail(HANDSHAKE_FAILED)
        startClock()
        val h = newHandshake(key)
        hs = h
        send(h.writeMessage(payload1()))
        hsStep = 1
    }

    /** One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). */
    public suspend fun receive(noise: ByteArray): Unit = guarded {
        if (phase == "closed") return@guarded
        if (!started && role == NoiseRole.responder) startClock()
        if (phase == "hs") onHandshake(noise) else onTransport(noise)
    }

    /** Send one message of the host's, split into records. Only once the session is open. */
    public suspend fun sendRecord(type: Int, body: ByteArray): Unit = lock.withLock {
        check(phase == "open") { "session not open" }
        require(type !in OWNED) { "record owned by the session" }
        require(body.size <= maxSend) { "message too large" }
        emit(type, body)
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

    private fun wipe() {
        tp?.wipe()
    }

    private fun startClock() {
        if (started) return
        started = true
        transportDue = mono() + TRANSPORT_DEADLINE_SECONDS
    }

    private suspend fun newHandshake(discKey: ByteArray): NoiseHandshake = NoiseHandshake(
        NoiseHandshakeOptions(
            role = role,
            protocol = peerNoiseProtocol(mode),
            prologue = peerPrologue(slug, mode),
            psk = peerPsk(discKey, slug),
            staticKey = staticKey,
            ports = ports,
        ),
    )

    private fun ownPayload(): ByteArray {
        val held = account.heldRing()
        return payload23(mode, caps, AccountPayload(account.certJws, held?.epoch ?: 1))
    }

    private fun admit(certJws: String, ringJws: String?, remote: ByteArray): PeerAdmission = Peer.admitPeer(
        certJws,
        ringJws,
        account.trust,
        account.expectedAud,
        now(),
        CertSession("a", Base64Url.encode(remote), account.ownSub, account.ownDeviceId),
    )

    private suspend fun onHandshake(noise: ByteArray) {
        if (role == NoiseRole.responder && hs == null) {
            onFirstMessage(noise)
            return
        }
        val h = hs ?: throw Fail(HANDSHAKE_FAILED)
        val message = if (role == NoiseRole.initiator) 2 else 3
        if (hsStep != (if (role == NoiseRole.initiator) 1 else 2)) throw Fail(HANDSHAKE_FAILED)
        val verdict = parseHandshakePayload(mode, message, h.readMessage(noise)) as? PayloadVerdict.Accepted ?: throw Fail(HANDSHAKE_FAILED)
        val cert = verdict.cert
        val ring = verdict.ring
        val remote = h.remoteStatic
        if (cert == null || ring == null || remote == null) throw Fail(HANDSHAKE_FAILED)
        val held = account.heldRing()
        if (held != null) {
            // A held roster that is expired, unverifiable or another account's must not admit: ask for
            // a fresh one and refuse. Only a device with no roster at all (first run) admits.
            val v = Peer.verifyRing(held.jws, account.trust, account.expectedAud) as? RingResult.Ok
            if (v == null || Peer.ringExpired(v.ring, now()) || v.ring.sub != account.ownSub) {
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
        peerCaps = verdict.caps
        if (role == NoiseRole.initiator) send(h.writeMessage(ownPayload()))
        tp = h.transport()
        transportDue = null
        keyedAt = mono()
        phase = "hello"
        pending = Pending(remote, adm.cert.deviceId)
        sendHello()
    }

    /** Message 1: try the current then the previous discovery key; a failed tag closes silently. */
    private suspend fun onFirstMessage(noise: ByteArray) {
        var payload: ByteArray? = null
        for (k in account.discKeys.take(2)) {
            if (k == null) continue
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
        val parsed = StrictJson.validate(body) ?: return null
        val o = parsed.value
        val platform = o["platform"].stringValue
        val app = o["app"].stringValue
        if (platform == null || app == null) return null
        val rawLabel = o["label"]
        if ("label" in o && rawLabel.stringValue == null) return null
        val mm = o["maxMessage"].longValue
        if (!wireInteger(mm, "/maxMessage", 1, parsed.nonWireIntegers) || mm!! > MAX_SAFE_INTEGER) return null
        // Display data from the peer: NFC, controls and bidi stripped, 64 code points.
        val clean = rawLabel.stringValue?.let { normalizeDeviceLabel(Normalizer.normalize(it, Normalizer.Form.NFC)) }
        return PeerHello(platform, app, mm, clean)
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
            phase = "open"
            onEvent(SessionEvent.Established(caps.toList(), h, true, p.remote, p.peerDeviceId))
            pushRing()
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

            else -> onEvent(SessionEvent.Record(type, body))
        }
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
        val held = account.heldRing() ?: return
        if (held.epoch > peerRing) emit(RecordType.RING, JsonObject(mapOf("ring" to JsonPrimitive(held.jws))).toString().toByteArray(Charsets.UTF_8))
    }

    private fun onRing(body: ByteArray) {
        val ring = parseStrictObject(body)?.get("ring").stringValue ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
        val r = Peer.replaceRing(account.heldRing()?.jws, ring, account.trust, account.expectedAud, now())
        // A roster that is stale, older or another account's changes nothing.
        if (r !is RingReplacement.Replace || r.ring.sub != account.ownSub) return
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
