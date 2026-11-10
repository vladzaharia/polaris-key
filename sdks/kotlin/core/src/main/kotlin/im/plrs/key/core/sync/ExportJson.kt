// The JSON and text helpers of the export (WIRE-CONTRACT-V5 section 13.12): the canonical line, what a row can be
// written as, a pointer's size, and names in the byte order of their UTF-8.

package im.plrs.key.core.sync

import im.plrs.key.core.MAX_JSON_DEPTH
import im.plrs.key.core.decimalValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal

/** The largest integer every SDK holds exactly: 2^53 - 1. */
private const val MAX_SAFE_SIZE = (1L shl 53) - 1
private const val HEX64_LENGTH = 64

internal object ExportJson {
    /** Canonical JSON (section 13.10.3) and a single `\n`. Throws [SyncCryptoException] for a value the contract refuses. */
    fun line(v: JsonElement): String = CanonicalJson.encode(v) + "\n"

    /** Whether nesting stays within `MAX_JSON_DEPTH`, counted from the value's own outermost array or object as level 1. */
    private fun shallow(v: JsonElement, level: Int): Boolean = when (v) {
        is JsonObject -> level <= MAX_JSON_DEPTH && v.values.all { shallow(it, level + 1) }
        is JsonArray -> level <= MAX_JSON_DEPTH && v.all { shallow(it, level + 1) }
        else -> true
    }

    /** Whether the canonical form can spell [v]: finite numbers, no lone surrogate, at most 64 levels. */
    fun serialisable(v: JsonElement): Boolean = shallow(v, 1) && runCatching { CanonicalJson.encode(v) }.isSuccess

    /** A pointer's size when it is a non-negative safe integer (a JSON number, not a string, a fraction or null), else null. */
    fun sizeOf(v: JsonElement?): Long? {
        val d: BigDecimal = (if (isNumber(v)) v.decimalValue else null) ?: return null
        val whole = d.stripTrailingZeros().scale() <= 0
        return if (whole && d.signum() >= 0 && d <= BigDecimal.valueOf(MAX_SAFE_SIZE)) d.toLong() else null
    }

    fun isHex64(v: JsonElement?): Boolean {
        val text = (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
        return text.length == HEX64_LENGTH && text.all { it in "0123456789abcdef" }
    }

    /** A JSON number (a boolean and a string are not). */
    fun isNumber(v: JsonElement?): Boolean = SyncJson.isNumber(v) && v is JsonPrimitive && !v.isString

    /** The UTF-8 bytes of [s] as a JavaScript text encoder writes them: a lone surrogate is U+FFFD. */
    fun utf8(s: String): ByteArray {
        val b = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            val pair = Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])
            when {
                pair -> b.append(c).append(s[++i])
                Character.isSurrogate(c) -> b.append('\uFFFD')
                else -> b.append(c)
            }
            i++
        }
        return b.toString().toByteArray(Charsets.UTF_8)
    }

    fun utf8Length(s: String): Int = utf8(s).size

    /** Names in the byte order of their UTF-8 (code point order). */
    val byBytes: Comparator<String> = Comparator { a, b -> java.util.Arrays.compareUnsigned(utf8(a), utf8(b)) }
}
