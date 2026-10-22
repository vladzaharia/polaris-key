// @pkey-feature ui.kit ui.update ui.activate ui.settings
// The follow-ups of the Compose kit's built UX review (UK-09: F-4, F-5, F-6) asserted on the
// semantics: the registry states PolarisKitScreen draws, LicenseChoice's way on, ChannelPicker.

package im.plrs.key.ui

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
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
class KitScreenFixesTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setContent {
            androidx.compose.runtime.CompositionLocalProvider(LocalPolarisReduceMotion provides true) {
                StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { content() } }
            }
        }
        rule.waitForIdle()
    }

    private fun matrix(id: String, content: @androidx.compose.runtime.Composable (MatrixCase) -> Unit) {
        val case = MatrixCases.case(id)
        show { content(case) }
    }

    private fun assertTheBar(id: String) {
        matrix(id) { PolarisKitScreen(it.screen, rows = it.rows) }
        val bar = rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)).fetchSemanticsNodes()
        assertEquals("$id: one bar", 1, bar.size)
        assertEquals(ProgressBarRangeInfo(0.4f, 0f..1f), bar.single().config[SemanticsProperties.ProgressBarRangeInfo])
    }

    @Test
    fun theProgressStateDrawsItsBarFromTheFraction() = assertTheBar("updateProgress-downloading")

    @Test
    fun theDownloadingPromptDrawsItsBarFromTheFraction() = assertTheBar("updatePrompt-downloading")

    @Test
    fun restartWhenReadyIsThePrimaryAboveLater() {
        matrix("updatePrompt-downloading") { PolarisKitScreen(it.screen, rows = it.rows) }
        val restart = rule.onNodeWithText(sampleCopy.updateRestartWhenReady).getUnclippedBoundsInRoot()
        val later = rule.onNodeWithText(sampleCopy.updateLater).getUnclippedBoundsInRoot()
        assertTrue("Restart when ready leads: $restart vs $later", restart.top < later.top)
    }

    @Test
    fun theUpdateIsDoneStatusIsNotAButton() {
        matrix("updateProgress-done") { PolarisKitScreen(it.screen, rows = it.rows) }
        rule.onNodeWithText("Up to date").assertIsDisplayed()
        assertEquals(0, rule.onAllNodes(hasText("Up to date") and hasClickAction()).fetchSemanticsNodes().size)
    }

    @Test
    fun aBusyActivateKeepsItsLabelOnABusyButton() {
        matrix("activate-busy") { PolarisKitScreen(it.screen, rows = it.rows) }
        rule.onNodeWithText("Activate license").assertIsDisplayed().assertIsNotEnabled()
        rule.onNodeWithText("Activating…").assertDoesNotExist()
    }

    @Test
    fun theLoadingAccountDrawsNoTextBodyButAnAnnouncement() {
        matrix("accountAndLicense-loading") { PolarisKitScreen(it.screen, rows = it.rows) }
        rule.onNodeWithText("Account and license").assertIsDisplayed()
        rule.onNodeWithText("Loading…").assertDoesNotExist()
    }

    @Test
    fun anAllFullLicenseChoiceHasWayOn() {
        var cancelled = 0
        matrix("licenseChoice-all-full") { c ->
            PolarisLicenseChoice(c.screen, c.rows.choices!!, onAction = { if (it == KitAction.cancel) cancelled++ })
        }
        rule.onNodeWithText("Cancel").assertIsDisplayed().performClick()
        assertEquals(1, cancelled)
    }

    @Test
    fun theChannelPickerIsAGroupWithHumanNamesAndAnErrorSlot() {
        show { PolarisChannelPicker(PolarisChannelUi("stable", listOf("stable", "early-access")), onSelect = {}, error = "Couldn't switch.") }
        assertEquals(1, rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.SelectableGroup)).fetchSemanticsNodes().size)
        rule.onNodeWithText("Early access").assertIsDisplayed()
        rule.onNodeWithText("early-access").assertDoesNotExist()
        rule.onNodeWithText("Couldn't switch.").assertIsDisplayed()
    }

    @Test
    fun theCatalogsChannelLabelWinsOverTheId() {
        show { PolarisChannelPicker(PolarisChannelUi("stable", listOf("stable", "ea"), labels = mapOf("ea" to "Early access program")), onSelect = {}) }
        rule.onNodeWithText("Early access program").assertIsDisplayed()
    }

    @Test
    fun aLicenseLockedPickerSaysTheLicenseFixesIt() {
        show { PolarisChannelPicker(PolarisChannelUi("stable", listOf("stable"), lockedByLicense = true)) }
        rule.onNodeWithText("Your license includes this channel only.").assertIsDisplayed()
        rule.onNodeWithText("Stable").assertIsDisplayed()
    }
}
