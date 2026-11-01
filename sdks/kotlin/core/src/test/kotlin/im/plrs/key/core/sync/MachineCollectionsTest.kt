// @pkey-feature sync.records
//
// The machine's collection calls (plans/C-26, U-46): `update` and `delete`, pattern collections, record events for a
// watched collection, and the outcome tap beside `onOutcome`. The wire shapes the machine sends are asserted on the
// requests it queues; nothing here is sealed (server mode).

package im.plrs.key.core.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

private val CATALOG = j(
    """{"settings":[],"collections":[
      {"name":"cards","policy":"merge"},
      {"name":"tags","policy":"union"},
      {"name":"profiles","policy":"revision","resolve":"keepServer"},
      {"name":"notes","policy":"lastWrite"},
      {"name":"save.*","policy":"lastWrite"},
      {"name":"save.big.*","policy":"max","field":"best"}]}""",
) as JsonObject

private fun machine(subject: String? = "sub_alice"): CloudSyncMachine {
    val ids = ArrayDeque(listOf("c_000000000000000client1", "c_000000000000000client2", "c_000000000000000client3"))
    val opts = CloudSyncOptions("demo", CATALOG, JsonObject(emptyMap()), 1_760_000_000_000L) { ids.removeFirst() }
    opts.contacted = true
    opts.subject = subject
    opts.encryption = "server"
    return CloudSyncMachine(opts)
}

private fun pullBody(changes: String = "[]", cursor: Int = 0) = j(
    """{"subject":"sub_alice","serverNow":1760000000000,"cursor":$cursor,"more":false,"catalogVersion":1,""" +
        """"aliases":{},"changes":$changes,"tombstones":[]}""",
)

/** Answer every queued request: a pull with [pull], a push with an `ok` for each mutation. Returns the pushes sent. */
private fun settle(m: CloudSyncMachine, pull: JsonElement = pullBody()): List<JsonObject> {
    val pushes = mutableListOf<JsonObject>()
    var guard = 0
    while (guard++ < 10) {
        m.advance(1)
        val reqs = m.takeRequests()
        if (reqs.isEmpty()) break
        for (req in reqs) {
            if ((req["method"] as JsonPrimitive).content == "GET") {
                m.receive(SyncResponse(200, pull))
            } else {
                val body = req["body"] as JsonObject
                pushes += body
                val ms = (body["mutations"] as JsonArray).map { it as JsonObject }
                var v = 10
                val results = ms.map { mu ->
                    j("""{"mutationId":${mu["mutationId"]},"status":"ok","version":${v++}}""")
                }
                m.receive(
                    SyncResponse(
                        200,
                        JsonObject(
                            (pullBody() as JsonObject) +
                                mapOf("lastMutationId" to (ms.last()["mutationId"]!!), "results" to JsonArray(results)),
                        ),
                    ),
                )
            }
        }
    }
    return pushes
}

class MachineCollectionsTest {
    private fun ops(push: JsonObject) = (push["mutations"] as JsonArray).map { it as JsonObject }

    @Test
    fun updateIsOneStampAndLeavesOtherFieldsAlone() {
        val m = machine()
        settle(
            m,
            pullBody(
                """[{"record":["cards","c1"],"value":{"hp":1,"title":"Dragon","extra":"keep"},"version":3,"editedHlc":"018bcfe56418:0000"}]""",
                3,
            ),
        )
        assertEquals(ReadResult(j("""{"hp":1,"title":"Dragon","extra":"keep"}"""), "cloud"), m.record("cards", "c1"))
        assertEquals(CallResult.Ok, m.update("cards", "c1", mapOf("hp" to JsonPrimitive(2), "color" to JsonPrimitive("red")), listOf("title")))
        assertEquals(ReadResult(j("""{"hp":2,"extra":"keep","color":"red"}"""), "pending"), m.record("cards", "c1"))
        val sent = settle(m).flatMap { ops(it) }
        assertEquals(listOf("setField", "setField", "removeField"), sent.map { (it["op"] as JsonPrimitive).content })
        assertEquals(listOf("color", "hp", "title"), sent.map { (it["field"] as JsonPrimitive).content })
        assertEquals(1, sent.map { it["editedHlc"] }.toSet().size)
        assertNull(sent[2]["value"])
        assertEquals(JsonPrimitive("red"), sent[0]["value"])
    }

    @Test
    fun updateRefusalsJournalNothing() {
        val m = machine()
        settle(m)
        assertEquals(CallResult.Failed("collection-unknown"), m.update("tags", "t", mapOf("a" to JsonPrimitive(1))))
        assertEquals(CallResult.Failed("collection-unknown"), m.update("nope", "t", mapOf("a" to JsonPrimitive(1))))
        assertEquals(CallResult.Failed("bad_request"), m.update("cards", "c", emptyMap(), emptyList()))
        assertEquals(CallResult.Failed("bad_request"), m.update("cards", "c", mapOf("a" to JsonPrimitive(1)), listOf("a")))
        assertTrue(settle(m).isEmpty())
        assertNull(m.record("cards", "c"))
        assertEquals(CallResult.Failed("signed-out"), machine(null).update("cards", "c", mapOf("a" to JsonPrimitive(1))))
    }

    @Test
    fun deleteStampsEveryPolicyButUnionAndRefusesRevision() {
        val m = machine()
        settle(m)
        assertEquals(CallResult.Ok, m.delete("notes", "n1"))
        assertEquals(CallResult.Ok, m.delete("cards", "c1"))
        assertEquals(CallResult.Ok, m.delete("tags", "t1"))
        assertEquals(CallResult.Failed("collection-unknown"), m.delete("profiles", "p1"))
        assertEquals(CallResult.Failed("collection-unknown"), m.delete("nope", "x"))
        assertEquals(CallResult.Failed("signed-out"), machine(null).delete("notes", "n"))
        val sent = settle(m).flatMap { ops(it) }
        assertEquals(listOf("delete", "delete", "delete"), sent.map { (it["op"] as JsonPrimitive).content })
        assertNotNull(sent[0]["editedHlc"])
        assertNotNull(sent[1]["editedHlc"])
        assertNull(sent[2]["editedHlc"])
        assertNull(m.record("notes", "n1"))
    }

    @Test
    fun aPatternGovernsTheNamesUnderItAndTheLongestPrefixWins() {
        val m = machine()
        assertEquals("lastWrite", m.collectionDecl("save.slot1")?.policy)
        assertEquals("save.*", m.collectionDecl("save.slot1")?.name)
        assertEquals("max", m.collectionDecl("save.big.run")?.policy)
        assertEquals("best", m.collectionDecl("save.big.run")?.field)
        assertNull(m.collectionDecl("save."))
        assertNull(m.collectionDecl("save"))
        assertNull(m.collectionDecl("saves"))
        assertEquals("merge", m.collectionDecl("cards")?.policy)
        settle(m)
        assertEquals(CallResult.Ok, m.put("save.slot1", "a", JsonPrimitive(1)))
        assertEquals(CallResult.Failed("collection-unknown"), m.put("save.", "a", JsonPrimitive(1)))
        assertEquals(listOf("a"), m.recordIds("save.slot1"))
    }

    @Test
    fun recordIdsListPendingCreatesInByteOrder() {
        val m = machine()
        settle(m, pullBody("""[{"record":["notes","b"],"value":1,"version":3,"editedHlc":"018bcfe56418:0000"}]""", 3))
        m.put("notes", "c", JsonPrimitive(2))
        m.put("notes", "a", JsonPrimitive(3))
        assertEquals(listOf("a", "b", "c"), m.recordIds("notes"))
        m.delete("notes", "b")
        assertEquals(listOf("a", "c"), m.recordIds("notes"))
        assertEquals(emptyList<String>(), machine(null).recordIds("notes"))
    }

    @Test
    fun aWatchedCollectionReportsLocalAndRemoteChanges() {
        val m = machine()
        m.watchRecords("notes", true)
        // A remote change arrives with the first pull.
        settle(m, pullBody("""[{"record":["notes","n2"],"value":"r","version":30,"editedHlc":"018bcfe56418:0001"}]""", 30))
        assertEquals(listOf<SyncEvent>(SyncEvent.Records("notes", listOf("n2"), "remote")), m.takeEvents().filterIsInstance<SyncEvent.Records>())
        m.put("notes", "n1", JsonPrimitive(1))
        m.put("other", "x", JsonPrimitive(1))
        assertEquals(listOf<SyncEvent>(SyncEvent.Records("notes", listOf("n1"), "local")), m.takeEvents())
        // The acknowledgement changes where the value comes from (pending to cloud), which is a change too.
        settle(m)
        assertEquals(listOf<SyncEvent>(SyncEvent.Records("notes", listOf("n1"), "remote")), m.takeEvents())
        settle(m)
        assertTrue(m.takeEvents().none { it is SyncEvent.Records })
        m.watchRecords("notes", false)
        m.put("notes", "n3", JsonPrimitive(1))
        assertTrue(m.takeEvents().none { it is SyncEvent.Records })
    }

    @Test
    fun theOutcomeTapSeesWhatOnOutcomeSeesAndStops() {
        val m = machine()
        settle(m)
        val slot = mutableListOf<Long>()
        val tap = mutableListOf<Long>()
        m.onOutcome { slot += it.mutationId }
        val stop = m.tapOutcomes { tap += it.mutationId }
        val first = (m.putAt("profiles", "p1", JsonPrimitive(1), JsonPrimitive("*")) as PutAtResult.Ok).mutationId
        settle(m)
        assertEquals(listOf(first), slot)
        assertEquals(listOf(first), tap)
        stop()
        m.putAt("profiles", "p2", JsonPrimitive(1), JsonPrimitive("*"))
        settle(m)
        assertEquals(2, slot.size)
        assertEquals(1, tap.size)
    }

    @Test
    fun aReplacementMachineAdoptsTheObservers() {
        val old = machine()
        settle(old)
        val seen = mutableListOf<Long>()
        old.tapOutcomes { seen += it.mutationId }
        old.watchRecords("notes", true)
        val next = machine()
        next.adoptObservers(old)
        settle(next)
        next.takeEvents()
        next.put("notes", "n1", JsonPrimitive(1))
        assertEquals(1, next.takeEvents().filterIsInstance<SyncEvent.Records>().size)
        val t = (next.putAt("profiles", "p1", JsonPrimitive(1), JsonPrimitive("*")) as PutAtResult.Ok).mutationId
        settle(next)
        assertEquals(listOf(t), seen)
    }
}
