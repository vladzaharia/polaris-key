// The files index, `pkey-files/1`, its path rules and `treeDigest` (plans/P4-01.md §2.7;
// WIRE-CONTRACT-V4 §2.6). client-core `packs/files.ts` is the reference; Swift's `Files.swift` the
// structural model. `content/cases.json#pathCases` and `#filesIndexCases` pin every verdict.

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FILES_FORMAT
import im.plrs.key.core.MAX_FILES_INDEX_BYTES
import im.plrs.key.core.MAX_INDEX_FILES
import im.plrs.key.core.MAX_PACK_PATH_BYTES
import im.plrs.key.core.NonWireIntegers
import im.plrs.key.core.arrayValue
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.isSha256Hex
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.saturatingAdd
import im.plrs.key.core.stringValue
import im.plrs.key.core.wireInteger
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** What [checkPaths] reports. */
public sealed interface CheckPathsResult {
    public data object Ok : CheckPathsResult

    /** `files-unsafe-path`, `files-duplicate-path`, `files-case-collision` or `files-path-conflict`, with the later path. */
    public data class Refused(val error: String, val path: String) : CheckPathsResult

    public val json: JsonObject
        get() = when (this) {
            Ok -> buildJsonObject { put("ok", JsonPrimitive(true)) }
            is Refused -> buildJsonObject {
                put("ok", JsonPrimitive(false))
                put("error", JsonPrimitive(error))
                put("path", JsonPrimitive(path))
            }
        }
}

private val BAD_CHARS: Set<Char> = "\\:*?\"<>|".toSet()
private val DEVICES: Set<String> = buildSet {
    addAll(listOf("con", "prn", "aux", "nul"))
    for (d in 1..9) {
        add("com$d")
        add("lpt$d")
    }
}

/** ASCII-only lowercase. */
internal fun asciiLower(s: String): String {
    val c = s.toCharArray()
    for (i in c.indices) if (c[i] in 'A'..'Z') c[i] = c[i] + 32
    return String(c)
}

/** Path rules 1–3 (A7 §3.3) and the `.pkey` addition (plans/P4-01.md §2.7). */
internal fun pathSafe(path: String): Boolean {
    val n = path.toByteArray(Charsets.UTF_8).size
    if (n < 1 || n > MAX_PACK_PATH_BYTES) return false
    for (c in path) if (c.code < 0x20 || c.code > 0x7e || c in BAD_CHARS) return false
    val segments = path.split('/')
    if (asciiLower(segments[0]) == ".pkey") return false
    for (s in segments) {
        if (s.isEmpty() || s == "." || s == "..") return false
        if (s.endsWith(" ") || s.endsWith(".")) return false
        val stem = s.split('.')[0]
        if (asciiLower(stem) in DEVICES) return false
    }
    return true
}

/**
 * The path rules, in order (plans/P4-01.md §2.7, A7 §3.3): unsafe, duplicate, case collision, then a
 * directory-prefix conflict (case-insensitively). The later path is reported. Run before any byte
 * is written.
 */
public fun checkPaths(paths: List<String>): CheckPathsResult {
    val seen = HashSet<String>()
    val lower = HashSet<String>()
    val dirs = HashSet<String>()
    for (path in paths) {
        if (!pathSafe(path)) return CheckPathsResult.Refused(ErrorCode.filesUnsafePath, path)
        if (path in seen) return CheckPathsResult.Refused(ErrorCode.filesDuplicatePath, path)
        val lp = asciiLower(path)
        if (lp in lower) return CheckPathsResult.Refused(ErrorCode.filesCaseCollision, path)
        val parts = lp.split('/')
        val prefixes = (1 until parts.size).map { parts.subList(0, it).joinToString("/") }
        if (lp in dirs || prefixes.any { it in lower }) return CheckPathsResult.Refused(ErrorCode.filesPathConflict, path)
        seen += path
        lower += lp
        dirs += prefixes
    }
    return CheckPathsResult.Ok
}

/** One file as [treeDigest] reads it. */
public data class TreeFile(val path: String, val size: Long, val sha256: String)

/**
 * `treeDigest` (plans/P4-01.md §2.7): the SHA-256 of one line `<sha256hex> <size> <path>\n` per
 * file, sorted by path bytes. An empty tree hashes the empty string.
 */
public fun treeDigest(files: List<TreeFile>): String {
    val h = PackHasher()
    for (f in files.sortedWith { a, b -> compareUtf8Bytes(a.path, b.path) }) h.update("${f.sha256} ${f.size} ${f.path}\n".toByteArray(Charsets.UTF_8))
    return h.digest()
}

@JvmName("treeDigestOfEntries")
public fun treeDigest(entries: List<FilesIndexEntry>): String = treeDigest(entries.map { TreeFile(it.path, it.size, it.sha256) })

/** What [parseFilesIndex] reports. */
public sealed interface ParseFilesIndexResult {
    public data class Ok(val index: FilesIndexDoc) : ParseFilesIndexResult
    public data class Refused(val error: String, val path: String?) : ParseFilesIndexResult
}

/** The index, or null. */
public val ParseFilesIndexResult.index: FilesIndexDoc? get() = (this as? ParseFilesIndexResult.Ok)?.index

private val invalidIndex = ParseFilesIndexResult.Refused(ErrorCode.filesIndexInvalid, null)
private val layoutMismatch = ParseFilesIndexResult.Refused(ErrorCode.filesLayoutMismatch, null)

internal fun packWireInt(v: JsonElement?, pointer: String, min: Long, nonWire: NonWireIntegers): Boolean = wireInteger(v.longValue, pointer, min, nonWire)

/** The member rules of one entry (plans/P4-01.md §2.7), integer rule included. */
private fun entryOk(e: JsonElement, i: Int, container: Boolean, nonWire: NonWireIntegers): Boolean {
    val o = e.objectValue ?: return false
    val at = "/files/$i"
    if (o["path"].stringValue == null) return false
    if (!packWireInt(o["size"], "$at/size", 0, nonWire)) return false
    val sha = o["sha256"].stringValue ?: return false
    if (!isSha256Hex(sha)) return false
    val b = o["blob"].objectValue ?: return false
    val bs = b["sha256"].stringValue ?: return false
    if (!isSha256Hex(bs)) return false
    if (!packWireInt(b["bytes"], "$at/blob/bytes", 0, nonWire)) return false
    val codec = b["codec"].stringValue
    if (codec == "none") {
        if (b["bytes"].longValue != o["size"].longValue || bs != sha) return false
    } else if (codec != "zstd") {
        return false
    }
    if (container && !packWireInt(o["offset"], "$at/offset", 0, nonWire)) return false
    return true
}

/**
 * `parseFilesIndex(stored, ref, variant)` (plans/P4-01.md §2.7): the first failure, in order: the
 * stored object against its ref and its decode, strict JSON, the member rules, the path rules, then
 * the layout rule. [decode] decodes a `codec: "zstd"` index (without it a zstd index is invalid).
 * Never throws.
 */
public fun parseFilesIndex(
    stored: ByteArray,
    ref: PackFilesRef,
    payload: PackPayload,
    decode: ((frame: ByteArray, size: Int) -> ByteArray)?,
    maxBytes: Long = MAX_FILES_INDEX_BYTES.toLong(),
): ParseFilesIndexResult {
    // 1. The stored object against its ref, then the decode.
    if (ref.size > maxBytes) return invalidIndex
    if (stored.size.toLong() != ref.bytes) return invalidIndex
    if (sha256Of(stored) != ref.sha256) return invalidIndex
    val decoded: ByteArray = when {
        ref.codec == "none" -> stored
        ref.codec == "zstd" && decode != null -> try {
            decode(stored, ref.size.toInt())
        } catch (e: Exception) {
            return invalidIndex
        }
        else -> return invalidIndex
    }
    if (decoded.size.toLong() != ref.size) return invalidIndex

    // 2. Strict JSON.
    val parsed = strictParse(decoded) ?: return invalidIndex
    val o = parsed.value
    val nonWire = parsed.nonWire

    // 3. The member rules.
    if (o["format"].stringValue != FILES_FORMAT || o["layout"].stringValue != ref.layout) return invalidIndex
    val p = o["payload"].objectValue ?: return invalidIndex
    if (!packWireInt(p["size"], "/payload/size", 0, nonWire)) return invalidIndex
    val psha = p["sha256"].stringValue ?: return invalidIndex
    if (!isSha256Hex(psha)) return invalidIndex
    val psize = p["size"].longValue ?: return invalidIndex
    if (psize != payload.size || psha != payload.sha256) return invalidIndex
    val files = o["files"].arrayValue ?: return invalidIndex
    if (files.size > MAX_INDEX_FILES) return invalidIndex
    val container = ref.layout == "container"
    for ((i, e) in files.withIndex()) if (!entryOk(e, i, container, nonWire)) return invalidIndex
    val index = FilesIndexDoc.from(o) ?: return invalidIndex
    val entries = index.files

    // 4. The path rules.
    val paths = checkPaths(entries.map { it.path })
    if (paths is CheckPathsResult.Refused) return ParseFilesIndexResult.Refused(paths.error, paths.path)

    // 5. The layout.
    var total = 0L
    for (e in entries) total = saturatingAdd(total, e.size)
    if (container) {
        var end = 0L
        for (e in entries) {
            val offset = e.offset ?: 0
            if (offset < end) return layoutMismatch
            end = saturatingAdd(offset, e.size)
        }
        if (end > psize) return layoutMismatch
        val gaps = ref.gaps ?: return layoutMismatch
        if (psize - total != gaps.size) return layoutMismatch
    } else if (ref.layout == "tree") {
        for (i in 1 until entries.size) if (compareUtf8Bytes(entries[i - 1].path, entries[i].path) >= 0) return invalidIndex
        if (total != psize) return invalidIndex
        if (treeDigest(entries) != psha) return invalidIndex
    }
    return ParseFilesIndexResult.Ok(index)
}
