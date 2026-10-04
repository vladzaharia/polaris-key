// The appliers (plans/P4-01.md §2.9; notes/A7 §3.4): `applyFull`, `applyDelta` and `applyFile`, over
// injected ports. `content/cases.json#applyCases` pins every verdict and counter. The first failure
// is the verdict, and nothing throws: a port that throws is the failing step's code. client-core
// `packs/apply.ts` is the reference; Swift's `Apply.swift` the structural model.
//
// Verify before use: a stored object's length and SHA-256 are checked against its ref before a byte
// is decoded, an installed base's SHA-256 against the delta's `from` before it is used, and the
// output's SHA-256 before it is reported. Every `zstd-patch-from` frame passes §2.7 rule 3's window
// check (`windowAllowed`, with the decoder's own P) before it is decoded, and a base that starts
// with the zstd dictionary magic is refused (rule 5).

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MAX_FILES_INDEX_BYTES
import im.plrs.key.core.jsonInt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The counters of the `file` strategy and of a `files` set (§2.9). */
public data class ApplyCounters(
    var reusedFiles: Long = 0,
    var deltaFiles: Long = 0,
    var blobFiles: Long = 0,
    /** The bytes of the objects fetched for the strategy, except the index and gaps. */
    var downloadedBytes: Long = 0,
)

/** An applier's verdict. */
public sealed interface ApplyVerdict {
    /** A rebuilt container: its payload hash and size. */
    public data class Container(val sha256: String, val size: Long, val counters: ApplyCounters? = null) : ApplyVerdict

    /** A rebuilt tree: its file count, total size and `treeDigest`. */
    public data class Tree(val files: Long, val bytes: Long, val treeDigest: String, val counters: ApplyCounters? = null) : ApplyVerdict
    public data class Failed(val error: String, val path: String? = null) : ApplyVerdict

    public val ok: Boolean get() = this !is Failed

    /** The verdict as the corpus writes it. */
    public val json: JsonObject
        get() = buildJsonObject {
            val c: ApplyCounters? = when (val v = this@ApplyVerdict) {
                is Container -> {
                    put("ok", JsonPrimitive(true))
                    put("sha256", JsonPrimitive(v.sha256))
                    put("size", jsonInt(v.size))
                    v.counters
                }
                is Tree -> {
                    put("ok", JsonPrimitive(true))
                    put("files", jsonInt(v.files))
                    put("bytes", jsonInt(v.bytes))
                    put("treeDigest", JsonPrimitive(v.treeDigest))
                    v.counters
                }
                is Failed -> {
                    put("ok", JsonPrimitive(false))
                    put("error", JsonPrimitive(v.error))
                    v.path?.let { put("path", JsonPrimitive(it)) }
                    null
                }
            }
            if (c != null) {
                put("reusedFiles", jsonInt(c.reusedFiles))
                put("deltaFiles", jsonInt(c.deltaFiles))
                put("blobFiles", jsonInt(c.blobFiles))
                put("downloadedBytes", jsonInt(c.downloadedBytes))
            }
        }
}

/** An applier's answer: the verdict, and the target index when one was read. */
public data class ApplyResult(val verdict: ApplyVerdict, val index: FilesIndexDoc? = null)

/** What the appliers read from and write to. */
public class ApplyPorts(
    /** The stored objects the strategy fetched, by the SHA-256 of their stored bytes. */
    public val objects: ObjectPort,
    public val zstd: ZstdPort,
    /** Where a container payload is written (offset 0 onward). Null: discarded. */
    public val sink: ByteSink? = null,
    /** Where a tree's files are written. Null: discarded. */
    public val tree: TreeSink? = null,
)

private fun fail(error: String, path: String? = null) = ApplyResult(ApplyVerdict.Failed(error, path))

private fun startsWithDictionaryMagic(b: ByteArray): Boolean =
    b.size >= 4 && (b[0].toInt() and 0xff) == 0x37 && (b[1].toInt() and 0xff) == 0xa4 && (b[2].toInt() and 0xff) == 0x30 && (b[3].toInt() and 0xff) == 0xec

/** One raw-prefix decode behind the window check (§2.7 rules 3 and 5). Null on refusal. */
internal fun prefixDecode(zstd: ZstdPort, frame: ByteArray, base: ByteArray, size: Long, memBytes: Long): ByteArray? {
    if (startsWithDictionaryMagic(base)) return null
    val wlm = windowLogMax(memBytes, zstd.pointerBits) ?: return null
    if (!windowAllowed(frame, memBytes, zstd.pointerBits)) return null
    if (size < 0 || size > Int.MAX_VALUE - 8) return null
    return try {
        zstd.decodeWithPrefix(frame, base, size.toInt(), wlm)
    } catch (e: Exception) {
        null
    }
}

private fun objectOf(ports: ApplyPorts, sha256: String): ByteSource? = try {
    ports.objects(sha256)
} catch (e: Exception) {
    null
}

/** Read and parse the target index (§2.7), refusing an oversized one before reading it. */
private fun readIndex(variant: PackVariant, ports: ApplyPorts): ParseFilesIndexResult {
    val files = variant.files
    var stored = ByteArray(0)
    if (files.size <= MAX_FILES_INDEX_BYTES && files.bytes <= MAX_FILES_INDEX_BYTES) {
        val src = objectOf(ports, files.sha256)
        if (src != null && src.size == files.bytes) stored = try {
            readAll(src)
        } catch (e: Exception) {
            ByteArray(0)
        }
    }
    val zstd = ports.zstd
    return parseFilesIndex(stored, files, variant.payload, { f, s -> zstd.decode(f, s) })
}

/** Write a source's bytes to a sink at [at], feeding a hasher; returns the bytes written. */
private fun copyThrough(source: ByteSource, sink: ByteSink?, at: Long, hasher: PackHasher): Long {
    var n = 0L
    while (n < source.size) {
        val chunk = source.read(n, minOf(READ_CHUNK.toLong(), source.size - n).toInt())
        if (chunk.isEmpty()) break
        hasher.update(chunk)
        sink?.write(at + n, chunk)
        n += chunk.size
    }
    return n
}

private class Overrun : RuntimeException(null, null, false, false)

/**
 * `applyFull` (§2.9): a tree first validates its index (§2.7's codes). Then, before decoding, the
 * `full` ref must be usable with `full.size == payload.size`, and the stored length and SHA-256 must
 * equal the ref → else `full-corrupt`; the decode must give exactly `full.size` bytes. A container's
 * bytes must hash to `payload.sha256`; a tree's are split by entry sizes in index order and every
 * file's SHA-256 checked → `full-corrupt`.
 */
public fun applyFull(variant: PackVariant, ports: ApplyPorts): ApplyResult {
    val payload = variant.payload
    var index: FilesIndexDoc? = null
    if (variant.files.layout == "tree") {
        when (val r = readIndex(variant, ports)) {
            is ParseFilesIndexResult.Ok -> index = r.index
            is ParseFilesIndexResult.Refused -> return fail(r.error, r.path)
        }
    }
    val full = variant.full
    if (full == null || !usableCodec(full.codec) || full.size != payload.size) return fail(ErrorCode.fullCorrupt)
    val stored = objectOf(ports, full.sha256)
    if (stored == null || stored.size != full.bytes) return fail(ErrorCode.fullCorrupt)
    return try {
        // Stream the decode when the port can, so a large payload never sits in one buffer.
        if (full.codec == "zstd" && ports.zstd.canStream) {
            if (hashSource(stored) != full.sha256) return fail(ErrorCode.fullCorrupt)
            return streamFull(variant, index, stored, ports)
        }
        val out = openObject(stored, full, ports.zstd) ?: return fail(ErrorCode.fullCorrupt)
        if (index == null) {
            if (sha256Of(out) != payload.sha256) return fail(ErrorCode.fullCorrupt)
            ports.sink?.write(0, out)
            return ApplyResult(ApplyVerdict.Container(payload.sha256, out.size.toLong()))
        }
        var pos = 0
        for (f in index.files) {
            if (pos + f.size > out.size) return fail(ErrorCode.fullCorrupt)
            val part = out.copyOfRange(pos, pos + f.size.toInt())
            pos += f.size.toInt()
            if (sha256Of(part) != f.sha256) return fail(ErrorCode.fullCorrupt)
            ports.tree?.writeFile(f.path, part)
        }
        ApplyResult(ApplyVerdict.Tree(index.files.size.toLong(), out.size.toLong(), treeDigest(index.files)), index)
    } catch (e: Exception) {
        fail(ErrorCode.fullCorrupt)
    }
}

/** `applyFull`'s streaming path: the output is hashed (a container) or split into files (a tree) as it arrives. */
private fun streamFull(variant: PackVariant, index: FilesIndexDoc?, stored: ByteSource, ports: ApplyPorts): ApplyResult {
    val payload = variant.payload
    val size = variant.full!!.size
    var total = 0L
    if (index == null) {
        val hasher = PackHasher()
        try {
            ports.zstd.decodeStream(stored, size) { chunk ->
                if (total + chunk.size > size) throw Overrun()
                hasher.update(chunk)
                ports.sink?.write(total, chunk)
                total += chunk.size
            }
        } catch (e: Exception) {
            return fail(ErrorCode.fullCorrupt)
        }
        if (total != size || hasher.digest() != payload.sha256) return fail(ErrorCode.fullCorrupt)
        return ApplyResult(ApplyVerdict.Container(payload.sha256, size))
    }
    // A tree: walk the entries as the bytes arrive; each file is buffered alone.
    val files = index.files
    var i = 0
    // The bytes of the file being assembled; copied out only when a file completes.
    val acc = java.io.ByteArrayOutputStream()
    fun flush() {
        while (i < files.size && acc.size() >= files[i].size) {
            val all = acc.toByteArray()
            var at = 0
            while (i < files.size && all.size - at >= files[i].size) {
                val f = files[i]
                val part = all.copyOfRange(at, at + f.size.toInt())
                at += f.size.toInt()
                if (sha256Of(part) != f.sha256) throw Overrun()
                ports.tree?.writeFile(f.path, part)
                i++
            }
            acc.reset()
            acc.write(all, at, all.size - at)
        }
    }
    try {
        flush() // zero-size files at the start
        ports.zstd.decodeStream(stored, size) { chunk ->
            if (total + chunk.size > size) throw Overrun()
            total += chunk.size
            acc.write(chunk)
            flush()
        }
    } catch (e: Exception) {
        return fail(ErrorCode.fullCorrupt)
    }
    if (total != size || i != files.size) return fail(ErrorCode.fullCorrupt)
    return ApplyResult(ApplyVerdict.Tree(files.size.toLong(), total, treeDigest(files)), index)
}

/**
 * `applyDelta` (`payload` scope, §2.9): the artifact against its ref → `delta-artifact-mismatch`;
 * the base's SHA-256 equals `from` → `delta-base-mismatch`; §2.7 rule 3's window check, then the
 * raw-prefix decode, its length and its SHA-256 against `payload` → `delta-apply-failed`.
 * [skipBaseCheck] is the corpus's test-only switch.
 */
public fun applyDelta(variant: PackVariant, deltaIndex: Int, base: ByteSource, ports: ApplyPorts, skipBaseCheck: Boolean = false): ApplyResult {
    val payload = variant.payload
    val d = variant.deltas.getOrNull(deltaIndex) as? PackDelta.Payload ?: return fail(ErrorCode.deltaArtifactMismatch)
    return try {
        val src = objectOf(ports, d.artifact.sha256)
        if (src == null || src.size != d.artifact.bytes) return fail(ErrorCode.deltaArtifactMismatch)
        val frame = readAll(src)
        if (frame.size.toLong() != d.artifact.bytes || sha256Of(frame) != d.artifact.sha256) return fail(ErrorCode.deltaArtifactMismatch)
        val baseBytes = readAll(base)
        if (!skipBaseCheck && sha256Of(baseBytes) != d.from) return fail(ErrorCode.deltaBaseMismatch)
        val out = prefixDecode(ports.zstd, frame, baseBytes, payload.size, d.memBytes)
        if (out == null || out.size.toLong() != payload.size || sha256Of(out) != payload.sha256) return fail(ErrorCode.deltaApplyFailed)
        ports.sink?.write(0, out)
        ApplyResult(ApplyVerdict.Container(payload.sha256, out.size.toLong()))
    } catch (e: Exception) {
        fail(ErrorCode.deltaApplyFailed)
    }
}

/**
 * `applyFile` (§2.9), for the `file` strategy ([deltaIndex] null) and for a `files`-scope set: the
 * target index, the gaps ref of a container (`files-layout-mismatch`), the descriptor and data of a
 * set (`delta-artifact-mismatch`). Then for each target file in index order: reuse an installed file
 * with the same SHA-256; else the set's `delta` entry (`delta-base-mismatch {path}`, then the window
 * check and decode → `delta-apply-failed {path}`); else its `blob` entry, or for the `file` strategy
 * the file's own blob (`file-corrupt {path}`); else `file-source-missing {path}`. A container's
 * payload SHA-256 → `payload-hash-mismatch`; a tree checks every file, reused ones included.
 */
public fun applyFile(variant: PackVariant, deltaIndex: Int?, installed: List<InstalledFile>, ports: ApplyPorts): ApplyResult {
    var current: Pair<String, String?> = ErrorCode.fileCorrupt to null
    try {
        val payload = variant.payload
        val index = when (val r = readIndex(variant, ports)) {
            is ParseFilesIndexResult.Ok -> r.index
            is ParseFilesIndexResult.Refused -> return fail(r.error, r.path)
        }
        val container = index.layout == "container"

        var gaps = ByteArray(0)
        if (container) {
            val g = variant.files.gaps ?: return fail(ErrorCode.filesLayoutMismatch)
            gaps = openObject(objectOf(ports, g.sha256), g, ports.zstd) ?: return fail(ErrorCode.filesLayoutMismatch)
        }

        val entries = HashMap<String, PatchEntry>()
        var data: ByteSource? = null
        var memBytes = 0L
        var downloaded = 0L
        var usingSet = false
        if (deltaIndex != null) {
            val d = variant.deltas.getOrNull(deltaIndex) as? PackDelta.Files ?: return fail(ErrorCode.deltaArtifactMismatch)
            usingSet = true
            memBytes = d.memBytes
            val patch = parsePatch(objectOf(ports, d.patch.sha256), d.method, d.from, d.patch, d.data, payload.sha256, index, ports.zstd)
                ?: return fail(ErrorCode.deltaArtifactMismatch)
            val ds = objectOf(ports, d.data.sha256)
            if (ds == null || ds.size != d.data.bytes || (try { hashSource(ds) } catch (e: Exception) { null }) != d.data.sha256) {
                return fail(ErrorCode.deltaArtifactMismatch)
            }
            data = ds
            downloaded = d.patch.bytes + d.data.bytes
            for (e in patch.entries) entries[e.path] = e
        }

        val have = HashMap<String, InstalledFile>()
        for (f in installed) if (!have.containsKey(f.sha256)) have[f.sha256] = f
        val counters = ApplyCounters()

        val hasher = PackHasher()
        var pos = 0L
        var gp = 0L
        var written = 0L
        val reused = ArrayList<InstalledFile?>()

        for (f in index.files) {
            current = ErrorCode.fileCorrupt to f.path
            val reuse = have[f.sha256]
            var bytes: ByteArray? = null
            if (reuse != null) {
                counters.reusedFiles++
            } else if (usingSet) {
                val e = entries[f.path] ?: return fail(ErrorCode.fileSourceMissing, f.path)
                if (e.length > Int.MAX_VALUE - 8) return fail(ErrorCode.fileCorrupt, f.path)
                val slice = data!!.read(e.offset, e.length.toInt())
                if (e.op == "delta") {
                    current = ErrorCode.deltaApplyFailed to f.path
                    val b = have[e.from!!] ?: return fail(ErrorCode.deltaBaseMismatch, f.path)
                    val baseBytes = readAll(b.source)
                    if (sha256Of(baseBytes) != e.from) return fail(ErrorCode.deltaBaseMismatch, f.path)
                    val out = prefixDecode(ports.zstd, slice, baseBytes, f.size, memBytes)
                    if (out == null || out.size.toLong() != f.size || sha256Of(out) != f.sha256) return fail(ErrorCode.deltaApplyFailed, f.path)
                    bytes = out
                    counters.deltaFiles++
                } else {
                    val out: ByteArray? = if (e.codec == "zstd") {
                        try {
                            ports.zstd.decode(slice, f.size.toInt())
                        } catch (x: Exception) {
                            null
                        }
                    } else slice
                    if (out == null || out.size.toLong() != f.size || sha256Of(out) != f.sha256) return fail(ErrorCode.fileCorrupt, f.path)
                    bytes = out
                    counters.blobFiles++
                }
            } else {
                val stored = objectOf(ports, f.blob.sha256) ?: return fail(ErrorCode.fileSourceMissing, f.path)
                val ref = PackObjectRef(f.blob.sha256, f.blob.bytes, f.size, f.blob.codec)
                val out = openObject(stored, ref, ports.zstd)
                if (out == null || sha256Of(out) != f.sha256) return fail(ErrorCode.fileCorrupt, f.path)
                bytes = out
                counters.blobFiles++
                downloaded += stored.size
            }

            if (container) {
                val offset = f.offset ?: 0
                val g = offset - pos
                // A gaps object shorter than the layout needs yields fewer bytes here, and the payload
                // hash then refuses the result.
                val lo = gp.coerceIn(0, gaps.size.toLong()).toInt()
                val hi = (gp + g).coerceIn(lo.toLong(), gaps.size.toLong()).toInt()
                val gap = gaps.copyOfRange(lo, hi)
                hasher.update(gap)
                ports.sink?.write(written, gap)
                written += gap.size
                gp += g
                val src: ByteSource = bytes?.let { MemorySource(it) } ?: reuse!!.source
                written += copyThrough(sliceSource(src, 0, f.size), ports.sink, written, hasher)
                pos = offset + f.size
            } else {
                if (bytes != null) ports.tree?.writeFile(f.path, bytes)
                reused += if (bytes == null) reuse else null
            }
        }

        counters.downloadedBytes = downloaded
        if (!container) {
            for ((i, f) in index.files.withIndex()) {
                val r = reused[i] ?: continue
                val b = readAll(sliceSource(r.source, 0, f.size))
                if (b.size.toLong() != f.size || sha256Of(b) != f.sha256) return fail(ErrorCode.fileCorrupt, f.path)
                ports.tree?.writeFile(f.path, b)
            }
            return ApplyResult(ApplyVerdict.Tree(index.files.size.toLong(), index.files.sumOf { it.size }, treeDigest(index.files), counters), index)
        }
        val trailing = if (gp < gaps.size) gaps.copyOfRange(gp.toInt(), gaps.size) else ByteArray(0)
        hasher.update(trailing)
        ports.sink?.write(written, trailing)
        written += trailing.size
        if (hasher.digest() != payload.sha256) return fail(ErrorCode.payloadHashMismatch)
        return ApplyResult(ApplyVerdict.Container(payload.sha256, written, counters), index)
    } catch (e: Exception) {
        return fail(current.first, current.second)
    }
}
