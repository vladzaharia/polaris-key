// The Cloud Sync client's shared types and JSON helpers (the Kotlin port of the Python machine's
// plain-data layer, U-07.K1). The state machine itself lands in later slices; everything here is
// pure data, with no I/O and no clock.
//
// Absent versus null (U-06.5, rule M-4): a `JsonElement?` that is Kotlin `null` is "no value"; JSON
// `null` is the value `JsonNull`. Numbers compare by value (`1` equals `1.0`) and a boolean is never a
// number. String order is UTF-16 code units, which is what `String.compareTo` does on the JVM.

package im.plrs.key.core.sync

import im.plrs.key.core.decimalValue
import im.plrs.key.core.jsonEquals
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The partition of a device nobody has signed in on. */
public const val LOCAL_PARTITION: String = "local"

/** The most keys a partition's "ever sealed" latch holds (E2E); the oldest go first. */
public const val SEALED_LATCH_MAX: Int = 4096

/** JSON helpers shared by the routes, the machine and the runner. */
public object SyncJson {
    /** Whether [v] is a JSON number with a finite value (a boolean is not a number). */
    public fun isNumber(v: JsonElement?): Boolean {
        if (v.decimalValue == null) return false
        return (v as JsonPrimitive).content.toDoubleOrNull()?.isFinite() == true
    }

    /** Whether [v] is a finite number with no fractional part (`2` and `2.0` both are). */
    public fun isInteger(v: JsonElement?): Boolean {
        val d = v.decimalValue
        return isNumber(v) && d != null && d.stripTrailingZeros().scale() <= 0
    }

    /** Structural equality as the scenarios mean it (M-4). */
    public fun jsonEqual(a: JsonElement?, b: JsonElement?): Boolean = jsonEquals(a, b)

    /** Object member names in UTF-16 code-unit order. */
    public fun sortedKeys(o: JsonObject): List<String> = o.keys.sorted()

    /** The canonical text of [v]: members in UTF-16 order, no whitespace, numbers as `JSON.stringify` spells them. */
    public fun canonical(v: JsonElement): String = CanonicalJson.encode(v)

    /**
     * The UTF-8 length of [v]'s canonical JSON (the 8 KiB setting bound). A value the canonical form
     * refuses (a lone surrogate, an integer over 2^53) is over every bound: it reports [Int.MAX_VALUE].
     */
    public fun jsonBytes(v: JsonElement): Int = runCatching { CanonicalJson.encodeBytes(v).size }.getOrDefault(Int.MAX_VALUE)
}

/** What a local call (`set`, `clear`, `put`, `add`, `remove`, `flush`, `refresh`) answers. */
public sealed interface CallResult {
    /** The call took effect. */
    public data object Ok : CallResult

    /** The call was refused with an error code. */
    public data class Failed(val error: String) : CallResult

    /** The corpus's `expect` form: `{"ok":true}` or `{"ok":false,"error":...}`. */
    public fun toJson(): JsonObject = when (this) {
        is Ok -> buildJsonObject { put("ok", true) }

        is Failed -> buildJsonObject {
            put("ok", false)
            put("error", error)
        }
    }
}

/** The state a machine reports, as the corpus spells it. */
public enum class SyncState(public val wire: String) {
    Idle("idle"),
    Pending("pending"),
    Syncing("syncing"),
    Offline("offline"),
    Paused("paused"),
    Blocked("blocked"),
    Local("local"),
    Locked("locked"),
    Unsupported("unsupported"),
}

/** The machine's status: the state, the unsynced count, and why it is parked, blocked, locked or pinned. */
public data class SyncStatus(val state: SyncState, val pending: Int, val reason: String? = null, val code: String? = null) {
    /** The corpus's `status` form; `reason` and `code` are absent when null. */
    public fun toJson(): JsonObject = buildJsonObject {
        put("state", state.wire)
        put("pending", pending)
        reason?.let { put("reason", it) }
        code?.let { put("code", it) }
    }
}

/** An event the machine would emit. Events name keys and counts only, never values (H-11). */
public sealed interface SyncEvent {
    /** The corpus's event form. */
    public fun toJson(): JsonObject

    /** Settings changed, with the origin of the change. */
    public data class Change(val keys: List<String>, val origin: String) : SyncEvent {
        override fun toJson(): JsonObject = buildJsonObject {
            put("type", "change")
            put("keys", JsonArray(keys.map { JsonPrimitive(it) }))
            put("origin", origin)
        }
    }

    /** A mutation was rejected for good; [code] is the Worker's code or `undefined`. */
    public data class Rejected(val mutationId: Long, val code: String) : SyncEvent {
        override fun toJson(): JsonObject = buildJsonObject {
            put("type", "rejected")
            put("mutationId", mutationId)
            put("code", code)
        }
    }

    /** The machine signed out, with the count it left unsynced. */
    public data class SignedOut(val reason: String, val unsynced: Int) : SyncEvent {
        override fun toJson(): JsonObject = buildJsonObject {
            put("type", "signedOut")
            put("reason", reason)
            put("unsynced", unsynced)
        }
    }

    /** Unsynced data was left behind by a sign-out. */
    public data class UnsyncedData(val count: Int) : SyncEvent {
        override fun toJson(): JsonObject = buildJsonObject {
            put("type", "unsyncedData")
            put("count", count)
        }
    }

    /** A sign-in is on offer; [signInUrl] is null when no URL could be kept (A-5). */
    public data class SignInOffered(val signInUrl: String?) : SyncEvent {
        override fun toJson(): JsonObject = buildJsonObject {
            put("type", "signInOffered")
            put("signInUrl", signInUrl?.let { JsonPrimitive(it) } ?: JsonNull)
        }
    }
}

/**
 * What the host's own open says of one served row (HC-2): [sealed] it opened from a ciphertext,
 * [invalid] it could not be opened, or neither with the change's [seq] for a plaintext row.
 */
public data class OpenedRow(val sealed: Boolean = false, val invalid: Boolean = false, val seq: Long? = null)

/**
 * The typed open result of one answer: [changes] by position in the body (null for a row the host
 * did not open) and [conflicts] by mutation id.
 */
public data class OpenedBody(val changes: List<OpenedRow?> = emptyList(), val conflicts: Map<Long, OpenedRow?> = emptyMap())

/** The writes of one mutation kind, by wire name. */
public enum class SyncOp(public val wire: String) {
    Set("set"),
    Clear("clear"),
    SetMember("setMember"),
    RemoveMember("removeMember"),
    Add("add"),
    Remove("remove"),
}

/**
 * One account's (or the device's) journal slice. The machine slices fill in the behaviour; the shape is
 * the Python `_new_partition`: the client id, the next mutation id, the pull cursor, the pending
 * mutations (wire objects), the held and settled values, and the sealed latch.
 */
public class SyncPartition(public var clientId: String?) {
    public var nextMutationId: Long = 1
    public var cursor: Long = 0
    public val pending: MutableList<JsonObject> = mutableListOf()
    public val held: MutableMap<String, JsonElement> = linkedMapOf()
    public val settings: MutableMap<String, JsonObject> = linkedMapOf()
    public val records: MutableMap<String, JsonObject> = linkedMapOf()
    public val device: MutableMap<String, JsonElement> = linkedMapOf()
    public var signedOutAt: Long? = null
    public var headroom: Long? = null
    public var encryptionSince: Long? = null
    public val sealedKeys: MutableSet<String> = linkedSetOf()
}
