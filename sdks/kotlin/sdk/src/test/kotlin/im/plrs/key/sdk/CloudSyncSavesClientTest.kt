// @pkey-feature sync.saves
// @pkey-feature sync.conflict
//
// The saves client (U-22.5) over an in-memory cloud that is both the file routes and the record layer:
// the D-3 order (file, then the metadata on the version finalize answered), the E2E binding, a Worker that swaps a
// file, `formatVersion`, the 16 slots, conflicts (a MergeRequest per slot) and their keeps, a quota refusal, and pause and cancel.
// The machine's records binding and the client's wiring are pinned in CloudSyncSavesTest.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MergeCause
import im.plrs.key.core.MergeChoice
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.MergeKeep
import im.plrs.key.core.sync.RecordFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
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

    /** Rewrites the answer to `finalize` (the stored file is untouched). */
    var finalizeAnswer: (JsonObject) -> JsonObject = { it }
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
        // A version is always newer than the record's current one.
        counter = maxOf(counter, records[target.record]?.version ?: 0L)
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
            finalizeAnswer(
                buildJsonObject {
                    put("version", version)
                    put("size", bytes.size)
                    put("sha256", file.sha256)
                    put("format", "whole")
                },
            ),
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

    /** What a pull does (another device wrote meanwhile); null: this port cannot pull. */
    var onPull: (() -> Unit)? = null
    var pulls = 0

    override suspend fun pull(): Boolean {
        val f = onPull ?: return false
        pulls++
        f()
        return true
    }

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

    private class ClientOptions(
        val formatVersion: Int? = null,
        val maxBytes: Long = 32L * 1024 * 1024,
        val journal: JournalStore = MemoryJournal(),
        val deviceLabel: String? = null,
    )

    private fun client(cloud: Cloud, e2e: Boolean, options: ClientOptions = ClientOptions(), onSettled: () -> Unit = {}): SavesClient {
        val engine = FileTransferEngine(cloud, options.journal, sleeper = { })
        val codec: FileCodec = if (e2e) E2eFileCodec(root, SAVES_COLLECTION) else ServerFileCodec()
        val hooks = SavesHooks(
            settled = { id, r ->
                onSettled()
                settled += id to r
            },
        )
        return SavesClient(scope, hooks, MergeRegistry(scope)) {
            SavesDeps(
                cloud,
                engine,
                cloud,
                codec,
                delta = false,
                maxBytes = options.maxBytes,
                saveFormatVersion = options.formatVersion,
                deviceLabel = options.deviceLabel,
                now = { 1_000L },
            )
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
        val saves = client(cloud, e2e = false, ClientOptions(formatVersion = 2))
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
        val saves = client(cloud, e2e = false, ClientOptions(maxBytes = 1000))
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

    /** A save written twice by "another device" and then written here on the first version: a conflict request. */
    private suspend fun staleRequest(saves: SavesClient, id: String = "s"): Pair<MergeRequest, Long> {
        assertTrue(saves.write(id, bytes(100), meta("theirs")).result() is SaveResult.Done)
        val first = (saves.read(id) as SaveRead.Ok).version
        assertTrue(saves.write(id, bytes(100, 2), meta("newer")).result() is SaveResult.Done)
        val out = saves.write(id, bytes(120, 3), meta("mine"), baseVersion = first).result() as SaveResult.Conflict
        return out.request to first
    }

    private fun chapter(side: im.plrs.key.core.sync.MergeSide?): String? = (side?.value as? JsonObject)?.get("chapter").stringValue

    @Test
    fun saveConflictOpensRequest() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val (request, first) = staleRequest(saves)
        assertEquals("w:saves/s", request.id)
        assertEquals(MergeCause.write, request.cause)
        assertEquals(SAVES_COLLECTION, request.collection)
        assertEquals("s", request.record)
        assertEquals("open", request.state)
        assertNull(request.error)
        assertEquals("newer", chapter(request.remote))
        assertEquals("mine", chapter(request.local))
        assertEquals(first, request.local!!.version)
        assertEquals(1_000L, request.local!!.savedAt)
        assertEquals(listOf(MergeChoice.local, MergeChoice.remote, MergeChoice.both), request.choices)
        assertEquals(listOf("w:saves/s"), saves.merge.conflicts().map { it.id })
        // Nothing of the device's copy was stored.
        assertEquals("newer", (saves.read("s") as SaveRead.Ok).metadata["chapter"].stringValue)
    }

    @Test
    fun saveRequestFreezesSlot() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val (request, _) = staleRequest(saves)
        val sent = cloud.bases.size
        // A later write with no base only replaces the request's local copy; it is not sent.
        val again = saves.write("s", bytes(130, 4), meta("later")).result() as SaveResult.Conflict
        assertTrue(again.request === request)
        assertEquals("later", chapter(request.local))
        assertEquals(sent, cloud.bases.size)
        assertEquals(1, saves.merge.conflicts().size)
        assertTrue(request.keep(MergeKeep.Local) is MergeOutcome.Kept)
        assertEquals("later", (saves.read("s") as SaveRead.Ok).metadata["chapter"].stringValue)
        assertArrayEquals(bytes(130, 4), (saves.read("s") as SaveRead.Ok).bytes)
    }

    @Test
    fun saveBaseIsSeenVersion() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("one")).result() is SaveResult.Done)
        assertEquals(JsonPrimitive("*"), cloud.bases.last())
        val wrote = cloud.records.values.single().version
        // Another device wrote on top and this device pulled it: the pulled version is not a base.
        cloud.records.values.single().let {
            it.version += 40
            it.value = buildJsonObject { put("chapter", "theirs") }
        }
        val out = saves.write("s", bytes(100, 2), meta("two")).result()
        assertEquals(JsonPrimitive(wrote), cloud.bases.last())
        assertTrue(out is SaveResult.Conflict)
        assertEquals("theirs", chapter((out as SaveResult.Conflict).request.remote))
        // A slot not seen this session is create-only, so a save on the cloud is a conflict, not an overwrite.
        val fresh = client(cloud, e2e = false)
        val out2 = fresh.write("s", bytes(100, 3), meta("three")).result()
        assertEquals(JsonPrimitive("*"), cloud.bases.last())
        assertTrue(out2 is SaveResult.Conflict)
    }

    @Test
    fun saveKeepLocal() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val (request, _) = staleRequest(saves)
        val serverVersion = cloud.records.values.single().version
        val kept = request.keep(MergeKeep.Local)
        assertTrue(kept.toString(), kept is MergeOutcome.Kept)
        assertEquals("local", (kept as MergeOutcome.Kept).kept)
        assertEquals(JsonPrimitive(serverVersion), cloud.bases.last())
        assertArrayEquals(bytes(120, 3), (saves.read("s") as SaveRead.Ok).bytes)
        assertEquals("mine", (saves.read("s") as SaveRead.Ok).metadata["chapter"].stringValue)
        assertTrue(saves.merge.conflicts().isEmpty())
    }

    @Test
    fun saveKeepRemote() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false, ClientOptions(deviceLabel = "Steam Deck"))
        assertTrue(saves.write("s", bytes(100), meta("old")).result() is SaveResult.Done)
        val stale = cloud.get("s")!!
        // Another device wrote on top; this device's cache still holds the first row until it pulls.
        cloud.records.values.single().let {
            it.version += 40
            it.value = buildJsonObject { put("chapter", "theirs") }
        }
        cloud.cache = { stale }
        cloud.onPull = { cloud.cache = null }
        val request = (saves.write("s", bytes(120, 3), meta("mine"), baseVersion = stale.version).result() as SaveResult.Conflict).request
        assertEquals(1, cloud.pulls)
        assertEquals("theirs", chapter(request.remote))
        // This device's card carries when and where it was saved (never a hardware value).
        assertEquals(1_000L, request.local!!.savedAt)
        assertEquals("Steam Deck", request.local!!.device)
        assertNull("the other copy carries no savedAt, so neither is newer", request.newer)
        // Keeping the other version pulls again, writes nothing, and the chosen copy is what is held.
        cloud.cache = { stale }
        val sent = cloud.bases.size
        val kept = request.keep(MergeKeep.Remote) as MergeOutcome.Kept
        assertEquals(2, cloud.pulls)
        assertEquals(cloud.records.values.single().version, kept.version)
        assertEquals(sent, cloud.bases.size)
        assertTrue(saves.merge.conflicts().isEmpty())
    }

    @Test
    fun saveKeepBothNeedsFreeSlot() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val (request, _) = staleRequest(saves)
        val both = request.keep(MergeKeep.Both) as MergeOutcome.Kept
        assertEquals("s.copy", both.copyId)
        assertEquals("mine", (saves.read("s.copy") as SaveRead.Ok).metadata["chapter"].stringValue)
        assertEquals("newer", (saves.read("s") as SaveRead.Ok).metadata["chapter"].stringValue)
        // With all 16 slots in use `both` is not on offer, and asking for it is refused without touching the request.
        val full = Cloud(e2e = false)
        val crowded = client(full, e2e = false)
        for (i in 1..16) assertTrue(crowded.write("s$i", bytes(50), meta("c")).result() is SaveResult.Done)
        val stale = (crowded.write("s1", bytes(60), meta("mine"), baseVersion = 999).result() as SaveResult.Conflict).request
        assertEquals(listOf(MergeChoice.local, MergeChoice.remote), stale.choices)
        assertEquals(MergeOutcome.Refused("bad_request", reopened = false), stale.keep(MergeKeep.Both))
        assertEquals("open", stale.state)
    }

    @Test
    fun saveKeepAfterDeleteCreates() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("old")).result() is SaveResult.Done)
        val stale = cloud.get("s")
        cloud.records.clear()
        cloud.cache = { stale }
        val request = (saves.write("s", bytes(120, 3), meta("mine")).result() as SaveResult.Conflict).request
        assertNull(request.remote)
        assertEquals(listOf(MergeChoice.local, MergeChoice.remote), request.choices)
        assertTrue(request.keep(MergeKeep.Local) is MergeOutcome.Kept)
        assertEquals(JsonPrimitive("*"), cloud.bases.last())
    }

    @Test
    fun saveExactWriteSupersedes() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val (request, _) = staleRequest(saves)
        val current = cloud.records.values.single().version
        val done = saves.write("s", bytes(90, 5), meta("exact"), baseVersion = current).result()
        assertTrue(done.toString(), done is SaveResult.Done)
        assertTrue(saves.merge.conflicts().isEmpty())
        assertEquals(MergeOutcome.Refused(ErrorCode.syncMergeClosed, reopened = false), request.keep(MergeKeep.Local))
        // A delete with no base while a request is open is based on the request's local version, so it conflicts.
        val (second, _) = staleRequest(saves, "t")
        val theirs = cloud.records.keys.last()
        assertTrue(saves.delete("t") is SaveSetResult.Conflict)
        assertTrue(saves.merge.conflicts().none { it.id == second.id })
        assertTrue(theirs.isNotEmpty())
        assertEquals("newer", (saves.read("t") as SaveRead.Ok).metadata["chapter"].stringValue)
    }

    @Test
    fun saveKeepOnClosedRequest() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        val (request, _) = staleRequest(saves)
        assertTrue(request.keep(MergeKeep.Remote) is MergeOutcome.Kept)
        assertEquals(MergeOutcome.Refused(ErrorCode.syncMergeClosed, reopened = false), request.keep(MergeKeep.Local))
        assertEquals(MergeOutcome.Refused(ErrorCode.syncMergeClosed, reopened = false), request.keep(MergeKeep.Remote))
    }

    @Test
    fun saveRequestNotJournaled() = runBlocking {
        val cloud = Cloud(e2e = false)
        val journal = MemoryJournal()
        val saves = client(cloud, e2e = false, ClientOptions(journal = journal))
        val (request, _) = staleRequest(saves)
        assertEquals("open", request.state)
        // A relaunch drops the request (S5); the app still holds its save, and its next write raises the conflict again.
        val relaunched = client(cloud, e2e = false, ClientOptions(journal = journal))
        assertTrue(relaunched.merge.conflicts().isEmpty())
        val again = relaunched.write("s", bytes(120, 3), meta("mine")).result() as SaveResult.Conflict
        assertEquals("w:saves/s", again.request.id)
        assertEquals("newer", chapter(again.request.remote))
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
        val request = (saves.write("s", bytes(120, 3), meta("mine"), baseVersion = first).result() as SaveResult.Conflict).request
        val serverVersion = cloud.records.values.single().version
        assertEquals(serverVersion, request.remote!!.version)
        // Keeping this device's version succeeds, and the next write does not repeat the conflict.
        assertTrue(request.keep(MergeKeep.Local) is MergeOutcome.Kept)
        cloud.cache = null
        assertTrue(saves.write("s", bytes(90, 4), meta("again")).result() is SaveResult.Done)
    }

    @Test
    fun aSaveDeletedElsewhereReadsAsDeletedAfterThePull() = runBlocking {
        val cloud = Cloud(e2e = false)
        val saves = client(cloud, e2e = false)
        assertTrue(saves.write("s", bytes(100), meta("old")).result() is SaveResult.Done)
        val stale = cloud.get("s")!!
        // A tombstone answers its version, not 0; the pull removes the row.
        cloud.records.values.single().version = stale.version + 40
        cloud.cache = { stale }
        cloud.onPull = {
            cloud.cache = null
            cloud.records.clear()
        }
        val request = (saves.write("s", bytes(120, 3), meta("mine"), baseVersion = stale.version).result() as SaveResult.Conflict).request
        assertNull(request.remote)
    }

    @Test
    fun aFinalizeAnswerNamingAnotherFileFailsTheWriteAndAdoptsNothing() = runBlocking {
        for (e2e in listOf(false, true)) {
            val cloud = Cloud(e2e = e2e)
            val saves = client(cloud, e2e = e2e)
            assertTrue(saves.write("a", bytes(100, 1), meta("one")).result() is SaveResult.Done)
            val other = saves.write("b", bytes(120, 2), meta("two")).result() as SaveResult.Done
            val before = cloud.records.mapValues { it.value.value.toString() }
            cloud.finalizeAnswer = { a ->
                JsonObject(a + mapOf("size" to JsonPrimitive(other.file.size), "sha256" to JsonPrimitive(other.file.sha256)))
            }
            val failed = saves.write("a", bytes(140, 3), meta("three")).result()
            assertTrue("expected failed, got $failed", failed is SaveResult.Failed)
            // No metadata was pushed for the refused file.
            assertEquals(before, cloud.records.mapValues { it.value.value.toString() })
        }
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
    fun aSettledEventIsDeliveredBeforeTheOutcomeIsObservable() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.quota = true }
        val saves = client(cloud, e2e = false, onSettled = { Thread.sleep(50) })
        val t = saves.write("s", bytes(100), meta("c"))
        assertTrue(t.result() is SaveResult.Failed)
        assertEquals(listOf("saves:s"), settled.map { it.first })
        assertTrue(saves.transfers().isEmpty())
    }

    @Test
    fun aPausedTransferKeepsItsJournalAndResumesAndACancelReleasesTheUpload() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val journal = MemoryJournal()
        val saves = client(cloud, e2e = false, ClientOptions(journal = journal))
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

    // -- background runs (U-41.7b): a scheduled run waits for the live write --------------------------------------

    @Test
    fun aBackgroundRunWaitsForTheLiveWriteAndAnswersDone() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val started = CopyOnWriteArrayList<String>()
        val engine = FileTransferEngine(cloud, MemoryJournal(), sleeper = { })
        val saves = SavesClient(scope, SavesHooks(started = { started += it }), MergeRegistry(scope)) {
            SavesDeps(cloud, engine, cloud, ServerFileCodec(), delta = false, now = { 1_000L })
        }
        val t = saves.write("s", bytes(500), meta("c"))
        assertEquals(listOf("saves:s"), started.toList())
        val run = scope.async { saves.awaitBackground(ownerTag("saves:s")) }
        kotlinx.coroutines.delay(100)
        assertFalse(run.isCompleted)
        cloud.gate!!.complete(Unit)
        assertEquals(BackgroundTransferOutcome.DONE, withTimeout(10_000) { run.await() })
        assertTrue(t.result() is SaveResult.Done)
    }

    @Test
    fun aBackgroundRunStopsForANoSuchWriteACancelledOneAndAPausedOne() = runBlocking {
        val cloud = Cloud(e2e = false).also { it.gate = CompletableDeferred() }
        val saves = client(cloud, e2e = false)
        assertEquals(BackgroundTransferOutcome.STOP, saves.awaitBackground(ownerTag("saves:none")))
        val t = saves.write("s", bytes(500), meta("c"))
        kotlinx.coroutines.delay(100)
        val run = scope.async { saves.awaitBackground(ownerTag("saves:s")) }
        t.pause()
        withTimeout(5000) { while (t.state != TransferState.PAUSED) kotlinx.coroutines.delay(5) }
        assertEquals(BackgroundTransferOutcome.STOP, withTimeout(10_000) { run.await() })
        val cancelled = scope.async { saves.awaitBackground(ownerTag("saves:s")) }
        t.cancel()
        assertEquals(SaveResult.Cancelled, t.result())
        assertEquals(BackgroundTransferOutcome.STOP, withTimeout(10_000) { cancelled.await() })
    }
}
