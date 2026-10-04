// @pkey-feature packs.index.files packs.index.chunks packs.apply.full packs.apply.file packs.apply.chunk packs.apply.delta packs.state packs.delta.feed packs.record update.content
//
// The content corpus ("conformance/corpus/v2/content/", plans/P4-01.md §4.4, plans/P4-10.md §4.3,
// plans/P4-29.md §4.4), read from the checkout (never mirrored), through :packs' production code:
//
//   blobs               every file under content/blobs/ against the `blobs` table (harness check)
//   pathCases           §2.7's path rules                        → checkPaths
//   filesIndexCases     §2.7's parseFilesIndex, steps 1–5         → parseFilesIndex
//   packSetIdCases      §2.9's packSetId                          → packSetId
//   stampCases          §2.8's content stamp                      → parseContentStamp, and
//                       `expect.holds` (when present)             → stampHolds
//   frameWindowCases    §2.7 rule 3's header window               → frameWindow
//   applyCases          §2.9's appliers, verdicts and counters    → applyFull, applyDelta, applyFile, applyChunk
//   chunkIndexCases     plans/P4-10.md §2.3's parser               → parseChunkIndex
//   feedDeltaApplyCases plans/P4-29.md §4.4's merged feed delta   → withFeedDeltas, applyDelta
//
// Every decoding section runs under both zstd paths (libzstd streaming the `full` payload, and the
// one-shot path), as the Node runner runs one per decoder. The `packs.state` proof's other half is
// stage-matrix.json (StageMatrixTest).

package im.plrs.key.conformance

import im.plrs.key.core.CONTENT_CORPUS_VERSION
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stampHolds
import im.plrs.key.core.stringValue
import im.plrs.key.packs.ApplyPorts
import im.plrs.key.packs.ApplyChunkPorts
import im.plrs.key.packs.ByteStream
import im.plrs.key.packs.ChunkOutput
import im.plrs.key.packs.ChunkRangeResponse
import im.plrs.key.packs.ChunkSeed
import im.plrs.key.packs.FilesIndexDoc
import im.plrs.key.packs.InstalledFile
import im.plrs.key.packs.LibZstd
import im.plrs.key.packs.MemorySource
import im.plrs.key.packs.PackFilesRef
import im.plrs.key.packs.PackObjectRef
import im.plrs.key.packs.PackPayload
import im.plrs.key.packs.PackSetEntry
import im.plrs.key.packs.PackVariant
import im.plrs.key.packs.ParseChunkIndexResult
import im.plrs.key.packs.ParseFilesIndexResult
import im.plrs.key.packs.ZstdPort
import im.plrs.key.packs.applyChunk
import im.plrs.key.packs.applyDelta
import im.plrs.key.packs.applyFile
import im.plrs.key.packs.applyFull
import im.plrs.key.packs.checkPaths
import im.plrs.key.packs.frameWindow
import im.plrs.key.packs.hexBytes
import im.plrs.key.packs.packSetId
import im.plrs.key.packs.parseChunkIndex
import im.plrs.key.packs.parseChunkIndexBytes
import im.plrs.key.packs.parseContentStamp
import im.plrs.key.packs.parseFilesIndex
import im.plrs.key.packs.readChunkU64
import im.plrs.key.packs.sha256Of
import im.plrs.key.packs.sliceSource
import im.plrs.key.packs.withFeedDeltas
import im.plrs.key.packs.CHUNKS_U64_MAX
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/** libzstd without its streaming decode: `applyFull` then takes its one-buffer path. */
private class OneShotZstd(private val base: LibZstd = LibZstd()) : ZstdPort {
    override val pointerBits: Int get() = base.pointerBits
    override fun decode(frame: ByteArray, size: Int): ByteArray = base.decode(frame, size)
    override fun decodeWithPrefix(frame: ByteArray, prefix: ByteArray, size: Int, windowLogMax: Int): ByteArray = base.decodeWithPrefix(frame, prefix, size, windowLogMax)
}

/** An in-memory chunk output of a fixed size. */
private class MemoryChunkOutput(size: Int) : ChunkOutput {
    private val bytes = ByteArray(size)

    @Synchronized
    override fun write(offset: Long, bytes: ByteArray) {
        if (offset < 0 || offset + bytes.size > this.bytes.size) throw IllegalArgumentException("short output")
        bytes.copyInto(this.bytes, offset.toInt())
    }

    @Synchronized
    override fun read(offset: Long, length: Int): ByteArray {
        val lo = offset.coerceIn(0, bytes.size.toLong()).toInt()
        val hi = (offset + length).coerceIn(lo.toLong(), bytes.size.toLong()).toInt()
        return bytes.copyOfRange(lo, hi)
    }
}

class ContentCorpusTest : ConformanceSuite() {
    companion object {
        private val zstd = LibZstd()

        /** The backends the decoding sections run under. */
        private val backends: List<Pair<String, ZstdPort>> = listOf("libzstd (streaming full)" to LibZstd(), "libzstd (one-shot)" to OneShotZstd())

        /** The eight chunk apply cases (plans/P4-10.md §4.3), every one run. */
        private val chunkApplyCases = listOf(
            "chunk-v1-to-v2", "chunk-no-seed", "chunk-tampered-zstd", "chunk-tampered-raw", "chunk-bundle-truncated",
            "chunk-seed-tampered", "chunk-seed-tampered-repair", "chunk-index-for-other-payload",
        )

        @BeforeClass
        @JvmStatic
        fun requireDecoder() {
            assertTrue("zstd-jni's native libzstd loads on this host", LibZstd.available)
            println("[conformance-kotlin] content corpus: libzstd ${LibZstd.version} through zstd-jni")
        }
    }

    private val corpus: JsonObject = ContentCorpus.load()
    private val blobs = ContentCorpus.blobs

    private fun section(name: String): List<JsonObject> = corpus[name]!!.arrayValue!!.map { it.obj }

    /** Materialise a `<ref>`: the blob (decoded when `codec` is `zstd`) or the text, then mutated. */
    private fun materialise(ref: JsonElement): ByteArray {
        val o = ref.obj
        var bytes: ByteArray = o["text"].stringValue?.toByteArray(Charsets.UTF_8) ?: run {
            val name = o["blob"].stringValue!!
            val raw = blobs[name] ?: error("no blob $name")
            // A copy: the mutations below must never reach the shared blob table.
            if (o["codec"].stringValue == "zstd") zstd.decode(raw, o["size"].longValue!!.toInt()) else raw.copyOf()
        }
        for (m in o["mutate"].arrayValue ?: emptyList()) {
            val mo = m.obj
            when (val op = mo["op"].stringValue) {
                "truncate" -> bytes = bytes.copyOf(minOf(bytes.size, mo["length"].longValue!!.toInt()))
                "xor" -> {
                    val at = mo["offset"].longValue!!.toInt()
                    bytes[at] = (bytes[at].toInt() xor mo["value"].longValue!!.toInt()).toByte()
                }
                "putU16", "putU32", "putU64" -> {
                    val at = mo["offset"].longValue!!.toInt()
                    val value = mo["value"].longValue!!
                    val width = when (op) {
                        "putU16" -> 2
                        "putU32" -> 4
                        else -> 8
                    }
                    for (k in 0 until width) bytes[at + k] = ((value ushr (8 * k)) and 0xff).toByte()
                }
                else -> error("unknown mutation $m")
            }
        }
        return bytes
    }

    @Test
    fun versionAndSections() {
        assertEquals(CONTENT_CORPUS_VERSION.toLong(), corpus["contentCorpusVersion"].longValue)
        assertEquals(18, section("pathCases").size)
        assertEquals(15, section("filesIndexCases").size)
        assertEquals(22, section("chunkIndexCases").size)
        assertEquals(7, section("packSetIdCases").size)
        assertEquals(10, section("stampCases").size)
        assertEquals(13, section("frameWindowCases").size)
        assertEquals(27, section("applyCases").size)
        assertEquals(4, section("feedDeltaApplyCases").size)
        assertEquals(chunkApplyCases, section("applyCases").filter { it["strategy"].stringValue == "chunk" }.map { it["id"].stringValue })
    }

    @Test
    fun blobsMatchTheTableAndNothingElseIsThere() {
        val table = corpus["blobs"]!!.obj
        assertEquals(table.keys.sorted(), blobs.keys.sorted())
        for ((name, want) in table) {
            val got = blobs.getValue(name)
            assertEquals(name, want.obj["size"].longValue, got.size.toLong())
            assertEquals(name, want.obj["sha256"].stringValue, sha256Of(got))
        }
    }

    @Test
    fun chunkIndexCases() {
        val f = Failures("chunkIndexCases")
        for ((label, z) in backends) {
            for (o in section("chunkIndexCases")) {
                val r = parseChunkIndex(materialise(o["stored"]!!), PackObjectRef.from(o["chunks"]), PackPayload.from(o["payload"]), { fr, s -> z.decode(fr, s) })
                f.check(jsonEquals(o["expect"], r.json)) { "[$label] ${o["id"].stringValue}: ${o["description"].stringValue}: got ${r.json}" }
            }
        }
        f.done(44)
    }

    /** The u64 rule (plans/P4-10.md §2.3): low word first, saturated at 2^53, at any offset. */
    @Test
    fun chunkU64RuleAtUnalignedOffsets() {
        for (pad in 0 until 8) {
            fun at(vararg b: Int) = ByteArray(pad) { 0xee.toByte() } + ByteArray(b.size) { b[it].toByte() }
            assertEquals(2L * 4_294_967_296L + 1, readChunkU64(at(1, 0, 0, 0, 2, 0, 0, 0), pad))
            assertEquals(9_007_199_254_740_991L, readChunkU64(at(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0), pad))
            assertEquals(CHUNKS_U64_MAX, readChunkU64(at(0, 0, 0, 0, 0, 0, 0x20, 0), pad))
            assertEquals(CHUNKS_U64_MAX, readChunkU64(at(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), pad))
        }
    }

    @Test
    fun chunkIndexCaseInputs() {
        for (o in section("chunkIndexCases")) {
            val id = o["id"].stringValue
            val stored = materialise(o["stored"]!!)
            val ref = o["chunks"]!!.obj
            val matches = stored.size.toLong() == ref["bytes"].longValue && sha256Of(stored) == ref["sha256"].stringValue
            assertEquals(id, id != "chunks-ref-tampered", matches)
        }
    }

    @Test
    fun chunkApplyCases() = runBlocking {
        val f = Failures("applyCases (chunk)")
        val cases = section("applyCases").filter { it["strategy"].stringValue == "chunk" }
        assertEquals(8, cases.size)
        for ((label, z) in backends) {
            for (o in cases) {
                val id = o["id"].stringValue
                val store = (o["objects"].objectValue ?: JsonObject(emptyMap())).mapValues { materialise(it.value) }
                val seeds = (o["seeds"].arrayValue ?: emptyList()).mapNotNull { sd ->
                    val so = sd.obj
                    (parseChunkIndexBytes(materialise(so["index"]!!), null) as? ParseChunkIndexResult.Ok)?.let { ChunkSeed(it.index, MemorySource(materialise(so["payload"]!!))) }
                }
                val variant = PackVariant.from(o["variant"]) ?: error(id ?: "")
                val output = MemoryChunkOutput(variant.payload.size.toInt())
                val r = applyChunk(
                    variant, seeds,
                    ApplyChunkPorts(
                        objects = { h -> store[h]?.let { MemorySource(it) } },
                        zstd = z,
                        fetchRange = { req ->
                            val b = store[req.bundle] ?: ByteArray(0)
                            val lo = minOf(req.offset, b.size.toLong()).toInt()
                            val hi = minOf(req.offset + req.length, b.size.toLong()).toInt()
                            ChunkRangeResponse.Ok(ByteStream.of(b.copyOfRange(lo, maxOf(lo, hi))))
                        },
                        output = output,
                    ),
                    repair = o["repair"].boolValue == true,
                )
                f.check(jsonEquals(o["expect"], r.verdict.json)) { "[$label] $id: ${o["description"].stringValue}: got ${r.verdict.json}" }
            }
        }
        f.done(16)
    }

    @Test
    fun pathCases() {
        val f = Failures("pathCases")
        for (o in section("pathCases")) {
            val got = checkPaths(o["paths"]!!.arrayValue!!.map { it.stringValue ?: "" }).json
            f.check(jsonEquals(o["expect"], got)) { "${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(18)
    }

    @Test
    fun filesIndexCases() {
        val f = Failures("filesIndexCases")
        for (o in section("filesIndexCases")) {
            val r = parseFilesIndex(materialise(o["stored"]!!), PackFilesRef.from(o["files"])!!, PackPayload.from(o["payload"])!!, { fr, s -> zstd.decode(fr, s) })
            val got: JsonObject = when (r) {
                is ParseFilesIndexResult.Ok -> buildJsonObject {
                    put("ok", JsonPrimitive(true))
                    put("files", jsonInt(r.index.files.size.toLong()))
                }
                is ParseFilesIndexResult.Refused -> buildJsonObject {
                    put("ok", JsonPrimitive(false))
                    put("error", JsonPrimitive(r.error))
                    r.path?.let { put("path", JsonPrimitive(it)) }
                }
            }
            f.check(jsonEquals(o["expect"], got)) { "${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(15)
    }

    @Test
    fun applyCases() {
        val f = Failures("applyCases")
        for ((label, z) in backends) {
            for (o in section("applyCases")) {
                val id = o["id"].stringValue
                if (o["strategy"].stringValue == "chunk") continue
                val store = (o["objects"].objectValue ?: JsonObject(emptyMap())).mapValues { materialise(it.value) }
                var base = ByteArray(0)
                var installed: List<InstalledFile> = emptyList()
                o["installed"].objectValue?.let { inst ->
                    base = materialise(inst["payload"]!!)
                    val idx = FilesIndexDoc.from(im.plrs.key.core.JsonText.parse(materialise(inst["files"]!!).toString(Charsets.UTF_8)))!!
                    val whole = MemorySource(base)
                    installed = idx.files.map { InstalledFile(it.path, it.sha256, it.size, sliceSource(whole, it.offset ?: 0, it.size)) }
                }
                val variant = PackVariant.from(o["variant"]) ?: error(id ?: "")
                val ports = ApplyPorts({ h -> store[h]?.let { MemorySource(it) } }, z)
                val r = when (o["strategy"].stringValue) {
                    "full" -> applyFull(variant, ports)
                    "delta" -> applyDelta(variant, o["delta"].longValue!!.toInt(), MemorySource(base), ports, o["skipBaseCheck"].boolValue == true)
                    "file" -> applyFile(variant, o["delta"].longValue?.toInt(), installed, ports)
                    else -> error("$id: unknown strategy")
                }
                f.check(jsonEquals(o["expect"], r.verdict.json)) { "[$label] $id: ${o["description"].stringValue}: got ${r.verdict.json}" }
            }
        }
        f.done(38)
    }

    @Test
    fun feedDeltaApplyCases() {
        val f = Failures("feedDeltaApplyCases")
        for ((label, z) in backends) {
            for (o in section("feedDeltaApplyCases")) {
                val id = o["id"].stringValue
                val store = (o["objects"].objectValue ?: JsonObject(emptyMap())).mapValues { materialise(it.value) }
                val variant = PackVariant.from(o["variant"]) ?: error(id ?: "")
                val merged = withFeedDeltas(variant, rawFeedDeltas(o["deltas"]))
                f.equal(1, merged.feedIds.size) { "$id feedIds" }
                val k = merged.variant.deltas.indexOfFirst { it.scope == "payload" && it.id == merged.feedIds.firstOrNull() }
                val base = materialise(o["installed"]!!.obj["payload"]!!)
                val r = applyDelta(merged.variant, k, MemorySource(base), ApplyPorts({ h -> store[h]?.let { MemorySource(it) } }, z))
                f.check(jsonEquals(o["expect"], r.verdict.json)) { "[$label] $id: ${o["description"].stringValue}: got ${r.verdict.json}" }
            }
        }
        f.done(8)
    }

    @Test
    fun packSetIdCases() {
        val f = Failures("packSetIdCases")
        for (o in section("packSetIdCases")) {
            var malformed = false
            val entries = ArrayList<PackSetEntry>()
            for (e in o["entries"].arrayValue ?: emptyList()) {
                val eo = e.objectValue
                val p = eo?.get("packId").stringValue
                val r = eo?.get("releaseSha256").stringValue
                if (p == null || r == null) malformed = true else entries += PackSetEntry(p, r)
            }
            val id = if (malformed) null else packSetId(entries)
            val got = buildJsonObject { put("packSetId", id?.let { JsonPrimitive(it) } ?: JsonNull) }
            f.check(jsonEquals(o["expect"], got)) { "${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(7)
    }

    @Test
    fun stampCases() {
        val f = Failures("stampCases")
        for (o in section("stampCases")) {
            val expect = LinkedHashMap(o["expect"]!!.obj)
            val holds = expect.remove("holds")
            val stamp = o["stamp"].stringValue!!
            val got = parseContentStamp(stamp).json
            f.check(jsonEquals(JsonObject(expect), got)) { "${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
            if (holds == null) continue
            val h = stampHolds(stamp)?.let { l -> JsonArray(l.map { it.json }) } ?: JsonNull
            f.check(jsonEquals(holds, h)) { "${o["id"].stringValue} holds: got $h" }
        }
        f.done(10)
    }

    @Test
    fun frameWindowCases() {
        val f = Failures("frameWindowCases")
        for (o in section("frameWindowCases")) {
            val w = frameWindow(hexBytes(o["header"].stringValue!!))
            val got = buildJsonObject { put("window", w?.let { jsonInt(it) } ?: JsonNull) }
            f.check(jsonEquals(o["expect"], got)) { "${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(13)
    }
}
