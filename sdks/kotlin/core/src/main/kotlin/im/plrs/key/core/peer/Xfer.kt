// WIRE-CONTRACT-V5 section 15.11: Direct Transfer (`xfer/1`). The control-body codecs, the partial-file path
// and [XferMachine], one side of one session as a state machine. A machine does no I/O: it reads records,
// the host's calls and a clock, and answers each with an [XferOut] (records to send, questions for the host,
// effects on the kept partial files). [XferEndpoint] runs a machine over a session; the host API above it is
// the SDK's. Mirrors client-core's `peer/xfer.ts`; `peer-matrix.json` `xfer` is the conformance check.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.StrictJson
import im.plrs.key.core.cleanDisplayName
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonObject
import java.security.MessageDigest

/** A control body is at most this long. */
public const val XFER_MAX_CONTROL_BYTES: Int = 4096

/** The largest transfer, in bytes. */
public const val XFER_MAX_SIZE: Long = 1L shl 40
public const val XFER_DEFAULT_CHUNK: Int = 61_440
public const val XFER_MAX_CHUNK: Int = 65_492
public const val XFER_WINDOW: Int = 16
public const val XFER_ACK_EVERY: Int = 8
public const val XFER_MAX_TRANSFERS: Int = 4
public const val XFER_CONSENT_SECONDS: Double = 120.0
public const val XFER_IDLE_SECONDS: Double = 60.0
public const val XFER_PARTIAL_SECONDS: Double = 86_400.0
public const val XFER_MAX_PARTIALS_PER_PEER: Int = 8
public const val XFER_ENDED_IDS: Int = 64
public const val XFER_CHUNK_HEAD: Int = 24

/** The capability both handshake payloads list. */
public const val XFER_CAP: String = "xfer/1"

/** The six record types. */
public object XferType {
    public const val OFFER: Int = 0x0020
    public const val ACCEPT: Int = 0x0021
    public const val CHUNK: Int = 0x0022
    public const val ACK: Int = 0x0023
    public const val DONE: Int = 0x0024
    public const val CANCEL: Int = 0x0025
}

/** True for the six transfer record types. */
public fun isXferType(type: Int): Boolean = type in XferType.OFFER..XferType.CANCEL

/** The `CANCEL` reasons; the names are the wire's. */
public enum class XferReason {
    declined,
    cancelled,
    hash,
    size,
    category,
    busy,
    quota,
    timeout,
}

private val SHA_RE = Regex("[0-9a-f]{64}")
private val CAT_RE = Regex("[a-z0-9-]{1,32}")
private val TYPE_RE = Regex("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")
private val ID_RE = Regex("[A-Za-z0-9_-]{22}")
private const val HEX = "0123456789abcdef"
private const val NAME_MAX_BYTES = 255
private const val TYPE_MAX_BYTES = 127
private const val ID_BYTES = 16

/** Lower-case hex of [b]. */
public fun xferHex(b: ByteArray): String {
    val sb = StringBuilder(b.size * 2)
    for (x in b) {
        sb.append(HEX[(x.toInt() shr 4) and 0xf]).append(HEX[x.toInt() and 0xf])
    }
    return sb.toString()
}

private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

/** A transfer id: 22 canonical base64url characters of 16 bytes. */
public fun isXferId(v: String?): Boolean = v != null && ID_RE.matches(v) && Base64Url.isCanonical(v)

// -- control bodies -------------------------------------------------------------------------------------------

private class Control(val o: JsonObject, val nonWire: im.plrs.key.core.NonWireIntegers)

private fun control(body: ByteArray): Control? {
    if (body.size > XFER_MAX_CONTROL_BYTES) return null
    val s = StrictJson.validate(body) ?: return null
    return Control(s.value, s.nonWireIntegers)
}

/** An integer member in [min]..[max]: a number not written with a fraction or an exponent. */
private fun intOf(c: Control, name: String, min: Long, max: Long): Long? {
    val e = c.o[name] as? kotlinx.serialization.json.JsonPrimitive ?: return null
    if (e.isString || "/$name" in c.nonWire) return null
    val v = e.longValue ?: return null
    return if (v in min..max) v else null
}

private fun idOf(c: Control?): String? = c?.o?.get("id").stringValue?.takeIf { isXferId(it) }

/** An `OFFER` body. */
public class XferOfferBody(
    public val id: String,
    public val size: Long,
    public val sha256: String,
    public val chunk: Int,
    public val name: String? = null,
    public val type: String? = null,
    public val cat: String? = null,
) {
    override fun toString(): String = "XferOfferBody(size=$size)"
}

/** An `OFFER` body; [maxMessage] is the reader's own `HELLO` value. Null is a `peer_bad_frame`. */
public fun parseXferOffer(body: ByteArray, maxMessage: Long): XferOfferBody? {
    val c = control(body) ?: return null
    val id = idOf(c) ?: return null
    val name = c.o["name"]
    val type = c.o["type"]
    val cat = c.o["cat"]
    var nameS: String? = null
    var typeS: String? = null
    var catS: String? = null
    if (name != null) {
        nameS = name.stringValue ?: return null
        if (nameS.toByteArray(Charsets.UTF_8).size > NAME_MAX_BYTES) return null
    }
    if (type != null) {
        typeS = type.stringValue ?: return null
        if (typeS.toByteArray(Charsets.UTF_8).size > TYPE_MAX_BYTES || !TYPE_RE.matches(typeS)) return null
    }
    val size = intOf(c, "size", 0, XFER_MAX_SIZE) ?: return null
    val sha = c.o["sha256"].stringValue ?: return null
    if (!SHA_RE.matches(sha)) return null
    if (cat != null) {
        catS = cat.stringValue ?: return null
        if (!CAT_RE.matches(catS)) return null
    }
    val chunk = intOf(c, "chunk", 1, XFER_MAX_CHUNK.toLong()) ?: return null
    if (chunk + XFER_CHUNK_HEAD > maxMessage) return null
    return XferOfferBody(id, size, sha, chunk.toInt(), nameS, typeS, catS)
}

private fun q(s: String): String {
    val sb = StringBuilder("\"")
    for (ch in s) {
        when {
            ch == '"' -> sb.append("\\\"")
            ch == '\\' -> sb.append("\\\\")
            ch.code < 0x20 -> sb.append("\\u").append("%04x".format(ch.code))
            else -> sb.append(ch)
        }
    }
    return sb.append('"').toString()
}

private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

/** The sender's `OFFER` body. */
public fun xferOfferBody(o: XferOfferBody): ByteArray {
    val sb = StringBuilder("{\"id\":").append(q(o.id))
    if (o.name != null) sb.append(",\"name\":").append(q(o.name))
    if (o.type != null) sb.append(",\"type\":").append(q(o.type))
    sb.append(",\"size\":").append(o.size).append(",\"sha256\":").append(q(o.sha256))
    if (o.cat != null) sb.append(",\"cat\":").append(q(o.cat))
    return utf8(sb.append(",\"chunk\":").append(o.chunk).append('}').toString())
}

/** An `ACCEPT` or `ACK` body. */
public fun xferOffsetBody(id: String, offset: Long): ByteArray = utf8("{\"id\":${q(id)},\"offset\":$offset}")

/** A `DONE` body: with the hash toward the receiver, without it toward the sender. */
public fun xferDoneBody(id: String, sha256: String? = null): ByteArray =
    utf8(if (sha256 == null) "{\"id\":${q(id)}}" else "{\"id\":${q(id)},\"sha256\":${q(sha256)}}")

/** A `CANCEL` body. */
public fun xferCancelBody(id: String, reason: XferReason): ByteArray = utf8("{\"id\":${q(id)},\"reason\":${q(reason.name)}}")

/** A `CHUNK` body: `id(16) || u64be offset || data`. */
public fun xferChunkBody(id: String, offset: Long, data: ByteArray): ByteArray {
    val b = ByteArray(XFER_CHUNK_HEAD + data.size)
    Base64Url.decode(id)!!.copyInto(b, 0)
    for (i in 0 until 8) b[ID_BYTES + i] = (offset ushr (56 - 8 * i)).toByte()
    data.copyInto(b, XFER_CHUNK_HEAD)
    return b
}

/** The offer parameters an offset is judged against. */
public class XferParams(public val size: Long, public val chunk: Int)

private fun offsetOk(v: Long, p: XferParams, ack: Boolean): Boolean = v >= 0 && v <= p.size && (v % p.chunk == 0L || (ack && v == p.size))

/** An `ACCEPT` or `ACK` body, `{id, offset}`, judged against its `OFFER`. Null is a fault. */
public fun parseXferOffset(ack: Boolean, body: ByteArray, p: XferParams): Pair<String, Long>? {
    val c = control(body)
    val id = idOf(c) ?: return null
    val offset = intOf(c!!, "offset", 0, XFER_MAX_SIZE) ?: return null
    return if (offsetOk(offset, p, ack)) id to offset else null
}

/** A parsed `DONE`: [sha256] only toward the receiver. */
public class XferDone(public val id: String, public val sha256: String?)

/** A `DONE` body: `{id, sha256}` toward the receiver, `{id}` toward the sender. */
public fun parseXferDone(body: ByteArray, towardReceiver: Boolean): XferDone? {
    val c = control(body)
    val id = idOf(c) ?: return null
    val sha = c!!.o["sha256"]
    if (!towardReceiver) return if (sha == null) XferDone(id, null) else null
    val s = sha.stringValue
    return if (s != null && SHA_RE.matches(s)) XferDone(id, s) else null
}

private fun reasonOf(r: String): XferReason = XferReason.entries.firstOrNull { it.name == r } ?: XferReason.cancelled

/** A `CANCEL` body. A string outside the eight reasons reads as `cancelled`. */
public fun parseXferCancel(body: ByteArray): Pair<String, XferReason>? {
    val c = control(body)
    val id = idOf(c) ?: return null
    val r = c!!.o["reason"].stringValue ?: return null
    return id to reasonOf(r)
}

/** A parsed `CHUNK` head. */
public class XferChunkHead(public val id: String, public val offset: Long, public val length: Int)

/** A `CHUNK` body judged against its offer and the next offset the receiver [expect]s. */
public fun parseXferChunk(body: ByteArray, size: Long, chunk: Int, expect: Long): XferChunkHead? {
    if (body.size < XFER_CHUNK_HEAD) return null
    val id = Base64Url.encode(body.copyOfRange(0, ID_BYTES))
    var at = 0L
    for (i in 0 until 8) at = (at shl 8) or (body[ID_BYTES + i].toLong() and 0xff)
    val length = body.size - XFER_CHUNK_HEAD
    if (length == 0 || length > chunk || at != expect) return null
    if (expect + length > size) return null
    if (length < chunk && expect + length != size) return null
    return XferChunkHead(id, expect, length)
}

/** The partial file's name (section 15.11 "The name is display data"): derived from the resume key only. */
public fun xferPartialPath(key: ByteArray, id: String, sha256: String): String {
    val d = MessageDigest.getInstance("SHA-256")
    d.update(utf8("pkey-xfer/1 partial"))
    d.update(0)
    d.update(key)
    d.update(Base64Url.decode(id)!!)
    d.update(unhex(sha256))
    return xferHex(d.digest())
}

// -- the machine's vocabulary -------------------------------------------------------------------------------

/** A kept partial file of the peer key (section 15.11 "Resume"). */
public data class XferPartial(
    /** The store's name for it: [xferPartialPath] for the key, the transfer id and the hash. */
    val ref: String,
    val id: String,
    val sha256: String,
    val size: Long,
    val chunk: Int,
    /** Bytes on disk. */
    val bytes: Long,
    /** Seconds (the machine's clock) of the last write. */
    val writtenAt: Double,
    /** A live transfer in another session holds it. */
    val held: Boolean = false,
    /** Bytes re-read and hashed since the session began; default [bytes]. A receiver never offers an offset it has not re-read. */
    val reread: Long? = null,
)

/** What the host is asked about an `OFFER`. [name] is already cleaned display data. */
public class XferAsk(
    public val id: String,
    public val size: Long,
    public val name: String? = null,
    public val type: String? = null,
    public val cat: String? = null,
) {
    override fun toString(): String = "XferAsk(size=$size)"
}

/** How the host answers an offer. */
public enum class XferAnswer { accept, decline, ask }

/** The host's handler, answering at once or `ask` for an answer later through `consent`. */
public fun interface XferHandler {
    public fun answer(ask: XferAsk): XferAnswer
}

/** A record the machine wants sent. */
public sealed class XferSend {
    public class Offer(
        public val id: String,
        public val size: Long,
        public val chunk: Int,
        public val sha256: String,
        public val cat: String?,
        public val name: String?,
        public val type: String?,
    ) : XferSend()

    public class Accept(public val id: String, public val offset: Long) : XferSend()

    /** The consecutive `CHUNK` records one step sends: `chunk` bytes each, the last the remainder. */
    public class Chunks(public val id: String, public val offset: Long, public val bytes: Long) : XferSend()
    public class Ack(public val id: String, public val offset: Long) : XferSend()
    public class Done(public val id: String, public val sha256: String?) : XferSend()
    public class Cancel(public val id: String, public val reason: XferReason) : XferSend()
}

/** A store refused a create or truncate for want of room: the endpoint cancels that one transfer with `quota`. */
public class XferNoRoomException(message: String) : java.io.IOException(message)

/** An effect on the kept partial files, or bytes for one; the driver applies them in order. */
public sealed class XferEffect {
    /** A new partial; [partial] is its record (the id, hash, size and chunk the store keeps beside it). */
    public class Create(public val ref: String, public val partial: XferPartial) : XferEffect()
    public class Truncate(public val ref: String, public val to: Long) : XferEffect()
    public class Discard(public val ref: String) : XferEffect()
    public class Evict(public val ref: String) : XferEffect()
    public class Keep(public val ref: String) : XferEffect()
    public class Delete(public val ref: String) : XferEffect()

    /** The transfer [id] is complete: the store moves the partial to where the host chose. */
    public class Finalize(public val ref: String, public val id: String) : XferEffect()
    public class Write(public val ref: String, public val offset: Long, public val data: ByteArray) : XferEffect()
}

/** How a transfer ended. */
public sealed class XferResult {
    public abstract val id: String

    public class Delivered(override val id: String) : XferResult()
    public class Cancelled(override val id: String, public val reason: XferReason) : XferResult()
    public class Closed(override val id: String) : XferResult()
}

/** What one machine step produced. */
public class XferOut {
    public val send: MutableList<XferSend> = ArrayList()
    public var close: PeerCloseCode? = null
    public var ask: XferAsk? = null
    public val withdraw: MutableList<String> = ArrayList()
    public val results: MutableList<XferResult> = ArrayList()
    public val partial: MutableList<XferEffect> = ArrayList()

    /** The host's own send was refused locally: too many live transfers. */
    public var refused: Boolean = false

    /** A late record for an ended id, dropped without effect. */
    public var drop: Boolean = false
}

/** What a machine needs to know. */
public class XferMachineOptions(
    /** The session's mode: transfers run in `a` and `c` only. */
    public val mode: RecordMode,
    /** The session's capabilities (the intersection of both payloads). */
    public val caps: List<String>,
    /** This side's own `HELLO` `maxMessage`. */
    public val maxMessage: Long,
    /** The remote static key: 32 raw bytes. */
    public val peerKey: ByteArray,
    /** No handler: every `OFFER` is declined. */
    public val handler: XferHandler?,
    public val hostLimit: Long? = null,
    /** Bytes the store can still take; null for unlimited. */
    public val free: (() -> Long?)? = null,
    /** The link's categories (mode c). */
    public val categories: List<String> = emptyList(),
    /** The kept partials of this peer key. */
    public val partials: List<XferPartial> = emptyList(),
    /**
     * A hasher fed with the first `offset` bytes of a kept partial, which the store has re-read. Without it a
     * resume starts at 0.
     */
    public val rehash: ((ref: String, offset: Long) -> MessageDigest)? = null,
    /** A name for a new partial file; default [xferPartialPath]. */
    public val newRef: ((id: String, sha256: String) -> String)? = null,
    /** The window is judged from the last `ACK` actually sent; set when `ACK`s are held back. */
    public val withholdAcks: Boolean = false,
)

/** The host's offer arguments. */
public class XferOfferArgs(
    public val id: String,
    public val size: Long,
    public val chunk: Int,
    public val sha256: String,
    public val cat: String? = null,
    public val name: String? = null,
    public val type: String? = null,
    /** False when the source cannot restart at an `ACCEPT` offset above 0. */
    public val seekable: Boolean = true,
)

private enum class Dir { `in`, out }
private enum class St { asking, offered, active, doneSent }

private class Tr(val id: String, val dir: Dir, val size: Long, val chunk: Int, val sha: String, var since: Double) {
    var st = St.asking
    var recv = 0L
    var sinceAck = 0
    var ackedEnd = 0L
    var hash: MessageDigest? = null
    var partial: String? = null
    var accepted = false
    var sentEnd = 0L
    var ackEnd = 0L
    var seekable = true
    var full = false
}

private class Ended(val id: String, val dir: Dir, var cancelledHere: Boolean)

/** One side of one session. Not thread-safe: the endpoint serialises its calls. */
public class XferMachine(private val o: XferMachineOptions) {
    private val tr = LinkedHashMap<String, Tr>()
    private val ended = ArrayList<Ended>()
    private var closed = false
    private var parts: MutableList<XferPartial> = o.partials.toMutableList()
    private var clock = 0.0
    private var out = XferOut()

    init {
        require(o.peerKey.size == 32) { "peerKey" }
    }

    /** The kept partials now (a new session starts from these with `held` cleared). */
    public fun partials(): List<XferPartial> = parts.toList()

    /** The number of live transfers. */
    public val live: Int get() = tr.size

    /** The clock value at which the next wait runs out, or null when none is running. */
    public fun nextDeadline(): Double? {
        var best: Double? = null
        for (t in tr.values) {
            val lim = limit(t) ?: continue
            val at = t.since + lim
            if (best == null || at < best) best = at
        }
        return best
    }

    // -- events ----------------------------------------------------------------------------------------------

    /** Only the clock moves. */
    public fun tick(at: Double): XferOut = begin(at) {}

    /** A record the session read: one of the six xfer types, with [more] its flag. */
    public fun receive(at: Double, type: Int, body: ByteArray, more: Boolean = false): XferOut = begin(at) { onRecord(type, body, more) }

    /** The host sends: `OFFER`. */
    public fun offer(at: Double, a: XferOfferArgs): XferOut {
        require(isXferId(a.id) && a.size in 0..XFER_MAX_SIZE && a.chunk in 1..XFER_MAX_CHUNK && SHA_RE.matches(a.sha256)) { "offer" }
        require(!tr.containsKey(a.id) && ended.none { it.id == a.id }) { "transfer id already used" }
        return begin(at) {
            if (tr.size >= XFER_MAX_TRANSFERS) {
                out.refused = true
                return@begin
            }
            val t = newTr(a.id, Dir.out, a.size, a.chunk, a.sha256)
            t.st = St.offered
            t.seekable = a.seekable
            tr[t.id] = t
            send(XferSend.Offer(a.id, a.size, a.chunk, a.sha256, a.cat, a.name, a.type))
        }
    }

    /** The host's answer to an `ask`. */
    public fun consent(at: Double, id: String, accept: Boolean): XferOut = begin(at) {
        val t = tr[id]
        if (t == null || t.st != St.asking) return@begin
        if (!accept) {
            send(XferSend.Cancel(id, XferReason.declined))
            end(t, true)
            return@begin
        }
        accept(t)
    }

    /**
     * The host's room check failed when the person accepted: `CANCEL` `quota` for that one transfer, and the
     * session stays. A partial this transfer made at 0 bytes goes; one with bytes kept stays.
     */
    public fun noRoom(at: Double, id: String): XferOut = begin(at) {
        val t = tr[id] ?: return@begin
        if (t.dir != Dir.`in` || (t.st != St.asking && !t.accepted)) return@begin
        send(XferSend.Cancel(id, XferReason.quota))
        val p = parts.firstOrNull { it.ref == t.partial }
        if (p != null && p.bytes == 0L) {
            eff(XferEffect.Discard(p.ref))
            parts.removeAll { it.ref == p.ref }
        }
        end(t, true)
    }

    /** The host cancels a transfer. */
    public fun cancel(at: Double, id: String): XferOut = begin(at) {
        val t = tr[id] ?: return@begin
        // After its DONE a sender sends no CANCEL other than timeout.
        if (t.dir == Dir.out && t.st == St.doneSent) return@begin
        send(XferSend.Cancel(id, XferReason.cancelled))
        val p = t.partial
        if (t.st == St.asking) {
            out.withdraw += id
        } else if (t.dir == Dir.`in` && p != null) {
            eff(XferEffect.Delete(p))
        }
        result(t, XferResult.Cancelled(id, XferReason.cancelled))
        end(t, true)
    }

    /** The host's source failed before the transfer's `DONE` went out: cancel an outgoing transfer in any state. */
    public fun fail(at: Double, id: String): XferOut = begin(at) {
        val t = tr[id]
        if (t == null || t.dir != Dir.out) return@begin
        send(XferSend.Cancel(id, XferReason.cancelled))
        result(t, XferResult.Cancelled(id, XferReason.cancelled))
        end(t, true)
    }

    /** The session ended. Does nothing when a fault already ended it; see [abandon]. */
    public fun close(at: Double): XferOut {
        if (closed) return XferOut()
        return begin(at) { shutdown() }
    }

    /** The session closed (for any reason): report every live transfer `closed` and keep the partials. Idempotent. */
    public fun abandon(at: Double): XferOut {
        out = XferOut()
        clock = at
        shutdown()
        closed = true
        return out
    }

    /** A new session on the same machine keeps the partials, none held and none re-read. */
    public fun newSession(at: Double): XferOut {
        out = XferOut()
        clock = at
        tr.clear()
        ended.clear()
        closed = false
        parts = parts.map { it.copy(reread = null, held = false) }.toMutableList()
        return out
    }

    // -- internals -------------------------------------------------------------------------------------------

    private fun begin(at: Double, fn: () -> Unit): XferOut {
        out = XferOut()
        if (closed) return out
        clock = at
        expire(at)
        fn()
        return out
    }

    private fun shutdown() {
        for (t in tr.values) {
            val p = t.partial
            if (t.st == St.asking) {
                out.withdraw += t.id
            } else if (t.dir == Dir.`in` && p != null) {
                eff(XferEffect.Keep(p))
            }
            result(t, XferResult.Closed(t.id))
        }
        tr.clear()
        closed = true
    }

    private fun send(s: XferSend) {
        out.send += s
    }

    private fun eff(e: XferEffect) {
        out.partial += e
        val gone = when (e) {
            is XferEffect.Delete -> e.ref
            is XferEffect.Finalize -> e.ref
            else -> null
        }
        if (gone != null) parts.removeAll { it.ref == gone }
    }

    private fun fault() {
        out.close = PeerCloseCode.peer_bad_frame
        closed = true
    }

    /** A transfer the host was never told about (still asking) reports no result. */
    private fun result(t: Tr, r: XferResult) {
        if (t.st == St.asking) return
        out.results += r
    }

    private fun remember(id: String, dir: Dir, cancelledHere: Boolean) {
        ended += Ended(id, dir, cancelledHere)
        while (ended.size > XFER_ENDED_IDS) ended.removeAt(0)
    }

    private fun end(t: Tr, cancelledHere: Boolean) {
        tr.remove(t.id)
        remember(t.id, t.dir, cancelledHere)
    }

    private fun newTr(id: String, dir: Dir, size: Long, chunk: Int, sha: String) = Tr(id, dir, size, chunk, sha, clock)

    // -- the clock -------------------------------------------------------------------------------------------

    /** Seconds this transfer may wait in its current state; null while nothing is awaited. */
    private fun limit(t: Tr): Double? {
        if (t.dir == Dir.`in`) return if (t.st == St.asking) XFER_CONSENT_SECONDS else XFER_IDLE_SECONDS
        if (t.st == St.offered) return XFER_CONSENT_SECONDS + XFER_IDLE_SECONDS
        if (t.st == St.doneSent) return XFER_IDLE_SECONDS
        return if (t.full) XFER_IDLE_SECONDS else null
    }

    /** Every wait that ran out by [at] ends with `CANCEL timeout`; the partial is kept. */
    private fun expire(at: Double) {
        for (t in tr.values.toList()) {
            val lim = limit(t)
            if (lim == null || at - t.since < lim) continue
            send(XferSend.Cancel(t.id, XferReason.timeout))
            val p = t.partial
            if (t.st == St.asking) {
                out.withdraw += t.id
            } else if (t.dir == Dir.`in` && p != null) {
                eff(XferEffect.Keep(p))
            }
            result(t, XferResult.Cancelled(t.id, XferReason.timeout))
            end(t, true)
        }
    }

    // -- records ---------------------------------------------------------------------------------------------

    private fun onRecord(type: Int, body: ByteArray, more: Boolean) {
        // Step 1: the mode and the capability.
        if ((o.mode != RecordMode.a && o.mode != RecordMode.c) || XFER_CAP !in o.caps) {
            out.close = PeerCloseCode.peer_not_allowed
            closed = true
            return
        }
        if (more || !isXferType(type)) return fault()
        if (type == XferType.OFFER) return onOffer(body)
        if (type == XferType.CHUNK) return onChunk(body)
        val c = control(body)
        val id = idOf(c)
        if (c == null || id == null) return fault()
        // The generic member checks, before the id is looked up.
        var offset = 0L
        var sha: String? = null
        var reason = XferReason.cancelled
        when (type) {
            XferType.ACCEPT, XferType.ACK -> offset = intOf(c, "offset", 0, XFER_MAX_SIZE) ?: return fault()

            XferType.DONE -> {
                val e = c.o["sha256"]
                if (e != null) {
                    val s = e.stringValue
                    if (s == null || !SHA_RE.matches(s)) return fault()
                    sha = s
                }
            }

            else -> reason = reasonOf(c.o["reason"].stringValue ?: return fault())
        }
        val t = tr[id] ?: return late(id, type, sha)
        when (type) {
            XferType.ACCEPT -> onAccept(t, offset)
            XferType.ACK -> onAck(t, offset)
            XferType.DONE -> onDone(t, sha)
            else -> onCancel(t, reason)
        }
    }

    /** A record for an id that is not live: dropped when remembered, else a fault. */
    private fun late(id: String, type: Int, sha: String?) {
        val e = ended.firstOrNull { it.id == id } ?: return fault()
        if (type == XferType.DONE && e.dir == Dir.out && e.cancelledHere && sha == null) {
            out.results += XferResult.Delivered(id)
            e.cancelledHere = false
            return
        }
        out.drop = true
    }

    private fun onOffer(body: ByteArray) {
        val f = parseXferOffer(body, o.maxMessage) ?: return fault()
        if (tr.containsKey(f.id) || ended.any { it.id == f.id }) return fault()
        val t = newTr(f.id, Dir.`in`, f.size, f.chunk, f.sha256)
        fun refuse(reason: XferReason) {
            send(XferSend.Cancel(f.id, reason))
            remember(f.id, Dir.`in`, true)
        }
        // Step 4: busy.
        val kept = parts.firstOrNull { it.id == f.id && it.sha256 == f.sha256 }
        if (tr.size >= XFER_MAX_TRANSFERS || tr.values.any { it.st == St.asking } || kept?.held == true) return refuse(XferReason.busy)
        // Step 5: the category, before the person is asked.
        if (o.mode == RecordMode.c && (f.cat == null || f.cat !in o.categories)) return refuse(XferReason.category)
        // Step 6: size and quota; a resume counts only the bytes still to come.
        val limit = o.hostLimit
        if (limit != null && f.size > limit) return refuse(XferReason.size)
        val free = o.free?.invoke()
        val need = f.size - if (resumable(f.size, f.chunk, kept)) kept!!.bytes else 0L
        if (free != null && need > free) return refuse(XferReason.quota)
        // Step 7: consent.
        val shown = if (f.name == null) null else cleanDisplayName(f.name)
        val ask = XferAsk(f.id, f.size, shown, f.type, f.cat)
        val answer = o.handler?.answer(ask) ?: XferAnswer.decline
        if (answer == XferAnswer.decline) return refuse(XferReason.declined)
        tr[t.id] = t
        if (answer == XferAnswer.ask) {
            out.ask = ask
            return
        }
        accept(t)
    }

    private fun resumable(size: Long, chunk: Int, p: XferPartial?): Boolean =
        p != null && p.size == size && p.chunk == chunk && clock - p.writtenAt <= XFER_PARTIAL_SECONDS

    /**
     * Step 8: the resume lookup, then `ACCEPT`. A kept partial the store can no longer read back (gone, or shorter
     * than it said) is not resumed: the transfer starts again at 0 on a fresh file.
     */
    private fun accept(t: Tr) {
        val mi = parts.indexOfFirst { it.id == t.id && it.sha256 == t.sha }
        val m = if (mi >= 0) parts[mi] else null
        var offset = 0L
        var hash: MessageDigest? = null
        var resumed = false
        if (m != null && resumable(t.size, t.chunk, m)) {
            val read = minOf(m.reread ?: m.bytes, m.bytes)
            val want = minOf(read / t.chunk * t.chunk, t.size)
            val rehash = o.rehash
            if (rehash != null && want > 0) {
                hash = try {
                    rehash(m.ref, want)
                } catch (e: Exception) {
                    // Whatever the store says, the transfer starts again from 0.
                    null
                }
                if (hash != null) offset = want
            }
            resumed = rehash == null || want == 0L || hash != null
        }
        if (resumed && m != null) {
            t.partial = m.ref
            eff(XferEffect.Truncate(m.ref, offset))
            parts[mi] = m.copy(bytes = offset, writtenAt = clock, reread = null)
        } else {
            if (m != null) {
                eff(XferEffect.Discard(m.ref))
                parts.removeAt(mi)
            }
            if (t.size > 0) startPartial(t)
        }
        t.hash = hash ?: MessageDigest.getInstance("SHA-256")
        t.recv = offset
        t.ackedEnd = offset
        t.st = St.active
        t.accepted = true
        t.since = clock
        send(XferSend.Accept(t.id, offset))
    }

    /** A new partial for [t]; at the limit the oldest one that no live transfer holds is evicted first. */
    private fun startPartial(t: Tr) {
        if (parts.size >= XFER_MAX_PARTIALS_PER_PEER) {
            val oldest = parts.filter { !it.held }.minByOrNull { it.writtenAt }
            if (oldest != null) {
                eff(XferEffect.Evict(oldest.ref))
                parts.remove(oldest)
            }
        }
        val ref = o.newRef?.invoke(t.id, t.sha) ?: xferPartialPath(o.peerKey, t.id, t.sha)
        val rec = XferPartial(ref, t.id, t.sha, t.size, t.chunk, 0, clock)
        eff(XferEffect.Create(ref, rec))
        parts += rec
        t.partial = ref
    }

    private fun onAccept(t: Tr, offset: Long) {
        if (t.dir != Dir.out || t.accepted || t.st != St.offered) return fault()
        if (!offsetOk(offset, XferParams(t.size, t.chunk), false)) return fault()
        t.accepted = true
        if (offset > 0 && !t.seekable) {
            send(XferSend.Cancel(t.id, XferReason.cancelled))
            result(t, XferResult.Cancelled(t.id, XferReason.cancelled))
            end(t, true)
            return
        }
        t.st = St.active
        t.sentEnd = offset
        t.ackEnd = offset
        t.since = clock
        pump(t, true)
    }

    /** The sender sends what the window allows, then `DONE` once the last byte is out. */
    private fun pump(t: Tr, first: Boolean) {
        val from = t.sentEnd
        val room = XFER_WINDOW.toLong() * t.chunk - (t.sentEnd - t.ackEnd)
        val upTo = minOf(t.size, t.sentEnd + maxOf(0L, room))
        var end = t.sentEnd
        while (end < upTo) end = minOf(t.size, end + t.chunk)
        if (end > from) {
            send(XferSend.Chunks(t.id, from, end - from))
            t.sentEnd = end
        }
        if (t.sentEnd == t.size) {
            send(XferSend.Done(t.id, t.sha))
            t.st = St.doneSent
            t.full = false
            t.since = clock
            return
        }
        // The idle wait for an `ACK` starts when the window fills, and again on progress.
        val full = t.sentEnd - t.ackEnd >= XFER_WINDOW.toLong() * t.chunk
        if (full && (!t.full || end > from || first)) t.since = clock
        t.full = full
    }

    private fun onAck(t: Tr, offset: Long) {
        if (t.dir != Dir.out || !t.accepted) return fault()
        if (offset < t.ackEnd || offset > t.sentEnd || !offsetOk(offset, XferParams(t.size, t.chunk), true)) return fault()
        t.ackEnd = offset
        if (t.st == St.active) pump(t, false)
    }

    private fun onChunk(body: ByteArray) {
        if (body.size < XFER_CHUNK_HEAD) return fault()
        val id = Base64Url.encode(body.copyOfRange(0, ID_BYTES))
        val t = tr[id] ?: return late(id, XferType.CHUNK, null)
        if (t.dir != Dir.`in` || t.st != St.active) return fault()
        val v = parseXferChunk(body, t.size, t.chunk, t.recv) ?: return fault()
        // The window: more than `XFER_WINDOW` chunks past the last `ACK` this side sent.
        if (v.offset + v.length - t.ackedEnd > XFER_WINDOW.toLong() * t.chunk) return fault()
        val data = body.copyOfRange(XFER_CHUNK_HEAD, body.size)
        val end = v.offset + v.length
        t.hash!!.update(data)
        val offset = t.recv
        t.recv = end
        t.sinceAck += 1
        t.since = clock
        val pi = parts.indexOfFirst { it.ref == t.partial }
        if (pi >= 0) {
            parts[pi] = parts[pi].copy(bytes = end, writtenAt = clock)
            out.partial += XferEffect.Write(parts[pi].ref, offset, data)
        }
        if (t.sinceAck >= XFER_ACK_EVERY || end == t.size) {
            t.sinceAck = 0
            if (!o.withholdAcks) {
                send(XferSend.Ack(t.id, end))
                t.ackedEnd = end
            }
        }
    }

    private fun onDone(t: Tr, sha: String?) {
        if (t.dir == Dir.out) {
            // A `DONE` toward the sender carries no hash, and only follows its own `DONE`.
            if (sha != null || t.st != St.doneSent) return fault()
            result(t, XferResult.Delivered(t.id))
            end(t, false)
            return
        }
        if (sha == null || t.st != St.active) return fault()
        fun cancel(reason: XferReason) {
            send(XferSend.Cancel(t.id, reason))
            t.partial?.let { eff(XferEffect.Delete(it)) }
            result(t, XferResult.Cancelled(t.id, reason))
            end(t, true)
        }
        if (t.recv < t.size) return cancel(XferReason.size)
        if (sha != t.sha || xferHex(t.hash!!.digest()) != t.sha) return cancel(XferReason.hash)
        send(XferSend.Done(t.id, null))
        t.partial?.let { eff(XferEffect.Finalize(it, t.id)) }
        result(t, XferResult.Delivered(t.id))
        end(t, false)
    }

    private fun onCancel(t: Tr, reason: XferReason) {
        val p = t.partial
        if (t.st == St.asking) {
            out.withdraw += t.id
        } else if (t.dir == Dir.`in` && p != null) {
            eff(if (reason == XferReason.timeout) XferEffect.Keep(p) else XferEffect.Delete(p))
        }
        result(t, XferResult.Cancelled(t.id, reason))
        end(t, false)
    }
}
