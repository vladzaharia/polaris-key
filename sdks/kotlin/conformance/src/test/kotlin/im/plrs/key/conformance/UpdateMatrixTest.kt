// @pkey-feature update.decide
//
// The Kotlin runner for conformance/corpus/v2/"update-matrix.json" (plans/P3-01.md §4.6), read in
// place, with the same sections as the Node, Python, Swift and Godot runners:
//
//   vocabulary       the version and §2.8's lists         → the generated constants
//   versionCases     25 comparisons                       → compareVersions
//   capabilityCases  10 narrowings                        → effectiveCapabilities
//   outletCases      12 resolutions                       → resolveUpdateOutlet
//   bucketVectors    6 vectors                            → rolloutBucket
//   rows             65 decisions and their boot values   → decideUpdate, bootDecision
//
// The content rows (`contentRows`) run in ContentDecisionTest.

package im.plrs.key.conformance

import im.plrs.key.core.BINARY_METHOD_VALUES
import im.plrs.key.core.BootEvent
import im.plrs.key.core.ChannelFeedDoc
import im.plrs.key.core.DetectedOutlet
import im.plrs.key.core.FEED_VERSION_SCHEMES
import im.plrs.key.core.HostOutlet
import im.plrs.key.core.InstalledBuild
import im.plrs.key.core.OUTLET_UNKNOWN
import im.plrs.key.core.OutletStamp
import im.plrs.key.core.ROLLOUT_BUCKETS
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.ResolvedOutlet
import im.plrs.key.core.StagedUpdate
import im.plrs.key.core.UPDATE_ACTION_VALUES
import im.plrs.key.core.UPDATE_BLOCKED_REASON_VALUES
import im.plrs.key.core.UPDATE_MATRIX_VERSION
import im.plrs.key.core.UPDATE_NONE_REASON_VALUES
import im.plrs.key.core.UpdateContentInput
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.UpdateDecisionInput
import im.plrs.key.core.UpdateOutlet
import im.plrs.key.core.arrayValue
import im.plrs.key.core.bootDecision
import im.plrs.key.core.compareVersions
import im.plrs.key.core.decideUpdate
import im.plrs.key.core.effectiveCapabilities
import im.plrs.key.core.feedClaims
import im.plrs.key.core.isUndismissable
import im.plrs.key.core.isValidHostOutlet
import im.plrs.key.core.json
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.resolveUpdateOutlet
import im.plrs.key.core.rolloutBucket
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A row's `input` as an `UpdateDecisionInput`. Every member the matrix carries is read. */
internal fun decisionInput(json: JsonElement): UpdateDecisionInput {
    val o = json.obj
    val feed = ChannelFeedDoc.from(o["feed"]) ?: error("the row's feed")
    val record = o["record"]?.takeIf { it !is JsonNull }?.let { ReleaseRecordDoc.from(it.obj) ?: error("the row's record") }
    val i = o["installed"]!!.obj
    val installed = InstalledBuild(
        i["version"].stringValue!!, i["binaryVersion"].stringValue, i["buildNumber"].stringValue, i["platform"].stringValue!!,
        i["arch"].stringValue!!, i["format"].stringValue, i["engine"].stringValue,
    )
    val outlet = o["outlet"]!!.obj
    val staged = o["staged"].objectValue?.let { StagedUpdate(it["version"].stringValue!!, it["channel"].stringValue!!) }
    val content = o["content"]?.let { UpdateContentInput.from(it) ?: error("the row's content") }
    return UpdateDecisionInput(
        now = o["now"].longValue!!, feed = feed, record = record, installed = installed,
        outlet = UpdateOutlet(outlet["id"].stringValue, outlet["kind"].stringValue!!), subkind = o["subkind"].stringValue,
        staged = staged, skipVersion = o["skipVersion"].stringValue, bucket = o["bucket"].longValue,
        methods = o["methods"]!!.arrayValue!!.mapNotNull { it.stringValue }, content = content,
    )
}

class UpdateMatrixTest : ConformanceSuite() {
    private val matrix: JsonObject = Corpus.v2("update-matrix.json")

    private fun section(name: String): List<JsonObject> = matrix[name]!!.arrayValue!!.map { it.obj }

    private fun hostOutlet(v: JsonElement?): HostOutlet? = when {
        v is JsonPrimitive && v.isString -> HostOutlet.Kind(v.content)
        v is JsonObject -> HostOutlet.Outlet(v["id"].stringValue ?: "", v["kind"].stringValue ?: "", v["subkind"].stringValue)
        else -> null
    }

    private fun stamp(v: JsonElement?): OutletStamp? = v.objectValue?.let { OutletStamp(it["outlet"].stringValue, it["outletKind"].stringValue, it["outletSubkind"].stringValue) }

    private fun detected(v: JsonElement?): DetectedOutlet? = v.objectValue?.let { o ->
        o["kind"].stringValue?.let { DetectedOutlet(it, o["confidence"].stringValue, o["source"].stringValue, o["subkind"].stringValue) }
    }

    private fun resolvedJson(r: ResolvedOutlet?): JsonElement = r?.let {
        buildJsonObject {
            put("id", it.id?.let { s -> JsonPrimitive(s) } ?: JsonNull)
            put("kind", JsonPrimitive(it.kind))
            put("subkind", it.subkind?.let { s -> JsonPrimitive(s) } ?: JsonNull)
        }
    } ?: JsonNull

    @Test
    fun versionAndVocabulary() {
        assertEquals(UPDATE_MATRIX_VERSION.toLong(), matrix["updateMatrixVersion"].longValue)
        val v = matrix["vocabulary"]!!.obj
        fun list(k: String) = v[k]!!.arrayValue!!.map { it.stringValue!! }
        assertEquals(UPDATE_ACTION_VALUES, list("actions"))
        assertEquals(UPDATE_NONE_REASON_VALUES, list("noneReasons"))
        assertEquals(UPDATE_BLOCKED_REASON_VALUES, list("blockedReasons"))
        assertEquals(BINARY_METHOD_VALUES, list("methods"))
        assertEquals(BootEvent.Decision.entries.map { it.wire }, list("boot"))
        assertEquals(FEED_VERSION_SCHEMES, list("schemes"))
        assertEquals(setOf("actions", "noneReasons", "blockedReasons", "methods", "boot", "schemes"), v.keys)
    }

    @Test
    fun everySectionHasItsCases() {
        assertEquals(25, section("versionCases").size)
        assertEquals(10, section("capabilityCases").size)
        assertEquals(12, section("outletCases").size)
        assertEquals(6, section("bucketVectors").size)
        assertEquals(65, section("rows").size)
    }

    @Test
    fun versionCases() {
        val f = Failures("versionCases")
        for (c in section("versionCases")) {
            f.equal(c["expect"].longValue?.toInt(), compareVersions(c["scheme"].stringValue!!, c["a"].stringValue!!, c["b"].stringValue!!)) { "version ${c["name"].stringValue}" }
        }
        f.done(25)
    }

    @Test
    fun capabilityCases() {
        val f = Failures("capabilityCases")
        for (c in section("capabilityCases")) {
            val got = effectiveCapabilities(c["kind"].stringValue!!, c["platform"].stringValue!!, c["subkind"].stringValue, c["server"].objectValue)
            f.check(jsonEquals(c["expect"], got.json)) { "capability ${c["name"].stringValue}: got ${got.json}" }
        }
        f.done(10)
    }

    @Test
    fun outletCases() {
        val f = Failures("outletCases")
        for (c in section("outletCases")) {
            val got = resolveUpdateOutlet(hostOutlet(c["host"]), stamp(c["stamp"]), detected(c["detected"]))
            f.check(jsonEquals(c["expect"], resolvedJson(got))) { "outlet ${c["name"].stringValue}: got ${resolvedJson(got)}" }
        }
        f.done(12)
    }

    /** A host outlet outside the vocabularies is refused (the SDK raises `invalid-options`). */
    @Test
    fun invalidHostOutletsAreRefused() {
        for (host in listOf(
            HostOutlet.Kind("epic"), HostOutlet.Kind(OUTLET_UNKNOWN), HostOutlet.Outlet("Direct Build", "direct"),
            HostOutlet.Outlet("direct", "epic"), HostOutlet.Outlet("direct", "direct", "brew"), HostOutlet.Outlet("direct\n", "direct"),
        )) {
            assertNull("$host", resolveUpdateOutlet(host))
            assertFalse("$host", isValidHostOutlet(host))
        }
    }

    @Test
    fun bucketVectors() {
        val f = Failures("bucketVectors")
        for (v in section("bucketVectors")) {
            f.equal(v["bucket"].longValue, rolloutBucket(v["salt"].stringValue!!, v["installId"].stringValue!!)) { "bucket ${v["name"].stringValue}" }
            f.equal(v["bucket"].longValue, v["u32"].longValue!! % ROLLOUT_BUCKETS) { "bucket ${v["name"].stringValue} modulus" }
            f.equal(v["u32"].longValue, v["first4"].stringValue!!.toLong(16)) { "bucket ${v["name"].stringValue} first4" }
        }
        f.done(6)
    }

    @Test
    fun rows() {
        val f = Failures("rows")
        for (row in section("rows")) {
            val name = row["name"].stringValue
            val input = decisionInput(row["input"]!!)
            // Every row's feed passes the feed claims (plans/P3-01.md §4.9).
            f.equal(null, feedClaims(row["input"]!!.obj["feed"], "djdl", input.feed.channel, input.installed.platform)) { "row $name: its feed passes the claims" }
            val decision = decideUpdate(input)
            val expect = row["expect"]!!.obj
            f.check(jsonEquals(expect["decision"], decision.json)) { "row $name: expected ${expect["decision"]}, got ${decision.json}" }
            f.equal(expect["boot"].stringValue, bootDecision(decision).wire) { "row $name boot" }
        }
        f.done(65)
    }

    /** No P3-01 row stops play: every boot value is `none` or `optional`; every blocked answer is undismissable. */
    @Test
    fun noRowStopsPlay() {
        for (row in section("rows")) {
            val name = row["name"].stringValue
            assertTrue(name, row["expect"]!!.obj["boot"].stringValue in setOf("none", "optional"))
            val decision = decideUpdate(decisionInput(row["input"]!!))
            if (decision is UpdateDecision.Blocked) assertTrue(name, isUndismissable(decision))
            if (isUndismissable(decision)) assertEquals(name, BootEvent.Decision.optional, bootDecision(decision))
        }
    }
}
