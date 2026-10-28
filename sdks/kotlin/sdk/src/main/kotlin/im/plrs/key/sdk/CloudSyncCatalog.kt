// The Cloud Sync host's catalog (H-1, H-2): the app's compiled mirror is authoritative, a served
// catalog is vetted and may only add keys, and it is never persisted as the routes' source.

package im.plrs.key.sdk

import im.plrs.key.core.SYNC_KEY_PATTERN
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncRoutes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The most entries and bytes of a catalog the host will route by. */
public const val MAX_CATALOG_ENTRIES: Int = 1024
public const val MAX_CATALOG_BYTES: Int = 1024 * 1024

/** A served catalog is fetched again at most this often (the first fetch is free), in milliseconds. */
public const val CATALOG_REFETCH_MS: Long = 5 * 60_000L

internal val EMPTY_CATALOG: JsonObject = JsonObject(mapOf("schemaVersion" to JsonPrimitive(0), "entries" to JsonArray(emptyList())))

internal object CloudSyncCatalog {
    private val syncKey = Regex(SYNC_KEY_PATTERN)

    /** The routes of [catalog], without any mode the catalog states (the app decides the mode, A-7). */
    fun routesOf(catalog: JsonObject): List<JsonObject> = SyncRoutes.syncedSettings(catalog).map { JsonObject(it - "encryption") }

    /**
     * A catalog fit to route by: the right shape and size, every entry key a valid sync key, and one entry
     * per key. Null when it is not.
     */
    fun vetted(c: JsonObject?): JsonObject? {
        val entries = c?.get("entries").arrayValue
        val tooBig = c == null || entries == null || entries.size > MAX_CATALOG_ENTRIES || c.toString().length > MAX_CATALOG_BYTES
        if (tooBig || !isCatalogShape(c)) return null
        val seen = hashSetOf<String>()
        val kept = entries!!.filter { e ->
            val k = (e as? JsonObject)?.get("key").stringValue
            k != null && syncKey.matches(k) && seen.add(k)
        }
        val out = JsonObject(c!! + ("entries" to JsonArray(kept)))
        return if (runCatching { routesOf(out) }.isSuccess) out else null
    }

    /**
     * The routes' catalog: the mirror as it is, plus served entries only for keys the mirror does not name
     * and the person's own open settings do not use. The Worker's catalog never changes a route the app
     * compiled in, and never turns an open setting into a declared one.
     */
    fun effective(mirror: JsonObject?, served: JsonObject?, openKeys: Set<String>): JsonObject {
        val mine = mirror?.get("entries").arrayValue.orEmpty()
        val taken = mine.mapNotNull { (it as JsonObject)["key"].stringValue }.toSet()
        val extra = served?.get("entries").arrayValue.orEmpty()
            .filter {
                val k = (it as JsonObject)["key"].stringValue
                k !in taken && k !in openKeys
            }
        val base = mirror ?: served ?: EMPTY_CATALOG
        val version = (served ?: mirror)?.get("schemaVersion").longValue ?: 0L
        return JsonObject(base + mapOf("schemaVersion" to JsonPrimitive(version), "entries" to JsonArray(mine + extra)))
    }
}
