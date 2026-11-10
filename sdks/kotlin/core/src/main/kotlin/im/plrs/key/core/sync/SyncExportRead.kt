// Reading one planned file into the open zip entry (WIRE-CONTRACT-V5 section 13.12, "Reading a file"). A file is read at
// most its planned size; the stored bytes are hashed as they are read and compared with the pointer's `sha256`, a chunked
// file's reassembly with the manifest's `plainSha256`. The entry is written as far as it checks, and a file that ends short,
// whose hash differs or that fails to authenticate is flagged partial. The sizes and hashes reported describe the bytes
// written.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_CHUNK_MAX_STORED_BYTES
import im.plrs.key.core.stringValue
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.security.MessageDigest

/** A sink write is at most one segment: 1 MiB of plaintext. */
private const val PIECE = 1_048_576

internal class FileResult(val size: Long, val sha256: String, val partial: Boolean)

/** The stored bytes of a file, at most [limit] of them in all, hashed as they go by. */
private class Limited(private val src: ExportStored, private val limit: Long) : AutoCloseable {
    var total = 0L
        private set
    private val hash = MessageDigest.getInstance("SHA-256")

    suspend fun next(): ByteArray? {
        var out: ByteArray? = null
        while (out == null && total < limit) {
            currentCoroutineContext().ensureActive()
            val piece = src.next() ?: break
            val room = limit - total
            val p = if (piece.size > room) piece.copyOf(room.toInt()) else piece
            if (p.isNotEmpty()) {
                total += p.size
                hash.update(p)
                out = p
            }
        }
        return out
    }

    fun hex(): String = SyncChunks.hex(hash.digest())

    override fun close() = src.close()
}

internal class ExportFileReader(
    private val files: ExportFileSource,
    private val e2e: Boolean,
    private val zip: ZipStoreWriter,
    private val progress: (Int) -> Unit,
) {
    private val written = MessageDigest.getInstance("SHA-256")
    private var size = 0L

    private fun put(planned: Long, b: ByteArray, from: Int = 0, to: Int = b.size) {
        check(size + (to - from) <= planned) { "read past the plan" }
        written.update(b, from, to - from)
        size += to - from
        zip.write(b, from, to)
        progress(to - from)
    }

    /** Streams [p] into the open entry. */
    suspend fun read(p: PlanFile, codec: ExportFileCodec): FileResult {
        val partial = if (p.file["format"].stringValue == "chunks") chunked(p, codec) else whole(p, codec)
        return FileResult(size, SyncChunks.hex(written.digest()), partial)
    }

    /** The chunks in manifest order, each opened under its id with its length checked; `plainSha256` after the last. */
    private suspend fun chunked(p: PlanFile, codec: ExportFileCodec): Boolean {
        val m = p.manifest!!
        val total = MessageDigest.getInstance("SHA-256")
        for (rec in m.records) {
            val plain = chunk(p, codec, rec) ?: return true
            total.update(plain)
            put(p.planned, plain)
        }
        return !MessageDigest.isEqual(total.digest(), m.plainSha256)
    }

    /** One chunk's plaintext, or null when the Worker has none, serves too much, or serves one that does not open under its id and length. */
    private suspend fun chunk(p: PlanFile, codec: ExportFileCodec, rec: SyncManifest.Record): ByteArray? {
        currentCoroutineContext().ensureActive()
        val obj = files.chunk(p.row.collection, SyncChunks.hex(rec.id))?.takeIf { it.size <= SYNC_CHUNK_MAX_STORED_BYTES }
        return obj?.let { codec.openChunk(rec.id, it) }?.takeIf { it.size == rec.plainLen }
    }

    private suspend fun whole(p: PlanFile, codec: ExportFileCodec): Boolean {
        val stored = p.ref.size
        Limited(files.stored(p.ref), stored).use { src ->
            val failed = if (e2e) segments(p, codec, src) else plain(p, src)
            return failed || src.total != stored || src.hex() != p.file["sha256"].stringValue
        }
    }

    /** Server mode: the stored bytes are the plaintext. */
    private suspend fun plain(p: PlanFile, src: Limited): Boolean {
        while (true) {
            val piece = src.next() ?: return false
            for (at in piece.indices step PIECE) put(p.planned, piece, at, minOf(piece.size, at + PIECE))
        }
    }

    /**
     * End-to-end: a segment at a time, each authenticated, the last one known from the plan. True when the stream failed: the
     * failure is not rethrown because it only means the entry ends at the last good segment and is flagged partial.
     */
    @Suppress("SwallowedException")
    private suspend fun segments(p: PlanFile, codec: ExportFileCodec, src: Limited): Boolean {
        val opener = codec.newPlannedOpener(p.planned)
        try {
            while (true) {
                val piece = src.next() ?: break
                for (plain in opener.push(piece)) put(p.planned, plain)
            }
            opener.finish()
        } catch (f: SyncFileStream.Failure) {
            return true
        }
        return false
    }
}
