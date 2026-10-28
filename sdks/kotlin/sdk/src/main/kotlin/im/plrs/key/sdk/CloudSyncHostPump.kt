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
import kotlinx.coroutines.withTimeoutOrNull

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
        val generation = st.generation
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
            drain(m, generation)
            emit(m)
            // Saving commits the debounced edits (`persist()`), so a pass that exchanged nothing leaves the file
            // alone and an edit keeps its debounce window. The save is inside the loop: a touch that lands while
            // it runs sets `again` and the pass repeats, so no wake-up is lost (H-9).
            if (st.used > 0 && st.generation == generation) save()
        } while (st.again && st.used < SYNC_MAX_EXCHANGES && st.generation == generation)
    }

    private suspend fun drain(m: CloudSyncMachine, generation: Long) {
        while (st.used < SYNC_MAX_EXCHANGES && st.generation == generation) {
            val reqs = m.takeRequests()
            if (reqs.isEmpty()) return
            for (req in reqs) {
                st.used += 1
                exchanges.exchange(m, req)
                // A purge ran during the exchange: the rest of the batch belongs to a machine that is gone.
                if (st.generation != generation) return
            }
        }
    }

    /**
     * New catalog or document: the machine is rebuilt from its own journal (never mid-request). Every await comes
     * first; the snapshot and the construction then run with no suspension between them, so an accepted `set` is
     * in the snapshot or in the new machine. A purge that ran meanwhile drops the rebuild (generation).
     */
    private suspend fun rebuild() {
        st.rebuildWanted = false
        val generation = st.generation
        val document = st.deps.document()
        val discovery = st.deps.discovery()
        if (st.generation != generation || st.purging) return
        val old = machine()
        val persisted = old.persist()
        val events = old.takeEvents()
        builder.buildNow(persisted, document, discovery)
        deliver(events)
        save()
    }

    /** Events are delivered on a worker context, never while holding the host's dispatcher: a listener may block on the host (H-8). */
    suspend fun emit(m: CloudSyncMachine) = deliver(m.takeEvents())

    suspend fun deliver(events: List<im.plrs.key.core.sync.SyncEvent>) {
        if (events.isEmpty()) return
        val listeners = st.listeners.toList()
        withContext(Dispatchers.Default) { for (fn in listeners) runCatching { fn(events) } }
    }

    /** Persist the journal. Committing the debounced edits is what `persist()` does by contract. The file never holds the root. */
    suspend fun save(persisted: MachineState? = null) {
        val snapshot = MachineStateJson.encode(persisted ?: machine().persist())
        val keys = st.openKeys.toList()
        // Failing to persist never fails the call that produced it. After a purge nothing is saved (H-7).
        if (!st.purged) withContext(Dispatchers.IO) { runCatching { st.file.save(snapshot, null, keys) { !st.purged } } }
    }

    private fun retryDue(): Boolean = !st.retryArmed && !st.closed && st.failures in 1..SYNC_MAX_RETRIES

    /** Waits for the pump that is running (and the re-runs it owes), at most [maxMs]. */
    suspend fun awaitDone(maxMs: Long) {
        val running = withContext(st.dispatcher) { st.pumpDone }
        if (running != null) withTimeoutOrNull(maxMs) { running.await() }
    }

    /** After a transport failure: re-kick the machine after a bounded, jittered delay, at most [SYNC_MAX_RETRIES] times. */
    fun armRetry() {
        if (!retryDue()) return
        st.retryArmed = true
        val wait = st.deps.retryDelayMs(st.failures)
        scope.launch {
            delay(wait)
            st.retryArmed = false
            val m = st.machine
            if (st.live && m != null && m.networkState == "online") m.setNetwork("online")
            touch()
        }
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
