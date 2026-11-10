// The layout of an export (WIRE-CONTRACT-V5 section 13.12): the fixed README, the entry names in contract order, the
// record line and the index. Names are numbered by position, so a name never holds a person's or the Worker's text.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_EXPORT_STORE_DIR
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The fixed text of `README.txt`: ASCII, LF, no interpolation; `exportCases` pins it. */
public const val SYNC_EXPORT_README: String = """This is a readable copy of data an app synced with Polaris Locker.

The app made it on this device. It is NOT encrypted: anyone who can open
this file can read everything in it. Keep it where you keep your other
private files, and delete it when you no longer need it. The time it was
made is "exportedAt" in data.json, in milliseconds since 1970-01-01 UTC.

Polaris Locker's own export of this data, from its website, uses the same
layout and holds the data as the app stored it: encrypted when the app
encrypts it.

data.json                              what this holds, and what could not be read
stores/sync.cloudSync/settings.json    the synced settings
stores/sync.cloudSync/records/         the synced records, one file a collection
stores/sync.cloudSync/index.json       which file holds which collection
stores/sync.cloudSync/files/           the synced files
stores/sync.cloudSync/files.json       which file belongs to which record

A file marked "partial" in data.json is incomplete or did not match what
the app stored. Do not rely on it.
"""

internal object ExportLayout {
    val dir: String = SYNC_EXPORT_STORE_DIR

    fun recordsName(i: Int) = "${dir}records/$i.ndjson"

    fun fileName(i: Int) = "${dir}files/$i.bin"

    val settingsName: String = dir + "settings.json"
    val filesName: String = dir + "files.json"
    val indexName: String = dir + "index.json"

    /** The entries in the order of the contract. */
    fun names(records: Int, files: Int): List<String> =
        listOf("README.txt", settingsName) + List(records) { recordsName(it) } + List(files) { fileName(it) } +
            listOf(filesName, indexName, "data.json")

    /** The index line: which entry holds which collection, and how many records. */
    fun index(listing: List<Pair<String, Int>>): String = ExportJson.line(
        buildJsonObject {
            put("records", JsonArray(listing.mapIndexed { i, (c, n) -> item(recordsName(i), c, n) }))
        },
    )

    private fun item(entry: String, collection: String, count: Int): JsonObject = buildJsonObject {
        put("entry", entry)
        put("collection", collection)
        put("count", count)
    }

    /** One record's line: `{id, version, value?, file?}`; [id] overrides the opened id (the id the plan kept). */
    fun line(r: ExportOpened, file: JsonObject?): String = ExportJson.line(
        buildJsonObject {
            put("id", r.id)
            put("version", r.version)
            r.value?.let { put("value", it) }
            file?.let { put("file", it) }
        },
    )

    /** What the archive holds of a file, as the record's `file` member and as a `files.json` item. */
    fun facts(entry: String, version: JsonElement, got: FileResult, expected: Long): JsonObject = buildJsonObject {
        put("entry", entry)
        put("version", version)
        put("size", got.size)
        put("sha256", got.sha256)
        if (got.partial) {
            put("partial", true)
            put("expectedSize", expected)
        }
    }
}
