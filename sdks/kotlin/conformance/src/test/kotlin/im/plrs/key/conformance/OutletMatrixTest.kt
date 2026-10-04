// @pkey-feature outlet.detect
//
// The Kotlin runner for conformance/corpus/v2/outlet-matrix.json's decision rows (plans/P3-01.md
// §2.9, §4.7), with the Node, Python, Swift and Godot runners' row names: the signal table and
// platform data equal the compiled OUTLET_SIGNALS and OUTLET_PLATFORM_DATA, the capability tables
// equal `kinds` and `subkinds`, and every row runs through detectOutlet. `outlet.detect` stays
// planned until P6-12 adds the readers over :platform's install source.

package im.plrs.key.conformance

import im.plrs.key.core.DetectedOutlet
import im.plrs.key.core.DetectionStamp
import im.plrs.key.core.LISTING_URL_PREFIXES
import im.plrs.key.core.OUTLET_CAPABILITY_DEFAULTS
import im.plrs.key.core.OUTLET_KIND_VALUES
import im.plrs.key.core.OUTLET_PLATFORMS
import im.plrs.key.core.OUTLET_PLATFORM_DATA
import im.plrs.key.core.OUTLET_SIGNALS
import im.plrs.key.core.OUTLET_SUBKIND_VALUES
import im.plrs.key.core.OutletSignalSpec
import im.plrs.key.core.PLATFORM_NARROWING
import im.plrs.key.core.SUBKIND_NARROWING
import im.plrs.key.core.UNKNOWN_DETECTION
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.detectOutlet
import im.plrs.key.core.jsonEquals
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class OutletMatrixTest {
    private val matrix = Corpus.v2("outlet-matrix.json")

    private fun strings(e: JsonElement?) = e!!.arrayValue!!.map { it.stringValue!! }

    @Test
    fun signalTableEqualsTheMatrix() {
        assertEquals(strings(matrix["vocabulary"]!!.obj["signals"]), OUTLET_SIGNALS.map { it.signal })
        assertEquals(
            matrix["signals"]!!.arrayValue!!.map { OutletSignalSpec(it.obj["signal"].stringValue!!, it.obj["confidence"].stringValue) },
            OUTLET_SIGNALS,
        )
        assertEquals(strings(matrix["vocabulary"]!!.obj["kinds"]), OUTLET_KIND_VALUES)
        assertEquals(strings(matrix["vocabulary"]!!.obj["subkinds"]), OUTLET_SUBKIND_VALUES)
    }

    @Test
    fun platformDataEqualsTheMatrix() {
        val d = matrix["platformData"]!!.obj
        val p = OUTLET_PLATFORM_DATA
        assertEquals(strings(d["playStoreCertSha256s"]), p.playStoreCertSha256s)
        assertEquals(strings(d["altStorePalMarketplaceIds"]), p.altStorePalMarketplaceIds)
        assertEquals(strings(d["playPackages"]), p.playPackages)
        assertEquals(strings(d["obtainiumPackages"]), p.obtainiumPackages)
        assertEquals(strings(d["fdroidClientPackages"]), p.fdroidClientPackages)
        assertEquals(strings(d["systemInstallerPackages"]), p.systemInstallerPackages)
        assertEquals(d["macosStoreLeaves"].objectValue!!.mapValues { it.value.stringValue }, p.macosStoreLeaves)
        assertEquals(d["deadlineMs"].longValue, p.deadlineMs)
        assertEquals(
            d["listingUrlPrefixes"].objectValue!!.mapValues { strings(it.value) },
            LISTING_URL_PREFIXES,
        )
        assertEquals(
            setOf(
                "listingUrlPrefixes", "playStoreCertSha256s", "altStorePalMarketplaceIds", "playPackages",
                "obtainiumPackages", "fdroidClientPackages", "systemInstallerPackages", "macosStoreLeaves", "deadlineMs",
            ),
            d.keys,
        )
    }

    @Test
    fun capabilityTablesEqualTheMatrix() {
        val kinds = matrix["kinds"]!!.obj
        assertEquals(kinds.keys, OUTLET_CAPABILITY_DEFAULTS.keys)
        for ((kind, row) in kinds) {
            val caps = row.obj["capabilities"]?.obj ?: row.obj
            val c = OUTLET_CAPABILITY_DEFAULTS.getValue(kind)
            assertEquals("$kind binaryUpdates", caps["binaryUpdates"].stringValue, c.binaryUpdates)
            assertEquals("$kind codeUpdates", caps["codeUpdates"].boolValue, c.codeUpdates)
            assertEquals("$kind dataUpdates", caps["dataUpdates"].boolValue, c.dataUpdates)
            assertEquals("$kind channelSwitch", caps["channelSwitch"].boolValue, c.channelSwitch)
            assertEquals("$kind commerce", caps["commerce"].stringValue, c.commerce)
            assertEquals("$kind downloadedScripts", caps["downloadedScripts"].boolValue, c.downloadedScripts)
            row.obj["platforms"]?.let { assertEquals("$kind platforms", strings(it), OUTLET_PLATFORMS.getValue(kind)) }
        }
        val narrowing = matrix["platformNarrowing"]!!.obj
        assertEquals(
            "platformNarrowing",
            true,
            jsonEquals(narrowing, JsonObject(PLATFORM_NARROWING.mapValues { (_, k) -> JsonObject(k.mapValues { JsonObject(it.value) }) })),
        )
        val subkinds = matrix["subkinds"]!!.obj
        assertEquals(subkinds.keys, SUBKIND_NARROWING.keys)
        for ((sub, row) in subkinds) {
            val narrowing = row.obj["narrowing"]?.obj ?: row.obj
            assertEquals("$sub narrowing", JsonObject(SUBKIND_NARROWING.getValue(sub)).let { want -> jsonEquals(narrowing, want) }, true)
        }
    }

    @Test
    fun everyRow() {
        val f = Failures("outlet-matrix rows")
        val rows = matrix["rows"]!!.arrayValue!!.map { it.obj }
        f.equal(48, rows.size) { "row count" }
        for (row in rows) {
            val stamp = row["stamp"]?.takeIf { it !is JsonNull }?.obj?.let { s ->
                DetectionStamp(
                    s["outletKind"].stringValue!!, s["subkind"].stringValue,
                    s["outletIds"].objectValue?.mapValues { it.value.stringValue!! } ?: emptyMap(),
                )
            }
            val got = detectOutlet(stamp, row["signals"]!!.obj)
            val e = row["expect"]!!.obj
            val want = DetectedOutlet(e["kind"].stringValue!!, e["confidence"].stringValue, e["source"].stringValue, e["subkind"].stringValue)
            f.equal(want, got) { row["name"].stringValue!! }
        }
        f.done(48)
    }

    @Test
    fun malformedValuesAndMissingIdentitiesAreNoEvidence() {
        val stamp = DetectionStamp("direct", outletIds = mapOf("steamAppId" to "3166810", "snapName" to "diceroll"))
        val cases: List<Map<String, JsonElement>> = listOf(
            mapOf("linux.snapEnv" to JsonNull),
            mapOf("linux.snapEnv" to JsonPrimitive("diceroll")),
            mapOf("android.installSource" to JsonNull),
            mapOf("ios.appDistributor" to JsonPrimitive(7)),
            mapOf("unknown.signal" to JsonPrimitive(true)),
            mapOf("windows.packageIdentity" to JsonNull, "windows.signatureKind" to JsonPrimitive("Store")),
            mapOf("steam.libraryManifest" to JsonPrimitive(3166810)),
        )
        for (signals in cases) assertEquals("$signals", "direct", detectOutlet(stamp, signals).kind)
        assertEquals(UNKNOWN_DETECTION, detectOutlet(null, emptyMap()))
        assertEquals(UNKNOWN_DETECTION, detectOutlet(DetectionStamp("epic"), emptyMap()))
    }
}
