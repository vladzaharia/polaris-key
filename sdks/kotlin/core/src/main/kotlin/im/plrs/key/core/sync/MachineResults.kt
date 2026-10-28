// What one mutation's result does to the machine (Python `_result`): a setting's ok, conflict and
// terminal refusal, and a record's ok, conflict and rebase.

package im.plrs.key.core.sync

import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One result with the context the machine needs to apply it. */
internal class ResultCtx(
    val part: SyncPartition,
    val r: JsonObject,
    val overrides: MutableMap<String, String>,
    val opened: OpenedBody,
    val cursor: Long,
)

internal class MachineResults(private val p: MachineParts) {
    private val core get() = p.core
    private val routing get() = p.routing

    fun apply(op: Op, ctx: ResultCtx) {
        when (val t = op.target) {
            is OpTarget.Setting -> setting(op, t, ctx)
            is OpTarget.Record -> p.recordResults.apply(op, t, ctx)
        }
    }

    private fun rejected(op: Op, r: JsonObject) = core.events.add(SyncEvent.Rejected(op.mutationId, SyncNum.jsString(r, "code")))

    private fun version(v: Long) = JsonPrimitive(v)

    private fun setting(op: Op, t: OpTarget.Setting, ctx: ResultCtx) {
        val key = t.key
        val renamed = ctx.r["renamedTo"].stringValue
        val serverKey = renamed ?: routing.alias(key)
        val ok = ctx.r["status"].stringValue == "ok"
        if (op.moved) ctx.overrides[key] = "merge"
        val v = SyncNum.long(ctx.r["version"])
        if (ok && v != null) p.rows.noteSealed(ctx.part, v, "s:$serverKey")
        when {
            ok -> settingOk(op, ctx, key, serverKey, v)
            ctx.r["status"].stringValue == "conflict" && ctx.r["server"] is JsonObject -> settingConflict(op, ctx, key, serverKey)
            ctx.r["status"].stringValue == "rejected" -> rejected(op, ctx.r)
        }
    }

    private fun settingOk(op: Op, ctx: ResultCtx, key: String, serverKey: String, version: Long?) {
        if ((ctx.r["dropped"] as? JsonPrimitive)?.content == "true") {
            ctx.overrides[key] = "migration"
            routing.declared.map { it["key"].stringValue!! }.filter { routing.alias(it) == routing.alias(key) }.forEach {
                ctx.overrides[it] =
                    "migration"
            }
        } else if (version != null) {
            val prior = ctx.part.settings[serverKey]
            val value = SyncValues.applySettingOp(routing.policyOf(key), prior?.value, op.op, op.value, op.member)
            if (value == null) ctx.part.settings.remove(serverKey) else ctx.part.settings[serverKey] = SyncRow(value, version)
        }
    }

    /** A stale write loses to the server copy, and nothing is enqueued, except an E2E `max`/`min` re-push. */
    private fun settingConflict(op: Op, ctx: ResultCtx, key: String, serverKey: String) {
        val server = ctx.r["server"] as JsonObject
        val sv = SyncNum.long(server["version"]) ?: return
        val row = p.rows.copyRow(ctx.part, "s:$serverKey", server, ctx.opened.conflicts[op.mutationId], ctx.cursor)
        ctx.part.settings[serverKey] = row
        val policy = routing.policyOf(key)
        if (repush(op, row, policy, server)) {
            val again = Op(0, op.target, "set", op.value)
            again.editedHlc = op.editedHlc
            again.baseVersion = version(sv)
            p.journal.enqueue(ctx.part, again)
            ctx.overrides[key] = "merge"
        }
    }

    /** E2E max/min: keep the better value and re-push it on the server's version. */
    private fun repush(op: Op, row: SyncRow, policy: String, server: JsonObject): Boolean =
        op.op == "set" && p.rows.decidable(row) && p.pump.clientDecides(policy) && p.rows.better(policy, op.value, server["value"])
}
