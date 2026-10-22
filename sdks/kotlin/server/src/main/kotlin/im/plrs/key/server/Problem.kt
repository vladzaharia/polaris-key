// Product backends — WIRE-CONTRACT-V4 §14.3, the problem body and challenge of a refusal.
//
// Pinned by `backend-matrix.json` (`problem`). The copy is `conformance/parity/copy.<locale>.json`'s
// `codes` table, copied into this JAR at build time (see build.gradle.kts), so the strings have one
// source. The locale comes from `Accept-Language` among the eight copy locales; English is the
// fallback. The body never names the step that refused, the header, the document or a claim.

package im.plrs.key.server

import im.plrs.key.core.CopyEntry
import im.plrs.key.core.JsonText
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** §14.3: the copy locales, English first. */
public val BACKEND_LOCALES: List<String> = listOf("en", "de", "fr", "es", "it", "ja", "ko", "pt-BR", "zh-Hans")

public const val PROBLEM_TYPE_BASE: String = "https://key.plrs.im/docs/reference/error-codes/#"
public const val PROBLEM_CONTENT_TYPE: String = "application/problem+json"

private fun asciiLower(s: String): String {
    val out = StringBuilder(s.length)
    for (c in s) out.append(if (c in 'A'..'Z') c + 0x20 else c)
    return out.toString()
}

private fun trimOws(s: String): String = s.trim { it == ' ' || it == '\t' }

private val QVALUE = Regex("^(0(\\.[0-9]{0,3})?|1(\\.0{0,3})?)$")

private fun rangeLocale(range: String): String? {
    if (range == "*") return "en"
    val tag = asciiLower(range)
    BACKEND_LOCALES.firstOrNull { asciiLower(it) == tag }?.let { return it }
    val parts = tag.split('-')
    val lang = parts[0]
    val second = parts.getOrNull(1)
    if (lang == "zh") return if (second in setOf("tw", "hk", "mo", "hant")) null else "zh-Hans"
    if (lang == "pt") return "pt-BR"
    return BACKEND_LOCALES.firstOrNull { it == lang }
}

/**
 * §14.3: the copy locale for an `Accept-Language` value. Ranges are tried by weight (the first
 * `q` parameter; ties keep their order; a weight of 0, or one outside the qvalue grammar, drops
 * the range). `*` is English. With no match, English.
 */
public fun backendLocale(acceptLanguage: String?): String {
    if (acceptLanguage == null) return "en"
    class Range(val range: String, val q: Double, val at: Int)
    val ranges = ArrayList<Range>()
    acceptLanguage.split(',').forEachIndexed { at, element ->
        val pieces = element.split(';')
        val range = trimOws(pieces[0])
        var q = 1.0
        for (param in pieces.drop(1)) {
            val p = trimOws(param)
            val eq = p.indexOf('=')
            val name = if (eq < 0) p else p.substring(0, eq).trimEnd(' ', '\t')
            if (asciiLower(name) != "q") continue
            val value = if (eq < 0) "" else p.substring(eq + 1).trimStart(' ', '\t')
            if (!QVALUE.matches(value)) return@forEachIndexed
            q = value.toDouble()
            break
        }
        if (range.isNotEmpty() && q > 0) ranges += Range(range, q, at)
    }
    for (r in ranges.sortedWith(compareByDescending<Range> { it.q }.thenBy { it.at })) {
        rangeLocale(r.range)?.let { return it }
    }
    return "en"
}

/** The copy tables of the eight locales, read from the JAR once. */
public object ProblemCopy {
    private val tables = ConcurrentHashMap<String, Map<String, CopyEntry>>()

    /** One locale's `codes` table; empty when the locale has no file. */
    public fun table(locale: String): Map<String, CopyEntry> = tables.getOrPut(locale) { load(locale) }

    private fun load(locale: String): Map<String, CopyEntry> {
        val stream = ProblemCopy::class.java.getResourceAsStream("/im/plrs/key/server/copy/copy.$locale.json") ?: return emptyMap()
        val root = stream.use { JsonText.parse(it.readBytes().toString(Charsets.UTF_8)) }.objectValue ?: return emptyMap()
        val codes = root["codes"].objectValue ?: return emptyMap()
        val out = LinkedHashMap<String, CopyEntry>()
        for ((code, entry) in codes) {
            val o = entry.objectValue ?: continue
            out[code] = CopyEntry(o["title"].stringValue ?: continue, o["message"].stringValue ?: continue)
        }
        return out
    }
}

/** A refusal as the response a framework adapter sends. */
public class BackendProblem internal constructor(
    public val code: String,
    public val status: Int,
    public val locale: String,
    /** The `WWW-Authenticate` value on a 401, else null. */
    public val challenge: String?,
    public val type: String,
    public val title: String,
    public val detail: String,
) {
    /** The refusal this problem answers, for `when (problem.refusal)` in an `onRefusal` hook. */
    public val refusal: BackendRefusal get() = BackendRefusal.of(code)!!

    /** The response headers: `Content-Type`, `Cache-Control` and, on a 401, `WWW-Authenticate`. */
    public val headers: Map<String, String>
        get() = buildMap {
            put("Content-Type", PROBLEM_CONTENT_TYPE)
            put("Cache-Control", "no-store")
            if (challenge != null) put("WWW-Authenticate", challenge)
        }

    /** The JSON body `{type, title, status, detail, code}`. */
    public val body: String
        get() = JsonObject(
            linkedMapOf(
                "type" to JsonPrimitive(type),
                "title" to JsonPrimitive(title),
                "status" to JsonPrimitive(status),
                "detail" to JsonPrimitive(detail),
                "code" to JsonPrimitive(code),
            ),
        ).toString()

    override fun toString(): String = "BackendProblem(code=$code, status=$status)"
}

/**
 * §14.3: the refusal's problem. [realm] is the first configured product's slug. A locale whose
 * table lacks the code reads English.
 */
public fun backendProblem(code: String, acceptLanguage: String?, realm: String): BackendProblem {
    val refusal = BackendRefusal.of(code) ?: throw IllegalArgumentException("not a backend code: $code")
    var locale = backendLocale(acceptLanguage)
    var entry = ProblemCopy.table(locale)[code]
    if (entry == null) {
        locale = "en"
        entry = ProblemCopy.table("en")[code] ?: throw IllegalStateException("no English copy for $code")
    }
    val challenge = if (refusal.status == 401) "${BackendWire.AUTH_SCHEME} realm=\"$realm\", error=\"$code\"" else null
    return BackendProblem(code, refusal.status, locale, challenge, PROBLEM_TYPE_BASE + code, entry.title, entry.message)
}
