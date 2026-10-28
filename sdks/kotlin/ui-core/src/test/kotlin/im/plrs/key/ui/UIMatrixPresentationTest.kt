// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
//
// The Kotlin presentation core against conformance/corpus/v2/ui-matrix.json (plans/UK-02b.md §5):
// every row of all eleven families, never skipping one. Component rows compare the component, the
// state, the sorted copy keys and the sorted actions; a `mustNot` row also asserts that none of its
// forbidden states, copy keys or actions appear. `theme` rows compare the resolved name, accent
// source, scheme, icon and preset; `i18n` rows the formatted string.
//
// Families: gate, activate, signIn, deviceLimit, devices, update, settings, paywall, cloudSync, theme, i18n.
package im.plrs.key.ui

import im.plrs.key.core.UI_MATRIX_VERSION
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UIMatrixPresentationTest {
    private val matrix = UIMatrix.load()

    @Test
    fun theMatrixIsTheVersionTheCoreImplements() {
        assertEquals(UI_MATRIX_VERSION, matrix.version)
        assertEquals(UI_MATRIX_VERSION, KitStates.uiMatrixVersion)
    }

    @Test fun gateFamily() = runFamily("gate")

    @Test fun activateFamily() = runFamily("activate")

    @Test fun signInFamily() = runFamily("signIn")

    @Test fun deviceLimitFamily() = runFamily("deviceLimit")

    @Test fun devicesFamily() = runFamily("devices")

    @Test fun updateFamily() = runFamily("update")

    @Test fun settingsFamily() = runFamily("settings")

    @Test fun paywallFamily() = runFamily("paywall")

    @Test fun cloudSyncFamily() = runFamily("cloudSync")

    @Test
    fun themeFamily() {
        val rows = matrix.rows("theme")
        val failures = mutableListOf<String>()
        for (row in rows) {
            val name = row.string("name") ?: "?"
            val input = row.obj("input") ?: JsonObject(emptyMap())
            val kit = requireNotNull(KitKind.entries.firstOrNull { it.id == input.string("kit") }) { "$name: kit" }
            val preset = KitPreset.entries.firstOrNull { it.id == input.string("preset") } ?: KitPreset.polarisKey
            val scheme = KitColorScheme.entries.firstOrNull { it.id == input.string("colorScheme") }
            val rest = JsonObject(input - setOf("kit", "preset", "colorScheme"))
            val theme = KitIdentity.theme(matrix.inputs(rest), kit, preset, scheme)
            val expect = requireNotNull(row.obj("expect")) { "$name: expect" }
            failures.compare("$name name", expect.string("name"), theme.name)
            failures.compare("$name accentSource", expect.string("accentSource"), theme.accentSource.id)
            failures.compare("$name colorScheme", expect.string("colorScheme"), theme.colorScheme.id)
            failures.compare("$name icon", expect.string("icon"), theme.icon.id)
            failures.compare("$name preset", expect.string("preset"), theme.preset.id)
        }
        failures.assertNone("theme (${rows.size} rows)")
    }

    @Test
    fun i18nFamily() {
        val rows = matrix.rows("i18n")
        val failures = mutableListOf<String>()
        for (row in rows) {
            val name = row.string("name") ?: "?"
            val args = row.obj("args")?.mapValues { (_, value) ->
                val primitive = value as JsonPrimitive
                val number = if (primitive.isString) null else primitive.intOrNull
                if (number != null) CopyArgument.Number(number) else CopyArgument.Text(primitive.content)
            } ?: emptyMap()
            val overrides = row.obj("overrides")?.mapValues { (_, keys) ->
                (keys as JsonObject).mapValues { (_, text) -> (text as JsonPrimitive).content }
            } ?: emptyMap()
            val catalog = KitCopy.bundled.overriding(overrides)
            val key = requireNotNull(row.string("key")) { "$name: key" }
            val locale = requireNotNull(row.string("locale")) { "$name: locale" }
            failures.compare(name, row.string("expect"), catalog.format(key, locale, args))
        }
        failures.assertNone("i18n (${rows.size} rows)")
    }

    private fun runFamily(family: String) {
        val rows = matrix.rows(family)
        val failures = mutableListOf<String>()
        for (row in rows) {
            val name = row.string("name") ?: "?"
            val expect = requireNotNull(row.obj("expect")) { "$name: expect" }
            val componentId = expect.string("component") ?: ""
            val component = requireNotNull(KitComponent.fromId(componentId)) { "$name: unknown component $componentId" }
            val got = KitStates.resolve(component, matrix.inputs(row.obj("input")))
            val state = requireNotNull(expect.string("state")) { "$name: state" }
            failures.compare("$name component", component, got.component)
            failures.compare("$name state", state, got.state)
            failures.compare("$name copy", expect.array("copy")?.strings().orEmpty().sorted(), got.copyKeys)
            failures.compare(
                "$name actions",
                expect.array("actions")?.strings().orEmpty().sorted(),
                got.actions.map(KitAction::id).sorted(),
            )
            if (state == "hidden" && (got.copy.isNotEmpty() || got.actions.isNotEmpty())) {
                failures += "$name: hidden renders nothing"
            }
            row.obj("mustNot")?.let { forbidden ->
                forbidden.array("states")?.strings()?.forEach { forbiddenState ->
                    if (got.state == forbiddenState) failures += "$name: must not resolve $forbiddenState"
                }
                forbidden.array("copy")?.strings()?.forEach { key ->
                    if (got.shows(key)) failures += "$name: must not show $key"
                }
                forbidden.array("actions")?.strings()?.forEach { action ->
                    if (got.actions.any { it.id == action }) failures += "$name: must not offer $action"
                }
            }
        }
        failures.assertNone("$family (${rows.size} rows)")
    }

    private fun MutableList<String>.compare(label: String, expected: Any?, actual: Any?) {
        if (expected != actual) add("$label: expected <$expected> but was <$actual>")
    }

    private fun List<String>.assertNone(family: String) {
        assertTrue("$family: ${size} row mismatches\n${joinToString("\n")}", isEmpty())
    }
}

/** conformance/corpus/v2/ui-matrix.json, read in place (the corpus is never copied). */
private class UIMatrix(val raw: JsonObject) {
    private val defaults: JsonObject = raw.obj("vocabulary").obj("defaults") ?: error("vocabulary.defaults")

    val version: Int? get() = raw["uiMatrixVersion"].integer()

    fun rows(family: String): List<JsonObject> {
        val rows = requireNotNull(raw.array(family)) { "No $family family" }.objects()
        assertTrue("$family has rows", rows.isNotEmpty())
        return rows
    }

    /**
     * A row's input over `vocabulary.defaults`: a member the row omits takes the default, and
     * `capabilities` merges member by member. An explicit `null` (no presentation) stays null.
     */
    fun inputs(row: JsonObject?): KitInputs {
        val merged = defaults.toMutableMap()
        for ((key, value) in row.orEmpty()) {
            val base = defaults[key] as? JsonObject
            merged[key] = if (key == "capabilities" && base != null && value is JsonObject) {
                JsonObject(base + value)
            } else {
                value
            }
        }
        return KitInputs.of(merged)
    }

    companion object {
        fun load(): UIMatrix {
            val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui-core's test task" }
            val text = File(root, "conformance/corpus/v2/ui-matrix.json").readText()
            return UIMatrix(Json.parseToJsonElement(text) as JsonObject)
        }
    }
}

private fun JsonObject?.orEmpty(): JsonObject = this ?: JsonObject(emptyMap())
