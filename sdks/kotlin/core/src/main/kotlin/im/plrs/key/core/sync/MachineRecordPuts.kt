// How a record `put` is journalled, by the collection's policy.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

internal class MachineRecordPuts(private val p: MachineParts) {
    private val core get() = p.core

    fun revision(part: SyncPartition, rk: String, target: OpTarget.Record, value: JsonElement) {
        val queued = part.pending.firstOrNull { p.records.isRecord(it, rk) }
        when {
            p.records.inFlightTouches(rk) -> part.held[rk] = value

            queued != null -> queued.value = value

            else -> p.journal.enqueue(
                part,
                Op(0, target, "set", value).also { it.baseVersion = part.records[rk]?.let { r -> JsonPrimitive(r.version) } ?: JsonPrimitive("*") },
            )
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
        for (member in nxt.keys.sorted()) {
            if (member !in cur || !SyncJson.jsonEqual(cur[member], nxt[member])) {
                p.journal.enqueue(part, stamp(Op(0, target, "setMember", nxt[member], member), edited))
            }
        }
        for (member in cur.keys.sorted().filter { it !in nxt }) p.journal.enqueue(part, stamp(Op(0, target, "removeMember", null, member), edited))
    }

    fun stamped(part: SyncPartition, rk: String, target: OpTarget.Record, value: JsonElement) {
        val edited = p.journal.tickHlc()
        val queued = if (p.records.inFlightTouches(rk)) null else part.pending.firstOrNull { p.records.isRecord(it, rk) && it.op == "set" }
        if (queued != null) {
            queued.value = value
            queued.editedHlc = edited
        } else {
            p.journal.enqueue(part, stamp(Op(0, target, "set", value), edited))
        }
    }
}
