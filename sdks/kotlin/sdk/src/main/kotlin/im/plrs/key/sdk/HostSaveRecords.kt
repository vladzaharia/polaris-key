// The saves' record layer over the Cloud Sync machine (U-22.5): reads are the machine's cloud rows
// (`records("saves")`), and a write is an exact mutation (`putAt` / `removeAt`) whose one outcome the caller waits for.
// A write is never coalesced or rebased. The metadata of a save is sealed and blinded by the host codec like any
// record (D-2: scalar values), so the Worker sees the collection and nothing else in end-to-end mode.

package im.plrs.key.sdk

import im.plrs.key.core.sync.HostCodec
import im.plrs.key.core.sync.PutAtResult
import im.plrs.key.core.sync.RecordFile
import im.plrs.key.core.sync.RecordOutcome
import im.plrs.key.core.sync.RecordRow
import im.plrs.key.core.sync.SyncBlind
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.ConcurrentHashMap

@Suppress("TooManyFunctions")
internal class HostSaveRecords(private val host: CloudSyncHost) : SaveRecords {
    private val waiting = ConcurrentHashMap<Long, CompletableDeferred<RecordOutcome>>()

    /** Take the host's outcome listener; call once, before any write. */
    suspend fun listen() {
        host.onOutcome { o -> waiting.remove(o.mutationId)?.complete(o) }
    }

    /** Settle every write still waiting as dropped (the person and their data are gone). */
    fun dropAll() {
        for (id in waiting.keys.toList()) waiting.remove(id)?.complete(RecordOutcome.Dropped(id))
    }

    private suspend fun e2e(): Boolean = host.withMachine { it.encryptionMode() == "e2e" }

    override suspend fun wireId(id: String): String = HostCodec.wireId(if (e2e()) host.syncCodec else null, SAVES_COLLECTION, id)

    override suspend fun notReady(): String? = if (host.withMachine { it.subject } == null) "signed-out" else null

    private fun record(row: RecordRow, id: String = row.id): SaveRecord = SaveRecord(
        id,
        row.version,
        row.value as? JsonObject ?: JsonObject(emptyMap()),
        row.file,
    )

    override suspend fun list(): List<SaveRecord> {
        val (rows, blinded) = host.withMachine { it.records(SAVES_COLLECTION) to (it.encryptionMode() == "e2e") }
        return rows.filter { !(blinded && SyncBlind.isBlindedName(it.id)) }.map { record(it) }
    }

    override suspend fun get(id: String): SaveRecord? {
        val (rows, blinded) = host.withMachine { it.records(SAVES_COLLECTION) to (it.encryptionMode() == "e2e") }
        var row = rows.firstOrNull { it.id == id }
        // A record that has a file and no value comes back under its wire id (the host cannot place its blinded id without a value).
        if (row == null && blinded) {
            val wire = HostCodec.wireId(host.syncCodec, SAVES_COLLECTION, id)
            row = rows.firstOrNull { it.id == wire }
        }
        return row?.let { record(it, id) }
    }

    private suspend fun await(id: String, call: (im.plrs.key.core.sync.CloudSyncMachine) -> PutAtResult): SaveSetResult {
        host.catchUp()
        val outcome = CompletableDeferred<RecordOutcome>()
        // Registered inside the machine's turn: the result cannot arrive before the waiter is there.
        val started = host.withMachine { m ->
            call(m).also { if (it is PutAtResult.Ok) waiting[it.mutationId] = outcome }
        }
        if (started is PutAtResult.Failed) return SaveSetResult.Rejected(started.error)
        val ticket = (started as PutAtResult.Ok).mutationId
        host.kick()
        // No timeout: a cancel (this coroutine's), a sign-out drop and the host's retries are what end the wait.
        val o = try {
            outcome.await()
        } finally {
            waiting.remove(ticket)
        }
        return when (o) {
            is RecordOutcome.Ok -> SaveSetResult.Ok(o.version)

            is RecordOutcome.Conflict -> SaveSetResult.Conflict(
                o.server?.let {
                    SaveRecord(
                        id,
                        it.version,
                        it.value as? JsonObject ?: JsonObject(emptyMap()),
                        it.file,
                    )
                },
            )

            is RecordOutcome.Rejected -> SaveSetResult.Rejected(o.code)

            is RecordOutcome.Dropped -> SaveSetResult.Rejected("signed-out")
        }
    }

    override suspend fun pull(): Boolean {
        val asked = host.withMachine { it.pull(); true }
        host.touch()
        return asked
    }

    override suspend fun set(id: String, value: JsonObject, baseVersion: JsonElement, file: RecordFile?): SaveSetResult =
        await(id) { it.putAt(SAVES_COLLECTION, id, value, baseVersion, file) }

    override suspend fun delete(id: String, baseVersion: Long): SaveSetResult =
        await(id) { it.removeAt(SAVES_COLLECTION, id, JsonPrimitive(baseVersion)) }
}
