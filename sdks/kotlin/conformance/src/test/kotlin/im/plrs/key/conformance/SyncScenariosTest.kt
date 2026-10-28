// @pkey-feature sync.scenarios
// @pkey-feature sync.settings
//
// The Kotlin runner for conformance/corpus/v2/sync-scenarios.json (read in place), mirroring the
// Python test_sync_scenarios.py. `settingCases` runs in full. The scenario replays are the shell the
// machine slices fill in: PENDING lists every scenario until its slice ports it (D-N1), by name, with
// the slice that ports it, and the `e2e-` prefix rule holds the E2E scenarios until the last machine
// slice. The last machine slice deletes PENDING and the prefix rule, so a scenario X-1.1 adds runs
// without an edit here. The machine has no crypto, so the JCA and Tink passes both run this suite.

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
    fun everyPendingNameIsACorpusScenario() {
        val names = scenarios.map { it["name"].stringValue }.toSet()
        assertTrue("PENDING names a scenario the corpus does not have", names.containsAll(PENDING))
    }

    @Test
    fun everyScenarioIsHeldOrDriven() {
        // The driver is the machine slices' to fill in. Until then every scenario is held, but its shape
        // must read (an init block, steps of known kinds), and a scenario that is neither held nor driven
        // fails: a new corpus row is never silently skipped.
        val kinds = setOf("local", "advance", "network", "respond", "root", "signIn", "signOut", "relaunch", "assert")
        for (sc in scenarios) {
            val name = sc["name"].stringValue!!
            assertTrue("$name: init", sc["init"] is JsonObject)
            for (step in sc["steps"].arrayValue!!) {
                val kind = (step as JsonObject).keys.single()
                assertTrue("$name: unknown step $kind", kind in kinds)
            }
            assertTrue("$name: no machine drives it and PENDING does not hold it", pending(name))
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

    private fun pending(name: String): Boolean = name in PENDING || name.startsWith("e2e-")

    private companion object {
        /**
         * The scenarios no slice has ported yet; each machine slice removes the names it ports (D-N1).
         * K4 deletes this set and the `e2e-` prefix rule.
         */
        val PENDING: Set<String> = setOf(
            // U-07.K2 (the local half: no `respond` step).
            "key-activated-device-local-only",
            "sign-out-discard-unsynced",
            "pending-expire-after-30-days",
            // U-07.K3 (the exchange half).
            "optimistic-read-pending",
            "max-policy-optimistic",
            "debounce-slider",
            "clock-offset-folded",
            "clock-slow-precontact-restamp",
            "clock-fast-precontact-restamp",
            "lww-conflict-server-wins",
            "conflict-then-ok-one-push",
            "request-failure-keeps-journal",
            "conflict-rebase-new-mutation",
            "one-outstanding-cas",
            "account-switch-partition",
            "first-sign-in-empty-cloud",
            "first-sign-in-newer-and-older-cloud",
            "sign-out-local-edit-sign-in-other",
            "account-required-on-push",
            "relink-clears-binding",
            "merge-alias-subject-change",
            "unauthorized-pauses",
            "sign-out-flush-succeeds",
            "sign-out-flush-timeout",
            "on-sign-out-keep",
            "journal-loss-new-client-id",
            "client-mismatch-regenerates",
            "cursor-expired-with-pending",
            "member-merge",
            "union-add-remove",
            "renamed-and-dropped-keys",
            "locked-key-refused",
            "invalid-stored-value",
            "rejected-result-reverts",
            "relaunch-commits-and-pushes",
            "open-setting-synced",
            "open-setting-too-large",
            "local-key-stays-local",
            "secret-key-refused",
            "platform-scope-target",
            "config-local-import-loses-to-cloud",
            "record-max-field-conflict",
            "attestation-required-blocks",
            "other-403-blocks",
            "writes-paused-keeps-journal",
            "quota-rejected-keeps-value",
            "quota-raised-retries",
            "quota-lowered-deletes-nothing",
            "terminal-rejection-reverts",
            "server-mode-unchanged",
        )
    }
}
