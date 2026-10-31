// `pkey-sync-chunks/1` (WIRE-CONTRACT-V5 §13.8.3): the file of a `chunks` upload, a manifest over
// content-defined chunks. It is stored sealed as a `pkey-sync-file/1` stream; this is the
// plaintext inside.
//
//   header, 64 bytes little-endian: "PKSYNCCH", version u16 (1), recordSize u16 (48),
//     flags u32 (0), chunkCount u32, reserved u32 (0), plainSize u64, plainSha256 (32 bytes)
//   record, 48 bytes: id (32 bytes) | plainLen u32 | flags u32 (0) | reserved u64 (0)
//
// A reader refuses the first violation, in the order of [SyncManifest.Invalid]. The plaintext hash
// binds the reassembled file and is checked by whoever reassembles it; a manifest alone cannot.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_CDC_MAX_BYTES
import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_MAX_CHUNKS_PER_FILE

public object SyncManifest {
    public const val MAGIC: String = "PKSYNCCH"
    public const val VERSION: Int = 1
    public const val HEADER_BYTES: Int = 64
    public const val RECORD_BYTES: Int = 48
    private const val ID_BYTES = 32
    private const val BYTE_MASK = 0xffL
    private const val BITS_PER_BYTE = 8
    private const val U16 = 2
    private const val U32 = 4
    private const val U64 = 8

    // Header offsets, then the offsets inside a record.
    private const val AT_VERSION = 8
    private const val AT_RECORD_SIZE = 10
    private const val AT_FLAGS = 12
    private const val AT_COUNT = 16
    private const val AT_RESERVED = 20
    private const val AT_PLAIN_SIZE = 24
    private const val AT_SHA = 32
    private const val AT_LEN = 32
    private const val AT_REC_FLAGS = 36
    private const val AT_REC_RESERVED = 40

    public class Record(public val id: ByteArray, public val plainLen: Int)

    public class Manifest(public val plainSize: Long, public val plainSha256: ByteArray, public val records: List<Record>)

    /**
     * In the order a reader checks: the header (shape, magic, version, recordSize, flags, reserved),
     * the declared count (over `SYNC_MAX_CHUNKS_PER_FILE`), the byte length, a plainSize over
     * `SYNC_FILE_MAX_BYTES`, each record in file order (record: its flags or reserved are not zero;
     * chunkLen: its length is 0 or over `SYNC_CDC_MAX_BYTES`), and last size: the lengths do not
     * add up to plainSize. [wire] is the corpus's word.
     */
    public enum class Invalid(public val wire: String) {
        SHAPE("shape"),
        MAGIC("magic"),
        VERSION("version"),
        RECORD_SIZE("recordSize"),
        FLAGS("flags"),
        RESERVED("reserved"),
        COUNT("count"),
        LENGTH("length"),
        SIZE("size"),
        RECORD("record"),
        CHUNK_LEN("chunkLen"),
    }

    public sealed class Parsed {
        public class Ok(public val manifest: Manifest) : Parsed()

        public class Refused(public val reason: Invalid) : Parsed()
    }

    private fun put(b: ByteArray, at: Int, bytes: Int, n: Long) {
        var v = n
        for (i in 0 until bytes) {
            b[at + i] = (v and BYTE_MASK).toByte()
            v = v ushr BITS_PER_BYTE
        }
    }

    private fun get(b: ByteArray, at: Int, bytes: Int): Long {
        var v = 0L
        for (i in bytes - 1 downTo 0) v = (v shl BITS_PER_BYTE) or (b[at + i].toLong() and BYTE_MASK)
        return v
    }

    public fun encode(m: Manifest): ByteArray {
        val sound = m.plainSha256.size == ID_BYTES && m.plainSize >= 0 && m.records.size <= SYNC_MAX_CHUNKS_PER_FILE &&
            m.records.all { it.id.size == ID_BYTES && it.plainLen >= 0 }
        if (!sound) throw SyncCryptoException("bad manifest")
        val out = ByteArray(HEADER_BYTES + RECORD_BYTES * m.records.size)
        SyncCrypto.utf8(MAGIC).copyInto(out)
        put(out, AT_VERSION, U16, VERSION.toLong())
        put(out, AT_RECORD_SIZE, U16, RECORD_BYTES.toLong())
        put(out, AT_COUNT, U32, m.records.size.toLong())
        put(out, AT_PLAIN_SIZE, U64, m.plainSize)
        m.plainSha256.copyInto(out, AT_SHA)
        m.records.forEachIndexed { i, r ->
            val at = HEADER_BYTES + RECORD_BYTES * i
            r.id.copyInto(out, at)
            put(out, at + AT_LEN, U32, r.plainLen.toLong())
        }
        return out
    }

    /** The first violation in the header, the declared count, the length or the plain size. */
    private fun headerProblem(b: ByteArray): Invalid? = when {
        b.size < HEADER_BYTES -> Invalid.SHAPE

        !SyncCrypto.utf8(MAGIC).contentEquals(b.copyOfRange(0, MAGIC.length)) -> Invalid.MAGIC

        get(b, AT_VERSION, U16) != VERSION.toLong() -> Invalid.VERSION

        get(b, AT_RECORD_SIZE, U16) != RECORD_BYTES.toLong() -> Invalid.RECORD_SIZE

        get(b, AT_FLAGS, U32) != 0L -> Invalid.FLAGS

        get(b, AT_RESERVED, U32) != 0L -> Invalid.RESERVED

        get(b, AT_COUNT, U32) > SYNC_MAX_CHUNKS_PER_FILE -> Invalid.COUNT

        b.size.toLong() != HEADER_BYTES + RECORD_BYTES * get(b, AT_COUNT, U32) -> Invalid.LENGTH

        // A u64 above 2^63 reads negative; it and a size over the cap are both SIZE.
        get(b, AT_PLAIN_SIZE, U64).let { it < 0 || it > SYNC_FILE_MAX_BYTES } -> Invalid.SIZE

        else -> null
    }

    /** The first violation in the records, in file order, and last whether the lengths add up. */
    private fun recordsProblem(b: ByteArray): Invalid? {
        val count = get(b, AT_COUNT, U32).toInt()
        var sum = 0L
        var problem: Invalid? = null
        var i = 0
        while (problem == null && i < count) {
            val at = HEADER_BYTES + RECORD_BYTES * i
            val len = get(b, at + AT_LEN, U32)
            problem = when {
                get(b, at + AT_REC_FLAGS, U32) != 0L || get(b, at + AT_REC_RESERVED, U64) != 0L -> Invalid.RECORD
                len == 0L || len > SYNC_CDC_MAX_BYTES -> Invalid.CHUNK_LEN
                else -> null
            }
            sum += len
            i++
        }
        return problem ?: if (sum != get(b, AT_PLAIN_SIZE, U64)) Invalid.SIZE else null
    }

    public fun parse(b: ByteArray): Parsed {
        val problem = headerProblem(b) ?: recordsProblem(b)
        if (problem != null) return Parsed.Refused(problem)
        val records = List(get(b, AT_COUNT, U32).toInt()) {
            val at = HEADER_BYTES + RECORD_BYTES * it
            Record(b.copyOfRange(at, at + ID_BYTES), get(b, at + AT_LEN, U32).toInt())
        }
        return Parsed.Ok(Manifest(get(b, AT_PLAIN_SIZE, U64), b.copyOfRange(AT_SHA, AT_SHA + ID_BYTES), records))
    }
}
