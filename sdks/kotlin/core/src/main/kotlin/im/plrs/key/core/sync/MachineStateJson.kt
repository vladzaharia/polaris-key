// The machine's persisted state as JSON, for the host's state file. `decode` validates the whole shape
// and answers null for anything else, so a corrupt or foreign file starts the machine empty instead of
// half-loaded. The file holds the opened snapshot of the signed-in person's settings; the root is never
// part of it (the key ring holds that in memory).

package im.plrs.key.core.sync

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

public object MachineStateJson {
    public fun encode(s: MachineState): JsonObject = buildJsonObject {
        put("subject", s.subject?.let { JsonPrimitive(it) } ?: JsonNull)
        put("partitions", JsonObject(s.partitions.mapValues { partition(it.value) }))
        put("hlc", JsonArray(listOf(JsonPrimitive(s.hlcPhysical), JsonPrimitive(s.hlcCounter))))
        put("offsetMs", s.offsetMs)
        put("contacted", s.contacted)
        put("aliases", JsonObject(s.aliases.mapValues { JsonPrimitive(it.value) }))
        put("blocked", s.blocked?.let { JsonPrimitive(it) } ?: JsonNull)
        put("deviceLocal", JsonObject(s.deviceLocal))
        put("imported", s.imported)
        put("e2eSeen", s.e2eSeen)
    }

    private fun row(r: SyncRow): JsonObject = buildJsonObject {
        put("value", r.value ?: JsonNull)
        put("version", r.version)
        r.editedHlc?.let { put("editedHlc", it) }
        if (r.bad) put("bad", true)
        r.plain?.let { put("plain", it) }
    }

    private fun partition(p: SyncPartition): JsonObject = buildJsonObject {
        put("clientId", p.clientId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("nextMutationId", p.nextMutationId)
        put("cursor", p.cursor)
        put("pending", JsonArray(p.pending.map { it.toJson() }))
        put("held", JsonObject(p.held))
        put("settings", JsonObject(p.settings.mapValues { row(it.value) }))
        put("records", JsonObject(p.records.mapValues { row(it.value) }))
        put("device", JsonObject(p.device.mapValues { it.value.toJson() }))
        p.signedOutAt?.let { put("signedOutAt", it) }
        p.headroom?.let { put("headroom", it) }
        p.encryptionSince?.let { put("encryptionSince", it) }
        p.sealedFloor?.let { put("sealedFloor", it) }
        put("sealedKeys", JsonArray(p.sealedKeys.map { JsonPrimitive(it) }))
    }

    /** The state [json] holds, or null when it is not exactly a state this version wrote. */
    public fun decode(json: JsonElement?): MachineState? = runCatching { decodeOrThrow(json as JsonObject) }.getOrNull()

    private fun decodeOrThrow(o: JsonObject): MachineState {
        val parts = linkedMapOf<String, SyncPartition>()
        for ((name, p) in o["partitions"] as JsonObject) parts[name] = decodePartition(p as JsonObject)
        val hlc = o["hlc"] as JsonArray
        val s = MachineState(o["subject"].stringValue, LinkedHashMap(parts))
        s.hlcPhysical = hlc[0].longValue!!
        s.hlcCounter = hlc[1].longValue!!
        s.offsetMs = o["offsetMs"].longValue ?: 0
        s.contacted = o["contacted"].boolValue!!
        (o["aliases"] as? JsonObject)?.forEach { (k, v) -> v.stringValue?.let { s.aliases[k] = it } }
        s.blocked = o["blocked"].stringValue
        (o["deviceLocal"] as? JsonObject)?.forEach { (k, v) -> s.deviceLocal[k] = v }
        s.imported = o["imported"].boolValue == true
        s.e2eSeen = o["e2eSeen"].boolValue == true
        return s
    }

    private fun decodeRow(r: JsonElement): SyncRow {
        val o = r as JsonObject
        return SyncRow(o["value"], o["version"].longValue!!, o["editedHlc"].stringValue, o["bad"].boolValue == true, o["plain"].longValue)
    }

    private fun decodePartition(o: JsonObject): SyncPartition {
        val p = SyncPartition(o["clientId"].stringValue)
        p.nextMutationId = o["nextMutationId"].longValue!!
        p.cursor = o["cursor"].longValue!!
        p.pending = o["pending"].arrayValue!!.map { decodeOp(it as JsonObject) }.toMutableList()
        (o["held"] as JsonObject).forEach { (k, v) -> p.held[k] = v }
        (o["settings"] as JsonObject).forEach { (k, v) -> p.settings[k] = decodeRow(v) }
        (o["records"] as JsonObject).forEach { (k, v) -> p.records[k] = decodeRow(v) }
        (o["device"] as JsonObject).forEach { (k, v) -> p.device[k] = decodeDevice(v as JsonObject) }
        p.signedOutAt = o["signedOutAt"].longValue
        p.headroom = o["headroom"].longValue
        p.encryptionSince = o["encryptionSince"].longValue
        p.sealedFloor = o["sealedFloor"].longValue
        o["sealedKeys"].arrayValue?.forEach { k -> k.stringValue?.let { p.sealedKeys.add(it) } }
        return p
    }

    private fun decodeDevice(o: JsonObject): DeviceEntry =
        DeviceEntry(o["value"], o["cleared"].boolValue == true, o["editedHlc"].stringValue!!, o["preContact"].boolValue == true)

    private fun decodeTarget(t: JsonObject): OpTarget {
        val rec = t["record"].arrayValue
        return if (rec != null) {
            OpTarget.Record(rec[0].stringValue!!, rec[1].stringValue!!)
        } else {
            OpTarget.Setting(t["setting"].stringValue!!, t["scope"].stringValue!!)
        }
    }

    private fun decodeOp(o: JsonObject): Op {
        val op =
            Op(
                o["mutationId"].longValue!!,
                decodeTarget(o["target"].objectValue!!),
                o["op"].stringValue!!,
                o["value"],
                o["member"].stringValue,
                o["element"],
            )
        op.editedHlc = o["editedHlc"].stringValue
        op.baseVersion = o["baseVersion"]
        op.observedSeq = o["observedSeq"].longValue
        op.preContact = o["preContact"].boolValue == true
        op.moved = o["moved"].boolValue == true
        op.parked = o["parked"].stringValue
        return op
    }
}
