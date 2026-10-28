// Pure helpers of the Cloud Sync machine: the hybrid logical clock text, the schema subset a setting
// value must satisfy, and one operation applied to a value under a key's policy.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_HLC_PATTERN
import im.plrs.key.core.boolValue
import im.plrs.key.core.decimalValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val HLC_PHYSICAL_MAX = 0xFFFFFFFFFFFFL
private const val HLC_COUNTER_MAX = 0xFFFFL
private const val HLC_PHYSICAL_DIGITS = 12
private const val HLC_COUNTER_DIGITS = 4
private const val HEX = 16

internal object SyncValues {
    private val hlcPattern = Regex(SYNC_HLC_PATTERN)

    fun formatHlc(physicalMs: Long, counter: Long): String {
        require(physicalMs in 0..HLC_PHYSICAL_MAX) { "HLC physical part out of range" }
        require(counter in 0..HLC_COUNTER_MAX) { "HLC counter out of range" }
        return physicalMs.toString(HEX).padStart(HLC_PHYSICAL_DIGITS, '0') + ":" + counter.toString(HEX).padStart(HLC_COUNTER_DIGITS, '0')
    }

    fun parseHlc(hlc: String): Pair<Long, Long> {
        require(hlcPattern.containsMatchIn(hlc)) { "not an HLC" }
        return hlc.substring(0, HLC_PHYSICAL_DIGITS).toLong(HEX) to hlc.substring(HLC_PHYSICAL_DIGITS + 1).toLong(HEX)
    }

    private fun number(v: JsonElement?): Double? = SyncNum.double(v)

    /** Whether [value] satisfies the schema subset (an absent or empty schema: anything). */
    fun valueValid(value: JsonElement, schema: JsonObject?): Boolean {
        if (schema == null || schema.isEmpty()) return true
        val typeOk = when (schema["type"].stringValue) {
            "number", "integer" -> numberOk(value, schema)
            "string" -> value is JsonPrimitive && value.isString
            "boolean" -> value.boolValue != null
            "object" -> value is JsonObject
            else -> true
        }
        val enum = schema["enum"] as? JsonArray
        return typeOk && (enum == null || enum.any { SyncJson.jsonEqual(it, value) })
    }

    private fun numberOk(value: JsonElement, schema: JsonObject): Boolean {
        val d = number(value)
        val min = number(schema["minimum"])
        val max = number(schema["maximum"])
        val integerOk = schema["type"].stringValue != "integer" || SyncJson.isInteger(value)
        return d != null && integerOk && (min == null || d >= min) && (max == null || d <= max)
    }

    /** One setting operation applied to [base] under [policy]; null is "no value", `JsonNull` is a value. */
    fun applySettingOp(policy: String, base: JsonElement?, op: String, value: JsonElement?, member: String?): JsonElement? = when (op) {
        "clear" -> null
        "set" -> setValue(policy, base, value ?: JsonNull)
        "setMember" -> JsonObject(((base as? JsonObject) ?: JsonObject(emptyMap())) + (member!! to (value ?: JsonNull)))
        "removeMember" -> JsonObject(((base as? JsonObject) ?: JsonObject(emptyMap())) - member!!)
        else -> base
    }

    private fun setValue(policy: String, base: JsonElement?, v: JsonElement): JsonElement {
        val b = number(base)
        val n = number(v)
        val decides = policy == "max" || policy == "min"
        if (decides && b != null && n != null) {
            val takeNew = if (policy == "max") n > b else n < b
            return if (takeNew) v else base!!
        }
        return v
    }

    /** One record operation applied to a value. */
    fun applyRecordOp(base: JsonElement?, op: Op): JsonElement? = when (op.op) {
        "set" -> op.value ?: JsonNull
        "setMember", "removeMember" -> applySettingOp("merge", base, op.op, op.value, op.member)
        "add" -> addTo((base as? JsonArray) ?: JsonArray(emptyList()), op.element!!)
        "remove" -> JsonArray(((base as? JsonArray) ?: JsonArray(emptyList())).filterNot { SyncJson.jsonEqual(it, op.element) })
        else -> base
    }

    private fun addTo(arr: JsonArray, element: JsonElement): JsonArray =
        if (arr.any { SyncJson.jsonEqual(it, element) }) arr else JsonArray(arr + element)

    fun objectOf(v: JsonElement?): JsonObject = v.objectValue ?: JsonObject(emptyMap())
}
