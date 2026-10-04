// The zstd window check (plans/P4-01.md §2.7 rule 3; WIRE-CONTRACT-V4 §2.6), `packSetId` (§2.9) and
// the content stamp (§2.8). client-core `packs/window.ts`, `set.ts` and `stamp.ts` are the
// reference; Swift's `Window.swift` the structural model. `content/cases.json#frameWindowCases`,
// `#packSetIdCases` and `#stampCases` pin them.
//
// Before an applier decodes a `zstd-patch-from` frame it reads the frame's window from the header
// bytes alone (`frameWindow`) and refuses the frame as `delta-apply-failed` when that is null or
// above 2^`windowLogMax(memBytes)`. No decoder parameter replaces the check.

package im.plrs.key.packs

import im.plrs.key.core.CONTENT_STAMP_FORMAT
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MAX_WIRE_INTEGER
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.contentClaims
import im.plrs.key.core.isPackId
import im.plrs.key.core.isSha256Hex
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** 2^32: the saturation point of [frameWindow], above every `windowLogMax`. */
private const val WINDOW_CEILING: Long = 1L shl 32

/**
 * `frameWindow(bytes)` (plans/P4-01.md §2.7): the window of the zstd frame whose header starts
 * [bytes], per RFC 8878 §3.1.1. Null unless bytes 0–3 are `28 B5 2F FD`, the reserved bit of the
 * descriptor is clear, and [bytes] hold the whole header. Saturates at 2^32. Never throws.
 */
public fun frameWindow(bytes: ByteArray): Long? {
    if (bytes.size < 5) return null
    if ((bytes[0].toInt() and 0xff) != 0x28 || (bytes[1].toInt() and 0xff) != 0xb5 || (bytes[2].toInt() and 0xff) != 0x2f || (bytes[3].toInt() and 0xff) != 0xfd) return null
    val d = bytes[4].toInt() and 0xff
    if (d and 0x08 != 0) return null
    val single = d and 0x20 != 0
    val dictBytes = intArrayOf(0, 1, 2, 4)[d and 0x03]
    val fcsFlag = d ushr 6
    val fcsBytes = if (fcsFlag == 0) (if (single) 1 else 0) else intArrayOf(0, 2, 4, 8)[fcsFlag]
    val headerBytes = 5 + (if (single) 0 else 1) + dictBytes + fcsBytes
    if (bytes.size < headerBytes) return null
    if (!single) {
        val w = bytes[5].toInt() and 0xff
        val exp = 10 + (w ushr 3)
        if (exp >= 32) return WINDOW_CEILING
        val b = 1L shl exp
        return minOf(b + (b / 8) * (w and 7), WINDOW_CEILING)
    }
    val at = 5 + dictBytes
    if (fcsBytes == 8) {
        for (i in 4 until 8) if (bytes[at + i].toInt() != 0) return WINDOW_CEILING
    }
    var v = 0L
    var i = minOf(fcsBytes, 4) - 1
    while (i >= 0) {
        v = v * 256 + (bytes[at + i].toLong() and 0xff)
        i--
    }
    if (fcsBytes == 2) v += 256
    return minOf(v, WINDOW_CEILING)
}

/**
 * `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))` (plans/P4-01.md §2.7 rule 3), in integers.
 * Null when [memBytes] is negative or above 2^53 − 1, or [p] is not 30 or 31.
 */
public fun windowLogMax(memBytes: Long, p: Int = 31): Int? {
    if (memBytes < 0 || memBytes > MAX_WIRE_INTEGER || (p != 30 && p != 31)) return null
    var n = 0
    var v = memBytes - 1
    while (v > 0) {
        n++
        v /= 2
    }
    return maxOf(10, minOf(p, n))
}

/** The window check itself: true when [frame]'s header window is known and at most 2^windowLogMax. */
public fun windowAllowed(frame: ByteArray, memBytes: Long, p: Int = 31): Boolean {
    val limit = windowLogMax(memBytes, p) ?: return false
    val window = frameWindow(frame) ?: return false
    return window <= (1L shl limit)
}

// ── packSetId (plans/P4-01.md §2.9) ─────────────────────────────────────────────────────────────

/** One member of a pack set: the pack id and the record hash of its release. */
public data class PackSetEntry(val packId: String, val releaseSha256: String)

/**
 * The SHA-256 of the UTF-8 lines `<packId> <releaseSha256>\n`, sorted by pack-id bytes. Null when a
 * pack id is invalid, a release is not 64 lowercase hex, or a pack is listed twice.
 */
public fun packSetId(entries: List<PackSetEntry>): String? {
    val seen = HashSet<String>()
    for (e in entries) if (!isPackId(e.packId) || !isSha256Hex(e.releaseSha256) || !seen.add(e.packId)) return null
    val h = PackHasher()
    for (e in entries.sortedWith { a, b -> compareUtf8Bytes(a.packId, b.packId) }) h.update("${e.packId} ${e.releaseSha256}\n".toByteArray(Charsets.UTF_8))
    return h.digest()
}

// ── The content stamp, `pkey-content/1` (plans/P4-01.md §2.6, §2.8) ─────────────────────────────

/** What [parseContentStamp] reports. */
public sealed interface ParseContentStampResult {
    public data class Ok(val content: AppContent) : ParseContentStampResult

    /** `content-stamp-invalid`. */
    public data object Invalid : ParseContentStampResult

    public val json: JsonObject
        get() = when (this) {
            is Ok -> buildJsonObject {
                put("ok", JsonPrimitive(true))
                put("content", content.json)
            }
            Invalid -> buildJsonObject {
                put("ok", JsonPrimitive(false))
                put("error", JsonPrimitive(ErrorCode.contentStampInvalid))
            }
        }
}

/** The content, or null. */
public val ParseContentStampResult.content: AppContent? get() = (this as? ParseContentStampResult.Ok)?.content

/**
 * Parse a content stamp file's bytes: strict JSON, `format == "pkey-content/1"`, and §2.4's
 * `content` claims with pointers at the stamp's top level. Unknown members are ignored.
 */
public fun parseContentStamp(input: ByteArray): ParseContentStampResult {
    val parsed = strictParse(input) ?: return ParseContentStampResult.Invalid
    val o = parsed.value
    if (o["format"].stringValue != CONTENT_STAMP_FORMAT) return ParseContentStampResult.Invalid
    if (!contentClaims(o, parsed.nonWire, "")) return ParseContentStampResult.Invalid
    val content = AppContent.from(o) ?: return ParseContentStampResult.Invalid
    return ParseContentStampResult.Ok(content)
}

public fun parseContentStamp(text: String): ParseContentStampResult = parseContentStamp(text.toByteArray(Charsets.UTF_8))
