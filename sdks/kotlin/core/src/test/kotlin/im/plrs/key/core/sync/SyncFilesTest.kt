// @pkey-feature sync.files.delta
//
// What the corpus rows do not pin about the synced-file primitives (U-23.K1): the chunk object
// round trip, a slice of the refusals, and the encode guards. The rows themselves run in
// :conformance (SyncFileVectorsTest).

package im.plrs.key.core.sync

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SyncFilesTest {
    private val root = ByteArray(32) { (it * 5 + 1).toByte() }
    private val plain = ByteArray(3000) { (it * 7 + (it shr 3)).toByte() }
    private val id = SyncChunks.chunkId(root, "saves", plain)

    private fun refusal(o: SyncChunks.Opened): SyncChunks.Invalid? = (o as? SyncChunks.Opened.Refused)?.reason

    @Test
    fun aRawChunkRoundTripsAndSealsTheSameTwice() {
        val obj = SyncChunks.seal(root, "saves", id, SyncChunks.CODEC_RAW, plain)
        val o = SyncChunks.open(root, "saves", id, obj)
        assertTrue(o is SyncChunks.Opened.Ok && o.plain.contentEquals(plain) && o.codec == 0)
        assertArrayEquals(obj, SyncChunks.seal(root, "saves", id, SyncChunks.CODEC_RAW, plain))
        assertEquals(SyncChunks.Invalid.AUTH, refusal(SyncChunks.open(root, "other", id, obj)))
    }

    @Test
    fun aZstdObjectWithNoDecoderOrAWrongSizeIsDecode() {
        val frame = byteArrayOf(0x28, 0xb5.toByte(), 0x2f, 0xfd.toByte(), 0x20, 0x07)
        val obj = SyncChunks.seal(root, "saves", id, SyncChunks.CODEC_ZSTD, frame)
        assertEquals(SyncChunks.Invalid.DECODE, refusal(SyncChunks.open(root, "saves", id, obj)))
        var seen = -1
        val wrong = SyncChunks.open(root, "saves", id, obj) { _, size ->
            seen = size
            byteArrayOf(1, 2, 3)
        }
        assertEquals(SyncChunks.Invalid.DECODE, refusal(wrong))
        assertEquals(7, seen)
        val throwing = SyncChunks.open(root, "saves", id, obj) { _, _ -> error("no") }
        assertEquals(SyncChunks.Invalid.DECODE, refusal(throwing))
    }

    @Test
    fun sealRefusesBadInputs() {
        for (bad in listOf<() -> Unit>(
            { SyncChunks.seal(root, "saves", id, 2, plain) },
            { SyncChunks.seal(root, "saves", id.copyOf(31), 0, plain) },
            { SyncChunks.seal(root.copyOf(31), "saves", id, 0, plain) },
        )) {
            try {
                bad()
                fail("expected a refusal")
            } catch (expected: SyncCryptoException) {
                // refused
            }
        }
    }

    @Test
    fun idBytesReadsLowercaseHexOnly() {
        val hex = SyncChunks.hex(id)
        assertArrayEquals(id, SyncChunks.idBytes(hex))
        assertNull(SyncChunks.idBytes(hex.uppercase()))
        assertNull(SyncChunks.idBytes(hex + "\n"))
        assertNull(SyncChunks.idBytes("ab"))
    }

    @Test
    fun zstdContentSizeReadsEveryFieldWidth() {
        fun b(vararg x: Int) = ByteArray(x.size) { x[it].toByte() }
        assertEquals(7, SyncZstdFrame.contentSize(b(0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x07)))
        assertEquals(257, SyncZstdFrame.contentSize(b(0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x01, 0x00)))
        assertNull(SyncZstdFrame.contentSize(b(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00)))
        assertNull(SyncZstdFrame.contentSize(b(0x00, 0xb5, 0x2f, 0xfd, 0x20, 0x07)))
        // An eight-byte size past 2^62 stays a number a caller refuses as SIZE.
        val huge = b(0x28, 0xb5, 0x2f, 0xfd, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0x80)
        assertEquals(Int.MAX_VALUE, SyncZstdFrame.contentSize(huge))
    }

    @Test
    fun manifestEncodeRefusesBadInputs() {
        val sha = ByteArray(32) { 1 }
        for (bad in listOf<() -> Unit>(
            { SyncManifest.encode(SyncManifest.Manifest(0, ByteArray(1), emptyList())) },
            { SyncManifest.encode(SyncManifest.Manifest(1, sha, listOf(SyncManifest.Record(ByteArray(1), 1)))) },
            { SyncManifest.encode(SyncManifest.Manifest(-1, sha, emptyList())) },
        )) {
            try {
                bad()
                fail("expected a refusal")
            } catch (expected: SyncCryptoException) {
                // refused
            }
        }
    }

    @Test
    fun aChunkerWithTheDefaultsHoldsAtMostMaxAndEndsEmpty() {
        val c = SyncCdc.Chunker()
        assertEquals(0, c.push(ByteArray(10)).size)
        val rest = c.finish()
        assertEquals(1, rest.size)
        assertEquals(10, rest[0].size)
        assertTrue(c.finish().isEmpty())
    }
}
