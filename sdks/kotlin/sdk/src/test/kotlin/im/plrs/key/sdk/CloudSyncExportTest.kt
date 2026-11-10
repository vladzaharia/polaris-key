// @pkey-feature sync.export
//
// `client.cloudSync.export()` on a real client against a scripted Worker (server mode, whole files): the archive of a person's
// synced data read back with `java.util.zip.ZipFile`, the destination rules of WIRE-CONTRACT-V5 section 13.12 (an exclusive
// owner-only partial, a planted link refused, a stale partial removed, the old destination surviving every failure and cancel),
// cancellation, and the stream overload the SDK never closes. The corpus rows run in :conformance (SyncVectorsTest).

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.sync.SyncExportException
import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.util.zip.ZipFile

private const val ALICE = "ps_AliceAliceAliceAlice1"

private val mirror: JsonObject = Json.parseToJsonElement(
    """{"schemaVersion":1,"entries":[{"key":"audio.volume","kind":"config","schema":{"type":"number"},"user":{"sync":"user","conflict":"lastWrite"}}],
      "cloudSync":{"encryption":"server","collections":[{"name":"saves","template":"saves","files":{"delta":false}}]}}""",
) as JsonObject

private fun sha(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

private fun bytes(n: Int, seed: Int = 7) = ByteArray(n) { (it * 31 + seed).toByte() }

/** The Worker's saves in server mode: rows with a pointer, the stored files, and what an export asked for. */
private class World {
    val rows = LinkedHashMap<String, JsonObject>()
    val stored = HashMap<Pair<String, Long>, ByteArray>()
    val asked = java.util.concurrent.CopyOnWriteArrayList<String>()

    @Volatile var pullStatus = 200

    @Volatile var syncEnabled = true

    @Volatile var ranges = 0

    fun addSave(id: String, version: Long, data: ByteArray, chapter: String) {
        stored[id to version] = data
        rows[id] = buildJsonObject {
            put("record", JsonArray(listOf(JsonPrimitive("saves"), JsonPrimitive(id))))
            put("version", version)
            put("value", buildJsonObject { put("chapter", chapter) })
            put(
                "file",
                buildJsonObject {
                    put("version", version)
                    put("size", data.size)
                    put("sha256", sha(data))
                    put("format", "whole")
                },
            )
        }
    }

    fun pointer(id: String, version: Long): JsonObject {
        val data = stored.getValue(id to version)
        return buildJsonObject {
            put("version", version)
            put("size", data.size)
            put("sha256", sha(data))
            put("format", "whole")
        }
    }

    fun body(): JsonObject = JsonObject(
        mapOf(
            "encryption" to JsonPrimitive("server"),
            "subject" to JsonPrimitive(ALICE),
            "cursor" to JsonPrimitive(10),
            "more" to JsonPrimitive(false),
            "serverNow" to JsonPrimitive(System.currentTimeMillis()),
            "catalogVersion" to JsonPrimitive(1),
            "lastMutationId" to JsonPrimitive(0),
            "changes" to JsonArray(
                listOf(
                    buildJsonObject {
                        put("setting", "audio.volume")
                        put("value", 0.5)
                        put("version", 3)
                    },
                ) + rows.values,
            ),
            "tombstones" to JsonArray(emptyList()),
            "aliases" to JsonObject(emptyMap()),
            "usage" to Json.parseToJsonElement("""{"bytes":0,"settings":0,"records":0,"files":0}"""),
            "quota" to Json.parseToJsonElement("""{"bytes":268435456,"files":true}"""),
        ),
    )
}

/** A stream that records what the SDK did to it. */
private class Probe(private val failAfter: Int = Int.MAX_VALUE) : OutputStream() {
    val out = ByteArrayOutputStream()
    var closed = false
    var flushed = 0

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(b: ByteArray, off: Int, len: Int) {
        if (out.size() + len > failAfter) throw IOException("No space left on device")
        out.write(b, off, len)
    }

    override fun flush() {
        flushed++
    }

    override fun close() {
        closed = true
    }
}

class CloudSyncExportTest {
    @get:Rule val tmp = TemporaryFolder()

    private val signer = TestSigner()
    private val world = World()

    private fun handle(r: PolarisRequest): PolarisResponse {
        val path = r.path
        val prefix = "/djdl/sync/files/saves/"
        return when {
            path.endsWith("/.well-known/polaris.json") -> respond(
                200,
                """{"product":"djdl","services":{"license":{"enabled":true},"config":{"enabled":true},""" +
                    """"sync":{"enabled":${world.syncEnabled},"encryption":"server"},""" +
                    """"identity":{"enabled":true,"account":true,"issuer":"https://key.example/djdl/identity",""" +
                    """"endpoints":{"subject":"https://key.example/djdl/identity/subject",""" +
                    """"signout":"https://key.example/djdl/identity/signout"}}}}""",
            )

            path.endsWith("/identity/subject") -> respond(200, """{"subject":"$ALICE"}""")

            path.startsWith(prefix) -> files(r, path.removePrefix(prefix))

            path.contains("/sync") && world.pullStatus != 200 -> respond(world.pullStatus, """{"error":{"code":"account_required"}}""")

            path.contains("/sync") -> respond(200, world.body().toString())

            else -> respond(404, """{"error":{"code":"not_found"}}""")
        }
    }

    private fun files(r: PolarisRequest, rest: String): PolarisResponse {
        val parts = rest.split("/")
        val id = parts[0]
        world.asked += "${r.method} ${parts.drop(1).joinToString("/").ifEmpty { "-" }}"
        val version = r.url.substringAfter("version=", "").toLongOrNull()
        return when {
            parts.drop(1) == listOf("revisions") -> respond(
                200,
                buildJsonObject {
                    put(
                        "revisions",
                        JsonArray(
                            world.stored.keys.filter {
                                it.first == id
                            }.map { it.second }.sortedDescending().map { world.pointer(id, it) },
                        ),
                    )
                }.toString(),
            )

            version != null -> ranged(r, world.stored[id to version])

            else -> respond(404, """{"error":{"code":"not_found"}}""")
        }
    }

    private fun ranged(r: PolarisRequest, data: ByteArray?): PolarisResponse {
        val range = r.headers.entries.firstOrNull { it.key.equals("range", true) }?.value
        val m = Regex("bytes=(\\d+)-(\\d+)").matchEntire(range ?: "")
        return when {
            data == null -> respond(404, """{"error":{"code":"not_found"}}""")

            m == null -> PolarisResponse(200, data, mapOf("etag" to "\"e\""))

            else -> {
                world.ranges++
                val start = m.groupValues[1].toInt()
                val end = minOf(m.groupValues[2].toInt(), data.size - 1)
                val headers = mapOf("etag" to "\"e\"", "content-range" to "bytes $start-$end/${data.size}")
                PolarisResponse(206, data.copyOfRange(start, end + 1), headers)
            }
        }
    }

    private fun client(): PolarisKeyClient = runBlocking {
        val dir = tmp.newFolder()
        val store = FileStore("djdl", dir)
        store.setToken("pkeyt_alice")
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl",
                    baseUrl = "https://key.example",
                    version = "1.0.0",
                    pinnedKeys = signer.trust,
                    trustRefresh = false,
                    store = store,
                    transport = ScriptedTransport(::handle),
                    clock = { 1_700_000_000L },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.config, ServiceSlug.identity, ServiceSlug.sync),
                ),
                license = LicenseClientOptions(fingerprint = false),
                keyring = KeyringOptions(keys = null, rootStorage = InMemoryDeviceKeyStorage()),
                cloudSync = CloudSyncHostOptions().also {
                    it.encryption = "server"
                    it.catalog = mirror
                },
            ),
        )
    }

    private suspend fun signedIn(): PolarisKeyClient {
        val c = client()
        c.identity.subject()
        withTimeout(8_000) { while (c.cloudSync.status().state == SyncState.Local) delay(20) }
        c.cloudSync.flush()
        return c
    }

    private fun entries(archive: ByteArray): Map<String, ByteArray> {
        val file = Files.createTempFile(tmp.root.toPath(), "read-", ".zip")
        Files.write(file, archive)
        return ZipFile(file.toFile()).use { z -> z.entries().toList().associate { it.name to z.getInputStream(it).use { s -> s.readBytes() } } }
    }

    private val dir get() = tmp.root.toPath()

    private fun assertNoPartial(dest: Path) =
        assertFalse(Files.exists(dest.resolveSibling(dest.fileName.toString() + ".partial"), java.nio.file.LinkOption.NOFOLLOW_LINKS))

    private fun reason(e: PolarisException) = (e as SyncExportException).reason

    @Test
    fun aPathExportWritesAReadableZipAndTheRenameIsTheLastStep() = runBlocking {
        val data = bytes(3000)
        world.addSave("slot-1", 1, data, "one")
        world.addSave("slot-2", 2, bytes(10), "two")
        val c = signedIn()
        val dest = dir.resolve("export.zip")
        val result = c.cloudSync.export(dest)
        val z = entries(Files.readAllBytes(dest))
        assertEquals(
            listOf(
                "README.txt",
                "data.json",
                "stores/sync.cloudSync/files.json",
                "stores/sync.cloudSync/files/0.bin",
                "stores/sync.cloudSync/files/1.bin",
                "stores/sync.cloudSync/index.json",
                "stores/sync.cloudSync/records/0.ndjson",
                "stores/sync.cloudSync/settings.json",
            ),
            z.keys.sorted(),
        )
        assertArrayEquals(data, z.getValue("stores/sync.cloudSync/files/0.bin"))
        assertEquals("{\"audio.volume\":0.5}\n", String(z.getValue("stores/sync.cloudSync/settings.json")))
        val lines = String(z.getValue("stores/sync.cloudSync/records/0.ndjson")).trim().lines()
        assertEquals(2, lines.size)
        assertTrue(
            lines[0],
            lines[0].contains("\"file\":{\"entry\":\"stores/sync.cloudSync/files/0.bin\",\"sha256\":\"${sha(data)}\",\"size\":3000,\"version\":1}"),
        )
        assertEquals(dest, result.path)
        assertEquals(Files.size(dest), result.bytes)
        assertEquals(1, result.settings)
        assertEquals(2, result.records)
        assertEquals(2, result.files)
        assertEquals(0, result.unsynced)
        assertTrue(result.skipped.isEmpty())
        assertNoPartial(dest)
        assertTrue("a ranged read of the stored bytes", world.ranges >= 2)
        c.close()
    }

    @Test
    fun thePartialIsOwnerOnlyFromItsCreation() = runBlocking {
        assumeTrue(Files.getFileStore(dir).supportsFileAttributeView("posix"))
        world.addSave("slot-1", 1, bytes(100), "one")
        val c = signedIn()
        val dest = dir.resolve("mode.zip")
        val seen = ArrayList<String>()
        c.cloudSync.export(
            dest,
            CloudSyncExportOptions(
                onProgress = {
                    val partial = dir.resolve("mode.zip.partial")
                    if (Files.exists(partial)) seen += PosixFilePermissions.toString(Files.getPosixFilePermissions(partial))
                },
            ),
        )
        assertTrue(seen.isNotEmpty())
        assertEquals(setOf("rw-------"), seen.toSet())
        c.close()
    }

    @Test
    fun aStaleRegularPartialIsRemovedAndReplaced() = runBlocking {
        world.addSave("slot-1", 1, bytes(100), "one")
        val c = signedIn()
        val dest = dir.resolve("stale.zip")
        Files.write(dir.resolve("stale.zip.partial"), "left by a crash".toByteArray())
        c.cloudSync.export(dest)
        assertTrue(entries(Files.readAllBytes(dest)).containsKey("data.json"))
        assertNoPartial(dest)
        c.close()
    }

    @Test
    fun aPlantedLinkAtThePartialIsRefusedAndItsTargetIsUntouched() = runBlocking {
        assumeTrue(Files.getFileStore(dir).supportsFileAttributeView("posix"))
        world.addSave("slot-1", 1, bytes(100), "one")
        val c = signedIn()
        val target = dir.resolve("victim.txt")
        Files.write(target, "keep me".toByteArray())
        val dest = dir.resolve("linked.zip")
        Files.createSymbolicLink(dir.resolve("linked.zip.partial"), target)
        try {
            c.cloudSync.export(dest)
            fail("a link at the partial must be refused")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.syncExportFailed, e.code)
            assertEquals("destination", reason(e))
        }
        assertEquals("keep me", String(Files.readAllBytes(target)))
        assertTrue(Files.isSymbolicLink(dir.resolve("linked.zip.partial")))
        assertFalse(Files.exists(dest))
        c.close()
    }

    @Test
    fun aDirectoryOrALinkAsTheDestinationIsRefused() = runBlocking {
        assumeTrue(Files.getFileStore(dir).supportsFileAttributeView("posix"))
        world.addSave("slot-1", 1, bytes(100), "one")
        val c = signedIn()
        val folder = Files.createDirectory(dir.resolve("folder"))
        val real = Files.write(dir.resolve("real.txt"), "x".toByteArray())
        val link = Files.createSymbolicLink(dir.resolve("link.zip"), real)
        for (bad in listOf(folder, link)) {
            try {
                c.cloudSync.export(bad)
                fail("a non-regular destination must be refused")
            } catch (e: PolarisException) {
                assertEquals("destination", reason(e))
            }
        }
        assertEquals("x", String(Files.readAllBytes(real)))
        c.close()
    }

    @Test
    fun aMissingParentDirectoryIsADestinationFailure() = runBlocking {
        world.addSave("slot-1", 1, bytes(100), "one")
        val c = signedIn()
        try {
            c.cloudSync.export(dir.resolve("no-such-dir").resolve("x.zip"))
            fail("the parent does not exist")
        } catch (e: PolarisException) {
            assertEquals("destination", reason(e))
        }
        c.close()
    }

    @Test
    fun aCancelRemovesThePartialAndLeavesTheOldDestinationAsItWas() = runBlocking {
        world.addSave("slot-1", 1, bytes(300_000), "one")
        val c = signedIn()
        val dest = Files.write(dir.resolve("old.zip"), "the old export".toByteArray())
        lateinit var job: kotlinx.coroutines.Deferred<CloudSyncExport>
        val started = java.util.concurrent.atomic.AtomicBoolean(false)
        job = async(Dispatchers.Default) {
            c.cloudSync.export(
                dest,
                CloudSyncExportOptions(
                    onProgress = {
                        // The first bytes of the file are written: cancel from inside the export.
                        if (started.compareAndSet(false, true)) job.cancel()
                    },
                ),
            )
        }
        try {
            job.await()
            fail("the export was cancelled")
        } catch (e: CancellationException) {
            assertNotNull(e)
        }
        assertTrue(started.get())
        assertEquals("the old export", String(Files.readAllBytes(dest)))
        assertNoPartial(dest)
        // And the client is free for the next export.
        c.cloudSync.export(dest)
        assertTrue(entries(Files.readAllBytes(dest)).containsKey("data.json"))
        c.close()
    }

    @Test
    fun aRefusedPullLeavesTheOldDestinationAndNoPartial() = runBlocking {
        val c = signedIn()
        val dest = Files.write(dir.resolve("kept.zip"), "the old export".toByteArray())
        world.pullStatus = 403
        try {
            c.cloudSync.export(dest)
            fail("account_required")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.accountRequired, e.code)
        }
        assertEquals("the old export", String(Files.readAllBytes(dest)))
        assertNoPartial(dest)
        c.close()
    }

    @Test
    fun aFullDiskIsADestinationFailureThatCleansUpAndKeepsTheOldFile() {
        val dest = Files.write(dir.resolve("full.zip"), "the old export".toByteArray())
        var writes = 0
        val file = PartialFile(dest) { ch, b ->
            if (++writes == 3) throw IOException("No space left on device")
            while (b.hasRemaining()) ch.write(b)
        }
        file.prepare()
        try {
            repeat(5) { file.write(bytes(100), 0, 100) }
            fail("the third write fails")
        } catch (e: SyncExportException) {
            assertEquals("destination", e.reason)
            assertFalse(e.message!!.contains(dir.toString()))
        }
        file.discard()
        assertEquals("the old export", String(Files.readAllBytes(dest)))
        assertNoPartial(dest)
    }

    @Test
    fun aStreamFailureIsADestinationFailureAndTheStreamIsNeverClosed() = runBlocking {
        world.addSave("slot-1", 1, bytes(3000), "one")
        val c = signedIn()
        val probe = Probe(failAfter = 200)
        try {
            c.cloudSync.export(probe)
            fail("the stream is full")
        } catch (e: PolarisException) {
            assertEquals("destination", reason(e))
        }
        assertFalse(probe.closed)
        c.close()
    }

    @Test
    fun aStreamExportIsWrittenAndFlushedAndNeverClosedByTheSdk() = runBlocking {
        world.addSave("slot-1", 1, bytes(3000), "one")
        val c = signedIn()
        val probe = Probe()
        val result = c.cloudSync.export(probe)
        assertFalse("the SDK must not close the app's stream", probe.closed)
        assertTrue(probe.flushed >= 1)
        assertEquals(null, result.path)
        assertEquals(probe.out.size().toLong(), result.bytes)
        assertTrue(entries(probe.out.toByteArray()).containsKey("data.json"))
        c.close()
    }

    @Test
    fun aCancelledStreamExportDoesNotCloseTheStreamEither() = runBlocking {
        world.addSave("slot-1", 1, bytes(300_000), "one")
        val c = signedIn()
        val probe = Probe()
        lateinit var job: kotlinx.coroutines.Deferred<CloudSyncExport>
        job = async(Dispatchers.Default) { c.cloudSync.export(probe, CloudSyncExportOptions(onProgress = { job.cancel() })) }
        try {
            job.await()
            fail("the export was cancelled")
        } catch (e: CancellationException) {
            assertNotNull(e)
        }
        assertFalse(probe.closed)
        c.close()
    }

    @Test
    fun revisionsAreWrittenOnRequestAndMarkedNotLive() = runBlocking {
        world.addSave("slot-1", 2, bytes(500, 1), "one")
        world.stored["slot-1" to 1L] = bytes(400, 9)
        val c = signedIn()
        val dest = dir.resolve("rev.zip")
        val result = c.cloudSync.export(dest, CloudSyncExportOptions(includeRevisions = true))
        assertEquals(2, result.files)
        val files = String(entries(Files.readAllBytes(dest)).getValue("stores/sync.cloudSync/files.json"))
        assertTrue(files, files.contains("\"live\":false"))
        assertTrue(files, files.contains("\"live\":true"))
        c.close()
    }

    @Test
    fun anExportWhileSignedOutIsAccountRequired() = runBlocking {
        val c = client()
        try {
            c.cloudSync.export(dir.resolve("none.zip"))
            fail("no person is signed in")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.accountRequired, e.code)
        }
        assertFalse(Files.exists(dir.resolve("none.zip")))
        c.close()
    }

    @Test
    fun aSecondExportWhileOneRunsIsBusy() = runBlocking {
        val c = signedIn()
        val gate = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        val exporter = CloudSyncExporter(
            c.core,
            startedHost = {
                entered.complete(Unit)
                gate.await()
                null
            },
            flush = { error("not reached") },
            fileCodec = { _, _ -> ServerFileCodec() },
        )
        val first = async(Dispatchers.Default) { runCatching { exporter.export(StreamDestination(Probe()), null, CloudSyncExportOptions()) } }
        entered.await()
        try {
            exporter.export(StreamDestination(Probe()), null, CloudSyncExportOptions())
            fail("one export per client runs at a time")
        } catch (e: PolarisException) {
            assertEquals("busy", reason(e))
        }
        gate.complete(Unit)
        // The first fails (no host was started) and frees the client for the next export.
        assertTrue(first.await().isFailure)
        assertTrue(c.cloudSync.export(Probe()).entries > 0)
        c.close()
    }

    @Test
    fun aProductWithoutTheSyncServiceGetsTheTypedNotApplicable() = runBlocking {
        world.syncEnabled = false
        val c = client()
        c.discover()
        val dest = dir.resolve("na.zip")
        try {
            c.cloudSync.export(dest)
            fail("the product runs no Sync service")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
            assertEquals("sync.export", e.unsupported?.feature)
        }
        assertFalse(Files.exists(dest))
        c.close()
    }
}
