// @pkey-feature sync.export
//
// What the corpus rows do not pin about the export's container and its planned opener (U-51.7): the zip writer's zip32
// refusal and its central directory order (read back by java.util.zip.ZipFile and, where there is one, `unzip -t`), and a stream cut
// on a segment boundary still yielding every whole segment before it fails. The corpus rows run in :conformance.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.CRC32
import java.util.zip.ZipFile

class SyncExportZipTest {
    private class Collect : ExportSink {
        val out = ByteArrayOutputStream()

        override fun write(bytes: ByteArray, offset: Int, length: Int) = out.write(bytes, offset, length)
    }

    private fun entry(n: Int) = ByteArray(n) { (it * 31 + n).toByte() }

    private fun tooLarge(block: () -> Unit) {
        try {
            block()
            fail("expected sync-export-too-large")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.syncExportTooLarge, e.code)
        }
    }

    @Test
    fun entriesAreListedInTheOrderTheCallerNamesAndEveryCrcIsRight() {
        val sink = Collect()
        val zip = ZipStoreWriter(sink)
        zip.begin("b.bin")
        zip.write(entry(10))
        zip.write(entry(5), 1, 4)
        zip.end()
        zip.addBytes("a.txt", entry(300))
        zip.addBytes("empty", ByteArray(0))
        val total = zip.finish(listOf("a.txt", "b.bin", "empty"))
        assertEquals(sink.out.size().toLong(), total)
        val file = Files.createTempFile("pkey-zip-", ".zip")
        try {
            Files.write(file, sink.out.toByteArray())
            readBack(file)
            unzipTests(file.toString())
        } finally {
            Files.deleteIfExists(file)
        }
    }

    private fun readBack(file: java.nio.file.Path) {
        ZipFile(file.toFile()).use { z ->
            val got = z.entries().toList()
            assertEquals(listOf("a.txt", "b.bin", "empty"), got.map { it.name })
            for (e in got) {
                val data = z.getInputStream(e).use { it.readBytes() }
                assertEquals(e.crc, CRC32().also { it.update(data) }.value)
                assertEquals(e.size, data.size.toLong())
                assertEquals(java.util.zip.ZipEntry.STORED, e.method)
            }
            assertArrayEquals(entry(300), z.getInputStream(z.getEntry("a.txt")).use { it.readBytes() })
            assertArrayEquals(entry(10) + entry(5).copyOfRange(1, 4), z.getInputStream(z.getEntry("b.bin")).use { it.readBytes() })
        }
    }

    /** `unzip -t` where the machine has it: an independent reader of the same archive. */
    private fun unzipTests(path: String) {
        val p = runCatching { ProcessBuilder("unzip", "-t", path).redirectErrorStream(true).start() }.getOrNull()
        assumeTrue("no unzip on this machine", p != null)
        val text = p!!.inputStream.readBytes().toString(Charsets.UTF_8)
        assertEquals(0, p.waitFor())
        assertTrue(text, text.contains("No errors detected"))
    }

    @Test
    fun aWriteThatWouldPassTheLimitRefusesBeforeItReachesTheSink() {
        // 22 bytes of end record, 30 + 92 - 30 + 2 * 1 per entry, and 8 bytes of data: 22 + 94 + 8 = 124.
        val sink = Collect()
        val zip = ZipStoreWriter(sink, 124)
        zip.begin("a")
        zip.write(entry(8))
        val before = sink.out.size()
        tooLarge { zip.write(entry(1)) }
        assertEquals(before, sink.out.size())
        zip.end()
        tooLarge { zip.begin("b") }
        assertEquals(124L, zip.finish())
    }

    @Test
    fun anEntryNameMayNotRepeatAndAnEntryMayNotBeLeftOpen() {
        val zip = ZipStoreWriter(Collect())
        zip.begin("a")
        zip.end()
        try {
            zip.begin("a")
            fail("a repeated name must be refused")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("repeats"))
        }
        zip.begin("b")
        try {
            zip.finish()
            fail("an open entry must be refused")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message!!.contains("open"))
        }
    }

    @Test
    fun aPlannedOpenerYieldsEveryWholeSegmentOfAStreamCutOnABoundary() {
        val root = ByteArray(32) { (it * 3 + 1).toByte() }
        val plain = ByteArray(2 * SyncFileStream.SEGMENT_BYTES + 100) { (it * 7).toByte() }
        val sealed = SyncFileStream.sealFile(SyncKeys.deriveCollKey(root, "saves"), SyncKeys.deriveKid(root), plain, ByteArray(32) { 9 })
        // The header and the first segment only: the second and third are missing.
        val cut = SyncFileStream.HEADER_BYTES + SyncFileFormat.WHOLE_SEGMENT
        val opener = PlannedFileOpener(SyncKeys.deriveCollKey(root, "saves"), SyncKeys.deriveKid(root), plain.size.toLong())
        val got = opener.push(sealed.copyOf(cut))
        assertEquals(1, got.size)
        assertArrayEquals(plain.copyOf(SyncFileStream.SEGMENT_BYTES), got[0])
        try {
            opener.finish()
            fail("a missing segment must fail")
        } catch (e: SyncFileStream.Failure) {
            assertEquals(SyncFileStream.Invalid.SHAPE, e.reason)
        }
    }

    @Test
    fun aPlannedOpenerReturnsTheGoodSegmentsBeforeItReportsABadOne() {
        val root = ByteArray(32) { (it * 3 + 1).toByte() }
        val plain = ByteArray(2 * SyncFileStream.SEGMENT_BYTES + 100) { (it * 5).toByte() }
        val coll = SyncKeys.deriveCollKey(root, "saves")
        val sealed = SyncFileStream.sealFile(coll, SyncKeys.deriveKid(root), plain, ByteArray(32) { 4 })
        sealed[SyncFileStream.HEADER_BYTES + SyncFileFormat.WHOLE_SEGMENT + 3] =
            (sealed[SyncFileStream.HEADER_BYTES + SyncFileFormat.WHOLE_SEGMENT + 3].toInt() xor 1).toByte()
        val opener = PlannedFileOpener(coll, SyncKeys.deriveKid(root), plain.size.toLong())
        // One push holds a good segment and a bad one: the good one comes first, the failure on the next call.
        val got = opener.push(sealed)
        assertEquals(1, got.size)
        try {
            opener.push(ByteArray(1))
            fail("the bad segment must fail the next call")
        } catch (e: SyncFileStream.Failure) {
            assertEquals(SyncFileStream.Invalid.AUTH, e.reason)
        }
    }
}
