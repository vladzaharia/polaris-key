// The machine's journal writes: the hybrid logical clock, enqueueing, parked edits and the debounced
// drafts that become journal entries.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

internal class MachineJournal(private val p: MachineParts) {
    private val core get() = p.core
    private val routing get() = p.routing

    fun tickHlc(): String {
        val s = core.s
        val physical = core.now + s.offsetMs
        if (physical > s.hlcPhysical) {
            s.hlcPhysical = physical
            s.hlcCounter = 0
        } else {
            s.hlcCounter += 1
        }
        return SyncValues.formatHlc(s.hlcPhysical, s.hlcCounter)
    }

    fun enqueue(part: SyncPartition, op: Op): Op {
        op.mutationId = part.nextMutationId
        part.nextMutationId += 1
        part.pending.add(op)
        return op
    }

    /** One whole value for [key]: a `set`, or for a `merge` key one member operation per differing member. */
    fun enqueueSetting(part: SyncPartition, key: String, value: JsonElement?, editedHlc: String, marks: Marks) {
        val target = routing.targetOf(key)
        if (routing.policyOf(key) != "merge" || value !is JsonObject) {
            enqueue(part, Op(0, target, "set", value ?: JsonNull).also { it.editedHlc = editedHlc }.withMarks(marks))
            return
        }
        val cur = if (core.s.subject == null) JsonObject(emptyMap()) else SyncValues.objectOf(p.layers.layer(key)?.value)
        for (member in value.keys.sorted()) {
            if (member !in cur || !SyncJson.jsonEqual(cur[member], value[member])) {
                enqueue(part, Op(0, target, "setMember", value[member], member).also { it.editedHlc = editedHlc }.withMarks(marks))
            }
        }
        for (member in cur.keys.sorted()) {
            if (member !in value) enqueue(part, Op(0, target, "removeMember", null, member).also { it.editedHlc = editedHlc }.withMarks(marks))
        }
    }

    /** A newer local edit of a `lastWrite` or `merge` key replaces its parked edits (R5). */
    fun dropParkedByLocalEdit(part: SyncPartition, key: String) {
        if (routing.policyOf(key) !in listOf("lastWrite", "merge")) return
        val target = routing.alias(key)
        part.pending = part.pending.filterNot {
            it.parked != null && (it.target as? OpTarget.Setting)?.let { t -> routing.alias(t.key) == target } == true
        }.toMutableList()
    }

    /** Re-send parked edits as new mutations with their original clock (a processed id is never resent). */
    fun unpark(part: SyncPartition, which: (String) -> Boolean) {
        val parked = part.pending.filter { it.parked != null && which(it.parked!!) }
        if (parked.isEmpty()) return
        part.pending = part.pending.filter { o -> parked.none { it === o } }.toMutableList()
        parked.forEach { enqueue(part, it.resend()) }
    }

    fun commitAllDrafts() = core.drafts.keys.sorted().forEach { commitDraft(it) }

    fun commitDraft(key: String) {
        val d = core.drafts.remove(key) ?: return
        val policy = routing.policyOf(key)
        if (core.s.subject == null) {
            val local = core.partitionFor(LOCAL_PARTITION)
            val prior = local.device[key]
            val value = when {
                d.clear -> null
                policy == "merge" -> d.value
                else -> SyncValues.applySettingOp(policy, prior?.takeIf { !it.cleared }?.value, "set", d.value, null)
            }
            local.device[key] = DeviceEntry(value, d.clear, d.editedHlc, d.preContact)
            return
        }
        val part = core.active()
        dropParkedByLocalEdit(part, key)
        val marks = Marks(preContact = d.preContact)
        if (d.clear) {
            enqueue(part, Op(0, routing.targetOf(key), "clear").also { it.editedHlc = d.editedHlc }.withMarks(marks))
        } else {
            enqueueSetting(part, key, d.value, d.editedHlc, marks)
        }
    }

    /** A signed-out device edit entering the journal on sign-in. */
    fun moveDeviceEntry(part: SyncPartition, key: String, d: DeviceEntry) {
        val marks = Marks(preContact = d.preContact, moved = true)
        if (d.cleared) {
            enqueue(part, Op(0, routing.targetOf(key), "clear").also { it.editedHlc = d.editedHlc }.withMarks(marks))
        } else {
            enqueueSetting(part, key, d.value, d.editedHlc, marks)
        }
    }
}
