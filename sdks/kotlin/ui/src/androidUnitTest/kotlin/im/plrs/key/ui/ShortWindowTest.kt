// @pkey-feature ui.signin
// DL3 (UI-KITS.md): when a screen does not fit, secondary lines give way before the controls do.
// In a short single column (a phone in a split screen, 411 x 440) the code view drops the device
// echo, so Open browser and Cancel stay fully on screen; in a tall one the echo shows (TallWindowTest).

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h440dp-mdpi")
class ShortWindowTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    @Test
    fun theDeviceEchoGivesWayAndTheControlsStayOnScreen() {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), showQr = false)
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(copy.format(copy.signInDeviceLabel, "Living room TV")).assertDoesNotExist()
        rule.onNodeWithText(copy.signInOpenBrowser).assertIsDisplayed()
        rule.onNodeWithText(copy.cancel).assertIsDisplayed()
        val cancel = rule.onNodeWithText(copy.cancel).getUnclippedBoundsInRoot()
        assertTrue("Cancel ends inside the 440 dp window: ${cancel.bottom}", cancel.bottom <= 440.dp)
    }
}
