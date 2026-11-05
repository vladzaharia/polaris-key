// MergeRequests of the machine (plans/U-08.md section 2.3): a `revision` record's plain `put` that meets a conflict
// opens one request per record, held on the device until `keep`; `cloudEmpty` reads the pull's `empty` flag.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MergeCause
import im.plrs.key.core.MergeChoice
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What a MergeRequest's `keep` takes. */
public sealed interface MergeKeep {
    /** This device's copy. */
    public data object Local : MergeKeep

    /** The cloud's copy. */
    public data object Remote : MergeKeep

    /** Both (saves only, into a free slot). */
    public data object Both : MergeKeep

    /** A new value (records only). */
    public data class Value(val value: JsonElement) : MergeKeep

    /** The name the corpus and the events spell the choice with. */
    public val choice: String
        get() = when (this) {
            Local -> MergeChoice.local
            Remote -> MergeChoice.remote
            Both -> MergeChoice.both
            is Value -> MergeChoice.value
        }
}

/** The file a save side holds. */
public data class MergeFile(val size: Long, val format: String) {
    internal fun toJson(): JsonObject = buildJsonObject {
        put("size", size)
        put("format", format)
    }
}

/** One side of a request: a record's value, or a save's metadata. */
public data class MergeSide(
    val value: JsonElement,
    val version: Long?,
    val savedAt: Long? = null,
    val device: String? = null,
    val file: MergeFile? = null,
) {
    /** The corpus's side form. */
    public fun toJson(): JsonObject = buildJsonObject {
        put("value", value)
        put("version", version?.let { JsonPrimitive(it) } ?: JsonNull)
        put("savedAt", savedAt?.let { JsonPrimitive(it) } ?: JsonNull)
        put("device", device?.let { JsonPrimitive(it) } ?: JsonNull)
        put("file", file?.toJson() ?: JsonNull)
    }
}

/** The machine's view of one open request. */
public data class MachineConflict(
    val id: String,
    val cause: String,
    val collection: String,
    val record: String,
    val local: MergeSide,
    val remote: MergeSide?,
    val choices: List<String>,
    val state: String,
    val error: String?,
) {
    /** The corpus's `conflicts` entry form. */
    public fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("cause", cause)
        put("collection", collection)
        put("record", record)
        put("local", local.toJson())
        put("remote", remote?.toJson() ?: JsonNull)
        put("choices", JsonArray(choices.map { JsonPrimitive(it) }))
        put("state", state)
        put("error", error?.let { JsonPrimitive(it) } ?: JsonNull)
    }
}

/** The MergeRequest calls of the machine. */
public interface SyncMerge {
    /** The open requests of the signed-in subject (record collections), in id order. */
    public fun conflicts(): List<MachineConflict>

    /**
     * Answer an open request: `local` and `value` send one `set` on the remote version (`"*"` when it is gone), `remote`
     * sends nothing and reads the server copy. A closed request is `sync-merge-closed`; a choice it does not offer is `bad_request`.
     */
    public fun keep(id: String, choice: MergeKeep): CallResult

    /** Whether the cloud was empty at the subject's first cursor-0 answer; null before any. */
    public fun cloudEmpty(): Boolean?
}

internal class MachineMerge(private val p: MachineParts) : SyncMerge {
    private val core get() = p.core

    private fun conflictId(collection: String, record: String) = "w:$collection/$record"

    private fun split(rk: String): Pair<String, String> {
        val i = rk.indexOf('/')
        return rk.substring(0, i) to rk.substring(i + 1)
    }

    private fun keys(): List<String> = if (core.s.subject == null) emptyList() else core.active().conflicts.keys.sorted()

    fun count(): Int = keys().size

    /**
     * Open (or, when a keep's own set conflicted, reopen) the request of a `revision` record: the held edit, else the
     * mutation's, is the device's copy.
     */
    fun open(part: SyncPartition, rk: String, collection: String, record: String, op: Op) {
        val existing = part.conflicts[rk]
        val held = part.held.remove(rk)
        if (existing != null) {
            existing.keepChoice = null
            existing.error = null
            if (held != null) existing.local = held
        } else {
            val base = (op.baseVersion as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()
            part.conflicts[rk] = ConflictRec(held ?: op.value ?: JsonNull, base)
        }
        core.events.add(SyncEvent.Conflict(conflictId(collection, record), MergeCause.write, collection, record))
    }

    fun close(part: SyncPartition, rk: String, how: String) {
        if (part.conflicts.remove(rk) == null) return
        val (collection, record) = split(rk)
        core.events.add(SyncEvent.ConflictClosed(conflictId(collection, record), how))
    }

    override fun conflicts(): List<MachineConflict> {
        if (core.s.subject == null) return emptyList()
        val part = core.active()
        return keys().map { rk ->
            val c = part.conflicts.getValue(rk)
            val (collection, record) = split(rk)
            val remote = part.records[rk]?.takeIf { !p.layers.rowUnreadable(it) }?.let { MergeSide(it.value ?: JsonNull, it.version) }
            MachineConflict(
                conflictId(collection, record),
                MergeCause.write,
                collection,
                record,
                MergeSide(c.local, c.localVersion),
                remote,
                listOf(MergeChoice.local, MergeChoice.remote, MergeChoice.value),
                if (c.keepChoice != null) "applying" else "open",
                c.error,
            )
        }
    }

    @Suppress("ReturnCount")
    override fun keep(id: String, choice: MergeKeep): CallResult {
        if (core.s.subject == null) return CallResult.Failed(ErrorCode.syncMergeClosed)
        val part = core.active()
        val rk = keys().firstOrNull { k -> split(k).let { (c, r) -> conflictId(c, r) == id } }
            ?: return CallResult.Failed(ErrorCode.syncMergeClosed)
        val c = part.conflicts.getValue(rk)
        val bad = CallResult.Failed("bad_request")
        if (c.keepChoice != null || choice is MergeKeep.Both) return bad
        if (choice is MergeKeep.Value && SyncJson.jsonBytes(choice.value) > im.plrs.key.core.SYNC_MAX_VALUE_BYTES) return bad
        val (collection, record) = split(rk)
        if (choice is MergeKeep.Remote) {
            close(part, rk, "remote")
            p.records.noteChanges("merge")
            p.pump.kick()
            return CallResult.Ok
        }
        val row = part.records[rk]
        val base: JsonElement = if (row != null && !p.layers.rowUnreadable(row)) JsonPrimitive(row.version) else JsonPrimitive("*")
        val value = (choice as? MergeKeep.Value)?.value ?: c.local
        val op = p.journal.enqueue(part, Op(0, OpTarget.Record(collection, record), "set", value).also { it.baseVersion = base })
        c.error = null
        c.keepChoice = choice.choice
        c.keepMutationId = op.mutationId
        p.records.noteChanges("merge")
        p.pump.kick()
        return CallResult.Ok
    }

    override fun cloudEmpty(): Boolean? = if (core.s.subject == null) null else core.active().empty
}
