// The Cloud Sync machine's persisted state and its journal records (the Python machine's plain-data
// dicts, typed). A JSON null is a value (`JsonNull`); a Kotlin `null` is "no value" (rule M-4).

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What a journalled operation writes to. */
internal sealed interface OpTarget {
    fun toJson(): JsonObject

    data class Setting(val key: String, val scope: String) : OpTarget {
        override fun toJson(): JsonObject = buildJsonObject {
            put("setting", key)
            put("scope", scope)
        }
    }

    data class Record(val collection: String, val id: String) : OpTarget {
        override fun toJson(): JsonObject = buildJsonObject { put("record", JsonArray(listOf(JsonPrimitive(collection), JsonPrimitive(id)))) }
    }
}

/** One journalled mutation. The marks (`preContact`, `moved`, `parked`) are journal-only and never sent. */
internal class Op(
    var mutationId: Long,
    val target: OpTarget,
    val op: String,
    val value: JsonElement? = null,
    val member: String? = null,
    val element: JsonElement? = null,
) {
    var editedHlc: String? = null
    var baseVersion: JsonElement? = null
    var observedSeq: Long? = null
    var preContact: Boolean = false
    var moved: Boolean = false
    var parked: String? = null

    /** The journal form (every mark), or the wire form when [wire] is true. */
    fun toJson(wire: Boolean = false): JsonObject = buildJsonObject {
        put("mutationId", mutationId)
        put("target", target.toJson())
        put("op", op)
        value?.let { put("value", it) }
        member?.let { put("member", it) }
        element?.let { put("element", it) }
        editedHlc?.let { put("editedHlc", it) }
        baseVersion?.let { put("baseVersion", it) }
        observedSeq?.let { put("observedSeq", it) }
        if (!wire) {
            if (preContact) put("preContact", true)
            if (moved) put("moved", true)
            parked?.let { put("parked", it) }
        }
    }

    /** A copy for a re-send: no mutation id and no `parked` mark (the id is assigned on enqueue). */
    fun resend(): Op = Op(0, target, op, value, member, element).also {
        it.editedHlc = editedHlc
        it.baseVersion = baseVersion
        it.observedSeq = observedSeq
        it.preContact = preContact
        it.moved = moved
    }

    fun withMarks(marks: Marks): Op = also {
        it.preContact = marks.preContact
        it.moved = marks.moved
    }
}

/** The journal-only marks an operation is enqueued with. */
internal data class Marks(val preContact: Boolean = false, val moved: Boolean = false)

/** A debounced edit that has not reached the journal yet. */
internal class Draft(val value: JsonElement?, val clear: Boolean, var editedHlc: String, var preContact: Boolean, val due: Long)

/** The signed-out device's value for one key, its policy already applied. */
internal class DeviceEntry(val value: JsonElement?, val cleared: Boolean, var editedHlc: String, var preContact: Boolean) {
    fun toJson(): JsonObject = buildJsonObject {
        if (!cleared) put("value", value ?: JsonNull)
        if (cleared) put("cleared", true)
        put("editedHlc", editedHlc)
        if (preContact) put("preContact", true)
    }
}

/** A server row held in a partition's snapshot (a setting or a record). */
internal class SyncRow(val value: JsonElement?, val version: Long, val editedHlc: String? = null, val bad: Boolean = false, val plain: Long? = null)

/** One account's (or the device's) journal slice (Python `_new_partition`). */
internal class SyncPartition(var clientId: String?) {
    var nextMutationId: Long = 1
    var cursor: Long = 0
    var pending: MutableList<Op> = mutableListOf()
    var held: MutableMap<String, JsonElement> = linkedMapOf()
    var settings: MutableMap<String, SyncRow> = linkedMapOf()
    var records: MutableMap<String, SyncRow> = linkedMapOf()
    val device: MutableMap<String, DeviceEntry> = linkedMapOf()
    var signedOutAt: Long? = null
    var headroom: Long? = null
    var encryptionSince: Long? = null
    var sealedFloor: Long? = null
    val sealedKeys: LinkedHashSet<String> = linkedSetOf()

    fun deepCopy(): SyncPartition = SyncPartition(clientId).also { c ->
        c.nextMutationId = nextMutationId
        c.cursor = cursor
        c.pending = pending.map {
            it.resend().also { o ->
                o.mutationId = it.mutationId
                o.parked = it.parked
            }
        }.toMutableList()
        c.held = LinkedHashMap(held)
        c.settings = LinkedHashMap(settings)
        c.records = LinkedHashMap(records)
        device.forEach { (k, d) -> c.device[k] = DeviceEntry(d.value, d.cleared, d.editedHlc, d.preContact) }
        c.signedOutAt = signedOutAt
        c.headroom = headroom
        c.encryptionSince = encryptionSince
        c.sealedFloor = sealedFloor
        c.sealedKeys.addAll(sealedKeys)
    }
}

/** What survives a relaunch: the device binding, the per-subject journals, the clock and the device-local store. */
public class MachineState internal constructor(internal var subject: String?, internal val partitions: LinkedHashMap<String, SyncPartition>) {
    internal var hlcPhysical: Long = 0
    internal var hlcCounter: Long = 0
    internal var offsetMs: Long = 0
    internal var contacted: Boolean = false
    internal val aliases: MutableMap<String, String> = linkedMapOf()
    internal var blocked: String? = null
    internal val deviceLocal: MutableMap<String, JsonElement> = linkedMapOf()
    internal var imported: Boolean = false
    internal var e2eSeen: Boolean = false

    internal fun deepCopy(): MachineState = MachineState(subject, LinkedHashMap(partitions.mapValues { it.value.deepCopy() })).also {
        it.hlcPhysical = hlcPhysical
        it.hlcCounter = hlcCounter
        it.offsetMs = offsetMs
        it.contacted = contacted
        it.aliases.putAll(aliases)
        it.blocked = blocked
        it.deviceLocal.putAll(deviceLocal)
        it.imported = imported
        it.e2eSeen = e2eSeen
    }
}
