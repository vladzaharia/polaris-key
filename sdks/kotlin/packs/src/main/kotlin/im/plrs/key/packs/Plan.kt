// The install planner (plans/P4-01.md §2.9; notes/A7 §4.2 exactly, with `full.requests`).
// `plan-matrix.json#rows` pins it. A pure integer function: it returns its verdicts
// (`plan-transport-unsupported`, `plan-insufficient-disk`, `plan-no-strategy`) and never throws.
// client-core `packs/plan.ts` is the reference; Swift's `Plan.swift` the structural model.

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PLAN_REQUEST_WEIGHT
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The strategies, in the rank that breaks a cost tie (`full` is always last). */
public val PLAN_STRATEGIES: List<String> = listOf("noop", "platform", "delta", "chunk", "file", "full")

/** One installed release of the pack, as the planner sees it. */
public data class PlanInstalled(
    val release: String,
    val payloadSha256: String,
    /** The chunk ids this release's chunk index holds (P4-11), when it is kept. */
    val chunks: List<String>? = null,
    /** The file hashes this release's files index holds, when it is kept. */
    val files: List<String>? = null,
) {
    public companion object {
        public fun from(json: JsonElement?): PlanInstalled? {
            val o = json.objectValue ?: return null
            return PlanInstalled(
                o["release"].stringValue ?: return null,
                o["payloadSha256"].stringValue ?: return null,
                o["chunks"].objectValue?.get("ids").arrayValue?.mapNotNull { it.stringValue },
                o["files"].arrayValue?.mapNotNull { it.stringValue },
            )
        }
    }
}

/** What the host can do. `requestWeight` defaults to `PLAN_REQUEST_WEIGHT` (16,384). */
public data class PlanCaps(
    val strategies: List<String>,
    val patchMethods: List<String>,
    val transports: List<String>,
    val memBudget: Long,
    val freeDisk: Long,
    val requestWeight: Long? = null,
) {
    public companion object {
        public fun from(json: JsonElement?): PlanCaps? {
            val o = json.objectValue ?: return null
            fun strings(k: String) = o[k].arrayValue?.mapNotNull { it.stringValue } ?: emptyList()
            return PlanCaps(
                strings("strategies"), strings("patchMethods"), strings("transports"),
                o["memBudget"].longValue ?: return null, o["freeDisk"].longValue ?: return null, o["requestWeight"].longValue,
            )
        }
    }
}

/** A costed candidate, as the plan reports it. */
public data class PlanCandidate(val strategy: String, val delta: String?, val bytes: Long, val requests: Long, val cost: Long) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("strategy", JsonPrimitive(strategy))
            put("bytes", jsonInt(bytes))
            put("requests", jsonInt(requests))
            put("cost", jsonInt(cost))
            delta?.let { put("delta", JsonPrimitive(it)) }
        }
}

/** [plan]'s answer. */
public sealed interface PlanResult {
    public data class Chosen(val candidate: PlanCandidate, val peakDisk: Long, val fallbacks: List<PlanCandidate>) : PlanResult
    public data class Platform(val transport: String) : PlanResult

    /** `plan-transport-unsupported`, `plan-insufficient-disk` or `plan-no-strategy`. */
    public data class Error(val code: String) : PlanResult

    public val json: JsonObject
        get() = when (this) {
            is Chosen -> JsonObject(
                candidate.json + mapOf("peakDisk" to jsonInt(peakDisk), "fallbacks" to JsonArray(fallbacks.map { it.json })),
            )
            is Platform -> buildJsonObject {
                put("strategy", JsonPrimitive("platform"))
                put("transport", JsonPrimitive(transport))
                put("fallbacks", JsonArray(emptyList()))
            }
            is Error -> buildJsonObject { put("error", JsonPrimitive(code)) }
        }
}

private class Cand(val strategy: String, val delta: String?, val bytes: Long, val requests: Long, val ord: Int) {
    var cost = 0L
    var peakDisk = 0L
}

private fun rank(s: String): Int = PLAN_STRATEGIES.indexOf(s).let { if (it < 0) PLAN_STRATEGIES.size else it }

/**
 * `plan(target, installed, caps)`: `noop` when a release with the target payload is installed; a
 * platform-bound target takes `platform` when the host lists its transport, else
 * `plan-transport-unsupported`. Otherwise every allowed, feasible candidate is costed (`bytes +
 * requestWeight × requests`), with `peakDisk` = payload size + bytes. Candidates over `freeDisk`
 * drop. The cheapest wins (ties: strategy rank, then record order); the rest are fallbacks in cost
 * order with `full` last.
 */
public fun plan(target: PlanTarget, installed: List<PlanInstalled>, caps: PlanCaps): PlanResult {
    val t = target
    if (installed.any { it.payloadSha256 == t.payload.sha256 }) return PlanResult.Chosen(PlanCandidate("noop", null, 0, 0, 0), 0, emptyList())
    t.platform?.let { transport ->
        return if (transport in caps.transports) PlanResult.Platform(transport) else PlanResult.Error(ErrorCode.planTransportUnsupported)
    }
    val strategies = caps.strategies.toSet()
    val have = installed.map { it.payloadSha256 }.toSet()
    val cands = ArrayList<Cand>()

    if ("delta" in strategies) {
        for ((k, d) in t.deltas.withIndex()) {
            if (d.method in caps.patchMethods && d.from in have && d.memBytes <= caps.memBudget) {
                cands += Cand("delta", d.id, d.artifacts.sumOf { it.bytes }, d.artifacts.size.toLong(), k)
            }
        }
    }

    val seeds = installed.mapNotNull { it.chunks }
    val chunks = t.chunks
    if ("chunk" in strategies && chunks != null && seeds.isNotEmpty()) {
        val seeded = HashSet<String>()
        seeds.forEach { seeded.addAll(it) }
        val seen = HashSet<String>()
        var prev: PlanChunkRecord? = null
        var runs = 0L
        var bytes = chunks.indexBytes
        for (r in chunks.records) {
            if (r.id in seeded || r.id in seen) continue
            seen += r.id
            bytes += r.clen
            val p = prev
            if (p == null || r.bundle != p.bundle || r.offset != p.offset + p.clen) runs++
            prev = r
        }
        cands += Cand("chunk", null, bytes, 1 + runs, 0)
    }

    val withFiles = installed.filter { it.files != null }
    val files = t.files
    if ("file" in strategies && files != null && withFiles.isNotEmpty()) {
        val held = HashSet<String>()
        withFiles.forEach { held.addAll(it.files!!) }
        val missing = LinkedHashMap<String, Long>()
        for (f in files.files) if (f.sha256 !in held && !missing.containsKey(f.sha256)) missing[f.sha256] = f.blobBytes
        val sum = missing.values.sum()
        cands += Cand("file", null, files.indexBytes + files.gapsBytes + sum, 1L + (if (files.gapsBytes > 0) 1 else 0) + missing.size, 0)
    }

    t.full?.let { cands += Cand("full", null, it.bytes, it.requests ?: 1, 0) }

    if (cands.isEmpty()) return PlanResult.Error(ErrorCode.planNoStrategy)
    val w = caps.requestWeight ?: PLAN_REQUEST_WEIGHT.toLong()
    for (c in cands) {
        c.cost = c.bytes + w * c.requests
        c.peakDisk = t.payload.size + c.bytes
    }
    val feasible = cands.filter { it.peakDisk <= caps.freeDisk }
    if (feasible.isEmpty()) return PlanResult.Error(ErrorCode.planInsufficientDisk)
    // A stable sort: equal keys keep their candidate order.
    val sorted = feasible.withIndex().sortedWith(
        compareBy<IndexedValue<Cand>>({ it.value.cost }, { rank(it.value.strategy) }, { it.value.ord }, { it.index }),
    ).map { it.value }
    val chosen = sorted[0]
    val rest = sorted.drop(1)
    val ordered = rest.filter { it.strategy != "full" } + rest.filter { it.strategy == "full" }
    fun publish(c: Cand) = PlanCandidate(c.strategy, c.delta, c.bytes, c.requests, c.cost)
    return PlanResult.Chosen(publish(chosen), chosen.peakDisk, ordered.map { publish(it) })
}
