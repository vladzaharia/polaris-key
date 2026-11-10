// How a record `put` is journalled, by the collection's policy.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

internal class MachineRecordPuts(private val p: MachineParts) {
    private val core get() = p.core

    fun revision(part: SyncPartition, rk: String, target: OpTarget.Record, value: JsonElement) {
        // An exact write (`putAt`) is never coalesced into, and a `put` never edits it.
        val queued = part.pending.firstOrNull { p.records.isRecord(it, rk) && it.ticket == null }
        val open = part.conflicts[rk]?.takeIf { it.keepChoice == null }
        when {
            // An open request freezes the record: the later put replaces the device's copy and is not sent.
            open != null -> open.local = value

            p.records.inFlightTouches(rk) -> part.held[rk] = value

            queued != null -> queued.value = value

            else -> {
                val base = part.records[rk]?.let { r -> JsonPrimitive(r.version) } ?: JsonPrimitive("*")
                p.journal.enqueue(part, Op(0, target, "set", value).also { it.baseVersion = base })
            }
        }
    }

    private fun stamp(op: Op, edited: String): Op = op.also {
        it.editedHlc = edited
        it.preContact = !core.s.contacted
    }

    fun merge(part: SyncPartition, target: OpTarget.Record, value: JsonElement) {
        val edited = p.journal.tickHlc()
        val cur = SyncValues.objectOf(p.records.record(target.collection, target.id)?.value)
        val nxt = SyncValues.objectOf(value)
        for (field in nxt.keys.sorted()) {
            if (field !in cur || !SyncJson.jsonEqual(cur[field], nxt[field])) {
                p.journal.enqueue(part, stamp(Op(0, target, "setField", nxt[field]).also { it.field = field }, edited))
            }
        }
        val removed = cur.keys.sorted().filter { it !in nxt }
        for (field in removed) {
            p.journal.enqueue(part, stamp(Op(0, target, "removeField").also { it.field = field }, edited))
        }
    }

    fun stamped(part: SyncPartition, rk: String, target: OpTarget.Record, value: JsonElement) {
        val edited = p.journal.tickHlc()
        val queued = if (p.records.inFlightTouches(rk)) {
            null
        } else {
            part.pending.firstOrNull { p.records.isRecord(it, rk) && it.op == "set" }
        }
        if (queued != null) {
            queued.value = value
            queued.editedHlc = edited
        } else {
            p.journal.enqueue(part, stamp(Op(0, target, "set", value), edited))
        }
    }
}
