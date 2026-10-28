// How the machine reads the app's catalog (the setting routes) and the current document.

package im.plrs.key.core.sync

import im.plrs.key.core.arrayValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonObject

internal class MachineRouting(private val core: MachineCore) {
    private val settings: List<JsonObject> = core.opts.catalog["settings"].arrayValue.orEmpty().map { it as JsonObject }
    private val collections: List<JsonObject> = core.opts.catalog["collections"].arrayValue.orEmpty().map { it as JsonObject }
    val declared: List<JsonObject> get() = settings

    fun alias(key: String): String = core.s.aliases[key] ?: key

    fun route(key: String): JsonObject? =
        settings.firstOrNull { it["key"].stringValue == key } ?: alias(key).let { a -> settings.firstOrNull { it["key"].stringValue == a } }

    fun routeKind(key: String): String? = route(key)?.get("route").stringValue

    fun syncs(key: String): Boolean = routeKind(key).let { it == null || it == "synced" }

    fun policyOf(key: String): String = route(key)?.takeIf { it["route"].stringValue == "synced" }?.get("policy").stringValue ?: "lastWrite"

    fun schemaOf(key: String): JsonObject? = route(key)?.takeIf { it["route"].stringValue == "synced" }?.get("schema") as? JsonObject

    fun targetOf(key: String): OpTarget.Setting =
        OpTarget.Setting(key, route(key)?.takeIf { it["route"].stringValue == "synced" }?.get("scope").stringValue ?: "user")

    fun collection(name: String): JsonObject? = collections.firstOrNull { it["name"].stringValue == name }

    fun locked(key: String): Boolean = core.opts.document["locked"].arrayValue.orEmpty().any { it.stringValue == key }

    fun documentValue(key: String) = (core.opts.document["values"] as? JsonObject)?.get(key)
}
