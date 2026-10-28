package im.plrs.key.sdk

import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.MachineStateJson
import im.plrs.key.core.sync.SyncEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext

@OptIn(ExperimentalCoroutinesApi::class)
public class CloudSyncHost(deps: CloudSyncHostDeps, opts: CloudSyncHostOptions = CloudSyncHostOptions()) {
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val st = CloudSyncHostState(deps, opts, dispatcher)
    private val exchanges = CloudSyncHostExchange(st)
    private val builder = CloudSyncHostBuilder(st, scope, ::touch)
    private val pump = CloudSyncHostPump(st, exchanges, builder, scope, ::touch)

    /** Run [block] on the machine, on the host's dispatcher (the machine is not thread-safe). */
    public suspend fun <T> withMachine(block: (CloudSyncMachine) -> T): T =
        withContext(dispatcher) { block(checkNotNull(st.machine) { "Cloud Sync host: start() has not run" }) }

    /** Subscribe to the machine's events (batches, in order). Returns an unsubscribe function. */
    public fun onEvents(fn: (List<SyncEvent>) -> Unit): () -> Unit {
        st.listeners.add(fn)
        return { st.listeners.remove(fn) }
    }

    /**
     * Load the saved journal and catalog, build the machine and attach it to the key ring. Idempotent. Makes
     * no request unless a catalog has to be fetched (none cached and none compiled in).
     */
    public suspend fun start() {
        withContext(dispatcher) {
            if (st.started || st.closed) return@withContext
            st.started = true
            val saved = withContext(Dispatchers.IO) { st.file.load() }
            st.openKeys.addAll(saved.openKeys)
            st.mirror = CloudSyncCatalog.vetted(st.opts.catalog)
            st.served = CloudSyncCatalog.vetted(saved.catalog)
            builder.build(MachineStateJson.decode(saved.persisted))
            if (saved.catalog == null && st.opts.catalog == null) exchanges.refetch(null)
        }
        touch()
    }

    /** Discovery just loaded: tell the machine what `services.sync` says. */
    public suspend fun noteDiscovery() {
        withContext(dispatcher) { st.machine?.let { builder.applyDiscovery(it) } }
        touch()
    }

    /** The signed config document refreshed: lift a block, and rebuild if the document changed. */
    public suspend fun noteDocumentRefreshed() {
        withContext(dispatcher) {
            val m = st.machine ?: return@withContext
            m.refresh()
            if (st.deps.document().toString() != st.documentJson) st.rebuildWanted = true
        }
        touch()
    }

    /** Bring the machine's clock to the real one, so an edit made now is stamped and debounced from now. */
    public suspend fun catchUp() {
        withContext(dispatcher) {
            val m = st.machine ?: return@withContext
            val dt = st.deps.clock() - m.now
            if (dt > 0) m.advance(dt)
        }
    }

    /** Run the machine now: advance its clock, exchange every queued request, save. Never throws. */
    public suspend fun touch() {
        withContext(dispatcher) {
            if (!st.live || !st.deps.syncEnabled()) return@withContext
            if (st.pumping) {
                // A caller reacting from inside the pump: the pump runs again after it.
                st.again = true
                return@withContext
            }
            st.pumping = true
            val failure = try {
                runCatching { pump.run() }.exceptionOrNull()
            } finally {
                st.pumping = false
            }
            if (failure is CancellationException) throw failure
            pump.arm()
        }
    }

    /** Stop the timer and the key-ring attachment; save the journal. Safe to call more than once. */
    public suspend fun close() {
        withContext(dispatcher) {
            if (st.closed) return@withContext
            val was = st.live
            st.closed = true
            st.detach?.invoke()
            st.detach = null
            if (was && st.machine != null) pump.save()
        }
        scope.cancel()
    }
}
