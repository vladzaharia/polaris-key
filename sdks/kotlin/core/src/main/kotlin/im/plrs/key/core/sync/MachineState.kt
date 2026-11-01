// The Cloud Sync machine's persisted state and its journal records (the Python machine's plain-data
// dicts, typed). A JSON null is a value (`JsonNull`); a Kotlin `null` is "no value" (rule M-4).

package im.plrs.key.core.sync

import im.plrs.key.core.longValue
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
internal class Op(var mutationId: Long, val target: OpTarget, val op: String, var value: JsonElement? = null) {
    var member: String? = null
    var element: JsonElement? = null

    /** `setField` and `removeField` on a `merge` record (§13.3). */
    var field: String? = null
    var editedHlc: String? = null
    var baseVersion: JsonElement? = null
    var observedSeq: Long? = null
    var preContact: Boolean = false
    var moved: Boolean = false
    var parked: String? = null

    /** The id `putAt` / `removeAt` returned: the op is exact (never coalesced, never rebased) and its outcome is reported under it. */
    var ticket: Long? = null

    /** The pointer `putAt` was given (the one the save's finalize returned): the row adopts it when the op is acknowledged `ok`. Never sent. */
    var file: RecordFile? = null

    /** The journal form (every mark), or the wire form when [wire] is true. */
    fun toJson(wire: Boolean = false): JsonObject = buildJsonObject {
        put("mutationId", mutationId)
        put("target", target.toJson())
        put("op", op)
        value?.let { put("value", it) }
        member?.let { put("member", it) }
        field?.let { put("field", it) }
        element?.let { put("element", it) }
        editedHlc?.let { put("editedHlc", it) }
        baseVersion?.let { put("baseVersion", it) }
        observedSeq?.let { put("observedSeq", it) }
        if (!wire) {
            if (preContact) put("preContact", true)
            if (moved) put("moved", true)
            parked?.let { put("parked", it) }
            ticket?.let { put("ticket", it) }
            file?.let { put("file", it.toJson()) }
        }
    }

    /** A copy for a re-send: no mutation id and no `parked` mark (the id is assigned on enqueue). */
    fun resend(keepParked: Boolean = false): Op = Op(0, target, op, value).also {
        it.member = member
        it.element = element
        it.field = field
        if (keepParked) it.parked = parked
        it.editedHlc = editedHlc
        it.baseVersion = baseVersion
        it.observedSeq = observedSeq
        it.preContact = preContact
        it.moved = moved
        it.ticket = ticket
        it.file = file
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

/** A record's file pointer (V5 section 13.4): the stored bytes, not the value. */
public class RecordFile(public val version: Long, public val size: Long, public val sha256: String, public val format: String) {
    internal fun toJson(): JsonObject = buildJsonObject {
        put("version", version)
        put("size", size)
        put("sha256", sha256)
        put("format", format)
    }

    public companion object {
        /** The pointer [v] holds, or null when it is not a well-formed one. */
        @Suppress("ComplexCondition")
        public fun of(v: JsonElement?): RecordFile? {
            val o = v as? JsonObject ?: return null
            val version = o["version"].longValue
            val size = o["size"].longValue
            val sha = (o["sha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val format = (o["format"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val ok = version != null && size != null && sha != null && (format == "whole" || format == "chunks")
            return if (ok) RecordFile(version!!, size!!, sha!!, format!!) else null
        }
    }
}

/** A server row held in a partition's snapshot (a setting or a record). */
internal class SyncRow(
    val value: JsonElement?,
    val version: Long,
    val editedHlc: String? = null,
    val bad: Boolean = false,
    val plain: Long? = null,
    val file: RecordFile? = null,
)

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

    /**
     * The last ticket `putAt` / `removeAt` handed out; separate from [nextMutationId], so a renumbering never makes a new
     * ticket equal a pending one.
     */
    var nextTicket: Long = 0
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
        c.nextTicket = nextTicket
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
