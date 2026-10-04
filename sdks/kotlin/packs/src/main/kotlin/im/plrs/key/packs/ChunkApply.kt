// `applyChunk`, chunk sync from seeds (plans/P4-10.md §2.5; notes/A7 §3.4; P4-11), over injected
// ports. `content/cases.json#applyCases` (`strategy: chunk`) pins every verdict and counter.
// client-core `packs/chunkApply.ts` is the reference; Swift's `ChunkApply.swift` the structural model.
//
//  1. The target index is read by its ref and parsed bound to the variant's payload.
//  2. The seed map S: id → (seed, offset), first occurrence over seeds in order, then records.
//  3. The request runs (`chunkRuns`, the planner's rule exactly). Each run is one single-range request.
//  4. For each target record in order: copy from a seed, else from the output when the id was
//     already written, else the next `clen` bytes of its run (`chunk-bundle-truncated {chunk}`,
//     `chunk-corrupt {chunk}`).
//  5. The payload's SHA-256 → `payload-hash-mismatch`; with `repair`, A7's repair pass first.
//
// Memory: the parsed index, the seed map and one chunk (`clen + len`, at most 2 × MAX_CHUNK_BYTES);
// the output goes to the host's positional sink, never a buffer, and a run's body is read as it
// arrives. Nothing throws: a port that throws is the step's verdict, and a transport that refuses or
// fails is `network-error` with `detail` (`range-refused` falls back; `interrupted` keeps the run
// journal for a resume).

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MAX_CHUNK_BYTES
import im.plrs.key.core.MAX_CHUNK_INDEX_BYTES
import im.plrs.key.core.jsonInt
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** A body read piece by piece: `next` returns the next piece, null at the end; throws when the transfer fails. */
public interface ByteStream {
    public suspend fun next(): ByteArray?

    /** Stop reading and release the body. */
    public fun close()

    public companion object {
        /** A stream over pieces already in memory. */
        public fun of(vararg pieces: ByteArray): ByteStream = object : ByteStream {
            private var k = 0
            override suspend fun next(): ByteArray? = if (k < pieces.size) pieces[k++] else null
            override fun close() {
                k = pieces.size
            }
        }

        /** An empty stream. */
        public val empty: ByteStream get() = of()
    }
}

/** One seed: an installed (or embedded) container payload whose chunk index is kept. */
public class ChunkSeed(public val index: ChunkIndexDoc, public val payload: ByteSource)

/** One single-range request: `length` bytes of the bundle whose SHA-256 is `bundle`, from `offset`. */
public data class ChunkRangeRequest(val bundle: String, val offset: Long, val length: Long)

/**
 * A range request's answer, as the applier reads it. `Ok`: the body (shorter than asked when the
 * object ends inside the range, or the transfer was cut short). `Refused`: the server answered with
 * anything but the exact range of the same object, so the strategy stops and the host falls back.
 */
public sealed interface ChunkRangeResponse {
    public class Ok(public val body: ByteStream) : ChunkRangeResponse
    public data object Refused : ChunkRangeResponse
}

public typealias ChunkRangeFetch = suspend (ChunkRangeRequest) -> ChunkRangeResponse

/** The output: a positional sink the applier can read back. `read` returns at most `length` bytes. */
public interface ChunkOutput {
    public fun write(offset: Long, bytes: ByteArray)
    public fun read(offset: Long, length: Int): ByteArray
}

/** What [applyChunk] reads from and writes to. */
public class ApplyChunkPorts(
    /** The stored target index, by the SHA-256 of its stored bytes. */
    public val objects: (String) -> ByteSource?,
    public val zstd: ZstdPort,
    public val fetchRange: ChunkRangeFetch,
    public val output: ChunkOutput,
)

/** The counters of a successful chunk apply (the corpus compares every one). */
public data class ChunkCounters(
    val sha256: String,
    val size: Long,
    val fetchedChunks: Long,
    val fetchedBytes: Long,
    /** The single-range requests sent for runs (the planner adds one for the index). */
    val requests: Long,
    val seedChunks: Long,
    val selfChunks: Long,
    val repairedChunks: List<Int>,
)

/** [applyChunk]'s verdict. */
public sealed interface ChunkVerdict {
    public data class Ok(val counters: ChunkCounters) : ChunkVerdict

    /** [detail] is `range-refused` (fall back) or `interrupted` (resume later), for `network-error` only. */
    public data class Failed(val error: String, val chunk: Int? = null, val bundle: Int? = null, val detail: String? = null) : ChunkVerdict

    public val ok: Boolean get() = this is Ok

    public val json: JsonObject
        get() = when (this) {
            is Ok -> buildJsonObject {
                val c = counters
                put("ok", JsonPrimitive(true))
                put("sha256", JsonPrimitive(c.sha256))
                put("size", jsonInt(c.size))
                put("fetchedChunks", jsonInt(c.fetchedChunks))
                put("fetchedBytes", jsonInt(c.fetchedBytes))
                put("requests", jsonInt(c.requests))
                put("seedChunks", jsonInt(c.seedChunks))
                put("selfChunks", jsonInt(c.selfChunks))
                put("repairedChunks", JsonArray(c.repairedChunks.map { jsonInt(it.toLong()) }))
            }
            is Failed -> buildJsonObject {
                put("ok", JsonPrimitive(false))
                put("error", JsonPrimitive(error))
                chunk?.let { put("chunk", jsonInt(it.toLong())) }
                bundle?.let { put("bundle", jsonInt(it.toLong())) }
                detail?.let { put("detail", JsonPrimitive(it)) }
            }
        }
}

/** [applyChunk]'s answer: the verdict, and the target index when it parsed. */
public data class ChunkApplyResult(val verdict: ChunkVerdict, val index: ChunkIndexDoc?)

/** One request run: its bundle index, byte range and the target records it carries, in order. */
public data class ChunkRun(val bundle: Int, val offset: Long, var length: Long, val records: MutableList<Int>)

/**
 * The request runs over a target index given the seeded ids (the planner's rule in `plan`): the
 * records neither seeded nor already fetched, grouped while the bundle stays the same and
 * `offset == prev.offset + prev.clen`.
 */
public fun chunkRuns(records: List<ChunkRecord>, seeded: (String) -> Boolean): List<ChunkRun> {
    val runs = ArrayList<ChunkRun>()
    val seen = HashSet<String>()
    var prev: ChunkRecord? = null
    for ((i, r) in records.withIndex()) {
        if (seeded(r.id) || r.id in seen) continue
        seen += r.id
        val p = prev
        if (p == null || r.bundle != p.bundle || r.offset != p.offset + p.clen) runs += ChunkRun(r.bundle, r.offset, 0, ArrayList())
        val last = runs[runs.size - 1]
        last.length = r.offset + r.clen - last.offset
        last.records += i
        prev = r
    }
    return runs
}

/** The seed map: id → (seed, offset), first occurrence over seeds in order, then records. */
public fun seedMap(seeds: List<ChunkSeed>): Map<String, Pair<Int, Long>> {
    val s = HashMap<String, Pair<Int, Long>>()
    for ((si, seed) in seeds.withIndex()) {
        var off = 0L
        for (r in seed.index.records) {
            if (!s.containsKey(r.id)) s[r.id] = si to off
            off += r.len
        }
    }
    return s
}

/** Reads a run's body record by record, holding only the record being read. */
private class RunReader(private var body: ByteStream?) {
    private var pending = ByteArray(0)
    private var at = 0

    /** Exactly `n` bytes, or fewer when the body ends first. Throws when the transfer fails. */
    suspend fun take(n: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream(n)
        while (out.size() < n) {
            if (at >= pending.size) {
                val b = body ?: break
                val next = b.next()
                if (next == null) {
                    close()
                    break
                }
                pending = next
                at = 0
                continue
            }
            val k = minOf(n - out.size(), pending.size - at)
            out.write(pending, at, k)
            at += k
        }
        return out.toByteArray()
    }

    fun close() {
        body?.close()
        body = null
        pending = ByteArray(0)
        at = 0
    }
}

private class ChunkFailure(val verdict: ChunkVerdict) : RuntimeException(null, null, false, false)

/**
 * `applyChunk(variant, seeds, ports, repair, completedRuns, onRunDone, onProgress)` (plans/P4-10.md
 * §2.5): the payload rebuilt into `ports.output`, or the first failure. [completedRuns] are runs an
 * earlier attempt completed (the run journal): each record of such a run is read back from the output
 * and re-hashed before reuse, and one that differs refetches the whole run. Never throws.
 */
public suspend fun applyChunk(
    variant: PackVariant,
    seeds: List<ChunkSeed>,
    ports: ApplyChunkPorts,
    repair: Boolean = false,
    completedRuns: Set<Int> = emptySet(),
    onRunDone: (suspend (Int) -> Unit)? = null,
    onProgress: ((Long) -> Unit)? = null,
): ChunkApplyResult {
    val payload = variant.payload
    val ref = variant.chunks?.ref ?: return ChunkApplyResult(ChunkVerdict.Failed(ErrorCode.chunksRefMismatch), null)
    // 1. The target index, bounded before a byte is read.
    var stored = ByteArray(0)
    if (ref.bytes >= 0 && ref.size >= 0 && ref.bytes <= MAX_CHUNK_INDEX_BYTES && ref.size <= MAX_CHUNK_INDEX_BYTES) {
        val src = try {
            ports.objects(ref.sha256)
        } catch (e: Exception) {
            null
        }
        if (src != null && src.size == ref.bytes) stored = try {
            readAll(src)
        } catch (e: Exception) {
            ByteArray(0)
        }
    }
    val zstd = ports.zstd
    val t = when (val r = parseChunkIndex(stored, ref, payload, { f, s -> zstd.decode(f, s) })) {
        is ParseChunkIndexResult.Ok -> r.index
        is ParseChunkIndexResult.Failed -> return ChunkApplyResult(ChunkVerdict.Failed(r.error, r.chunk, r.bundle), null)
    }
    fun done(v: ChunkVerdict) = ChunkApplyResult(v, t)
    for ((i, r) in t.records.withIndex()) if (r.len > MAX_CHUNK_BYTES) return done(ChunkVerdict.Failed(ErrorCode.chunkCorrupt, chunk = i))

    // 2–3. The seed map and the runs.
    val s = seedMap(seeds)
    val runs = chunkRuns(t.records) { s.containsKey(it) }
    val runOf = HashMap<Int, Int>()
    val lastOfRun = HashMap<Int, Int>()
    for ((k, run) in runs.withIndex()) {
        for (i in run.records) runOf[i] = k
        lastOfRun[run.records[run.records.size - 1]] = k
    }
    val posOf = LongArray(t.records.size)
    run {
        var p = 0L
        for ((i, r) in t.records.withIndex()) {
            posOf[i] = p
            p += r.len
        }
    }

    /** Decode and verify one fetched record's stored bytes. */
    fun verify(i: Int, raw: ByteArray): ByteArray {
        val r = t.records[i]
        if (raw.size < r.clen) throw ChunkFailure(ChunkVerdict.Failed(ErrorCode.chunkBundleTruncated, chunk = i))
        val data = if (r.clen == r.len) raw else try {
            zstd.decode(raw, r.len.toInt())
        } catch (e: Exception) {
            throw ChunkFailure(ChunkVerdict.Failed(ErrorCode.chunkCorrupt, chunk = i))
        }
        if (data.size.toLong() != r.len || sha256Of(data) != r.id) throw ChunkFailure(ChunkVerdict.Failed(ErrorCode.chunkCorrupt, chunk = i))
        return data
    }

    /** One single-range request; a refusal or a throw is the verdict. */
    suspend fun open(bundle: Int, offset: Long, length: Long): RunReader {
        val res = try {
            ports.fetchRange(ChunkRangeRequest(t.bundles[bundle].sha256, offset, length))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ChunkFailure(ChunkVerdict.Failed(ErrorCode.networkError, detail = "interrupted"))
        }
        if (res !is ChunkRangeResponse.Ok) throw ChunkFailure(ChunkVerdict.Failed(ErrorCode.networkError, detail = "range-refused"))
        return RunReader(res.body)
    }

    suspend fun takeOrInterrupted(rd: RunReader, n: Long): ByteArray = try {
        rd.take(n.toInt())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw ChunkFailure(ChunkVerdict.Failed(ErrorCode.networkError, detail = "interrupted"))
    }

    /** Whether every record of a journalled run still hashes to its id in the output. */
    fun runIntact(k: Int): Boolean {
        for (i in runs[k].records) {
            val r = t.records[i]
            val got = ports.output.read(posOf[i], r.len.toInt())
            if (got.size.toLong() != r.len || sha256Of(got) != r.id) return false
        }
        return true
    }

    // 4. Every record, in payload order.
    var current: Pair<String, Int?> = ErrorCode.chunksRefMismatch to null
    var reader: RunReader? = null
    try {
        val hasher = PackHasher()
        val kinds = ByteArray(t.records.size) // 0 seed, 1 self, 2 fetch
        val first = HashMap<String, Long>()
        var fetchedChunks = 0L
        var fetchedBytes = 0L
        var seedChunks = 0L
        var selfChunks = 0L
        var requests = 0L
        var openRun = -1
        var resumedRun = -1
        for (i in t.records.indices) {
            val r = t.records[i]
            val pos = posOf[i]
            current = ErrorCode.chunkCorrupt to i
            var data: ByteArray
            val hit = s[r.id]
            val f = first[r.id]
            if (hit != null) {
                val got = seeds[hit.first].payload.read(hit.second, r.len.toInt())
                data = if (got.size.toLong() == r.len) got else ByteArray(r.len.toInt()).also { got.copyInto(it, 0, 0, minOf(got.size, r.len.toInt())) }
                kinds[i] = 0
                seedChunks++
            } else if (f != null) {
                data = ports.output.read(f, r.len.toInt())
                kinds[i] = 1
                selfChunks++
            } else {
                val k = runOf.getValue(i)
                if (k != openRun && k != resumedRun) {
                    reader?.close()
                    reader = null
                    if (k in completedRuns && runIntact(k)) {
                        resumedRun = k
                    } else {
                        val run = runs[k]
                        reader = open(run.bundle, run.offset, run.length)
                        openRun = k
                        requests++
                    }
                }
                data = if (k == resumedRun) ports.output.read(pos, r.len.toInt()) else verify(i, takeOrInterrupted(reader!!, r.clen))
                kinds[i] = 2
                fetchedChunks++
                fetchedBytes += r.clen
            }
            if (!first.containsKey(r.id)) first[r.id] = pos
            if (kinds[i] != 2.toByte() || runOf[i] != resumedRun) ports.output.write(pos, data)
            hasher.update(data)
            val k = lastOfRun[i]
            if (k != null) {
                if (openRun == k) {
                    reader?.close()
                    reader = null
                }
                onRunDone?.invoke(k)
                onProgress?.invoke(fetchedBytes)
            }
        }

        // 5. The payload hash, with the repair pass.
        val repaired = ArrayList<Int>()
        if (hasher.digest() != payload.sha256) {
            if (!repair) return done(ChunkVerdict.Failed(ErrorCode.payloadHashMismatch))
            for (i in t.records.indices) {
                if (kinds[i] != 0.toByte()) continue
                val r = t.records[i]
                current = ErrorCode.chunkCorrupt to i
                val back = ports.output.read(posOf[i], r.len.toInt())
                if (back.size.toLong() == r.len && sha256Of(back) == r.id) continue
                val rd = open(r.bundle, r.offset, r.clen)
                val raw = try {
                    takeOrInterrupted(rd, r.clen)
                } finally {
                    rd.close()
                }
                ports.output.write(posOf[i], verify(i, raw))
                repaired += i
            }
            current = ErrorCode.payloadHashMismatch to null
            val again = PackHasher()
            var at = 0L
            while (at < t.payloadSize) {
                val part = ports.output.read(at, minOf(READ_CHUNK.toLong(), t.payloadSize - at).toInt())
                if (part.isEmpty()) break
                again.update(part)
                at += part.size
            }
            if (again.digest() != payload.sha256) return done(ChunkVerdict.Failed(ErrorCode.payloadHashMismatch))
        }
        return done(
            ChunkVerdict.Ok(ChunkCounters(payload.sha256, t.payloadSize, fetchedChunks, fetchedBytes, requests, seedChunks, selfChunks, repaired)),
        )
    } catch (e: ChunkFailure) {
        return done(e.verdict)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return ChunkApplyResult(ChunkVerdict.Failed(current.first, current.second), null)
    } finally {
        reader?.close()
    }
}

// ── The exact Content-Range adapter ─────────────────────────────────────────────────────────────

/** `bytes <o>-<e>/<size>`, each 1–16 ASCII digits, after trimming whitespace; null otherwise. */
internal fun parseContentRange(value: String): Triple<Long, Long, Long>? {
    val s = value.trim()
    if (!s.startsWith("bytes ")) return null
    val rest = s.substring(6)
    val nums = ArrayList<Long>()
    var cur = 0L
    var digits = 0
    val seps = charArrayOf('-', '/')
    for (c in rest) {
        if (c in '0'..'9') {
            digits++
            if (digits > 16) return null
            cur = cur * 10 + (c - '0')
        } else if (nums.size < 2 && c == seps[nums.size] && digits > 0) {
            nums += cur
            cur = 0
            digits = 0
        } else {
            return null
        }
    }
    if (nums.size != 2 || digits == 0) return null
    return Triple(nums[0], nums[1], cur)
}

/** At most [n] bytes of a body, then the body is released. */
private class CappedBody(private var body: ByteStream?, private var left: Long) : ByteStream {
    override suspend fun next(): ByteArray? {
        while (left > 0) {
            val b = body ?: return null
            val c = b.next()
            if (c == null) {
                body = null
                return null
            }
            if (c.isEmpty()) continue
            if (c.size >= left) {
                val out = c.copyOf(left.toInt())
                left = 0
                close()
                return out
            }
            left -= c.size
            return c
        }
        close()
        return null
    }

    override fun close() {
        body?.close()
        body = null
    }
}

/**
 * The chunk strategy's `fetchRange` over the host's object fetch (plans/P4-10.md §2.5): one
 * single-range request per run, `Range: bytes=<o>-<o+len-1>` with `If-Range: "<bundle sha256>"`.
 * Only a `206` whose `Content-Range` is exactly `bytes o-e/<size>` for the request is read, or one
 * clipped at the object's end; an `ETag`, when present, must be exactly the quoted bundle hash.
 * Anything else is `Refused`, and the body is never read. Never a multi-range.
 */
public fun chunkRangeFetch(fetch: ObjectFetch): ChunkRangeFetch = { req ->
    val tag = "\"${req.bundle}\""
    val res = fetch(ObjectRequest(req.bundle, req.offset, tag, req.length))
    val end = req.offset + req.length - 1
    var take = -1L
    val m = res.contentRange?.let { parseContentRange(it) }
    if (req.length > 0 && res.status == 206 && m != null && (res.etag == null || res.etag == tag)) {
        val (start, e, size) = m
        if (start == req.offset && e == end && end < size) {
            take = req.length
        } else if (start == req.offset && e < end && e == size - 1 && e >= start) {
            take = e - start + 1
        }
    }
    if (take < 0) {
        res.body.close()
        ChunkRangeResponse.Refused
    } else {
        ChunkRangeResponse.Ok(CappedBody(res.body, take))
    }
}
