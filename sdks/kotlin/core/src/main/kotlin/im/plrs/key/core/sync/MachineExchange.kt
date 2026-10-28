// A 200 answer to the request in flight (Python `_ok`): first contact, the results, the pull members
// (snapshot, changes, tombstones), the cursor, aliases and the quota headroom.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_MAX_CLOCK_SKEW_MS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The rejection codes that park a setting edit instead of reverting it (R5). */
private val PARKING = mapOf("quota_exceeded" to "quota", "entitlement_required" to "entitlement")

internal class MachineExchange(private val p: MachineParts) {
    private val core get() = p.core

    fun ok(req: InFlight, body: JsonObject, opened: OpenedBody) {
        SyncNum.long(body["serverNow"])?.let { p.contact.firstContact(it) }
        val subject = body["subject"].stringValue
        if (req.partition != core.s.subject) return
        if (subject != null && subject != req.partition) {
            p.session.leave("subjectChanged", false)
            return
        }
        val part = core.active()
        val before = p.layers.valueMap()
        val overrides = linkedMapOf<String, String>()
        applyResults(part, req, body, opened, overrides)
        if (req.cursor == 0L && SyncNum.long(body["cursor"]) != null) {
            part.settings = linkedMapOf()
            part.records = linkedMapOf()
        }
        if (core.requiresE2e()) SyncNum.long(body["encryptionSince"])?.let { p.rows.lowerSince(part, it) }
        applyChanges(part, req, body, opened)
        applyTombstones(part, body)
        SyncNum.long(body["cursor"])?.let { part.cursor = it }
        body["aliases"].objectValue?.let { a ->
            core.s.aliases.clear()
            a.forEach { (k, v) -> v.stringValue?.let { s -> core.s.aliases[k] = s } }
        }
        applyQuota(part, body)
        core.needSnapshot = false
        core.pullWanted = (body["more"] as? JsonPrimitive)?.content == "true"
        p.layers.emitChanges(before, overrides, "remote")
    }

    private fun applyResults(part: SyncPartition, req: InFlight, body: JsonObject, opened: OpenedBody, overrides: MutableMap<String, String>) {
        val batch = part.pending.filter { it.mutationId in req.mutationIds }
        val parkedNow = body["results"].arrayValue.orEmpty().mapNotNull { r ->
            (r as? JsonObject)?.let { applyResult(part, req, it, ResultCtx(part, it, overrides, opened, req.cursor)) }
        }
        // A parked edit that a later edit of the same value already replaces is dropped.
        for (op in parkedNow) {
            if ((batch + part.pending).any { q -> q !== op && q.mutationId > op.mutationId && sameValue(op, q) }) part.pending.removeAll { it === op }
        }
    }

    /** Applies one result; answers the op it parked (R5), if it did. */
    private fun applyResult(part: SyncPartition, req: InFlight, res: JsonObject, ctx: ResultCtx): Op? {
        val id = SyncNum.long(res["mutationId"])
        val at = part.pending.indexOfFirst { it.mutationId == id && id in req.mutationIds }
        val op = part.pending.getOrNull(at)
        val rejected = res["status"].stringValue == "rejected" && op?.target is OpTarget.Setting
        val park = if (rejected) PARKING[SyncNum.jsString(res, "code")] else null
        when {
            op == null -> Unit

            park != null -> op.parked = park

            else -> {
                part.pending.removeAt(at)
                p.results.apply(op, ctx)
            }
        }
        return if (park != null) op else null
    }

    /** Whether two setting operations write the same value: the same key, and the same member unless one writes the whole value. */
    private fun sameValue(a: Op, b: Op): Boolean {
        val ta = a.target as? OpTarget.Setting
        val tb = b.target as? OpTarget.Setting
        fun whole(o: Op) = o.op == "set" || o.op == "clear"
        return ta != null && tb != null && ta.key == tb.key && (whole(a) || whole(b) || a.member == b.member)
    }

    private fun recordKey(rec: JsonElement?): String? = (rec as? JsonArray)?.takeIf { it.size == 2 }?.let { "${text(it[0])}/${text(it[1])}" }

    private fun text(v: JsonElement): String = if (v is JsonPrimitive) v.content else v.toString()

    private fun applyChanges(part: SyncPartition, req: InFlight, body: JsonObject, opened: OpenedBody) {
        body["changes"].arrayValue.orEmpty().forEachIndexed { i, change ->
            val c = change as? JsonObject ?: return@forEachIndexed
            val version = SyncNum.long(c["version"]) ?: return@forEachIndexed
            // E2E guard (a): inside one partition a served change is newer than the cursor the request carried.
            if (core.requiresE2e() && req.cursor > 0 && version <= req.cursor) return@forEachIndexed
            val setting = c["setting"].stringValue
            val rk = recordKey(c["record"])
            val latch = if (setting != null) "s:$setting" else rk?.let { "r:$it" } ?: ""
            val flag = p.rows.rowBad(part, latch, version, opened.changes.getOrNull(i), req.cursor)
            val row = SyncRow(c["value"] ?: JsonNull, version, null, flag.bad, flag.plain)
            if (setting != null) {
                part.settings[setting] = row
                p.rows.dropParkedByRemote(part, setting, c["editedHlc"].stringValue)
            } else if (rk != null) {
                part.records[rk] = row
            }
        }
    }

    private fun applyTombstones(part: SyncPartition, body: JsonObject) {
        for (t in body["tombstones"].arrayValue.orEmpty()) {
            val o = t as? JsonObject ?: continue
            val setting = o["setting"].stringValue
            val rk = recordKey(o["record"])
            if (setting != null) {
                part.settings.remove(setting)
                p.rows.dropParkedByRemote(part, setting, o["editedHlc"].stringValue)
            } else if (rk != null) {
                part.records.remove(rk)
            }
        }
    }

    /** R5: more room than the last response showed re-sends the quota-parked edits. */
    private fun applyQuota(part: SyncPartition, body: JsonObject) {
        val quota = SyncNum.long(body["quota"].objectValue?.get("bytes"))
        val usage = SyncNum.long(body["usage"].objectValue?.get("bytes"))
        if (quota == null || usage == null) return
        val headroom = quota - usage
        val last = part.headroom
        if (last != null && headroom > last) p.journal.unpark(part) { it == "quota" }
        part.headroom = headroom
    }
}
