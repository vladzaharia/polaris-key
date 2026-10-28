// The pull half of the host codec, around the rows: tombstones and result lists (HC-1, HC-3).

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal

internal object HostCodecResults {
    /** A tombstone names an open key blinded; only the keys the machine already holds map back. */
    fun tombstones(list: List<JsonElement>, codec: SyncCodecPort, openKeys: Collection<String>): List<JsonElement> {
        val names = openKeys.associateBy { codec.blind(SyncBlind.Kind.Setting, HostCodec.SETTINGS_COLLECTION, it) }
        return list.map { t ->
            val to = t as? JsonObject
            val plain = to?.get("setting").stringValue?.let { names[it] }
            if (to != null && plain != null) JsonObject(to + ("setting" to JsonPrimitive(plain))) else t
        }
    }

    /**
     * A hashable identity for a served `mutationId`, as JavaScript's `Set` sees it (`1` and `true` differ;
     * `1` and `1.0` do not; an absent id and a `null` are the same).
     */
    private fun idKey(v: JsonElement?): String = when {
        v == null || v is JsonNull -> "null"
        v !is JsonPrimitive -> "j$v"
        v.isString -> "s${v.content}"
        v.content == "true" || v.content == "false" -> "b${v.content}"
        else -> "n" + (v.content.toBigDecimalOrNull()?.let { numberKey(it) } ?: v.content)
    }

    private fun numberKey(d: BigDecimal): String = if (d.signum() == 0) "0" else d.stripTrailingZeros().toPlainString()

    /** The id as an integer, when it is one (`1.0` is not: only an integer names a mutation). */
    private fun intId(v: JsonElement?): Long? = (v as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()

    /** The plaintext setting name of mutation [mid], or null when the host did not say. */
    private fun conflictSetting(ms: List<JsonElement>, mid: JsonElement?): String? {
        val id = intId(mid) ?: return null
        val m = ms.firstOrNull { (it as? JsonObject)?.get("mutationId")?.let(::intId) == id } as? JsonObject
        return m?.get("target").objectValue?.get("setting").stringValue
    }

    /** The cleaned results and the typed verdict of each conflict copy, by mutation id. */
    fun results(
        list: List<JsonElement>,
        rows: HostCodecOpen,
        mutations: List<JsonElement>,
        aliases: Map<String, String>,
    ): Pair<List<JsonElement>, Map<Long, OpenedRow?>> {
        val seen = hashSetOf<String>()
        val conflicts = linkedMapOf<Long, OpenedRow?>()
        val out = list.map { r ->
            val ro = r as? JsonObject ?: return@map r
            // One verdict per mutation. A second result for an id would overwrite the first verdict while the
            // machine reads the first body entry: fail closed (HC-1).
            if (!seen.add(idKey(ro["mutationId"]))) throw PolarisException(ErrorCode.syncFailed, "Cloud Sync answer repeats a mutationId")
            result(ro, rows, mutations, aliases, conflicts)
        }
        return out to conflicts
    }

    private fun result(
        ro: JsonObject,
        rows: HostCodecOpen,
        mutations: List<JsonElement>,
        aliases: Map<String, String>,
        conflicts: MutableMap<Long, OpenedRow?>,
    ): JsonElement {
        val clean = HostCodec.stripped(ro).toMutableMap()
        val from = conflictSetting(mutations, ro["mutationId"])
        // A rename is kept only for an alias the app declares.
        if (clean.containsKey("renamedTo") && !(from != null && aliases[from] == clean["renamedTo"].stringValue)) clean.remove("renamedTo")
        val server = ro["server"] as? JsonObject
        if (ro["status"].stringValue == "conflict" && server != null) {
            // Only a conflict for a mutation of this request opens: without one there is no name to open against.
            val (entry, row) = rows.copy(server, from)
            clean["server"] = entry
            intId(ro["mutationId"])?.let { conflicts[it] = row }
        }
        return JsonObject(clean)
    }
}
