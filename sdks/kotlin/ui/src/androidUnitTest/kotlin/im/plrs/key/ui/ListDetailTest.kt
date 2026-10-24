// @pkey-feature ui.settings ui.devices
// UI-KITS.md DL1 and the board's tablet: the account list-detail. A tablet shows the list and the
// chosen item together; a phone shows the list, then the item, and Back returns to the list.
// Rename inside the detail still closes first on Back.

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ListDetailTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val copy = sampleCopy

    private fun show(settings: PolarisSettingsUi = sampleSettings) {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisAccountScreen(settings, PolarisDevicesUi(loading = false, devices = sampleDevices, nowMillis = NOW * 1000), onSet = { _, _ -> }, onReset = {}, onChannel = ::noop)
                }
            }
        }
        rule.waitForIdle()
    }

    private fun noop(@Suppress("UNUSED_PARAMETER") id: String) = Unit

    private fun back() {
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1280dp-h800dp-mdpi")
    fun aTabletShowsTheListAndTheItemTogether() {
        show()
        // The list, with the first item open in the end pane.
        rule.onNodeWithText(copy.devicesTitle).assertIsDisplayed()
        rule.onNodeWithText("Music volume").assertIsDisplayed()
        // Choosing Devices swaps the end pane and keeps the list.
        rule.onNodeWithText(copy.devicesSubtitle).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Pixel 9 Pro").assertIsDisplayed()
        rule.onNodeWithText("Music volume").assertDoesNotExist()
        rule.onNodeWithText(copy.settingsTitle).assertIsDisplayed()
        // Two panes have nowhere to go back to.
        assert(!rule.activity.onBackPressedDispatcher.hasEnabledCallbacks())
    }

    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
    fun aPhoneShowsTheListThenTheItemAndBackReturns() {
        show()
        rule.onNodeWithText(copy.settingsTitle).assertIsDisplayed()
        rule.onNodeWithText("Music volume").assertDoesNotExist()
        rule.onNodeWithText(copy.devicesSubtitle).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Pixel 9 Pro").assertIsDisplayed()
        back()
        rule.onNodeWithText("Pixel 9 Pro").assertDoesNotExist()
        rule.onNodeWithText(copy.devicesSubtitle).assertIsDisplayed()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1280dp-h800dp-mdpi")
    fun aTabletOpensTheChannelRowInTheEndPane() {
        show(sampleSettings.copy(channel = sampleChannel))
        rule.onNodeWithText("Release channel").assertIsDisplayed() // the list row
        rule.onNodeWithText("Music volume").assertIsDisplayed()
        rule.onNodeWithText("Beta").assertDoesNotExist()
        rule.onNodeWithText("Release channel").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Beta").assertIsDisplayed()
        rule.onNodeWithText("Music volume").assertDoesNotExist()
        assert(!rule.activity.onBackPressedDispatcher.hasEnabledCallbacks())
    }

    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
    fun aPhoneOpensTheChannelThenBackReturnsToTheList() {
        show(sampleSettings.copy(channel = sampleChannel))
        rule.onNodeWithText("Release channel").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Beta").assertIsDisplayed()
        back()
        rule.onNodeWithText("Beta").assertDoesNotExist()
        rule.onNodeWithText(copy.devicesSubtitle).assertIsDisplayed()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1280dp-h800dp-mdpi")
    fun withoutAChannelThereIsNoChannelRow() {
        show(sampleSettings.copy(channel = null))
        rule.onNodeWithText("Release channel").assertDoesNotExist()
    }
}
