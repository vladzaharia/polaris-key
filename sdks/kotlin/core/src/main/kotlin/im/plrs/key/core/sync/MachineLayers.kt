// What the machine believes a key's value is: the layered view (snapshot, journal, drafts) and the
// change events computed from before and after maps.

package im.plrs.key.core.sync

import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** One key's layered value; [value] null is "no value". */
internal class Layer(val value: JsonElement?, val from: String, val pending: Boolean)

internal class MachineLayers(private val p: MachineParts) {
    private val core get() = p.core
    private val routing get() = p.routing

    fun rowUnreadable(row: SyncRow): Boolean {
        val plain = row.plain
        val since = if (core.s.subject == null) null else core.active().encryptionSince
        val legacy = plain != null && core.requiresE2e() && since != null && plain < since
        return row.bad || core.lockedOut() || (plain != null && core.requiresE2e() && !legacy)
    }

    fun snapshotUnreadable(serverKey: String): Boolean {
        if (core.s.subject == null) return false
        val row = core.active().settings[serverKey]
        return row != null && rowUnreadable(row)
    }

    private class Acc(var value: JsonElement? = null, var has: Boolean = false, var pending: Boolean = false)

    fun layer(key: String): Layer? {
        if (!routing.syncs(key)) return null
        val acc = Acc()
        val policy = routing.policyOf(key)
        val target = routing.alias(key)
        if (core.s.subject != null) fromCloud(acc, policy, target) else fromDevice(acc, target)
        fromDrafts(acc, policy, target)
        val origin = if (acc.pending) {
            "pending"
        } else if (core.s.subject != null) {
            "cloud"
        } else {
            "device"
        }
        return if (acc.has || acc.pending) Layer(acc.value, origin, acc.pending) else null
    }

    private fun fromCloud(acc: Acc, policy: String, target: String) {
        val part = core.active()
        part.settings[target]?.takeIf { !rowUnreadable(it) }?.let {
            acc.value = it.value
            acc.has = true
        }
        for (op in part.pending) {
            val t = op.target as? OpTarget.Setting
            if (t == null || routing.alias(t.key) != target) continue
            acc.value = SyncValues.applySettingOp(policy, acc.value, op.op, op.value, op.member)
            acc.pending = true
        }
    }

    private fun fromDevice(acc: Acc, target: String) {
        for ((k, d) in core.active().device.filter { routing.alias(it.key) == target }) {
            acc.value = if (d.cleared) null else d.value
            acc.has = true
        }
    }

    private fun fromDrafts(acc: Acc, policy: String, target: String) {
        for ((_, d) in core.drafts.filter { routing.alias(it.key) == target }) {
            acc.value = when {
                d.clear -> null
                policy == "merge" -> d.value
                else -> SyncValues.applySettingOp(policy, acc.value, "set", d.value, null)
            }
            acc.pending = true
        }
    }

    /** Every open (undeclared) key the machine currently holds a value for. */
    fun openKeys(): List<String> {
        val keys = linkedSetOf<String>()
        val pa = core.active()
        if (core.s.subject != null) {
            keys.addAll(pa.settings.keys)
            pa.pending.forEach { (it.target as? OpTarget.Setting)?.let { t -> keys.add(t.key) } }
        } else {
            keys.addAll(pa.device.keys)
        }
        keys.addAll(core.drafts.keys)
        return keys.filter { routing.route(it) == null }
    }

    fun valueMap(): Map<String, JsonElement> {
        val m = linkedMapOf<String, JsonElement>()
        for (r in routing.declared) {
            val kind = r["route"].stringValue
            val key = r["key"].stringValue!!
            if (kind == "synced" || kind == "local") m[key] = p.reads.get(key).value
        }
        for (k in openKeys()) m[k] = p.reads.get(k).value
        return m
    }

    fun emitChanges(before: Map<String, JsonElement>, overrides: Map<String, String>, origin: String) {
        val after = valueMap()
        val groups = linkedMapOf<String, MutableList<String>>()
        for (k in (before.keys + after.keys)) {
            val was = before[k] ?: (routing.documentValue(k) ?: JsonNull)
            val now = after[k] ?: p.reads.get(k).value
            if (SyncJson.jsonEqual(was, now)) continue
            groups.getOrPut(overrides[k] ?: origin) { mutableListOf() }.add(k)
        }
        for (o in listOf("local", "remote", "merge", "migration")) {
            groups[o]?.let { core.events.add(SyncEvent.Change(it.sorted(), o)) }
        }
    }
}
