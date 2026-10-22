// @pkey-feature ui.signin
// DL5 (UI-KITS.md): every sign-in step keeps the product's icon and name as its header, the last one
// included, and announces itself politely.

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
class SignInDoneTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun theDoneStepNamesTheProduct() {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                    PolarisSignInScreen(PolarisSignInUi.Done)
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText("Diceroll").assertIsDisplayed()
        rule.onNodeWithText(sampleCopy.signInDone).assertIsDisplayed()
    }
}
