// `pkey-sync-file/1` (WIRE-CONTRACT-V5 §13.10.4): a file sealed as a stream of segments.
//
//   header, 64 bytes little-endian: "PKSYNCF1", version u16 (1), flags u16 (0),
//     segmentBytes u32 (1 MiB), kid (16 bytes), salt (32 bytes)
//   segment i: AES-256-GCM(K_file, nonce = u8(last) | 0x00 0x00 0x00 | u64be(i), aad = header,
//     the segment's plaintext), so 16 bytes longer than its plaintext
//
// K_file comes from K_coll and the header's salt ([SyncKeys.deriveFileKey]). Every segment but the
// last holds exactly [SyncFileStream.SEGMENT_BYTES] of plaintext; the last holds 1..SEGMENT_BYTES,
// except that an empty file is one empty last segment. The end of the stream says which segment is
// last, so a truncated stream, a dropped or reordered segment and a missing last flag all fail the tag.
//
// Nothing here holds a whole file unless the caller asks for it ([SyncFileStream.sealFile] /
// [SyncFileStream.openFile]): the [SyncFileStream.Sealer] and the [SyncFileStream.Opener] keep at
// most one segment, and [SyncFileStream.openRange] reads and decrypts only the segments it needs.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_FILE_SEGMENT_BYTES
import im.plrs.key.core.sync.SyncFileFormat.AT_KID
import im.plrs.key.core.sync.SyncFileFormat.AT_SALT
import im.plrs.key.core.sync.SyncFileFormat.AT_SEGMENT
import im.plrs.key.core.sync.SyncFileFormat.AT_VERSION
import im.plrs.key.core.sync.SyncFileFormat.U16
import im.plrs.key.core.sync.SyncFileFormat.U32
import im.plrs.key.core.sync.SyncFileFormat.WHOLE_SEGMENT
import im.plrs.key.core.sync.SyncFileFormat.nonce
import im.plrs.key.core.sync.SyncFileFormat.parseHeader
import im.plrs.key.core.sync.SyncFileFormat.put
import im.plrs.key.core.sync.SyncFileFormat.refuse
import im.plrs.key.core.sync.SyncFileFormat.segmentsOf
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

public object SyncFileStream {
    public const val MAGIC: String = "PKSYNCF1"
    public const val VERSION: Int = 1
    public const val HEADER_BYTES: Int = 64

    /** The only segment size `pkey-sync-file/1` defines. */
    public const val SEGMENT_BYTES: Int = SYNC_FILE_SEGMENT_BYTES
    public const val TAG_BYTES: Int = SyncCrypto.TAG_BYTES

    /**
     * Why a reader refuses a stream, in the order it checks: the header ([SHAPE]: under 64 bytes;
     * [MAGIC], [VERSION], [FLAGS], [SEGMENT_SIZE], [KID]), then the body ([SHAPE]: no segment, or a
     * tail shorter than a tag; [SIZE]: an empty last segment after others, or a short ranged read;
     * [AUTH]: a segment fails its tag, which covers truncation, reordering, a missing last flag and a
     * tampered header). [RANGE] is a ranged open outside the file; [PLAIN_SIZE] and [PLAIN_SHA256] are
     * [Reassembly] checks. [wire] is the corpus's word.
     */
    public enum class Invalid(public val wire: String) {
        SHAPE("shape"),
        MAGIC("magic"),
        VERSION("version"),
        FLAGS("flags"),
        SEGMENT_SIZE("segmentSize"),
        KID("kid"),
        SIZE("size"),
        AUTH("auth"),
        RANGE("range"),
        PLAIN_SIZE("plainSize"),
        PLAIN_SHA256("plainSha256"),
    }

    /** A stream or reassembly refused; [reason] says why. */
    public class Failure(public val reason: Invalid) : Exception("pkey-sync-file/1: ${reason.wire}")

    public sealed class Opened {
        public class Ok(public val plain: ByteArray) : Opened()

        public class Refused(public val reason: Invalid) : Opened()
    }

    /** The 64-byte header. */
    public fun encodeHeader(kid: ByteArray, salt: ByteArray): ByteArray {
        if (kid.size != SyncCrypto.KID_BYTES) throw SyncCryptoException("bad kid length")
        if (salt.size != SyncCrypto.FILE_SALT_BYTES) throw SyncCryptoException("bad salt length")
        val h = ByteArray(HEADER_BYTES)
        SyncCrypto.utf8(MAGIC).copyInto(h)
        put(h, AT_VERSION, U16, VERSION.toLong())
        put(h, AT_SEGMENT, U32, SEGMENT_BYTES.toLong())
        kid.copyInto(h, AT_KID)
        salt.copyInto(h, AT_SALT)
        return h
    }

    /** The sealed size of a plaintext of [plainSize] bytes. */
    public fun sealedSize(plainSize: Long): Long {
        require(plainSize >= 0) { "plain size" }
        return HEADER_BYTES + plainSize + segmentsOf(plainSize) * TAG_BYTES
    }

    /** The plaintext size a sealed size implies, or null when no stream has that size. */
    public fun plainSize(sealedSize: Long): Long? {
        val body = sealedSize - HEADER_BYTES
        if (body < TAG_BYTES) return null
        val full = body / WHOLE_SEGMENT
        val rest = body - full * WHOLE_SEGMENT
        return when {
            rest == 0L -> full * SEGMENT_BYTES

            rest < TAG_BYTES -> null

            // An empty last segment is only the empty file.
            rest == TAG_BYTES.toLong() && full > 0 -> null

            else -> full * SEGMENT_BYTES + (rest - TAG_BYTES)
        }
    }

    // -- Seal ------------------------------------------------------------------------------------

    /**
     * Seals a file as it arrives. [header] goes first; [push] returns the sealed segments that the
     * bytes complete and [finish] the last one. One byte is held back until more arrives, so the final
     * segment is known to be the last. Every seal draws a fresh random 32-byte salt (§13.10.2), never
     * one derived from the content: a salt names one file version, and reusing it under the same
     * [collKey] repeats K_file and every nonce. [salt] is for known-answer vectors only.
     */
    public class Sealer(collKey: ByteArray, kid: ByteArray, salt: ByteArray? = null) {
        public val header: ByteArray
        private val key: ByteArray
        private var index = 0L
        private val buf = ByteArray(SEGMENT_BYTES + 1)
        private var len = 0

        init {
            if (collKey.size != SyncCrypto.KEY_BYTES) throw SyncCryptoException("bad collection key length")
            val s = salt ?: SyncCrypto.random(SyncCrypto.FILE_SALT_BYTES)
            header = encodeHeader(kid, s)
            key = SyncKeys.deriveFileKey(collKey, s)
        }

        /** The sealed segments that [data] (its [from] until [to] range) completes, in order. */
        public fun push(data: ByteArray, from: Int = 0, to: Int = data.size): List<ByteArray> {
            require(from in 0..to && to <= data.size) { "bad range" }
            val out = ArrayList<ByteArray>()
            var at = from
            while (at < to) {
                val take = minOf(buf.size - len, to - at)
                data.copyInto(buf, len, at, at + take)
                len += take
                at += take
                if (len == buf.size) {
                    out.add(seal(buf.copyOfRange(0, SEGMENT_BYTES), last = false))
                    buf[0] = buf[SEGMENT_BYTES]
                    len = 1
                }
            }
            return out
        }

        /** The last sealed segment (an empty file is one empty last segment). The sealer is empty after. */
        public fun finish(): ByteArray {
            val last = seal(buf.copyOfRange(0, len), last = true)
            len = 0
            return last
        }

        private fun seal(plain: ByteArray, last: Boolean): ByteArray = SyncCrypto.aesGcmSeal(key, header, plain, nonce(index++, last))
    }

    /** [Sealer] over one buffer: the header and every segment. For files that fit in memory. */
    public fun sealFile(collKey: ByteArray, kid: ByteArray, plain: ByteArray, salt: ByteArray? = null): ByteArray {
        val s = Sealer(collKey, kid, salt)
        return SyncFileFormat.join(listOf(s.header) + s.push(plain) + s.finish())
    }

    // -- Open ------------------------------------------------------------------------------------

    /**
     * Opens a sealed stream as it arrives. [push] returns the plaintext of each segment whose tag has
     * verified and [finish] the last one; both throw [Failure]. Truncation is only known at [finish],
     * so a caller that writes the plaintext out treats it as provisional until [finish] returns.
     * [kid] is `SyncKeys.deriveKid(root)`; a stream sealed under another ring is [Invalid.KID].
     */
    public class Opener(private val collKey: ByteArray, private val kid: ByteArray) {
        private val head = ByteArray(HEADER_BYTES)
        private var headLen = 0
        private var parsed: SyncFileFormat.Parsed? = null
        private var key = ByteArray(0)
        private var index = 0L
        private val buf = ByteArray(WHOLE_SEGMENT + 1)
        private var len = 0

        /** The plaintext of each segment that [data] (its [from] until [to] range) completes, in order. */
        public fun push(data: ByteArray, from: Int = 0, to: Int = data.size): List<ByteArray> {
            require(from in 0..to && to <= data.size) { "bad range" }
            val out = ArrayList<ByteArray>()
            var at = from
            while (at < to) {
                if (parsed == null) {
                    val take = minOf(HEADER_BYTES - headLen, to - at)
                    data.copyInto(head, headLen, at, at + take)
                    headLen += take
                    at += take
                    if (headLen == HEADER_BYTES) {
                        val p = parseHeader(head, kid)
                        parsed = p
                        key = SyncKeys.deriveFileKey(collKey, p.salt)
                    }
                } else {
                    val take = minOf(buf.size - len, to - at)
                    data.copyInto(buf, len, at, at + take)
                    len += take
                    at += take
                    // One byte beyond a whole segment proves the segment is not the last.
                    if (len == buf.size) {
                        out.add(open(buf.copyOfRange(0, WHOLE_SEGMENT), last = false))
                        buf[0] = buf[WHOLE_SEGMENT]
                        len = 1
                    }
                }
            }
            return out
        }

        /** The plaintext of the last segment, once the input has ended. */
        public fun finish(): ByteArray {
            if (parsed == null || len < TAG_BYTES) refuse(Invalid.SHAPE)
            if (len == TAG_BYTES && index > 0) refuse(Invalid.SIZE)
            val tail = buf.copyOfRange(0, len)
            len = 0
            return open(tail, last = true)
        }

        private fun open(sealed: ByteArray, last: Boolean): ByteArray {
            val plain = SyncCrypto.aesGcmOpen(key, parsed!!.header, sealed, nonce(index, last)) ?: refuse(Invalid.AUTH)
            index++
            return plain
        }
    }

    /** [Opener] over one buffer; a refusal comes back with its reason. */
    public fun openFile(collKey: ByteArray, kid: ByteArray, sealed: ByteArray): Opened {
        val o = Opener(collKey, kid)
        return try {
            Opened.Ok(SyncFileFormat.join(o.push(sealed) + o.finish()))
        } catch (refused: Failure) {
            Opened.Refused(refused.reason)
        }
    }

    /** Reads [length] bytes of the stored file at [offset]; a short answer is a [Invalid.SIZE] refusal. */
    public fun interface RangeReader {
        public fun read(offset: Long, length: Int): ByteArray
    }

    /** A stored stream of [sealedSize] bytes, read through [reader]. */
    public class Stored(public val sealedSize: Long, public val reader: RangeReader)

    /**
     * Opens bytes `[start, end)` of the plaintext of a [stored] stream. It reads the header and then
     * only the segments that overlap the range, each verified as a whole; the last-segment flag comes
     * from [Stored.sealedSize], so a server that lies about the size or drops a tail fails the tag. An
     * [end] past the plaintext is [Invalid.RANGE]. Throws [Failure].
     */
    public fun openRange(collKey: ByteArray, kid: ByteArray, stored: Stored, start: Long, end: Long): ByteArray {
        val plainLen = plainSize(stored.sealedSize) ?: refuse(Invalid.SHAPE)
        if (start < 0 || start > end || end > plainLen) refuse(Invalid.RANGE)
        fun fetch(offset: Long, length: Int): ByteArray {
            val b = stored.reader.read(offset, length)
            if (b.size != length) refuse(Invalid.SIZE)
            return b
        }
        val p = parseHeader(fetch(0, HEADER_BYTES), kid)
        if (start == end) return ByteArray(0)
        val key = SyncKeys.deriveFileKey(collKey, p.salt)
        val segments = segmentsOf(plainLen)
        val out = ByteArrayOutputStream(minOf(end - start, SEGMENT_BYTES.toLong()).toInt())
        for (i in (start / SEGMENT_BYTES)..((end - 1) / SEGMENT_BYTES)) {
            val isLast = i == segments - 1
            val segLen = if (isLast) (plainLen - i * SEGMENT_BYTES).toInt() else SEGMENT_BYTES
            val sealed = fetch(HEADER_BYTES + i * WHOLE_SEGMENT, segLen + TAG_BYTES)
            val plain = SyncCrypto.aesGcmOpen(key, p.header, sealed, nonce(i, isLast)) ?: refuse(Invalid.AUTH)
            val from = (maxOf(start, i * SEGMENT_BYTES) - i * SEGMENT_BYTES).toInt()
            val to = (minOf(end, i * SEGMENT_BYTES + segLen) - i * SEGMENT_BYTES).toInt()
            out.write(plain, from, to - from)
        }
        return out.toByteArray()
    }

    // -- Reassembly ------------------------------------------------------------------------------

    /**
     * Passes the plaintext of a reassembled file through while hashing it, and at the end checks the
     * length and SHA-256 the chunk manifest declared ([SyncManifest.Manifest.plainSize] /
     * `plainSha256`). [push] throws [Invalid.PLAIN_SIZE] for a source that overruns (before it can write
     * the rest of a runaway file); [finish] throws [Invalid.PLAIN_SIZE] or [Invalid.PLAIN_SHA256]. The
     * caller discards what it wrote: a file is not usable until [finish] returns. Never holds the file.
     */
    public class Reassembly(private val plainSize: Long, private val plainSha256: ByteArray) {
        private val hash = MessageDigest.getInstance("SHA-256")
        private var count = 0L

        init {
            if (plainSize < 0 || plainSize > SYNC_FILE_MAX_BYTES) refuse(Invalid.PLAIN_SIZE)
        }

        public fun push(data: ByteArray, from: Int = 0, to: Int = data.size) {
            require(from in 0..to && to <= data.size) { "bad range" }
            count += to - from
            if (count > plainSize) refuse(Invalid.PLAIN_SIZE)
            hash.update(data, from, to - from)
        }

        public fun finish() {
            if (count != plainSize) refuse(Invalid.PLAIN_SIZE)
            if (!SyncCrypto.equalBytes(hash.digest(), plainSha256)) refuse(Invalid.PLAIN_SHA256)
        }
    }
}
