// @pkey-feature packs.apply.chunk packs.state
//
// The engine's range (chunk) fetch path end to end (plans/P4-11.md): a v1 -> v2 chunk sync over the
// corpus's own `pkey-chunks/1` indexes and bundles, through a byte server whose range answers can
// be refused, dropped or tampered with. B-150 follow-through: a refused range keeps its class
// through the range-to-full fallback, as in Swift's ChunkSyncTests and Python's test_packs_chunks.

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PackTarget
import im.plrs.key.core.jsonInt
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The corpus's v1 and v2 containers, their chunk indexes and v2's new bundles, as packs. */
private object CorpusChunks {
    private val content: File = run {
        var d: File? = File(System.getProperty("user.dir")).absoluteFile
        while (d != null && !File(d, "conformance/corpus/v2/content/cases.json").isFile) d = d.parentFile
        File(d ?: error("no conformance corpus above ${System.getProperty("user.dir")}"), "conformance/corpus/v2/content")
    }
    private val cases = Json.parseToJsonElement(File(content, "cases.json").readText()).jsonObject
    private fun blob(name: String): ByteArray = File(content, "blobs/$name").readBytes()
    private val apply = cases["applyCases"]!!.jsonArray.map { it.jsonObject }.first { it["id"]!!.jsonPrimitive.content == "chunk-v1-to-v2" }
    private val params = cases["params"]!!.jsonObject["chunks"]!!.jsonObject
    private val zstd = LibZstd()

    val v1Payload: ByteArray = zstd.decode(blob("payload/v1.full.zst"), cases["payloads"]!!.jsonObject["v1"]!!.jsonObject["size"]!!.jsonPrimitive.content.toInt())
    private val v1Index = blob("chunks/v1.pkc")
    /** The target index, the bundles it names and v2's payload, as the corpus pins them. */
    val v2Objects: Map<String, ByteArray> = apply["objects"]!!.jsonObject.mapValues { blob(it.value.jsonObject["blob"]!!.jsonPrimitive.content) }
    val v2Ref: JsonObject = apply["variant"]!!.jsonObject["chunks"]!!.jsonObject
    val bundles: Set<String> = v2Objects.keys - v2Ref["sha256"]!!.jsonPrimitive.content
    val v2Sha: String = cases["payloads"]!!.jsonObject["v2"]!!.jsonObject["sha256"]!!.jsonPrimitive.content

    /** v2's payload: the corpus's own chunk apply over v1 (the hash is the corpus's). */
    val v2Payload: ByteArray = runBlocking {
        val variant = PackVariant.from(apply["variant"]!!) ?: error("variant")
        val seed = (parseChunkIndexBytes(v1Index, null) as ParseChunkIndexResult.Ok).index
        val out = ByteArray(variant.payload.size.toInt())
        val r = applyChunk(
            variant, listOf(ChunkSeed(seed, MemorySource(v1Payload))),
            ApplyChunkPorts(
                objects = { h -> v2Objects[h]?.let { MemorySource(it) } },
                zstd = zstd,
                fetchRange = { req ->
                    val b = v2Objects[req.bundle]!!
                    ChunkRangeResponse.Ok(ByteStream.of(b.copyOfRange(req.offset.toInt(), minOf(b.size.toLong(), req.offset + req.length).toInt())))
                },
                output = object : ChunkOutput {
                    override fun write(offset: Long, bytes: ByteArray) { bytes.copyInto(out, offset.toInt()) }
                    override fun read(offset: Long, length: Int): ByteArray = out.copyOfRange(offset.toInt(), minOf(out.size, offset.toInt() + length))
                },
            ),
            repair = false,
        )
        assertTrue("the corpus v1 -> v2 chunk apply: ${r.verdict}", r.verdict.ok)
        out
    }

    private val v1Spec: ChunkSpec get() {
        val ref = JsonObject(
            mapOf(
                "format" to JsonPrimitive("pkey-chunks/1"), "sha256" to JsonPrimitive(sha256Of(v1Index)), "bytes" to jsonInt(v1Index.size.toLong()),
                "size" to jsonInt(v1Index.size.toLong()), "codec" to JsonPrimitive("none"), "params" to params,
            ),
        )
        return ChunkSpec(ref, mapOf(sha256Of(v1Index) to v1Index))
    }

    val v1: BuiltPack by lazy { containerPack("djdl.levels", "1.0.0", 1, v1Payload, chunks = v1Spec) }
    val v2: BuiltPack by lazy { containerPack("djdl.levels", "1.1.0", 2, v2Payload, chunks = ChunkSpec(v2Ref, v2Objects)) }
}

class PacksChunkRangeTest {
    /** Both releases are served; v1 is installed (and its chunk index kept), the stub then reset to [setup]. */
    private fun v1Installed(setup: (ByteServer) -> Unit = {}): Triple<ByteServer, PackEngine, MemoryPackStorage> = runBlocking {
        val server = ByteServer(CorpusChunks.v1, CorpusChunks.v2)
        val storage = MemoryPackStorage()
        val engine = engineOf(server, stampOf(CorpusChunks.v1), storage)
        engine.load()
        engine.ensureReleases(listOf(PackTarget("djdl.levels", CorpusChunks.v1.pin)))
        assertEquals(CorpusChunks.v1.sha256, engine.state().active["djdl.levels"]?.recordSha256)
        synchronized(server) { server.objectRequests.clear() }
        setup(server)
        Triple(server, engine, storage)
    }

    private fun ranged(s: ByteServer) = synchronized(s) { s.objectRequests.filter { it.length != null } }
    private fun installTarget(e: PackEngine) = runBlocking { e.ensureReleases(listOf(PackTarget("djdl.levels", CorpusChunks.v2.pin))) }

    private fun refusal(e: PackEngine): String = runBlocking {
        try {
            installTarget(e)
            fail("the refused install succeeded")
            ""
        } catch (x: PackException) {
            x.code
        }
    }

    @Test
    fun chunksAreAppliedFromTheSeedAndTheResultMatchesTheCorpusHash() {
        val (server, engine, _) = v1Installed()
        val v2 = installTarget(engine)
        assertEquals(CorpusChunks.v2Sha, v2[0].payloadSha256)
        assertEquals(CorpusChunks.v2.sha256, engine.state().active["djdl.levels"]?.recordSha256)
        assertEquals(CorpusChunks.v1.sha256, engine.state().previous["djdl.levels"]?.recordSha256)
        // The corpus's chunk-v1-to-v2 plan: the target index, then only v2's new bundles by range; no full object.
        val rs = ranged(server)
        assertEquals(3, rs.size)
        assertTrue(rs.all { it.sha256 in CorpusChunks.bundles && it.ifRange == "\"${it.sha256}\"" })
        assertTrue(server.fetchedObjects().none { it == CorpusChunks.v2.payloadSha256 })
    }

    @Test
    fun aRefusedRangeFallsBackToTheFullPayload() {
        for (status in listOf(401, 403, 404, 500, 503, 200)) {
            val (server, engine, _) = v1Installed { it.rangeStatus = status }
            val v2 = installTarget(engine)
            assertEquals("status $status", CorpusChunks.v2Sha, v2[0].payloadSha256)
            assertTrue("status $status: the full object was fetched", CorpusChunks.v2.payloadSha256 in server.fetchedObjects())
        }
    }

    @Test
    fun aRefusedRangeKeepsItsClassWhenTheFallbackFailsAlike() {
        val cases = listOf(
            401 to ErrorCode.packNotEntitled, 403 to ErrorCode.packNotEntitled,
            500 to ErrorCode.serverError, 503 to ErrorCode.serverError,
            404 to ErrorCode.networkError,
        )
        for ((status, code) in cases) {
            val (_, engine, _) = v1Installed { it.rangeStatus = status; it.statusFor[CorpusChunks.v2.payloadSha256] = status }
            assertEquals("status $status", code, refusal(engine))
            // Nothing half-installed: v1 is still the active release.
            assertEquals(CorpusChunks.v1.sha256, engine.state().active["djdl.levels"]?.recordSha256)
        }
    }

    @Test
    fun aTransportFailureOfTheRangeAndTheFallbackIsANetworkError() {
        val (_, engine, _) = v1Installed { it.rangeDrops = true; it.dropFor += CorpusChunks.v2.payloadSha256 }
        assertEquals(ErrorCode.networkError, refusal(engine))
        assertEquals(CorpusChunks.v1.sha256, engine.state().active["djdl.levels"]?.recordSha256)
    }

    @Test
    fun aRefusedRangeIsNotRememberedByTheNextInstall() {
        // The class is per fetch: after a 403 on the range, a clean retry installs by chunk.
        val (server, engine, _) = v1Installed { it.rangeStatus = 403; it.statusFor[CorpusChunks.v2.payloadSha256] = 403 }
        assertEquals(ErrorCode.packNotEntitled, refusal(engine))
        server.rangeStatus = null
        server.statusFor.clear()
        assertEquals(CorpusChunks.v2Sha, installTarget(engine)[0].payloadSha256)
    }

    @Test
    fun aTamperedBundleFallsBackToTheFullPayload() {
        val bad = CorpusChunks.bundles.first()
        val tampered = CorpusChunks.v2Objects[bad]!!.copyOf().also { for (k in 0 until 64) it[100 + k] = (it[100 + k].toInt() xor 0x5a).toByte() }
        val (server, engine, _) = v1Installed { it.tampered[bad] = tampered }
        val v2 = installTarget(engine)
        assertEquals(CorpusChunks.v2Sha, v2[0].payloadSha256)
        assertTrue(CorpusChunks.v2.payloadSha256 in server.fetchedObjects())
        assertEquals(CorpusChunks.v2.sha256, engine.state().active["djdl.levels"]?.recordSha256)
    }
}
