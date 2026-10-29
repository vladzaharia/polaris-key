// The Cloud Sync host (U-07.K6, bounds U-07.K7): the first production host of `CloudSyncMachine`. A port of
// Python's `cloud_sync/host.py` and the Swift host, with every SEC-SYNC-HOST fix. The machine does no I/O;
// this class is everything around it:
//
//  - one machine per client, built from app code (`CloudSyncHostOptions.encryption`, default `e2e`), the
//    discovery `services.sync` member, the key ring (`attach`) and the product catalog;
//  - H-1, H-2: the app's compiled mirror is authoritative; a served catalog is vetted, only adds routes,
//    is fetched again on a changed `catalogVersion` at most every five minutes (server-mode pulls
//    included) and an equal rebuild is skipped (see [CloudSyncCatalog], [CloudSyncHostExchange]);
//  - H-3, H-4: every request goes through [CloudSyncTransport] (bearer, `X-PKey-*`, no redirect, 8 MiB
//    cap, 15 s); in E2E mode through `HostCodec` on the way out and in;
//  - H-5: open-setting names come only from rows opened sealed and from the host's own mutations (4096);
//  - H-6: the journal is written to `<state dir>/cloud-sync.json` ([CloudSyncStateFile]);
//  - H-7: [purge] deletes the file first, a generation counter makes an in-flight pump drop its answer and
//    never save, the machine is rebuilt empty and the file is deleted again;
//  - H-8: events are delivered on a worker context, so a listener that blocks on the host cannot deadlock
//    it, and a `touch` from a listener sets `again`: one pump, one more pass;
//  - H-9: [flush] is bounded, the trailing touch included, and the pump saves inside its loop so a touch
//    that lands as it ends is not lost;
//  - H-10: a locked ring sends and reads nothing and the host adds no request of its own; an E2E 200 that
//    is not an object is dropped; an answer the codec cannot open is dropped and the cursor stays;
//  - HOST-BIND (A-1): a request bound to a person other than the session's is dropped, before the send
//    and after the answer;
//  - a transport failure is retried after a bounded, jittered delay, at most [SYNC_MAX_RETRIES] times.
//
// Concurrency: the host runs on one single-thread dispatcher, so the machine and every field are
// confined to it; a suspended HTTP exchange frees it, so no lock is ever held across the network. One
// pump runs at a time: a `touch` that arrives during a pump sets `again` and returns. At most
// [SYNC_MAX_EXCHANGES] exchanges per pump. Nothing in the licence path imports this file.

package im.plrs.key.sdk

import im.plrs.key.core.SYNC_SIGNOUT_FLUSH_MS
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.MachineStateJson
import im.plrs.key.core.sync.SyncEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

private const val SAVE_AFTER_DEADLINE_MS = 250L

public class CloudSyncHost private constructor(private val core: CloudSyncHostCore) : CloudSyncHostData by core.data {
    public constructor(deps: CloudSyncHostDeps, opts: CloudSyncHostOptions = CloudSyncHostOptions()) : this(CloudSyncHostCore(deps, opts))

    private val st = core.st
    private val dispatcher = core.dispatcher

    init {
        core.touchFn = ::touch
    }

    /** Whether the JVM shutdown hook is installed. */
    internal val hasShutdownHook: Boolean get() = st.shutdownHook != null

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
            // The served catalog is never persisted: the compiled mirror is authoritative, and the Worker's is fetched again on start.
            core.builder.build(MachineStateJson.decode(saved.persisted))
            core.installShutdownHook({ flush(it) }, this@CloudSyncHost)
            // A locked ring adds no request of its own (H-10); otherwise one rate-limited fetch, counted like any other.
            if (st.opts.encryption != "e2e" || !st.deps.codec.locked) core.exchanges.refetch(null)
        }
        touch()
    }

    /** Discovery just loaded: tell the machine what `services.sync` says. */
    public suspend fun noteDiscovery() {
        withContext(dispatcher) { st.machine?.let { core.builder.applyDiscovery(it) } }
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

    /** Run a pass without waiting for it: a `set`, a sign-in or a nudge never awaits the whole pump (its exchanges can take as long as the network). */
    public fun kick() {
        core.scope.launch { touch() }
    }

    /**
     * Whether [start] has built the machine and the host is not closed. [start] marks itself started before its
     * journal load suspends, so a caller in that window must not reach [withMachine] yet.
     */
    public suspend fun isStarted(): Boolean = withContext(dispatcher) { st.live && st.machine != null }

    /**
     * A document that changed since the machine was built is routed through a rebuild first, so the locked
     * list the machine checks is the current one (A-6). A no-op when nothing changed. Never lifts a block:
     * only a fetch that succeeded does ([noteDocumentRefreshed]).
     */
    public suspend fun refreshDocumentIfChanged() {
        val changed = withContext(dispatcher) {
            if (st.machine == null || st.deps.document().toString() == st.documentJson) return@withContext false
            st.rebuildWanted = true
            true
        }
        if (changed) touch()
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
            if (!st.live || st.purging || !st.deps.syncEnabled()) return@withContext
            if (st.pumping) {
                // A caller reacting from inside the pump: the pump runs again after it.
                st.again = true
                return@withContext
            }
            st.pumping = true
            val done = CompletableDeferred<Unit>().also { st.pumpDone = it }
            val failure = try {
                runCatching { core.pump.run() }.exceptionOrNull()
            } finally {
                st.pumping = false
                st.pumpDone = null
                done.complete(Unit)
            }
            if (failure is CancellationException) throw failure
            core.pump.arm()
            core.pump.armRetry()
        }
    }

    /**
     * Send what is waiting and save, giving up (the journal is kept) after [maxMs]. Bounded, the trailing
     * touch included: a touch that lands as the pump ends still sends (H-9).
     */
    public suspend fun flush(maxMs: Long = SYNC_SIGNOUT_FLUSH_MS.toLong()) {
        if (!st.live) return
        withContext(dispatcher) { st.machine?.flush() }
        // One deadline for the pass and the save (the sign-out bound is not doubled); the save runs on the host's
        // dispatcher, where the machine and the open keys are confined.
        val done = withTimeoutOrNull(maxMs) {
            touch()
            core.pump.awaitDone(maxMs)
            touch()
            withContext(dispatcher) { core.pump.save() }
        }
        // Past the deadline the journal is still kept: a short save of what the machine holds.
        if (done == null) withTimeoutOrNull(SAVE_AFTER_DEADLINE_MS) { withContext(dispatcher) { core.pump.save() } }
    }

    /** What the shutdown hook runs: a flush bounded by the sign-out flush bound. */
    internal suspend fun shutdownFlush() = flush(SYNC_SIGNOUT_FLUSH_MS.toLong())

    /** Stop the timers, the shutdown hook and the key-ring attachment; wait (bounded) for a running pump, then save. Safe to call twice. */
    public suspend fun close() {
        val was = withContext(dispatcher) {
            val live = st.live
            st.closed = true
            live
        }
        core.pump.awaitDone(SYNC_PUMP_WAIT_MS)
        withContext(dispatcher) {
            st.detach?.invoke()
            st.detach = null
            core.removeShutdownHook()
            if (was && st.machine != null) core.pump.save()
        }
        core.scope.cancel()
    }
}
