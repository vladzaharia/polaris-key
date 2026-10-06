// The served catalog (`GET /<p>/config/schema`) as types, for settings UIs and for validating a
// local override before it is persisted (notes/SDK-PARITY-PASS.md §3.11). The catalog is UNSIGNED
// display metadata: it never decides what a key resolves to (the verified config document and the
// override layers do), only how a settings row is drawn and what a user may type into it.

package im.plrs.key.config

import im.plrs.key.core.JsonText
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.math.BigDecimal
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One catalog entry. */
public data class CatalogEntry(
    val key: String,
    /** `config`, `secret` or `flag`. */
    val kind: String,
    val label: String?,
    val description: String?,
    val category: String?,
    /** The Draft-07-subset schema fragment. */
    val schema: JsonObject,
    /** The catalog's widget hint (`select`, `toggle`, `slider`, …), or null. */
    val widget: String?,
) {
    /** The schema's `type` (`string`, `boolean`, `integer`, `number`, `object`, `array`), or null. */
    val type: String? get() = schema["type"].stringValue

    /** The schema's `enum` values, or null. */
    val enumValues: List<JsonElement>? get() = schema["enum"].arrayValue

    /** Why [value] does not fit this entry's schema (type, enum, bounds, lengths), or null when it fits. */
    public fun problem(value: JsonElement): String? {
        val p = value as? JsonPrimitive
        when (type) {
            "boolean" -> if (p == null || p.isString || p.content !in setOf("true", "false")) return "$key takes true or false"
            "string" -> if (p == null || !p.isString) return "$key takes a string"
            "integer" -> if (p == null || p.isString || p.content.toBigDecimalOrNull()?.let { it.stripTrailingZeros().scale() <= 0 } != true) return "$key takes a whole number"
            "number" -> if (p == null || p.isString || p.content.toBigDecimalOrNull() == null) return "$key takes a number"
            "array" -> if (value !is kotlinx.serialization.json.JsonArray) return "$key takes a list"
            "object" -> if (value !is JsonObject) return "$key takes an object"
        }
        enumValues?.let { allowed -> if (allowed.none { it == value }) return "$key takes one of ${allowed.joinToString(", ")}" }
        val n = if (p != null && !p.isString) p.content.toBigDecimalOrNull() else null
        if (n != null) {
            num("minimum")?.let { if (n < it) return "$key is at least $it" }
            num("maximum")?.let { if (n > it) return "$key is at most $it" }
        }
        if (p != null && p.isString) {
            val len = p.content.codePointCount(0, p.content.length).toLong()
            schema["minLength"].longValue?.let { if (len < it) return "$key is at least $it characters" }
            schema["maxLength"].longValue?.let { if (len > it) return "$key is at most $it characters" }
        }
        return null
    }

    private fun num(name: String): BigDecimal? = (schema[name] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBigDecimalOrNull()
}

/** A parsed catalog. */
public data class Catalog(val schemaVersion: Long?, val entries: List<CatalogEntry>) {
    public fun entry(key: String): CatalogEntry? = entries.firstOrNull { it.key == key }

    public companion object {
        /** The served catalog, or null when it is not one. Entries without a key are skipped. */
        public fun parse(bytes: ByteArray): Catalog? {
            val o = JsonText.parseOrNull(bytes.toString(Charsets.UTF_8)).objectValue ?: return null
            val entries = o["entries"].arrayValue ?: return null
            return Catalog(
                o["schemaVersion"].longValue,
                entries.mapNotNull { e ->
                    val x = e.objectValue ?: return@mapNotNull null
                    CatalogEntry(
                        key = x["key"].stringValue ?: return@mapNotNull null,
                        kind = x["kind"].stringValue ?: "config",
                        label = x["label"].stringValue,
                        description = x["description"].stringValue,
                        category = x["category"].stringValue,
                        schema = x["schema"].objectValue ?: JsonObject(emptyMap()),
                        widget = x["ui"].objectValue?.get("widget").stringValue,
                    )
                },
            )
        }
    }
}

/** Whether two JSON values have the same JSON type (the fallback check without a catalog). */
internal fun sameJsonType(a: JsonElement, b: JsonElement): Boolean {
    fun kind(v: JsonElement): String = when {
        v is JsonNull -> "null"
        v is JsonObject -> "object"
        v is kotlinx.serialization.json.JsonArray -> "array"
        v is JsonPrimitive && v.isString -> "string"
        v is JsonPrimitive && (v.content == "true" || v.content == "false") -> "boolean"
        else -> "number"
    }
    return kind(a) == kind(b) || kind(a) == "null" || kind(b) == "null"
}
