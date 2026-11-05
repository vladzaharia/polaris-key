// @pkey-feature sync.conflict
//
// The MergeRequest registry over a real Cloud Sync machine (plans/U-08.md sections 2.2, 2.3, 2.5): a `revision` record's plain
// `put` that meets a conflict is listed and announced, a listener that returns a choice decides it at once, `keep` settles
// when the machine's answer arrives, a keep that conflicts again reopens, and a closed request answers `sync-merge-closed`.
// The corpus (`sync-scenarios.json`) pins the machine; this pins how the host's registry reads it.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.sync.CallResult
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.CloudSyncOptions
import im.plrs.key.core.sync.MachineConflict
import im.plrs.key.core.sync.MergeKeep
import im.plrs.key.core.sync.RecordRow
import im.plrs.key.core.sync.SyncResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

class MergeRegistryTest {
    private val catalog = j("""{"settings":[],"collections":[{"name":"progress","policy":"revision"}]}""") as JsonObject
    private val scope = CoroutineScope(Dispatchers.Default)

    private class Rig(val m: CloudSyncMachine, val registry: MergeRegistry)

    private fun rig(): Rig {
        val ids = ArrayDeque(listOf("c_000000000000000client1", "c_000000000000000client2"))
        val opts = CloudSyncOptions("demo", catalog, JsonObject(emptyMap()), 1_760_000_000_000L) { ids.removeFirst() }
        opts.contacted = true
        opts.subject = "sub_alice"
        opts.encryption = "server"
        val m = CloudSyncMachine(opts)
        val port = object : MergeMachinePort {
            override suspend fun conflicts(): List<MachineConflict> = m.conflicts()

            override suspend fun keep(id: String, choice: MergeKeep): CallResult = m.keep(id, choice)

            override suspend fun records(collection: String): List<RecordRow> = m.records(collection)
        }
        return Rig(m, MergeRegistry(scope, port))
    }

    private fun body(extra: String = "", cursor: Int = 0, last: Int = 0) = j(
        """{"subject":"sub_alice","serverNow":1760000000000,"cursor":$cursor,"more":false,"lastMutationId":$last,""" +
            """"catalogVersion":1,"aliases":{},"changes":[],"tombstones":[]$extra}""",
    )

    private fun pull(r: Rig) {
        r.m.advance(1)
        r.m.takeRequests()
        r.m.receive(
            SyncResponse(
                200,
                j(
                    """{"subject":"sub_alice","serverNow":1760000000000,"cursor":9,"more":false,"lastMutationId":0,"catalogVersion":1,""" +
                        """"aliases":{},"changes":[{"record":["progress","main"],"value":{"level":3},"version":7}],"tombstones":[]}""",
                ),
            ),
        )
    }

    /** Answer the push in flight: a conflict with the server copy at [version], or an ok at [version]. */
    private suspend fun answer(r: Rig, conflict: Boolean, level: Int, version: Int) {
        r.m.advance(1)
        val req = r.m.takeRequests().single()
        val mutationId = ((req["body"] as JsonObject)["mutations"] as kotlinx.serialization.json.JsonArray).let {
            (it[0] as JsonObject)["mutationId"]
        }
        val result = if (conflict) {
            """{"mutationId":$mutationId,"status":"conflict","server":{"value":{"level":$level},"version":$version}}"""
        } else {
            """{"mutationId":$mutationId,"status":"ok","version":$version}"""
        }
        r.m.receive(SyncResponse(200, JsonObject((body(cursor = 10, last = 1) as JsonObject) + mapOf("results" to j("[$result]")))))
        r.registry.feed(r.m.takeEvents())
    }

    private suspend fun openOne(r: Rig): MergeRequest {
        pull(r)
        assertEquals(CallResult.Ok, r.m.put("progress", "main", j("""{"level":4}""")))
        answer(r, conflict = true, level = 5, version = 8)
        return r.registry.conflicts().single()
    }

    @Test
    fun aConflictIsListedWithBothCopiesAndAnnouncedOnce() = runBlocking {
        val r = rig()
        val opened = mutableListOf<MergeRequest>()
        r.registry.onEvent { if (it is MergeStreamEvent.Opened) opened += it.request }
        val request = openOne(r)
        assertEquals("w:progress/main", request.id)
        assertEquals("write", request.cause)
        assertEquals("open", request.state)
        assertEquals(j("""{"level":4}"""), request.local!!.value)
        assertEquals(7L, request.local!!.version)
        assertEquals(j("""{"level":5}"""), request.remote!!.value)
        assertEquals(8L, request.remote!!.version)
        assertEquals(listOf("local", "remote", "value"), request.choices)
        assertNull(request.newer)
        assertEquals(1, opened.size)
        // A listener that registers later is told of the request already open.
        val seen = mutableListOf<String>()
        r.registry.onConflict {
            seen += it.id
            null
        }
        assertEquals(listOf("w:progress/main"), seen)
    }

    @Test
    fun keepLocalSettlesWhenTheMachineIsAnsweredAndTheRequestCloses() = runBlocking {
        val r = rig()
        val closed = mutableListOf<String>()
        r.registry.onEvent { if (it is MergeStreamEvent.Closed) closed += it.how }
        val request = openOne(r)
        val kept = scope.async { request.keep(MergeKeep.Local) }
        withTimeout(5_000) {
            while (request.state != "applying") {
                r.registry.conflicts()
                delay(5)
            }
        }
        answer(r, conflict = false, level = 4, version = 9)
        assertEquals(MergeOutcome.Kept("local", 9), withTimeout(5_000) { kept.await() })
        assertEquals(listOf("local"), closed)
        assertTrue(r.registry.conflicts().isEmpty())
        // The request is closed: a second keep is the closed code, and nothing was journalled for it.
        assertEquals(MergeOutcome.Refused(ErrorCode.syncMergeClosed, reopened = false), request.keep(MergeKeep.Remote))
    }

    @Test
    fun aKeepThatConflictsAgainReopensTheRequestWithTheNewRemote() = runBlocking {
        val r = rig()
        val request = openOne(r)
        val kept = scope.async { request.keep(MergeKeep.Local) }
        withTimeout(5_000) {
            while (request.state != "applying") {
                r.registry.conflicts()
                delay(5)
            }
        }
        answer(r, conflict = true, level = 6, version = 10)
        assertEquals(MergeOutcome.Refused("conflict", reopened = true), withTimeout(5_000) { kept.await() })
        assertEquals("open", request.state)
        assertEquals(10L, request.remote!!.version)
        assertEquals(j("""{"level":4}"""), request.local!!.value)
    }

    @Test
    fun keepRemoteSendsNothingAndAChoiceOutsideTheListIsBadRequest() = runBlocking {
        val r = rig()
        val request = openOne(r)
        assertEquals(MergeOutcome.Refused("bad_request", reopened = false), request.keep(MergeKeep.Both))
        assertEquals(MergeOutcome.Kept("remote", 8), request.keep(MergeKeep.Remote))
        r.m.advance(1)
        assertTrue(r.m.takeRequests().isEmpty())
        assertEquals(j("""{"level":5}"""), r.m.record("progress", "main")!!.value)
    }

    @Test
    fun aListenerThatReturnsAChoiceDecidesTheRequestAtOnce() = runBlocking {
        val r = rig()
        r.registry.onConflict { MergeKeep.Remote }
        pull(r)
        r.m.put("progress", "main", j("""{"level":4}"""))
        answer(r, conflict = true, level = 5, version = 8)
        withTimeout(5_000) { while (r.registry.conflicts().isNotEmpty()) delay(5) }
        assertEquals(j("""{"level":5}"""), r.m.record("progress", "main")!!.value)
    }
}
