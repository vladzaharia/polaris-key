// What a record mutation's result does to the machine (Python `_result`, the record half): ok, conflict,
// terminal refusal, and the rebase of a held value onto the server's version.

package im.plrs.key.core.sync

import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal class MachineRecordResults(private val p: MachineParts) {
    private val core get() = p.core
    private val routing get() = p.routing

    /** What a record result decides: nothing, or a new `set` on a version, with the value to write when none is held. */
    private class Rebase(var on: JsonElement? = null, var value: JsonElement? = null)

    fun apply(op: Op, t: OpTarget.Record, ctx: ResultCtx) {
        val rk = "${t.collection}/${t.id}"
        val part = ctx.part
        val status = ctx.r["status"].stringValue
        val server = ctx.r["server"] as? JsonObject
        val sv = SyncNum.long(ctx.r["version"])
        val rebase = Rebase()
        when {
            status == "ok" && sv != null -> recordOk(op, ctx, rk, sv, rebase)
            status == "conflict" && server != null -> if (SyncNum.long(server["version"]) != null) recordConflict(op, ctx, rk, server, rebase)
            else -> other(op, ctx, rk, rebase)
        }
        val on = rebase.on ?: return
        val value = part.held[rk] ?: rebase.value
        part.held.remove(rk)
        p.journal.enqueue(
            part,
            Op(0, OpTarget.Record(t.collection, t.id), "set", value ?: kotlinx.serialization.json.JsonNull).also {
                it.baseVersion =
                    on
            },
        )
    }

    private fun other(op: Op, ctx: ResultCtx, rk: String, rebase: Rebase) {
        if (ctx.r["status"].stringValue == "rejected") core.events.add(SyncEvent.Rejected(op.mutationId, SyncNum.jsString(ctx.r, "code")))
        if (rk in ctx.part.held) rebase.on = ctx.part.records[rk]?.let { JsonPrimitive(it.version) } ?: JsonPrimitive("*")
    }

    private fun recordOk(op: Op, ctx: ResultCtx, rk: String, version: Long, rebase: Rebase) {
        p.rows.noteSealed(ctx.part, version, "r:$rk")
        val value = SyncValues.applyRecordOp(ctx.part.records[rk]?.value, op)
        if (value != null) ctx.part.records[rk] = SyncRow(value, version)
        if (rk in ctx.part.held) rebase.on = JsonPrimitive(version)
    }

    /** The resolution is a NEW mutation on the server's version; N is never resent. */
    private fun recordConflict(op: Op, ctx: ResultCtx, rk: String, server: JsonObject, rebase: Rebase) {
        val sv = JsonPrimitive(SyncNum.long(server["version"])!!)
        val row = p.rows.copyRow(ctx.part, "r:$rk", server, ctx.opened.conflicts[op.mutationId], ctx.cursor)
        ctx.part.records[rk] = row
        val decl = routing.collection((op.target as OpTarget.Record).collection)
        val policy = decl?.get("policy").stringValue
        val field = decl?.get("field").stringValue
        val better = decl != null && op.op == "set" && p.rows.decidable(row) && p.pump.clientDecides(policy!!) &&
            p.rows.better(policy, p.rows.compared(op.value, field), p.rows.compared(server["value"], field))
        val keepLocal = decl != null && policy == "revision" && decl["resolve"].stringValue == "keepLocal" && op.op == "set"
        if (rk in ctx.part.held || better || keepLocal) {
            rebase.on = sv
            rebase.value = op.value
        }
    }
}
