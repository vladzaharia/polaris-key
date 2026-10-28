// Cloud Sync setting routes and the `user` block rules: a native port of
// `packages/shared-catalog/src/cloudSync.ts` (`syncedSettings`, `settingRoute`; the `user` rules are in SyncUserSetting.kt)
// by way of the Python `routes.py`. The corpus pins it: `sync-scenarios.json`'s
// `settingCases`. Entries are plain JSON objects, as a catalog document carries them.

package im.plrs.key.core.sync

import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

public object SyncRoutes {
    public val USER_SETTING_SYNC_SCOPES: List<String> = listOf("user", "platform", "local")
    public val USER_SETTING_CONFLICTS: List<String> = listOf("lastWrite", "max", "min", "merge")
    public val CLOUD_SYNC_ENCRYPTION_MODES: List<String> = listOf("e2e", "server")

    internal val lockedDefaults = setOf("enforced", "hidden")

    internal fun JsonElement?.orNullIfNull(): JsonElement? = if (this is JsonNull) null else this

    /** A catalog's effective mode: its declaration, else `e2e`. */
    public fun cloudSyncEncryption(catalog: JsonObject): String =
        if (catalog["cloudSync"].objectValue?.get("encryption").stringValue == "server") "server" else "e2e"

    /** Whether a `config` entry is Editable: no `managementDefault` locks it. */
    public fun isEditable(entry: JsonObject): Boolean = entry["managementDefault"].stringValue !in lockedDefaults

    /** One entry's route: `refused`, `locked`, `local` or `synced` (see [syncedSettings]). */
    public fun settingRoute(entry: JsonObject): JsonObject {
        val key = entry.getValue("key")
        val user = entry["user"].orNullIfNull().objectValue ?: JsonObject(emptyMap())
        val sync = user["sync"].orNullIfNull() ?: JsonPrimitive("user")
        return when {
            entry["kind"].stringValue != "config" -> plain(key, "refused")
            !isEditable(entry) -> plain(key, "locked")
            sync.stringValue == "local" -> plain(key, "local")
            else -> synced(entry, key, user, sync)
        }
    }

    private fun synced(entry: JsonObject, key: JsonElement, user: JsonObject, sync: JsonElement): JsonObject = buildJsonObject {
        put("key", key)
        put("route", "synced")
        put("scope", sync)
        put("policy", user["conflict"].orNullIfNull() ?: JsonPrimitive("lastWrite"))
        put("listed", user["listed"].orNullIfNull() ?: JsonPrimitive(true))
        entry["schema"]?.let { put("schema", it) }
    }

    private fun plain(key: JsonElement, route: String): JsonObject = buildJsonObject {
        put("key", key)
        put("route", route)
    }

    /**
     * One route per declared key, in catalog order. A catalog that carries its `cloudSync` block gets the
     * mode on every route; one that hands over entries only gets the routes alone.
     */
    public fun syncedSettings(catalog: JsonObject): List<JsonObject> {
        val routes = (catalog["entries"].arrayValue ?: JsonArray(emptyList())).map { settingRoute(it as JsonObject) }
        if (!catalog.containsKey("cloudSync")) return routes
        val mode = cloudSyncEncryption(catalog)
        return routes.map { r -> JsonObject(r + ("encryption" to JsonPrimitive(mode))) }
    }
}
