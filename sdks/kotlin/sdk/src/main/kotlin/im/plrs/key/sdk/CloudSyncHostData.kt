// The Cloud Sync host's data calls: purge (H-7), resume, and the one-time import of the legacy store (A-6).

package im.plrs.key.sdk

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** What the host does with the person's synced data. */
public interface CloudSyncHostData {
    /**
     * Forget the person's synced data (S6): the file is deleted first, a generation counter makes any in-flight
     * pump drop its answer and never save, the machine is rebuilt empty, and the file is deleted again. Nothing
     * is saved until [resume]. Works before `start` too (the file may predate this process). Throws only if the
     * file could not be removed; the in-memory data is gone either way.
     */
    public suspend fun purge()

    /** A principal signed in: the journal is saved again. */
    public suspend fun resume()

    /** Offer the legacy `config.local` contents to the machine, once per install (the marker survives a purge). */
    public suspend fun importLocalOnce(values: JsonObject)

    /**
     * The same offer, without writing the marker: true when it was made (no marker yet). The caller writes the
     * marker with [markImported] once the person's sign-in succeeded (A-6).
     */
    public suspend fun offerLocal(values: JsonObject): Boolean

    /** Write the import marker (kept apart from the state file; a purge leaves it). */
    public suspend fun markImported()
}

/** How long a purge or a close waits for the pump that is running, in milliseconds. */
public const val SYNC_PUMP_WAIT_MS: Long = 2_000

internal class CloudSyncHostDataImpl(
    private val st: CloudSyncHostState,
    private val builder: CloudSyncHostBuilder,
    private val pump: CloudSyncHostPump,
) : CloudSyncHostData {
    override suspend fun purge() {
        // At once, before any suspension: the live machine is replaced by an empty one and no pump or rebuild runs
        // until the purge ends, so nothing of the person's can be sent, saved or read back meanwhile (H-7).
        val old = withContext(st.dispatcher) {
            st.purged = true
            st.generation += 1
            st.purging = true
            st.rebuildWanted = false
            st.openKeys.clear()
            val previous = st.machine
            if (st.live) {
                builder.buildNow(null, st.documentValue, st.discoveryValue)
                st.machine?.importLocal(JsonObject(emptyMap()))
            }
            previous
        }
        try {
            // Before waiting for any pump: a sign-out that outlives its bounds, or a process that exits, must not
            // leave the snapshot on disk.
            withContext(Dispatchers.IO) { runCatching { st.file.remove() } }
            withContext(st.dispatcher) {
                if (st.live) {
                    pump.awaitDone(SYNC_PUMP_WAIT_MS)
                    old?.let { pump.emit(it) }
                }
            }
        } finally {
            withContext(Dispatchers.IO) {
                st.file.remove()
                st.file.sweepTemporaries()
            }
            withContext(st.dispatcher) { st.purging = false }
        }
    }

    override suspend fun resume() {
        withContext(st.dispatcher) { st.purged = false }
    }

    override suspend fun offerLocal(values: JsonObject): Boolean = withContext(st.dispatcher) {
        val done = withContext(Dispatchers.IO) { st.file.imported() }
        checkNotNull(st.machine) { "Cloud Sync host: start() has not run" }.importLocal(if (done) JsonObject(emptyMap()) else values)
        !done
    }

    override suspend fun markImported() {
        withContext(Dispatchers.IO) { runCatching { st.file.markImported() } }
    }

    override suspend fun importLocalOnce(values: JsonObject) {
        withContext(st.dispatcher) {
            val done = withContext(Dispatchers.IO) { st.file.imported() }
            checkNotNull(st.machine) { "Cloud Sync host: start() has not run" }.importLocal(if (done) JsonObject(emptyMap()) else values)
            if (!done) withContext(Dispatchers.IO) { runCatching { st.file.markImported() } }
        }
    }
}
