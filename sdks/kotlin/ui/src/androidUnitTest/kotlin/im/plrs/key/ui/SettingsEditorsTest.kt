// @pkey-feature ui.settings
// UI-KITS.md 4.3 Settings, typed controls from the catalog schema: a slider with its range stated
// and marked for a bounded number, a numeric field otherwise, a select for an enum, a text field,
// each committing a value of its own type and each offering "Reset to default" for a change made on
// this device; a locked row is never a control. And the kit's one switch (rule 6): a light knob.

package im.plrs.key.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.config.ConfigSource
import im.plrs.key.ui.brand.PolarisBrandTokens
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class SettingsEditorsTest {
    @get:Rule
    val rule = createComposeRule()

    private val sets = mutableListOf<Pair<String, JsonElement>>()
    private val resets = mutableListOf<String>()

    private fun show(vararg entries: PolarisSettingEntry) {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                    PolarisSettingsScreen(
                        PolarisSettingsUi(loading = false, entries = entries.toList()),
                        onSet = { k, v -> sets += k to v },
                        onReset = { resets += it },
                    )
                }
            }
        }
        rule.waitForIdle()
    }

    private val volume = PolarisSettingEntry(
        "audio.volume", "Music volume", "80", ConfigSource.local,
        editor = PolarisSettingEditor.Number("80", integer = true, min = 0.0, max = 100.0),
    )

    private val sliders = SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress)

    @Test
    fun aBoundedNumberIsASliderWithItsRangeStatedAndMarked() {
        show(volume)
        rule.onAllNodes(sliders).assertCountEquals(1)
        // The range in words under the label, and the bounds at both ends of the track.
        rule.onNodeWithText("Between 0 and 100").assertIsDisplayed()
        rule.onNodeWithText("0").assertIsDisplayed()
        rule.onNodeWithText("100").assertIsDisplayed()
        // The current value is shown beside the label.
        rule.onNodeWithText("80").assertIsDisplayed()
    }

    @Test
    fun theSliderCommitsAWholeNumberWhenTheSettingIsAnInteger() {
        show(volume)
        rule.onNode(sliders).performSemanticsAction(SemanticsActions.SetProgress) { it(30.4f) }
        rule.waitForIdle()
        assertEquals(listOf<Pair<String, JsonElement>>("audio.volume" to JsonPrimitive(30L)), sets)
    }

    @Test
    fun aFractionalRangeCommitsADecimal() {
        show(
            PolarisSettingEntry(
                "audio.pan", "Balance", "0.5", ConfigSource.remoteDefault,
                editor = PolarisSettingEditor.Number("0.5", integer = false, min = 0.0, max = 1.0),
            ),
        )
        rule.onNode(sliders).performSemanticsAction(SemanticsActions.SetProgress) { it(0.25f) }
        rule.waitForIdle()
        assertEquals(listOf<Pair<String, JsonElement>>("audio.pan" to JsonPrimitive(0.25)), sets)
    }

    @Test
    fun aNumberWithNoUpperBoundIsAFieldThatCommitsOnDone() {
        show(
            PolarisSettingEntry(
                "cache.mb", "Cache size", "256", ConfigSource.remoteDefault,
                editor = PolarisSettingEditor.Number("256", integer = true, min = 16.0, max = null),
            ),
        )
        rule.onAllNodes(sliders).assertCountEquals(0)
        rule.onNode(hasSetTextAction()).performTextReplacement("512")
        rule.onNode(hasSetTextAction()).performImeAction()
        assertEquals(listOf<Pair<String, JsonElement>>("cache.mb" to JsonPrimitive(512L)), sets)
        // Below the minimum, or not a number, nothing is saved.
        rule.onNode(hasSetTextAction()).performTextReplacement("4")
        rule.onNode(hasSetTextAction()).performImeAction()
        rule.onNode(hasSetTextAction()).performTextReplacement("many")
        rule.onNode(hasSetTextAction()).performImeAction()
        assertEquals(1, sets.size)
    }

    @Test
    fun anEnumIsASelectThatCommitsTheChosenOption() {
        show(
            PolarisSettingEntry(
                "graphics.quality", "Graphics quality", "high", ConfigSource.remoteDefault,
                editor = PolarisSettingEditor.Choice(listOf("Low" to JsonPrimitive("low"), "Medium" to JsonPrimitive("medium"), "High" to JsonPrimitive("high")), selected = 2),
            ),
        )
        // The current choice is the row's value; the menu is closed.
        rule.onNodeWithText("High").assertIsDisplayed()
        rule.onNodeWithText("Medium").assertDoesNotExist()
        rule.onNodeWithText("Graphics quality").performClick()
        rule.onNodeWithText("Medium").assertIsDisplayed()
        rule.onNodeWithText("Medium").performClick()
        rule.waitForIdle()
        assertEquals(listOf<Pair<String, JsonElement>>("graphics.quality" to JsonPrimitive("medium")), sets)
    }

    @Test
    fun aTextSettingCommitsOnDoneAndHonoursItsMaximumLength() {
        show(
            PolarisSettingEntry(
                "player.name", "Display name", "Ada", ConfigSource.fallback,
                editor = PolarisSettingEditor.Text("Ada", maxLength = 6), description = "Shown on the leaderboard.",
            ),
        )
        rule.onNodeWithText("Shown on the leaderboard.").assertIsDisplayed()
        rule.onNode(hasSetTextAction()).performTextReplacement("Grace Brewster Hopper")
        rule.onNode(hasSetTextAction()).performImeAction()
        assertEquals(listOf<Pair<String, JsonElement>>("player.name" to JsonPrimitive("Grace ")), sets)
    }

    @Test
    fun aChangeMadeHereOffersResetUnderEveryKindOfControl() {
        show(
            volume,
            PolarisSettingEntry("graphics.quality", "Graphics quality", "high", ConfigSource.local, editor = PolarisSettingEditor.Choice(listOf("High" to JsonPrimitive("high")), 0)),
            PolarisSettingEntry("player.name", "Display name", "Ada", ConfigSource.local, editor = PolarisSettingEditor.Text("Ada")),
            PolarisSettingEntry("audio.pan", "Balance", "0.5", ConfigSource.remoteDefault, editor = PolarisSettingEditor.Number("0.5", false, 0.0, 1.0)),
        )
        rule.onAllNodes(androidx.compose.ui.test.hasText("Reset to default")).assertCountEquals(3)
        rule.onAllNodes(androidx.compose.ui.test.hasText("Reset to default"))[0].performClick()
        assertEquals(listOf("audio.volume"), resets)
    }

    @Test
    fun aLockedRowIsNeverAControl() {
        show(volume.copy(source = ConfigSource.enforced))
        rule.onAllNodes(sliders).assertCountEquals(0)
        rule.onNodeWithText("80").assertIsDisplayed()
    }

    @Test
    fun theSwitchIsOneControlWithALightKnob() {
        show(PolarisSettingEntry("hints.enabled", "Show hints", "true", ConfigSource.remoteDefault, editor = PolarisSettingEditor.Toggle(true)))
        rule.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)).assertCountEquals(1)
    }

    @Test
    fun theKnobIsWhiteOnEveryTrackThatWhiteReadsOn() {
        val accent = PolarisBrandTokens.accent("core", dark = true).solid
        assertEquals(Color.White, polarisKnobColor(accent, Color.Black))
        // A neutral off-track: the outline colour of both brand themes.
        assertEquals(Color.White, polarisKnobColor(PolarisBrandTokens.Dark.borderStrong, Color.Black))
        assertEquals(Color.White, polarisKnobColor(PolarisBrandTokens.Light.borderStrong, Color.Black))
    }

    @Test
    fun theKnobStepsToThePageOnAnInkTrackThatWhiteWouldVanishOn() {
        // Dark theme, no product accent: the primary is near-white ink (UI-KITS.md 1.2).
        val ink = PolarisBrandTokens.Dark.textStrong
        val page = PolarisBrandTokens.Dark.surfacePage
        val knob = polarisKnobColor(ink, page)
        assertEquals(page, knob)
        assertTrue(knob != Color.White)
    }
}
