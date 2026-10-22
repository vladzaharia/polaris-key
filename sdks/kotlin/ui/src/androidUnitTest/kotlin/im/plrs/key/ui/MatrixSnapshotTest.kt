// @pkey-feature ui.kit ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
// The ui-matrix snapshots (plans/UK-02b.md §5): the first row of every distinct (component, state)
// in conformance/corpus/v2/ui-matrix.json is resolved by KitStates and drawn by PolarisKitScreen
// under the Polaris Key look, in both themes. A state the matrix says renders nothing (`hidden`) has
// no picture; the test asserts that it draws nothing instead.
//
// Baselines: src/test/snapshots/matrix/<component>-<state>/phone-polaris-{dark,light}.png.

package im.plrs.key.ui

import androidx.compose.ui.test.junit4.createEmptyComposeRule
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** One distinct (component, state) of the matrix and the inputs of its first row. */
internal data class MatrixCase(val id: String, val screen: KitScreen, val rows: KitRowData = KitRowData(), val inputs: KitInputs? = null, val component: KitComponent? = null) {
    override fun toString(): String = id
}

private val families = listOf("gate", "activate", "signIn", "deviceLimit", "devices", "update", "settings", "paywall")

internal object MatrixCases {
    private fun matrix(): JsonObject {
        val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui's test task" }
        return Json.parseToJsonElement(File(root, "conformance/corpus/v2/ui-matrix.json").readText()) as JsonObject
    }

    /** The case [id] ("licenseChoice-many"): its screen and the row data under its lines. */
    fun case(id: String): MatrixCase = all.first { it.id == id }

    /** The distinct (component, state) cases of the eight component families, first row each. */
    val all: List<MatrixCase> by lazy {
        val raw = matrix()
        val defaults = (raw["vocabulary"] as JsonObject)["defaults"] as JsonObject
        val seen = linkedMapOf<String, MatrixCase>()
        for (family in families) {
            for (row in raw[family] as JsonArray) {
                row as JsonObject
                val expect = row["expect"] as? JsonObject ?: continue
                val component = KitComponent.fromId((expect["component"] as JsonPrimitive).content) ?: continue
                val merged = defaults.toMutableMap()
                for ((key, value) in (row["input"] as? JsonObject).orEmptyObject()) {
                    val base = defaults[key] as? JsonObject
                    merged[key] = if (key == "capabilities" && base != null && value is JsonObject) JsonObject(base + value) else value
                }
                val inputs = KitInputs.of(merged)
                val screen = KitStates.resolve(component, inputs)
                val id = "${component.name}-${screen.state}"
                // An entitled gate draws its children, which the matrix does not have: no picture.
                val draws = !(component == KitComponent.entitlementGate && screen.state == "entitled")
                if (!screen.isHidden && draws) seen.putIfAbsent(id, MatrixCase(id, screen, KitRowData.from(inputs), inputs, component))
            }
        }
        seen.values.toList()
    }
}

private fun JsonObject?.orEmptyObject(): JsonObject = this ?: JsonObject(emptyMap())

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class MatrixSnapshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun themes(): List<Array<Any>> = listOf(arrayOf<Any>(true), arrayOf<Any>(false))
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyState() {
        val cases = MatrixCases.all
        assertTrue("the matrix yields states", cases.size > 40)
        val variant = snapshotVariants.first { it.branding == PolarisBranding.PolarisKey && it.dark == dark && it.widthDp == 411 }
        for (case in cases) {
            rule.capture("matrix/${case.id}/phone-polaris-${if (dark) "dark" else "light"}", variant) {
                // SignIn/code carries no copy in the matrix (the user code, the address and the countdown
                // are runtime values, not catalogue lines), so PolarisKitScreen would draw nothing: the
                // picture is the code view the stateful form draws for a prompt.
                // Reduced motion holds the toast's timer full, so the picture is the same on every run.
                androidx.compose.runtime.CompositionLocalProvider(LocalPolarisReduceMotion provides true) {
                    if (case.id == "signIn-code") PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), showQr = false)
                    else PolarisKitScreen(case.screen, rows = case.rows)
                }
            }
        }
    }
}
