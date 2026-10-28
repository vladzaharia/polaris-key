// Builds the Cloud Sync host's machine from the journal, the catalog and the document, and attaches it
// to the key ring (Python `_build`).

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.CloudSyncOptions
import im.plrs.key.core.sync.MachineState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.security.SecureRandom

private const val CLIENT_ID_BYTES = 16

internal class CloudSyncHostBuilder(private val st: CloudSyncHostState, private val scope: CoroutineScope, private val touch: suspend () -> Unit) {
    private val random = SecureRandom()

    private fun newClientId(): String = "c_" + Base64Url.encode(ByteArray(CLIENT_ID_BYTES).also { random.nextBytes(it) })

    /** (Re)build the machine from the journal, the catalog and the document. */
    suspend fun build(persisted: MachineState?) {
        st.detach?.invoke()
        st.detach = null
        st.catalog = CloudSyncCatalog.effective(st.mirror, st.served, st.openKeys)
        st.routes = CloudSyncCatalog.routesOf(st.catalog)
        val document = st.deps.document()
        st.documentJson = document.toString()
        val opts = CloudSyncOptions(st.deps.product, JsonObject(mapOf("settings" to JsonArray(st.routes))), document, st.deps.clock(), ::newClientId)
        opts.encryption = st.opts.encryption
        opts.hasRoot = st.deps.keyringUnlocked()
        val m = CloudSyncMachine(opts, persisted)
        st.machine = m
        applyDiscovery(m)
        st.building = true
        try {
            st.detach = st.deps.attachKeyring(RootFeed())
        } finally {
            st.building = false
        }
        st.rootPending = null
    }

    suspend fun applyDiscovery(m: CloudSyncMachine) {
        st.deps.discovery()?.let { m.setDiscovery(it) }
    }

    /** Called by the key ring under its own lock: record it, and let the dispatcher apply it. */
    private inner class RootFeed : SyncRootListener {
        override fun setRoot(present: Boolean) {
            scope.launch {
                st.rootPending = present
                if (!st.building) touch()
            }
        }
    }
}
