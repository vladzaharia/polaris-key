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
// Mode v adds (section 15.6.1, CC-15): both payloads list `vouch/1` (without it the session closes
// `peer_not_allowed` after HELLO, before any SAS record); [PeerChannel.vouch] is the order guard of the
// vouch records; [PeerChannel.handshakeHash] gives the handshake hash `h` once established; an initiator
// built with `holdSas` stops after HELLO until the host calls [PeerChannel.startSas], and its 120 s code
// deadline restarts then (the approver's restarts when `SAS_COMMIT` arrives).
//
// Modes q and l (section 15.12, CC-29.13) are the account-free local links. Mode q is the pairing: XXpsk0 under a PSK
// from CPace ([cpacePsk], run by the caller before message 1), a fresh link key as the static key, then HELLO, the
// person's consent ([PeerChannel.confirmPairing]), CONFIRM each way and one LOCAL_LINK each way ([LocalExchange]); a side
// that reads the peer's LOCAL_LINK reports a [SessionEvent.LocalLinked] and closes `peer_bye`. A responder needs
// [PairingOptions.permit], which counts the guess before the tag is tried. Mode l is a later session: XXpsk0 under a
// link's secret, the link's own key as the static key, and the remote static key pinned to the stored peer link key. A
// responder that holds local links tries them after the account keys and the contacts, behind the same limiter.
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
import im.plrs.key.core.stringValue
import im.plrs.key.core.wireInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

private const val SAS_NONCE_BYTES = 32
private const val KEY_BYTES = 32
private const val ISK_BYTES = 64
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

/** A contact the device holds (mode c): its secret (the PSK) and the peer's agreeKey. Prints as redacted. */
public class ContactLink(
    /** The 32-byte contact secret. */
    public val secret: ByteArray,
    /** The peer's agreeKey, 43 canonical base64url characters: the remote static key must equal it. */
    public val agreeKey: String,
) {
    override fun toString(): String = "ContactLink(redacted)"
}

/**
 * A local link the device holds (mode l, section 15.12): the link's secret (the PSK), its own private key and the peer's link
 * key. Prints as redacted.
 */
public class LocalLink(
    /** The 32-byte link secret. */
    public val secret: ByteArray,
    /** This device's private key for the link: the static key of every session under it. */
    public val ownKey: ByteArray,
    /** The peer's link public key: the remote static key must equal it. */
    public val peerKey: ByteArray,
) {
    override fun toString(): String = "LocalLink(redacted)"
}

/** What a mode-`q` session needs (section 15.12): the CPace outputs and this side's part of the exchange. */
@Suppress("LongParameterList")
public class PairingOptions(
    /** `HKDF-SHA256(ISK)`, the Noise PSK ([cpacePsk]). Overwritten once the handshake is done. */
    public val psk: ByteArray,
    /** The CPace ISK, 64 bytes: it makes the link secret. Overwritten when the session ends. */
    public val isk: ByteArray,
    /** The number of local links the device holds for the product ([MAX_LOCAL_LINKS] refuses a link). */
    public val held: Int,
    /** The categories this side's person approved. */
    public val cats: List<String>,
    /** This device's label for the peer to show. */
    public val label: String? = null,
    /**
     * Seconds already spent since the first byte (C1 and C2 ran before the session). At 30 or more the session starts no handshake
     * and tries no tag.
     */
    public val elapsed: Double = 0.0,
    /**
     * A responder's permit to try message 1's tag ([PairingWindow.beginGuess]): synchronous, it counts the guess before
     * the tag is tried. The session never tries a tag without one, and a mode-q responder is refused without it.
     */
    public val permit: (() -> Boolean)? = null,
) {
    override fun toString(): String = "PairingOptions(redacted)"
}

/** This device's side of the contact exchange (mode p, section 15.10). */
public class ContactOffer(
    /** This device's own agreeKey, 43 canonical base64url characters. */
    public val agreeKey: String,
    /** The agreeKey of every active contact the host holds for the product ([ContactExchange]). */
    public val held: List<String> = emptyList(),
    public val label: String? = null,
    /** The data categories this side's person approved (at most 8, `[a-z0-9-]{1,32}`). */
    public val cats: List<String> = emptyList(),
) {
    override fun toString(): String = "ContactOffer"
}

/** The peer's HELLO: display data (authenticated in mode a, by the certificate that opened the session). */
public data class PeerHello(val platform: String, val app: String, val maxMessage: Long, val label: String? = null)

/** What this side says about itself in its HELLO. */
public data class HelloInfo(val platform: String, val app: String, val label: String? = null, val maxMessage: Long = MAX_PEER_MESSAGE_BYTES.toLong())

/** Everything a session tells its host. */
public sealed class SessionEvent {
    /** The handshake and the HELLO exchange are done (modes v and p still need the SAS). */
    @Suppress("LongParameterList")
    public class Established(
        public val caps: List<String>,
        public val hello: PeerHello,
        public val helloAuthenticated: Boolean,
        public val remoteStatic: ByteArray,
        public val peerDeviceId: String?,
        /** Mode c: the index, in the channel's contacts, of the contact the peer is. */
        public val contactIndex: Int? = null,
        /** Mode l: the index, in the channel's local links, of the link the peer is. */
        public val localIndex: Int? = null,
    ) : SessionEvent() {
        override fun toString(): String = "Established(caps=${caps.size})"
    }

    /** A record the host owns. The host must close on an APP_CRITICAL type (0x8100 to 0xFFFD) it does not understand. */
    public class Record(public val recordType: Int, public val body: ByteArray) : SessionEvent() {
        override fun toString(): String = "Record(type=$recordType, ${body.size} bytes)"
    }

    /**
     * Mode p with an exchange: the peer's valid `CONTACT`, read in order. [secret] is the new contact secret
     * (key material: store it, zero your copy, never log it); [pending] is true for a peer the host holds.
     */
    public class Contact(public val secret: ByteArray, public val body: ContactBody, public val pending: Boolean) : SessionEvent() {
        override fun toString(): String = "Contact(pending=$pending)"
    }

    /**
     * Mode q, responder: its message 1 was judged (section 15.12, "Failure accounting"). [opens] false is one failed
     * guess: the window rotates the code, and the session closes silently.
     */
    public class Guess(public val opens: Boolean) : SessionEvent() {
        override fun toString(): String = "Guess(opens=$opens)"
    }

    /**
     * Mode q: the peer's valid `LOCAL_LINK`, read in order. [secret] is the link secret (key material: store it, zero your
     * copy, never log it) with [ownKey] and [peerKey] the two link public keys and [cats] the categories both sides
     * listed. The host stores the link; the session closes `peer_bye`.
     */
    public class LocalLinked(
        public val secret: ByteArray,
        public val ownKey: ByteArray,
        public val peerKey: ByteArray,
        public val label: String?,
        public val cats: List<String>,
    ) : SessionEvent() {
        override fun toString(): String = "LocalLinked(cats=${cats.size})"
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

/** Message 1s a minute one source group may send a listener that holds no account key (section 15.10). */
public const val LOCAL_GROUP_PER_MINUTE: Int = 2

/** What [HandshakeLimiter.beginLocal] answers. */
public sealed class LocalAdmission {
    /** Refused with no trial: [by] is `group` or `shared`. */
    public class Refused(public val by: String) : LocalAdmission() {
        override fun toString(): String = "Refused($by)"
    }

    /** One trial is allowed. Call [hit] when it opens (it returns the waiting slot's release) or [miss] when it does not. */
    public class Admitted(public val hit: () -> () -> Unit, public val miss: () -> Unit) : LocalAdmission() {
        override fun toString(): String = "Admitted"
    }
}

/**
 * The approver's admission: at most [maxPerMinute] handshakes a minute (default 5) and at most
 * [maxPending] sessions waiting on a code (default 4), on a monotonic clock. An attempt counts only
 * when [begin] is called, which a session does when its first byte arrives.
 */
public class HandshakeLimiter(
    private val maxPerMinute: Int = 5,
    private val maxPending: Int = 4,
    private val groupMax: Int = LOCAL_GROUP_PER_MINUTE,
    private val mono: () -> Double = { System.nanoTime() / 1e9 },
) {
    private val lock = Any()
    private val stamps = ArrayList<Double>()
    private var pending = 0

    /** Per source group, the message 1s of the last minute ([beginLocal]). */
    private val groups = HashMap<String, ArrayList<Double>>()

    /**
     * The admission of a listener that holds no account key (section 15.10, "Admission"): the group's budget
     * ([groupMax] a minute, counted as the message 1 arrives) comes first, then the shared limit, which counts only
     * failed trials (and the sessions waiting on message 3). A refusal costs no trial. `hit()` refunds the group's
     * count and takes a waiting slot; `miss()` spends the shared budget.
     */
    @Suppress("CyclomaticComplexMethod")
    public fun beginLocal(group: String): LocalAdmission {
        var refusal: String? = null
        val t = mono()
        synchronized(lock) {
            stamps.removeAll { t - it >= RATE_WINDOW_SECONDS }
            val live = groups.entries.iterator()
            while (live.hasNext()) {
                val e = live.next()
                e.value.removeAll { s -> t - s >= RATE_WINDOW_SECONDS }
                if (e.value.isEmpty()) live.remove()
            }
            val mine = groups[group] ?: ArrayList()
            if (mine.size >= groupMax) {
                refusal = "group"
            } else if (stamps.size >= maxPerMinute || pending >= maxPending) {
                refusal = "shared"
            } else {
                mine += t
                groups[group] = mine
            }
        }
        refusal?.let { return LocalAdmission.Refused(it) }
        var settled = false
        return LocalAdmission.Admitted(
            hit = {
                var first = false
                synchronized(lock) {
                    if (!settled) {
                        settled = true
                        first = true
                        // The refund takes this message's timestamp out of the group's LIVE list, not out of the list captured
                        // when it arrived: the list may have been trimmed or replaced since, and other messages counted.
                        val live = groups[group]
                        val i = live?.lastIndexOf(t) ?: -1
                        if (live != null && i >= 0) {
                            live.removeAt(i)
                            if (live.isEmpty()) groups.remove(group)
                        }
                        pending++
                    }
                }
                if (first) waitingSlot() else NO_RELEASE
            },
            miss = {
                synchronized(lock) {
                    if (!settled) {
                        settled = true
                        stamps += mono()
                    }
                }
            },
        )
    }

    /** A release function when one more session may start now; null when refused. */
    public fun begin(): (() -> Unit)? {
        synchronized(lock) {
            val t = mono()
            stamps.removeAll { t - it >= RATE_WINDOW_SECONDS }
            if (stamps.size >= maxPerMinute || pending >= maxPending) return null
            stamps += t
            pending++
        }
        return waitingSlot()
    }

    /** The release of one waiting slot (already counted): idempotent. */
    private fun waitingSlot(): () -> Unit {
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

private val NO_RELEASE: () -> Unit = {}

private val DEFAULT_PORTS = NoisePorts()

private class Pending(val remote: ByteArray, val peerDeviceId: String?)

/**
 * One session. [mode] is `a` ([account] required), or `v` / `p` (a one-time [staticKey]; a responder
 * also needs [admission]). [staticKey] is the device's agreement key (a [NoiseStatic]); [send] takes
 * one Noise message (the host frames it); [onEvent] runs inside whichever call produced the event.
 */
@Suppress("LargeClass")
public class PeerChannel(
    private val role: NoiseRole,
    private val slug: String,
    private val staticKey: NoiseStatic?,
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
    mode: PeerMode = PeerMode.a,
    private val admission: HandshakeLimiter? = null,
    /**
     * Mode c, and a mode-a responder that also serves contacts (the shared listener, section 15.10): the
     * contacts the device holds in `contactTrialOrder`, at most 72. A mode-c initiator names exactly one. A
     * responder first tries the account's keys (mode a only), then each secret in order; the first tag that
     * verifies decides the mode. It needs [admission].
     */
    private val contacts: List<ContactLink> = emptyList(),
    /** Mode p only: take part in the contact exchange. The session then owns `CONFIRM` and `CONTACT`. */
    private val exchange: ContactOffer? = null,
    /**
     * Mode v, initiator only: stop after HELLO and send no SAS record until the host calls [startSas]. The
     * host dials several approvers and starts the one the person chose (N9).
     */
    private val holdSas: Boolean = false,
    /**
     * Mode l, and a responder that also serves local links (section 15.12): the links the device holds in held order, at
     * most 32. A mode-l initiator names exactly one. A responder tries them after the account's keys and the contacts,
     * behind the same [admission] limiter.
     */
    private val locals: List<LocalLink> = emptyList(),
    /** Mode q only: the CPace outputs and this side's part of the pairing. */
    private val pair: PairingOptions? = null,
    /**
     * A responder that holds no account key (a local-links-only listener): the source group of the connection (the accept
     * gate's own key). With it, the trial is admitted by the group's budget first and only a failed trial spends the
     * shared one (section 15.10, "Admission"). Without it, or with an account key tried, the shared limiter admits.
     */
    private val admissionGroup: String? = null,
) {
    private val lock = Mutex()
    private var mode: PeerMode = mode
    private var asm = RecordAssembler(RecordMode.valueOf(mode.name))
    private val xchg: ContactExchange? = exchange?.let { ContactExchange(it.agreeKey, it.held) }
    private var contactIdx = -1
    private var localIdx = -1
    private var contactDue: Double? = null
    private var hash: ByteArray? = null

    /** Mode q: the pairing's order guard, the clock that runs once both CONFIRMs are done, and this side's link public key. */
    private val lx: LocalExchange? = pair?.let { LocalExchange(it.held, it.cats) }
    private var lxTimer = false
    private var ownPub: ByteArray? = null

    /** The static keys made for local-link trials: wiped when the session ends. */
    private val linkKeys = ArrayList<RawNoiseStatic>()

    // Both mode-v payloads list `vouch/1` (rule 1); the host cannot leave it out.
    private var caps: List<String> = when {
        mode == PeerMode.v && VOUCH_CAP !in caps -> caps + VOUCH_CAP

        // Mode q needs `local/1` on both sides (section 15.12): the host cannot leave it out of its payload.
        mode == PeerMode.q && LOCAL_CAP !in caps -> caps + LOCAL_CAP

        else -> caps.toList()
    }
    private val flow: VouchFlow<VouchMessage>? =
        if (mode == PeerMode.v) VouchFlow(if (role == NoiseRole.initiator) VouchRole.Requester else VouchRole.Approver) else null
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
    private var xfer: ((Int, ByteArray) -> Unit)? = null

    init {
        require((mode == PeerMode.a) == (account != null)) { "account context" }
        require(mode == PeerMode.l || staticKey != null) { "static key" }
        require(
            contacts.all {
                it.secret.size == KEY_BYTES
            } && locals.all { l -> listOf(l.secret, l.ownKey, l.peerKey).all { it.size == KEY_BYTES } },
        ) {
            "secrets"
        }
        if (mode == PeerMode.c) {
            require(contacts.size in 1..MAX_CONTACT_SECRETS && (role != NoiseRole.initiator || contacts.size == 1)) { "contacts" }
            require(role == NoiseRole.initiator || admission != null) { "a contact responder needs an admission limiter" }
            require(locals.isEmpty() || (role == NoiseRole.responder && locals.size <= MAX_LOCAL_LINKS)) { "locals" }
        } else if (mode == PeerMode.l) {
            require(locals.size in 1..MAX_LOCAL_LINKS && (role != NoiseRole.initiator || locals.size == 1)) { "locals" }
            require(contacts.isEmpty() || (role == NoiseRole.responder && contacts.size <= MAX_CONTACT_SECRETS)) { "contacts" }
            require(role == NoiseRole.initiator || admission != null) { "a local-link responder needs an admission limiter" }
        } else if (contacts.isNotEmpty() || locals.isNotEmpty()) {
            // The shared listener: a mode-a responder that also serves contacts and local links.
            require(mode == PeerMode.a && role == NoiseRole.responder) { "contacts" }
            require(contacts.size <= MAX_CONTACT_SECRETS && locals.size <= MAX_LOCAL_LINKS) { "contacts" }
            require(admission != null) { "a contact responder needs an admission limiter" }
        }
        if (mode == PeerMode.q) {
            require(
                pair != null && pair.psk.size == KEY_BYTES && pair.isk.size == ISK_BYTES && pair.held >= 0 && pair.elapsed >= 0.0 &&
                    (role != NoiseRole.responder || pair.permit != null),
            ) { "pairing" }
        } else {
            require(pair == null) { "pairing is for mode q" }
        }
        require(exchange == null || mode == PeerMode.p) { "exchange is for mode p" }
        require(mode != PeerMode.v && mode != PeerMode.p || role != NoiseRole.responder || admission != null) {
            "an approver needs an admission limiter"
        }
        require(!holdSas || (mode == PeerMode.v && role == NoiseRole.initiator)) { "holdSas is for the mode v initiator" }
    }

    override fun toString(): String = "PeerChannel(mode=${mode.name}, role=$role, phase=$phase)"

    /** True once HELLO has been exchanged and until the session closes. */
    public val isOpen: Boolean get() = phase == "open"

    /** True once the session has ended. */
    public val closed: Boolean get() = phase == "closed"

    /**
     * Mode v: this session's order guard (section 15.6.1), negotiated when the session is established. Null in
     * the other modes.
     */
    public val vouch: VouchFlow<VouchMessage>? get() = flow

    /**
     * The Noise handshake hash `h`, a copy, once the session is established (section 15.6.1 binds the vouch
     * to it). Throws [IllegalStateException] before that. It is a public value; the one-time keys never leave
     * the handshake.
     */
    public fun handshakeHash(): ByteArray = checkNotNull(hash) { "session not established" }.copyOf()

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
        contactDue?.let { waits += it - mono() }
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
        if (lx != null && deadlinePassed(sasDue) && !deadlinePassed(transportDue)) {
            // Mode q: 120 s from the first byte until both CONFIRMs are done (section 15.12).
            sasDue = null
            try {
                localStep(LocalExchangeEvent.TimeoutConfirm)
            } catch (e: Fail) {
                fail(e.code, false)
            }
        } else if (deadlinePassed(transportDue) || deadlinePassed(sasDue)) {
            fail(PeerCloseCode.peer_timeout.name, false)
        } else if (deadlinePassed(contactDue)) {
            contactDue = null
            try {
                if (lx != null) localStep(LocalExchangeEvent.TimeoutExchange) else exchangeStep(ExchangeEvent.Timeout)
            } catch (e: Fail) {
                fail(e.code, false)
            }
        } else if (expires != null && now() >= expires) {
            fail(PeerCloseCode.peer_expired.name, false)
        }
    }

    private fun deadlinePassed(due: Double?): Boolean = due != null && mono() >= due

    /** Initiator only: write message 1. */
    @Suppress("CyclomaticComplexMethod")
    public suspend fun start(): Unit = guarded {
        if (role != NoiseRole.initiator || hs != null || phase != "hs") throw Fail(HANDSHAKE_FAILED)
        if (pair != null && pair.elapsed >= TRANSPORT_DEADLINE_SECONDS) throw Fail(HANDSHAKE_FAILED)
        val key = account?.let { it.discKeys.firstOrNull() ?: throw Fail(HANDSHAKE_FAILED) }
        startClock()
        if (mode == PeerMode.c) contactIdx = 0
        if (mode == PeerMode.l) localIdx = 0
        val h = when (mode) {
            PeerMode.c -> newHandshake(mode, contacts[0].secret)
            PeerMode.l -> newHandshake(mode, locals[0].secret, linkStatic(locals[0]))
            PeerMode.q -> newHandshake(mode, pair!!.psk)
            else -> newHandshake(mode, key?.let { peerPsk(it, slug) })
        }
        hs = h
        send(h.writeMessage(payload1()))
        hsStep = 1
    }

    /** One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). */
    public suspend fun receive(noise: ByteArray): Unit = guarded {
        if (phase == "closed") return@guarded
        if (!started && role == NoiseRole.responder) {
            // An approver counts the attempt only now that a session starts.
            if (admission != null && (mode == PeerMode.v || mode == PeerMode.p)) {
                release = admission.begin() ?: throw Fail(PeerCloseCode.peer_busy.name)
            }
            startClock()
        }
        if (phase == "hs") onHandshake(noise) else onTransport(noise)
    }

    /** Send one message of the host's, split into records. Only once the session is open. */
    public suspend fun sendRecord(type: Int, body: ByteArray): Unit = lock.withLock {
        check(phase == "open") { "session not open" }
        // A pairing carries no host records: the session owns every one it may send (section 15.12).
        require(mode != PeerMode.q) { "record owned by the session" }
        require(
            type !in OWNED && !isXferType(type) && !(type == RecordType.CONFIRM && mode == PeerMode.p) &&
                !(type == RecordType.CONTACT && xchg != null),
        ) {
            "record owned by the session"
        }
        require(body.size <= maxSend) { "message too large" }
        emit(type, body)
    }

    /**
     * The transfer port (section 15.11): the one reader and writer of the six transfer record types. Records of
     * those types reach [onRecord] instead of the host's `Record` event, and [sendRecord] refuses them. Only once
     * the session is open with `xfer/1` among its capabilities, and once. Returns the writer.
     */
    public fun attachXfer(onRecord: (Int, ByteArray) -> Unit): suspend (Int, ByteArray) -> Unit {
        check(phase == "open" && xfer == null && XFER_CAP in caps) { "transfers are not available on this session" }
        xfer = onRecord
        return { type, body ->
            lock.withLock {
                check(phase == "open" && isXferType(type)) { "session not open" }
                require(body.size <= maxSend) { "message too large" }
                emit(type, body)
            }
        }
    }

    /**
     * Mode v, `holdSas` initiator: the person chose this approver; send `SAS_COMMIT` now and start the 120 s
     * code deadline over. Only once, only after the session is established; any other call closes the
     * session `peer_not_allowed`.
     */
    public suspend fun startSas(): Unit = guarded {
        if (!canStartSas()) throw Fail(PeerCloseCode.peer_not_allowed.name)
        // The code deadline counts from the person's choice, not from the first byte: a session held while
        // the person looked at the list keeps its whole 120 s.
        sasDue = mono() + SAS_DEADLINE_SECONDS
        commitSas()
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
        if (xchg != null) {
            // The peer's CONTACT must follow within CONTACT_EXCHANGE_SECONDS of this CONFIRM.
            contactDue = mono() + CONTACT_EXCHANGE_SECONDS
            exchangeStep(ExchangeEvent.OwnConfirm)
        }
        val q = ArrayList(queued)
        queued.clear()
        for ((t, b) in q) onEvent(SessionEvent.Record(t, b))
    }

    /**
     * Mode q: the person agreed to pair. Sends `CONFIRM`, and `LOCAL_LINK` once the peer's `CONFIRM` has been read. Only
     * once, only after the session is established; any other call closes the session `peer_not_allowed`.
     */
    public suspend fun confirmPairing(): Unit = guarded {
        if (lx == null || phase != "sas-shown") throw Fail(PeerCloseCode.peer_not_allowed.name)
        phase = "open"
        localStep(LocalExchangeEvent.OwnConfirm)
    }

    /** Mode q: the person declined. Closes `peer_bye` (a decline after the person agreed is ignored). */
    public suspend fun declinePairing(): Unit = guarded {
        if (lx == null) throw Fail(PeerCloseCode.peer_not_allowed.name)
        localStep(LocalExchangeEvent.OwnDecline)
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
        // The CPace outputs and the per-link keys are key material: gone once the session is over.
        pair?.psk?.fill(0)
        pair?.isk?.fill(0)
        for (k in linkKeys) k.wipe()
        linkKeys.clear()
    }

    private fun startClock() {
        if (started) return
        started = true
        // Mode q: C1 and C2 ran before this session, so their time counts against both deadlines.
        val spent = pair?.elapsed ?: 0.0
        transportDue = mono() + maxOf(0.0, TRANSPORT_DEADLINE_SECONDS - spent)
        if (mode == PeerMode.v || mode == PeerMode.p) {
            sasDue = mono() + SAS_DEADLINE_SECONDS
        } else if (mode == PeerMode.q) {
            // 120 s from the first byte until both CONFIRMs are done (section 15.12).
            sasDue = mono() + maxOf(0.0, SAS_DEADLINE_SECONDS - spent)
        }
    }

    /** A handshake of [mode] under [psk] (the discovery key's, a contact's, a link's or the pairing's; null in modes v and p). */
    private fun newHandshake(mode: PeerMode, psk: ByteArray?, key: NoiseStatic? = staticKey): NoiseHandshake = NoiseHandshake(
        NoiseHandshakeOptions(
            role = role,
            protocol = peerNoiseProtocol(mode),
            prologue = peerPrologue(slug, mode),
            psk = psk,
            staticKey = key ?: throw Fail(HANDSHAKE_FAILED),
            ports = ports,
        ),
    )

    /** The static key of one local link: a copy of its private key, wiped when the session ends. */
    private fun linkStatic(l: LocalLink): NoiseStatic = RawNoiseStatic(l.ownKey, ports.curves).also { linkKeys += it }

    private fun ownPayload(): ByteArray {
        val a = account
        if (a == null || mode != PeerMode.a) return payload23(mode, caps)
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
        if (mode == PeerMode.c) {
            // The pin (section 15.10): the peer must be the key the contact was made with. Nothing is sent.
            if (!contactPin(contacts[contactIdx].agreeKey, remote)) throw Fail(PeerCloseCode.peer_revoked.name)
        }
        if (mode == PeerMode.l) {
            // The pin (section 15.12): the peer must be the key the link was made with. Nothing is sent.
            if (!localPin(locals[localIdx].peerKey, remote)) throw Fail(PeerCloseCode.peer_revoked.name)
        }
        if (mode == PeerMode.q) {
            // A reflected handshake (the peer's static key is our own) ends silently, before the transport (section 15.12, "Link keys").
            val own = (staticKey ?: throw Fail(HANDSHAKE_FAILED)).publicKey()
            ownPub = own
            if (!pairingRemoteOk(own, remote)) throw Fail(HANDSHAKE_FAILED)
        }
        if (mode == PeerMode.a) {
            val cert = verdict.cert
            val ring = verdict.ring
            if (cert == null || ring == null) throw Fail(HANDSHAKE_FAILED)
            peerDeviceId = admitAccount(cert, ring, remote)
        }
        peerCaps = verdict.caps
        if (role == NoiseRole.initiator) send(h.writeMessage(ownPayload()))
        tp = h.transport()
        pair?.psk?.fill(0)
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

    /**
     * Message 1, tried in a fixed order (section 15.5, 15.10, 15.12): the account's current then previous discovery key
     * (mode a), then each contact's secret and each local link's secret in the order of [listenerTrialOrder] (no DH
     * happens before the tag). The first tag that verifies decides the mode and the secret; a failed tag on every one
     * closes silently. The contact and local-link trials are admitted by the limiter first, so a refused attempt tries no
     * secret.
     */
    @Suppress("SwallowedException")
    private suspend fun onFirstMessage(noise: ByteArray) {
        var payload: ByteArray? = null
        var accountTried = 0

        val acct = account
        if (mode == PeerMode.q) {
            // The pairing window's attempt: one secret, the code's PSK. A tag that fails is one failed guess (section
            // 15.12): the host's window rotates the code. The permit counts the guess before the tag is tried; without it,
            // or past the attempt's 30 s, the tag is never tried ("Failure accounting").
            val p = pair!!
            if (p.elapsed >= TRANSPORT_DEADLINE_SECONDS || !p.permit!!()) throw Fail(HANDSHAKE_FAILED)
            val h = newHandshake(PeerMode.q, p.psk)
            try {
                payload = h.readMessage(noise)
                hs = h
            } catch (e: NoiseException) {
                onEvent(SessionEvent.Guess(false))
                throw Fail(HANDSHAKE_FAILED)
            }
            onEvent(SessionEvent.Guess(true))
        } else if (mode != PeerMode.c && mode != PeerMode.l) {
            for (k in if (acct != null) acct.discKeys.take(2) else listOf<ByteArray?>(null)) {
                if (acct != null && k == null) continue
                accountTried++
                try {
                    val h = newHandshake(mode, k?.let { peerPsk(it, slug) })
                    payload = h.readMessage(noise)
                    hs = h
                    break
                } catch (e: NoiseException) {
                    continue
                }
            }
        }
        if (hs == null && (contacts.isNotEmpty() || locals.isNotEmpty())) payload = trySecrets(noise, accountTried)
        val h = hs
        if (h == null || payload == null) throw Fail(HANDSHAKE_FAILED)
        if (parseHandshakePayload(mode, 1, payload) !is PayloadVerdict.Accepted) throw Fail(HANDSHAKE_FAILED)
        send(h.writeMessage(ownPayload()))
        hsStep = 2
    }

    /**
     * The contact and local-link trials of a shared listener, behind the limiter. No account key held and a group known:
     * the group's budget, then the shared limiter that only a failed trial spends (section 15.10, "Admission");
     * otherwise the shared limiter counts the attempt as it begins. A miss costs the same whatever the host holds: dummy
     * trials make up the difference. Returns message 1's payload when a secret opened it.
     */
    private suspend fun trySecrets(noise: ByteArray, accountTried: Int): ByteArray? {
        var attempt: LocalAdmission.Admitted? = null
        val group = admissionGroup
        if (accountTried == 0 && group != null) {
            attempt = admission!!.beginLocal(group) as? LocalAdmission.Admitted ?: throw Fail(PeerCloseCode.peer_busy.name)
        } else {
            release = admission!!.begin() ?: throw Fail(PeerCloseCode.peer_busy.name)
        }
        var tried = 0
        var payload: ByteArray? = null
        for (t in listenerTrialOrder(null, contacts.size, locals.size)) {
            payload = openTrial(t, noise)
            if (hs != null) {
                if (attempt != null) release = attempt.hit()
                break
            }
            tried++
        }
        if (hs == null) {
            attempt?.miss()
            for (n in trialPadding(tried + accountTried) downTo 1) dummyTrial(noise)
        }
        return payload
    }

    /** One trial of message 1 under a held secret. On success the session is bound to that secret's mode and `hs` is set. */
    @Suppress("SwallowedException")
    private suspend fun openTrial(t: TrialEntry, noise: ByteArray): ByteArray? {
        var key: RawNoiseStatic? = null
        try {
            val h = if (t.kind == 'c') {
                newHandshake(PeerMode.c, contacts[t.index].secret)
            } else {
                val l = locals[t.index]
                newHandshake(PeerMode.l, l.secret, RawNoiseStatic(l.ownKey, ports.curves).also { key = it })
            }
            val payload = h.readMessage(noise)
            hs = h
            if (t.kind == 'c') {
                contactIdx = t.index
            } else {
                localIdx = t.index
                key?.let { linkKeys += it }
            }
            mode = if (t.kind == 'c') PeerMode.c else PeerMode.l
            asm = RecordAssembler(RecordMode.valueOf(mode.name))
            return payload
        } catch (e: NoiseException) {
            key?.wipe()
            return null
        }
    }

    /** One trial under a random secret, on the default ports (so a host's own ports count only the real trials): it opens nothing. */
    private suspend fun dummyTrial(noise: ByteArray) {
        val key = RawNoiseStatic(DEFAULT_PORTS.random(KEY_BYTES))
        try {
            NoiseHandshake(
                NoiseHandshakeOptions(
                    role = NoiseRole.responder,
                    protocol = peerNoiseProtocol(PeerMode.l),
                    prologue = peerPrologue(slug, PeerMode.l),
                    psk = DEFAULT_PORTS.random(KEY_BYTES),
                    staticKey = key,
                ),
            ).readMessage(noise)
        } catch (e: NoiseException) {
            // a dummy secret opens nothing
        } finally {
            key.wipe()
        }
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
                platform = cleanPlatform(platform),
                app = cleanApp(app),
                maxMessage = mm!!,
                label = rawLabel.stringValue?.let(::cleanLabel),
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
            if (flow != null) {
                // Rule 1 (N7): without `vouch/1` on both sides, close before any SAS record.
                val v = flow.negotiate(caps, peerCaps)
                if (v is VouchVerdict.Closed) throw Fail(v.close.name)
            }
            if (mode == PeerMode.q) {
                // `local/1` is mandatory (section 15.12): without it, close before any consent prompt.
                negotiateLocalCaps(mode, caps, peerCaps).close?.let { throw Fail(it.name) }
            }
            caps = capsIntersection(caps, peerCaps)
            asm.xferAllowed = XFER_CAP in caps
            pending = null
            hash = hs!!.handshakeHash
            val acctMode = mode == PeerMode.a
            val direct = acctMode || mode == PeerMode.c || mode == PeerMode.l
            // Mode q has no code to compare: its person's consent follows ([confirmPairing]).
            phase = if (direct) {
                "open"
            } else if (mode == PeerMode.q) {
                "sas-shown"
            } else {
                "sas"
            }
            // A contact responder's slot among the connections waiting for message 3 ends here.
            if (direct) settle()
            onEvent(
                SessionEvent.Established(
                    caps.toList(),
                    h,
                    acctMode,
                    p.remote,
                    p.peerDeviceId,
                    contactIndex = if (mode == PeerMode.c) contactIdx else null,
                    localIndex = if (mode == PeerMode.l) localIdx else null,
                ),
            )
            if (acctMode) {
                pushRing()
            } else if (direct || mode == PeerMode.q) {
                return
            } else if (role == NoiseRole.initiator && !holdSas) {
                // The device commits first, unless the host holds the code back until it picks this approver.
                commitSas()
            }
            return
        }
        when (type) {
            RecordType.HELLO -> throw Fail(PeerCloseCode.peer_bad_frame.name)

            RecordType.PING -> emit(RecordType.PONG, body)

            RecordType.PONG -> Unit

            RecordType.REKEY -> tp!!.receive.rekey()

            RecordType.CLOSE -> onPeerClose(body)

            RecordType.CONFIRM, RecordType.CONTACT, RecordType.LOCAL_LINK -> if (lx != null) {
                // Mode q: the session owns both records. Only after the transport is up.
                if (phase != "sas-shown" && phase != "open") throw Fail(PeerCloseCode.peer_not_allowed.name)
                localStep(if (type == RecordType.CONFIRM) LocalExchangeEvent.PeerConfirm else LocalExchangeEvent.PeerLink(body))
            } else if (xchg != null) {
                // With the exchange on, the session owns both; only after the code is shown.
                if (phase != "sas-shown" && phase != "open") throw Fail(PeerCloseCode.peer_not_allowed.name)
                exchangeStep(if (type == RecordType.CONFIRM) ExchangeEvent.PeerConfirm else ExchangeEvent.PeerContact(body))
            } else {
                hostRecord(type, body)
            }

            RecordType.TRUST -> {
                if (mode != PeerMode.a) throw Fail(PeerCloseCode.peer_not_allowed.name)
                val jws = parseStrictObject(body)?.get("trust").stringValue ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
                onEvent(SessionEvent.TrustUnverified(jws))
            }

            RecordType.RING -> onRing(body)

            RecordType.SAS_COMMIT, RecordType.SAS_NONCE, RecordType.SAS_REVEAL -> onSas(type, body)

            else -> if (isXferType(type)) {
                // Direct Transfer: the capability was checked by the assembler; no port attached means the host
                // listed the capability without a transfer layer behind it.
                (xfer ?: throw Fail(PeerCloseCode.peer_not_allowed.name))(type, body)
            } else {
                hostRecord(type, body)
            }
        }
    }

    /** Everything else belongs to the host, and only once the code is settled. */
    private fun hostRecord(type: Int, body: ByteArray) {
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

    /** Run one event through the pairing exchange (mode q) and act on what it says. */
    private suspend fun localStep(e: LocalExchangeEvent) {
        val x = lx!!
        val p = pair!!
        val r = x.step(e)
        if ("CONFIRM" in r.sends) emit(RecordType.CONFIRM, "{}".toByteArray(Charsets.UTF_8))
        if ("LOCAL_LINK" in r.sends) emit(RecordType.LOCAL_LINK, buildLocalLink(p.label, p.cats))
        // Both CONFIRMs done: the 120 s deadline ends and the exchange's 30 s begins.
        if (x.bothConfirmed && !lxTimer) {
            lxTimer = true
            settle()
            contactDue = mono() + CONTACT_EXCHANGE_SECONDS
        }
        val stored = r.stored
        if (stored != null) {
            val own = ownPub
            val h = hash
            val peer = hs?.remoteStatic
            if (own == null || h == null || peer == null) throw Fail(HANDSHAKE_FAILED)
            val secret = localLinkSecret(h, p.isk, own, peer)
            onEvent(SessionEvent.LocalLinked(secret, own.copyOf(), peer, stored.label, stored.cats))
        }
        r.close?.let { throw Fail(it.name) }
    }

    /** Run one event through the contact exchange and act on what it says. */
    private suspend fun exchangeStep(e: ExchangeEvent) {
        val x = xchg!!
        val offer = exchange!!
        val r = x.step(e)
        if (r.close != null) throw Fail(r.close.name)
        // CONFIRM is sent by confirmSas; only CONTACT is the exchange's to send.
        if ("CONTACT" in r.sends) emit(RecordType.CONTACT, buildContact(offer.agreeKey, offer.label, offer.cats))
        val stored = r.stored ?: return
        if (!x.waiting) contactDue = null
        val own = key32Bytes(offer.agreeKey)
        val peer = key32Bytes(stored.agreeKey)
        val d = nD
        val m = nM
        val h = hs
        if (own == null || peer == null || d == null || m == null || h == null) throw Fail(PeerCloseCode.peer_bad_frame.name)
        onEvent(SessionEvent.Contact(contactSecret(h.handshakeHash, d, m, own, peer), stored, r.pending))
    }

    private fun key32Bytes(text: String): ByteArray? = Base64Url.decodeStrict(text)?.takeIf { it.size == KEY_BYTES }

    /** The held initiator, established and not yet committed. */
    private fun canStartSas(): Boolean = holdSas && phase == "sas" && sasStep == 0 && nD == null

    private suspend fun commitSas() {
        val n = ports.random(SAS_NONCE_BYTES)
        nD = n
        emit(RecordType.SAS_COMMIT, sasBody(SasMember.c, sasCommit(n)))
        sasStep = 1
    }

    private suspend fun onSas(type: Int, body: ByteArray) {
        if (phase != "sas" || sasDone) throw Fail(PeerCloseCode.peer_bad_frame.name)
        val initiator = role == NoiseRole.initiator
        // Responder (the approver): COMMIT then REVEAL. Initiator (the device): NONCE.
        if (type == RecordType.SAS_COMMIT && !initiator && sasStep == 0) {
            val c = parseSasBody(SasMember.c, body) ?: throw Fail(PeerCloseCode.peer_bad_frame.name)
            // Mode v: the code deadline counts from D's choice, as D's does from [startSas]; a session held
            // while D's person looked at the list keeps its whole 120 s on this end too.
            if (mode == PeerMode.v) sasDue = mono() + SAS_DEADLINE_SECONDS
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
        // A peer's CLOSE ends the handshake: free its limiter slot and deadline (R-6K N5).
        settle()
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
        if (mode != PeerMode.a) throw Fail(PeerCloseCode.peer_not_allowed.name)
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
