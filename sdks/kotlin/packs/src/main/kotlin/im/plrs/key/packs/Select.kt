// Variant selection and target mapping (plans/P4-01.md §2.9; WIRE-CONTRACT-V4 §11.4), and the feed's
// delta menu merge (plans/P4-29.md §2.4). `plan-matrix.json#variantCases` pins `selectVariant`,
// `#targetCases` pins `planTarget` and `#feedDeltaCases` pins `withFeedDeltas`. client-core
// `packs/select.ts` is the reference; Swift's `Select.swift` the structural model. Pure.

package im.plrs.key.packs

import im.plrs.key.core.CHUNKS_FORMAT
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FILES_FORMAT
import im.plrs.key.core.FeedDeltas
import im.plrs.key.core.MAX_CHUNK_BYTES
import im.plrs.key.core.MAX_CHUNK_INDEX_BYTES
import im.plrs.key.core.MAX_FILES_INDEX_BYTES
import im.plrs.key.core.arrayValue
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.decimalValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.math.BigDecimal
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** An object ref is usable when its codec is `zstd` or `none` (§2.9). */
public fun usableCodec(codec: String?): Boolean = codec == "zstd" || codec == "none"

/** The index is readable when `files.format` is `pkey-files/1`, its codec usable and its size within the limit. */
public fun indexReadable(files: JsonElement?): Boolean {
    val f = files.objectValue ?: return false
    if (f["format"].stringValue != FILES_FORMAT || !usableCodec(f["codec"].stringValue)) return false
    val size = f["size"].decimalValue ?: return false
    return size <= BigDecimal(MAX_FILES_INDEX_BYTES)
}

public fun indexReadable(files: PackFilesRef): Boolean =
    files.format == FILES_FORMAT && usableCodec(files.codec) && files.size <= MAX_FILES_INDEX_BYTES

/** A container's index and gaps together are rebuildable; a tree needs only the readable index. */
public fun indexRebuildable(files: PackFilesRef): Boolean {
    if (!indexReadable(files)) return false
    if (files.layout != "container") return true
    return usableCodec(files.gaps?.codec)
}

/** A variant is usable when its layout is `container`, or `tree` with a readable index. */
public fun variantUsable(variant: JsonElement?): Boolean {
    val v = variant.objectValue ?: return false
    val f = v["files"].objectValue ?: return false
    val layout = f["layout"].stringValue
    if (layout == "container") return true
    return layout == "tree" && indexReadable(v["files"])
}

public fun variantUsable(variant: PackVariant): Boolean {
    if (variant.files.layout == "container") return true
    return variant.files.layout == "tree" && indexReadable(variant.files)
}

/** What the host prefers: its engine (null outside Godot) and, per axis, its values in preference order. */
public data class VariantPrefs(val engine: String? = null, val axes: Map<String, List<String>> = emptyMap())

/** What [selectVariant] reports. */
public sealed interface SelectVariantResult {
    public data class Index(val index: Int) : SelectVariantResult

    /** `pack-no-variant`. */
    public data object NoVariant : SelectVariantResult

    public val json: JsonObject
        get() = when (this) {
            is Index -> buildJsonObject { put("index", jsonInt(index.toLong())) }
            NoVariant -> buildJsonObject { put("error", JsonPrimitive(ErrorCode.packNoVariant)) }
        }
}

private fun lexLess(a: List<Int>, b: List<Int>): Boolean {
    for (i in 0 until minOf(a.size, b.size)) if (a[i] != b[i]) return a[i] < b[i]
    return a.size < b.size
}

/**
 * `selectVariant(variants, {engine, axes})` (§2.9): a variant is eligible when it is usable, its
 * `requires.engine` is absent or equals the host's `engine`, and every axis it declares has a host
 * preference list containing its value. The lowest tuple of preference indexes over the axis names
 * in byte order wins; ties keep the earlier variant.
 */
public fun selectVariant(variants: List<JsonElement>, prefs: VariantPrefs): SelectVariantResult {
    var best: Pair<Int, List<Int>>? = null
    for ((i, v) in variants.withIndex()) {
        if (!variantUsable(v)) continue
        val variant = v.objectValue ?: continue
        val req = variant["requires"].objectValue
        if (req != null && req.containsKey("engine")) {
            val host: JsonElement = prefs.engine?.let { JsonPrimitive(it) } ?: JsonNull
            if (!jsonEquals(req["engine"], host)) continue
        }
        val sel = variant["variant"].objectValue ?: JsonObject(emptyMap())
        val key = ArrayList<Int>()
        var eligible = true
        for (axis in sel.keys.sortedWith { a, b -> compareUtf8Bytes(a, b) }) {
            val list = prefs.axes[axis]
            val value = sel[axis].stringValue
            val k = if (list != null && value != null) list.indexOf(value) else -1
            if (k < 0) {
                eligible = false
                break
            }
            key += k
        }
        if (!eligible) continue
        val b = best
        if (b == null || lexLess(key, b.second)) best = i to key
    }
    return best?.let { SelectVariantResult.Index(it.first) } ?: SelectVariantResult.NoVariant
}

/** A delta of the planner's input (A7 §4.1). */
public data class PlanDelta(val id: String, val method: String, val from: String, val memBytes: Long, val artifacts: List<PackHashBytes>)

/** One chunk record `[id, len, clen, bundle, offset]` (P4-10, P4-11). */
public data class PlanChunkRecord(val id: String, val len: Long, val clen: Long, val bundle: Int, val offset: Long)

/** One chunk record of a parsed index (the planner's record). */
public typealias ChunkRecord = PlanChunkRecord

private fun record(r: JsonElement?): PlanChunkRecord? {
    val a = r.arrayValue ?: return null
    if (a.size != 5) return null
    val bundle = a[3].longValue ?: return null
    if (bundle < 0 || bundle > Int.MAX_VALUE) return null
    return PlanChunkRecord(a[0].stringValue ?: return null, a[1].longValue ?: return null, a[2].longValue ?: return null, bundle.toInt(), a[4].longValue ?: return null)
}

/** The planner's target (A7 §4.1, with `full.requests`; plans/P4-01.md §2.9). */
public data class PlanTarget(
    val release: String,
    val payload: PackPayload,
    val full: Full?,
    val platform: String?,
    val chunks: Chunks?,
    val files: Files?,
    val deltas: List<PlanDelta>,
) {
    public data class Full(val bytes: Long, val requests: Long?)
    public data class Chunks(val indexBytes: Long, val records: List<PlanChunkRecord>)
    public data class FileBlob(val sha256: String, val blobBytes: Long)
    public data class Files(val indexBytes: Long, val gapsBytes: Long, val files: List<FileBlob>)

    /** The target as the corpus writes it. */
    public val json: JsonObject
        get() = buildJsonObject {
            put("release", JsonPrimitive(release))
            put("payload", payload.json)
            put("full", full?.let { f -> buildJsonObject { put("bytes", jsonInt(f.bytes)); f.requests?.let { put("requests", jsonInt(it)) } } } ?: JsonNull)
            put("platform", platform?.let { buildJsonObject { put("transport", JsonPrimitive(it)) } } ?: JsonNull)
            put("chunks", chunks?.let { c ->
                buildJsonObject {
                    put("indexBytes", jsonInt(c.indexBytes))
                    put("records", JsonArray(c.records.map {
                        JsonArray(listOf(JsonPrimitive(it.id), jsonInt(it.len), jsonInt(it.clen), jsonInt(it.bundle.toLong()), jsonInt(it.offset)))
                    }))
                }
            } ?: JsonNull)
            put("files", files?.let { f ->
                buildJsonObject {
                    put("indexBytes", jsonInt(f.indexBytes))
                    put("gapsBytes", jsonInt(f.gapsBytes))
                    put("files", JsonArray(f.files.map { buildJsonObject { put("sha256", JsonPrimitive(it.sha256)); put("blobBytes", jsonInt(it.blobBytes)) } }))
                }
            } ?: JsonNull)
            put("deltas", JsonArray(deltas.map { d ->
                buildJsonObject {
                    put("id", JsonPrimitive(d.id))
                    put("method", JsonPrimitive(d.method))
                    put("from", JsonPrimitive(d.from))
                    put("memBytes", jsonInt(d.memBytes))
                    put("artifacts", JsonArray(d.artifacts.map { buildJsonObject { put("sha256", JsonPrimitive(it.sha256)); put("bytes", jsonInt(it.bytes)) } }))
                }
            }))
        }

    public companion object {
        /** A target from the corpus's JSON (`plan-matrix.json#rows[].input.target`). */
        public fun from(json: JsonElement?): PlanTarget? {
            val o = json.objectValue ?: return null
            val release = o["release"].stringValue ?: return null
            val payload = PackPayload.from(o["payload"]) ?: return null
            val full = o["full"].objectValue?.let { f -> f["bytes"].longValue?.let { Full(it, f["requests"].longValue) } }
            val platform = o["platform"].objectValue?.get("transport").stringValue
            var chunks: Chunks? = null
            val c = o["chunks"].objectValue
            val ib = c?.get("indexBytes").longValue
            if (c != null && ib != null) chunks = Chunks(ib, (c["records"].arrayValue ?: emptyList()).map { record(it) ?: return null })
            var files: Files? = null
            val f = o["files"].objectValue
            val fib = f?.get("indexBytes").longValue
            val gb = f?.get("gapsBytes").longValue
            if (f != null && fib != null && gb != null) {
                files = Files(fib, gb, (f["files"].arrayValue ?: emptyList()).map { x ->
                    val xo = x.objectValue ?: return null
                    FileBlob(xo["sha256"].stringValue ?: return null, xo["blobBytes"].longValue ?: return null)
                })
            }
            val deltas = (o["deltas"].arrayValue ?: emptyList()).map { d ->
                val dobj = d.objectValue ?: return null
                PlanDelta(
                    dobj["id"].stringValue ?: return null, dobj["method"].stringValue ?: return null,
                    dobj["from"].stringValue ?: return null, dobj["memBytes"].longValue ?: return null,
                    (dobj["artifacts"].arrayValue ?: emptyList()).mapNotNull { PackHashBytes.from(it) },
                )
            }
            return PlanTarget(release, payload, full, platform, chunks, files, deltas)
        }
    }
}

/** What [planTarget] reads of a parsed chunk index (plans/P4-10.md §2.5). */
public data class PlanChunkIndex(val payloadSize: Long, val payloadSha256: String, val records: List<PlanChunkRecord>) {
    public companion object {
        /** From the corpus's JSON (`plan-matrix.json#targetCases[].chunkIndex`). */
        public fun from(json: JsonElement?): PlanChunkIndex? {
            val o = json.objectValue ?: return null
            val size = o["payloadSize"].longValue ?: return null
            val sha = o["payloadSha256"].stringValue ?: return null
            return PlanChunkIndex(size, sha, (o["records"].arrayValue ?: emptyList()).map { record(it) ?: return null })
        }
    }
}

/**
 * plans/P4-10.md §2.5: the chunk candidate when the variant is a usable `container`, `chunks.format`
 * is `pkey-chunks/1`, its codec is usable, `chunks.size` ≤ `MAX_CHUNK_INDEX_BYTES`, the parsed index
 * is given and bound to the payload, and no record's `len` exceeds `MAX_CHUNK_BYTES`.
 */
internal fun chunkTarget(variant: PackVariant, chunkIndex: PlanChunkIndex?): PlanTarget.Chunks? {
    val c = variant.chunks ?: return null
    if (chunkIndex == null) return null
    if (variant.files.layout != "container") return null
    if (c.format != CHUNKS_FORMAT || !usableCodec(c.ref.codec) || c.ref.size > MAX_CHUNK_INDEX_BYTES) return null
    if (chunkIndex.payloadSize != variant.payload.size || chunkIndex.payloadSha256 != variant.payload.sha256) return null
    if (chunkIndex.records.any { it.len > MAX_CHUNK_BYTES }) return null
    return PlanTarget.Chunks(c.ref.bytes, chunkIndex.records)
}

/**
 * `planTarget(variant, recordSha256, filesIndex | null)` (§2.9): a variant onto the planner's input.
 * An unusable variant maps to no candidate at all. `full` needs a usable ref whose size is the
 * payload's (a tree's costs its index too, in two requests); `files` needs a readable index (a
 * container: rebuildable); a `payload` delta is kept on a container, a `files` delta when `files` is
 * kept and its `patch` ref is usable; anything else is dropped.
 */
public fun planTarget(variant: PackVariant, recordSha256: String, filesIndex: FilesIndexDoc?, chunkIndex: PlanChunkIndex? = null): PlanTarget {
    val payload = variant.payload
    if (!variantUsable(variant)) return PlanTarget(recordSha256, payload, null, null, null, null, emptyList())
    val files = variant.files
    val container = files.layout == "container"
    var fullT: PlanTarget.Full? = null
    val full = variant.full
    if (full != null && usableCodec(full.codec) && full.size == payload.size) {
        fullT = if (container) PlanTarget.Full(full.bytes, 1) else PlanTarget.Full(full.bytes + files.bytes, 2)
    }
    var filesT: PlanTarget.Files? = null
    if (filesIndex != null && indexRebuildable(files)) {
        filesT = PlanTarget.Files(
            files.bytes, if (container) files.gaps?.bytes ?: 0 else 0,
            filesIndex.files.map { PlanTarget.FileBlob(it.sha256, it.blob.bytes) },
        )
    }
    val deltas = ArrayList<PlanDelta>()
    for (d in variant.deltas) {
        when {
            d is PackDelta.Payload && container -> deltas += PlanDelta(d.artifact.sha256, d.method, d.from, d.memBytes, listOf(d.artifact))
            d is PackDelta.Files && filesT != null && usableCodec(d.patch.codec) -> {
                val arts = arrayListOf(PackHashBytes(files.sha256, files.bytes))
                val g = files.gaps
                if (container && g != null) arts += PackHashBytes(g.sha256, g.bytes)
                arts += PackHashBytes(d.patch.sha256, d.patch.bytes)
                arts += d.data
                deltas += PlanDelta(d.patch.sha256, d.method, d.from, d.memBytes, arts)
            }
        }
    }
    return PlanTarget(recordSha256, payload, fullT, null, chunkTarget(variant, chunkIndex), filesT, deltas)
}

/** [withFeedDeltas]'s answer: the merged variant and the appended feed delta ids, in feed order. */
public data class MergedVariant(val variant: PackVariant, val feedIds: List<String>)

/**
 * `withFeedDeltas(variant, deltas)` (plans/P4-29.md §2.4 step 2): the variant with the feed's menu
 * for its payload appended to a copy of its deltas, after the record's own. Unchanged, with empty
 * `feedIds`, when [deltas] is null, the variant is not usable, its layout is not `container`, or the
 * menu has no key equal to `variant.payload.sha256`. An entry whose artifact hash equals an existing
 * delta id is skipped (a record delta wins). The merged list may exceed `MAX_VARIANT_DELTAS`. Pure.
 */
public fun withFeedDeltas(variant: PackVariant, deltas: FeedDeltas?): MergedVariant {
    if (deltas == null || !variantUsable(variant) || variant.files.layout != "container") return MergedVariant(variant, emptyList())
    val menu = deltas[variant.payload.sha256] ?: return MergedVariant(variant, emptyList())
    val merged = ArrayList(variant.deltas)
    val ids = merged.mapNotNull { it.id }.toHashSet()
    val feedIds = ArrayList<String>()
    for (e in menu) {
        if (!ids.add(e.artifactSha256)) continue
        merged += PackDelta.Payload(e.method, e.from, e.memBytes, PackHashBytes(e.artifactSha256, e.artifactBytes))
        feedIds += e.artifactSha256
    }
    if (feedIds.isEmpty()) return MergedVariant(variant, feedIds)
    return MergedVariant(variant.copy(deltas = merged), feedIds)
}
