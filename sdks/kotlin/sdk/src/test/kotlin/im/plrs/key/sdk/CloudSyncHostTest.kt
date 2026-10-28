// @pkey-feature sync.settings
//
// The Cloud Sync host (U-07.K6): H-1 and H-2 (the catalog), H-3 and H-4 (the transport), H-5 (open
// keys), H-6 (the state file), H-10 (the codec drops) and HOST-BIND, over a scripted exchange and a
// fixture root. The machine's own behaviour is pinned by the corpus (:conformance, SyncScenarios).

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.MachineStateJson
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.sync.SyncResponse
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

private val ROOT = ByteArray(32) { (3 * it + 7).toByte() }

private fun j(s: String): JsonObject = Json.parseToJsonElement(s) as JsonObject

private class Fixture(private val root: ByteArray = ROOT) : SyncCodecPort {
    var isLocked = false
    override val locked: Boolean get() = isLocked

    override fun seal(collection: String, name: String, value: JsonElement) = SyncEnvelope.seal(root, collection, name, value)

    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(root, collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(root, collection, envelope)

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String) = SyncBlind.blind(root, kind, ctx, name)
}

class CloudSyncHostTest {
    @get:Rule val tmp = TemporaryFolder()

    private val mirror = j("""{"schemaVersion":1,"entries":[{"key":"audio.volume","kind":"config","schema":{"type":"number"}}]}""")

    /** A host over a scripted exchange; [answer] sees every request the machine sent. */
    private inner class Rig(encryption: String = "server", catalog: JsonObject? = mirror, dir: File = tmp.newFolder()) {
        val sent = mutableListOf<JsonObject>()
        var answer: (JsonObject) -> SyncResponse = { SyncResponse(200, j("""{"cursor":1,"serverNow":1760000000000}""")) }
        var now = 1_760_000_000_000L
        val codec = Fixture()
        var unlocked = false
        var subject: String? = null
        var schema: JsonObject? = null
        var schemaFetches = 0
        val deps = CloudSyncHostDeps("demo", dir, { r ->
            sent += r
            answer(r)
        }, codec, { j("""{"values":{}}""") }).also {
            it.clock = { now }
            it.keyringUnlocked = { unlocked }
            it.subject = { subject }
            it.fetchSchema = {
                schemaFetches++
                schema
            }
        }
        val opts = CloudSyncHostOptions().also {
            it.encryption = encryption
            it.catalog = catalog
        }
        val host = CloudSyncHost(deps, opts)

        /** Starts the host (a signed-out machine sends nothing), then signs in; the caller touches. */
        fun signIn(who: String) = runBlocking {
            host.start()
            host.withMachine { it.signIn(who) }
        }
    }

    // ── H-3, H-4: the transport ───────────────────────────────────────────────────────────────

    private fun core(
        handler: (im.plrs.key.core.PolarisRequest) -> PolarisResponse,
        withToken: Boolean = true,
    ): Pair<ScriptedTransport, im.plrs.key.core.CoreContext> {
        val transport = ScriptedTransport(handler)
        val store = FileStore("djdl", tmp.newFolder())
        if (withToken) runBlocking { store.setToken("pkeyt_L7Z_jTR0YsyzhMxHLBdEwKZ4yW2Uu4m6CANM1oHQiUA") }
        val client = runBlocking {
            PolarisKeyClient.create(
                PolarisKeyClientOptions(
                    core = CoreOptions(
                        productSlug = "djdl",
                        version = "1.0.0",
                        pinnedKeys = TestSigner().trust,
                        trustRefresh = false,
                        store = store,
                        transport = transport,
                        clock = { 1_700_000_000L },
                    ),
                    license = LicenseClientOptions(fingerprint = false),
                    connect = ConnectOptions(deviceKeys = null, state = InMemoryDeviceKeyStorage()),
                ),
            )
        }
        return transport to client.core
    }

    private val pull = j("""{"method":"GET","path":"/djdl/sync?cursor=0&clientId=c_x"}""")

    @Test
    fun h3h4TransportNeverFollowsReadsUnderACapAndHasADeadline() = runBlocking {
        val (transport, core) = core({ respond(200, """{"cursor":0}""") })
        val res = CloudSyncTransport.send(core, pull)
        assertEquals(200, res.status)
        val r = transport.requests().single()
        assertFalse(r.followRedirects)
        assertEquals(15.0, r.timeoutSeconds, 0.0)
        assertEquals(SYNC_MAX_RESPONSE_BYTES + 1, r.maxBodyBytes)
        assertTrue(r.headers.any { it.key.equals("authorization", true) && it.value.startsWith("Bearer ") })
    }

    @Test
    fun h3AnOverCapBodyIsNoAnswerAndA3xxIsAnAnswerNotFollowed() {
        assertTrue(CloudSyncTransport.answer(200, ByteArray(SYNC_MAX_RESPONSE_BYTES + 1)).transportError)
        val redirect = CloudSyncTransport.answer(302, ByteArray(0))
        assertEquals(302, redirect.status)
        assertFalse(redirect.transportError)
        // A 2xx the machine cannot read is not an answer; an error page keeps its status.
        assertTrue(CloudSyncTransport.answer(200, "<html>".toByteArray()).transportError)
        assertEquals(502, CloudSyncTransport.answer(502, "<html>".toByteArray()).status)
    }

    @Test
    fun h3SendsNothingForAPathOutsideSyncOrWithoutAToken() = runBlocking {
        val (transport, core) = core({ respond(200, "{}") })
        for (p in listOf("/other/sync?cursor=0", "/djdl/license/document", "/djdl/sync/../x", "/djdl/sync?cursor=0&x=a b")) {
            assertTrue(p, CloudSyncTransport.send(core, j("""{"method":"GET","path":"$p"}""")).transportError)
        }
        assertTrue(transport.requests().isEmpty())
        val (t2, noToken) = core({ respond(200, "{}") }, withToken = false)
        assertTrue(CloudSyncTransport.send(noToken, pull).transportError)
        assertTrue(t2.requests().isEmpty())
    }

    // ── H-6: the state file ───────────────────────────────────────────────────────────────────

    private val persisted = MachineStateJson.encode(
        CloudSyncMachine(
            im.plrs.key.core.sync.CloudSyncOptions("demo", j("""{"settings":[]}"""), j("""{"values":{}}"""), 1L) {
                "c_000000000000000client1"
            }.also {
                it.contacted =
                    true
            },
        ).persist(),
    )

    @Test
    fun h6StateFileIsOwnerOnlyAtomicAndRoundTripsTheJournal() {
        val dir = tmp.newFolder()
        val f = CloudSyncStateFile(dir, "demo")
        f.save(persisted, mirror, listOf("a", "b"))
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(f.file.toPath())))
        assertEquals(listOf(CLOUD_SYNC_FILE), dir.list()!!.toList())
        val back = f.load()
        assertNotNull(MachineStateJson.decode(back.persisted))
        assertEquals(mirror, back.catalog)
        assertEquals(listOf("a", "b"), back.openKeys)
        f.remove()
        assertFalse(f.file.exists())
    }

    @Test
    fun h6AnotherProductsOrACorruptOrASymlinkedFileIsEmpty() {
        val dir = tmp.newFolder()
        CloudSyncStateFile(dir, "other").save(persisted, null, emptyList())
        assertNull(CloudSyncStateFile(dir, "demo").load().persisted)
        File(dir, CLOUD_SYNC_FILE).writeText("{not json")
        assertNull(CloudSyncStateFile(dir, "demo").load().persisted)
        assertNull(MachineStateJson.decode(j("""{"partitions":{},"hlc":[0,0]}""")))
    }

    @Test
    fun h6APlantedSymlinkIsNeverWrittenThrough() {
        val dir = tmp.newFolder()
        val victim = File(tmp.newFolder(), "victim.txt").also { it.writeText("keep") }
        Files.createSymbolicLink(File(dir, CLOUD_SYNC_FILE).toPath(), victim.toPath())
        assertNull(CloudSyncStateFile(dir, "demo").load().persisted)
        CloudSyncStateFile(dir, "demo").save(persisted, null, emptyList())
        assertEquals("keep", victim.readText())
        assertFalse(Files.isSymbolicLink(File(dir, CLOUD_SYNC_FILE).toPath()))
        assertNotNull(CloudSyncStateFile(dir, "demo").load().persisted)
    }

    // ── H-1, H-2: the catalog ─────────────────────────────────────────────────────────────────

    @Test
    fun h1TheMirrorIsAuthoritativeAndAServedCatalogOnlyAddsKeys() {
        val served = j(
            """{"schemaVersion":2,"cloudSync":{"encryption":"server"},"entries":[
              {"key":"audio.volume","kind":"config","managementDefault":"enforced"},
              {"key":"new.key","kind":"config"},{"key":"open.key","kind":"config"}]}""",
        )
        val eff = CloudSyncCatalog.effective(mirror, CloudSyncCatalog.vetted(served), setOf("open.key"))
        val routes = CloudSyncCatalog.routesOf(eff)
        assertEquals(listOf("audio.volume", "new.key"), routes.map { (it["key"] as JsonPrimitive).content })
        assertEquals("synced", (routes[0]["route"] as JsonPrimitive).content)
        assertTrue(routes.none { it.containsKey("encryption") })
    }

    @Test
    fun h1VettingDropsBadKeysDuplicatesAndOversizedCatalogs() {
        val v = CloudSyncCatalog.vetted(
            j(
                """{"schemaVersion":1,"entries":[{"key":"ok.k","kind":"config"},{"key":"ok.k","kind":"config"},""" +
                    """{"key":"bad key!","kind":"config"},{"nokey":1}]}""",
            ),
        )!!
        assertEquals(1, (v["entries"] as kotlinx.serialization.json.JsonArray).size)
        assertNull(CloudSyncCatalog.vetted(j("""{"schemaVersion":1}""")))
        val many = (0..MAX_CATALOG_ENTRIES).joinToString(",") { """{"key":"k$it","kind":"config"}""" }
        assertNull(CloudSyncCatalog.vetted(j("""{"schemaVersion":1,"entries":[$many]}""")))
    }

    private fun pullBody(version: Long) = SyncResponse(200, j("""{"cursor":1,"serverNow":1760000000000,"catalogVersion":$version}"""))

    @Test
    fun h2RefetchesOnAChangedVersionAtMostEveryFiveMinutesEvenAfterAServerModePull() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.answer = { pullBody(1) }
        r.host.touch()
        // The served catalog is not persisted: it is fetched again on start (once, counted like any other fetch).
        assertEquals(1, r.schemaFetches)
        r.now += CATALOG_REFETCH_MS
        // A pull naming another version fetches once; an equal served catalog skips the rebuild.
        r.answer = { pullBody(2) }
        r.schema = j("""{"schemaVersion":2,"entries":[{"key":"audio.volume","kind":"config"}]}""")
        r.host.withMachine { it.flush() }
        r.host.touch()
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(1))
            it.flush()
        }
        r.host.touch()
        assertEquals(2, r.schemaFetches)
        // Inside five minutes: no second fetch, whatever the version.
        r.answer = { pullBody(3) }
        r.now += 60_000
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(2))
            it.flush()
        }
        r.host.touch()
        assertEquals(2, r.schemaFetches)
        r.now += CATALOG_REFETCH_MS
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(3))
            it.flush()
        }
        r.host.touch()
        assertEquals(3, r.schemaFetches)
        r.host.close()
    }

    // ── H-5, H-10, HOST-BIND, the pump ────────────────────────────────────────────────────────

    @Test
    fun h5OpenKeysComeOnlyFromSealedRowsAndOwnMutationsAndAreCapped() = runBlocking {
        val r = Rig(encryption = "e2e")
        r.unlocked = true
        r.signIn("sub_alice")
        r.answer = { SyncResponse(200, j("""{"encryption":"e2e","cursor":1,"serverNow":1760000000000}""")) }
        r.host.touch()
        r.host.withMachine {
            it.set("my.open.one", JsonPrimitive(1))
            it.flush()
        }
        r.host.touch()
        val f = CloudSyncStateFile(File(r.deps.stateDir.path), "demo")
        assertTrue(f.load().openKeys.contains("my.open.one"))
        // A served plaintext row, or a sealed row for a declared key, never adds a name.
        r.answer =
            { SyncResponse(200, j("""{"encryption":"e2e","cursor":2,"changes":[{"setting":"forged.key","scope":"user","value":1,"version":2}]}""")) }
        r.host.withMachine { it.flush() }
        r.host.touch()
        assertFalse(f.load().openKeys.contains("forged.key"))
        assertEquals(listOf("my.open.one"), f.load().openKeys)
        r.host.close()
    }

    @Test
    fun h10ALockedRingSendsAndPullsNothingAndTheHostAddsNoRequest() = runBlocking {
        val r = Rig(encryption = "e2e")
        r.codec.isLocked = true
        r.signIn("sub_alice")
        r.host.touch()
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(1))
            it.flush()
        }
        r.host.touch()
        assertEquals(0, r.schemaFetches)
        // Any request the machine queued is answered as a transport failure and nothing reaches the wire.
        assertTrue(r.sent.isEmpty())
        r.host.close()
    }

    @Test
    fun h10AnE2e200ThatIsNotAnObjectIsDroppedAndARootLostMidFlightDropsTheAnswer() = runBlocking {
        val r = Rig(encryption = "e2e")
        r.unlocked = true
        r.signIn("sub_alice")
        r.answer = { SyncResponse(200, JsonPrimitive("nope")) }
        r.host.touch()
        // The machine's pull was answered with a non-object: dropped, the cursor stays 0.
        val cursor = r.host.withMachine { (it.journal()["sub_alice"] as JsonObject)["cursor"] }
        assertEquals(JsonPrimitive(0), cursor)
        // Locked after the request left: the answer is dropped and the cursor stays.
        r.answer = {
            r.codec.isLocked = true
            SyncResponse(200, j("""{"encryption":"e2e","cursor":9,"serverNow":1760000000000}"""))
        }
        r.host.withMachine { it.flush() }
        r.host.touch()
        val after = r.host.withMachine { (it.journal()["sub_alice"] as JsonObject)["cursor"] }
        assertEquals(JsonPrimitive(0), after)
        r.host.close()
    }

    @Test
    fun h10ARepeatedMutationIdAnswerIsDroppedAndTheEditStaysPending() = runBlocking {
        val r = Rig(encryption = "e2e")
        r.unlocked = true
        r.signIn("sub_alice")
        r.answer = { SyncResponse(200, j("""{"encryption":"e2e","cursor":1,"serverNow":1760000000000}""")) }
        r.host.touch()
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(1))
            it.flush()
        }
        r.answer = {
            SyncResponse(
                200,
                j("""{"encryption":"e2e","results":[{"mutationId":1,"status":"ok","version":1},{"mutationId":1.0,"status":"ok","version":2}]}"""),
            )
        }
        r.host.touch()
        val pending = r.host.withMachine { (it.journal()["sub_alice"] as JsonObject)["pending"].toString() }
        assertTrue(pending, pending.contains("audio.volume"))
        r.host.close()
    }

    @Test
    fun h10ASealedPushLeavesNoPlaintextOnTheWire() = runBlocking {
        val r = Rig(encryption = "e2e")
        r.unlocked = true
        r.signIn("sub_alice")
        r.answer = { SyncResponse(200, j("""{"encryption":"e2e","cursor":1,"serverNow":1760000000000}""")) }
        r.host.touch()
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(7357))
            it.set("secret.open.key", JsonPrimitive("hunter2"))
            it.flush()
        }
        r.host.touch()
        val pushes = r.sent.filter { it["method"] == JsonPrimitive("POST") }
        assertTrue(pushes.isNotEmpty())
        for (p in pushes) {
            val wire = p.toString()
            assertFalse(wire.contains("hunter2"))
            assertFalse(wire.contains("secret.open.key"))
            assertTrue(wire.contains("\"ct\""))
        }
        r.host.close()
    }

    @Test
    fun hostBindDropsARequestBoundToAnotherPersonAndDoesNotReadAnAnswerAfterAChange() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.subject = "sub_bob"
        r.host.touch()
        // The session's person is Bob while the machine holds Alice's request: nothing is sent.
        assertTrue(r.sent.isEmpty())
        // An unknown session person does not block.
        r.subject = null
        r.host.withMachine { it.flush() }
        r.host.touch()
        assertTrue(r.sent.isNotEmpty())
        // The person changes during the request: the answer is not read.
        r.subject = "sub_alice"
        r.answer = {
            r.subject = "sub_bob"
            SyncResponse(200, j("""{"cursor":50,"serverNow":1760000000000}"""))
        }
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(2))
            it.flush()
        }
        r.host.touch()
        val cursor = r.host.withMachine { (it.journal()["sub_alice"] as JsonObject)["cursor"] }
        assertFalse(cursor == JsonPrimitive(50))
        r.host.close()
    }

    @Test
    fun aPumpMakesAtMostSixtyFourExchangesAndSavesTheJournal() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        // Every answer asks for more: the machine keeps pulling.
        r.answer = { SyncResponse(200, j("""{"cursor":1,"more":true,"serverNow":1760000000000}""")) }
        r.host.touch()
        assertTrue(r.sent.size <= SYNC_MAX_EXCHANGES)
        assertTrue(r.sent.size >= SYNC_MAX_EXCHANGES - 1)
        val saved = CloudSyncStateFile(r.deps.stateDir, "demo").load()
        assertNotNull(MachineStateJson.decode(saved.persisted))
        r.host.close()
    }

    @Test
    fun aTouchDuringAPumpSetsAgainAndReturns() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.touch()
        val before = r.sent.size
        r.host.withMachine {
            it.set("audio.volume", JsonPrimitive(5))
            it.flush()
        }
        r.host.touch()
        r.host.touch()
        assertTrue(r.sent.size > before)
        assertNotNull(JsonText.parseOrNull("{}"))
        r.host.close()
    }
}
