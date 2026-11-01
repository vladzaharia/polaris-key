// The pull half of the host codec, record rows (WIRE-CONTRACT-V5 section 13.10.4): a change or a conflict's server
// copy opened from one `ct` (a scalar value), sealed `fields` (a `merge` record) or sealed `elements` (a `union` record).

package im.plrs.key.core.sync

import im.plrs.key.core.arrayValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

internal class HostCodecRecordRows(private val codec: SyncCodecPort, recordKeys: Collection<Pair<String, String>>) {
    /** The records the machine holds, by `(collection, blinded id)`: where a sealed row carries no cell to name its id. */
    private val held: Map<Pair<String, String>, String> by lazy {
        recordKeys.mapNotNull { (c, id) -> HostRecord.ref(HostRecord.pair(c, id)) }
            .associate { (c, id) -> (c to codec.blind(SyncBlind.Kind.Record, c, id)) to id }
    }

    /** The sealed shape of a record row: one `ct`, sealed `fields`, sealed `elements`, none (`plain`), or null for a mix. */
    private fun shape(e: JsonObject): String? {
        val shapes = listOfNotNull(
            "ct".takeIf { e.containsKey("ct") },
            "fields".takeIf { e["fields"] is JsonArray },
            "elements".takeIf { e["elements"] is JsonArray },
        )
        return if (shapes.isEmpty()) "plain" else shapes.singleOrNull()
    }

    /**
     * A record change: `{record: [collection, id], ct | fields | elements, version}`. A plaintext row is legacy (the
     * machine checks its `seq` against `encryptionSince`). A sealed one needs a blinded id and opens only when the
     * `k` inside every envelope re-blinds to the names the row came under (HC-5); it then carries the plaintext id and
     * the opened value (a `merge` record's object, a `union` record's array in the served order).
     */
    fun change(c: JsonObject): OpenedEntry {
        val shape = shape(c)
        val ref = HostRecord.ref(c["record"])
        return when {
            shape == "plain" -> HostRow.plain(c)
            shape == null || ref == null || !SyncBlind.isBlindedName(ref.second) -> HostRow.invalid(c)
            shape == "ct" -> single(c, ref.first, ref.second)
            else -> cells(c, shape, ref.first, ref.second)
        }
    }

    private fun single(c: JsonObject, collection: String, served: String): OpenedEntry {
        val opened = HostRow.fromCt(c["ct"])?.let { codec.openAny(collection, it) as? SyncEnvelope.Opened.Ok }
        val honest = opened != null && opened.name.isNotEmpty() && !HostCodec.hasNul(opened.name) &&
            codec.blind(SyncBlind.Kind.Record, collection, opened.name) == served
        return if (honest) sealedRecord(c, collection, opened!!.name, opened.value) else HostRow.invalid(c)
    }

    private fun cells(c: JsonObject, shape: String, collection: String, served: String): OpenedEntry {
        val opened = openCells(c, shape, collection, null)
        val honest = opened != null && (opened.id == null || codec.blind(SyncBlind.Kind.Record, collection, opened.id) == served)
        // No cell names the record: the id comes from a record the machine holds, if any.
        return if (honest) sealedRecord(c, collection, opened!!.id ?: held[collection to served] ?: served, opened.value) else HostRow.invalid(c)
    }

    private fun sealedRecord(e: JsonObject, collection: String, id: String, value: JsonElement): OpenedEntry =
        HostRow.sealed(e, mapOf("record" to HostRecord.pair(collection, id), "value" to value))

    /** A conflict's server copy of the record [rec] of the mutation: opened under that id. */
    fun copy(e: JsonObject, rec: Pair<String, String>): OpenedEntry {
        val shape = shape(e)
        return when (shape) {
            "plain" -> HostRow.plain(e)

            null -> HostRow.invalid(e)

            "ct" -> HostRow.fromCt(e["ct"])?.let { codec.open(rec.first, rec.second, it, emptyList()) as? SyncEnvelope.Opened.Ok }
                ?.let { HostRow.sealed(e, mapOf("value" to it.value)) } ?: HostRow.invalid(e)

            else -> openCells(e, shape, rec.first, rec.second)?.let { HostRow.sealed(e, mapOf("value" to it.value)) } ?: HostRow.invalid(e)
        }
    }

    private class Cells(val id: String?, val value: JsonElement)

    private class Cell(val id: String, val name: String, val value: JsonElement)

    /**
     * Opens the sealed cells of a `merge` record (`fields`) or a `union` record (`elements`). Each envelope's `k` splits
     * at its first U+0000 into the id and the cell name; the cell's blinded name must be what the row carries (and, for
     * an element, the opened value must spell the name), and every cell must name the same id ([expectId], when the
     * caller knows it). `id` is null for a record with no cells.
     */
    private fun openCells(e: JsonObject, shape: String, collection: String, expectId: String?): Cells? {
        val kind = if (shape == "fields") SyncBlind.Kind.Field else SyncBlind.Kind.Element
        val opened = e[shape].arrayValue.orEmpty().map { openCell(it, kind, collection) }
        val cells = opened.filterNotNull()
        val ids = cells.map { it.id }.toSet()
        val valid = cells.size == opened.size && cells.map { it.name }.toSet().size == cells.size && ids.size <= 1 &&
            (expectId == null || ids.all { it == expectId })
        val value: JsonElement = if (kind ==
            SyncBlind.Kind.Field
        ) {
            JsonObject(cells.associate { it.name to it.value })
        } else {
            JsonArray(cells.map { it.value })
        }
        return if (valid) Cells(ids.singleOrNull() ?: expectId, value) else null
    }

    private fun openCell(cell: JsonElement, kind: SyncBlind.Kind, collection: String): Cell? {
        val co = cell as? JsonObject
        val wire = co?.get(kind.wire).stringValue?.takeIf { SyncBlind.isBlindedName(it) }
        val r = HostRow.fromCt(co?.get("ct"))?.let { codec.openAny(collection, it) as? SyncEnvelope.Opened.Ok }
        val cut = r?.name?.indexOf('\u0000') ?: -1
        val name = if (cut > 0) r!!.name.substring(cut + 1) else null
        val honest = wire != null && name != null && name.isNotEmpty() && !HostCodec.hasNul(name) &&
            codec.blind(kind, collection, name) == wire && (kind != SyncBlind.Kind.Element || spelled(r!!.value) == name)
        return if (honest) Cell(r!!.name.substring(0, cut), name!!, r.value) else null
    }

    private fun spelled(v: JsonElement): String? = try {
        CanonicalJson.encode(v)
    } catch (_: SyncCryptoException) {
        null
    }
}
