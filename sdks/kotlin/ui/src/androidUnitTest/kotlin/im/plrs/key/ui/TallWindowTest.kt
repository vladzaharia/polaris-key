// @pkey-feature ui.signin
// The counterpart of ShortWindowTest: in a tall window the code view keeps the device echo.

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class TallWindowTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun aTallWindowKeepsTheDeviceEcho() {
        val copy = sampleCopy
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), showQr = false)
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(copy.format(copy.signInDeviceLabel, "Living room TV")).assertIsDisplayed()
    }
}
