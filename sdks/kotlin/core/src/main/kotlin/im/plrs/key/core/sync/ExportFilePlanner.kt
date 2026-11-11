// Planning the files of an export (WIRE-CONTRACT-V5 section 13.12, "Which file is live", "File sizes", "Chunked files"): the live
// file of each row (the pointer in server mode, the file the sealed `$file` binding names in end-to-end mode), the kept revisions
// on request, every candidate checked, and every chunked file's manifest fetched and read before anything is written.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_EXPORT_MAX_CHUNKS
import im.plrs.key.core.SYNC_MAX_CHUNKS_PER_FILE
import im.plrs.key.core.decimalValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

internal class ExportFilePlanner(private val input: ExportInput) {
    private val e2e = input.codec != null
    private val codecs = HashMap<String, ExportFileCodec>()

    /** Every file entry, live first and then the revisions newest first, row by row. */
    val planned = ArrayList<PlanFile>()
    val skips = ArrayList<PlanSkip>()

    /** The collection of every file pointer the machine holds that the plan met: the bound counts each. */
    val pointerCollections = ArrayList<String>()

    /** The chunk records of every manifest read so far. */
    var chunkTotal = 0
        private set

    private fun codecFor(collection: String): ExportFileCodec = codecs.getOrPut(collection) { input.fileCodec(collection) }

    private fun noEntry(collection: String) {
        pointerCollections.add(collection)
        skips.add(PlanSkip("file", collection))
    }

    /** The files of one collection: the records that have a file and no value (end-to-end) first, then its rows in id order. */
    suspend fun plan(collection: String, fileOnly: Int, rows: List<PlanRow>) {
        repeat(fileOnly) { noEntry(collection) }
        for (row in rows) {
            val current = row.pointer ?: continue
            currentCoroutineContext().ensureActive()
            if (e2e && row.binding == null) {
                // A file the sealed value does not name is no readable file there (section 13.10.4).
                noEntry(collection)
                row.pointer = null
            } else {
                planRow(collection, row, current)
            }
        }
    }

    private suspend fun planRow(collection: String, row: PlanRow, current: JsonObject) {
        val version = current["version"]
        val others = input.files.pointers(collection, row.wire).filter {
            ExportJson.isNumber(it["version"]) && !SyncJson.jsonEqual(it["version"], version)
        }
        val candidates = listOf(current) + others.sortedByDescending { it["version"].decimalValue!! }
        repeat(candidates.size) { pointerCollections.add(collection) }
        val binding = row.binding
        val live = candidates.firstOrNull { if (binding == null) it === current else binding.names(it) }
        if (live == null) {
            // No candidate is the live file: the row has no readable file.
            row.pointer = null
            skips.add(PlanSkip("file", collection))
        } else {
            mark(collection, row, live, true)
            if (input.includeRevisions) candidates.filter { it !== live }.forEach { mark(collection, row, it, false) }
        }
    }

    private suspend fun mark(collection: String, row: PlanRow, f: JsonObject, live: Boolean) {
        val size = ExportJson.sizeOf(f["size"])
        val format = if (f["format"].stringValue == "chunks") "chunks" else "whole"
        val ref = ExportFileRef(collection, row.wire, f["version"]!!, format, size ?: 0L)
        val checked = if (chunkTotal > SYNC_EXPORT_MAX_CHUNKS) null else validate(collection, ref, f)
        if (checked == null) {
            skips.add(PlanSkip("file", collection))
            if (live) row.pointer = null
        } else {
            planned.add(PlanFile(row, ref, f, live, checked.first, checked.second))
        }
    }

    /** The planned plaintext size of a file, and its manifest when chunked; null when the pointer is not a file this export can read. */
    private suspend fun validate(collection: String, ref: ExportFileRef, f: JsonObject): Pair<Long, PlanManifest?>? {
        val size = ExportJson.sizeOf(f["size"])
        val codec = codecFor(collection)
        return when {
            size == null || !ExportJson.isHex64(f["sha256"]) -> null
            f["format"].stringValue == "whole" -> if (e2e) codec.plainSize(size)?.let { it to null } else size to null
            f["format"].stringValue == "chunks" -> manifestOf(codec, ref, f, size)
            else -> null
        }
    }

    private suspend fun manifestOf(codec: ExportFileCodec, ref: ExportFileRef, f: JsonObject, size: Long): Pair<Long, PlanManifest?>? {
        val most = codec.storedSize(SyncManifest.HEADER_BYTES.toLong() + SyncManifest.RECORD_BYTES.toLong() * SYNC_MAX_CHUNKS_PER_FILE)
        val stored = readBounded(ref, most)?.takeIf { SyncChunks.hex(MessageDigest.getInstance("SHA-256").digest(it)) == f["sha256"].stringValue }
        val plain = stored?.let { codec.openManifest(it) }
        val parsed = plain?.let { (SyncManifest.parse(it) as? SyncManifest.Parsed.Ok)?.manifest }
        if (parsed == null || codec.storedSize(parsed.plainSize) != size) return null
        chunkTotal += parsed.records.size
        return parsed.plainSize to PlanManifest(parsed.records, parsed.plainSha256)
    }

    /** The stored bytes of [ref] up to [limit]; null when the source has more. */
    private suspend fun readBounded(ref: ExportFileRef, limit: Long): ByteArray? {
        val out = ByteArrayOutputStream()
        input.files.stored(ref).use { src ->
            while (true) {
                currentCoroutineContext().ensureActive()
                val piece = src.next() ?: break
                if (out.size() + piece.size > limit) return null
                out.write(piece)
            }
        }
        return out.toByteArray()
    }
}
