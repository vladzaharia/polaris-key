// WIRE-CONTRACT-V5 section 15.6.1: the codecs and rules of mode v, the vouch (CC-15.K1). Pure: no I/O, no
// clock the caller does not hand in, no route. D is the device with no sign-in (the initiator); M is the
// signed-in device nearby (the responder). The vectors are `peer-matrix.json` `vouch`. Mirrors
// client-core's `peer/vouch.ts`.
//
// What lives here: the `VOUCH_REQ` body (build, parse, verify), the `VOUCH_RESULT` body, M's reading of
// the `nearby/approve` answer ([finishMap]), the number-matching decoys ([decoyCodes]), the approver's
// advert instance, the failure budget, and [VouchFlow], the order guard both ends run over the records
// of one session. What does not: the session itself ([PeerChannel]), the routes, the adverts' sockets and
// the prompt. Failures carry a close code and never a value: the request handle, `sig`, `h`, the nonces
// and the one-time keys appear in no message here.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceProof
import im.plrs.key.core.DeviceProofFields
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.Ed25519Strict
import im.plrs.key.core.StrictJson
import im.plrs.key.core.X25519Points
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.ByteBuffer

/** The capability both mode-v payloads list (rule 1). */
public const val VOUCH_CAP: String = "vouch/1"

/** A `VOUCH_REQ` body is at most this many bytes (rule 5). */
public const val VOUCH_REQ_MAX: Int = 4096

/** Rule 12: records D holds before its person confirms the account. */
public const val VOUCH_HELD_RECORDS: Int = 16
public const val VOUCH_HELD_BYTES: Int = 16 * 1024

/** Rule 2: the advert's listener and instance are renewed this often (seconds). */
public const val APPROVER_RENEW_SECONDS: Int = 300

/** Rule 2: this many prompted failures within the window stop the advert. */
public const val VOUCH_FAILURE_LIMIT: Int = 2
public const val VOUCH_FAILURE_WINDOW_SECONDS: Int = 600

private val REQUEST_RE = Regex("nr_[A-Za-z0-9_-]{22}")
private val DEVICE_RE = Regex("[A-Za-z0-9_-]{32}")
private const val KEY_CHARS = 43
private const val KEY_BYTES = 32
private const val CODE_RANGE = 1_000_000
private const val DECOYS = 3
private const val INSTANCE_BYTES = 10
private const val DRAW_BYTES = 4
private const val DRAW_SPAN = 1L shl 32
private const val DRAW_MASK = 0xffffffffL
private const val HTTP_OK = 200
private const val HTTP_NO_CONTENT = 204
private const val HTTP_FORBIDDEN = 403
private const val HTTP_NOT_FOUND = 404
private const val HTTP_CONFLICT = 409
private const val SYNC_FIRST = 0x0030
private const val SYNC_LAST = 0x003f

/** A canonical base64url of 32 bytes, decoded, or null. */
private fun key32(v: String?): ByteArray? {
    if (v == null || v.length != KEY_CHARS) return null
    return Base64Url.decodeStrict(v)?.takeIf { it.size == KEY_BYTES }
}

// -- VOUCH_REQ ------------------------------------------------------------------------------------

/** What D's `HELLO` showed (display data), as M holds it. */
public class VouchHello(public val label: String?, public val platform: String) {
    override fun toString(): String = "VouchHello"
}

/** A verified request: exactly what M sends to `nearby/approve` (rule 5). The handle is not in [toString]. */
public class VouchRequest(
    public val request: String,
    public val deviceId: String,
    public val signKey: String,
    public val agreeKey: String,
    public val label: String?,
    public val platform: String,
) {
    override fun equals(other: Any?): Boolean = other is VouchRequest &&
        request == other.request && deviceId == other.deviceId && signKey == other.signKey &&
        agreeKey == other.agreeKey && label == other.label && platform == other.platform

    override fun hashCode(): Int = listOf(request, deviceId, signKey, agreeKey, label, platform).hashCode()

    override fun toString(): String = "VouchRequest(redacted)"
}

/** The `VOUCH_REQ` body D sends after it showed the code (rule 5). Throws [IllegalArgumentException] on a malformed input. */
public suspend fun buildVouchRequest(
    port: DeviceKeyPort,
    slug: String,
    /** This session's Noise handshake hash. */
    h: ByteArray,
    /** The handle from `nearby/start`. */
    request: String,
    /** The `X-PKey-Device` value sent on `start`. */
    deviceId: String,
    /** The same `label` and `platform` D's `HELLO` carried. */
    hello: VouchHello,
): ByteArray {
    require(h.size == KEY_BYTES && REQUEST_RE.matches(request) && DEVICE_RE.matches(deviceId)) { "vouch request: bad input" }
    val proof = DeviceProofs.sign(port, DeviceProofPurpose.vouch, slug, deviceId, "${Base64Url.encode(h)}.$request")
    val keys = port.publicKeys()
    require(keys != null && keys.signKey == proof.signKey) { "vouch request: keys changed" }
    val members = LinkedHashMap<String, JsonElement>()
    members["v"] = JsonPrimitive(1)
    members["request"] = JsonPrimitive(request)
    members["deviceId"] = JsonPrimitive(deviceId)
    members["signKey"] = JsonPrimitive(keys.signKey)
    members["agreeKey"] = JsonPrimitive(keys.agreeKey)
    hello.label?.let { members["label"] = JsonPrimitive(it) }
    members["platform"] = JsonPrimitive(hello.platform)
    members["sig"] = JsonPrimitive(proof.sig)
    val body = JsonObject(members).toString().toByteArray(Charsets.UTF_8)
    require(body.size <= VOUCH_REQ_MAX) { "vouch request: too large" }
    return body
}

/** A `VOUCH_REQ` body that passed every check that needs no session (rule 5), signature unread. */
public class ParsedVouchRequest(
    public val request: String,
    public val deviceId: String,
    public val signKey: String,
    public val agreeKey: String,
    public val label: String?,
    public val platform: String,
    /** Unverified until [verifyVouchRequest]. */
    public val sig: String,
) {
    override fun toString(): String = "ParsedVouchRequest(redacted)"
}

/** Strict JSON, size, shape and key checks; null means close `peer_bad_frame`. */
public fun parseVouchRequest(body: ByteArray): ParsedVouchRequest? {
    if (body.size > VOUCH_REQ_MAX) return null
    val parsed = StrictJson.validate(body) ?: return null
    val o = parsed.value
    if (o["v"].longValue != 1L || "/v" in parsed.nonWireIntegers) return null
    val request = o["request"].stringValue?.takeIf { REQUEST_RE.matches(it) } ?: return null
    val deviceId = o["deviceId"].stringValue?.takeIf { DEVICE_RE.matches(it) } ?: return null
    val signKey = o["signKey"].stringValue
    val sk = key32(signKey) ?: return null
    if (!Ed25519Strict.isAcceptablePoint(sk)) return null
    val agreeKey = o["agreeKey"].stringValue
    val ak = key32(agreeKey) ?: return null
    if (!X25519Points.isAcceptableAgreeKey(ak)) return null
    val rawLabel = o["label"]
    if ("label" in o && rawLabel.stringValue == null) return null
    val platform = o["platform"].stringValue ?: return null
    val sig = o["sig"].stringValue ?: return null
    return ParsedVouchRequest(
        request = request,
        deviceId = deviceId,
        signKey = signKey!!,
        agreeKey = agreeKey!!,
        label = rawLabel.stringValue?.let(::cleanLabel),
        platform = cleanPlatform(platform),
        sig = sig,
    )
}

/**
 * M's whole check of a `VOUCH_REQ` (rule 5): the parse, the proof over this session's [h], and the equality
 * of `label` and `platform` with `HELLO`. Null means close `peer_bad_frame` and call no route.
 *
 * [helloCleaned]: [hello] is the `HELLO` the session already cleaned (what [PeerHello] carries): it is
 * compared as it is. Without this the label is cleaned again, and the cleaning is not idempotent (an
 * invisible mark between a base and a combining mark can change a second time), so an honest D would be
 * refused.
 */
public fun verifyVouchRequest(slug: String, h: ByteArray, hello: VouchHello, body: ByteArray, helloCleaned: Boolean = false): VouchRequest? {
    val p = parseVouchRequest(body) ?: return null
    val proof = DeviceProof(
        DeviceProofFields("vouch", slug, p.deviceId, "${Base64Url.encode(h)}.${p.request}", "-"),
        p.signKey,
        p.sig,
    )
    if (!DeviceProofs.verify(proof)) return null
    val helloLabel = when {
        hello.label == null -> null
        helloCleaned -> hello.label
        else -> cleanLabel(hello.label)
    }
    if (p.label != helloLabel) return null
    if (p.platform != cleanPlatform(hello.platform)) return null
    return VouchRequest(p.request, p.deviceId, p.signKey, p.agreeKey, p.label, p.platform)
}

// -- VOUCH_RESULT ---------------------------------------------------------------------------------

/** What `VOUCH_RESULT` says. */
public enum class VouchStatus { approved, denied, expired }

/** The `VOUCH_RESULT` body M sends. */
public fun buildVouchResult(status: VouchStatus): ByteArray = "{\"status\":\"${status.name}\"}".toByteArray(Charsets.UTF_8)

/** D's reading of a `VOUCH_RESULT` (rule 6). */
public sealed class VouchResultRead {
    /** A status. An unknown one reads as `denied`. */
    public class Status(public val status: VouchStatus) : VouchResultRead()

    /** A body that is not an object with a string `status`: close with [code]. */
    public class Refuse(public val code: PeerCloseCode) : VouchResultRead()
}

/** D's reading of a `VOUCH_RESULT` (rule 6): display data only. */
public fun parseVouchResult(body: ByteArray): VouchResultRead {
    val o = parseStrictObject(body)
    val s = o?.get("status").stringValue ?: return VouchResultRead.Refuse(PeerCloseCode.peer_bad_frame)
    return VouchResultRead.Status(VouchStatus.values().firstOrNull { it.name == s } ?: VouchStatus.denied)
}

// -- M reads the answer of nearby/approve ---------------------------------------------------------

/** The answer of `nearby/approve` as the host read it (rule 6). */
public class ApproveAnswer(
    /** The HTTP status, or null when there was no answer. */
    public val http: Int?,
    /** The body text, or null when none. */
    public val body: String?,
    /** M's fresh read: does discovery still name `nearby` and `nearbyApprove`? */
    public val discoveryNearby: Boolean,
    /** True once M already answered a `device_keys_required` by registering its keys. */
    public val keysRetried: Boolean = false,
) {
    override fun toString(): String = "ApproveAnswer(http=$http)"
}

/** What M does with the answer of `nearby/approve`. */
public sealed class FinishAction {
    /** Send this `VOUCH_RESULT`. After any status but `approved`, close `peer_bye`. */
    public class Send(public val status: VouchStatus) : FinishAction()

    /** Nothing yet: show the licence choice, or register keys (section 15.8), then call again. */
    public class Wait(public val what: String) : FinishAction() {
        public companion object {
            public const val CHOICE: String = "choice"
            public const val KEYS: String = "keys"
        }
    }

    /** Send nothing and close `peer_bye`; [stopAdvert] when discovery lost `nearby`. */
    public class Close(public val stopAdvert: Boolean) : FinishAction()
}

/** Rule 6's table. Anything it does not list closes. */
public fun finishMap(r: ApproveAnswer): FinishAction {
    fun stop(stopAdvert: Boolean = false): FinishAction = FinishAction.Close(stopAdvert)
    val http = r.http ?: return stop()
    val o = r.body?.let { parseStrictObject(it.toByteArray(Charsets.UTF_8)) }
    val code = o?.get("code").stringValue
    val status = o?.get("status").stringValue
    return when (http) {
        HTTP_OK -> when (status) {
            "approved" -> FinishAction.Send(VouchStatus.approved)
            "choose" -> FinishAction.Wait(FinishAction.Wait.CHOICE)
            else -> stop()
        }

        HTTP_NO_CONTENT -> FinishAction.Send(VouchStatus.denied)

        // D hears `denied` for both, so a session holder cannot tell which refusal an account hit.
        HTTP_FORBIDDEN -> if (code == "not_nearby" || code == "device_limit") FinishAction.Send(VouchStatus.denied) else stop()

        // The 404 is ambiguous (rule 6): `expired` only while discovery still names the routes.
        HTTP_NOT_FOUND -> if (r.discoveryNearby) FinishAction.Send(VouchStatus.expired) else stop(true)

        HTTP_CONFLICT -> when {
            code == "device_keys_required" -> if (r.keysRetried) stop() else FinishAction.Wait(FinishAction.Wait.KEYS)
            code == "license_choice_required" -> FinishAction.Wait(FinishAction.Wait.CHOICE)
            else -> stop()
        }

        else -> stop()
    }
}

// -- randomness: decoys, positions and the advert instance ----------------------------------------

/** Draws that may be rejected before a generator that cannot produce a value is given up on. */
private const val MAX_DRAWS = 256

private fun uniformBelow(n: Int, random: (Int) -> ByteArray): Int {
    val limit = (DRAW_SPAN / n) * n
    repeat(MAX_DRAWS) {
        val x = ByteBuffer.wrap(random(DRAW_BYTES)).int.toLong() and DRAW_MASK
        if (x < limit) return (x % n).toInt()
    }
    error("vouch: random source")
}

/** The three codes M shows (rule 4): [codes] has the real one at [index]. */
public class DecoyCodes(public val codes: List<Int>, public val index: Int) {
    override fun toString(): String = "DecoyCodes"
}

/**
 * The three codes M shows (rule 4): the session's [real] code and two decoys by rejection sampling,
 * distinct, and the real one at a uniform position by a partial Fisher-Yates shuffle.
 */
public fun decoyCodes(real: Int, random: (Int) -> ByteArray = NoisePorts.defaultRandom): DecoyCodes {
    require(real in 0 until CODE_RANGE) { "vouch: code" }
    val slots = ArrayList<Pair<Int, Boolean>>()
    slots += real to true
    var tries = 0
    // A source that keeps repeating a code is given up on, not looped on.
    while (slots.size < DECOYS) {
        check(tries++ < MAX_DRAWS) { "vouch: random source" }
        val code = uniformBelow(CODE_RANGE, random)
        if (slots.none { it.first == code }) slots += code to false
    }
    for (i in DECOYS - 1 downTo 1) {
        val j = uniformBelow(i + 1, random)
        val t = slots[i]
        slots[i] = slots[j]
        slots[j] = t
    }
    return DecoyCodes(slots.map { it.first }, slots.indexOfFirst { it.second })
}

/** The approver's advert instance (rule 2): `p1-` and 10 CSPRNG bytes in base32, 16 characters. */
public fun approverInstance(random: (Int) -> ByteArray = NoisePorts.defaultRandom): String = "p1-" + base32Lower(random(INSTANCE_BYTES))

// -- the failure budget (rule 2) ------------------------------------------------------------------

/**
 * M counts the failures of sessions whose prompt was shown (a wrong pick, "None of these match", a 120 s
 * timeout) against a monotonic clock. The second within 10 minutes stops the advert, and it stays stopped
 * until the person reopens "Approve a nearby device". A session that was only queued, or shown the passive
 * notice, counts for nothing: the caller does not report it.
 */
public class VouchFailureBudget(private val mono: () -> Double) {
    private val lock = Any()
    private var at = ArrayList<Double>()
    private var halted = false

    /** Record one failure; true when the advert must stop now. */
    public fun fail(): Boolean = synchronized(lock) {
        val now = mono()
        at = ArrayList(at.filter { now - it < VOUCH_FAILURE_WINDOW_SECONDS })
        at.add(now)
        if (at.size >= VOUCH_FAILURE_LIMIT) halted = true
        halted
    }

    /** True while the advert must stay off. */
    public val stopped: Boolean get() = synchronized(lock) { halted }

    /** The person reopened "Approve a nearby device": the count starts again. */
    public fun reopen(): Unit = synchronized(lock) {
        at = ArrayList()
        halted = false
    }

    override fun toString(): String = "VouchFailureBudget"
}

// -- the order guard (rules 1, 4, 5, 7, 8, 12) ----------------------------------------------------

/** A record the order guard looks at. */
public interface VouchRecord {
    public val type: Int
    public val body: ByteArray
}

/** The plain [VouchRecord]. */
public class VouchMessage(override val type: Int, override val body: ByteArray) : VouchRecord {
    override fun toString(): String = "VouchMessage(type=$type, ${body.size} bytes)"
}

/** What the guard says about one record. */
public sealed class VouchVerdict<out R : VouchRecord> {
    /** Records to hand on now: this one, or ones held earlier, in order. May be empty. */
    public class Ok<R : VouchRecord>(public val deliver: List<R>) : VouchVerdict<R>()

    /** Close the session with [close]. */
    public class Closed(public val close: PeerCloseCode) : VouchVerdict<Nothing>()
}

public enum class VouchRole { Requester, Approver }

public enum class AbandonReason { WrongPick, NoneMatch, Stop, Timeout }

private fun isSync(t: Int): Boolean = t in SYNC_FIRST..SYNC_LAST

/**
 * One end's order guard over the vouch records of one session. D is the [VouchRole.Requester], M the
 * [VouchRole.Approver]. Every record is checked in both directions: [receive] for what arrives, [send] for
 * what this end is about to send, with the same codes (rule 7). After a close verdict the flow is dead and
 * answers with that code again.
 *
 * - `VOUCH_REQ`: D to M, once, after D showed the code. M's flow holds it until the person's right pick
 *   ([picked]), so a wrong pick, "None of these match", a timeout or a stop ([abandon]) never delivers it.
 * - `VOUCH_RESULT`: M to D, at most once, after a verified `VOUCH_REQ`.
 * - `0x0030` to `0x003F`: M to D, only after an `approved` result; D holds them (16 records, 16 KiB, then
 *   `peer_busy`) until its person confirms the account ([confirmAccount], rule 12).
 *
 * No silent approval (rule 10): [mayFinish] is true only after the right pick and a verified request, which
 * is when `nearby/approve` may be called. Not thread-safe: the caller serialises its calls.
 */
public class VouchFlow<R : VouchRecord>(public val role: VouchRole) {
    private var dead: PeerCloseCode? = null
    private var negotiated = false
    private var shown = false
    private var pickedFlag = false
    private var requestSeen = false
    private var requestSent = false
    private var held: R? = null
    private var verifiedFlag = false
    private var resultSent = false
    private var resultSeen = false
    private var status: VouchStatus? = null
    private var confirmed = false
    private var queue = ArrayList<R>()
    private var queueBytes = 0

    private fun close(code: PeerCloseCode): VouchVerdict<R> {
        if (dead == null) dead = code
        held = null
        queue = ArrayList()
        queueBytes = 0
        return VouchVerdict.Closed(dead!!)
    }

    private fun gone(): VouchVerdict<R>? = dead?.let { VouchVerdict.Closed(it) }

    private fun ok(vararg r: R): VouchVerdict<R> = VouchVerdict.Ok(r.toList())

    /** Rule 1: both payloads list `vouch/1`; call once, when the session is `established`. */
    public fun negotiate(local: List<String>, remote: List<String>): VouchVerdict<R> {
        gone()?.let { return it }
        if (VOUCH_CAP !in capsIntersection(local, remote)) return close(PeerCloseCode.peer_not_allowed)
        negotiated = true
        return VouchVerdict.Ok(emptyList())
    }

    /** This side's screen shows the code (D: the code; M: the three codes). */
    public fun codeShown() {
        shown = true
    }

    /** M: the person picked the code D shows. Hands over the held request, if it arrived. */
    public fun picked(): VouchVerdict<R> {
        gone()?.let { return it }
        if (role != VouchRole.Approver || !negotiated || !shown) return close(PeerCloseCode.peer_not_allowed)
        pickedFlag = true
        val out = held?.let { listOf(it) } ?: emptyList()
        held = null
        return VouchVerdict.Ok(out)
    }

    /** M: the session ends before a right pick; the request is never delivered (rule 4). */
    public fun abandon(reason: AbandonReason): VouchVerdict<R> =
        close(if (reason == AbandonReason.Timeout) PeerCloseCode.peer_timeout else PeerCloseCode.peer_bye)

    /** M: the delivered request verified ([verifyVouchRequest]). */
    public fun verified() {
        if (pickedFlag && requestSeen) verifiedFlag = true
    }

    /** M: may `nearby/approve` be called for this session? (rule 10; N12) */
    public val mayFinish: Boolean
        get() = dead == null && verifiedFlag && !resultSent && role == VouchRole.Approver

    /** D: the person confirmed the signed-in account; held records are handed over (rule 12). */
    public fun confirmAccount(): VouchVerdict<R> {
        gone()?.let { return it }
        confirmed = true
        val out = queue
        queue = ArrayList()
        queueBytes = 0
        return VouchVerdict.Ok(out)
    }

    /** D: the person declined, or the screen timed out: every held record is dropped (rule 12). */
    public fun declineAccount(): VouchVerdict<R> = close(PeerCloseCode.peer_bye)

    /** A record arrived from the peer. */
    public fun receive(r: R): VouchVerdict<R> {
        gone()?.let { return it }
        return when {
            r.type == RecordType.VOUCH_REQ -> receiveRequest(r)
            r.type == RecordType.VOUCH_RESULT -> receiveResult(r)
            isSync(r.type) -> receiveSync(r)
            else -> ok(r)
        }
    }

    private fun receiveRequest(r: R): VouchVerdict<R> {
        if (role != VouchRole.Approver || !negotiated) return close(PeerCloseCode.peer_not_allowed)
        if (requestSeen) return close(PeerCloseCode.peer_bad_frame)
        requestSeen = true
        if (pickedFlag) return ok(r)
        held = r
        return VouchVerdict.Ok(emptyList())
    }

    private fun receiveResult(r: R): VouchVerdict<R> {
        if (role != VouchRole.Requester || !negotiated || !requestSent) return close(PeerCloseCode.peer_not_allowed)
        if (resultSeen) return close(PeerCloseCode.peer_bad_frame)
        val got = parseVouchResult(r.body)
        if (got is VouchResultRead.Refuse) return close(got.code)
        resultSeen = true
        status = (got as VouchResultRead.Status).status
        return ok(r)
    }

    private fun receiveSync(r: R): VouchVerdict<R> {
        if (role != VouchRole.Requester || !negotiated || status != VouchStatus.approved) return close(PeerCloseCode.peer_not_allowed)
        if (confirmed) return ok(r)
        if (queue.size >= VOUCH_HELD_RECORDS || queueBytes + r.body.size > VOUCH_HELD_BYTES) return close(PeerCloseCode.peer_busy)
        queue.add(r)
        queueBytes += r.body.size
        return VouchVerdict.Ok(emptyList())
    }

    /** This end is about to send a record. The sender's checks are the receiver's. */
    public fun send(r: R): VouchVerdict<R> {
        gone()?.let { return it }
        if (r.type == RecordType.VOUCH_REQ) {
            if (role != VouchRole.Requester || !negotiated || !shown) return close(PeerCloseCode.peer_not_allowed)
            if (requestSent) return close(PeerCloseCode.peer_bad_frame)
            requestSent = true
            return ok(r)
        }
        if (r.type == RecordType.VOUCH_RESULT) {
            if (role != VouchRole.Approver || !verifiedFlag) return close(PeerCloseCode.peer_not_allowed)
            if (resultSent) return close(PeerCloseCode.peer_bad_frame)
            val got = parseVouchResult(r.body)
            if (got is VouchResultRead.Refuse) return close(got.code)
            resultSent = true
            status = (got as VouchResultRead.Status).status
            return ok(r)
        }
        if (isSync(r.type)) {
            if (role != VouchRole.Approver || status != VouchStatus.approved) return close(PeerCloseCode.peer_not_allowed)
            return ok(r)
        }
        return ok(r)
    }

    override fun toString(): String = "VouchFlow($role)"
}
