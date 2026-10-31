// The exact record writes of a `revision` collection (U-22.5): `records()` lists the cloud rows a person can read,
// `putAt` / `removeAt` write at exactly one base version, and `onOutcome` reports each write's one result.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One cloud row of a collection, as `records()` lists it. A file-only row has a [JsonNull] value. */
public class RecordRow(public val id: String, public val value: JsonElement, public val version: Long, public val file: RecordFile?) {
    /** The corpus's `rows` form. */
    public fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("value", value)
        put("version", version)
        put("file", file?.toJson() ?: JsonNull)
    }
}

/** The server's copy a conflict carries. */
public class RecordCopy(public val value: JsonElement, public val version: Long, public val file: RecordFile?) {
    internal fun toJson(): JsonObject = buildJsonObject {
        put("value", value)
        put("version", version)
        put("file", file?.toJson() ?: JsonNull)
    }
}

/** The result of one `putAt` / `removeAt`, reported once to the `onOutcome` listener. */
public sealed interface RecordOutcome {
    /** The ticket `putAt` / `removeAt` returned. */
    public val mutationId: Long

    /** The corpus's `outcomes` form. */
    public fun toJson(): JsonObject

    public class Ok(override val mutationId: Long, public val version: Long) : RecordOutcome {
        override fun toJson(): JsonObject = base("ok") { put("version", version) }
    }

    /** A stale base version: [server] is the server's copy, or null when the host could not read it. */
    public class Conflict(override val mutationId: Long, public val server: RecordCopy?) : RecordOutcome {
        override fun toJson(): JsonObject = base("conflict") { put("server", server?.toJson() ?: JsonNull) }
    }

    public class Rejected(override val mutationId: Long, public val code: String) : RecordOutcome {
        override fun toJson(): JsonObject = base("rejected") { put("code", code) }
    }

    /** Sign-out removed the write before it was answered. */
    public class Dropped(override val mutationId: Long) : RecordOutcome {
        override fun toJson(): JsonObject = base("dropped") {}
    }

    private companion object {
        fun RecordOutcome.base(status: String, more: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject {
            put("mutationId", mutationId)
            put("status", status)
            more()
        }
    }
}

/** What `putAt` / `removeAt` answer. */
public sealed interface PutAtResult {
    public class Ok(public val mutationId: Long) : PutAtResult

    /** `collection-unknown` or `signed-out`. */
    public class Failed(public val error: String) : PutAtResult

    /** The corpus's `expect` form. */
    public fun toJson(): JsonObject = when (this) {
        is Ok -> buildJsonObject {
            put("ok", true)
            put("mutationId", mutationId)
        }

        is Failed -> buildJsonObject {
            put("ok", false)
            put("error", error)
        }
    }
}

/** The exact record calls an app makes while Cloud Sync is on. */
public interface SyncExactRecords {
    /**
     * The cloud rows of [collection] a person can read, by id: the snapshot as last pulled or acknowledged, without
     * pending edits. Empty when signed out.
     */
    public fun records(collection: String): List<RecordRow>

    /** Write a `revision` record at exactly [baseVersion] (a version or `"*"`): never coalesced, never rebased. */
    public fun putAt(collection: String, id: String, value: JsonElement, baseVersion: JsonElement): PutAtResult

    /** Delete a `revision` record at exactly [baseVersion] (removes its file, V5 section 13.8.1). */
    public fun removeAt(collection: String, id: String, baseVersion: JsonElement): PutAtResult

    /**
     * The listener for `putAt` / `removeAt` outcomes: once per call, when its result arrives or on sign-out. It must not
     * call the machine. Null removes it.
     */
    public fun onOutcome(listener: ((RecordOutcome) -> Unit)?)
}
