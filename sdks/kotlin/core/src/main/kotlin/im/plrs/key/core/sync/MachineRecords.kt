// The machine's records: `put` (compare-and-swap for `revision`, a stamped `set` for `lastWrite`, `max`
// and `min`, member operations for `merge`), `add` and `remove` for `union`, and the read of one record.

package im.plrs.key.core.sync

import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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

/** The collection handle's calls on the machine: `update`, `delete`, the catalog's declarations, record events and outcome taps. */
public interface SyncCollections {
    /**
     * Update a `merge` record: [set] writes the named fields and [remove] drops the named ones; any other field is
     * untouched (a field this version does not know survives). One clock stamp.
     */
    public fun update(
        collection: String,
        recordId: String,
        set: Map<String, JsonElement> = emptyMap(),
        remove: List<String> = emptyList(),
    ): CallResult

    /** Delete a record of any policy but `revision` (use `removeAt` there). */
    public fun delete(collection: String, recordId: String): CallResult

    /** The declaration of a collection in the catalog (an exact name, else the longest `prefix.*` pattern), or null. */
    public fun collectionDecl(name: String): CollectionDecl?

    /** The ids of a collection's effective records (pending edits applied), in byte order. */
    public fun recordIds(collection: String): List<String>

    /** Report record changes of [collection] as [SyncEvent.Records] events from now on (`false`: stop). */
    public fun watchRecords(collection: String, on: Boolean)

    /** Another listener for `putAt` / `removeAt` outcomes, beside `onOutcome`'s: returns its remover. A tap is told of every outcome. */
    public fun tapOutcomes(tap: (RecordOutcome) -> Unit): () -> Unit

    /** Carry over what observers registered on a machine this one replaces: the outcome taps and the watched collections (with their counts). */
    public fun adoptObservers(from: CloudSyncMachine)
}

/** A collection as the catalog declares it. */
public data class CollectionDecl(val name: String, val policy: String, val field: String? = null, val resolve: String? = null)

@Suppress("TooManyFunctions")
internal class MachineRecords(private val p: MachineParts) :
    SyncRecords,
    SyncCollections,
    SyncExactRecords {
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
        noteChanges("local")
        p.pump.kick()
        return CallResult.Ok
    }

    override fun update(collection: String, recordId: String, set: Map<String, JsonElement>, remove: List<String>): CallResult {
        val names = set.keys.toList() + remove
        val refusal = when {
            p.routing.collection(collection)?.get("policy").stringValue != "merge" -> "collection-unknown"
            core.s.subject == null -> "signed-out"
            names.isEmpty() || names.toSet().size != names.size -> "bad_request"
            else -> null
        }
        if (refusal == null) {
            val part = core.active()
            val target = OpTarget.Record(collection, recordId)
            val edited = p.journal.tickHlc()
            val marks = Marks(preContact = !core.s.contacted)
            for (field in set.keys.sorted()) {
                val op = Op(0, target, "setField", set.getValue(field)).also {
                    it.field = field
                    it.editedHlc = edited
                }
                p.journal.enqueue(part, op.withMarks(marks))
            }
            for (field in remove.sorted()) {
                val op = Op(0, target, "removeField").also {
                    it.field = field
                    it.editedHlc = edited
                }
                p.journal.enqueue(part, op.withMarks(marks))
            }
            noteChanges("local")
            p.pump.kick()
        }
        return refusal?.let { CallResult.Failed(it) } ?: CallResult.Ok
    }

    override fun delete(collection: String, recordId: String): CallResult {
        val policy = p.routing.collection(collection)?.get("policy").stringValue
        val refusal = when {
            policy == null || policy == "revision" -> "collection-unknown"
            core.s.subject == null -> "signed-out"
            else -> null
        }
        if (refusal != null) return CallResult.Failed(refusal)
        val op = Op(0, OpTarget.Record(collection, recordId), "delete")
        if (policy != "union") op.also { it.editedHlc = p.journal.tickHlc() }.preContact = !core.s.contacted
        p.journal.enqueue(core.active(), op)
        noteChanges("local")
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
        val op = Op(0, OpTarget.Record(collection, recordId), name).also { it.element = element }
        if (name == "remove") op.observedSeq = part.cursor
        p.journal.enqueue(part, op)
        noteChanges("local")
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

    override fun records(collection: String): List<RecordRow> {
        if (core.s.subject == null) return emptyList()
        val prefix = "$collection/"
        return core.active().records.entries.filter { it.key.startsWith(prefix) && !p.layers.rowUnreadable(it.value) }
            .sortedBy { it.key }
            .map { (k, row) -> RecordRow(k.substring(prefix.length), row.value ?: JsonNull, row.version, row.file) }
    }

    override fun putAt(collection: String, id: String, value: JsonElement, baseVersion: JsonElement, file: RecordFile?): PutAtResult =
        exact(collection, baseVersion, Op(0, OpTarget.Record(collection, id), "set", value).also { it.file = file })

    override fun removeAt(collection: String, id: String, baseVersion: JsonElement): PutAtResult =
        exact(collection, baseVersion, Op(0, OpTarget.Record(collection, id), "delete"))

    override fun onOutcome(listener: ((RecordOutcome) -> Unit)?) {
        core.outcome = listener
    }

    private fun exact(collection: String, baseVersion: JsonElement, op: Op): PutAtResult {
        val refusal = when {
            p.routing.collection(collection)?.get("policy").stringValue != "revision" -> "collection-unknown"
            core.s.subject == null -> "signed-out"
            else -> null
        }
        if (refusal != null) return PutAtResult.Failed(refusal)
        val part = core.active()
        op.baseVersion = baseVersion
        p.journal.enqueue(part, op)
        part.nextTicket += 1
        op.ticket = part.nextTicket
        noteChanges("local")
        p.pump.kick()
        return PutAtResult.Ok(part.nextTicket)
    }

    /** Report [op]'s outcome, when it is an exact write. */
    fun emitOutcome(op: Op, make: (Long) -> RecordOutcome) {
        val ticket = op.ticket ?: return
        val outcome = make(ticket)
        core.outcome?.invoke(outcome)
        core.outcomeTaps.toList().forEach { it(outcome) }
    }

    override fun tapOutcomes(tap: (RecordOutcome) -> Unit): () -> Unit {
        core.outcomeTaps.add(tap)
        return { core.outcomeTaps.remove(tap) }
    }

    override fun collectionDecl(name: String): CollectionDecl? = p.routing.collection(name)?.let {
        CollectionDecl(it["name"].stringValue!!, it["policy"].stringValue!!, it["field"].stringValue, it["resolve"].stringValue)
    }

    override fun adoptObservers(from: CloudSyncMachine) {
        from.observers().let { (taps, collections) ->
            core.outcomeTaps.addAll(taps)
            collections.forEach { (name, n) -> repeat(n) { watchRecords(name, true) } }
        }
    }

    override fun watchRecords(collection: String, on: Boolean) {
        val n = core.watchCounts[collection] ?: 0
        if (!on) {
            // Reference-counted: two watchers of one collection do not silence each other.
            if (n > 1) {
                core.watchCounts[collection] = n - 1
            } else {
                core.watchCounts.remove(collection)
                core.watched.remove(collection)
            }
            return
        }
        core.watchCounts[collection] = n + 1
        if (collection !in core.watched) core.watched[collection] = recordStates(collection)
    }

    override fun recordIds(collection: String): List<String> = recordStates(collection).keys.sorted()

    /**
     * Every `(collection, id)` of the records the active partition holds (pulled or held), in key order; empty
     * with no subject. A record tombstone names its id blinded, and only these map it back.
     */
    fun recordKeys(): List<Pair<String, String>> {
        if (core.s.subject == null) return emptyList()
        val part = core.active()
        return (part.records.keys + part.held.keys).toSortedSet().mapNotNull { rk ->
            val i = rk.indexOf('/')
            if (i < 0) null else rk.substring(0, i) to rk.substring(i + 1)
        }
    }

    /** The effective rows of a collection: pending creates and held values included. Record id to its value and origin. */
    private fun recordStates(collection: String): Map<String, String> {
        val out = linkedMapOf<String, String>()
        if (core.s.subject == null) return out
        val prefix = "$collection/"
        val part = core.active()
        val keys = linkedSetOf<String>().apply {
            addAll(part.records.keys)
            part.pending.forEach { op ->
                (op.target as? OpTarget.Record)?.takeIf { it.collection == collection }?.let { add(recordKey(it.collection, it.id)) }
            }
            addAll(part.held.keys)
        }
        for (rk in keys) {
            if (!rk.startsWith(prefix)) continue
            val id = rk.substring(prefix.length)
            record(collection, id)?.let { out[id] = "${it.value}\u0000${it.from}" }
        }
        return out
    }

    /** Push a `records` event for each watched collection whose effective rows changed. */
    fun noteChanges(origin: String) {
        if (core.watched.isEmpty()) return
        for ((collection, last) in core.watched.entries.toList()) {
            val now = recordStates(collection)
            val ids = (last.keys + now.keys).toSortedSet().filter { last[it] != now[it] }
            core.watched[collection] = now
            if (ids.isNotEmpty()) core.events.add(SyncEvent.Records(collection, ids, origin))
        }
    }
}
