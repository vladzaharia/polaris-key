// WIRE-CONTRACT-V5 section 15.6: records inside one Noise transport plaintext
// (`u16be type || u8 flags || body`), the type table, MORE reassembly and the order of checks
// (CC-12.8; the byte layer's records half, which CC-12.3 left out). Mirrors client-core's
// `peer/record.ts`.

package im.plrs.key.core.peer

/** The largest message, reassembled from its records. */
public const val MAX_PEER_MESSAGE_BYTES: Int = 1_048_576

private const val NOISE_MAX = 65535
private const val TAG_BYTES = 16
private const val HEADER_BYTES = 3
private const val BYTE = 0xff
private const val SHIFT = 8
private const val MORE = 1
private const val CRITICAL = 0x8000
private const val RESERVED_FLAGS = 0xfe

/** A record body is at most this long: a Noise message less its tag and the three header bytes. */
public const val MAX_RECORD_BODY: Int = NOISE_MAX - TAG_BYTES - HEADER_BYTES

/** Records in one MORE chain: a full message in the smallest records, plus one. */
public const val MAX_CHAIN_RECORDS: Int = (MAX_PEER_MESSAGE_BYTES + MAX_RECORD_BODY - 1) / MAX_RECORD_BODY + 1

/** The channel modes a record table distinguishes (`c` is the content-key channel). */
public enum class RecordMode { a, v, p, c }

/** Why a session closes. The names are the wire's. */
public enum class PeerCloseCode {
    peer_revoked,
    peer_expired,
    peer_bad_frame,
    peer_unknown_critical,
    peer_not_allowed,
    peer_busy,
    peer_timeout,
    peer_bye,
}

/** The record types. */
public object RecordType {
    public const val HELLO: Int = 0x8001
    public const val RING: Int = 0x0002
    public const val TRUST: Int = 0x0003
    public const val PING: Int = 0x0004
    public const val PONG: Int = 0x0005
    public const val CANDIDATES: Int = 0x0006
    public const val VOUCH_REQ: Int = 0x8010
    public const val VOUCH_RESULT: Int = 0x8011
    public const val CONFIRM: Int = 0x8012
    public const val CONTACT: Int = 0x0013
    public const val SAS_COMMIT: Int = 0x8014
    public const val SAS_NONCE: Int = 0x8015
    public const val SAS_REVEAL: Int = 0x8016
    public const val REKEY: Int = 0x80fe
    public const val CLOSE: Int = 0x80ff
}

private class TypeRow(val from: Int, val to: Int, val modes: Set<RecordMode>, val bodyLen: Int? = null)

private val ALL = RecordMode.values().toSet()
private val A = setOf(RecordMode.a)
private val V = setOf(RecordMode.v)
private val P = setOf(RecordMode.p)
private val VP = setOf(RecordMode.v, RecordMode.p)
private val AC = setOf(RecordMode.a, RecordMode.c)

private val TYPES = listOf(
    TypeRow(0x8001, 0x8001, ALL),
    TypeRow(0x0002, 0x0002, A),
    TypeRow(0x0003, 0x0003, A),
    TypeRow(0x0004, 0x0004, ALL, 8),
    TypeRow(0x0005, 0x0005, ALL, 8),
    TypeRow(0x0006, 0x0006, A),
    TypeRow(0x8010, 0x8010, V),
    TypeRow(0x8011, 0x8011, V),
    TypeRow(0x8012, 0x8012, P),
    TypeRow(0x0013, 0x0013, P),
    TypeRow(0x8014, 0x8016, VP),
    TypeRow(0x0020, 0x0025, AC),
    TypeRow(0x0030, 0x003f, V),
    TypeRow(0x0100, 0x7fff, AC),
    TypeRow(0x8100, 0xfffd, AC),
    TypeRow(0x80fe, 0x80fe, ALL, 0),
    TypeRow(0x80ff, 0x80ff, ALL),
)

/** One record. */
public class PeerRecord(public val type: Int, public val flags: Int, public val body: ByteArray) {
    override fun toString(): String = "PeerRecord(type=$type, ${body.size} bytes)"
}

/**
 * A record from a Noise plaintext; null (the session closes with `peer_bad_frame`) when it is
 * shorter than the three header bytes or sets a flag bit other than `MORE`.
 */
public fun parseRecord(plain: ByteArray): PeerRecord? {
    if (plain.size < HEADER_BYTES || (plain[2].toInt() and RESERVED_FLAGS) != 0) return null
    val type = ((plain[0].toInt() and BYTE) shl SHIFT) or (plain[1].toInt() and BYTE)
    return PeerRecord(type, plain[2].toInt() and BYTE, plain.copyOfRange(HEADER_BYTES, plain.size))
}

/** The plaintext of [r]. */
public fun encodeRecord(r: PeerRecord): ByteArray {
    val out = ByteArray(HEADER_BYTES + r.body.size)
    out[0] = (r.type shr SHIFT).toByte()
    out[1] = (r.type and BYTE).toByte()
    out[2] = r.flags.toByte()
    r.body.copyInto(out, HEADER_BYTES)
    return out
}

/** A message split into records, `MORE` on all but the last. */
public fun splitMessage(type: Int, body: ByteArray): List<ByteArray> {
    require(body.size <= MAX_PEER_MESSAGE_BYTES) { "message size" }
    val out = ArrayList<ByteArray>()
    var at = 0
    do {
        val end = minOf(body.size, at + MAX_RECORD_BODY)
        out += encodeRecord(PeerRecord(type, if (end < body.size) MORE else 0, body.copyOfRange(at, end)))
        at = end
    } while (at < body.size)
    return out
}

/** What [RecordAssembler.push] answers. */
public sealed class AssembleResult {
    /** A whole message. */
    public class Message(public val type: Int, public val body: ByteArray) : AssembleResult() {
        override fun toString(): String = "Message(type=$type, ${body.size} bytes)"
    }

    /** A chain is open. */
    public object Pending : AssembleResult()

    /** An unknown non-critical type, dropped. */
    public object Ignored : AssembleResult()

    /** The session closes with [code]. */
    public class Close(public val code: PeerCloseCode) : AssembleResult()
}

/** Reads records in order, in a session of one mode (the checks run in the order section 15.6 lists). */
public class RecordAssembler(private val mode: RecordMode) {
    private var openType = -1
    private var openSize = 0
    private var parts = ArrayList<ByteArray>()
    private var dropping = -1

    private fun bad(code: PeerCloseCode): AssembleResult = AssembleResult.Close(code)

    /** Feed one record. */
    public fun push(r: PeerRecord): AssembleResult {
        if ((r.flags and RESERVED_FLAGS) != 0) return bad(PeerCloseCode.peer_bad_frame)
        val more = (r.flags and MORE) != 0
        if (dropping >= 0) {
            if (dropping != r.type) return bad(PeerCloseCode.peer_bad_frame)
            if (!more) dropping = -1
            return AssembleResult.Ignored
        }
        if (openType >= 0 && openType != r.type) return bad(PeerCloseCode.peer_bad_frame)
        val row = TYPES.firstOrNull { r.type in it.from..it.to }
        if (row == null) {
            if ((r.type and CRITICAL) != 0) return bad(PeerCloseCode.peer_unknown_critical)
            if (more) dropping = r.type
            return AssembleResult.Ignored
        }
        if (mode !in row.modes) return bad(PeerCloseCode.peer_not_allowed)
        val size = (if (openType >= 0) openSize else 0) + r.body.size
        if (size > MAX_PEER_MESSAGE_BYTES || parts.size >= MAX_CHAIN_RECORDS) return bad(PeerCloseCode.peer_bad_frame)
        parts.add(r.body)
        if (more) {
            openType = r.type
            openSize = size
            return AssembleResult.Pending
        }
        val body = ByteArray(size)
        var at = 0
        for (p in parts) {
            p.copyInto(body, at)
            at += p.size
        }
        openType = -1
        openSize = 0
        parts = ArrayList()
        if (row.bodyLen != null && body.size != row.bodyLen) return bad(PeerCloseCode.peer_bad_frame)
        return AssembleResult.Message(r.type, body)
    }
}
