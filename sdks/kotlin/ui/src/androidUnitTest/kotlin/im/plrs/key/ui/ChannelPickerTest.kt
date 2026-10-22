// @pkey-feature ui.settings
// UI-KITS.md 4.1 ChannelPicker (default · locked): the switchable list reports a pick through the
// host's handler and draws nothing without one; the locked picker always says why (the store that
// fixes the channel) and names the lock for assistive tech; inside the settings screen it sits
// above the values.

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class ChannelPickerTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setContent { StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { content() } } }
        rule.waitForIdle()
    }

    @Test
    fun aPickIsReportedAndTheCurrentChannelIsSelected() {
        val picks = mutableListOf<String>()
        show { PolarisChannelPicker(sampleChannel, onSelect = { picks += it }) }
        rule.onNodeWithText("Release channel").assertIsDisplayed()
        rule.onNodeWithText("Stable").assertIsSelected()
        rule.onNodeWithText("Stable").performClick()
        rule.onNodeWithText("Beta").performClick()
        assertEquals(listOf("beta"), picks)
    }

    @Test
    fun withoutAHandlerTheSwitchablePickerIsNotDrawn() {
        show { PolarisChannelPicker(sampleChannel) }
        rule.onNodeWithText("Release channel").assertDoesNotExist()
        rule.onNodeWithText("Beta").assertDoesNotExist()
    }

    @Test
    fun aLockedPickerSaysWhyAndNamesTheLock() {
        show { PolarisChannelPicker(sampleChannel.copy(lockedBy = "play")) }
        rule.onNodeWithText("Google Play sets the channel.").assertIsDisplayed()
        rule.onNodeWithText("Stable").assertIsDisplayed()
        rule.onNodeWithText("Beta").assertDoesNotExist()
        rule.onNodeWithContentDescription("Locked").assertExists()
    }

    @Test
    fun aPickerWithOneChannelAndNoLockIsNotDrawn() {
        show { PolarisChannelPicker(PolarisChannelUi("stable", listOf("stable")), onSelect = {}) }
        rule.onNodeWithText("Release channel").assertDoesNotExist()
    }

    @Test
    fun theSettingsScreenShowsTheLockedPickerWithoutAHandler() {
        show { PolarisSettingsScreen(sampleSettings.copy(channel = sampleChannel.copy(lockedBy = "steam"))) }
        rule.onNodeWithText("Steam sets the channel.").assertIsDisplayed()
    }

    @Test
    fun theSettingsScreenDrawsNoSwitchablePickerWithoutAHandler() {
        show { PolarisSettingsScreen(sampleSettings.copy(channel = sampleChannel)) }
        rule.onNodeWithText("Release channel").assertDoesNotExist()
    }

    @Test
    fun theSettingsScreenDrawsTheSwitchablePickerWithAHandler() {
        show { PolarisSettingsScreen(sampleSettings.copy(channel = sampleChannel), onChannel = {}) }
        rule.onNodeWithText("Release channel").assertIsDisplayed()
    }
}
