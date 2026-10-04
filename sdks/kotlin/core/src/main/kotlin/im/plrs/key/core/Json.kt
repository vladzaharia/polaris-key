// JSON for the wire — WIRE-CONTRACT-V4 §1.2, §3 and WIRE-CONTRACT-V3 §10.
//
// The tree type is kotlinx.serialization's `JsonElement`, so later modules and hosts share one
// JSON vocabulary. The PARSING is this file's, never the library's: the rules a verdict depends on
// (duplicate member names are refused, never first- or last-wins; names compare by Unicode scalar
// values, never by canonical equivalence; a name holding U+0000 is refused; every number is judged
// from its digits; nesting is capped at `MAX_JSON_DEPTH`) are the corpus's, and a library parser
// would silently pick one of the behaviours the audit found SDKs disagreeing on (R2-06).
//
// Numbers keep their source token (`JsonUnquotedLiteral`), so `1.0` and `1` stay distinguishable
// and an integer claim is decided from its token (`wireInteger`), never from a double.
//
// Two entry points:
//
//   StrictJson.validate(bytes)  the JWS header and payload parser: one top-level object, V4 §1.2
//                               rules 1–9, and the payload's non-wire-integer pointers.
//   JsonText.parse(text)        RFC 8259 for everything else (discovery documents, HTTP bodies,
//                               the corpus files): any top-level value, a duplicate name keeps
//                               the LAST member as `JSON.parse` does.

@file:OptIn(ExperimentalSerializationApi::class)

package im.plrs.key.core

import java.math.BigDecimal
import java.math.BigInteger
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral

/**
 * The RFC 6901 pointers of a payload's number tokens that cannot be wire integers (a fraction or
 * exponent part, or digits above 2^53 − 1).
 *
 * Held as a tree of raw (unescaped) reference tokens, one node per container on the way to a
 * recorded number, so the set stays linear in the capped payload however long the member names
 * are (V4 §1.2). [contains] walks the tree; [pointers] builds the escaped pointers for callers
 * that list them (the conformance runner).
 */
public class NonWireIntegers private constructor(
    private val parent: MutableList<Int>,
    private val names: MutableList<String>,
    private val leaf: MutableList<Boolean>,
    private val edges: MutableMap<Pair<Int, String>, Int>,
    private val leaves: MutableList<Int>,
) {
    public constructor() : this(mutableListOf(-1), mutableListOf(""), mutableListOf(false), HashMap(), mutableListOf())

    internal fun child(node: Int, name: String): Int {
        val key = node to name
        edges[key]?.let { return it }
        val id = parent.size
        parent += node
        names += name
        leaf += false
        edges[key] = id
        return id
    }

    internal fun add(node: Int) {
        if (leaf[node]) return
        leaf[node] = true
        leaves += node
    }

    public val size: Int get() = leaves.size
    public fun isEmpty(): Boolean = leaves.isEmpty()

    /** True when [pointer] (escaped) names a recorded number. */
    public operator fun contains(pointer: String): Boolean {
        val tokens = tokens(pointer) ?: return false
        var node = 0
        for (t in tokens) node = edges[node to t] ?: return false
        return leaf[node]
    }

    /** Every pointer, escaped. */
    public val pointers: Set<String>
        get() {
            val out = HashSet<String>()
            for (n in leaves) {
                val parts = ArrayList<String>()
                var k = n
                while (k > 0) {
                    parts += escape(names[k])
                    k = parent[k]
                }
                out += parts.asReversed().joinToString("") { "/$it" }
            }
            return out
        }

    override fun equals(other: Any?): Boolean = other is NonWireIntegers && other.pointers == pointers

    override fun hashCode(): Int = pointers.hashCode()

    override fun toString(): String = pointers.sorted().toString()

    public companion object {
        /** A set from escaped pointer strings (an invalid pointer is skipped). */
        public fun of(vararg pointers: String): NonWireIntegers {
            val set = NonWireIntegers()
            for (p in pointers) {
                val tokens = tokens(p) ?: continue
                var node = 0
                for (t in tokens) node = set.child(node, t)
                set.add(node)
            }
            return set
        }

        /** RFC 6901: split an escaped pointer into raw tokens, or null when it is not one. */
        internal fun tokens(pointer: String): List<String>? {
            if (pointer.isEmpty()) return emptyList()
            if (pointer[0] != '/') return null
            val out = ArrayList<String>()
            val current = StringBuilder()
            var k = 1
            while (k < pointer.length) {
                val c = pointer[k]
                when (c) {
                    '/' -> {
                        out += current.toString()
                        current.setLength(0)
                    }
                    '~' -> {
                        if (k + 1 >= pointer.length) return null
                        when (pointer[k + 1]) {
                            '0' -> current.append('~')
                            '1' -> current.append('/')
                            else -> return null
                        }
                        k++
                    }
                    else -> current.append(c)
                }
                k++
            }
            out += current.toString()
            return out
        }

        internal fun escape(name: String): String = name.replace("~", "~0").replace("/", "~1")
    }
}

/**
 * WIRE-CONTRACT-V4 §3: an integer claim is a plain integer token from the claim's minimum to
 * 2^53 − 1, decided from the token ([pointer] must not be in [nonWire]).
 */
public fun wireInteger(value: Long?, pointer: String, min: Long, nonWire: NonWireIntegers): Boolean {
    if (value == null) return false
    if (pointer in nonWire) return false
    return value >= min && value <= MAX_WIRE_INTEGER
}

/** The result of [StrictJson.validate]: the parsed object and its non-wire-integer pointers. */
public class StrictParse(public val value: JsonObject, public val nonWireIntegers: NonWireIntegers)

/** The JWS header and payload parser (V4 §1.2). */
public object StrictJson {
    /** Validate one header or payload byte for byte; null when it is refused. */
    public fun validate(bytes: ByteArray): StrictParse? = StrictScanner(bytes).run()

    /**
     * V4 §1.2 rule 8: a number token is in range when its exponent part has at most six
     * significant digits and the number is zero or its first non-zero digit's power of ten is
     * from -307 to 307. Judged from the digits, with no floating point.
     */
    public fun numberTokenInRange(t: ByteArray, from: Int = 0, to: Int = t.size): Boolean {
        var i = from
        fun digit(k: Int) = k < to && t[k] >= '0'.code.toByte() && t[k] <= '9'.code.toByte()
        if (i < to && t[i] == '-'.code.toByte()) i++
        var intDigits = 0
        var leadingZeros = 0
        var sawNonZero = false
        while (digit(i)) {
            if (!sawNonZero) {
                if (t[i] == '0'.code.toByte()) leadingZeros++ else sawNonZero = true
            }
            intDigits++
            i++
        }
        if (i < to && t[i] == '.'.code.toByte()) {
            i++
            while (digit(i)) {
                if (!sawNonZero) {
                    if (t[i] == '0'.code.toByte()) leadingZeros++ else sawNonZero = true
                }
                i++
            }
        }
        var exponent = 0
        if (i < to && (t[i] == 'e'.code.toByte() || t[i] == 'E'.code.toByte())) {
            i++
            var negative = false
            if (i < to && (t[i] == '+'.code.toByte() || t[i] == '-'.code.toByte())) {
                negative = t[i] == '-'.code.toByte()
                i++
            }
            var significant = 0
            while (digit(i)) {
                val d = t[i] - '0'.code.toByte()
                if (significant > 0 || d != 0) {
                    significant++
                    if (significant > MAX_EXPONENT_DIGITS) return false
                    exponent = exponent * 10 + d
                }
                i++
            }
            if (negative) exponent = -exponent
        }
        if (!sawNonZero) return true
        val power = intDigits - 1 - leadingZeros + exponent
        return power >= -MAX_DECIMAL_EXPONENT && power <= MAX_DECIMAL_EXPONENT
    }

    private const val MAX_DECIMAL_EXPONENT = 307
    private const val MAX_EXPONENT_DIGITS = 6
}

private class StrictScanner(private val b: ByteArray) {
    private var i = 0
    private val nonWire = NonWireIntegers()

    // The open path: one segment per level, and its node in `nonWire` once a number below it
    // has been recorded (-1 until then).
    private val segs = ArrayList<String>()
    private val ids = ArrayList<Int>()

    fun run(): StrictParse? {
        ws()
        if (i >= b.size || b[i] != '{'.code.toByte()) return null
        val value = value(0) ?: return null
        ws()
        return if (i == b.size) StrictParse(value as JsonObject, nonWire) else null
    }

    private fun record() {
        var k = segs.size - 1
        while (k >= 0 && ids[k] < 0) k--
        var node = if (k < 0) 0 else ids[k]
        var j = k + 1
        while (j < segs.size) {
            node = nonWire.child(node, segs[j])
            ids[j] = node
            j++
        }
        nonWire.add(node)
    }

    private fun ws() {
        while (i < b.size) {
            val c = b[i].toInt()
            if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) i++ else break
        }
    }

    private fun value(depth: Int): JsonElement? {
        ws()
        if (i >= b.size) return null
        val c = b[i].toInt()
        if (c == '{'.code) {
            if (depth + 1 > MAX_JSON_DEPTH) return null
            i++
            ws()
            val members = LinkedHashMap<String, JsonElement>()
            if (i < b.size && b[i] == '}'.code.toByte()) {
                i++
                return JsonObject(members)
            }
            while (true) {
                ws()
                val name = string() ?: return null
                if (name.indexOf('\u0000') >= 0) return null
                if (members.containsKey(name)) return null
                ws()
                if (i >= b.size || b[i] != ':'.code.toByte()) return null
                i++
                segs += name
                ids += -1
                val v = value(depth + 1) ?: return null
                segs.removeAt(segs.size - 1)
                ids.removeAt(ids.size - 1)
                members[name] = v
                ws()
                if (i >= b.size) return null
                if (b[i] == ','.code.toByte()) {
                    i++
                    continue
                }
                if (b[i] == '}'.code.toByte()) {
                    i++
                    return JsonObject(members)
                }
                return null
            }
        }
        if (c == '['.code) {
            if (depth + 1 > MAX_JSON_DEPTH) return null
            i++
            ws()
            val items = ArrayList<JsonElement>()
            if (i < b.size && b[i] == ']'.code.toByte()) {
                i++
                return JsonArray(items)
            }
            var index = 0
            while (true) {
                segs += index.toString()
                ids += -1
                val v = value(depth + 1) ?: return null
                segs.removeAt(segs.size - 1)
                ids.removeAt(ids.size - 1)
                items += v
                index++
                ws()
                if (i >= b.size) return null
                if (b[i] == ','.code.toByte()) {
                    i++
                    continue
                }
                if (b[i] == ']'.code.toByte()) {
                    i++
                    return JsonArray(items)
                }
                return null
            }
        }
        if (c == '"'.code) return string()?.let { JsonPrimitive(it) }
        if (c == '-'.code || (c >= 0x30 && c <= 0x39)) return number()
        for ((lit, v) in LITERALS) {
            if (i + lit.size <= b.size && (lit.indices).all { b[i + it] == lit[it] }) {
                i += lit.size
                return v
            }
        }
        return null
    }

    private fun hex4(): Int? {
        if (i + 4 > b.size) return null
        var v = 0
        for (k in 0 until 4) {
            val c = b[i + k].toInt()
            val d = when (c) {
                in 0x30..0x39 -> c - 0x30
                in 0x41..0x46 -> c - 0x41 + 10
                in 0x61..0x66 -> c - 0x61 + 10
                else -> return null
            }
            v = v * 16 + d
        }
        i += 4
        return v
    }

    /** One string: refuses raw control characters, bad escapes, lone surrogates and ill-formed UTF-8. */
    private fun string(): String? {
        if (i >= b.size || b[i] != '"'.code.toByte()) return null
        i++
        val out = StringBuilder()
        while (true) {
            if (i >= b.size) return null
            val c = b[i].toInt() and 0xff
            if (c == '"'.code) {
                i++
                return out.toString()
            }
            if (c < 0x20) return null
            if (c == '\\'.code) {
                i++
                if (i >= b.size) return null
                val e = b[i].toInt()
                i++
                when (e) {
                    '"'.code -> out.append('"')
                    '\\'.code -> out.append('\\')
                    '/'.code -> out.append('/')
                    'b'.code -> out.append('\b')
                    'f'.code -> out.append('\u000C')
                    'n'.code -> out.append('\n')
                    'r'.code -> out.append('\r')
                    't'.code -> out.append('\t')
                    'u'.code -> {
                        val u = hex4() ?: return null
                        if (u in 0xD800..0xDBFF) {
                            if (i + 2 > b.size || b[i] != '\\'.code.toByte() || b[i + 1] != 'u'.code.toByte()) {
                                return null
                            }
                            i += 2
                            val low = hex4() ?: return null
                            if (low !in 0xDC00..0xDFFF) return null
                            out.append(u.toChar()).append(low.toChar())
                        } else if (u in 0xDC00..0xDFFF) {
                            return null
                        } else {
                            out.append(u.toChar())
                        }
                    }
                    else -> return null
                }
                continue
            }
            if (c < 0x80) {
                out.append(c.toChar())
                i++
                continue
            }
            val cp = utf8Scalar() ?: return null
            out.appendCodePoint(cp)
        }
    }

    /** One multi-byte UTF-8 sequence, strictly (RFC 3629 Table 3-7). */
    private fun utf8Scalar(): Int? {
        val c = b[i].toInt() and 0xff
        var lo = 0x80
        var hi = 0xBF
        val need: Int
        var cp: Int
        when (c) {
            in 0xC2..0xDF -> { need = 1; cp = c and 0x1F }
            0xE0 -> { need = 2; lo = 0xA0; cp = c and 0x0F }
            in 0xE1..0xEC, in 0xEE..0xEF -> { need = 2; cp = c and 0x0F }
            0xED -> { need = 2; hi = 0x9F; cp = c and 0x0F }
            0xF0 -> { need = 3; lo = 0x90; cp = c and 0x07 }
            in 0xF1..0xF3 -> { need = 3; cp = c and 0x07 }
            0xF4 -> { need = 3; hi = 0x8F; cp = c and 0x07 }
            else -> return null
        }
        if (i + need >= b.size) return null
        for (k in 1..need) {
            val x = b[i + k].toInt() and 0xff
            val min = if (k == 1) lo else 0x80
            val max = if (k == 1) hi else 0xBF
            if (x < min || x > max) return null
            cp = (cp shl 6) or (x and 0x3F)
        }
        i += need + 1
        return cp
    }

    private fun number(): JsonElement? {
        val start = i
        fun digit(k: Int) = k < b.size && b[k] >= 0x30 && b[k] <= 0x39
        if (b[i] == '-'.code.toByte()) i++
        if (!digit(i)) return null
        if (b[i] == 0x30.toByte()) i++ else while (digit(i)) i++
        var plain = true
        if (i < b.size && b[i] == '.'.code.toByte()) {
            plain = false
            i++
            if (!digit(i)) return null
            while (digit(i)) i++
        }
        if (i < b.size && (b[i] == 'e'.code.toByte() || b[i] == 'E'.code.toByte())) {
            plain = false
            i++
            if (i < b.size && (b[i] == '+'.code.toByte() || b[i] == '-'.code.toByte())) i++
            if (!digit(i)) return null
            while (digit(i)) i++
        }
        if (!StrictJson.numberTokenInRange(b, start, i)) return null
        val token = String(b, start, i - start, Charsets.US_ASCII)
        val digits = token.removePrefix("-")
        val tooBig = digits.length > MAX_WIRE_DIGITS.length ||
            (digits.length == MAX_WIRE_DIGITS.length && digits > MAX_WIRE_DIGITS)
        if (!plain || tooBig) record()
        return JsonUnquotedLiteral(token)
    }

    companion object {
        const val MAX_WIRE_DIGITS = "9007199254740991"
        val LITERALS: List<Pair<ByteArray, JsonElement>> = listOf(
            "true".toByteArray() to JsonPrimitive(true),
            "false".toByteArray() to JsonPrimitive(false),
            "null".toByteArray() to JsonNull,
        )
    }
}

/** A JSON text that does not parse. */
public class JsonSyntaxException(message: String) : Exception(message)

/** RFC 8259 for everything that is not a JWS segment. */
public object JsonText {
    /** Parse [text] (any top-level value). A duplicate name keeps the last member. */
    public fun parse(text: String): JsonElement = LenientParser(text).run()

    /** [parse], or null when [text] is not JSON. */
    public fun parseOrNull(text: String): JsonElement? =
        try {
            parse(text)
        } catch (e: JsonSyntaxException) {
            null
        }
}

private class LenientParser(private val s: String) {
    private var i = 0

    fun run(): JsonElement {
        ws()
        val v = value(0)
        ws()
        if (i != s.length) fail("trailing data")
        return v
    }

    private fun fail(why: String): Nothing = throw JsonSyntaxException("$why at offset $i")

    private fun ws() {
        while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
    }

    private fun value(depth: Int): JsonElement {
        if (depth > 512) fail("nesting too deep")
        ws()
        if (i >= s.length) fail("unexpected end")
        return when (val c = s[i]) {
            '{' -> {
                i++
                val members = LinkedHashMap<String, JsonElement>()
                ws()
                if (i < s.length && s[i] == '}') {
                    i++
                    return JsonObject(members)
                }
                while (true) {
                    ws()
                    val name = string()
                    ws()
                    if (i >= s.length || s[i] != ':') fail("expected ':'")
                    i++
                    members.remove(name)
                    members[name] = value(depth + 1)
                    ws()
                    if (i >= s.length) fail("unexpected end")
                    if (s[i] == ',') {
                        i++
                        continue
                    }
                    if (s[i] == '}') {
                        i++
                        return JsonObject(members)
                    }
                    fail("expected ',' or '}'")
                }
                @Suppress("UNREACHABLE_CODE")
                JsonNull
            }
            '[' -> {
                i++
                val items = ArrayList<JsonElement>()
                ws()
                if (i < s.length && s[i] == ']') {
                    i++
                    return JsonArray(items)
                }
                while (true) {
                    items += value(depth + 1)
                    ws()
                    if (i >= s.length) fail("unexpected end")
                    if (s[i] == ',') {
                        i++
                        continue
                    }
                    if (s[i] == ']') {
                        i++
                        return JsonArray(items)
                    }
                    fail("expected ',' or ']'")
                }
                @Suppress("UNREACHABLE_CODE")
                JsonNull
            }
            '"' -> JsonPrimitive(string())
            't' -> literal("true", JsonPrimitive(true))
            'f' -> literal("false", JsonPrimitive(false))
            'n' -> literal("null", JsonNull)
            else -> if (c == '-' || c in '0'..'9') number() else fail("unexpected '$c'")
        }
    }

    private fun literal(word: String, v: JsonElement): JsonElement {
        if (!s.startsWith(word, i)) fail("bad literal")
        i += word.length
        return v
    }

    private fun string(): String {
        if (i >= s.length || s[i] != '"') fail("expected a string")
        i++
        val out = StringBuilder()
        while (true) {
            if (i >= s.length) fail("unterminated string")
            val c = s[i]
            if (c == '"') {
                i++
                return out.toString()
            }
            if (c < ' ') fail("control character in a string")
            if (c == '\\') {
                i++
                if (i >= s.length) fail("unterminated escape")
                when (val e = s[i++]) {
                    '"' -> out.append('"')
                    '\\' -> out.append('\\')
                    '/' -> out.append('/')
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000C')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        if (i + 4 > s.length) fail("short \\u escape")
                        val hex = s.substring(i, i + 4)
                        if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail("bad \\u escape")
                        out.append(hex.toInt(16).toChar())
                        i += 4
                    }
                    else -> fail("bad escape '\\$e'")
                }
                continue
            }
            out.append(c)
            i++
        }
    }

    private fun number(): JsonElement {
        val start = i
        fun digit(k: Int) = k < s.length && s[k] in '0'..'9'
        if (s[i] == '-') i++
        if (!digit(i)) fail("bad number")
        if (s[i] == '0') i++ else while (digit(i)) i++
        if (i < s.length && s[i] == '.') {
            i++
            if (!digit(i)) fail("bad number")
            while (digit(i)) i++
        }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            if (!digit(i)) fail("bad number")
            while (digit(i)) i++
        }
        return JsonUnquotedLiteral(s.substring(start, i))
    }
}

// ── Typed reads ──────────────────────────────────────────────────────────────────────────────
//
// The accessors every decoder goes through. A JSON number decodes as an integer when its value is
// an exact integer within Long (Swift's JSONDecoder accepts `1.0` as an Int the same way); a
// string, boolean or null never does. Integer CLAIMS are additionally checked with `wireInteger`.

/** The string value, or null for anything that is not a JSON string. */
public val JsonElement?.stringValue: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The boolean value, or null for anything that is not `true` or `false`. */
public val JsonElement?.boolValue: Boolean?
    get() {
        val p = this as? JsonPrimitive ?: return null
        if (p.isString || p is JsonNull) return null
        return when (p.content) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

/** The number as a BigDecimal, or null for anything that is not a JSON number. */
public val JsonElement?.decimalValue: BigDecimal?
    get() {
        val p = this as? JsonPrimitive ?: return null
        if (p.isString || p is JsonNull) return null
        val c = p.content
        if (c == "true" || c == "false") return null
        return c.toBigDecimalOrNull()
    }

/** The number as an exact Long, or null (not a number, not integral, or out of Long's range). */
public val JsonElement?.longValue: Long?
    get() {
        val d = decimalValue ?: return null
        return try {
            d.toBigIntegerExact().takeIf { it.bitLength() < 64 }?.toLong()
        } catch (e: ArithmeticException) {
            null
        }
    }

/** The object, or null. */
public val JsonElement?.objectValue: JsonObject?
    get() = this as? JsonObject

/** The array, or null. */
public val JsonElement?.arrayValue: JsonArray?
    get() = this as? JsonArray

/** True for JSON `null`. */
public val JsonElement?.isNull: Boolean
    get() = this is JsonNull

/** A number literal from an integer, as the wire spells it. */
public fun jsonInt(value: Long): JsonElement = JsonUnquotedLiteral(value.toString())

/** A number literal from a BigInteger. */
public fun jsonInt(value: BigInteger): JsonElement = JsonUnquotedLiteral(value.toString())

/**
 * Structural equality as JSON means it: members by name in any order, arrays in order, numbers
 * by value (`1`, `1.0` and `1e0` are equal), strings by UTF-16 code units (scalar values).
 */
public fun jsonEquals(a: JsonElement?, b: JsonElement?): Boolean {
    if (a == null || b == null) return a == null && b == null
    if (a is JsonNull || b is JsonNull) return a is JsonNull && b is JsonNull
    if (a is JsonObject) {
        if (b !is JsonObject || a.size != b.size) return false
        return a.all { (k, v) -> b.containsKey(k) && jsonEquals(v, b[k]) }
    }
    if (a is JsonArray) {
        if (b !is JsonArray || a.size != b.size) return false
        return a.indices.all { jsonEquals(a[it], b[it]) }
    }
    if (b is JsonObject || b is JsonArray) return false
    val pa = a as JsonPrimitive
    val pb = b as JsonPrimitive
    if (pa.isString || pb.isString) return pa.isString && pb.isString && pa.content == pb.content
    val da = a.decimalValue
    val db = b.decimalValue
    if (da != null && db != null) return da.compareTo(db) == 0
    return pa.content == pb.content
}
