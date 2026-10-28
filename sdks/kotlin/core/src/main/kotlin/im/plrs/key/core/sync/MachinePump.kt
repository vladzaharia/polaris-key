// The machine's outbox: the next request, if one is due and allowed (Python `_kick`).

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_MAX_MUTATIONS
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class MachinePump(private val p: MachineParts) {
    private val core get() = p.core

    private fun get(path: String): JsonObject = buildJsonObject {
        put("method", "GET")
        put("path", path)
    }

    private fun pullPath(part: SyncPartition, cursor: Long) = "/${core.opts.product}/sync?cursor=$cursor&clientId=${part.clientId}"

    private fun canSend(): Boolean =
        core.inFlight == null && core.s.subject != null && core.s.blocked == null && core.network == "online" && core.mayTalk()

    /** Send the next request, if one is due and allowed. */
    fun kick() {
        if (!canSend()) return
        val name = core.s.subject!!
        val part = core.active()
        // E2E: a push waits for the Worker to be confirmed `e2e` this session. A pull carries nothing of ours.
        val unconfirmed = core.requiresE2e() && core.advertised != "e2e"
        if (!core.s.contacted || core.needSnapshot || unconfirmed) {
            val cursor = if (core.needSnapshot) 0 else part.cursor
            core.inFlight = InFlight("pull", name, cursor, emptyList())
            core.outbox.add(get(pullPath(part, cursor)))
            return
        }
        val batch = part.pending.filter { it.parked == null }.take(SYNC_MAX_MUTATIONS)
        if (batch.isNotEmpty()) {
            core.inFlight = InFlight("push", name, part.cursor, batch.map { it.mutationId })
            core.outbox.add(push(part, batch))
        } else if (core.signingOut != null) {
            p.session.leave("signOut", core.signingOut!!.discard)
        } else if (core.pullWanted) {
            core.inFlight = InFlight("pull", name, part.cursor, emptyList())
            core.outbox.add(get(pullPath(part, part.cursor)))
        }
    }

    private fun push(part: SyncPartition, batch: List<Op>): JsonObject = buildJsonObject {
        put("method", "POST")
        put("path", "/${core.opts.product}/sync/ops")
        put(
            "body",
            buildJsonObject {
                put("clientId", part.clientId)
                put("cursor", part.cursor)
                put("atomic", false)
                put("mutations", JsonArray(batch.map { sendForm(part, it) }))
            },
        )
    }

    /** `max` and `min` are decided by the client in E2E mode. */
    fun clientDecides(policy: String): Boolean = core.requiresE2e() && policy in listOf("max", "min")

    private fun needsBaseVersion(op: Op, t: OpTarget.Setting): Boolean =
        op.op == "set" && op.baseVersion == null && clientDecides(p.routing.policyOf(t.key))

    /** The wire form of a pending operation; an E2E `max`/`min` set names the version it was made against. */
    private fun sendForm(part: SyncPartition, op: Op): JsonObject {
        val t = op.target as? OpTarget.Setting
        val plain = op.toJson(wire = true)
        if (t == null || !needsBaseVersion(op, t)) return plain
        val row = part.settings[p.routing.alias(t.key)]
        return JsonObject(plain + ("baseVersion" to (row?.let { JsonPrimitive(it.version) } ?: JsonPrimitive("*"))))
    }
}
