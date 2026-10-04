// `l10n.table` payloads (CONTENT §4.2; P4-16): PO, CSV or JSON tables, read by plain parsers, a port
// of client-core's `packs/handlers/l10n.ts` (Swift's `L10n.swift` the structural model) held to the
// same cases (`packages/client-core/test/fixtures/pack-type-cases.json`). Nothing here evaluates a
// byte: a table is text split into messages, never a script, a resource or an object graph.
//
// The format of a file is judged by its bytes, never its name: after a UTF-8 BOM and ASCII
// whitespace, `{` is a JSON table, `#`, `msgid` or `msgctxt` a PO file, anything else CSV. Text is
// scanned as Unicode code points, so "\r\n" stays two characters wherever a record or line ends.

package im.plrs.key.packs

import im.plrs.key.core.compareUtf8Bytes
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One message of a table. [strings] has one entry, or one per plural form (PO `msgstr[N]`). */
public data class L10nMessage(val context: String?, val id: String, val plural: String?, val strings: List<String>)

/** One locale's messages from one file (a CSV file with N locale columns gives N tables). */
public data class L10nTable(val path: String, val locale: String, val messages: List<L10nMessage>)

private val BCP47 = Regex(
    "^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$",
)

private fun underscoresToHyphens(s: String): String = s.replace('_', '-')

/**
 * A locale as a well-formed BCP-47 tag (RFC 5646 `langtag` and private use; no grandfathered tags),
 * with `_` accepted as Godot writes it and written `-`; null when it is not one. Case is kept.
 */
public fun bcp47Canonical(tag: String): String? {
    val canonical = underscoresToHyphens(tag)
    val n = canonical.codePointCount(0, canonical.length)
    if (n < 2 || n > 35) return null
    for (c in canonical) if (!(c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-')) return null
    if (!BCP47.matches(asciiLower(canonical))) return null
    return canonical
}

/** Whether two tags name the same locale (ASCII-case-insensitive, after canonicalisation). */
public fun sameLocale(a: String, b: String): Boolean = asciiLower(underscoresToHyphens(a)) == asciiLower(underscoresToHyphens(b))

/** The result of parsing one file of an `l10n.table` payload. */
public sealed interface L10nParse {
    public data class Ok(val tables: List<L10nTable>) : L10nParse

    /** `table` (unreadable) or `locale` (a locale that is not a well-formed tag). */
    public data class Failed(val detail: String) : L10nParse
}

private class RawTable(val locale: String, val messages: MutableList<L10nMessage>)

private fun cps(s: String): IntArray = s.codePoints().toArray()
private fun str(a: IntArray, from: Int = 0, to: Int = a.size): String = String(a, from, to - from)

/** Parse one file of an `l10n.table` payload (the check's rules 2–5; the size rule is the handler's). */
public fun parseL10nFile(path: String, bytes: ByteArray): L10nParse {
    if (!isStrictUtf8(bytes)) return L10nParse.Failed("table")
    var scalars = cps(bytes.toString(Charsets.UTF_8))
    if (scalars.contains(0)) return L10nParse.Failed("table")
    if (scalars.isNotEmpty() && scalars[0] == 0xFEFF) scalars = scalars.copyOfRange(1, scalars.size)
    var at = 0
    while (at < scalars.size && (scalars[at] == ' '.code || scalars[at] == '\t'.code || scalars[at] == '\n'.code || scalars[at] == '\r'.code)) at++
    if (at == scalars.size) return L10nParse.Failed("table")
    val raw: List<RawTable>? = when {
        scalars[at] == '{'.code -> parseJsonTable(scalars)
        startsWith(scalars, at, "#") || startsWith(scalars, at, "msgid") || startsWith(scalars, at, "msgctxt") -> parsePo(scalars)
        else -> parseCsv(scalars)
    }
    if (raw == null) return L10nParse.Failed("table")
    val tables = ArrayList<L10nTable>()
    for (t in raw) {
        val locale = bcp47Canonical(t.locale) ?: return L10nParse.Failed("locale")
        tables += L10nTable(path, locale, t.messages)
    }
    return L10nParse.Ok(tables)
}

private fun startsWith(s: IntArray, at: Int, prefix: String): Boolean {
    val p = cps(prefix)
    if (at + p.size > s.size) return false
    for (k in p.indices) if (s[at + k] != p[k]) return false
    return true
}

// ── JSON ────────────────────────────────────────────────────────────────────────────────────────

private fun parseJsonTable(scalars: IntArray): List<RawTable>? {
    val bytes = str(scalars).toByteArray(Charsets.UTF_8)
    // Strictness (V4 §1.2: duplicates, no trailing comma, …) is `strictParse`'s; its object keeps
    // member names exactly as written (no normalisation), so two distinct ids never merge.
    val o = strictParse(bytes)?.value ?: return null
    val locale = (o["locale"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val m = o["messages"] as? JsonObject ?: return null
    // Member order is not portable, so a JSON table's messages are in UTF-8 byte order of ids.
    val messages = ArrayList<L10nMessage>()
    for (id in m.keys.sortedWith { a, b -> compareUtf8Bytes(a, b) }) {
        val v = m[id] as? JsonPrimitive ?: return null
        if (!v.isString) return null
        messages += L10nMessage(null, id, null, listOf(v.content))
    }
    return listOf(RawTable(locale, messages))
}

// ── PO ──────────────────────────────────────────────────────────────────────────────────────────

/** A PO string literal (`"…"` and trailing spaces or tabs), unescaped; null when malformed. */
private fun poString(s: IntArray, from: Int, to: Int): String? {
    var i = from
    if (i >= to || s[i] != '"'.code) return null
    val out = StringBuilder()
    i++
    var closed = false
    while (i < to) {
        val c = s[i]
        if (c == '"'.code) {
            closed = true
            break
        }
        if (c != '\\'.code) {
            out.appendCodePoint(c)
            i++
            continue
        }
        i++
        if (i >= to) return null
        when (s[i]) {
            '\\'.code -> out.append('\\')
            '"'.code -> out.append('"')
            'n'.code -> out.append('\n')
            't'.code -> out.append('\t')
            'r'.code -> out.append('\r')
            else -> return null
        }
        i++
    }
    if (!closed) return null
    var j = i + 1
    while (j < to) {
        if (s[j] != ' '.code && s[j] != '\t'.code) return null
        j++
    }
    return out.toString()
}

private class PoEntry {
    var context: String? = null
    var id: String? = null
    var plural: String? = null
    val strings = ArrayList<String>()
    val complete: Boolean get() = id != null && strings.isNotEmpty()
}

private enum class PoPart { ctxt, id, plural, str }

private class PoKeyword(val kw: String, val index: Int?, val rest: Int)

/** A keyword line: the keyword, its `[N]` index (msgstr only) and where the rest starts after the spaces. */
private fun poKeyword(s: IntArray, from: Int, to: Int): PoKeyword? {
    val line = s.copyOfRange(from, to)
    var kw: String? = null
    var at = 0
    var index: Int? = null
    for (k in listOf("msgctxt", "msgid_plural", "msgid")) {
        if (startsWith(line, 0, k)) {
            kw = k
            at = k.length
            break
        }
    }
    if (kw == null && startsWith(line, 0, "msgstr")) {
        kw = "msgstr"
        at = 6
        if (at < line.size && line[at] == '['.code) {
            var j = at + 1
            var digits = 0
            var n = 0
            while (j < line.size && digits < 3 && line[j] in '0'.code..'9'.code) {
                n = n * 10 + (line[j] - '0'.code)
                digits++
                j++
            }
            if (digits in 1..2 && j < line.size && line[j] == ']'.code) {
                index = n
                at = j + 1
            }
        }
    }
    if (kw == null) return null
    var j = at
    while (j < line.size && (line[j] == ' '.code || line[j] == '\t'.code)) j++
    if (j <= at) return null
    return PoKeyword(kw, index, from + j)
}

private fun splitLines(s: IntArray): List<IntRange> {
    val out = ArrayList<IntRange>()
    var start = 0
    for (i in s.indices) {
        if (s[i] == '\n'.code) {
            out += start until i
            start = i + 1
        }
    }
    out += start until s.size
    return out
}

private fun parsePo(text: IntArray): List<RawTable>? {
    val entries = ArrayList<PoEntry>()
    var cur: PoEntry? = null
    var last: PoPart? = null
    for (range in splitLines(text)) {
        val from = range.first
        var to = range.last + 1
        if (to > from && text[to - 1] == '\r'.code) to--
        if ((from until to).all { text[it] == ' '.code || text[it] == '\t'.code }) {
            last = null
            continue
        }
        if (text[from] == '#'.code) {
            last = null
            continue
        }
        if (text[from] == '"'.code) {
            val s = poString(text, from, to) ?: return null
            val c = cur ?: return null
            when (last ?: return null) {
                PoPart.ctxt -> c.context = c.context!! + s
                PoPart.id -> c.id = c.id!! + s
                PoPart.plural -> c.plural = c.plural!! + s
                PoPart.str -> c.strings[c.strings.size - 1] = c.strings[c.strings.size - 1] + s
            }
            continue
        }
        val k = poKeyword(text, from, to) ?: return null
        val s = poString(text, k.rest, to) ?: return null
        if (k.kw == "msgctxt" || k.kw == "msgid") {
            val c0 = cur
            val opensNew = c0 == null || c0.complete || (k.kw == "msgid" && c0.id != null) || k.kw == "msgctxt"
            if (opensNew) {
                if (c0 != null) {
                    if (!c0.complete) return null
                    entries += c0
                }
                cur = PoEntry()
            }
            if (k.kw == "msgctxt") {
                cur!!.context = s
                last = PoPart.ctxt
            } else {
                cur!!.id = s
                last = PoPart.id
            }
            continue
        }
        val c = cur ?: return null
        if (c.id == null) return null
        if (k.kw == "msgid_plural") {
            if (c.plural != null || c.strings.isNotEmpty()) return null
            c.plural = s
            last = PoPart.plural
            continue
        }
        // msgstr or msgstr[N]
        if (k.index != null) {
            if (c.plural == null || k.index != c.strings.size) return null
        } else {
            if (c.plural != null || c.strings.isNotEmpty()) return null
        }
        c.strings += s
        last = PoPart.str
    }
    cur?.let {
        if (!it.complete) return null
        entries += it
    }
    var locale: String? = null
    var headers = 0
    val messages = ArrayList<L10nMessage>()
    val seen = HashSet<String>()
    for (e in entries) {
        if (e.id == "" && e.context == null) {
            headers++
            if (headers > 1 || e.plural != null) return null
            val h = cps(e.strings[0])
            for (r in splitLines(h)) {
                val l = h.copyOfRange(r.first, r.last + 1)
                if (startsWith(l, 0, "Language:") && locale == null) {
                    var a = 9
                    var b = l.size
                    while (a < b && (l[a] == ' '.code || l[a] == '\t'.code)) a++
                    while (b > a && (l[b - 1] == ' '.code || l[b - 1] == '\t'.code)) b--
                    locale = str(l, a, b)
                }
            }
            continue
        }
        val key = (e.context?.let { "1$it" } ?: "0") + "\u0000" + e.id!!
        if (!seen.add(key)) return null
        messages += L10nMessage(e.context, e.id!!, e.plural, e.strings.toList())
    }
    val loc = locale
    if (headers == 0 || loc.isNullOrEmpty()) return null
    return listOf(RawTable(loc, messages))
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────

/** RFC 4180 records (comma only); null when a quote is malformed. */
private fun csvRecords(t: IntArray): List<List<String>>? {
    val records = ArrayList<List<String>>()
    var record = ArrayList<String>()
    var i = 0
    val n = t.size
    fun recordEnd(k: Int) = t[k] == '\n'.code || (t[k] == '\r'.code && k + 1 < n && t[k + 1] == '\n'.code)
    var started = false
    while (i < n) {
        val field = StringBuilder()
        if (t[i] == '"'.code) {
            started = true
            i++
            while (true) {
                if (i >= n) return null
                val c = t[i]
                if (c == '"'.code) {
                    if (i + 1 < n && t[i + 1] == '"'.code) {
                        field.append('"')
                        i += 2
                        continue
                    }
                    i++
                    break
                }
                field.appendCodePoint(c)
                i++
            }
            if (i < n && t[i] != ','.code && !recordEnd(i)) return null
        } else {
            while (i < n && t[i] != ','.code && !recordEnd(i)) {
                if (t[i] == '"'.code) return null
                field.appendCodePoint(t[i])
                i++
            }
            if (field.isNotEmpty()) started = true
        }
        record += field.toString()
        if (i >= n) break
        if (t[i] == ','.code) {
            started = true
            i++
            if (i >= n) record += ""
            continue
        }
        i += if (t[i] == '\r'.code) 2 else 1
        if (started) records += record
        record = ArrayList()
        started = false
    }
    if (started) records += record
    return records
}

private fun parseCsv(text: IntArray): List<RawTable>? {
    val records = csvRecords(text) ?: return null
    val header = records.firstOrNull() ?: return null
    if (header.size < 2) return null
    val locales = header.drop(1)
    val lower = HashSet<String>()
    for (l in locales) if (!lower.add(asciiLower(underscoresToHyphens(l)))) return null
    val tables = locales.map { RawTable(it, ArrayList()) }
    val keys = HashSet<String>()
    for (r in records.drop(1)) {
        if (r.size != header.size) return null
        val key = r[0]
        if (key.isEmpty() || !keys.add(key)) return null
        for (c in 1 until r.size) tables[c - 1].messages += L10nMessage(null, key, null, listOf(r[c]))
    }
    return tables
}
