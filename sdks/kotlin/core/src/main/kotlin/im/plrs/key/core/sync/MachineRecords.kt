// The machine's records: `put` (compare-and-swap for `revision`, a stamped `set` for `lastWrite`, `max`
// and `min`, member operations for `merge`), `add` and `remove` for `union`, and the read of one record.

package im.plrs.key.core.sync

import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** The record calls an app makes while Cloud Sync is on. */
public interface SyncRecords {
    public fun put(collection: String, recordId: String, value: JsonElement): CallResult

    /** Add to a `union` record (an OR-set). */
    public fun add(collection: String, recordId: String, element: JsonElement): CallResult

    /** Remove from a `union` record, observed at the current cursor. */
    public fun remove(collection: String, recordId: String, element: JsonElement): CallResult

    /** The record's value and where it came from, or null. */
    public fun record(collection: String, recordId: String): ReadResult?
}

internal class MachineRecords(private val p: MachineParts) : SyncRecords {
    private val core get() = p.core

    fun recordKey(c: String, id: String) = "$c/$id"

    fun isRecord(o: Op, rk: String): Boolean = (o.target as? OpTarget.Record)?.let { recordKey(it.collection, it.id) } == rk

    fun inFlightTouches(rk: String): Boolean {
        val f = core.inFlight?.takeIf { it.kind == "push" } ?: return false
        return core.s.partitions[f.partition]?.pending?.any { it.mutationId in f.mutationIds && isRecord(it, rk) } == true
    }

    override fun put(collection: String, recordId: String, value: JsonElement): CallResult {
        val policy = p.routing.collection(collection)?.get("policy").stringValue
        val refusal = when {
            policy == null || policy == "union" -> "collection-unknown"
            core.s.subject == null -> "signed-out"
            else -> null
        }
        if (refusal != null) return CallResult.Failed(refusal)
        val part = core.active()
        val rk = recordKey(collection, recordId)
        val target = OpTarget.Record(collection, recordId)
        when (policy) {
            "revision" -> p.puts.revision(part, rk, target, value)
            "merge" -> p.puts.merge(part, target, value)
            else -> p.puts.stamped(part, rk, target, value)
        }
        p.pump.kick()
        return CallResult.Ok
    }

    override fun add(collection: String, recordId: String, element: JsonElement): CallResult = unionOp(collection, recordId, element, "add")

    override fun remove(collection: String, recordId: String, element: JsonElement): CallResult = unionOp(collection, recordId, element, "remove")

    private fun unionOp(collection: String, recordId: String, element: JsonElement, name: String): CallResult {
        val refusal = when {
            p.routing.collection(collection)?.get("policy").stringValue != "union" -> "collection-unknown"
            core.s.subject == null -> "signed-out"
            else -> null
        }
        if (refusal != null) return CallResult.Failed(refusal)
        val part = core.active()
        val op = Op(0, OpTarget.Record(collection, recordId), name, null, null, element)
        if (name == "remove") op.observedSeq = part.cursor
        p.journal.enqueue(part, op)
        p.pump.kick()
        return CallResult.Ok
    }

    override fun record(collection: String, recordId: String): ReadResult? {
        if (core.s.subject == null) return null
        val part = core.active()
        val rk = recordKey(collection, recordId)
        var value: JsonElement? = part.records[rk]?.takeIf { !p.layers.rowUnreadable(it) }?.value
        var pending = false
        for (op in part.pending.filter { isRecord(it, rk) }) {
            value = SyncValues.applyRecordOp(value, op)
            pending = true
        }
        part.held[rk]?.let {
            value = it
            pending = true
        }
        return value?.let { ReadResult(it, if (pending) "pending" else "cloud") }
    }
}
