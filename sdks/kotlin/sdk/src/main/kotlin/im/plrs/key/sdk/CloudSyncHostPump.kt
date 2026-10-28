// The Cloud Sync host's pump: advance the machine's clock, exchange every queued request, deliver events,
// save, and arm the real-clock timer while the machine holds work.

package im.plrs.key.sdk

import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.MachineState
import im.plrs.key.core.sync.MachineStateJson
import im.plrs.key.core.sync.SyncState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** How often the real-clock timer wakes the machine while it holds work, in milliseconds. */
public const val SYNC_TICK_MS: Long = 250

internal class CloudSyncHostPump(
    private val st: CloudSyncHostState,
    private val exchanges: CloudSyncHostExchange,
    private val builder: CloudSyncHostBuilder,
    private val scope: CoroutineScope,
    private val touch: suspend () -> Unit,
) {
    private var timerArmed = false

    private fun machine(): CloudSyncMachine = checkNotNull(st.machine) { "Cloud Sync host: start() has not run" }

    suspend fun run() {
        st.used = 0
        do {
            st.again = false
            if (st.rebuildWanted) rebuild()
            val m = machine()
            st.rootPending?.let {
                st.rootPending = null
                m.setRoot(it)
            }
            val dt = st.deps.clock() - m.now
            if (dt > 0) m.advance(dt)
            drain(m)
            emit(m)
        } while (st.again && st.used < SYNC_MAX_EXCHANGES)
        // Saving commits the debounced edits (`persist()`), so a pump that exchanged nothing leaves the file
        // alone and an edit keeps its debounce window.
        if (st.used > 0) save()
    }

    private suspend fun drain(m: CloudSyncMachine) {
        while (st.used < SYNC_MAX_EXCHANGES) {
            val reqs = m.takeRequests()
            if (reqs.isEmpty()) return
            for (req in reqs) {
                st.used += 1
                exchanges.exchange(m, req)
            }
        }
    }

    /** New catalog or document: the machine is rebuilt from its own journal (never mid-request). */
    private suspend fun rebuild() {
        st.rebuildWanted = false
        val old = machine()
        val persisted = old.persist()
        emit(old)
        builder.build(persisted)
        save(persisted)
    }

    private fun emit(m: CloudSyncMachine) {
        val events = m.takeEvents()
        if (events.isEmpty()) return
        for (fn in st.listeners.toList()) runCatching { fn(events) }
    }

    /** Persist the journal. Committing the debounced edits is what `persist()` does by contract. The file never holds the root. */
    suspend fun save(persisted: MachineState? = null) {
        val snapshot = MachineStateJson.encode(persisted ?: machine().persist())
        val served = st.served
        val keys = st.openKeys.toList()
        // Failing to persist never fails the call that produced it.
        withContext(Dispatchers.IO) { runCatching { st.file.save(snapshot, served, keys) } }
    }

    /** The real-clock timer: wake while the machine holds work (an edit waiting out its debounce, a retry). */
    fun arm() {
        val m = st.machine
        if (timerArmed || st.closed || m == null) return
        val s = m.status()
        if (s.pending == 0 || s.state !in setOf(SyncState.Pending, SyncState.Syncing, SyncState.Paused)) return
        timerArmed = true
        scope.launch {
            delay(SYNC_TICK_MS)
            timerArmed = false
            touch()
        }
    }
}
