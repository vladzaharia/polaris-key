// Cloud Sync under `config` (U-07.K9): the port the client installs, and what the machine needs from the
// config client. While a principal is held and the port is `active`, `set` and `clear` go through the sync
// machine, the effective value of a synced key is the machine's, and `setting(key).sync()` reports where
// it stands. Without a port (no Sync service, no signed-in person) nothing here changes: `config.local`
// decides.

package im.plrs.key.config

import im.plrs.key.core.ManagementState
import im.plrs.key.core.JsonText
import im.plrs.key.core.sync.CallResult
import im.plrs.key.core.sync.ReadResult
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** `local` with Cloud Sync off, no signed-in person or a `local` key; `pending` while an edit waits to be sent; `synced` otherwise. */
public enum class SettingSyncState { local, pending, synced }

/** What the Cloud Sync API gives the config client. The machine answers the refusals in its own order (`bad_request`, then `managed_by_admin`). */
public interface ConfigSyncPort {
    /** Cloud Sync is on and a principal is signed in. */
    public suspend fun active(): Boolean

    public suspend fun set(key: String, value: JsonElement): CallResult

    public suspend fun clear(key: String): CallResult

    /** The machine's effective value; `from == "document"` means the signed document decides. */
    public suspend fun get(key: String): ReadResult?

    public suspend fun state(key: String): SettingSyncState
}

/** Install Cloud Sync's port (the client does, once the host runs). Not an app verb. */
public fun ConfigClient.useSync(port: ConfigSyncPort?) {
    syncPort = port
}

/** The legacy local values, for the one-time import into Cloud Sync. Not an app verb. */
public suspend fun ConfigClient.importable(): JsonObject = JsonObject(localValues())

/**
 * The machine changed these keys. The publish pass diffs the values and raises each change once; this names
 * where it came from. Not an app verb.
 */
public suspend fun ConfigClient.noteSyncChange(keys: List<String>, origin: String) {
    for (k in keys) {
        syncKeys += k
        syncOrigins[k] = origin
    }
    publish()
}

/** The signed config document's values and the keys it locks, for the Cloud Sync machine. Not an app verb. */
public suspend fun ConfigClient.syncDocument(): JsonObject {
    val entries = documentEntries()
    return JsonObject(
        mapOf(
            "values" to JsonObject(entries.mapValues { it.value.value }),
            "locked" to JsonArray(
                entries.filter { it.value.state == ManagementState.enforced || it.value.state == ManagementState.hidden }.keys.sorted().map { JsonPrimitive(it) },
            ),
        ),
    )
}

/** `GET /config/schema` as JSON, or null on any failure. Not an app verb. */
public suspend fun ConfigClient.schemaJson(): JsonObject? = fetchSchema()?.let { JsonText.parseOrNull(String(it, Charsets.UTF_8)) as? JsonObject }
