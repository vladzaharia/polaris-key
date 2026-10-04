// `pkey-chunks/1`, the binary chunk index (plans/P4-10.md §2.3; WIRE-CONTRACT-V4 §2.6), and its
// parser. `content/cases.json#chunkIndexCases` pins `parseChunkIndex`. Pure, never throws.
// client-core `packs/chunks.ts` is the reference; Swift's `Chunks.swift` the structural model.
//
// Layout (all little-endian), exactly A7 §3.1:
//
//   header   64 B   "PKEYCHNK" | version u16 = 1 | recordSize u16 = 48 | flags u32 (bit 0
//                   fileAware) | chunkCount u32 | bundleCount u32 | payloadSize u64 |
//                   payloadSha256[32]
//   chunks   48 B   id[32] | len u32 | clen u32 | bundle u32 | offset u32, in payload order
//   bundles  48 B   sha256[32] | size u64 | reserved u64
//
// The u64 rule: a u64 is `hi × 2^32 + lo` from two u32 reads (low word first), saturated at 2^53,
// never a native 64-bit load. Every multi-byte read is composed from single bytes by index.

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MAX_CHUNK_INDEX_BYTES
import im.plrs.key.core.jsonInt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

private val CHUNKS_MAGIC = byteArrayOf(0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b)
private const val CHUNKS_HEADER_BYTES = 64
private const val CHUNKS_RECORD_BYTES = 48
private const val CHUNKS_FLAG_FILE_AWARE = 1L

/** 2^53, the u64 saturation point. */
public const val CHUNKS_U64_MAX: Long = 9_007_199_254_740_992L

/** One bundle `[sha256, size]` of a parsed index (`size` saturated at 2^53). */
public data class ChunkBundle(val sha256: String, val size: Long)

/** A parsed `pkey-chunks/1` index. */
public data class ChunkIndexDoc(
    val fileAware: Boolean,
    val payloadSize: Long,
    val payloadSha256: String,
    val records: List<ChunkRecord>,
    val bundles: List<ChunkBundle>,
) {
    /** What `planTarget` reads of it. */
    val planIndex: PlanChunkIndex get() = PlanChunkIndex(payloadSize, payloadSha256, records)
}

/** [parseChunkIndex]'s answer: the index, or the first failure with its `chunk` / `bundle`. */
public sealed interface ParseChunkIndexResult {
    public data class Ok(val index: ChunkIndexDoc) : ParseChunkIndexResult
    public data class Failed(val error: String, val chunk: Int? = null, val bundle: Int? = null) : ParseChunkIndexResult

    /** `{ok: false, error, chunk?, bundle?}`, or `{ok: true, chunks, bundleSizes}`. */
    public val json: JsonObject
        get() = when (this) {
            is Ok -> buildJsonObject {
                put("ok", JsonPrimitive(true))
                put("chunks", jsonInt(index.records.size.toLong()))
                put("bundleSizes", JsonArray(index.bundles.map { jsonInt(it.size) }))
            }
            is Failed -> buildJsonObject {
                put("ok", JsonPrimitive(false))
                put("error", JsonPrimitive(error))
                chunk?.let { put("chunk", jsonInt(it.toLong())) }
                bundle?.let { put("bundle", jsonInt(it.toLong())) }
            }
        }
}

/** The index, or null. */
public val ParseChunkIndexResult.index: ChunkIndexDoc? get() = (this as? ParseChunkIndexResult.Ok)?.index

private fun failed(error: String, chunk: Int? = null, bundle: Int? = null) = ParseChunkIndexResult.Failed(error, chunk, bundle)

private fun u8(b: ByteArray, at: Int): Long = (b[at].toLong() and 0xff)
private fun u16(b: ByteArray, at: Int): Long = u8(b, at) or (u8(b, at + 1) shl 8)
private fun u32(b: ByteArray, at: Int): Long = u8(b, at) or (u8(b, at + 1) shl 8) or (u8(b, at + 2) shl 16) or (u8(b, at + 3) shl 24)

/** A u64 at [at] by the u64 rule: two u32 reads, low word first, saturated at 2^53. */
public fun readChunkU64(b: ByteArray, at: Int): Long {
    val lo = u32(b, at)
    val hi = u32(b, at + 4)
    if (hi >= (1L shl 21)) return CHUNKS_U64_MAX
    return minOf(hi * 4_294_967_296L + lo, CHUNKS_U64_MAX)
}

/**
 * `parseChunkIndex(stored, ref, payload | null, decode, maxBytes)` (plans/P4-10.md §2.3): step 0 (the
 * stored object against its ref and its decode → `chunks-ref-mismatch`), then [parseChunkIndexBytes].
 */
public fun parseChunkIndex(
    stored: ByteArray,
    ref: PackObjectRef?,
    payload: PackPayload?,
    decode: ((ByteArray, Int) -> ByteArray)?,
    maxBytes: Long = MAX_CHUNK_INDEX_BYTES.toLong(),
): ParseChunkIndexResult {
    if (ref == null || ref.size > maxBytes || ref.size < 0) return failed(ErrorCode.chunksRefMismatch)
    if (stored.size.toLong() != ref.bytes) return failed(ErrorCode.chunksRefMismatch)
    if (sha256Of(stored) != ref.sha256) return failed(ErrorCode.chunksRefMismatch)
    val b = when (ref.codec) {
        "none" -> stored
        "zstd" -> {
            if (decode == null) return failed(ErrorCode.chunksRefMismatch)
            try {
                decode(stored, ref.size.toInt())
            } catch (e: Exception) {
                return failed(ErrorCode.chunksRefMismatch)
            }
        }
        else -> return failed(ErrorCode.chunksRefMismatch)
    }
    if (b.size.toLong() != ref.size) return failed(ErrorCode.chunksRefMismatch)
    return parseChunkIndexBytes(b, payload)
}

/** Steps 1–10 of `parseChunkIndex` over the decoded index bytes (no ref). Never throws. */
public fun parseChunkIndexBytes(b: ByteArray, payload: PackPayload?): ParseChunkIndexResult {
    if (b.size < CHUNKS_HEADER_BYTES) return failed(ErrorCode.chunksBadLength)
    for (i in CHUNKS_MAGIC.indices) if (b[i] != CHUNKS_MAGIC[i]) return failed(ErrorCode.chunksBadMagic)
    if (u16(b, 8) != 1L) return failed(ErrorCode.chunksUnsupportedVersion)
    if (u16(b, 10) != CHUNKS_RECORD_BYTES.toLong()) return failed(ErrorCode.chunksBadRecordSize)
    val flags = u32(b, 12)
    if (flags and CHUNKS_FLAG_FILE_AWARE.inv() != 0L) return failed(ErrorCode.chunksBadFlags)
    val n = u32(b, 16)
    val nb = u32(b, 20)
    if (b.size.toLong() != CHUNKS_HEADER_BYTES + CHUNKS_RECORD_BYTES * (n + nb)) return failed(ErrorCode.chunksBadLength)
    // From here n and nb are bounded by the array length.
    val ni = n.toInt()
    val nbi = nb.toInt()
    val payloadSize = readChunkU64(b, 24)
    val payloadSha256 = hexString(b, 32, 64)

    val bundles = ArrayList<ChunkBundle>(nbi)
    for (j in 0 until nbi) {
        val o = CHUNKS_HEADER_BYTES + CHUNKS_RECORD_BYTES * (ni + j)
        if (u32(b, o + 40) != 0L || u32(b, o + 44) != 0L) return failed(ErrorCode.chunksReservedNonzero, bundle = j)
        bundles += ChunkBundle(hexString(b, o, o + 32), readChunkU64(b, o + 32))
    }
    val records = ArrayList<ChunkRecord>(ni)
    var total = 0L
    for (i in 0 until ni) {
        val o = CHUNKS_HEADER_BYTES + CHUNKS_RECORD_BYTES * i
        val len = u32(b, o + 32)
        val clen = u32(b, o + 36)
        val bundle = u32(b, o + 40)
        val offset = u32(b, o + 44)
        if (len == 0L) return failed(ErrorCode.chunksZeroLength, chunk = i)
        if (clen == 0L || clen > len) return failed(ErrorCode.chunksBadClen, chunk = i)
        if (bundle >= nb) return failed(ErrorCode.chunksBadBundleRef, chunk = i)
        if (offset + clen > bundles[bundle.toInt()].size) return failed(ErrorCode.chunksBadBundleRange, chunk = i)
        total = minOf(total + len, CHUNKS_U64_MAX + 1)
        records += ChunkRecord(hexString(b, o, o + 32), len, clen, bundle.toInt(), offset)
    }
    if (total != payloadSize) return failed(ErrorCode.chunksSizeMismatch)
    if (payload != null && (payloadSha256 != payload.sha256 || payloadSize != payload.size)) return failed(ErrorCode.chunksPayloadMismatch)
    return ParseChunkIndexResult.Ok(ChunkIndexDoc(flags and CHUNKS_FLAG_FILE_AWARE != 0L, payloadSize, payloadSha256, records, bundles))
}
