// @pkey-feature core.cache
//
// The verified cache (§4.1) and the clock floor (§4.2) over a real store: a record holds signed
// artifacts only and every counter is DERIVED by re-verifying it on load; a record of another
// version is discarded; a planted (unverifiable) document is dropped; the FileStore keeps its files
// at 0600 in a 0700 directory and round-trips the record. The artifacts are the corpus's
// clock-floor vectors, so nothing here is signed by the test.

package im.plrs.key.core

import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CacheTest {
    private val cases = (JsonText.parse(File(System.getProperty("pkey.repoRoot"), "conformance/corpus/v2/cases.json").readText()) as JsonObject)

    private fun floorCase(id: String): JsonObject =
        cases["clockFloorCases"]!!.arrayValue!!.map { it as JsonObject }.first { it["id"].stringValue == id }

    private fun core(store: Store, c: JsonObject, now: Long) = CoreContext(
        CoreOptions(
            productSlug = c["expectedAud"].stringValue!!, version = "1.0.0",
            pinnedKeys = c["pinned"]!!.objectValue!!.mapValues { it.value.stringValue!! },
            store = store, transport = NoNetworkTransport, clock = { now },
        ),
    )

    private suspend fun reloaded(id: String): Pair<JsonObject, CoreContext> {
        val c = floorCase(id)
        val store = InMemoryStore(c["expectedAud"].stringValue!!, c["deviceId"].stringValue!!)
        store.setToken("pkeyt_test")
        store.writeCache(
            CacheRecord(
                trustJws = c["trustJws"].stringValue,
                docs = buildMap {
                    c["licenseJws"].stringValue?.let { put(DocumentSlice.license, it) }
                    c["configJws"].stringValue?.let { put(DocumentSlice.config, it) }
                },
            ),
        )
        val core = core(store, c, c["systemClock"].longValue!!)
        core.start()
        return c to core
    }

    @Test
    fun theReloadPathDerivesTheFloorFromWhatVerifies() = runBlocking {
        for (id in listOf("floor-trust-manifest-defeats-rollback", "floor-rejected-manifest-does-not-raise-it", "floor-honest-clock-is-never-lowered")) {
            val (c, core) = reloaded(id)
            val expect = c["expect"]!!.objectValue!!
            assertEquals(id, expect["highWaterMark"].longValue, core.highWaterMark())
            assertEquals(id, expect["effectiveNow"].longValue, core.now())
            assertEquals(id, expect["status"].stringValue, core.licenseStatus().status.wire)
        }
    }

    /**
     * The client's reload path also bounds how far ONE cached artifact may drag the floor: a
     * document stamped more than MAX_GRACE_SECONDS ahead of the current floor is dropped (Swift's
     * `verifyCached` does the same). In this vector the config document sits 392 days past the
     * manifest, so the client keeps the manifest's floor and the licence is in grace.
     */
    @Test
    fun oneArtifactCannotDragTheFloorPastTheGraceCeiling() = runBlocking {
        val (c, core) = reloaded("floor-max-over-three-artifacts")
        assertNull(core.cache().config)
        assertNotNull(core.cache().license)
        assertEquals(1700604800L, core.highWaterMark())
        assertEquals(LicenseStatus.grace, core.licenseStatus().status)
        assertNotNull(core.trustManifest())
        assertTrue(c["expect"]!!.objectValue!!["highWaterMark"].longValue!! > core.highWaterMark())
    }

    @Test
    fun aRecordOfAnotherVersionIsDiscarded() = runBlocking {
        val c = floorCase("floor-max-over-three-artifacts")
        val store = InMemoryStore("djdl", c["deviceId"].stringValue!!)
        store.writeCache(CacheRecord(trustJws = c["trustJws"].stringValue, v = 2))
        val core = core(store, c, c["systemClock"].longValue!!)
        core.start()
        assertEquals(0L, core.highWaterMark())
        assertNull(core.trustManifest())
    }

    @Test
    fun aPlantedDocumentIsDroppedNotTrusted() = runBlocking {
        val c = floorCase("floor-max-over-three-artifacts")
        val store = InMemoryStore("djdl", c["deviceId"].stringValue!!)
        val license = c["licenseJws"].stringValue!!
        val parts = license.split('.')
        val forged = parts[0] + "." + parts[1] + "." + parts[2].reversed()
        store.writeCache(CacheRecord(docs = mapOf(DocumentSlice.license to forged), etags = mapOf(DocumentSlice.license to "\"x\"")))
        val core = core(store, c, c["systemClock"].longValue!!)
        core.start()
        assertNull(core.cache().license)
        assertEquals(0L, core.highWaterMark())
        assertNull(core.etag(DocumentSlice.license))
    }

    @Test
    fun theRecordRoundTripsThroughJson() {
        val record = CacheRecord(
            trustJws = "a.b.c",
            docs = mapOf(DocumentSlice.license to "l.l.l", DocumentSlice.config to "c.c.c"),
            etags = mapOf(DocumentSlice.config to "\"e\""),
            importedBundle = ImportedBundle("01J", 1700000000),
            lastSyncUnauthorized = true,
            blocked = BlockInfoRecord(BlockReason.versionTooOld, AllowedRange(min = "2.0.0")),
            feeds = mapOf("stable" to "f.f.f"),
            releaseRecords = mapOf("ab" to "r.r.r"),
        )
        assertEquals(record, CacheRecord.fromJson(JsonText.parse(record.toJson().toString())))
        assertTrue(record.toJson().toString().contains("\"docs\":{\"license\":\"l.l.l\""))
    }

    @Test
    fun theFileStoreKeepsItsFilesPrivate() = runBlocking {
        val dir = File(Files.createTempDirectory("pkey-store").toFile(), "djdl")
        val store = FileStore("djdl", dir)
        assertNull(store.getToken())
        assertNull(store.readCache())
        store.setToken("pkeyt_abc")
        val id = store.getDeviceId()
        assertEquals(32, id.length)
        assertEquals(id, FileStore("djdl", dir).getDeviceId())
        store.writeCache(CacheRecord(trustJws = "a.b.c"))
        assertEquals("a.b.c", FileStore("djdl", dir).readCache()?.trustJws)
        assertEquals("pkeyt_abc", FileStore("djdl", dir).getToken())
        if (!System.getProperty("os.name").startsWith("Windows")) {
            assertEquals(setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE), Files.getPosixFilePermissions(dir.toPath()))
            for (name in listOf("token", "device-id", "cache.json")) {
                assertEquals(name, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE), Files.getPosixFilePermissions(File(dir, name).toPath()))
            }
        }
        assertEquals(StoreBackend.file, store.status().backend)
        assertEquals(StoreDegradedReason.keyringUnavailable, store.status().degraded?.reason)
        store.clearToken()
        store.clearCache()
        assertNull(store.getToken())
        assertNull(store.readCache())
        // An unparseable cache file is "no cache", never an error.
        File(dir, "cache.json").writeText("{not json")
        assertNull(store.readCache())
    }
}
