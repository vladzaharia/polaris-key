// @pkey-feature packs.plan packs.delta.feed
//
// conformance/corpus/v2/"plan-matrix.json" (planMatrixVersion 2, plans/P4-01.md §4.5, plans/P4-10.md
// §4.4, plans/P4-29.md §4.3), read in place, through :packs:
//
//   rows            the planner                → plan
//   variantCases    variant selection          → selectVariant
//   targetCases     a variant onto the planner → planTarget
//   feedDeltaCases  the feed's delta menu      → withFeedDeltas, then planTarget and plan

package im.plrs.key.conformance

import im.plrs.key.core.FeedDelta
import im.plrs.key.core.FeedDeltas
import im.plrs.key.core.PLAN_MATRIX_VERSION
import im.plrs.key.core.PLAN_REQUEST_WEIGHT
import im.plrs.key.core.arrayValue
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.packs.FilesIndexDoc
import im.plrs.key.packs.PackVariant
import im.plrs.key.packs.PlanCaps
import im.plrs.key.packs.PlanChunkIndex
import im.plrs.key.packs.PlanInstalled
import im.plrs.key.packs.PlanTarget
import im.plrs.key.packs.VariantPrefs
import im.plrs.key.packs.plan
import im.plrs.key.packs.planTarget
import im.plrs.key.packs.selectVariant
import im.plrs.key.packs.withFeedDeltas
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** A test-only feed delta menu read straight from JSON (no claims): the runners' `rawFeedDeltas`. */
internal fun rawFeedDeltas(v: JsonElement?): FeedDeltas? {
    val menu = v.objectValue ?: return null
    return menu.mapValues { (_, list) ->
        (list.arrayValue ?: emptyList()).mapNotNull { e ->
            val d = e.objectValue ?: return@mapNotNull null
            val a = d["artifact"].objectValue ?: return@mapNotNull null
            FeedDelta(
                d["from"].stringValue ?: return@mapNotNull null, d["method"].stringValue ?: return@mapNotNull null,
                d["memBytes"].longValue ?: return@mapNotNull null, a["sha256"].stringValue ?: return@mapNotNull null, a["bytes"].longValue ?: return@mapNotNull null,
            )
        }
    }
}

class PlanMatrixTest : ConformanceSuite() {
    private val matrix: JsonObject = Corpus.v2("plan-matrix.json")

    private fun section(name: String): List<JsonObject> = matrix[name]!!.arrayValue!!.map { it.obj }

    private fun filesIndex(v: JsonElement?): FilesIndexDoc? = if (v == null || v is JsonNull) null else FilesIndexDoc.from(v)

    private fun chunkIndex(v: JsonElement?): PlanChunkIndex? = if (v == null || v is JsonNull) null else PlanChunkIndex.from(v) ?: error("chunkIndex")

    @Test
    fun hasEveryRowAndCase() {
        assertEquals(PLAN_MATRIX_VERSION.toLong(), matrix["planMatrixVersion"].longValue)
        assertEquals(PLAN_REQUEST_WEIGHT.toLong(), matrix["requestWeight"].longValue)
        assertEquals(28, section("rows").size)
        assertEquals(11, section("variantCases").size)
        assertEquals(22, section("targetCases").size)
        assertEquals(13, section("feedDeltaCases").size)
    }

    @Test
    fun rows() {
        val f = Failures("plan rows")
        for (o in section("rows")) {
            val input = o["input"]!!.obj
            val target = PlanTarget.from(input["target"]) ?: error("row ${o["id"]}")
            val installed = (input["installed"].arrayValue ?: emptyList()).map { PlanInstalled.from(it)!! }
            val caps = PlanCaps.from(input["caps"])!!
            val got = plan(target, installed, caps).json
            f.check(jsonEquals(o["expect"], got)) { "row ${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(28)
    }

    @Test
    fun variantCases() {
        val f = Failures("variantCases")
        for (o in section("variantCases")) {
            val p = o["prefs"]!!.obj
            val axes = (p["axes"].objectValue ?: JsonObject(emptyMap())).mapValues { (_, v) -> v.arrayValue?.mapNotNull { it.stringValue } ?: emptyList() }
            val got = selectVariant(o["variants"]!!.arrayValue!!, VariantPrefs(p["engine"].stringValue, axes)).json
            f.check(jsonEquals(o["expect"], got)) { "variant ${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(11)
    }

    @Test
    fun targetCases() {
        val f = Failures("targetCases")
        for (o in section("targetCases")) {
            val variant = PackVariant.from(o["variant"]) ?: error("target ${o["id"]}")
            val got = planTarget(variant, o["recordSha256"].stringValue!!, filesIndex(o["filesIndex"]), chunkIndex(o["chunkIndex"])).json
            f.check(jsonEquals(o["expect"], got)) { "target ${o["id"].stringValue}: ${o["description"].stringValue}: got $got" }
        }
        f.done(22)
    }

    @Test
    fun feedDeltaCases() {
        val f = Failures("feedDeltaCases")
        for (o in section("feedDeltaCases")) {
            val id = o["id"].stringValue
            val variant = PackVariant.from(o["variant"]) ?: error("feed delta $id")
            val merged = withFeedDeltas(variant, rawFeedDeltas(o["deltas"]))
            val target = planTarget(merged.variant, o["recordSha256"].stringValue!!, filesIndex(o["filesIndex"]), chunkIndex(o["chunkIndex"]))
            val installed = (o["installed"].arrayValue ?: emptyList()).map { PlanInstalled.from(it)!! }
            val caps = PlanCaps.from(o["caps"])!!
            val got = buildJsonObject {
                put("feedIds", JsonArray(merged.feedIds.map { JsonPrimitive(it) }))
                put("target", target.json)
                put("plan", plan(target, installed, caps).json)
            }
            f.check(jsonEquals(o["expect"], got)) { "feed delta $id: ${o["description"].stringValue}: got $got" }
        }
        f.done(13)
    }
}
