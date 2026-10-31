// The byte layout of `pkey-sync-file/1` (WIRE-CONTRACT-V5 §13.10.4) that [SyncFileStream] reads and
// writes: little-endian header fields, the per-segment nonce and the header parse.

package im.plrs.key.core.sync

internal object SyncFileFormat {
    const val WHOLE_SEGMENT: Int = SyncFileStream.SEGMENT_BYTES + SyncFileStream.TAG_BYTES
    private const val BYTE_MASK = 0xffL
    private const val BITS_PER_BYTE = 8
    private const val LAST_FLAG_AT = 0
    private const val INDEX_AT = 4
    private const val INDEX_BYTES = 8
    const val AT_VERSION: Int = 8
    const val AT_FLAGS: Int = 10
    const val AT_SEGMENT: Int = 12
    const val AT_KID: Int = 16
    const val AT_SALT: Int = 32
    const val U16: Int = 2
    const val U32: Int = 4

    class Parsed(val header: ByteArray, val salt: ByteArray)

    fun refuse(reason: SyncFileStream.Invalid): Nothing = throw SyncFileStream.Failure(reason)

    fun put(b: ByteArray, at: Int, bytes: Int, n: Long) {
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

    fun segmentsOf(plainSize: Long): Long = maxOf(1L, (plainSize + SyncFileStream.SEGMENT_BYTES - 1) / SyncFileStream.SEGMENT_BYTES)

    /** The parts one after the other. */
    fun join(parts: List<ByteArray>): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var off = 0
        for (p in parts) {
            p.copyInto(out, off)
            off += p.size
        }
        return out
    }

    /** The 12-byte nonce of segment [index]: the last flag, three zero bytes, the index big-endian. */
    fun nonce(index: Long, last: Boolean): ByteArray {
        val n = ByteArray(SyncCrypto.NONCE_BYTES)
        n[LAST_FLAG_AT] = if (last) 1 else 0
        for (i in 0 until INDEX_BYTES) {
            n[INDEX_AT + i] = (index ushr (BITS_PER_BYTE * (INDEX_BYTES - 1 - i))).toByte()
        }
        return n
    }

    /** The first header refusal, in the order of [SyncFileStream.Invalid]; [kid] is the ring's. */
    fun parseHeader(b: ByteArray, kid: ByteArray): Parsed {
        val magic = SyncCrypto.utf8(SyncFileStream.MAGIC)
        if (b.size < SyncFileStream.HEADER_BYTES) refuse(SyncFileStream.Invalid.SHAPE)
        if (!magic.contentEquals(b.copyOfRange(0, magic.size))) refuse(SyncFileStream.Invalid.MAGIC)
        if (get(b, AT_VERSION, U16) != SyncFileStream.VERSION.toLong()) refuse(SyncFileStream.Invalid.VERSION)
        if (get(b, AT_FLAGS, U16) != 0L) refuse(SyncFileStream.Invalid.FLAGS)
        if (get(b, AT_SEGMENT, U32) != SyncFileStream.SEGMENT_BYTES.toLong()) refuse(SyncFileStream.Invalid.SEGMENT_SIZE)
        if (!SyncCrypto.equalBytes(b.copyOfRange(AT_KID, AT_KID + SyncCrypto.KID_BYTES), kid)) refuse(SyncFileStream.Invalid.KID)
        return Parsed(b.copyOfRange(0, SyncFileStream.HEADER_BYTES), b.copyOfRange(AT_SALT, SyncFileStream.HEADER_BYTES))
    }
}
