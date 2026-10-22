// @pkey-feature ui.devicelimit
// UI-KITS.md 4.3 DeviceLimit in the browser mode layer 1 ships: the product header, "Replace a
// device", "Your license is on 3 of 3 devices", the lede, the neutral seat meter (an image with a
// label, only when the refusal carries the counts), Open in browser as the one primary, and Back.
// The counts are absent from a refusal that has none: then no meter and no count.

package im.plrs.key.ui

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class DeviceLimitStepTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy
    private val keyChanges = mutableListOf<String>()

    private fun show(limit: ActivationResult.DeviceLimit) {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGateScreen(
                        gateUi(LicenseStatus.needsActivation),
                        PolarisActivationUi(key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", error = PolarisActivationError.Refused(limit), manageUrl = limit.manageUrl),
                        onKeyChange = { keyChanges += it },
                        onSignIn = null,
                    )
                }
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun theStepNamesTheCountsAndDrawsTheNeutralMeter() {
        show(ActivationResult.DeviceLimit(3, 3, SAMPLE_MANAGE_URL))
        rule.onNodeWithText("Replace a device").assertIsDisplayed()
        rule.onNodeWithText("Your license is on 3 of 3 devices").assertIsDisplayed()
        rule.onNodeWithText(copy.format(copy.deviceLimitBrowser, "Diceroll")).assertIsDisplayed()
        rule.onNodeWithText("3 of 3 in use").assertIsDisplayed()
        // The meter is one labelled image.
        rule.onAllNodes(
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Image) and
                SemanticsMatcher("labelled with the count") { node ->
                    node.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("3 of 3 devices in use") == true
                },
            useUnmergedTree = true,
        ).assertCountEquals(1)
        // One primary, the new-window glyph, no key field in this step.
        rule.onNodeWithText(copy.openInBrowser).assertIsDisplayed()
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
    }

    @Test
    fun backReturnsToTheKeyWithItKept() {
        show(ActivationResult.DeviceLimit(3, 3, SAMPLE_MANAGE_URL))
        rule.onNodeWithText(copy.back).performClick()
        assertEquals(listOf("pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"), keyChanges)
    }

    @Test
    fun aRefusalWithoutCountsDrawsNoMeterAndNoCount() {
        show(ActivationResult.DeviceLimit(null, null, SAMPLE_MANAGE_URL))
        rule.onNodeWithText("Replace a device").assertIsDisplayed()
        rule.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Image), useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("Your license is on 3 of 3 devices").assertDoesNotExist()
    }

    @Test
    fun withNoPortalLinkTheFixIsNamedInWords() {
        show(ActivationResult.DeviceLimit(2, 2))
        rule.onNodeWithText(copy.format(copy.deviceLimitNoManage, "Diceroll")).assertIsDisplayed()
        rule.onNodeWithText(copy.retry).assertIsDisplayed()
        rule.onNodeWithText(copy.openInBrowser).assertDoesNotExist()
    }
}
