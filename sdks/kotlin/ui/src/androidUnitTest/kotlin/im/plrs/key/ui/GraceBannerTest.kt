// @pkey-feature ui.gate
// UI-KITS.md 4.1 GraceBanner: the deadline and the days left, Reconnect, and dismissible per
// session. The licence is not extended: dismissing hides the banner only, and the gate still reads grace.

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseStatus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class GraceBannerTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    @Test
    fun theBannerNamesTheDaysLeftAndTheDeadlineAndDismissesForTheSession() {
        var reconnects = 0
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGateScreen(
                        gate = gateUi(LicenseStatus.grace, graceUntil = NOW + 3 * 86_400 + 600),
                        activation = PolarisActivationUi(),
                        onRetry = { reconnects++ },
                    ) { SampleProduct() }
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(copy.graceHeadline(NOW + 3 * 86_400 + 600, NOW, "en")).assertIsDisplayed()
        rule.onNodeWithText(copy.graceBody(NOW + 3 * 86_400 + 600, NOW, "en")).assertIsDisplayed()
        rule.onNodeWithText(copy.reconnect).performClick()
        assertEquals(1, reconnects)
        rule.onNodeWithText(copy.updateDismiss).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(copy.reconnect).assertDoesNotExist()
        rule.onNodeWithText("Diceroll").assertIsDisplayed()
    }
}
