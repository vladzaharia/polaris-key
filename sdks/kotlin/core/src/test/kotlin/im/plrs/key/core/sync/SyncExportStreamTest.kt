// @pkey-feature sync.export
//
// The export holds constant memory (U-51.7): a server-mode file of 640 MiB goes through the core in the default 512 MiB test heap,
// its stored bytes hashed against the pointer as they pass, in sink writes of at most one segment. A core that kept the file would run
// out of memory here.

package im.plrs.key.core.sync

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class SyncExportStreamTest {
    private val block = ByteArray(8 * 1024 * 1024) { (it * 131 + (it shr 9)).toByte() }
    private val size = 80L * block.size

    private object ServerCodec : ExportFileCodec {
        override fun storedSize(plainSize: Long) = plainSize

        override fun plainSize(storedSize: Long): Long = storedSize

        override fun openManifest(stored: ByteArray): ByteArray = stored

        override fun openChunk(id: ByteArray, obj: ByteArray): ByteArray = obj

        override fun newPlannedOpener(plainSize: Long): ExportFileOpener = error("server mode streams the stored bytes as they are")
    }

    /** The same block over and over, never more than the planned size. */
    private inner class Blocks : ExportFileSource {
        var served = 0L

        override suspend fun pointers(collection: String, record: String): List<JsonObject> = emptyList()

        override suspend fun stored(ref: ExportFileRef) = object : ExportStored {
            override suspend fun next(): ByteArray? {
                if (served >= size) return null
                served += block.size
                return block
            }
        }

        override suspend fun chunk(collection: String, idHex: String): ByteArray? = null
    }

    private class Counting : ExportSink {
        var bytes = 0L
        var maxPiece = 0

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            this.bytes += length
            maxPiece = maxOf(maxPiece, length)
        }
    }

    @Test
    fun aFileLargerThanTheHeapStreamsThroughInSegmentSizedWrites() = runBlocking {
        val digest = MessageDigest.getInstance("SHA-256")
        repeat(80) { digest.update(block) }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        val row = buildJsonObject {
            put("record", JsonArray(listOf(JsonPrimitive("saves"), JsonPrimitive("big"))))
            put("version", 1)
            put("value", buildJsonObject { put("n", 1) })
            put(
                "file",
                buildJsonObject {
                    put("version", 1)
                    put("size", size)
                    put("sha256", sha)
                    put("format", "whole")
                },
            )
        }
        val source = Blocks()
        val sink = Counting()
        val input = ExportInput("demo", 0L, 0, false, listOf(row), source, null, { ServerCodec })
        val summary = SyncExport.run(input, sink)
        assertEquals(size, source.served)
        assertEquals(1, summary.files)
        assertTrue("the file hashed to the pointer's sha256, so it is whole: ${summary.skipped}", summary.skipped.isEmpty())
        assertEquals(sink.bytes, summary.bytes)
        assertTrue(sink.bytes in size..summary.plannedBytes)
        assertTrue("a sink write of ${sink.maxPiece} bytes", sink.maxPiece <= SyncFileStream.SEGMENT_BYTES)
    }
}
