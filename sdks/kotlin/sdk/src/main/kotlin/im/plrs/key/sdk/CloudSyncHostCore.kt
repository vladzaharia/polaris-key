// The Cloud Sync host's collaborators, built once: the one-thread dispatcher, the shared state, the
// exchange, builder, pump and data calls, and the JVM shutdown hook.

package im.plrs.key.sdk

import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.SYNC_SIGNOUT_FLUSH_MS
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.lang.ref.WeakReference

@OptIn(ExperimentalCoroutinesApi::class)
internal class CloudSyncHostCore(deps: CloudSyncHostDeps, opts: CloudSyncHostOptions) {
    val dispatcher = Dispatchers.Default.limitedParallelism(1)
    val scope = CoroutineScope(SupervisorJob() + dispatcher)
    val st = CloudSyncHostState(deps, opts, dispatcher)

    /** Bound by the host once it exists: the collaborators call back into `touch`. */
    var touchFn: suspend () -> Unit = {}
    private val touch: suspend () -> Unit = { touchFn() }
    val exchanges = CloudSyncHostExchange(st)
    val builder = CloudSyncHostBuilder(st, scope, touch)
    val pump = CloudSyncHostPump(st, exchanges, builder, scope, touch)
    val data: CloudSyncHostData = CloudSyncHostDataImpl(st, builder, pump)

    /** A bounded, daemon JVM shutdown hook that flushes. Android's lifecycle does that job there (K10). */
    fun installShutdownHook(flush: suspend (Long) -> Unit, host: Any) {
        if (!st.deps.shutdownHook || RuntimeFamily.isAndroid || st.shutdownHook != null) return
        val ref = WeakReference(host)
        val hook = Thread(
            {
                if (ref.get() != null) runBlocking { withTimeoutOrNull(SYNC_SIGNOUT_FLUSH_MS.toLong()) { flush(SYNC_SIGNOUT_FLUSH_MS.toLong()) } }
            },
            "pkey-sync-flush",
        )
        hook.isDaemon = true
        st.shutdownHook = hook
        Runtime.getRuntime().addShutdownHook(hook)
    }

    fun removeShutdownHook() {
        st.shutdownHook?.let { hook -> runCatching { Runtime.getRuntime().removeShutdownHook(hook) } }
        st.shutdownHook = null
    }
}
