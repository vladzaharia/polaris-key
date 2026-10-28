// The machine's local edits: `set`, `clear`, the one-time import of the legacy store, `flush` and
// `refresh` (Python `set`, `clear`, `import_local`, `flush`, `refresh`, `_edit`).

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_DEBOUNCE_MS
import im.plrs.key.core.SYNC_IMPORT_HLC
import im.plrs.key.core.SYNC_MAX_VALUE_BYTES
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The calls an app makes while Cloud Sync is on. */
public interface SyncEdits {
    /** `config.set`. */
    public fun set(key: String, value: JsonElement): CallResult

    /** `config.clear`. */
    public fun clear(key: String): CallResult

    /**
     * Once per install, with the legacy `config.local` contents. Synced and undeclared keys enter at the
     * HLC floor, so a newer cloud value always wins; `local` keys stay on the device. A second call does nothing.
     */
    public fun importLocal(values: JsonObject): CallResult

    /** Commit every debounced edit now and push. */
    public fun flush(): CallResult

    /** A licence or config document fetch succeeded: the only thing that lifts a `/sync` 401 or a non-`account_required` 403. */
    public fun refresh(): CallResult
}

internal class MachineEdits(private val p: MachineParts) : SyncEdits {
    private val core get() = p.core
    private val routing get() = p.routing

    override fun set(key: String, value: JsonElement): CallResult = edit(key, value, false)

    override fun clear(key: String): CallResult = edit(key, null, true)

    /** Journals nothing on a refusal: `bad_request` for a secret or flag key or a bad value, `managed_by_admin` for a lock. */
    private fun edit(key: String, value: JsonElement?, clear: Boolean): CallResult {
        val kind = routing.routeKind(key)
        val refusal = when {
            kind == "refused" -> "bad_request"
            kind == "locked" || routing.locked(key) -> "managed_by_admin"
            !clear && invalid(key, kind, value!!) -> "bad_request"
            else -> null
        }
        if (refusal != null) return CallResult.Failed(refusal)
        val before = p.layers.valueMap()
        if (kind == "local") {
            if (clear) core.s.deviceLocal.remove(key) else core.s.deviceLocal[key] = value!!
        } else {
            core.drafts[key] = Draft(value, clear, p.journal.tickHlc(), !core.s.contacted, core.now + SYNC_DEBOUNCE_MS)
        }
        p.layers.emitChanges(before, emptyMap(), "local")
        return CallResult.Ok
    }

    private fun invalid(key: String, kind: String?, value: JsonElement): Boolean =
        (kind == "synced" && !SyncValues.valueValid(value, routing.schemaOf(key))) || SyncJson.jsonBytes(value) > SYNC_MAX_VALUE_BYTES

    override fun importLocal(values: JsonObject): CallResult {
        if (core.s.imported) return CallResult.Ok
        core.s.imported = true
        val before = p.layers.valueMap()
        for (key in values.keys.sorted()) importOne(key, values.getValue(key))
        p.layers.emitChanges(before, emptyMap(), "local")
        p.pump.kick()
        return CallResult.Ok
    }

    private fun importOne(key: String, value: JsonElement) {
        val kind = routing.routeKind(key)
        val skip = kind == "locked" || kind == "refused" || invalid(key, kind, value)
        when {
            skip -> Unit

            kind == "local" -> core.s.deviceLocal.putIfAbsent(key, value)

            core.s.subject == null ->
                core.partitionFor(LOCAL_PARTITION).device.putIfAbsent(key, DeviceEntry(value, false, SYNC_IMPORT_HLC, false))

            else -> p.journal.enqueueSetting(core.active(), key, value, SYNC_IMPORT_HLC, Marks(moved = true))
        }
    }

    override fun flush(): CallResult {
        p.journal.commitAllDrafts()
        p.pump.kick()
        return CallResult.Ok
    }

    override fun refresh(): CallResult {
        if (core.s.blocked in listOf("unauthorized", "attestation", "forbidden")) {
            core.s.blocked = null
            p.pump.kick()
        }
        return CallResult.Ok
    }
}
