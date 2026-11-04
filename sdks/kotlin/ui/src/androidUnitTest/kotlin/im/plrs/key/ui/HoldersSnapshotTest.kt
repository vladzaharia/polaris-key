// @pkey-feature ui.kit.holders
// The holders family of ui-matrix.json (UK-43.9): every ActivateDone, AddToAccount and SignIn key-done /
// attach / added row, resolved by KitStates and drawn by PolarisKitScreen under the Polaris Key look, in
// both themes, plus the AddToAccount wait (the code to check) that no row carries, and the form on a TV.
// AccountAndLicense's floating row is UK-43.10's.
//
// Baselines: src/test/snapshots/holders/<n>-<component>-<state>/<variant>.png.

package im.plrs.key.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createEmptyComposeRule
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
import java.io.File

private class HolderCase(val id: String, val screen: KitScreen)

private object HolderCases {
    private fun matrix(): JsonObject {
        val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui's test task" }
        return Json.parseToJsonElement(File(root, "conformance/corpus/v2/ui-matrix.json").readText()) as JsonObject
    }

    private fun inputsOf(raw: JsonObject, row: JsonObject?): KitInputs {
        val defaults = (raw["vocabulary"] as JsonObject)["defaults"] as JsonObject
        val merged = defaults.toMutableMap()
        for ((key, value) in (row?.get("input") as? JsonObject) ?: JsonObject(emptyMap())) merged[key] = value
        return KitInputs.of(merged)
    }

    private fun slug(name: String) = name.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(48)

    val all: List<HolderCase> by lazy {
        val raw = matrix()
        val cases = mutableListOf<HolderCase>()
        (raw["holders"] as JsonArray).forEachIndexed { n, row ->
            row as JsonObject
            val expect = row["expect"] as JsonObject
            val component = KitComponent.fromId((expect["component"] as JsonPrimitive).content)
            // AccountAndLicense's floating row is UK-43.10's.
            val screen = component?.takeIf { it != KitComponent.accountAndLicense }?.let { KitStates.resolve(it, inputsOf(raw, row)) }
            if (screen != null && !screen.isHidden) cases += HolderCase("%02d-%s".format(n, slug((row["name"] as JsonPrimitive).content)), screen)
        }
        // The wait for the browser: AddToAccount with the sign-in's code (no matrix row carries a code).
        val wait = inputsOf(raw, null)
            .with("addToAccount", JsonObject(mapOf("step" to JsonPrimitive("busy"), "deviceKind" to JsonPrimitive("computer"))))
            .with("deviceCode", JsonObject(mapOf("phase" to JsonPrimitive("waiting"), "userCode" to JsonPrimitive("WDJB-MJHT"))))
        cases += HolderCase("wait-code", KitStates.resolve(KitComponent.addToAccount, wait))
        cases
    }
}

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class HoldersSnapshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun themes(): List<Array<Any>> = listOf(arrayOf<Any>(true), arrayOf<Any>(false))
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyHolderRow() {
        val cases = HolderCases.all
        assertTrue("the holders family yields screens", cases.size > 20)
        val variant = snapshotVariants.first { it.branding == PolarisBranding.PolarisKey && it.dark == dark && it.widthDp == 411 }
        for (case in cases) {
            rule.capture("holders/${case.id}/phone-polaris-${if (dark) "dark" else "light"}", variant) {
                CompositionLocalProvider(LocalPolarisReduceMotion provides true) { PolarisKitScreen(case.screen) }
            }
        }
    }

    @Test
    fun theFormOnATelevisionAndAtLargeType() {
        val form = HolderCases.all.first { it.screen.component == KitComponent.addToAccount && it.screen.state == "form" }
        val tv = SnapshotVariant("tv-polaris", PolarisBranding.PolarisKey, dark, widthDp = 960, heightDp = 540, tv = true)
        val large = SnapshotVariant("phone-polaris-font200", PolarisBranding.PolarisKey, dark, fontScale = 2f)
        val theme = if (dark) "dark" else "light"
        rule.capture("holders/form-tv/$theme", tv) { PolarisKitScreen(form.screen) }
        rule.capture("holders/form-font200/$theme", large) { PolarisKitScreen(form.screen) }
    }
}
