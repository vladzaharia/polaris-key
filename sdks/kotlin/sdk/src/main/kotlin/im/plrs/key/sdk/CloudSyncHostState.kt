// The Cloud Sync host's shared state and its catalog and open-key bookkeeping (H-1, H-2, H-5). Every
// field is read and written only on the host's one-thread dispatcher.

package im.plrs.key.sdk

import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.CloudSyncMachine
import im.plrs.key.core.sync.OpenedBody
import im.plrs.key.core.sync.SyncEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

internal class CloudSyncHostState(val deps: CloudSyncHostDeps, val opts: CloudSyncHostOptions, val dispatcher: CoroutineDispatcher) {
    val file = CloudSyncStateFile(deps.stateDir, deps.product)
    var machine: CloudSyncMachine? = null
    var detach: (() -> Unit)? = null

    /** The catalog compiled into the app: authoritative for every key it names. */
    var mirror: JsonObject? = null

    /** The last catalog the Worker served: it may only add keys the mirror lacks. */
    var served: JsonObject? = null
    var catalog: JsonObject = EMPTY_CATALOG
    var routes: List<JsonObject> = emptyList()
    val openKeys: LinkedHashSet<String> = linkedSetOf()
    var documentJson: String = ""

    /** The document and discovery the machine was last built from: a purge rebuilds from these without awaiting. */
    var documentValue: JsonObject = EMPTY_CATALOG
    var discoveryValue: im.plrs.key.core.sync.SyncDiscovery? = null

    /** True from the start of a purge until it ends: no pump runs and no rebuild happens meanwhile (H-7). */
    var purging: Boolean = false
    var lastFetchAt: Long? = null
    var triedVersion: Long? = null
    var used: Int = 0
    var rebuildWanted: Boolean = false
    var again: Boolean = false
    var pumping: Boolean = false
    var building: Boolean = false
    var rootPending: Boolean? = null

    /** Bumped by every purge: an exchange or a pump that began under an older value drops its answer and never saves (H-7). */
    var generation: Long = 0

    /** After a purge the journal stays unsaved until a principal signs in again (H-7). */
    @Volatile var purged: Boolean = false

    /** Completes when the running pump (and every re-run it owes) ends; null while none runs (H-9). */
    var pumpDone: CompletableDeferred<Unit>? = null

    /** Consecutive transport failures, for the bounded retry; reset by any answer. */
    var failures: Int = 0
    var retryArmed: Boolean = false
    var shutdownHook: Thread? = null
    var started: Boolean = false
    var closed: Boolean = false
    val listeners: MutableList<(List<SyncEvent>) -> Unit> = mutableListOf()

    val live: Boolean get() = started && !closed

    fun declared(): Set<String> = routes.mapNotNull { it["key"].stringValue }.toSet()

    /** Names of the person's open settings, newest last, at most [OPEN_KEYS_MAX]. */
    fun addOpenKey(name: String) {
        openKeys.remove(name)
        openKeys.add(name)
        while (openKeys.size > OPEN_KEYS_MAX) openKeys.remove(openKeys.first())
    }

    /** The host's own mutations name open keys: any setting the routes do not declare (H-5). */
    fun noteOwnMutations(mutations: JsonArray?) {
        val declared = declared()
        for (m in mutations.orEmpty()) {
            val setting = ((m as? JsonObject)?.get("target") as? JsonObject)?.get("setting").stringValue
            if (setting != null && setting !in declared) addOpenKey(setting)
        }
    }

    /**
     * Names from rows this host opened sealed: a served name, an unopened row or a plaintext row never
     * enters the set, so a Worker cannot fill it to push real names out (H-5).
     */
    fun noteOpenedRows(body: JsonElement, opened: OpenedBody) {
        val changes = (body as? JsonObject)?.get("changes") as? JsonArray ?: return
        val declared = declared()
        changes.forEachIndexed { i, c ->
            val setting = (c as? JsonObject)?.get("setting").stringValue
            if (opened.changes.getOrNull(i)?.sealed == true && setting != null && setting !in declared) addOpenKey(setting)
        }
    }
}

private fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()
