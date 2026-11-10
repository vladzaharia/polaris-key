// Opening the rows of an export (WIRE-CONTRACT-V5 section 13.12): a setting or a record as the Worker served it, opened
// exactly as the host codec opens a pull (section 13.10.4), so a row that does not open is never trusted. Server mode
// reads the plaintext as served.

package im.plrs.key.core.sync

import im.plrs.key.core.arrayValue
import im.plrs.key.core.decimalValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal

/** The sealed `$file` binding of a record: the file a reader must use (section 13.10.4). */
internal class ExportBinding(val sha256: String, val size: Long, val format: String) {
    /** Whether the binding names this pointer's file. */
    fun names(f: JsonObject): Boolean {
        val size = f["size"].decimalValue
        return f["sha256"].stringValue == sha256 && ExportJson.isNumber(f["size"]) && size != null &&
            size.compareTo(BigDecimal.valueOf(this.size)) == 0 && f["format"].stringValue == format
    }

    companion object {
        /** The binding a sealed `$file` value spells, or null when it names no file a reader can use. */
        fun of(raw: JsonElement?): ExportBinding? {
            val o = raw.objectValue ?: return null
            val sha = o["sha256"]
            val size = ExportJson.sizeOf(o["size"])
            val format = o["format"].stringValue
            val usable = ExportJson.isHex64(sha) && size != null && size != 0L && (format == "whole" || format == "chunks")
            return if (usable) ExportBinding(sha.stringValue!!, size!!, format!!) else null
        }
    }
}

/** One record row opened: [value] is null when the row has none (a JSON null is a value). */
internal class ExportOpened(val id: String, val version: JsonElement, val value: JsonElement?, val binding: ExportBinding?)

/** What a record row came to. */
internal sealed interface ExportRow {
    class Opened(val row: ExportOpened) : ExportRow

    /** An end-to-end `merge` or `union` record with no cells reveals no id: omitted, unlisted. */
    data object Omit : ExportRow

    /** A file and no value: nothing names the id, nothing binds the file. */
    data object FileOnly : ExportRow

    data object Invalid : ExportRow
}

internal class ExportRows(private val codec: SyncCodecPort?) {
    /** The change as the host codec opens a pull, or null when it does not open. */
    private fun viaPull(c: JsonObject): JsonObject? {
        val pulled = HostCodec.openPull(JsonObject(mapOf("changes" to JsonArray(listOf(c)))), codec!!)
        if (pulled.opened.changes.firstOrNull()?.sealed != true) return null
        return (pulled.body as? JsonObject)?.get("changes").arrayValue?.firstOrNull().objectValue
    }

    /** The setting's served name and value, or null when the row does not open. */
    fun setting(c: JsonObject): Pair<String, JsonElement>? = if (codec == null) plainSetting(c) else sealedSetting(c)

    private fun plainSetting(c: JsonObject): Pair<String, JsonElement>? {
        val wire = c["setting"].stringValue!!
        val members = c["members"]
        return if (members is JsonObject) wire to members else c["value"]?.let { wire to it }
    }

    private fun sealedSetting(c: JsonObject): Pair<String, JsonElement>? {
        val sealed = c.containsKey("ct") || c["members"] is JsonArray
        val e = if (sealed) viaPull(c) else null
        val name = e?.get("setting").stringValue
        return if (name == null) null else e?.get("value")?.let { name to it }
    }

    /** The record row [c] of [collection] under the wire id [wire]. */
    fun record(collection: String, wire: String, c: JsonObject): ExportRow {
        val version = c["version"] ?: JsonNull
        val empty = listOf("fields", "elements").any { c[it].arrayValue?.isEmpty() == true }
        return when {
            codec == null -> ExportRow.Opened(ExportOpened(wire, version, c["value"], null))
            empty -> ExportRow.Omit
            sealedShape(c) -> opened(collection, c, version)
            !c.containsKey("ct") && pointerOf(c) != null -> ExportRow.FileOnly
            else -> ExportRow.Invalid
        }
    }

    private fun sealedShape(c: JsonObject): Boolean = c["fields"] is JsonArray || c["elements"] is JsonArray || c["ct"].stringValue != null

    private fun opened(collection: String, c: JsonObject, version: JsonElement): ExportRow {
        val e = viaPull(c)
        val ref = e?.get("record").arrayValue
        val id = ref?.getOrNull(1).stringValue
        val honest = ref != null && ref.size >= 2 && ref[0].stringValue == collection && id != null
        val value = e?.get("value")
        if (!honest || value == null) return ExportRow.Invalid
        val bound = c["ct"].stringValue != null && value is JsonObject && value.containsKey(FILE_KEY)
        val shown = if (bound) JsonObject((value as JsonObject) - FILE_KEY) else value
        val binding = if (bound) ExportBinding.of((value as JsonObject)[FILE_KEY]) else null
        return ExportRow.Opened(ExportOpened(id!!, version, shown, binding))
    }

    companion object {
        const val FILE_KEY = "\$file"

        /** The row's file pointer: an object with a numeric version. */
        fun pointerOf(c: JsonObject): JsonObject? = c["file"].objectValue?.takeIf { ExportJson.isNumber(it["version"]) }
    }
}
