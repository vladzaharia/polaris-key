// The record references of the host codec: which `[collection, id]` pair can name a record, and the pair as JSON.

package im.plrs.key.core.sync

import im.plrs.key.core.arrayValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

internal object HostRecord {
    /**
     * `(collection, id)` when [v] is a pair of non-empty strings that can name a record: no U+0000 (the blind
     * input has no length prefix) and not the settings collection's namespace (`$`), or null.
     */
    fun ref(v: JsonElement?): Pair<String, String>? {
        val a = v.arrayValue?.takeIf { it.size == 2 } ?: return null
        val c = a[0].stringValue
        val id = a[1].stringValue
        val usable =
            c != null && id != null && c.isNotEmpty() && id.isNotEmpty() && !HostCodec.hasNul(c) && !HostCodec.hasNul(id) && !c.startsWith("$")
        return if (usable) c!! to id!! else null
    }

    fun pair(collection: String, id: String): JsonArray = JsonArray(listOf(JsonPrimitive(collection), JsonPrimitive(id)))
}
