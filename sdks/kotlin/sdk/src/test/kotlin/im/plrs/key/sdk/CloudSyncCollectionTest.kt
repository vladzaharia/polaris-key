// @pkey-feature sync.records
//
// client.cloudSync.collection(name) (U-46): the catalog's collections reach the machine (exact names, `prefix.*`
// patterns, the template's policy, `conflictField`), the handle's refusals are returned and send nothing, and a merge
// `update`, a union `add` and a compare-and-set `put` reach the wire (sealed in end-to-end mode) with their outcomes
// and changes delivered to the listener, across a rebuild of the machine.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.RecordOutcome
import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.sync.SyncResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

private val ROOT = ByteArray(32) { (5 * it + 1).toByte() }

private fun j(s: String): JsonObject = Json.parseToJsonElement(s) as JsonObject

private class Ring(private val root: ByteArray = ROOT) : SyncCodecPort {
    override val locked: Boolean = false

    override fun seal(collection: String, name: String, value: JsonElement) = SyncEnvelope.seal(root, collection, name, value)

    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(root, collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(root, collection, envelope)

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String) = SyncBlind.blind(root, kind, ctx, name)
}

class CloudSyncCollectionTest {
    @get:Rule val tmp = TemporaryFolder()

    private val mirror = j(
        """{"schemaVersion":1,"entries":[],"cloudSync":{"collections":[
          {"name":"cards","conflict":"merge"},
          {"name":"tags","conflict":"union"},
          {"name":"profiles","conflict":"revision"},
          {"name":"scores","conflict":"max","conflictField":"best"},
          {"name":"notes","template":"session"},
          {"name":"save.*","conflict":"lastWrite"}]}}""",
    )

    private inner class Rig(private val encryption: String = "server") {
        val sent = mutableListOf<JsonObject>()
        var document = j("""{"values":{}}""")
        val deps = CloudSyncHostDeps(
            "demo",
            tmp.newFolder(),
            { r ->
                sent += r
                answer(r)
            },
            Ring(),
            { document },
        ).also {
            it.clock = { 1_760_000_000_000L }
            it.keyringUnlocked = { true }
            it.subject = { "sub_alice" }
        }
        val host = CloudSyncHost(
            deps,
            CloudSyncHostOptions().also {
                it.encryption = encryption
                it.catalog = mirror
            },
        )

        private fun answer(r: JsonObject): SyncResponse {
            val mode = if (encryption == "e2e") ""","encryption":"e2e","encryptionSince":1""" else ""
            if (r["method"].stringValue == "GET") return SyncResponse(200, j("""{"cursor":1,"serverNow":1760000000000$mode}"""))
            val ms = (r["body"].objectValue!!["mutations"] as JsonArray).map { it.objectValue!! }
            val results = ms.mapIndexed { i, m -> """{"mutationId":${m["mutationId"]},"status":"ok","version":${10 + i}}""" }
            return SyncResponse(
                200,
                j(
                    """{"cursor":2,"serverNow":1760000000000,"lastMutationId":${ms.last()["mutationId"]},"results":[${results.joinToString(
                        ",",
                    )}]$mode}""",
                ),
            )
        }

        fun pushes(): List<JsonObject> = sent.filter { it["method"].stringValue == "POST" }.map { it["body"].objectValue!! }

        fun mutations(): List<JsonObject> = pushes().flatMap { (it["mutations"] as JsonArray).map { m -> m.objectValue!! } }

        fun open(): SyncCollection = open("cards")

        fun open(name: String): SyncCollection = runBlocking {
            host.start()
            host.withMachine { it.signIn("sub_alice") }
            host.touch()
            SyncCollection(name, host)
        }
    }

    private fun <T> next(q: LinkedBlockingQueue<T>): T = q.poll(10, TimeUnit.SECONDS) ?: throw AssertionError("no event")

    @Test
    fun theCatalogsCollectionsReachTheMachine() = runBlocking {
        val rig = Rig()
        rig.open()
        val decl = rig.host.withMachine { m ->
            listOf("cards", "tags", "profiles", "scores", "notes", "save.slot1", "save.", "nope").map { m.collectionDecl(it) }
        }
        assertEquals("merge", decl[0]?.policy)
        assertEquals("union", decl[1]?.policy)
        assertEquals("revision", decl[2]?.policy)
        assertEquals("keepServer", decl[2]?.resolve)
        assertEquals("max", decl[3]?.policy)
        assertEquals("best", decl[3]?.field)
        assertEquals("lastWrite", decl[4]?.policy)
        assertEquals("save.*", decl[5]?.name)
        assertNull(decl[6])
        assertNull(decl[7])
    }

    @Test
    fun aRefusalIsReturnedAndSendsNothing() = runBlocking {
        val rig = Rig()
        val cards = rig.open()
        val one = JsonPrimitive(1)
        fun refused(r: CollectionResult, e: CollectionError) = assertEquals(CollectionResult.Refused(e), r)
        refused(SyncCollection("nope", rig.host).put("a", one), CollectionError.CollectionUnknown)
        refused(SyncCollection("nope", rig.host).delete("a"), CollectionError.CollectionUnknown)
        assertNull(SyncCollection("nope", rig.host).get("a"))
        assertEquals(emptyList<String>(), SyncCollection("nope", rig.host).ids())
        refused(cards.put("a", one), CollectionError.OpInvalidForPolicy)
        refused(cards.add("a", one), CollectionError.OpInvalidForPolicy)
        refused(cards.delete("a", IfVersion.At(1)), CollectionError.OpInvalidForPolicy)
        refused(cards.update("a"), CollectionError.ValueInvalid)
        refused(cards.update("a", mapOf("" to one)), CollectionError.ValueInvalid)
        refused(cards.update("a", mapOf("x".repeat(1025) to one)), CollectionError.ValueInvalid)
        refused(cards.update("a", mapOf("f" to one), listOf("f")), CollectionError.ValueInvalid)
        refused(cards.update("", mapOf("f" to one)), CollectionError.ValueInvalid)
        val tags = SyncCollection("tags", rig.host)
        refused(tags.update("t", mapOf("f" to one)), CollectionError.OpInvalidForPolicy)
        refused(tags.put("t", one), CollectionError.OpInvalidForPolicy)
        refused(tags.add("t", JsonPrimitive("x".repeat(1030))), CollectionError.ValueInvalid)
        val profiles = SyncCollection("profiles", rig.host)
        refused(profiles.update("p", mapOf("f" to one)), CollectionError.OpInvalidForPolicy)
        refused(profiles.add("p", one), CollectionError.OpInvalidForPolicy)
        val notes = SyncCollection("notes", rig.host)
        refused(notes.put("n", one, IfVersion.Absent), CollectionError.OpInvalidForPolicy)
        assertEquals(CollectionError.CollectionUnknown.code, ErrorCode.collectionUnknown)
        assertEquals(CollectionError.OpInvalidForPolicy.code, ErrorCode.opInvalidForPolicy)
        assertEquals(CollectionError.ValueInvalid.code, ErrorCode.valueInvalid)
        rig.host.flush()
        assertTrue(rig.mutations().isEmpty())
    }

    @Test
    fun signedOutIsARefusal() = runBlocking {
        val rig = Rig()
        rig.host.start()
        val notes = SyncCollection("notes", rig.host)
        assertEquals(CollectionResult.Refused(CollectionError.SignedOut), notes.put("n", JsonPrimitive(1)))
    }

    @Test
    fun updateReachesTheWireAsFieldsUnderOneStamp() = runBlocking {
        val rig = Rig()
        val cards = rig.open()
        assertEquals(CollectionResult.Ok(), cards.update("c1", mapOf("hp" to JsonPrimitive(3), "title" to JsonPrimitive("x")), listOf("old")))
        assertEquals(j("""{"hp":3,"title":"x"}"""), cards.get("c1")?.value)
        assertEquals(listOf("c1"), cards.ids())
        rig.host.flush()
        val ms = rig.mutations()
        assertEquals(listOf("setField", "setField", "removeField"), ms.map { it["op"].stringValue })
        assertEquals(listOf("hp", "old", "title"), ms.mapNotNull { it["field"].stringValue }.sorted())
        assertEquals(1, ms.map { it["editedHlc"].stringValue }.toSet().size)
        assertEquals("cloud", cards.get("c1")?.from)
        assertEquals(CollectionResult.Ok(), cards.delete("c1"))
        assertNull(cards.get("c1"))
    }

    @Test
    fun anEndToEndUpdateAndAddAreSealedAndBlinded() = runBlocking {
        val rig = Rig("e2e")
        val cards = rig.open()
        val tags = SyncCollection("tags", rig.host)
        cards.update("c1", mapOf("hp" to JsonPrimitive(3)))
        tags.add("t1", j("""{"b":2,"a":1}"""))
        rig.host.flush()
        val ms = rig.mutations()
        val set = ms.first { it["op"].stringValue == "setField" }
        val add = ms.first { it["op"].stringValue == "add" }
        val ring = Ring()
        assertEquals(ring.blind(SyncBlind.Kind.Field, "cards", "hp"), set["field"].stringValue)
        assertEquals(ring.blind(SyncBlind.Kind.Element, "tags", """{"a":1,"b":2}"""), add["element"].stringValue)
        assertEquals(ring.blind(SyncBlind.Kind.Record, "cards", "c1"), set["target"].objectValue!!["record"].arrayValue!![1].stringValue)
        assertNull(set["value"])
        val wire = rig.pushes().toString()
        for (plain in listOf("\"hp\"", "\"c1\"", "\"t1\"")) assertFalse(plain, wire.contains(plain))
        assertNotNull(set["ct"])
        assertNotNull(add["ct"])
    }

    @Test
    fun aCompareAndSetPutReportsItsOutcomeToTheListener() = runBlocking {
        val rig = Rig()
        rig.open()
        val profiles = SyncCollection("profiles", rig.host)
        val events = LinkedBlockingQueue<CollectionEvent>()
        val sub = profiles.on { events.add(it) }
        val r = profiles.put("p1", JsonPrimitive(1), IfVersion.Absent) as CollectionResult.Ok
        assertNotNull(r.mutationId)
        var outcome: RecordOutcome? = null
        while (outcome == null) (next(events) as? CollectionEvent.Outcome)?.let { outcome = it.outcome }
        assertEquals(r.mutationId, outcome!!.mutationId)
        assertTrue(outcome is RecordOutcome.Ok)
        // A plain put has no ticket and reports no outcome.
        assertNull((profiles.put("p2", JsonPrimitive(2)) as CollectionResult.Ok).mutationId)
        sub.cancel()
    }

    @Test
    fun theListenerHearsLocalChangesUntilItIsCancelledAndAcrossARebuild() = runBlocking {
        val rig = Rig()
        val notes = rig.open("notes")
        val events = LinkedBlockingQueue<CollectionEvent>()
        val sub = notes.on { events.add(it) }
        notes.put("n1", JsonPrimitive(1))
        val first = generateSequence { next(events) }.filterIsInstance<CollectionEvent.Change>().first()
        assertEquals(CollectionEvent.Change(listOf("n1"), "local"), first)
        // The signed document changed: the machine is rebuilt from its journal, and the watch moves with it.
        rig.host.flush()
        events.clear()
        rig.document = j("""{"values":{"a":1}}""")
        rig.host.refreshDocumentIfChanged()
        notes.put("n2", JsonPrimitive(2))
        val after = generateSequence { next(events) }.filterIsInstance<CollectionEvent.Change>().first { "n2" in it.ids }
        assertEquals("local", after.origin)
        sub.cancel()
        events.clear()
        notes.put("n3", JsonPrimitive(3))
        rig.host.flush()
        assertTrue(events.none { it is CollectionEvent.Change && "n3" in it.ids })
        assertEquals(listOf("n1", "n2", "n3"), notes.ids())
        assertTrue(rig.host.withMachine { it is CloudSyncMachine })
    }

    @Test
    fun whatCannotBeSealedIsRefusedWithoutJournallingOrSending() = runBlocking {
        val rig = Rig()
        val cards = rig.open()
        val notes = SyncCollection("notes", rig.host)
        val tags = SyncCollection("tags", rig.host)
        val one = JsonPrimitive(1)
        val bad = CollectionResult.Refused(CollectionError.ValueInvalid)
        assertEquals(bad, notes.put("a\u0000b", one))
        assertEquals(bad, notes.put("n", JsonPrimitive(Double.NaN)))
        assertEquals(bad, notes.put("n", JsonPrimitive(1L shl 60)))
        assertEquals(bad, notes.put("x".repeat(129), one))
        assertEquals(bad, notes.put("a b", one))
        assertEquals(bad, notes.put("x:" + "A".repeat(43), one))
        assertEquals(bad, cards.update("c", mapOf("f\u0000" to one)))
        assertEquals(bad, cards.update("c", mapOf("f" to JsonPrimitive(Double.POSITIVE_INFINITY))))
        assertEquals(bad, tags.add("t", JsonPrimitive(Double.NaN)))
        assertEquals(bad, notes.delete("a\u0000b"))
        rig.host.flush()
        assertTrue(rig.mutations().isEmpty())
        assertEquals(emptyList<String>(), notes.ids())
    }

    @Test
    fun refusalsComeInOneOrder() = runBlocking {
        val rig = Rig()
        rig.host.start()
        val nul = "a\u0000"
        assertEquals(CollectionResult.Refused(CollectionError.CollectionUnknown), SyncCollection("nope", rig.host).put(nul, JsonPrimitive(1)))
        assertEquals(CollectionResult.Refused(CollectionError.SignedOut), SyncCollection("tags", rig.host).put(nul, JsonPrimitive(1)))
        val tags = rig.open("tags")
        assertEquals(CollectionResult.Refused(CollectionError.OpInvalidForPolicy), tags.put(nul, JsonPrimitive(1)))
    }

    @Test
    fun thereIsNoImplicitSavesCollection() = runBlocking {
        val rig = Rig()
        val saves = rig.open("saves")
        assertNull(saves.policy())
        assertEquals(CollectionResult.Refused(CollectionError.CollectionUnknown), saves.put("s", JsonPrimitive(1)))
    }

    @Test
    fun twoHandlesOnOneCollectionDoNotSilenceEachOther() = runBlocking {
        val rig = Rig()
        val a = rig.open("notes")
        val b = SyncCollection("notes", rig.host)
        val events = LinkedBlockingQueue<CollectionEvent>()
        a.on { events.add(it) }
        b.on { }.cancel()
        a.put("n1", JsonPrimitive(1))
        val first = generateSequence { next(events) }.filterIsInstance<CollectionEvent.Change>().first()
        assertEquals(CollectionEvent.Change(listOf("n1"), "local"), first)
    }

    @Test
    fun anUnsealableJournaledMutationIsDroppedAndTheNextOneIsPushed() = runBlocking {
        val rig = Rig("e2e")
        val notes = rig.open("notes")
        // Journaled around the handle: a name no codec spells.
        rig.host.withMachine { it.put("notes", "a\u0000b", JsonPrimitive(1)) }
        rig.host.flush()
        assertTrue(rig.mutations().isEmpty())
        assertEquals(CollectionResult.Ok(), notes.put("n1", JsonPrimitive(2)))
        rig.host.flush()
        assertEquals(1, rig.mutations().size)
        assertEquals(0, rig.host.withMachine { it.status().pending })
    }
}
