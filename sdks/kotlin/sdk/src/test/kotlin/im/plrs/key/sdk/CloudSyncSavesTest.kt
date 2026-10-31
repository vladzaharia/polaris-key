// @pkey-feature sync.saves sync.files
//
// `client.cloudSync.saves` on a real client (U-22.5), against a scripted Worker (server mode, whole-file uploads): the
// order of a write (file first, then the metadata at the version finalize answered), the transfer events and
// `transfers()`, a conflict that carries the server copy, `resolve`, delete, a file-only row, `cancel()` of a write that
// waits for its metadata outcome, a locked ring stopping the codec, and the save transfers going with the person before
// the ring's pin does.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList

private const val ALICE = "ps_AliceAliceAliceAlice1"
private val ROOT = ByteArray(32) { (5 * it + 3).toByte() }
private val RING_ID = "rg_" + "A".repeat(22)

private val mirror: JsonObject = Json.parseToJsonElement(
    """{"schemaVersion":1,"entries":[{"key":"audio.volume","kind":"config","schema":{"type":"number"},"user":{"sync":"user","conflict":"lastWrite"}}],
      "cloudSync":{"encryption":"server","collections":[{"name":"saves","template":"saves","files":{"delta":false}}]}}""",
) as JsonObject

private fun sha(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

private fun bytes(n: Int, seed: Int = 7) = ByteArray(n) { (it * 31 + seed).toByte() }

private class Row(var value: JsonObject?, var version: Long, var file: JsonObject?, var ct: String? = null)

/** The Worker's saves, as far as a whole-file save needs. */
private class SavesWorld(val e2e: Boolean = false) {
    @Volatile var version = 0L
    val rows = java.util.concurrent.ConcurrentHashMap<String, Row>()
    val stored = java.util.concurrent.ConcurrentHashMap<Long, ByteArray>()
    val uploads = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
    val files = CopyOnWriteArrayList<String>()
    val pushes = CopyOnWriteArrayList<JsonObject>()

    /** The push never answers (a request-level failure): a write waits on its outcome. */
    @Volatile var opsDown = false

    fun file(version: Long, size: Int, shaHex: String) = buildJsonObject {
        put("version", version)
        put("size", size)
        put("sha256", shaHex)
        put("format", "whole")
    }

    private fun change(id: String, r: Row): JsonObject = buildJsonObject {
        put("record", JsonArray(listOf(JsonPrimitive("saves"), JsonPrimitive(id))))
        put("version", r.version)
        r.value?.let { put("value", it) }
        r.ct?.let { put("ct", it) }
        r.file?.let { put("file", it) }
    }

    fun body(extra: Map<String, JsonElement> = emptyMap(), since: Long = 0): JsonObject = JsonObject(
        buildMap {
            put("encryption", JsonPrimitive(if (e2e) "e2e" else "server"))
            put("subject", JsonPrimitive(ALICE))
            put("cursor", JsonPrimitive(version))
            put("more", JsonPrimitive(false))
            put("serverNow", JsonPrimitive(System.currentTimeMillis()))
            put("catalogVersion", JsonPrimitive(1))
            put("lastMutationId", JsonPrimitive(0))
            put("changes", JsonArray(rows.filter { it.value.version > since }.map { (id, r) -> change(id, r) }))
            put("tombstones", JsonArray(emptyList()))
            put("aliases", JsonObject(emptyMap()))
            put("usage", Json.parseToJsonElement("""{"bytes":0,"settings":0,"records":0,"files":0}"""))
            put("quota", Json.parseToJsonElement("""{"bytes":268435456,"files":true}"""))
            putAll(extra)
        },
    )

    fun ops(request: JsonObject): JsonObject {
        val results = mutableListOf<JsonElement>()
        val tombstones = mutableListOf<JsonElement>()
        for (m in request["mutations"] as JsonArray) {
            val mo = m as JsonObject
            val id = ((mo["target"] as JsonObject)["record"] as JsonArray)[1].stringValue!!
            val row = rows[id]
            val base = mo["baseVersion"]
            val stale = if (base is JsonPrimitive && base.isString) row != null else row?.version != base.longValue
            val mid = mo["mutationId"].longValue!!
            if (stale) {
                val server = if (row != null) {
                    JsonObject(change(id, row) - "record")
                } else {
                    buildJsonObject { put("version", version) }
                }
                results += buildJsonObject {
                    put("mutationId", mid)
                    put("status", "conflict")
                    put("server", server)
                }
                continue
            }
            val v = ++version
            if (mo["op"].stringValue == "delete") {
                rows.remove(id)
                tombstones += buildJsonObject {
                    put("record", JsonArray(listOf(JsonPrimitive("saves"), JsonPrimitive(id))))
                    put("version", v)
                }
            } else {
                rows[id] = Row(mo["value"] as? JsonObject, v, row?.file, mo["ct"].stringValue)
            }
            results += buildJsonObject {
                put("mutationId", mid)
                put("status", "ok")
                put("version", v)
            }
        }
        return body(mapOf("results" to JsonArray(results), "tombstones" to JsonArray(tombstones)), request["cursor"].longValue ?: 0)
    }
}

class CloudSyncSavesTest {
    @get:Rule val tmp = TemporaryFolder()

    private val signer = TestSigner()
    private var world = SavesWorld()

    private fun json(o: JsonElement, status: Int = 200) = respond(status, o.toString())

    private fun handle(r: PolarisRequest): PolarisResponse {
        val path = r.path
        val prefix = "/djdl/sync/files/saves/"
        return when {
            path.endsWith("/.well-known/polaris.json") -> respond(
                200,
                """{"product":"djdl","services":{"license":{"enabled":true},"config":{"enabled":true},""" +
                    """"sync":{"enabled":true,"encryption":"${if (world.e2e) "e2e" else "server"}"},""" +
                    """"identity":{"enabled":true,"account":true,"issuer":"https://key.example/djdl/identity",""" +
                    """"endpoints":""" +
                    """{"subject":"https://key.example/djdl/identity/subject","signout":"https://key.example/djdl/identity/signout"}}}}""",
            )

            path.endsWith("/identity/subject") -> respond(200, """{"subject":"$ALICE"}""")

            path.endsWith("/identity/signout") -> respond(200, """{"released":false}""")

            path.endsWith("/sync/ops") -> if (world.opsDown) {
                respond(503, """{"error":{"code":"unavailable"}}""")
            } else {
                world.pushes += Json.parseToJsonElement(String(r.body ?: ByteArray(0))) as JsonObject
                json(world.ops(Json.parseToJsonElement(String(r.body ?: ByteArray(0))) as JsonObject))
            }

            path.startsWith(prefix) -> files(r, path.removePrefix(prefix))

            path.contains("/sync") -> json(world.body(since = r.url.substringAfter("cursor=", "0").substringBefore("&").toLongOrNull() ?: 0))

            else -> respond(404, """{"error":{"code":"not_found"}}""")
        }
    }

    @Suppress("CyclomaticComplexMethod")
    private fun files(r: PolarisRequest, rest: String): PolarisResponse {
        val parts = rest.split("/")
        val id = parts[0]
        val tail = parts.drop(1)
        world.files += "${r.method} ${tail.joinToString("/").ifEmpty { "-" }}"
        val row = world.rows[id]
        return when {
            r.method == "POST" && tail == listOf("begin") -> {
                val base = (Json.parseToJsonElement(String(r.body!!)) as JsonObject)["baseVersion"]
                val stale = if (base is JsonPrimitive && base.isString) row != null else row?.version != base.longValue
                if (stale) {
                    respond(409, """{"error":{"code":"revision_conflict"},"server":{"version":${row?.version ?: 0}}}""")
                } else {
                    val up = "up_${world.uploads.size + 1}"
                    world.uploads[up] = ByteArray(0)
                    respond(200, """{"uploadId":"$up","mode":"single","expiresAt":4000000000000}""")
                }
            }

            r.method == "PUT" && tail.firstOrNull() == "upload" -> {
                world.uploads[tail[1]] = r.body ?: ByteArray(0)
                respond(204)
            }

            r.method == "DELETE" && tail.firstOrNull() == "upload" -> {
                world.uploads.remove(tail[1])
                respond(204)
            }

            r.method == "POST" && tail == listOf("finalize") -> {
                val up = ((Json.parseToJsonElement(String(r.body!!)) as JsonObject)["uploadId"]).stringValue!!
                val data = world.uploads.getValue(up)
                val v = ++world.version
                val file = world.file(v, data.size, sha(data))
                world.stored[v] = data
                world.rows[id] = Row(row?.value, v, file)
                json(file)
            }

            r.method == "GET" && tail == listOf("revisions") -> json(
                buildJsonObject {
                    put(
                        "revisions",
                        JsonArray(
                            world.stored.keys.sortedDescending().map { v ->
                                world.file(v, world.stored.getValue(v).size, sha(world.stored.getValue(v)))
                            },
                        ),
                    )
                },
            )

            r.method == "GET" && tail.isEmpty() -> {
                val v = r.url.substringAfter("version=", "").toLongOrNull() ?: row?.file?.get("version").longValue
                val data = v?.let { world.stored[it] }
                if (data == null) respond(404, """{"error":{"code":"not_found"}}""") else PolarisResponse(200, data, mapOf("etag" to "\"e\""))
            }

            else -> respond(404, """{"error":{"code":"not_found"}}""")
        }
    }

    private class LoggedStorage(val inner: InMemoryDeviceKeyStorage, val onClear: () -> Unit) : DeviceKeyStorage by inner {
        override suspend fun clear() {
            onClear()
            inner.clear()
        }
    }

    private inner class Rig(roots: DeviceKeyStorage = InMemoryDeviceKeyStorage(), seedRoot: Boolean = false, e2e: Boolean = false) {
        val dir: File = tmp.newFolder()
        val transport = ScriptedTransport(::handle)
        val client: PolarisKeyClient
        val events = CopyOnWriteArrayList<CloudSyncEvent>()

        init {
            val store = FileStore("djdl", dir)
            runBlocking { store.setToken("pkeyt_alice") }
            client = runBlocking {
                PolarisKeyClient.create(
                    PolarisKeyClientOptions(
                        core = CoreOptions(
                            productSlug = "djdl",
                            baseUrl = "https://key.example",
                            version = "1.0.0",
                            pinnedKeys = signer.trust,
                            trustRefresh = false,
                            store = store,
                            transport = transport,
                            clock = { 1_700_000_000L },
                            expectedServices = listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.identity, ServiceSlug.sync),
                        ),
                        license = LicenseClientOptions(fingerprint = false),
                        keyring = KeyringOptions(keys = null, rootStorage = roots),
                        cloudSync = CloudSyncHostOptions().also {
                            it.encryption = if (e2e) "e2e" else "server"
                            it.catalog = mirror
                        },
                    ),
                )
            }
            if (seedRoot) {
                runBlocking {
                    val kid = SyncKeys.deriveKid(ROOT)
                    val vault = RingVault(client.core, KeyringOptions(rootStorage = roots))
                    vault.save(SyncRootRecord(RING_ID, 1, kid.joinToString("") { "%02x".format(it) }, Base64Url.encode(ROOT)))
                    vault.writePin(SyncRingPin(RING_ID, 1, kid.joinToString("") { "%02x".format(it) }))
                    assertTrue(client.keyring.status().unlocked)
                }
            }
            client.scope.launch { client.events.collect { e -> if (e is PolarisEvent.CloudSync) events += e.event } }
        }

        suspend fun signIn() {
            client.identity.subject()
            eventually("signed in") { client.cloudSync.status().state != SyncState.Local }
            client.cloudSync.flush()
        }

        val saves get() = client.cloudSync.saves
    }

    private suspend fun eventually(what: String, timeoutMs: Long = 8_000, cond: suspend () -> Boolean) {
        try {
            withTimeout(timeoutMs) { while (!cond()) delay(20) }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out: $what ${world.files}", e)
        }
    }

    private fun meta(chapter: String) = buildJsonObject { put("chapter", chapter) }

    private suspend fun SaveTransfer.result(): SaveResult = withTimeout(10_000) { await() }

    @Test
    fun aWriteStoresTheFileThenTheMetadataAtTheVersionFinalizeAnsweredAndReadsBack() = runBlocking {
        val r = Rig()
        r.signIn()
        val data = bytes(3000)
        val transfer = r.saves.write("slot-1", data, meta("one"))
        assertEquals(listOf("saves:slot-1"), r.client.cloudSync.transfers().map { it.id })
        val done = transfer.result() as SaveResult.Done
        assertEquals(listOf("POST begin", "PUT upload/up_1", "POST finalize"), world.files.take(3))
        // The metadata `set` went on the version `finalize` answered, as an exact write.
        val set = world.pushes.flatMap { (it["mutations"] as JsonArray).map { m -> m as JsonObject } }.single { it["op"].stringValue == "set" }
        assertEquals(done.file.version, set["baseVersion"].longValue)
        assertEquals(sha(data), world.rows.getValue("slot-1").file?.get("sha256").stringValue)
        assertEquals(meta("one"), world.rows.getValue("slot-1").value)
        assertTrue(r.client.cloudSync.transfers().isEmpty())
        eventually("events") { r.events.any { it is CloudSyncEvent.TransferDone } }
        assertTrue(r.events.any { it is CloudSyncEvent.TransferProgress })
        val doneEvent = r.events.filterIsInstance<CloudSyncEvent.TransferDone>().last()
        assertEquals("saves:slot-1", doneEvent.id)
        assertEquals("done", doneEvent.state)
        assertEquals("transferDone", doneEvent.type)
        val listed = r.saves.list().single()
        assertEquals("slot-1", listed.id)
        assertEquals(meta("one"), listed.metadata)
        assertEquals(3000L, listed.file?.size)
        val read = r.saves.read("slot-1") as SaveRead.Ok
        assertArrayEquals(data, read.bytes)
        assertEquals(meta("one"), read.metadata)
        r.client.close()
    }

    @Test
    fun aStaleWriteIsAConflictThatCarriesTheServerCopyAndResolveSettlesIt() = runBlocking {
        world.rows["slot-1"] = Row(meta("two"), 7, world.file(7, 5, "a".repeat(64)))
        world.version = 7
        val r = Rig()
        r.signIn()
        val out = r.saves.write("slot-1", bytes(500), meta("mine"), baseVersion = 5).result() as SaveResult.Conflict
        assertEquals("two", out.conflict.remote!!.metadata["chapter"].stringValue)
        assertEquals(7L, out.conflict.serverVersion)
        val kept = r.saves.resolve(out.conflict, SaveKeep.REMOTE, bytes(500)).result()
        assertTrue(kept is SaveResult.KeptRemote)
        val both = r.saves.resolve(out.conflict, SaveKeep.BOTH, bytes(500)).result() as SaveResult.Done
        assertEquals("slot-1.copy", both.copyId)
        assertEquals(meta("mine"), world.rows.getValue("slot-1.copy").value)
        assertEquals(meta("two"), world.rows.getValue("slot-1").value)
        val local = r.saves.resolve(out.conflict, SaveKeep.LOCAL, bytes(500, 9)).result()
        assertTrue(local.toString(), local is SaveResult.Done)
        assertEquals(meta("mine"), world.rows.getValue("slot-1").value)
        eventually("a conflict event") { r.events.any { it is CloudSyncEvent.TransferDone && it.state == "conflict" } }
        r.client.close()
    }

    @Test
    fun aSaveIsDeletedAtItsVersion() = runBlocking {
        world.rows["slot-1"] = Row(meta("one"), 3, world.file(3, 5, "a".repeat(64)))
        world.version = 3
        val r = Rig()
        r.signIn()
        assertTrue(r.saves.delete("slot-1") is SaveSetResult.Ok)
        assertFalse(world.rows.containsKey("slot-1"))
        assertTrue(r.saves.list().isEmpty())
        val again = r.saves.delete("slot-1")
        assertTrue(again is SaveSetResult.Rejected)
        r.client.close()
    }

    @Test
    fun aRecordWithAFileAndNoValueIsListed() = runBlocking {
        world.rows["slot-9"] = Row(null, 4, world.file(4, 9, "b".repeat(64)))
        world.version = 4
        val r = Rig()
        r.signIn()
        val s = r.saves.list().single()
        assertEquals("slot-9", s.id)
        assertEquals(JsonObject(emptyMap()), s.metadata)
        assertEquals(9L, s.file?.size)
        r.client.close()
    }

    @Test
    fun cancelSettlesAWriteThatWaitsForItsMetadataOutcome() = runBlocking {
        val r = Rig()
        r.signIn()
        world.opsDown = true
        val t = r.saves.write("slot-1", bytes(100), meta("x"))
        eventually("the file is stored and the write waits") { world.rows["slot-1"]?.file != null && t.state == TransferState.RUNNING }
        delay(200)
        t.cancel()
        assertEquals(SaveResult.Cancelled, t.result())
        assertEquals(TransferState.CANCELLED, t.state)
        assertTrue(r.client.cloudSync.transfers().isEmpty())
        eventually("a cancelled event") { r.events.any { it is CloudSyncEvent.TransferDone && it.state == "cancelled" } }
        assertTrue(r.events.none { it is CloudSyncEvent.TransferFailed })
        r.client.close()
    }

    @Test
    fun aFileCodecStopsWithTheRing() = runBlocking {
        val r = Rig(seedRoot = true)
        val codec = r.client.keyring.fileCodec(SAVES_COLLECTION)
        val id = codec.chunkId(ByteArray(10))
        val sealed = codec.sealWhole(ByteArray(10))
        val opener = codec.newOpener()
        r.client.keyring.lock()
        fun locked(what: String, call: () -> Unit) {
            try {
                call()
                fail("$what still worked after the ring locked")
            } catch (e: PolarisException) {
                assertEquals(what, ErrorCode.syncLocked, e.code)
            }
        }
        locked("chunkId") { codec.chunkId(ByteArray(10)) }
        locked("sealChunk") { codec.sealChunk(id, ByteArray(10)) }
        locked("openChunk") { codec.openChunk(id, sealed) }
        locked("sealWhole") { codec.sealWhole(ByteArray(10)) }
        locked("sealManifest") { codec.sealManifest(ByteArray(10)) }
        locked("openManifest") { codec.openManifest(sealed) }
        locked("storedSize") { codec.storedSize(10) }
        locked("newOpener") { codec.newOpener() }
        locked("a piece of a stream") { opener.push(sealed) }
        locked("the end of a stream") { opener.finish() }
        locked("a new codec") { r.client.keyring.fileCodec(SAVES_COLLECTION) }
        r.client.close()
    }

    @Test
    fun theSaveTransfersGoBeforeThePinDoesAndTheRingIsLockedFirst() = runBlocking {
        val seen = CopyOnWriteArrayList<String>()
        lateinit var rig: Rig
        val roots = LoggedStorage(InMemoryDeviceKeyStorage()) {
            val journal = File(rig.dir, CLOUD_SYNC_TRANSFERS_DIR)
            seen += "pin:locked=${!rig.client.keyring.unlocked},journal=${journal.exists()},chunks=${File(rig.dir, CLOUD_SYNC_CHUNKS_DIR).exists()}"
        }
        rig = Rig(roots = roots, seedRoot = true)
        rig.signIn()
        assertTrue(rig.saves.write("slot-1", bytes(100), meta("x")).result() is SaveResult.Done)
        File(rig.dir, CLOUD_SYNC_CHUNKS_DIR).mkdirs()
        assertTrue("the journal is there before sign-out", File(rig.dir, CLOUD_SYNC_TRANSFERS_DIR).exists())
        rig.client.identity.signOut()
        assertEquals(listOf("pin:locked=true,journal=false,chunks=false"), seen.toList())
        assertFalse(File(rig.dir, CLOUD_SYNC_TRANSFERS_DIR).exists())
        assertFalse(File(rig.dir, CLOUD_SYNC_CHUNKS_DIR).exists())
        rig.client.close()
    }

    @Test
    fun aWriteThatWaitsIsDroppedWhenThePersonSignsOut() = runBlocking {
        val r = Rig()
        r.signIn()
        world.opsDown = true
        val t = r.saves.write("slot-1", bytes(100), meta("x"))
        eventually("the file is stored and the write waits") { world.rows["slot-1"]?.file != null }
        delay(200)
        r.client.identity.signOut()
        // Settled one way or the other, never as written: the waiting write was dropped and the transfer cancelled.
        val result = t.result()
        assertTrue(result.toString(), result is SaveResult.Failed || result == SaveResult.Cancelled)
        assertTrue(world.pushes.isEmpty())
        assertTrue(r.client.cloudSync.transfers().isEmpty())
        r.client.close()
    }

    @Test
    fun anEndToEndSaveIsSealedBlindedAndBoundAndReadsBackThroughTheMachine() = runBlocking {
        world = SavesWorld(e2e = true)
        val r = Rig(seedRoot = true, e2e = true)
        r.signIn()
        val data = bytes(2000)
        val done = r.saves.write("slot-1", data, meta("secret chapter")).result() as SaveResult.Done
        // The Worker saw a blinded record id, a sealed value and sealed bytes: no chapter, no plaintext, no `$file` in the clear.
        val wireId = world.rows.keys.single()
        assertTrue(wireId, wireId.startsWith("x:"))
        val row = world.rows.getValue(wireId)
        assertNull(row.value)
        assertNotNull(row.ct)
        assertFalse(world.pushes.joinToString().contains("secret chapter"))
        assertFalse(world.pushes.joinToString().contains(SAVE_FILE_BINDING_KEY))
        assertFalse(world.stored.getValue(done.file.version).contentEquals(data))
        assertTrue(world.files.all { it.isNotEmpty() })
        // List, read and delete go through the machine's rows, opened with the ring's root.
        val listed = r.saves.list().single()
        assertEquals("slot-1", listed.id)
        assertEquals(meta("secret chapter"), listed.metadata)
        assertEquals(done.file.sha256, listed.file?.sha256)
        assertArrayEquals(data, (r.saves.read("slot-1") as SaveRead.Ok).bytes)
        assertTrue(r.saves.delete("slot-1") is SaveSetResult.Ok)
        assertTrue(world.rows.isEmpty())
        assertTrue(r.saves.list().isEmpty())
        r.client.close()
    }

    @Test
    fun aProductWithoutASavesCollectionGetsTheTypedNotApplicable() = runBlocking {
        val bare = Json.parseToJsonElement("""{"schemaVersion":1,"entries":[]}""") as JsonObject
        val dir = tmp.newFolder()
        val store = FileStore("djdl", dir)
        store.setToken("pkeyt_alice")
        val client = PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl",
                    baseUrl = "https://key.example",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = store,
                    transport = ScriptedTransport(::handle),
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.identity, ServiceSlug.sync),
                ),
                license = LicenseClientOptions(fingerprint = false),
                cloudSync = CloudSyncHostOptions().also {
                    it.encryption = "server"
                    it.catalog = bare
                },
            ),
        )
        client.identity.subject()
        eventually("signed in") { client.cloudSync.status().state != SyncState.Local }
        try {
            client.cloudSync.saves.list()
            fail("a product with no saves collection listed saves")
        } catch (e: PolarisException) {
            assertNotNull(e.unsupported)
            assertEquals("sync.saves", e.unsupported!!.feature)
        }
        assertNull(null)
        client.close()
    }
}
