// @pkey-feature sync.scenarios
// @pkey-feature sync.settings config.sync
//
// The Kotlin runner for conformance/corpus/v2/sync-scenarios.json (read in place), mirroring the
// Python test_sync_scenarios.py. `settingCases` runs in full and every scenario replays (the skip list
// of D-N1 is gone), so a row X-1.1 adds runs without an edit. The machine has no crypto, so the JCA and
// Tink passes both run this suite.

package im.plrs.key.conformance

import im.plrs.key.core.SYNC_DEBOUNCE_MS
import im.plrs.key.core.SYNC_MAX_CLOCK_SKEW_MS
import im.plrs.key.core.SYNC_MAX_MUTATIONS
import im.plrs.key.core.SYNC_MAX_VALUE_BYTES
import im.plrs.key.core.SYNC_PENDING_DAYS
import im.plrs.key.core.SYNC_SCENARIOS_VERSION
import im.plrs.key.core.SYNC_SIGNOUT_FLUSH_MS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncJson
import im.plrs.key.core.sync.SyncRoutes
import im.plrs.key.core.sync.SyncUserSetting
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncScenariosTest : ConformanceSuite() {
    private val corpus: JsonObject = Corpus.v2("sync-scenarios.json")
    private val scenarios: List<JsonObject> = corpus["scenarios"].arrayValue!!.map { it as JsonObject }
    private val settingCases: List<JsonObject> = corpus["settingCases"].arrayValue!!.map { it as JsonObject }

    @Test
    fun corpusConstantsMatchTheGeneratedOnes() {
        assertEquals(SYNC_SCENARIOS_VERSION.toLong(), corpus["syncScenariosVersion"].longValue)
        val want = buildJsonObject {
            put("debounceMs", SYNC_DEBOUNCE_MS)
            put("signOutFlushMs", SYNC_SIGNOUT_FLUSH_MS)
            put("pendingDays", SYNC_PENDING_DAYS)
            put("maxMutationsPerPush", SYNC_MAX_MUTATIONS)
            put("maxClockSkewMs", SYNC_MAX_CLOCK_SKEW_MS)
            put("maxValueBytes", SYNC_MAX_VALUE_BYTES)
        }
        assertTrue("constants", SyncJson.jsonEqual(want, corpus["constants"]))
    }

    @Test
    fun everyScenarioReplays() {
        // No skip list: a scenario X-1.1 adds runs here without an edit.
        val kinds = setOf("local", "advance", "network", "respond", "root", "signIn", "signOut", "relaunch", "assert")
        for (sc in scenarios) {
            val name = sc["name"].stringValue!!
            assertTrue("$name: init", sc["init"] is JsonObject)
            for (step in sc["steps"].arrayValue!!) {
                val kind = (step as JsonObject).keys.single()
                assertTrue("$name: unknown step $kind", kind in kinds)
            }
            SyncScenarioDriver(corpus["product"].stringValue!!, sc).run()
        }
    }

    @Test
    fun settingCasesRunInFull() {
        for (case in settingCases) {
            val name = case["name"].stringValue
            val entries = case["entries"].arrayValue!!.map { it as JsonObject }
            val issues = JsonArray(
                entries.flatMap { e ->
                    SyncUserSetting.issues(e).map {
                        buildJsonObject {
                            put("key", e.getValue("key"))
                            put("code", it.code)
                            put("severity", it.severity)
                        }
                    }
                },
            )
            assertTrue("$name: issues", SyncJson.jsonEqual(case["issues"], issues))
            if (case["routes"] is JsonNull) {
                assertTrue("$name: a refused case holds an error", issues.any { (it as JsonObject)["severity"].stringValue == "error" })
                continue
            }
            val routes = SyncRoutes.syncedSettings(buildJsonObject { put("entries", JsonArray(entries)) })
            assertTrue("$name: routes", SyncJson.jsonEqual(case["routes"], JsonArray(routes)))
            for (key in case["open"].arrayValue!!) {
                assertFalse("$name: ${key.stringValue} is open", routes.any { it["key"] == key })
            }
        }
    }

    @Test
    fun nullIsAValueAndNumbersCompareByValue() {
        assertFalse(SyncJson.jsonEqual(null, JsonNull))
        assertTrue(SyncJson.jsonEqual(JsonNull, JsonNull))
        assertTrue(SyncJson.jsonEqual(JsonPrimitive(1), kotlinx.serialization.json.Json.parseToJsonElement("1.0")))
        assertFalse(SyncJson.jsonEqual(JsonPrimitive(true), JsonPrimitive(1)))
        assertFalse(SyncJson.isNumber(JsonPrimitive(true)))
        assertFalse(SyncJson.isNumber(JsonPrimitive("1")))
        assertTrue(SyncJson.isInteger(kotlinx.serialization.json.Json.parseToJsonElement("2.0")))
        assertFalse(SyncJson.isInteger(JsonPrimitive(2.5)))
        // UTF-16 code-unit order: U+FF5E sorts above the surrogate pair of U+1F600.
        val o = JsonObject(mapOf("～" to JsonPrimitive(1), "😀" to JsonPrimitive(2)))
        assertEquals(listOf("😀", "～"), SyncJson.sortedKeys(o))
    }
}
