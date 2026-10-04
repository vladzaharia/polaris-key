// `pkey-patch/1`, the descriptor of a `files`-scope delta set (plans/P4-01.md §2.7;
// WIRE-CONTRACT-V4 §2.6), and the one object-ref opener every applier shares. client-core
// `packs/patch.ts` is the reference; Swift's `Patch.swift` the structural model.

package im.plrs.key.packs

import im.plrs.key.core.MAX_FILES_INDEX_BYTES
import im.plrs.key.core.MAX_INDEX_FILES
import im.plrs.key.core.PATCH_FORMAT
import im.plrs.key.core.arrayValue
import im.plrs.key.core.isSha256Hex
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.saturatingAdd
import im.plrs.key.core.stringValue

/**
 * A stored object against its ref, then its decoded bytes (§2.7 step 1): the stored length and
 * SHA-256 must equal the ref's, the codec be `zstd` (decoded to exactly `size`) or `none`. Null on
 * any failure. [maxSize], when given, refuses a larger `ref.size` before a byte is read.
 */
public fun openObject(stored: ByteSource?, ref: PackObjectRef, zstd: ZstdPort, maxSize: Long? = null): ByteArray? {
    if (stored == null) return null
    if (maxSize != null && ref.size > maxSize) return null
    if (ref.codec != "zstd" && ref.codec != "none") return null
    if (stored.size != ref.bytes) return null
    if (ref.size > Int.MAX_VALUE - 8) return null
    val bytes = try {
        readAll(stored)
    } catch (e: Exception) {
        return null
    }
    if (bytes.size.toLong() != ref.bytes) return null
    if (sha256Of(bytes) != ref.sha256) return null
    val out = if (ref.codec == "none") {
        bytes
    } else {
        try {
            zstd.decode(bytes, ref.size.toInt())
        } catch (e: Exception) {
            return null
        }
    }
    return if (out.size.toLong() == ref.size) out else null
}

/** One entry of a parsed `pkey-patch/1` descriptor. */
public data class PatchEntry(
    val path: String,
    val op: String,
    val from: String?,
    val to: String,
    val size: Long,
    val codec: String?,
    val offset: Long,
    val length: Long,
)

/** A parsed `pkey-patch/1` descriptor. */
public data class PatchDoc(val entries: List<PatchEntry>)

/**
 * `parsePatch(stored, delta, targetPayloadSha256, targetIndex)` (§2.7): the descriptor of a `files`
 * delta set, or null — the caller's `delta-artifact-mismatch`. Never throws.
 */
public fun parsePatch(
    stored: ByteSource?,
    method: String,
    from: String,
    patch: PackObjectRef,
    data: PackHashBytes,
    targetPayloadSha256: String,
    target: FilesIndexDoc,
    zstd: ZstdPort,
): PatchDoc? {
    val decoded = openObject(stored, patch, zstd, MAX_FILES_INDEX_BYTES.toLong()) ?: return null
    val parsed = strictParse(decoded) ?: return null
    val o = parsed.value
    val nonWire = parsed.nonWire
    if (o["format"].stringValue != PATCH_FORMAT || o["scope"].stringValue != "files") return null
    if (o["method"].stringValue != method || o["from"].stringValue != from) return null
    if (o["to"].stringValue != targetPayloadSha256) return null
    val d = o["data"].objectValue ?: return null
    if (d["sha256"].stringValue != data.sha256) return null
    if (!packWireInt(d["bytes"], "/data/bytes", 0, nonWire) || d["bytes"].longValue != data.bytes) return null
    val list = o["entries"].arrayValue ?: return null
    if (list.size > MAX_INDEX_FILES) return null
    val byPath = HashMap<String, Int>()
    for ((i, f) in target.files.withIndex()) if (!byPath.containsKey(f.path)) byPath[f.path] = i
    val seen = HashSet<String>()
    var lastIndex = -1
    var end = 0L
    val entries = ArrayList<PatchEntry>()
    for ((i, raw) in list.withIndex()) {
        val at = "/entries/$i"
        val e = raw.objectValue ?: return null
        val path = e["path"].stringValue ?: return null
        if (!seen.add(path)) return null
        val ti = byPath[path] ?: return null
        if (ti <= lastIndex) return null
        lastIndex = ti
        val tf = target.files[ti]
        if (e["to"].stringValue != tf.sha256) return null
        if (!packWireInt(e["size"], "$at/size", 0, nonWire) || e["size"].longValue != tf.size) return null
        if (!packWireInt(e["offset"], "$at/offset", 0, nonWire) || !packWireInt(e["length"], "$at/length", 0, nonWire)) return null
        val offset = e["offset"].longValue ?: return null
        val length = e["length"].longValue ?: return null
        if (offset < end) return null
        end = saturatingAdd(offset, length)
        val op = e["op"].stringValue
        var fromHash: String? = null
        var codec: String? = null
        when (op) {
            "delta" -> {
                val f = e["from"].stringValue ?: return null
                if (!isSha256Hex(f)) return null
                fromHash = f
            }
            "blob" -> {
                codec = e["codec"].stringValue
                if (codec == "none") {
                    if (length != tf.size) return null
                } else if (codec != "zstd") {
                    return null
                }
            }
            else -> return null
        }
        entries += PatchEntry(path, op, fromHash, tf.sha256, tf.size, codec, offset, length)
    }
    if (end > data.bytes) return null
    return PatchDoc(entries)
}
