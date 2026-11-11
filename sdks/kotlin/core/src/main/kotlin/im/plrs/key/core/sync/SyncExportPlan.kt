// The plan of an export (WIRE-CONTRACT-V5 section 13.12): every row opened, every file candidate chosen and checked,
// every manifest fetched and read, and every bound counted, before the first byte is written.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_EXPORT_ITEM_RESERVE_BYTES
import im.plrs.key.core.SYNC_EXPORT_MAX_BYTES
import im.plrs.key.core.SYNC_EXPORT_MAX_CHUNKS
import im.plrs.key.core.SYNC_EXPORT_MAX_ENTRIES
import im.plrs.key.core.SYNC_EXPORT_ZIP_END_BYTES
import im.plrs.key.core.SYNC_EXPORT_ZIP_ENTRY_BYTES
import im.plrs.key.core.arrayValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The five entries every archive holds: the README, `settings.json`, `files.json`, `index.json` and `data.json`. */
private const val FIXED_ENTRIES = 5

/** Each byte of a name can take six bytes of JSON in a worst case: twice in a pair of escapes. */
private const val NAME_BYTES_FACTOR = 6L

/** A record row that will be written. [pointer] is the live file's pointer; it is cleared when the row has no readable file. */
internal class PlanRow(
    val collection: String,
    /** The wire id, which keys the row's files. */
    val wire: String,
    /** The change as served: the row is opened again when its line is written. */
    val change: JsonObject,
    val opened: ExportOpened,
    /** Bytes of the line without its `file` member. */
    val lineBytes: Int,
) {
    val id: String get() = opened.id
    val binding: ExportBinding? get() = opened.binding
    var pointer: JsonObject? = ExportRows.pointerOf(change)
}

internal class PlanManifest(val records: List<SyncManifest.Record>, val plainSha256: ByteArray)

internal class PlanFile(
    val row: PlanRow,
    val ref: ExportFileRef,
    val file: JsonObject,
    val live: Boolean,
    val planned: Long,
    val manifest: PlanManifest?,
)

internal class PlanSkip(val kind: String, val collection: String?) {
    fun json(): JsonObject = buildJsonObject {
        put("kind", kind)
        collection?.let { put("collection", it) }
        put("code", if (kind == "file") "sync-file-invalid" else "invalid")
    }
}

/** The settings as written: their line, and how many opened. */
internal class PlanSettings(val line: ByteArray, val count: Int)

/** The file bytes and the zip32 total the plan counted. */
internal class PlanTotals(val fileBytes: Long, val plannedBytes: Long)

internal class ExportPlan(
    val settings: PlanSettings,
    val written: List<Pair<String, List<PlanRow>>>,
    val files: List<PlanFile>,
    val totals: PlanTotals,
    val names: List<String>,
    val skips: List<PlanSkip>,
)

internal fun tooLarge(what: String) = PolarisException(ErrorCode.syncExportTooLarge, "The export is too large: $what")

internal class ExportPlanner(private val input: ExportInput, private val rows: ExportRows) {
    private val maxEntries = input.caps?.maxEntries ?: SYNC_EXPORT_MAX_ENTRIES
    private val maxBytes = input.caps?.maxBytes ?: SYNC_EXPORT_MAX_BYTES
    private val settingSkips = ArrayList<PlanSkip>()
    private val recordSkips = ArrayList<PlanSkip>()
    private val written = ArrayList<Pair<String, List<PlanRow>>>()
    private val fileOnly = HashMap<String, Int>()
    private val files = ExportFilePlanner(input)
    private val changes = input.changes.filterIsInstance<JsonObject>()
    private val recordChanges = changes.mapNotNull { c -> refOf(c)?.let { it to c } }

    private fun refOf(c: JsonObject): Pair<String, String>? {
        val r = c["record"].arrayValue ?: return null
        val a = r.getOrNull(0).stringValue
        val b = r.getOrNull(1).stringValue
        return if (r.size >= 2 && a != null && b != null) a to b else null
    }

    suspend fun build(): ExportPlan {
        val named = changes.filter { it["setting"].stringValue != null }
        val settingChanges = named.sortedWith(compareBy(ExportJson.byBytes) { it["setting"].stringValue!! })
        val settings = openSettings(settingChanges)
        val collections = recordChanges.map { it.first.first }.toSet().sortedWith(ExportJson.byBytes)
        for (collection in collections) openCollection(collection)
        for (collection in collections) {
            files.plan(collection, fileOnly[collection] ?: 0, written.firstOrNull { it.first == collection }?.second ?: emptyList())
        }
        return finish(settings, settingChanges.size)
    }

    private suspend fun openSettings(settingChanges: List<JsonObject>): PlanSettings {
        val out = LinkedHashMap<String, JsonElement>()
        for (c in settingChanges) {
            currentCoroutineContext().ensureActive()
            val got = rows.setting(c)
            if (got == null || !ExportJson.serialisable(JsonPrimitive(got.first)) || !ExportJson.serialisable(got.second)) {
                settingSkips.add(PlanSkip("setting", null))
            } else {
                out[got.first] = got.second
            }
        }
        return PlanSettings(ExportJson.utf8(ExportJson.line(JsonObject(out))), out.size)
    }

    private suspend fun openCollection(collection: String) {
        val mine = recordChanges.filter { it.first.first == collection }.sortedWith(compareBy(ExportJson.byBytes) { it.first.second })
        val out = ArrayList<PlanRow>()
        for ((ref, c) in mine) {
            currentCoroutineContext().ensureActive()
            when (val r = rows.record(collection, ref.second, c)) {
                ExportRow.Omit -> Unit

                ExportRow.FileOnly -> fileOnly[collection] = (fileOnly[collection] ?: 0) + 1

                ExportRow.Invalid -> recordSkips.add(PlanSkip("record", collection))

                is ExportRow.Opened ->
                    if (writable(r.row)) out.add(planRow(collection, ref.second, c, r.row)) else recordSkips.add(PlanSkip("record", collection))
            }
        }
        out.sortWith(compareBy(ExportJson.byBytes) { it.id })
        if (out.isNotEmpty()) written.add(collection to out)
    }

    private fun writable(r: ExportOpened): Boolean =
        ExportJson.serialisable(JsonPrimitive(r.id)) && ExportJson.serialisable(r.version) && (r.value?.let { ExportJson.serialisable(it) } ?: true)

    private fun planRow(collection: String, wire: String, c: JsonObject, r: ExportOpened) =
        PlanRow(collection, wire, c, r, ExportJson.utf8Length(ExportLayout.line(r, null)))

    private fun finish(settings: PlanSettings, settingRows: Int): ExportPlan {
        val over = when {
            FIXED_ENTRIES + written.size + files.planned.size > maxEntries -> "too many entries"
            files.chunkTotal > SYNC_EXPORT_MAX_CHUNKS -> "too many chunks"
            else -> null
        }
        if (over != null) throw tooLarge(over)
        val fileBytes = fileBytes()
        val names = ExportLayout.names(written.size, files.planned.size)
        val overhead = names.sumOf { SYNC_EXPORT_ZIP_ENTRY_BYTES + 2L * ExportJson.utf8Length(it) } + SYNC_EXPORT_ZIP_END_BYTES
        val total = fileBytes + known(settings.line.size, settingRows) + overhead
        if (total > maxBytes) throw tooLarge("over the size limit")
        return ExportPlan(settings, written, files.planned, PlanTotals(fileBytes, total), names, settingSkips + recordSkips + files.skips)
    }

    /** The planned file bytes; each term and the sum stay safe integers because the sum stops at the cap. */
    private fun fileBytes(): Long {
        var sum = 0L
        for (p in files.planned) {
            sum += p.planned
            if (sum > maxBytes) throw tooLarge("files over the limit")
        }
        return sum
    }

    /** The bytes of the entries other than the files: exact for the small ones, a bound for `files.json` and `data.json`. */
    private fun known(settingsBytes: Int, settingRows: Int): Long {
        val reserve = SYNC_EXPORT_ITEM_RESERVE_BYTES.toLong()
        val live = files.planned.filter { it.live }.map { it.row }.toSet()
        var n = ExportJson.utf8Length(SYNC_EXPORT_README).toLong() + settingsBytes
        n += ExportJson.utf8Length(ExportLayout.index(written.map { it.first to it.second.size }))
        for ((_, rows) in written) for (r in rows) n += r.lineBytes + if (r in live) reserve else 0
        // files.json and data.json depend on what the reads find: they count at their bound.
        n += 2 + files.planned.size
        for (p in files.planned) n += reserve + NAME_BYTES_FACTOR * (ExportJson.utf8Length(p.row.collection) + ExportJson.utf8Length(p.row.id))
        n += reserve + reserve * settingRows
        for ((ref, _) in recordChanges) n += reserve + NAME_BYTES_FACTOR * ExportJson.utf8Length(ref.first)
        for (pc in files.pointerCollections) n += reserve + NAME_BYTES_FACTOR * ExportJson.utf8Length(pc)
        return n
    }
}
