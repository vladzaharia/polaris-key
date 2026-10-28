// Canonical JSON (WIRE-CONTRACT-V5 §13.10.3, §13.10.8): sorted keys at every level (UTF-16
// code-unit order), no whitespace, non-ASCII text as itself, strings escaped as ECMAScript
// `JSON.stringify` does, numbers as ECMAScript `Number::toString`.
//
// `Double.toString` does not spell numbers that way (and on JDK 17 it is not always the shortest
// digits: 5e-324 prints as 4.9E-324), so the number printer is written out here from exact
// decimal arithmetic. A writer refuses, rather than spells differently: a number that is not
// finite, a string or key with a lone surrogate, and an integer over 2^53 in magnitude.

package im.plrs.key.core.sync

import im.plrs.key.core.JsonSyntaxException
import im.plrs.key.core.JsonText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal
import java.math.BigInteger
import java.math.MathContext
import java.math.RoundingMode

public object CanonicalJson {
    /** The largest magnitude of an integer every SDK holds exactly. */
    public const val MAX_SAFE_INTEGER: Long = 1L shl 53

    private const val MAX_DIGITS = 17
    private const val DEC_LIMIT = 21
    private const val DEC_SMALL = -6
    private const val CONTROL_LIMIT = 0x20
    private const val HEX = 16
    private const val HEX_WIDTH = 4
    private val integerToken = Regex("-?[0-9]+")

    /** The canonical text of [value]. Throws [SyncCryptoException] for a value the contract refuses. */
    public fun encode(value: JsonElement): String = StringBuilder().also { write(value, it, false) }.toString()

    public fun encodeBytes(value: JsonElement): ByteArray = SyncCrypto.utf8(encode(value))

    /**
     * Parses JSON text as `JSON.parse` does (every number an IEEE double) and writes it
     * canonically. A `\uD800`-style escape that is not half of a pair is refused.
     */
    public fun canonicalize(jsonText: String): String {
        val tree = try {
            JsonText.parse(jsonText)
        } catch (ignored: JsonSyntaxException) {
            throw SyncCryptoException("malformed JSON")
        }
        return StringBuilder().also { write(tree, it, true) }.toString()
    }

    private fun write(v: JsonElement, out: StringBuilder, asDoubles: Boolean) {
        when (v) {
            is JsonNull -> out.append("null")

            is JsonArray -> {
                out.append('[')
                v.forEachIndexed { i, e ->
                    if (i > 0) out.append(',')
                    write(e, out, asDoubles)
                }
                out.append(']')
            }

            is JsonObject -> {
                out.append('{')
                // String order is UTF-16 code-unit order, which is the contract's.
                v.keys.sorted().forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    writeString(k, out)
                    out.append(':')
                    write(v.getValue(k), out, asDoubles)
                }
                out.append('}')
            }

            is JsonPrimitive -> writePrimitive(v, out, asDoubles)
        }
    }

    private fun writePrimitive(v: JsonPrimitive, out: StringBuilder, asDoubles: Boolean) {
        when {
            v.isString -> writeString(v.content, out)
            v.content == "true" || v.content == "false" -> out.append(v.content)
            else -> out.append(numberToken(v.content, asDoubles))
        }
    }

    private fun numberToken(token: String, asDoubles: Boolean): String {
        if (!asDoubles && integerToken.matches(token)) {
            val n = BigInteger(token)
            if (n.abs() > BigInteger.valueOf(MAX_SAFE_INTEGER)) throw SyncCryptoException("integer over 2^53")
            return n.toString()
        }
        return numberString(token.toDoubleOrNull() ?: throw SyncCryptoException("malformed number"))
    }

    /** `JSON.stringify` for a string: only `"`, `\` and the C0 controls are escaped; a lone surrogate is refused. */
    private fun writeString(s: String, out: StringBuilder) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])) throw SyncCryptoException("lone surrogate")
                out.append(c).append(s[i + 1])
                i++
            } else if (Character.isLowSurrogate(c)) {
                throw SyncCryptoException("lone surrogate")
            } else {
                out.append(escaped(c))
            }
            i++
        }
        out.append('"')
    }

    private fun escaped(c: Char): String = when {
        c == '"' -> "\\\""
        c == '\\' -> "\\\\"
        c == '\b' -> "\\b"
        c == '\t' -> "\\t"
        c == '\n' -> "\\n"
        c == '\u000C' -> "\\f"
        c == '\r' -> "\\r"
        c.code < CONTROL_LIMIT -> "\\u" + c.code.toString(HEX).padStart(HEX_WIDTH, '0')
        else -> c.toString()
    }

    /**
     * The shortest decimal that reads back as [d] (digits without trailing zeros, and `n` with the
     * value `0.digits x 10^n`), from the exact binary value: for each precision the candidates
     * are the exact value rounded down and up, the nearest that round-trips wins.
     */
    private fun shortest(d: Double): Pair<String, Int> {
        val exact = BigDecimal(d)
        for (p in 1..MAX_DIGITS) {
            var best: BigDecimal? = null
            for (mode in arrayOf(RoundingMode.DOWN, RoundingMode.UP)) {
                val r = exact.round(MathContext(p, mode))
                if (r.toDouble() != d) continue
                if (best == null || r.subtract(exact).abs() < best.subtract(exact).abs()) best = r
            }
            if (best != null) {
                val unscaled = best.unscaledValue().toString()
                return unscaled.trimEnd('0') to (unscaled.length - best.scale())
            }
        }
        throw SyncCryptoException("no shortest form")
    }

    /** ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20) for radix 10. */
    public fun numberString(d: Double): String {
        if (!d.isFinite()) throw SyncCryptoException("number is not finite")
        if (d == 0.0) return "0" // also -0
        val (s, n) = shortest(Math.abs(d))
        val k = s.length
        val out = when {
            n in k..DEC_LIMIT -> s + "0".repeat(n - k)

            n in 1..DEC_LIMIT -> s.substring(0, n) + "." + s.substring(n)

            n > DEC_SMALL && n <= 0 -> "0." + "0".repeat(-n) + s

            else -> {
                val e = n - 1
                val mant = if (k == 1) s else s.substring(0, 1) + "." + s.substring(1)
                mant + "e" + (if (e < 0) "-" else "+") + Math.abs(e)
            }
        }
        return if (d < 0) "-$out" else out
    }
}
