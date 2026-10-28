// @pkey-feature sync.settings
//
// The Cloud Sync host's bounds (U-07.K7): H-7 purge (a purge interleaved with an exchange in flight),
// resume and the one-time import, H-8 listener re-entrancy, H-9 bounded flush with no lost wake-up, the
// shutdown hook, the bounded retry, and the H-5 open-key cap.

package im.plrs.key.sdk

import im.plrs.key.core.sync.SyncBlind
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncEnvelope
import im.plrs.key.core.sync.SyncEvent
import im.plrs.key.core.sync.SyncResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

private fun j(s: String): JsonObject = Json.parseToJsonElement(s) as JsonObject

private class NoCodec : SyncCodecPort {
    override val locked: Boolean = false

    override fun seal(collection: String, name: String, value: JsonElement) = ByteArray(0)

    override fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String>) =
        SyncEnvelope.open(ByteArray(32), collection, name, envelope, aliases)

    override fun openAny(collection: String, envelope: ByteArray) = SyncEnvelope.openAnyName(ByteArray(32), collection, envelope)

    override fun blind(kind: SyncBlind.Kind, ctx: String, name: String) = name
}

class CloudSyncHostBoundsTest {
    @get:Rule val tmp = TemporaryFolder()

    private val mirror = j("""{"schemaVersion":1,"entries":[{"key":"audio.volume","kind":"config","schema":{"type":"number"}}]}""")
    private val ok = SyncResponse(200, j("""{"cursor":1,"serverNow":1760000000000}"""))

    /** An answer that acknowledges every mutation the push carried (otherwise the machine keeps resending). */
    private fun okFor(req: JsonObject): SyncResponse {
        val mutations = ((req["body"] as? JsonObject)?.get("mutations") as? kotlinx.serialization.json.JsonArray) ?: return ok
        val results = mutations.joinToString(",") {
            """{"mutationId":${((it as JsonObject)["mutationId"] as JsonPrimitive).content},"status":"ok","version":1}"""
        }
        return SyncResponse(200, j("""{"cursor":1,"serverNow":1760000000000,"results":[$results]}"""))
    }

    private inner class Rig(val dir: File = tmp.newFolder()) {
        val sent = mutableListOf<JsonObject>()
        var answer: suspend (JsonObject) -> SyncResponse = { okFor(it) }
        val concurrent = AtomicInteger()
        var maxConcurrent = 0
        val deps = CloudSyncHostDeps(
            "demo",
            dir,
            { r ->
                maxConcurrent = maxOf(maxConcurrent, concurrent.incrementAndGet())
                sent += r
                try {
                    answer(r)
                } finally {
                    concurrent.decrementAndGet()
                }
            },
            NoCodec(),
            { j("""{"values":{}}""") },
        ).also { it.retryDelayMs = { 1L } }
        val host = CloudSyncHost(
            deps,
            CloudSyncHostOptions().also {
                it.encryption = "server"
                it.catalog = mirror
            },
        )
        val file = File(dir, CLOUD_SYNC_FILE)

        fun signIn(who: String) = runBlocking {
            host.start()
            host.withMachine { it.signIn(who) }
        }

        fun pushes() = sent.count { it["method"] == JsonPrimitive("POST") }

        suspend fun edit(v: Int) {
            host.withMachine {
                it.set("audio.volume", JsonPrimitive(v))
                it.flush()
            }
        }
    }

    // ── H-7: purge ────────────────────────────────────────────────────────────────────────────

    @Test
    fun h7APurgeClearsTheLiveMachineAtOnceAndNothingRunsUntilItEnds() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.touch()
        r.edit(1)
        val inFlight = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        r.answer = {
            inFlight.complete(Unit)
            release.await()
            ok
        }
        r.edit(2)
        val pump = async(Dispatchers.Default) { r.host.touch() }
        inFlight.await()
        val purge = async(Dispatchers.Default) { r.host.purge() }
        delay(150)
        // The pump is still out, the purge is waiting for it: the person's values are already gone from the live machine.
        assertNull(r.host.withMachine { it.subject })
        assertEquals(JsonNull, r.host.withMachine { it.get("audio.volume").value })
        // A touch during the purge sends nothing (no pump runs until it ends).
        val before = r.sent.size
        r.host.touch()
        assertEquals(before, r.sent.size)
        release.complete(Unit)
        pump.await()
        purge.await()
        assertFalse(r.file.exists())
    }

    @Test
    fun h7APurgeInterleavedWithAnExchangeInFlightLeavesNoFileAndNoSavedJournal() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.touch()
        r.edit(1)
        r.host.touch()
        assertTrue("saved once", r.file.exists())
        // The next push is held in flight while a purge runs.
        val inFlight = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        r.answer = {
            inFlight.complete(Unit)
            release.await()
            SyncResponse(
                200,
                j("""{"cursor":9,"serverNow":1760000000000,"changes":[{"setting":"audio.volume","scope":"user","value":0.5,"version":9}]}"""),
            )
        }
        r.edit(2)
        val pump = async(Dispatchers.Default) { r.host.touch() }
        inFlight.await()
        val purge = async(Dispatchers.Default) { r.host.purge() }
        delay(150)
        // The file went first, while the exchange is still out.
        assertFalse(r.file.exists())
        release.complete(Unit)
        pump.await()
        purge.await()
        assertFalse("no late save re-created it", r.file.exists())
        assertEquals(emptyList<String>(), r.dir.list()!!.filter { it.endsWith(".tmp") })
        val journal = r.host.withMachine { it.journal() }
        assertFalse(journal.containsKey("sub_alice"))
        // Nothing is saved until resume; after it, the next pump saves again.
        r.answer = { okFor(it) }
        r.signIn("sub_bob")
        r.host.touch()
        assertFalse(r.file.exists())
        r.host.resume()
        r.edit(3)
        r.host.touch()
        assertTrue(r.file.exists())
        r.host.close()
    }

    @Test
    fun h7PurgeWorksBeforeStartAndSweepsLeftoverTemporaries() = runBlocking {
        val r = Rig()
        File(r.dir, "$CLOUD_SYNC_FILE.abc.tmp").writeText("x")
        r.file.writeText("{}")
        r.host.purge()
        assertFalse(r.file.exists())
        assertFalse(File(r.dir, "$CLOUD_SYNC_FILE.abc.tmp").exists())
        r.host.close()
    }

    @Test
    fun importLocalOnceOffersTheLegacyStoreOnceAndThePurgeKeepsTheMarker() = runBlocking {
        val r = Rig()
        r.host.start()
        r.host.importLocalOnce(j("""{"audio.volume":0.4}"""))
        assertTrue(File(r.dir, CLOUD_SYNC_IMPORTED_FILE).exists())
        assertEquals(JsonPrimitive(0.4), r.host.withMachine { it.get("audio.volume").value })
        r.host.purge()
        assertTrue("the marker survives a purge", File(r.dir, CLOUD_SYNC_IMPORTED_FILE).exists())
        r.host.importLocalOnce(j("""{"audio.volume":0.9}"""))
        assertFalse(r.host.withMachine { it.get("audio.volume").value } == JsonPrimitive(0.9))
        r.host.close()
    }

    // ── H-8: a listener that re-enters the host ───────────────────────────────────────────────

    @Test
    fun h8AListenerThatBlocksOnTheHostNeitherDeadlocksNorStartsASecondPump() {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.onEvents { events ->
            if (events.any { it is SyncEvent.Change }) {
                runBlocking {
                    r.host.touch()
                    r.host.withMachine { it.flush() }
                    r.host.touch()
                }
            }
        }
        var failure: Throwable? = null
        val t = Thread {
            runCatching {
                runBlocking {
                    r.edit(5)
                    r.host.touch()
                }
            }.onFailure { failure = it }
        }
        t.start()
        t.join(10_000)
        assertFalse("deadlocked", t.isAlive)
        assertEquals(null, failure)
        assertEquals(1, r.maxConcurrent)
        assertTrue(r.pushes() >= 1)
        runBlocking { r.host.close() }
    }

    // ── H-9: flush(maxMs) ─────────────────────────────────────────────────────────────────────

    @Test
    fun h9FlushIsBoundedAndKeepsTheJournalWhenTheNetworkNeverAnswers() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.touch()
        r.answer = {
            delay(60_000)
            okFor(it)
        }
        r.edit(1)
        val started = System.nanoTime()
        r.host.flush(300)
        val ms = (System.nanoTime() - started) / 1_000_000
        assertTrue("took $ms ms", ms < 3_000)
        val pending = r.host.withMachine { (it.journal()["sub_alice"] as JsonObject)["pending"].toString() }
        assertTrue(pending, pending.contains("audio.volume"))
    }

    @Test
    fun h9ATouchThatLandsAsThePumpEndsStillSends() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.touch()
        var first = true
        r.answer = {
            if (first && it["method"] == JsonPrimitive("POST")) {
                first = false
                // A second edit and touch arrive while the first push is out.
                launch(Dispatchers.Default) {
                    r.edit(8)
                    r.host.touch()
                }.join()
            }
            okFor(it)
        }
        r.edit(7)
        r.host.flush(5_000)
        assertEquals(2, r.pushes())
        r.host.close()
    }

    @Test
    fun h9APlainTouchDuringThePumpRunsOnePassMoreWithoutAnyFlush() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.host.touch()
        var first = true
        r.answer = {
            if (first && it["method"] == JsonPrimitive("POST")) {
                first = false
                launch(Dispatchers.Default) {
                    r.edit(8)
                    r.host.touch()
                }.join()
            }
            okFor(it)
        }
        r.edit(7)
        r.host.touch()
        assertEquals(2, r.pushes())
        assertEquals(1, r.maxConcurrent)
        r.host.close()
    }

    @Test
    fun theShutdownHookFlushesAndCloseRemovesIt() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        assertTrue(r.host.hasShutdownHook)
        r.host.withMachine { it.set("audio.volume", JsonPrimitive(3)) }
        r.host.shutdownFlush()
        assertTrue(r.pushes() >= 1)
        r.host.close()
        assertFalse(r.host.hasShutdownHook)
    }

    // ── the bounded retry ─────────────────────────────────────────────────────────────────────

    @Test
    fun aTransportFailureIsRetriedAfterABoundedDelay() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        var failures = 1
        r.answer = { if (failures-- > 0) SyncResponse.TRANSPORT else okFor(it) }
        r.host.touch()
        repeat(100) { if (r.sent.size < 2) delay(50) }
        assertTrue("retried: ${r.sent.size}", r.sent.size >= 2)
        r.host.close()
    }

    @Test
    fun theRetryGivesUpAfterTheBoundAndTheDelayIsCappedAndJittered() = runBlocking {
        val r = Rig()
        r.signIn("sub_alice")
        r.answer = { SyncResponse.TRANSPORT }
        r.host.touch()
        delay(1_000)
        assertTrue("${r.sent.size}", r.sent.size <= 1 + SYNC_MAX_RETRIES)
        assertTrue(r.sent.size >= 2)
        val delays = (1..30).map { defaultRetryDelayMs(it) }
        assertTrue(delays.all { it in 500..60_000 })
        assertTrue(delays.toSet().size > 3)
        r.host.close()
    }

    // ── H-5: the open-key cap ─────────────────────────────────────────────────────────────────

    @Test
    fun h5OpenKeysAreCappedAtFourThousandNinetySixAndTheOldestGoFirst() {
        val r = Rig()
        val st = CloudSyncHostState(r.deps, CloudSyncHostOptions(), Dispatchers.Unconfined)
        for (i in 0 until OPEN_KEYS_MAX + 10) st.addOpenKey("k$i")
        assertEquals(OPEN_KEYS_MAX, st.openKeys.size)
        assertFalse("k0" in st.openKeys)
        assertTrue("k${OPEN_KEYS_MAX + 9}" in st.openKeys)
        // The file keeps the newest too.
        val file = CloudSyncStateFile(tmp.newFolder(), "demo")
        file.save(j("""{"partitions":{},"hlc":[0,0],"contacted":true}"""), null, (0 until OPEN_KEYS_MAX + 904).map { "n$it" })
        val back = file.load().openKeys
        assertEquals(OPEN_KEYS_MAX, back.size)
        assertEquals("n${OPEN_KEYS_MAX + 903}", back.last())
    }
}
