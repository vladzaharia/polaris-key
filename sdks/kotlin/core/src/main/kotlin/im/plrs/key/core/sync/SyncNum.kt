// Number and text reads of served JSON: a finite number as a Long or Double, and how a JavaScript
// template literal spells a member.

package im.plrs.key.core.sync

import im.plrs.key.core.decimalValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object SyncNum {
    fun double(v: JsonElement?): Double? = if (SyncJson.isNumber(v)) v.decimalValue!!.toDouble() else null

    /** A finite JSON number as a Long (a fraction is cut), or null for anything else. */
    fun long(v: JsonElement?): Long? = if (SyncJson.isNumber(v)) v.decimalValue!!.toLong() else null

    /** How a JavaScript template literal would spell `r[name]` (the rejection code in an event). */
    fun jsString(r: JsonObject, name: String): String = when (val v = r[name]) {
        null -> "undefined"
        is JsonNull -> "null"
        is JsonPrimitive -> v.content
        else -> v.toString()
    }
}
