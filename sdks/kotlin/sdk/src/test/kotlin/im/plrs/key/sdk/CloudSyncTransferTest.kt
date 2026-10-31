// @pkey-feature sync.files
//
// The Cloud Sync file transfer engine, journal, chunk cache and file codecs (U-23.K4), against a fake of the
// Worker's file routes behind the [FileTransport] port. A port of the Python test_cloud_sync_files.py:
// kill-and-resume from the journal, the Retry-After hold, the 410 restart, a tampered chunk or manifest is
// `sync-file-invalid`, cache damage is a miss, journal and cache names that no id can steer, and the real zstd
// decoder behind codec 1 chunks.

package im.plrs.key.sdk

import com.github.luben.zstd.Zstd
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.sync.SyncCrypto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList

private const val MIB = 1_048_576
private const val CLOCK = 1000.0
private val ROOT = ByteArray(32) { 7 }

private fun noise(n: Int): ByteArray = SyncCrypto.random(n)

private fun shaHex(d: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(d).joinToString("") { "%02x".format(it) }

private class Upload(val size: Int, val sha256: String, val mode: String) {
    val parts = java.util.TreeMap<Int, ByteArray>()
    var manifest: ByteArray? = null
}

/** A fake U-10 and U-37 server behind the port: parts in any order, chunks per collection, files by version. */
private class FakeServer : FileTransport {
    val uploads = HashMap<String, Upload>()
    val chunks = HashMap<String, ByteArray>()
    val files = CopyOnWriteArrayList<ByteArray>()
    val calls = CopyOnWriteArrayList<String>()
    val partPuts = CopyOnWriteArrayList<Int>()
    val chunkPuts = CopyOnWriteArrayList<String>()
    val chunkGets = CopyOnWriteArrayList<String>()
    val fileQueries = CopyOnWriteArrayList<FileQuery>()
    val aborted = CopyOnWriteArrayList<String>()
    val beginRequests = CopyOnWriteArrayList<JsonObject>()
    val planSizes = CopyOnWriteArrayList<Int>()
    var seq = 0
    var multipartAlways = false
    var partBytes = 100_000
    var etag = "\"e1\""

    /** Breaks one kind of call: return a refusal to override, or throw for "no answer". */
    @Volatile var hook: (String) -> FileRefusal? = { null }

    @Volatile var tamperChunk: (String, ByteArray) -> ByteArray = { _, o -> o }

    @Volatile var tamperFile: (FileQuery, FileBody) -> FileBody = { _, b -> b }

    @Volatile var beginAnswer: JsonObject? = null

    @Volatile var planAnswer: JsonObject? = null

    private fun <T> enter(kind: String): FileReply<T>? {
        calls.add(kind)
        return hook(kind)?.let { FileReply.Refused(it) }
    }

    private fun gone() = FileRefusal(410, "upload_expired")

    override suspend fun begin(target: FileTarget, request: JsonObject): FileReply<JsonObject> {
        beginRequests.add(request)
        enter<JsonObject>("begin")?.let { return it }
        beginAnswer?.let { return FileReply.Ok(it) }
        val size = (request["size"] as JsonPrimitive).content.toInt()
        val sha = (request["sha256"] as JsonPrimitive).content
        synchronized(this) {
            seq++
            val id = "up$seq"
            val mode = if ((request["format"] as JsonPrimitive).content ==
                "chunks"
            ) {
                "chunks"
            } else if (size <= 16 * MIB && !multipartAlways) {
                "single"
            } else {
                "multipart"
            }
            uploads[id] = Upload(size, sha, mode)
            return FileReply.Ok(
                buildJsonObject {
                    put("uploadId", id)
                    put("mode", mode)
                    put("expiresAt", (CLOCK + 86400) * 1000)
                    if (mode == "multipart") put("partBytes", partBytes)
                },
            )
        }
    }

    override suspend fun status(target: FileTarget, uploadId: String): FileReply<JsonObject> {
        enter<JsonObject>("status")?.let { return it }
        synchronized(this) {
            val u = uploads[uploadId] ?: return FileReply.Refused(gone())
            return FileReply.Ok(buildJsonObject { put("received", JsonArray(u.parts.keys.map { JsonPrimitive(it) })) })
        }
    }

    override suspend fun putSingle(target: FileTarget, uploadId: String, body: ByteArray, sha256: String): FileReply<Unit> {
        enter<Unit>("putSingle")?.let { return it }
        synchronized(this) {
            val u = uploads[uploadId] ?: return FileReply.Refused(gone())
            if (shaHex(body) != sha256) return FileReply.Refused(FileRefusal(400, "upload_mismatch"))
            if (u.mode == "chunks") u.manifest = body else u.parts[1] = body
            return FileReply.Ok(Unit)
        }
    }

    override suspend fun putPart(target: FileTarget, uploadId: String, n: Int, body: ByteArray, sha256: String): FileReply<Unit> {
        enter<Unit>("putPart")?.let { return it }
        synchronized(this) {
            val u = uploads[uploadId] ?: return FileReply.Refused(gone())
            if (shaHex(body) != sha256) return FileReply.Refused(FileRefusal(400, "upload_mismatch"))
            u.parts[n] = body
            partPuts.add(n)
            return FileReply.Ok(Unit)
        }
    }

    override suspend fun abort(target: FileTarget, uploadId: String): FileReply<Unit> {
        calls.add("abort")
        synchronized(this) {
            aborted.add(uploadId)
            uploads.remove(uploadId)
        }
        return FileReply.Ok(Unit)
    }

    override suspend fun planChunks(target: FileTarget, uploadId: String, request: JsonObject): FileReply<JsonObject> {
        enter<JsonObject>("plan")?.let { return it }
        planAnswer?.let { return FileReply.Ok(it) }
        synchronized(this) {
            if (uploadId !in uploads) return FileReply.Refused(gone())
            val list = request["chunks"] as JsonArray
            planSizes.add(list.size)
            val missing = ArrayList<JsonElement>()
            val present = ArrayList<JsonElement>()
            for (e in list) {
                val id = ((e as JsonArray)[0] as JsonPrimitive).content
                if (id in chunks) present.add(e) else missing.add(JsonPrimitive(id))
            }
            return FileReply.Ok(
                buildJsonObject {
                    put("missing", JsonArray(missing))
                    put("present", JsonArray(present))
                },
            )
        }
    }

    override suspend fun putChunk(target: FileTarget, uploadId: String, chunkId: String, body: ByteArray, sha256: String): FileReply<Unit> {
        enter<Unit>("putChunk")?.let { return it }
        synchronized(this) {
            if (uploadId !in uploads) return FileReply.Refused(gone())
            if (shaHex(body) != sha256) return FileReply.Refused(FileRefusal(400, "upload_mismatch"))
            chunks[chunkId] = body
            chunkPuts.add(chunkId)
            return FileReply.Ok(Unit)
        }
    }

    override suspend fun finalize(target: FileTarget, request: JsonObject): FileReply<JsonObject> {
        enter<JsonObject>("finalize")?.let { return it }
        synchronized(this) {
            val id = (request["uploadId"] as JsonPrimitive).content
            val u = uploads[id] ?: return FileReply.Refused(gone())
            val data = if (u.mode == "chunks") {
                u.manifest
                    ?: return FileReply.Refused(
                        FileRefusal(
                            409,
                            "upload_incomplete",
                            body = buildJsonObject {
                                put("missing", JsonArray(emptyList()))
                            },
                        ),
                    )
            } else {
                u.parts.values.fold(ByteArray(0)) { a, b -> a + b }
            }
            if (shaHex(data) != u.sha256) return FileReply.Refused(FileRefusal(400, "upload_mismatch"))
            files.add(data)
            uploads.remove(id)
            return FileReply.Ok(buildJsonObject { put("version", files.size) })
        }
    }

    override suspend fun getFile(target: FileTarget, query: FileQuery): FileReply<FileBody> {
        enter<FileBody>("getFile")?.let { return it }
        fileQueries.add(query)
        val data = query.version?.let { files[it - 1] } ?: files.last()
        if (query.ifMatch != null && query.ifMatch != etag) return FileReply.Refused(FileRefusal(412, "precondition_failed"))
        var body = FileBody(200, data, etag)
        query.range?.let { (from, to) ->
            val end = minOf(data.size, to)
            body = FileBody(206, data.copyOfRange(from, end), etag, ContentRange(from, end, data.size))
        }
        return FileReply.Ok(tamperFile(query, body))
    }

    override suspend fun getChunk(collection: String, chunkId: String): FileReply<ByteArray> {
        enter<ByteArray>("getChunk")?.let { return it }
        chunkGets.add(chunkId)
        val obj = synchronized(this) { chunks[chunkId] } ?: return FileReply.Refused(FileRefusal(404, "not_found"))
        return FileReply.Ok(tamperChunk(chunkId, obj))
    }
}

private class Collected {
    val parts = CopyOnWriteArrayList<ByteArray>()
    val data: ByteArray get() = parts.fold(ByteArray(0)) { a, b -> a + b }
    val writes: Int get() = parts.size
}

class CloudSyncTransferTest {
    private fun engine(s: FileTransport, j: JournalStore = MemoryJournal(), sleeps: MutableList<Double> = ArrayList(), parallelism: Int = 4) =
        FileTransferEngine(s, j, now = { CLOCK }, sleeper = { sleeps.add(it) }, random = { 0.5 }, parallelism = parallelism)

    private fun upReq(id: String, data: ByteArray, enc: String = "none", baseVersion: JsonElement? = null) =
        UploadRequest(id, "saves", "rec1", BytesSource(data), data.size, shaHex(data), enc, baseVersion)

    private fun chunkedReq(id: String, data: ByteArray, codec: FileCodec) = ChunkedUploadRequest(id, "saves", "rec1", BytesSource(data), codec)

    private fun dl(
        data: ByteArray,
        sink: Collected,
        stored: ByteArray = data,
        codec: FileCodec = ServerFileCodec(),
        format: String = "whole",
        cache: ChunkCache? = null,
        size: Int = stored.size,
        sha: String = shaHex(stored),
    ) = DownloadRequest("saves", "rec1", format, size, sha, codec, { sink.parts.add(it) }, cache = cache)

    private fun expect(reason: Reason, detail: String? = null, body: suspend () -> Unit) {
        val e = assertThrows(TransferException::class.java) { runBlocking { body() } }
        assertEquals(e.message, reason, e.reason)
        if (detail != null) assertEquals(detail, e.detail)
    }

    private fun record(id: String, uploadId: String = "u", expiresAt: Double = (CLOCK + 100) * 1000, sha: String = "a".repeat(64), size: Int = 5) =
        JournalRecord(id, "saves", "rec1", uploadId, "single", null, emptyList(), sha, size, expiresAt, "uploading")

    private fun tempDir(): File = Files.createTempDirectory("u23k4").toFile().also { it.deleteOnExit() }

    // -- codecs --------------------------------------------------------------------------------------------------

    @Test
    fun codecsRoundTripChunksAndHideTheRoot() {
        val e2e = E2eFileCodec(ROOT, "saves")
        val plain = noise(5000)
        for (c in listOf<FileCodec>(e2e, ServerFileCodec())) {
            val id = c.chunkId(plain)
            val obj = c.sealChunk(id, plain)
            assertEquals(c.chunkObjectBytes(plain.size), obj.size)
            assertArrayEquals((c.openChunk(id, obj) as FileOpened.Ok).plain, plain)
            assertTrue(c.openChunk(c.chunkId(noise(10)), obj) is FileOpened.Invalid)
            assertEquals(4096L, c.plainSize(c.storedSize(4096)))
        }
        assertFalse(e2e.toString().contains(ROOT.joinToString("") { "%02x".format(it) }))
        val srv = ServerFileCodec()
        val id = srv.chunkId(plain)
        assertEquals("size", (srv.openChunk(id, ByteArray(SERVER_CHUNK_MAX_STORED_BYTES + 1)) as FileOpened.Invalid).reason)
        assertEquals("codec", (srv.openChunk(id, byteArrayOf(0, 9, 1)) as FileOpened.Invalid).reason)
        assertEquals("version", (srv.openChunk(id, byteArrayOf(7, 0, 1)) as FileOpened.Invalid).reason)
    }

    @Test
    fun zstdChunksDecodeAndABombIsRefusedBeforeDecoding() {
        val srv = ServerFileCodec()
        val plain = ByteArray(200_000) { 0x41 }
        val frame = Zstd.compress(plain, 3)
        val obj = byteArrayOf(0, 1) + frame
        assertArrayEquals(plain, (srv.openChunk(srv.chunkId(plain), obj) as FileOpened.Ok).plain)
        assertEquals("id", (srv.openChunk(srv.chunkId(byteArrayOf(1)), obj) as FileOpened.Invalid).reason)
        val big = ByteArray(2 * MIB)
        assertEquals("size", (srv.openChunk(srv.chunkId(big), byteArrayOf(0, 1) + Zstd.compress(big, 3)) as FileOpened.Invalid).reason)
        assertEquals("decode", (srv.openChunk(srv.chunkId(plain), byteArrayOf(0, 1) + frame.copyOf(12)) as FileOpened.Invalid).reason)
    }

    // -- uploads -------------------------------------------------------------------------------------------------

    @Test
    fun singleUploadFinalizesAndClearsTheJournal() = runBlocking {
        val s = FakeServer()
        val j = MemoryJournal()
        val data = noise(50_000)
        val progress = CopyOnWriteArrayList<Pair<Int, Int>>()
        val req =
            UploadRequest("t1", "saves", "rec1", BytesSource(data), data.size, shaHex(data), "none", onProgress = { a, b -> progress.add(a to b) })
        val out = engine(s, j).upload(req)
        assertEquals("1", (out["version"] as JsonPrimitive).content)
        assertArrayEquals(data, s.files[0])
        assertTrue(j.list().isEmpty())
        assertEquals(listOf(50_000 to 50_000), progress.toList())
    }

    @Test
    fun multipartSendsAllPartsAndSequentialOrderIsAscending() = runBlocking {
        val big = noise(350_000)
        val s = FakeServer().apply { multipartAlways = true }
        engine(s).upload(upReq("t2", big))
        assertEquals(listOf(1, 2, 3, 4), s.partPuts.sorted())
        assertArrayEquals(big, s.files[0])
        val s2 = FakeServer().apply { multipartAlways = true }
        engine(s2, parallelism = 1).upload(upReq("t2b", big))
        assertEquals(listOf(1, 2, 3, 4), s2.partPuts.toList())
    }

    private fun killAfterSecondPut(s: FakeServer, holder: Array<Deferred<*>?>) {
        val seen = java.util.concurrent.atomic.AtomicInteger()
        s.hook = { kind ->
            if (kind == "putPart" && seen.incrementAndGet() == 2) holder[0]?.cancel()
            null
        }
    }

    @Test
    fun killThenResumeSendsOnlyTheMissingParts() = runBlocking {
        val s = FakeServer().apply { multipartAlways = true }
        val j = MemoryJournal()
        val big = noise(350_000)
        val holder = arrayOfNulls<Deferred<*>>(1)
        killAfterSecondPut(s, holder)
        val req = upReq("k1", big)
        val task = async(start = CoroutineStart.LAZY) { engine(s, j, parallelism = 1).upload(req) }
        holder[0] = task
        task.start()
        assertThrows(CancellationException::class.java) { runBlocking { task.await() } }
        val rec = parseJournalRecord(j.get("k1"))
        assertEquals(listOf(1, 2), rec.done)
        assertEquals("uploading", rec.state)
        s.hook = { null }
        engine(s, j).upload(req)
        assertEquals(listOf(1, 2, 3, 4), s.partPuts.sorted())
        assertEquals(1, s.beginRequests.size)
        assertArrayEquals(big, s.files[0])
    }

    @Test
    fun aPartTheServerLostIsSentAgain() = runBlocking {
        val s = FakeServer().apply { multipartAlways = true }
        val j = MemoryJournal()
        val big = noise(350_000)
        val holder = arrayOfNulls<Deferred<*>>(1)
        killAfterSecondPut(s, holder)
        val req = upReq("k2", big)
        val task = async(start = CoroutineStart.LAZY) { engine(s, j, parallelism = 1).upload(req) }
        holder[0] = task
        task.start()
        runCatching { task.await() }
        s.uploads.values.first().parts.remove(2)
        s.hook = { null }
        engine(s, j).upload(req)
        assertArrayEquals(big, s.files[0])
        assertEquals(2, s.partPuts.count { it == 2 })
    }

    @Test
    fun a410RestartsTheUploadAndRepeatedOnesGiveUp() = runBlocking {
        val data = noise(2000)
        val s = FakeServer()
        val first = java.util.concurrent.atomic.AtomicBoolean(true)
        s.hook = { if (it == "putSingle" && first.getAndSet(false)) FileRefusal(410, "upload_expired") else null }
        engine(s).upload(upReq("g1", data))
        assertEquals(2, s.beginRequests.size)
        assertArrayEquals(data, s.files[0])
        val s2 = FakeServer().apply { hook = { if (it == "putSingle") FileRefusal(410, "upload_expired") else null } }
        expect(Reason.RESTARTS_EXHAUSTED) { engine(s2).upload(upReq("g2", data)) }
        assertEquals(4, s2.beginRequests.size)
        for (status in listOf(404, 410)) {
            val s3 = FakeServer().apply { hook = { if (it == "begin") FileRefusal(status, "gone") else null } }
            expect(Reason.REJECTED) { engine(s3).upload(upReq("g3", data)) }
            assertEquals("$status on begin is not a restart", 1, s3.beginRequests.size)
        }
    }

    @Test
    fun a409CarriesTheServersVersion() = runBlocking {
        val s = FakeServer().apply {
            hook =
                {
                    if (it ==
                        "begin"
                    ) {
                        FileRefusal(409, "revision_conflict", body = buildJsonObject { put("server", buildJsonObject { put("version", 7) }) })
                    } else {
                        null
                    }
                }
        }
        val e =
            assertThrows(TransferException::class.java) { runBlocking { engine(s).upload(upReq("g4", noise(100), baseVersion = JsonPrimitive(3))) } }
        assertEquals(Reason.CONFLICT, e.reason)
        assertEquals(7, e.serverVersion)
        assertEquals("3", (s.beginRequests[0]["baseVersion"] as JsonPrimitive).content)
    }

    @Test
    fun retryAfterHoldsAndBackoffDoublesWithJitter() = runBlocking {
        val data = noise(3000)
        val told = java.util.concurrent.atomic.AtomicInteger()
        val s = FakeServer().apply {
            hook =
                { if (it == "begin" && told.getAndIncrement() < 2) FileRefusal(429, "rate_limited", retryAfterSeconds = 7.0) else null }
        }
        val sleeps = ArrayList<Double>()
        engine(s, sleeps = sleeps).upload(upReq("r1", data))
        assertEquals(7.0, sleeps.first(), 0.0)

        val s2 = FakeServer().apply { hook = { if (it == "begin") throw java.io.IOException("offline") else null } }
        val sleeps2 = ArrayList<Double>()
        expect(Reason.RETRIES_EXHAUSTED) { engine(s2, sleeps = sleeps2).upload(upReq("r2", data)) }
        assertEquals(8, s2.beginRequests.size)
        assertEquals(7, sleeps2.size)
        assertEquals(0.375, sleeps2[0], 1e-9)
        assertEquals(0.75, sleeps2[1], 1e-9)

        val s3 = FakeServer().apply { hook = { if (it == "begin") FileRefusal(403, "forbidden") else null } }
        expect(Reason.REJECTED) { engine(s3).upload(upReq("r3", data)) }
        assertEquals("a 403 is not retried", 1, s3.beginRequests.size)

        val s4 = FakeServer().apply { hook = { if (it == "finalize") FileRefusal(400, "upload_mismatch") else null } }
        expect(Reason.MISMATCH) { engine(s4).upload(upReq("r4", data)) }
        assertEquals("a mismatch releases the upload", 1, s4.aborted.size)
    }

    @Test
    fun aSourceThatIsNotTheDeclaredHashIsRefusedWithNothingSent() {
        val s = FakeServer()
        val d = noise(1000)
        expect(Reason.SOURCE_MISMATCH) { engine(s).upload(UploadRequest("m1", "saves", "rec1", BytesSource(d), d.size, shaHex(noise(3)), "none")) }
        assertTrue(s.calls.isEmpty())
    }

    @Test
    fun anExpiredRecordBeginsAfreshAndAnUnknownVersionIsLeftAlone() = runBlocking {
        val data = noise(2000)
        val s = FakeServer()
        val j = MemoryJournal()
        j.put("e1", record("e1", expiresAt = (CLOCK - 5) * 1000, sha = shaHex(data), size = data.size))
        engine(s, j).upload(upReq("e1", data))
        assertEquals(1, s.beginRequests.size)
        // expiresAt is milliseconds: a record live in ms is resumed (a status call); one past in ms is not,
        // although its number would read as live in seconds.
        val live = MemoryJournal()
        live.put("e2", record("e2", expiresAt = (CLOCK + 100) * 1000, sha = shaHex(data), size = data.size))
        val s5 = FakeServer()
        engine(s5, live).upload(upReq("e2", data))
        assertTrue("a record live in milliseconds is resumed", "status" in s5.calls)
        assertFalse("a record past in milliseconds is not", "status" in s.calls)
        val foreign = buildJsonObject {
            put("v", 2)
            put("id", "v2")
            put("anything", true)
        }
        j.putRaw("v2", foreign)
        s.calls.clear()
        expect(Reason.JOURNAL_VERSION) { engine(s, j).upload(upReq("v2", data)) }
        assertTrue(s.calls.isEmpty())
        assertEquals("the record is left as found", foreign, j.get("v2"))
        j.putRaw(
            "bad",
            buildJsonObject {
                put("v", 1)
                put("id", "bad")
            },
        )
        expect(Reason.JOURNAL_MALFORMED) { engine(s, j).upload(upReq("bad", data)) }
    }

    @Test
    fun engineCancelAbortsTheServersUploadAndForgetsTheRecord() = runBlocking {
        val s = FakeServer()
        val j = MemoryJournal()
        j.put("z", record("z", uploadId = "upX"))
        engine(s, j).cancel("z")
        assertEquals(listOf("upX"), s.aborted.toList())
        assertNull(j.get("z"))
        j.putRaw("y", buildJsonObject { put("v", 9) })
        engine(s, j).cancel("y")
        assertNotNull("a record this build cannot read stays", j.get("y"))
    }

    // -- chunks --------------------------------------------------------------------------------------------------

    @Test
    fun chunkedUploadSendsOnlyWhatChangedAndAKillLeavesARecordTheNextRunReleases() = runBlocking {
        val codec = ServerFileCodec()
        val s = FakeServer()
        val j = MemoryJournal()
        val data = noise(2 * MIB + 12_345)
        engine(s, j).uploadChunked(chunkedReq("c1", data, codec))
        val first = s.chunkPuts.size
        assertTrue(first >= 4)
        assertTrue(j.list().isEmpty())
        assertEquals("chunks", (s.beginRequests[0]["format"] as JsonPrimitive).content)
        assertEquals("none", (s.beginRequests[0]["enc"] as JsonPrimitive).content)
        val edited = data.copyOf().also { it[MIB + 5] = (it[MIB + 5] + 1).toByte() }
        s.chunkPuts.clear()
        engine(s, j).uploadChunked(chunkedReq("c2", edited, codec))
        assertTrue(s.chunkPuts.size in 1 until first)
        s.chunkPuts.clear()
        engine(s, j).uploadChunked(chunkedReq("c3", edited, codec))
        assertTrue("an identical reupload sends nothing", s.chunkPuts.isEmpty())
        assertTrue(s.planSizes.all { it <= 1024 })

        val s2 = FakeServer()
        val j2 = MemoryJournal()
        val holder = arrayOfNulls<Deferred<*>>(1)
        val seen = java.util.concurrent.atomic.AtomicInteger()
        s2.hook = { kind ->
            if (kind == "putChunk" && seen.incrementAndGet() == 2) holder[0]?.cancel()
            null
        }
        val req = chunkedReq("c4", data, codec)
        val task = async(start = CoroutineStart.LAZY) { engine(s2, j2, parallelism = 1).uploadChunked(req) }
        holder[0] = task
        task.start()
        assertThrows(CancellationException::class.java) { runBlocking { task.await() } }
        val rec = parseJournalRecord(j2.get("c4"))
        assertEquals("chunks", rec.mode)
        assertTrue(rec.done.isEmpty())
        s2.hook = { null }
        engine(s2, j2).uploadChunked(req)
        assertEquals("the previous upload was released", 1, s2.aborted.size)
        assertEquals("chunks already stored are not sent again", first, s2.chunkPuts.size)
    }

    @Test
    fun aPlanThatNamesAnUnaskedIdOrAWrongModeIsABadReply() {
        val codec = ServerFileCodec()
        val s = FakeServer().apply {
            planAnswer = buildJsonObject {
                put("missing", JsonArray(listOf(JsonPrimitive("f".repeat(64)))))
                put("present", JsonArray(emptyList()))
            }
        }
        expect(Reason.BAD_REPLY) { engine(s).uploadChunked(chunkedReq("c5", noise(200_000), codec)) }
        assertEquals(1, s.aborted.size)
        val s2 = FakeServer().apply {
            beginAnswer = buildJsonObject {
                put("uploadId", "x")
                put("mode", "single")
                put("expiresAt", (CLOCK + 5) * 1000)
            }
        }
        expect(Reason.BAD_REPLY) { engine(s2).uploadChunked(chunkedReq("c6", noise(1000), codec)) }
    }

    @Test
    fun endToEndChunksAreSealedAndAFileEditedAfterCuttingIsRefused() = runBlocking {
        val e2e = E2eFileCodec(ROOT, "saves")
        val s = FakeServer()
        val small = noise(180_000)
        engine(s).uploadChunked(chunkedReq("c7", small, e2e))
        assertEquals("e2e", (s.beginRequests[0]["enc"] as JsonPrimitive).content)
        val needle = small.copyOfRange(1000, 1064).joinToString("") { "%02x".format(it) }
        for (obj in s.chunks.values) assertFalse(obj.joinToString("") { "%02x".format(it) }.contains(needle))

        val raw = noise(300_000)
        val reads = java.util.concurrent.atomic.AtomicInteger()
        val shifty = object : RangedSource {
            override val size: Int = raw.size
            override fun read(start: Int, end: Int): ByteArray {
                val d = raw.copyOfRange(start, end)
                if (reads.incrementAndGet() > 1 && d.isNotEmpty()) d[0] = (d[0] + 1).toByte()
                return d
            }
        }
        expect(Reason.SOURCE_MISMATCH) { engine(FakeServer()).uploadChunked(ChunkedUploadRequest("c8", "saves", "rec1", shifty, ServerFileCodec())) }
    }

    // -- downloads -----------------------------------------------------------------------------------------------

    @Test
    fun wholeDownloadsReadRangesHoldTheETagAndRefuseBadAnswers() = runBlocking {
        val s = FakeServer()
        val data = noise(3000)
        engine(s).upload(upReq("d1", data))
        val sink = Collected()
        engine(s).download(dl(data, sink))
        assertArrayEquals(data, sink.data)

        val big = noise(9 * MIB)
        val s2 = FakeServer()
        engine(s2).upload(upReq("d2", big))
        val sink2 = Collected()
        engine(s2).download(dl(big, sink2))
        assertArrayEquals(big, sink2.data)
        assertEquals(2, s2.fileQueries.size)
        assertNull(s2.fileQueries[0].ifMatch)
        assertEquals("\"e1\"", s2.fileQueries[1].ifMatch)

        val n = java.util.concurrent.atomic.AtomicInteger()
        s2.tamperFile = { _, b -> if (n.incrementAndGet() == 2) FileBody(b.status, b.data, "\"e2\"", b.contentRange) else b }
        expect(Reason.BAD_REPLY) { engine(s2).download(dl(big, Collected())) }
        s2.tamperFile = { _, b -> if (b.status == 206) FileBody(206, b.data.copyOf(10), b.etag, b.contentRange) else b }
        expect(Reason.BAD_REPLY) { engine(s2).download(dl(big, Collected())) }
        s2.tamperFile = { _, b -> b.contentRange?.let { FileBody(206, b.data, b.etag, ContentRange(it.start + 1, it.end, it.total)) } ?: b }
        expect(Reason.BAD_REPLY) { engine(s2).download(dl(big, Collected())) }
        // A 200 for the whole file is taken from the start only.
        s2.tamperFile = { _, b -> FileBody(200, big, b.etag) }
        val sink3 = Collected()
        engine(s2).download(dl(big, sink3))
        assertArrayEquals(big, sink3.data)
    }

    @Test
    fun storedBytesThatDoNotHashAreSyncFileInvalid() = runBlocking {
        val s = FakeServer()
        val data = noise(4000)
        engine(s).upload(upReq("d3", data))
        val e = assertThrows(TransferException::class.java) { runBlocking { engine(s).download(dl(data, Collected(), sha = shaHex(noise(2)))) } }
        assertEquals(Reason.FILE_INVALID, e.reason)
        assertEquals(ErrorCode.syncFileInvalid, e.toPolarisException().code)
        expect(Reason.FILE_INVALID, "sha256") { engine(s).download(dl(data, Collected(), sha = "XYZ")) }
        expect(Reason.FILE_INVALID, "size") { engine(s).download(dl(data, Collected(), size = 0)) }
        s.hook = { if (it == "getFile") FileRefusal(404, "not_found") else null }
        expect(Reason.REJECTED) { engine(s).download(dl(data, Collected())) }
        assertEquals("a 404 on a download is a rejection", 1, s.beginRequests.size)
    }

    @Test
    fun endToEndWholeFileFlippedByteFailsItsTag() = runBlocking {
        val e2e = E2eFileCodec(ROOT, "saves")
        val plain = noise(20_000)
        val stored = e2e.sealWhole(plain)
        val s = FakeServer()
        engine(s).upload(upReq("d4", stored, enc = "e2e"))
        val sink = Collected()
        engine(s).download(dl(plain, sink, stored = stored, codec = e2e))
        assertArrayEquals(plain, sink.data)
        val bad = stored.copyOf().also { it[it.size - 40] = (it[it.size - 40] + 1).toByte() }
        s.files[0] = bad
        expect(Reason.FILE_INVALID) { engine(s).download(dl(plain, Collected(), stored = bad, codec = e2e)) }
    }

    @Test
    fun chunkedDownloadFillsTheCacheAndTreatsDamageAsAMiss() = runBlocking {
        val codec = ServerFileCodec()
        val data = noise(2 * MIB + 77)
        val s = FakeServer()
        engine(s).uploadChunked(chunkedReq("d5", data, codec))
        val manifest = s.files[0]
        val cache = MemoryChunkCache()
        val sink = Collected()
        engine(s).download(dl(data, sink, stored = manifest, codec = codec, format = "chunks", cache = cache, size = data.size))
        assertArrayEquals(data, sink.data)
        val fetched = s.chunkGets.size
        assertTrue(fetched >= 4)
        val again = Collected()
        engine(s).download(dl(data, again, stored = manifest, codec = codec, format = "chunks", cache = cache, size = data.size))
        assertArrayEquals(data, again.data)
        assertEquals("a second read is served from the cache", fetched, s.chunkGets.size)
        val firstId = s.chunks.keys.first()
        cache.put(firstId, noise(500))
        val third = Collected()
        engine(s).download(dl(data, third, stored = manifest, codec = codec, format = "chunks", cache = cache, size = data.size))
        assertArrayEquals(data, third.data)
        assertEquals("a damaged entry is a miss", fetched + 1, s.chunkGets.size)
        assertArrayEquals("...and is replaced by the good object", s.chunks[firstId], cache.get(firstId))
    }

    @Test
    fun tamperedChunksAndManifestsAreSyncFileInvalid() = runBlocking {
        val codec = ServerFileCodec()
        val data = noise(MIB + 4321)
        val s = FakeServer()
        engine(s).uploadChunked(chunkedReq("x1", data, codec))
        val manifest = s.files[0]
        fun req(sink: Collected, stored: ByteArray = manifest, size: Int = data.size) =
            dl(data, sink, stored = stored, codec = codec, format = "chunks", size = size)
        s.tamperChunk = { _, o -> o.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() } }
        expect(Reason.FILE_INVALID) { engine(s).download(req(Collected())) }
        s.tamperChunk = { _, o -> ByteArray(SERVER_CHUNK_MAX_STORED_BYTES + 1) + o }
        expect(Reason.FILE_INVALID, "chunk-size") { engine(s).download(req(Collected())) }
        val keys = s.chunks.keys.toList()
        val other = s.chunks.getValue(keys[1])
        s.tamperChunk = { id, o -> if (id == keys[0]) other else o }
        expect(Reason.FILE_INVALID) { engine(s).download(req(Collected())) }
        s.tamperChunk = { _, o -> o }
        val tm = manifest.copyOf().also { it[12] = 1 } // the header's flags word
        s.files[0] = tm
        expect(Reason.FILE_INVALID, "sha256") { engine(s).download(req(Collected())) }
        expect(Reason.FILE_INVALID) { engine(s).download(req(Collected(), stored = tm)) }
        s.files[0] = manifest
        expect(Reason.FILE_INVALID, "size") { engine(s).download(req(Collected(), size = data.size + 1)) }

        val e2e = E2eFileCodec(ROOT, "saves")
        val small = noise(120_000)
        val s2 = FakeServer()
        engine(s2).uploadChunked(chunkedReq("x2", small, e2e))
        val ok = Collected()
        engine(s2).download(dl(small, ok, stored = s2.files[0], codec = e2e, format = "chunks", size = e2e.storedSize(small.size.toLong()).toInt()))
        assertArrayEquals(small, ok.data)
        s2.tamperChunk = { _, o -> o.copyOf().also { it[it.size - 20] = (it[it.size - 20] + 1).toByte() } }
        val bad = Collected()
        expect(Reason.FILE_INVALID) {
            engine(
                s2,
            ).download(dl(small, bad, stored = s2.files[0], codec = e2e, format = "chunks", size = e2e.storedSize(small.size.toLong()).toInt()))
        }
        assertEquals("nothing is delivered from a tampered chunk", 0, bad.writes)
    }

    // -- journal and cache on disk -------------------------------------------------------------------------------

    private fun perms(f: File): Set<PosixFilePermission> = Files.getPosixFilePermissions(f.toPath())

    @Test
    fun aFileJournalNamesFilesByHashAtMode0600AndRefusesToBeSteered() {
        val dir = tempDir()
        val j = FileJournal(dir)
        val evil = "../../etc/pkey-journal-probe"
        val rec = record(evil).copy(mode = "multipart", partBytes = 2, size = 5, done = listOf(1, 2))
        j.put(evil, rec)
        val names = j.dir.list()!!.toList()
        assertEquals(listOf(journalFileName(evil)), names)
        assertEquals(69, names[0].length)
        assertEquals(PosixFilePermissionsOwner, perms(File(j.dir, names[0])))
        assertEquals(setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE), perms(j.dir))
        assertFalse(File(dir, "../../etc/pkey-journal-probe").exists())
        assertEquals(rec, parseJournalRecord(j.get(evil)))
        assertEquals(listOf(evil), j.list())
        File(j.dir, "evil.json").writeText("{}")
        File(j.dir, journalFileName("someone-else")).writeText(rec.toJson().toString())
        assertEquals("list keeps only a record in the file its own id names", listOf(evil), j.list())
        File(j.dir, journalFileName("junk")).writeText("not json")
        assertNull(j.get("junk"))
        File(j.dir, journalFileName("fv")).writeText("""{"v":9,"id":"fv"}""")
        assertTrue(assertThrows(TransferJournalException::class.java) { parseJournalRecord(j.get("fv")) }.version)
        assertFalse(rec.toJson().toString().contains("token"))
        j.delete(evil)
        assertNull(j.get(evil))
        j.clear()
        assertTrue(j.list().isEmpty())
    }

    @Test
    fun theParserRefusesMalformedRecords() {
        val multi = record("m").copy(mode = "multipart", partBytes = 100, size = 350)
        val bad = listOf<JsonElement?>(
            null,
            JsonPrimitive("x"),
            buildJsonObject { put("v", 1) },
            multi.copy(done = listOf(2, 1)).toJson(),
            multi.copy(done = listOf(9)).toJson(),
            record("c").copy(mode = "chunks", done = listOf(1)).toJson(),
        )
        for (b in bad) assertThrows(TransferJournalException::class.java) { parseJournalRecord(b) }
        assertEquals(multi, parseJournalRecord(multi.toJson()))
    }

    @Test
    fun chunkCacheNamesAreHexIdsOnlyAndTheFileCacheIsAnLruThatSurvivesDamage() {
        val id = "ab".repeat(32)
        assertTrue(isChunkCacheId(id))
        for (bad in listOf("../x", id + "0", id.uppercase(), "")) assertFalse(bad, isChunkCacheId(bad))
        val m = MemoryChunkCache(10)
        assertThrows(IllegalArgumentException::class.java) { m.put("../escape", byteArrayOf(1)) }
        assertThrows(IllegalArgumentException::class.java) { m.get("../escape") }
        val a = "01".repeat(32)
        val b = "02".repeat(32)
        val c = "03".repeat(32)
        m.put(a, noise(4))
        m.put(b, noise(4))
        m.get(a)
        m.put(c, noise(4))
        assertNull("the least recently used goes first", m.get(b))
        assertNotNull(m.get(a))
        assertEquals(CHUNK_CACHE_MIN_BYTES, chunkCacheBudget(0))
        assertEquals(600L * MIB, chunkCacheBudget(300L * MIB))

        val dir = tempDir()
        val da = chunkCacheDir(dir, "subject-a", "saves")
        assertTrue(da != chunkCacheDir(dir, "subject-b", "saves"))
        assertFalse(chunkCacheDir(dir, "s", "../../x").path.contains(".."))
        val fc = FileChunkCache(da, 1000)
        val obj = noise(400)
        fc.put(a, obj)
        assertArrayEquals(obj, fc.get(a))
        assertEquals(PosixFilePermissionsOwner, perms(File(da, a)))
        fc.put(b, noise(400))
        fc.put(c, noise(400))
        assertNull("the file cache keeps the newest within its budget", fc.get(a))
        assertNotNull(fc.get(c))
        File(da, c).writeBytes(byteArrayOf(1, 2))
        assertNull("a truncated entry is a miss", fc.get(c))
        val fresh = FileChunkCache(da, 1000)
        File(da, "stranger.txt").writeText("x")
        assertNotNull(fresh.get(b))
        assertThrows(IllegalArgumentException::class.java) { fresh.get("stranger.txt") }
        fc.clear()
        assertNull(fc.get(b))
    }
}

private val PosixFilePermissionsOwner = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
