// The data-only rule for delegated installs (plans/P4-19.md §2.5 and Amendment A1, WIRE-CONTRACT-V4
// §2.8). A port of client-core's `packs/dataonly.ts` (Swift's `DataOnly.swift` the structural
// model); `content/cases.json#dataOnlyCases` pins every verdict.
//
// A pack release signed by a delegated content key may hold only files this rule admits. The
// extension allow-list is the real control; the head and tail sniffs and the text rule are defence
// in depth that fail closed. The engine runs the extension rule over the files index before any
// payload object is fetched and the whole rule on each file's decoded bytes as the applier writes it.

package im.plrs.key.packs

import im.plrs.key.core.DATA_ONLY_EXTENSION_VALUES
import im.plrs.key.core.DATA_ONLY_HEAD_BYTES
import im.plrs.key.core.DATA_ONLY_TAIL_BYTES

/** Which rule refused a file (`pack-not-data-only`'s detail). */
public enum class DataOnlyRule(public val wire: String) { extension("extension"), content("content") }

private fun ascii(s: String): ByteArray = s.toByteArray(Charsets.US_ASCII)
private fun bytes(vararg b: Int): ByteArray = ByteArray(b.size) { b[it].toByte() }

/** The refused heads (rule 3), after a UTF-8 BOM and ASCII whitespace are skipped. */
private val HEADS: List<ByteArray> = listOf(
    ascii("RSRC"), ascii("RSCC"), ascii("GDPC"), ascii("GDEC"), ascii("GCPF"), ascii("GDSC"), ascii("[gd_"),
    bytes(0x50, 0x4b, 0x03, 0x04), bytes(0x7f, 0x45, 0x4c, 0x46), ascii("MZ"),
    bytes(0xfe, 0xed, 0xfa, 0xce), bytes(0xfe, 0xed, 0xfa, 0xcf), bytes(0xce, 0xfa, 0xed, 0xfe),
    bytes(0xcf, 0xfa, 0xed, 0xfe), bytes(0xca, 0xfe, 0xba, 0xbe), bytes(0x00, 0x61, 0x73, 0x6d),
    ascii("#!"), ascii("@tool"),
)
private val WORD_HEADS: List<ByteArray> = listOf(ascii("extends"), ascii("class_name"))

/** `PK\x05\x06`: a zip end-of-central-directory record (rule 4). */
private val ZIP_EOCD = bytes(0x50, 0x4b, 0x05, 0x06)
private val GDPC = ascii("GDPC")

/** The extensions whose files are text (Amendment A1): the whole decoded file passes the text rule. */
public val DATA_ONLY_TEXT_EXTENSIONS: List<String> = listOf("json", "csv", "tsv", "po", "txt")

/** The script markers a text file may not hold (Amendment A1). */
public val DATA_ONLY_SCRIPT_MARKERS: List<String> = listOf("GDScript", "CSharpScript", "ScriptExtension", "script/source", "source_code")

private fun isWs(b: Int): Boolean = b == 0x20 || (b in 0x09..0x0d)

private fun u(b: ByteArray, i: Int): Int = b[i].toInt() and 0xff

private fun startsWith(bytes: ByteArray, at: Int, magic: ByteArray): Boolean {
    if (at + magic.size > bytes.size) return false
    for (k in magic.indices) if (bytes[at + k] != magic[k]) return false
    return true
}

/** True when the window ends inside [magic] read from [at]: what is visible is its prefix. */
private fun straddles(bytes: ByteArray, at: Int, magic: ByteArray): Boolean {
    if (at + magic.size <= bytes.size) return false
    for (k in at until bytes.size) if (bytes[k] != magic[k - at]) return false
    return true
}

private fun contains(hay: ByteArray, needle: ByteArray): Boolean {
    if (needle.isEmpty()) return true
    if (hay.size < needle.size) return false
    val first = needle[0]
    val last = hay.size - needle.size
    var i = 0
    while (i <= last) {
        if (hay[i] == first) {
            var k = 1
            while (k < needle.size && hay[i + k] == needle[k]) k++
            if (k == needle.size) return true
        }
        i++
    }
    return false
}

/** Strict UTF-8 (WHATWG `fatal: true`): no overlong form, no surrogate, nothing above U+10FFFF, no truncation. */
internal fun isStrictUtf8(b: ByteArray): Boolean {
    var i = 0
    val n = b.size
    fun cont(k: Int, lo: Int = 0x80, hi: Int = 0xbf) = k < n && u(b, k) in lo..hi
    while (i < n) {
        val c = u(b, i)
        when {
            c < 0x80 -> i += 1
            c in 0xc2..0xdf -> {
                if (!cont(i + 1)) return false
                i += 2
            }
            c in 0xe0..0xef -> {
                val lo = if (c == 0xe0) 0xa0 else 0x80
                val hi = if (c == 0xed) 0x9f else 0xbf
                if (!cont(i + 1, lo, hi) || !cont(i + 2)) return false
                i += 3
            }
            c in 0xf0..0xf4 -> {
                val lo = if (c == 0xf0) 0x90 else 0x80
                val hi = if (c == 0xf4) 0x8f else 0xbf
                if (!cont(i + 1, lo, hi) || !cont(i + 2) || !cont(i + 3)) return false
                i += 4
            }
            else -> return false
        }
    }
    return true
}

private fun isHex(b: Int): Boolean = b in 0x30..0x39 || b in 0x41..0x46 || b in 0x61..0x66

private fun hexValue(b: Int): Int = when (b) {
    in 0x30..0x39 -> b - 0x30
    in 0x41..0x46 -> b - 0x41 + 10
    else -> b - 0x61 + 10
}

/** True when the text holds a `\u` or `\U` escape that could spell ASCII (Amendment A1). */
private fun asciiEscape(b: ByteArray): Boolean {
    var at = 0
    while (at < b.size) {
        if (u(b, at) == 0x5c && at + 1 < b.size && (u(b, at + 1) == 0x75 || u(b, at + 1) == 0x55)) {
            val n = if (u(b, at + 1) == 0x75) 4 else 6
            val start = at + 2
            if (start + n > b.size) return true
            var value = 0
            for (k in start until start + n) {
                if (!isHex(u(b, k))) return true
                value = value * 16 + hexValue(u(b, k))
            }
            if (value < 0x80) return true
        }
        at++
    }
    return false
}

/**
 * Rule 5 (Amendment A1), over a text file's whole decoded bytes: `content` when the bytes are not
 * valid UTF-8 or hold a NUL; when the text, or the text with every backslash removed, holds a script
 * marker; or when it holds a `\u` or `\U` escape that could spell ASCII. Null when admitted.
 */
public fun dataOnlyTextRefusal(bytes: ByteArray): DataOnlyRule? {
    if (!isStrictUtf8(bytes)) return DataOnlyRule.content
    if (bytes.any { it.toInt() == 0 }) return DataOnlyRule.content
    if (asciiEscape(bytes)) return DataOnlyRule.content
    val bare = bytes.filter { it.toInt() != 0x5c }.toByteArray()
    for (m in DATA_ONLY_SCRIPT_MARKERS) {
        val needle = m.toByteArray(Charsets.UTF_8)
        if (contains(bytes, needle) || contains(bare, needle)) return DataOnlyRule.content
    }
    return null
}

/** Rule 2: the final segment's text after its last `.`, ASCII-lowercased; null without one. */
public fun dataOnlyExtension(path: String): String? {
    val last = path.split('/').lastOrNull() ?: path
    val dot = last.lastIndexOf('.')
    if (dot < 0) return null
    return asciiLower(last.substring(dot + 1))
}

/** Rules 1 and 2 alone, over a path. */
public fun dataOnlyPathRefusal(path: String): DataOnlyRule? {
    if (!pathSafe(path)) return DataOnlyRule.extension
    val ext = dataOnlyExtension(path) ?: return DataOnlyRule.extension
    if (ext !in DATA_ONLY_EXTENSION_VALUES) return DataOnlyRule.extension
    return null
}

/**
 * The data-only rule over one file (plans/P4-19.md §2.5): [path] its index path, [head] its first
 * `DATA_ONLY_HEAD_BYTES` decoded bytes, [tail] its last `DATA_ONLY_TAIL_BYTES`, [full] the whole
 * decoded file. Null when the file is admitted.
 */
public fun dataOnlyRefusal(path: String, head: ByteArray, tail: ByteArray, full: ByteArray? = null): DataOnlyRule? {
    dataOnlyPathRefusal(path)?.let { return it }
    val h = if (head.size > DATA_ONLY_HEAD_BYTES) head.copyOf(DATA_ONLY_HEAD_BYTES) else head
    var at = 0
    if (h.size >= 3 && u(h, 0) == 0xef && u(h, 1) == 0xbb && u(h, 2) == 0xbf) at = 3
    while (at < h.size && isWs(u(h, at))) at++
    val cut = h.size == DATA_ONLY_HEAD_BYTES
    if (cut && at == h.size) return DataOnlyRule.content
    for (m in HEADS) if (startsWith(h, at, m) || (cut && straddles(h, at, m))) return DataOnlyRule.content
    for (m in WORD_HEADS) {
        if (startsWith(h, at, m)) {
            val k = at + m.size
            if (k < h.size) {
                val next = u(h, k)
                if (next == 0x20 || next == 0x09) return DataOnlyRule.content
            } else if (cut) {
                return DataOnlyRule.content
            }
        } else if (cut && straddles(h, at, m)) {
            return DataOnlyRule.content
        }
    }
    val t = if (tail.size > DATA_ONLY_TAIL_BYTES) tail.copyOfRange(tail.size - DATA_ONLY_TAIL_BYTES, tail.size) else tail
    if (t.size >= 4 && t.copyOfRange(t.size - 4, t.size).contentEquals(GDPC)) return DataOnlyRule.content
    if (contains(t, ZIP_EOCD)) return DataOnlyRule.content
    val ext = dataOnlyExtension(path)
    if (ext != null && ext in DATA_ONLY_TEXT_EXTENSIONS) {
        val f = full ?: return DataOnlyRule.content
        return dataOnlyTextRefusal(f)
    }
    return null
}

/** [dataOnlyRefusal] over a whole file's decoded bytes. */
public fun dataOnlyFileRefusal(path: String, bytes: ByteArray): DataOnlyRule? = dataOnlyRefusal(
    path,
    bytes.copyOf(minOf(bytes.size, DATA_ONLY_HEAD_BYTES)),
    bytes.copyOfRange(maxOf(0, bytes.size - DATA_ONLY_TAIL_BYTES), bytes.size),
    bytes,
)

/** A refusal the data-only tree sink saw: the first file it refused. */
public data class DataOnlyRefusalSeen(val path: String, val rule: DataOnlyRule)

internal class DataOnlyRefused : RuntimeException(null, null, false, false)

/** A tree sink that passes every file a delegated install writes through [dataOnlyRefusal] first. */
internal class DataOnlyTreeSink(private val inner: TreeSink) : TreeSink {
    @Volatile var seen: DataOnlyRefusalSeen? = null

    override fun writeFile(path: String, bytes: ByteArray) {
        val rule = dataOnlyFileRefusal(path, bytes)
        if (rule != null) {
            synchronized(this) { if (seen == null) seen = DataOnlyRefusalSeen(path, rule) }
            throw DataOnlyRefused()
        }
        inner.writeFile(path, bytes)
    }
}
