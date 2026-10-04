// @pkey-feature packs.apply.delta packs.index.chunks
//
// The zstd port over zstd-jni (P6-08): the start-up probe decodes the shared `--patch-from` vector,
// a frame decodes to exactly its size and nothing else, a base that starts with the dictionary magic
// is refused before any decoder sees it (§2.7 rule 5), the window check refuses an oversized frame,
// and the streaming decode delivers a payload in order.

package im.plrs.key.packs

import com.github.luben.zstd.Zstd
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PackZstdTest {
    private val z = LibZstd()

    @Test
    fun theProbePassesAndPatchFromIsAdvertised() {
        assertTrue(LibZstd.available)
        assertTrue(ZstdProbe.passes(z))
        val (port, info) = selectZstd()
        assertTrue(port is LibZstd)
        assertEquals(listOf("zstd-patch-from"), info.patchMethods)
        assertNull(info.unsupported)
        assertEquals(31, z.pointerBits)
    }

    @Test
    fun aFrameDecodesToExactlyItsSize() {
        val data = ByteArray(100_000) { (it % 97).toByte() }
        val frame = Zstd.compress(data, 3)
        assertArrayEquals(data, z.decode(frame, data.size))
        for (wrong in listOf(data.size - 1, data.size + 1)) {
            try {
                z.decode(frame, wrong)
                fail("size $wrong accepted")
            } catch (e: ZstdException) {
                // Refused.
            }
        }
        try {
            z.decode(frame + byteArrayOf(1, 2, 3), data.size)
            fail("trailing bytes accepted")
        } catch (e: ZstdException) {
            // Refused.
        }
        try {
            z.decode(frame.copyOf(frame.size - 4), data.size)
            fail("a truncated frame accepted")
        } catch (e: ZstdException) {
            // Refused.
        }
    }

    @Test
    fun aDictionaryMagicBaseAndAnOversizedWindowAreRefused() {
        val base = byteArrayOf(0x37, 0xa4.toByte(), 0x30, 0xec.toByte()) + ByteArray(500) { 7 }
        val target = base.copyOf().also { it[100] = 1 }
        // The frame never reaches a decoder: the base's magic refuses it first.
        val frame = Zstd.compress(target, 3)
        assertNull(prefixDecode(z, frame, base, target.size.toLong(), (base.size + target.size).toLong()))
        // The window check: a frame whose header window is above 2^windowLogMax(memBytes).
        val plain = ByteArray(5000) { (it % 13).toByte() }
        val okBase = ByteArray(4000) { (it % 11).toByte() }
        val f2 = patchFrom(okBase, plain)
        assertTrue(prefixDecode(z, f2, okBase, plain.size.toLong(), (okBase.size + plain.size).toLong())!!.contentEquals(plain))
        assertNull(prefixDecode(z, f2, okBase, plain.size.toLong(), 100))
    }

    @Test
    fun aStreamingDecodeDeliversThePayloadInOrder() {
        val data = ByteArray(300_000) { (it * 31 % 256).toByte() }
        val frame = Zstd.compress(data, 1)
        val out = java.io.ByteArrayOutputStream()
        z.decodeStream(MemorySource(frame), data.size.toLong()) { out.write(it) }
        assertArrayEquals(data, out.toByteArray())
        try {
            z.decodeStream(MemorySource(frame), data.size.toLong() - 1) {}
            fail("an overrun accepted")
        } catch (e: ZstdException) {
            // Refused.
        }
    }
}
