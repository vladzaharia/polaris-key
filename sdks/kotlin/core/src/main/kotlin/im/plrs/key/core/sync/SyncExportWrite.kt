// Writing the archive (WIRE-CONTRACT-V5 section 13.12): the files first, because a record line cites its file's size and
// SHA-256, known only once the file has streamed and no plaintext may be spooled; then the record files, `files.json`,
// `index.json` and `data.json`. The central directory lists the entries in the order of the contract, whatever the order the
// bytes were written in.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_EXPORT_FORMAT
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class ExportWriter(private val input: ExportInput, private val rows: ExportRows, private val plan: ExportPlan, sink: ExportSink) {
    private val zip = ZipStoreWriter(sink)
    private val e2e = input.codec != null
    private val partialSkips = ArrayList<JsonObject>()
    private val fileIndex = ArrayList<JsonElement>()
    private val lineFile = HashMap<PlanRow, JsonObject>()
    private var plainDone = 0L

    private fun bytes(text: String) = ExportJson.utf8(text)

    suspend fun write(): ExportSummary {
        zip.addBytes("README.txt", bytes(SYNC_EXPORT_README))
        zip.addBytes(ExportLayout.settingsName, plan.settings.line)
        writeFiles()
        val records = writeRecords()
        zip.addBytes(ExportLayout.filesName, bytes(ExportJson.line(JsonArray(fileIndex))))
        zip.addBytes(ExportLayout.indexName, bytes(ExportLayout.index(plan.written.map { it.first to it.second.size })))
        val skipped = plan.skips.map { it.json() } + partialSkips
        zip.addBytes("data.json", bytes(ExportJson.line(data(records, skipped))))
        val total = zip.finish(plan.names)
        check(total <= plan.totals.plannedBytes) { "the export plan undercounted the archive" }
        return ExportSummary(total, plan.totals.plannedBytes, plan.names.size, plan.settings.count, records, plan.files.size, skipped)
    }

    private fun data(records: Int, skipped: List<JsonObject>): JsonObject = buildJsonObject {
        put("schema", SYNC_EXPORT_FORMAT)
        put("source", "device")
        put("product", input.product)
        put("exportedAt", input.exportedAt)
        put("encryption", if (e2e) "e2e" else "server")
        put(
            "counts",
            buildJsonObject {
                put("settings", plan.settings.count)
                put("records", records)
                put("files", plan.files.size)
            },
        )
        put("unsynced", input.unsynced)
        put("skipped", JsonArray(skipped))
    }

    private fun progress(n: Int) {
        plainDone += n
        input.onProgress?.invoke(plainDone, plan.totals.fileBytes)
    }

    /** The files, read one at a time in plan order, at most the planned size each. */
    private suspend fun writeFiles() {
        val codecs = HashMap<String, ExportFileCodec>()
        for ((n, p) in plan.files.withIndex()) {
            currentCoroutineContext().ensureActive()
            val entry = ExportLayout.fileName(n)
            zip.begin(entry)
            val codec = codecs.getOrPut(p.row.collection) { input.fileCodec(p.row.collection) }
            val got = ExportFileReader(input.files, e2e, zip, ::progress).read(p, codec)
            zip.end()
            note(entry, p, got)
        }
    }

    private fun note(entry: String, p: PlanFile, got: FileResult) {
        if (got.partial) {
            partialSkips.add(
                buildJsonObject {
                    put("kind", "file")
                    put("collection", p.row.collection)
                    put("entry", entry)
                    put("code", "sync-file-invalid")
                    put("partial", true)
                },
            )
        }
        val facts = ExportLayout.facts(entry, p.file["version"]!!, got, p.planned)
        fileIndex.add(
            buildJsonObject {
                facts.forEach { (k, v) -> put(k, v) }
                put("collection", p.row.collection)
                put("id", p.row.id)
                put("live", p.live)
                if (e2e && !p.live) put("bound", false)
            },
        )
        if (p.live) lineFile[p.row] = facts
    }

    /** The record files, a line at a time: each row is opened again for its line. */
    private suspend fun writeRecords(): Int {
        var count = 0
        for ((i, group) in plan.written.withIndex()) {
            zip.begin(ExportLayout.recordsName(i))
            for (r in group.second) {
                currentCoroutineContext().ensureActive()
                val again = rows.record(group.first, r.wire, r.change) as? ExportRow.Opened
                    ?: throw PolarisException(ErrorCode.syncExportFailed, "A record changed while it was exported")
                val row = ExportOpened(r.id, again.row.version, again.row.value, null)
                zip.write(bytes(ExportLayout.line(row, lineFile[r])))
                count++
            }
            zip.end()
        }
        return count
    }
}

/** `cloudSync.export()`'s core: plans the archive, refusing before the first byte, then streams it into a sink. */
public object SyncExport {
    /**
     * Plans the archive, refusing with `sync-export-too-large` before the first byte, then writes it to [sink]. The caller
     * commits (or discards) the sink's destination once this returns or throws. A cancelled coroutine stops at its next step.
     */
    public suspend fun run(input: ExportInput, sink: ExportSink): ExportSummary {
        val rows = ExportRows(input.codec)
        val plan = ExportPlanner(input, rows).build()
        return ExportWriter(input, rows, plan, sink).write()
    }
}
