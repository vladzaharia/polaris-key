// @pkey-feature sync.saves
//
// The saves client (U-22.5) over an in-memory cloud that is both the file routes and the record layer:
// the D-3 order (file, then the metadata on the version finalize answered), the E2E binding, a Worker that swaps a
// file, `formatVersion`, the 16 slots, conflicts and their three resolutions, a quota refusal, and pause and cancel.
// The machine's records binding and the client's wiring are pinned in CloudSyncSavesTest.

package im.plrs.key.sdk

import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.RecordFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.CompositeDecoder
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.encoding.decodeStructure
import kotlinx.serialization.encoding.encodeStructure
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList

private class Meta(val chapter: String, val formatVersion: Int = 1)

/** The serializer the plugin would generate (this repo applies no serialization plugin; an app does). */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private object MetaSerializer : KSerializer<Meta> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Meta") {
        element<String>("chapter")
        element<Int>("formatVersion", isOptional = true)
    }

    override fun serialize(encoder: Encoder, value: Meta) = encoder.encodeStructure(descriptor) {
        encodeStringElement(descriptor, 0, value.chapter)
        encodeIntElement(descriptor, 1, value.formatVersion)
    }

    override fun deserialize(decoder: Decoder): Meta = decoder.decodeStructure(descriptor) {
        var chapter = ""
        var fv = 1
        while (true) {
            when (val i = decodeElementIndex(descriptor)) {
                0 -> chapter = decodeStringElement(descriptor, 0)
                1 -> fv = decodeIntElement(descriptor, 1)
                CompositeDecoder.DECODE_DONE -> break
                else -> error("index $i")
            }
        }
        Meta(chapter, fv)
    }
}

private class Rec(var version: Long, var value: JsonObject?, var file: RecordFile?)

/** The file routes and the record layer of one person's `saves`, in memory. Records are keyed by wire id. */
@Suppress("ReturnCount")
private class Cloud(private val e2e: Boolean) :
    FileTransport,
    SaveRecords {
    val records = LinkedHashMap<String, Rec>()
    val revisions = HashMap<String, MutableList<Triple<Long, ByteArray, String>>>()
    private val uploads = HashMap<String, Triple<String, JsonElement?, ByteArray?>>()
    private var counter = 0L
    var gate: CompletableDeferred<Unit>? = null
    var quota = false
    val aborted = CopyOnWriteArrayList<String>()

    private fun hex(d: ByteArray) = d.joinToString("") { "%02x".format(it) }

    private fun sha(d: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(d))

    private fun refused(status: Int, code: String, body: JsonElement? = null) = FileReply.Refused(FileRefusal(status, code, null, body))

    // -- FileTransport -----------------------------------------------------------------------------------------

    override suspend fun begin(target: FileTarget, request: JsonObject): FileReply<JsonObject> {
        val rec = records[target.record]
        val base = request["baseVersion"]
        bases.add(base)
        val stale = if (base is JsonPrimitive && base.isString) rec != null else base?.longValue != (rec?.version ?: -1L)
        if (stale && base != null) {
            val server = buildJsonObject { put("version", rec?.version ?: 0) }
            return refused(409, "revision_conflict", buildJsonObject { put("server", server) })
        }
        val id = "up_${uploads.size + 1}"
        uploads[id] = Triple(target.record, base, null)
        return FileReply.Ok(
            buildJsonObject {
                put("uploadId", id)
                put("mode", "single")
                put("expiresAt", 4_000_000_000_000.0)
            },
        )
    }

    override suspend fun status(target: FileTarget, uploadId: String): FileReply<JsonObject> = refused(404, "not_found")

    override suspend fun putSingle(target: FileTarget, uploadId: String, body: ByteArray, sha256: String): FileReply<Unit> {
        gate?.await()
        val u = uploads[uploadId] ?: return refused(404, "not_found")
        uploads[uploadId] = Triple(u.first, u.second, body)
        return FileReply.Ok(Unit)
    }

    override suspend fun putPart(target: FileTarget, uploadId: String, n: Int, body: ByteArray, sha256: String): FileReply<Unit> =
        refused(400, "bad_request")

    override suspend fun abort(target: FileTarget, uploadId: String): FileReply<Unit> {
        aborted.add(uploadId)
        uploads.remove(uploadId)
        return FileReply.Ok(Unit)
    }

    override suspend fun finalize(target: FileTarget, request: JsonObject): FileReply<JsonObject> {
        if (quota) return refused(403, "quota_exceeded", buildJsonObject { put("scope", "user") })
        val u = uploads.remove(request["uploadId"].stringValue) ?: return refused(404, "not_found")
        val bytes = u.third ?: return refused(409, "upload_incomplete")
        val version = ++counter
        val file = RecordFile(version, bytes.size.toLong(), sha(bytes), "whole")
        revisions.getOrPut(target.record) { ArrayList() }.add(Triple(version, bytes, file.sha256))
        val rec = records[target.record]
        if (rec == null) {
            records[target.record] = Rec(version, null, file)
        } else {
            rec.version = version
            rec.file = file
        }
        return FileReply.Ok(
            buildJsonObject {
                put("version", version)
                put("size", bytes.size)
                put("sha256", file.sha256)
                put("format", "whole")
            },
        )
    }

    override suspend fun planChunks(target: FileTarget, uploadId: String, request: JsonObject): FileReply<JsonObject> = refused(400, "bad_request")

    override suspend fun putChunk(target: FileTarget, uploadId: String, chunkId: String, body: ByteArray, sha256: String): FileReply<Unit> =
        refused(400, "bad_request")

    override suspend fun getFile(target: FileTarget, query: FileQuery): FileReply<FileBody> {
        val list = revisions[target.record] ?: return refused(404, "not_found")
        val bytes =
            (if (query.version == null) list.last() else list.firstOrNull { it.first == query.version.toLong() })?.second
                ?: return refused(404, "not_found")
        return FileReply.Ok(FileBody(200, bytes, "\"etag\""))
    }

    override suspend fun getChunk(collection: String, chunkId: String): FileReply<ByteArray> = refused(404, "not_found")

    override suspend fun revisions(target: FileTarget): FileReply<JsonObject> {
        val list = revisions[target.record].orEmpty().reversed()
        val rows = list.map { (v, b, s) ->
            buildJsonObject {
                put("version", v)
                put("size", b.size)
                put("sha256", s)
                put("format", "whole")
                put("createdAt", 1L)
            }
        }
        return FileReply.Ok(buildJsonObject { put("revisions", JsonArray(rows)) })
    }

    // -- SaveRecords -------------------------------------------------------------------------------------------

    override suspend fun wireId(id: String): String = if (e2e) "x:" + sha(id.toByteArray()).take(43) else id

    override suspend fun notReady(): String? = null

    private fun unwire(wire: String): String = idsByWire[wire] ?: wire

    private val idsByWire = HashMap<String, String>()

    private fun saved(wire: String, r: Rec): SaveRecord? = r.value?.let { SaveRecord(unwire(wire), r.version, it, r.file) }

    override suspend fun list(): List<SaveRecord> = records.mapNotNull { (w, r) -> saved(w, r) }

    /** While set, `get` answers this device's stale cache instead of the server's row. */
    var cache: ((String) -> SaveRecord?)? = null

    override suspend fun get(id: String): SaveRecord? = cache?.invoke(id) ?: records[wireId(id)]?.let { saved(wireId(id), it) }

    /** The `baseVersion` of each `begin`, in order. */
    val bases = CopyOnWriteArrayList<JsonElement?>()

    /** The pointer each `set` was given, in order. */
    val setFiles = CopyOnWriteArrayList<RecordFile?>()

    override suspend fun set(id: String, value: JsonObject, baseVersion: JsonElement, file: RecordFile?): SaveSetResult {
        setFiles.add(file)
        val wire = wireId(id)
        idsByWire[wire] = id
        val rec = records[wire] ?: Rec(0, null, null).also { records[wire] = it }
        if (rec.version != baseVersion.longValue) return SaveSetResult.Conflict(saved(wire, rec))
        rec.version = ++counter
        rec.value = value
        return SaveSetResult.Ok(rec.version)
    }

    override suspend fun delete(id: String, baseVersion: Long): SaveSetResult {
        val wire = wireId(id)
        val rec = records[wire] ?: return SaveSetResult.Rejected("not_found")
        if (rec.version != baseVersion) return SaveSetResult.Conflict(saved(wire, rec))
        records.remove(wire)
        return SaveSetResult.Ok(++counter)
    }
}

class CloudSyncSavesClientTest {
    private val root = ByteArray(32) { (it * 7 + 1).toByte() }
    private val settled = CopyOnWriteArrayList<Pair<String, SaveResult>>()
    private val scope = CoroutineScope(Dispatchers.Default)

    private fun client(
        cloud: Cloud,
        e2e: Boolean,
        formatVersion: Int? = null,
        maxBytes: Long = 32L * 1024 * 1024,
        journal: JournalStore = MemoryJournal(),
    ): SavesClient {
        val engine = FileTransferEngine(cloud, journal, sleeper = { })
        val codec: FileCodec = if (e2e) E2eFileCodec(root, SAVES_COLLECTION) else ServerFileCodec()
        return SavesClient(scope, SavesHooks(settled = { id, r -> settled += id to r })) {
            SavesDeps(cloud, engine, cloud, codec, delta = false, maxBytes = maxBytes, saveFormatVersion = formatVersion)
        }
    }

    private fun meta(chapter: String, formatVersion: Int = 1) = buildJsonObject {
        put("chapter", chapter)
        put("formatVersion", formatVersion)
    }

    private fun bytes(n: Int, seed: Int = 1) = ByteArray(n) { (it * seed + 3).toByte() }

    private suspend fun SaveTransfer.result(): SaveResult = withTimeout(10_000) { await() }

    @Test
    fun aServerModeSaveRoundTripsWithItsMetadata() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val data = bytes(5000)
        val done = saves.writeAs("slot1", data, Meta("one", 3), MetaSerializer).result() as SaveResult.Done
        assertEquals(1L, done.file.version)
        val listed = saves.list().single()
        assertEquals("slot1", listed.id)
        assertEquals(done.version, listed.version)
        assertEquals(done.file.sha256, listed.file?.sha256)
        val read = saves.read("slot1") as SaveRead.Ok
        assertArrayEquals(data, read.bytes)
        val m = read.metadataAs(MetaSerializer)
        assertEquals("one", m.chapter)
        assertEquals(3, m.formatVersion)
        assertTrue(saves.transfers().isEmpty())
        assertEquals("saves:slot1", settled.single().first)
    }

    @Test
    fun theMetadataWriteCarriesTheFinalizedPointerSoTheNewFileListsAtOnce() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val done = saves.writeAs("slot1", bytes(300), Meta("one", 3), MetaSerializer).result() as SaveResult.Done
        // The machine adopts this pointer on ok; without it the new row would list no file until a pull.
        val given = cloud.setFiles.single()!!
        assertEquals(done.file.version, given.version)
        assertEquals(done.file.size, given.size)
        assertEquals(done.file.sha256, given.sha256)
        assertEquals(done.file.format, given.format)
    }

    @Test
    fun anE2eSaveIsStoredSealedAndBoundToItsMetadata() = runBlocking {
        val cloud = Cloud(e2e = true)
        val saves = client(cloud, e2e = true)
        val data = bytes(3000)
        assertTrue(saves.write("slot1", data, meta("a")).result() is SaveResult.Done)
        val stored = cloud.revisions.values.single().single().second
        assertNotEquals("sealed bytes differ from the plaintext", data.size, stored.size)
        assertFalse(stored.toList().containsAll(data.toList().take(8)) && stored.size == data.size)
        val binding = (cloud.records.values.single().value as JsonObject)[SAVE_FILE_BINDING_KEY].objectValue!!
        assertEquals(cloud.records.values.single().file!!.sha256, binding["sha256"].stringValue)
        assertArrayEquals(data, (saves.read("slot1") as SaveRead.Ok).bytes)
        assertNull("the binding is not part of the metadata", (saves.list().single().metadata)[SAVE_FILE_BINDING_KEY])
        // The Worker points the record at another file (an older sealed revision of the same slot, or another slot's): the read fails.
        assertTrue(saves.write("slot2", bytes(3000, 5), meta("b")).result() is SaveResult.Done)
        val other = cloud.records.getValue(cloud.wireId("slot2")).file!!
        val one = cloud.records.getValue(cloud.wireId("slot1"))
        // A Worker that still serves slot1's older revision cannot fool the reader (it finds the one the binding names);
        // one that lost it can only fail it.
        cloud.revisions.getValue(cloud.wireId("slot1")).clear()
        cloud.revisions.getValue(
            cloud.wireId("slot1"),
        ).add(Triple(99L, cloud.revisions.getValue(cloud.wireId("slot2")).single().second, other.sha256))
        one.file = RecordFile(99, other.size, other.sha256, "whole")
        try {
            saves.read("slot1")
            fail("a swapped file must not read")
        } catch (e: SavesException) {
            assertEquals(SavesException.SYNC_FILE_INVALID, e.code)
        }
    }

    @Test
    fun aRecordWithAMalformedBindingFailsAndOneWithoutAFileHasNone() = runBlocking {
        val cloud = Cloud(e2e = true)
        val saves = client(cloud, e2e = true)
        cloud.set("bad", buildJsonObject { put(SAVE_FILE_BINDING_KEY, "nope") }, JsonPrimitive(0), null)
        cloud.set("plain", meta("x"), JsonPrimitive(0), null)
        try {
            saves.read("bad")
            fail("malformed binding")
        } catch (e: SavesException) {
            assertEquals(SavesException.SYNC_FILE_INVALID, e.code)
        }
        val none = saves.read("plain") as SaveRead.Ok
        assertNull(none.file)
        assertNull(none.bytes)
        assertEquals(SaveRead.NotFound, saves.read("missing"))
    }

    @Test
    fun aNewerFormatReadsAsNewerFormatAndListsAsSuch() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false, formatVersion = 2)
        assertTrue(saves.write("s", bytes(100), meta("x", 3)).result() is SaveResult.Done)
        assertTrue(saves.write("t", bytes(100), meta("x", 2)).result() is SaveResult.Done)
        val newer = saves.read("s") as SaveRead.NewerFormat
        assertEquals(3L, newer.formatVersion)
        assertEquals(2, newer.supported)
        assertTrue(saves.read("t") is SaveRead.Ok)
        assertEquals(listOf(true, false), saves.list().map { it.newerFormat })
    }

    @Test
    fun theSixteenSlotsAreTheLimitAndBadInputIsRefusedBeforeAnyRequest() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false, maxBytes = 1000)
        for (i in 1..16) assertTrue(saves.write("s$i", bytes(50), meta("c")).result() is SaveResult.Done)
        fun failed(r: SaveResult) = (r as SaveResult.Failed).error.code
        assertEquals(SavesException.SLOTS_FULL, failed(saves.write("s17", bytes(50), meta("c")).result()))
        assertTrue("an existing slot still writes", saves.write("s3", bytes(60), meta("c")).result() is SaveResult.Done)
        assertEquals(SavesException.TOO_LARGE, failed(saves.write("s3", bytes(1001), meta("c")).result()))
        assertEquals(SavesException.INVALID_SAVE, failed(saves.write("bad id", bytes(5), meta("c")).result()))
        assertEquals(SavesException.INVALID_SAVE, failed(saves.write("s3", bytes(5), buildJsonObject { put(SAVE_FILE_BINDING_KEY, 1) }).result()))
        try {
            saves.read("no/slash")
            fail("id")
        } catch (e: SavesException) {
            assertEquals(SavesException.INVALID_SAVE, e.code)
        }
    }

    @Test
    fun aStaleWriteIsAConflictAndEachResolutionDoesWhatItSays() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("theirs")).result() is SaveResult.Done)
        val first = (saves.read("s") as SaveRead.Ok).version
        assertTrue(saves.write("s", bytes(100, 2), meta("newer")).result() is SaveResult.Done)
        val conflict = (saves.write("s", bytes(120, 3), meta("mine"), baseVersion = first).result() as SaveResult.Conflict).conflict
        assertEquals("newer", conflict.remote!!.metadata["chapter"].stringValue)
        assertTrue(conflict.bothAvailable)
        // REMOTE keeps theirs and writes nothing.
        val kept = saves.resolve(conflict, SaveKeep.REMOTE, bytes(120, 3)).result() as SaveResult.KeptRemote
        assertEquals(conflict.serverVersion, kept.version)
        assertEquals("newer", (saves.read("s") as SaveRead.Ok).metadata["chapter"].stringValue)
        // BOTH writes mine as a new save.
        val both = saves.resolve(conflict, SaveKeep.BOTH, bytes(120, 3)).result() as SaveResult.Done
        assertEquals("s.copy", both.copyId)
        assertEquals("mine", (saves.read("s.copy") as SaveRead.Ok).metadata["chapter"].stringValue)
        // LOCAL overwrites theirs.
        val local = saves.resolve(conflict, SaveKeep.LOCAL, bytes(120, 3)).result()
        assertTrue(local is SaveResult.Done)
        assertArrayEquals(bytes(120, 3), (saves.read("s") as SaveRead.Ok).bytes)
    }

    @Test
    fun aConflictDescribesTheServersVersionNotTheCachedCopy() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("old")).result() is SaveResult.Done)
        val stale = cloud.get("s")
        val first = stale!!.version
        // Another device wrote on top; this device's cache still holds the first row.
        cloud.records.values.single().let {
            it.version += 40
            it.value = buildJsonObject { put("chapter", "theirs") }
        }
        cloud.cache = { stale }
        val conflict = (saves.write("s", bytes(120, 3), meta("mine"), baseVersion = first).result() as SaveResult.Conflict).conflict
        val serverVersion = cloud.records.values.single().version
        assertEquals(serverVersion, conflict.serverVersion)
        assertEquals(serverVersion, conflict.remote!!.version)
        // Keeping this device's version succeeds, and the next write does not repeat the conflict.
        assertTrue(saves.resolve(conflict, SaveKeep.LOCAL, bytes(120, 3)).result() is SaveResult.Done)
        cloud.cache = null
        assertTrue(saves.write("s", bytes(90, 4), meta("again")).result() is SaveResult.Done)
    }

    @Test
    fun aSaveDeletedElsewhereHasNoRemoteAndKeepMineUsesMustNotExist() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("old")).result() is SaveResult.Done)
        val stale = cloud.get("s")
        cloud.records.clear()
        cloud.cache = { stale }
        val conflict = (saves.write("s", bytes(120, 3), meta("mine")).result() as SaveResult.Conflict).conflict
        assertNull(conflict.remote)
        assertEquals(0L, conflict.serverVersion)
        assertTrue(saves.resolve(conflict, SaveKeep.LOCAL, bytes(120, 3)).result() is SaveResult.Done)
        assertEquals(JsonPrimitive("*"), cloud.bases.last())
    }

    @Test
    fun aQuotaRefusalAtFinalizeFailsTheTransferAndAFailureIsAnEvent() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.quota = true }
        val saves = client(cloud, e2e = false)
        val failed = saves.write("s", bytes(100), meta("c")).result() as SaveResult.Failed
        assertEquals(SavesException.TRANSFER_FAILED, failed.error.code)
        assertEquals("quota_exceeded", failed.error.detail)
        assertEquals(1, settled.count { it.second is SaveResult.Failed })
        assertTrue("the aborted upload was released", cloud.aborted.isNotEmpty())
    }

    @Test
    fun aPausedTransferKeepsItsJournalAndResumesAndACancelReleasesTheUpload() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val journal = MemoryJournal()
        val saves = client(cloud, e2e = false, journal = journal)
        val t = saves.write("s", bytes(500), meta("c"))
        withTimeout(5000) { while (journal.list().isEmpty()) kotlinx.coroutines.delay(5) }
        t.pause()
        withTimeout(5000) { while (t.state != TransferState.PAUSED) kotlinx.coroutines.delay(5) }
        assertEquals(listOf(t.id), saves.transfers().map { it.id })
        assertEquals(1, journal.list().size)
        cloud.gate!!.complete(Unit)
        t.resume()
        assertTrue(t.result() is SaveResult.Done)
        assertEquals(TransferState.DONE, t.state)
        assertTrue(journal.list().isEmpty())
        // Cancel while paused.
        val cloud2 = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val saves2 = client(cloud2, e2e = false)
        val t2 = saves2.write("s", bytes(500), meta("c"))
        kotlinx.coroutines.delay(100)
        t2.pause()
        withTimeout(5000) { while (t2.state != TransferState.PAUSED) kotlinx.coroutines.delay(5) }
        t2.cancel()
        assertEquals(SaveResult.Cancelled, t2.result())
        assertEquals(TransferState.CANCELLED, t2.state)
        assertTrue(cloud2.aborted.isNotEmpty())
        assertTrue(saves2.transfers().isEmpty())
    }

    @Test
    fun revisionsAndDeleteGoThroughTheCloud() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("a")).result() is SaveResult.Done)
        assertTrue(saves.write("s", bytes(110), meta("b")).result() is SaveResult.Done)
        assertEquals(listOf(2L, 1L).size, saves.revisions("s").size)
        assertTrue(saves.delete("s") is SaveSetResult.Ok)
        assertTrue(saves.list().isEmpty())
        assertTrue(saves.delete("s") is SaveSetResult.Rejected)
    }

    @Test
    fun aCancelDuringAPauseWinsOverTheResume() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val saves = client(cloud, e2e = false)
        val t = saves.write("s", bytes(500), meta("c"))
        kotlinx.coroutines.delay(100)
        t.pause()
        t.cancel()
        t.resume()
        assertEquals(SaveResult.Cancelled, t.result())
        assertEquals(TransferState.CANCELLED, t.state)
    }

    @Test
    fun pauseThenResumeBackToBackFinishes() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val saves = client(cloud, e2e = false)
        val t = saves.write("s", bytes(500), meta("c"))
        kotlinx.coroutines.delay(100)
        t.pause()
        t.resume()
        cloud.gate!!.complete(Unit)
        assertTrue(t.result() is SaveResult.Done)
    }
}
