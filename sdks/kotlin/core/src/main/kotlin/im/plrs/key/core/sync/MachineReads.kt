// The machine's reads: a key's value and state, the status, and the normalised journal.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A key's value and where it came from (`document`, `device`, `pending` or `cloud`). */
public data class ReadResult(val value: JsonElement, val from: String) {
    public fun toJson(): JsonObject = buildJsonObject {
        put("value", value)
        put("from", from)
    }
}

/** A key's sync state, whether its value is invalid, and whether it is locked. */
public data class SettingState(val sync: String, val invalid: Boolean, val locked: Boolean) {
    public fun toJson(): JsonObject = buildJsonObject {
        put("sync", sync)
        put("invalid", invalid)
        put("locked", locked)
    }
}

/** What the machine reports. */
public interface SyncReads {
    public fun get(key: String): ReadResult

    public fun settingState(key: String): SettingState

    public fun status(): SyncStatus

    /** The journal, normalised: what every SDK's journal must hold, whatever its encoding. */
    public fun journal(): JsonObject

    /** The effective mode: E2E when the app requires it or this device has ever accepted E2E. */
    public fun encryptionMode(): String

    /** `encryptionSince` of the active partition's last E2E pull, or null. */
    public fun encryptionSince(): Long?
}

internal class MachineReads(private val p: MachineParts) : SyncReads {
    private val core get() = p.core
    private val routing get() = p.routing

    override fun get(key: String): ReadResult {
        val doc = ReadResult(routing.documentValue(key) ?: JsonNull, "document")
        val kind = routing.routeKind(key)
        val layer = if (kind == "local") null else p.layers.layer(key)
        val value = layer?.value
        return when {
            // A lock beats the person's own choice, the `local` slot included.
            routing.locked(key) || kind == "locked" || kind == "refused" -> doc

            kind == "local" -> core.s.deviceLocal[key]?.let { ReadResult(it, "device") } ?: doc

            value == null || !SyncValues.valueValid(value, routing.schemaOf(key)) -> doc

            else -> ReadResult(value, layer.from)
        }
    }

    override fun settingState(key: String): SettingState {
        val kind = routing.routeKind(key)
        val layer = if (routing.syncs(key)) p.layers.layer(key) else null
        val sync = when {
            core.s.subject == null || kind == "local" -> "local"
            layer != null && layer.pending -> "pending"
            else -> "synced"
        }
        val badValue = layer?.value?.let { !SyncValues.valueValid(it, routing.schemaOf(key)) } == true
        val unreadable = routing.syncs(key) && p.layers.snapshotUnreadable(routing.alias(key)) && layer?.pending != true
        return SettingState(sync, badValue || unreadable, routing.locked(key) || kind == "locked")
    }

    fun pendingCount(): Int {
        if (core.s.subject == null) return core.drafts.size
        val part = core.active()
        return core.drafts.size + part.pending.size + part.held.size
    }

    /** What a push can still carry: every journalled operation that is not parked, plus held. */
    fun sendable(part: SyncPartition): Int = part.pending.count { it.parked == null } + part.held.size

    private fun parkedReason(): String? {
        if (core.s.subject == null) return null
        val kinds = core.active().pending.mapNotNull { it.parked }
        return listOf("quota", "entitlement").firstOrNull { it in kinds }
    }

    override fun status(): SyncStatus {
        val pending = pendingCount()
        val blocked = core.s.blocked
        return when {
            core.pinnedOut() -> SyncStatus(SyncState.Unsupported, pending, "encryption", ErrorCode.syncEncryptionPinned)
            blocked != null -> SyncStatus(SyncState.Blocked, pending, blocked)
            core.s.subject == null -> SyncStatus(SyncState.Local, pending)
            core.lockedOut() -> SyncStatus(SyncState.Locked, pending, "keyring")
            else -> SyncStatus(liveState(pending), pending, parkedReason())
        }
    }

    private fun liveState(pending: Int): SyncState = when {
        core.network == "offline" -> SyncState.Offline
        core.inFlight != null -> SyncState.Syncing
        core.paused -> SyncState.Paused
        pending > 0 -> SyncState.Pending
        else -> SyncState.Idle
    }

    override fun journal(): JsonObject {
        val out = linkedMapOf<String, JsonElement>()
        for (name in core.s.partitions.keys.sorted()) {
            val part = core.s.partitions.getValue(name)
            if (name == LOCAL_PARTITION) {
                if (part.device.isNotEmpty()) out[name] = buildJsonObject { put("settings", JsonObject(part.device.mapValues { it.value.toJson() })) }
                continue
            }
            out[name] = buildJsonObject {
                put("clientId", part.clientId?.let { JsonPrimitive(it) } ?: JsonNull)
                put("nextMutationId", part.nextMutationId)
                put("cursor", part.cursor)
                put("pending", JsonArray(part.pending.map { it.toJson() }))
                if (part.held.isNotEmpty()) put("held", JsonObject(part.held))
            }
        }
        return JsonObject(out)
    }

    override fun encryptionMode(): String = if (core.requiresE2e()) "e2e" else "server"

    override fun encryptionSince(): Long? = if (core.s.subject == null) null else core.active().encryptionSince
}
