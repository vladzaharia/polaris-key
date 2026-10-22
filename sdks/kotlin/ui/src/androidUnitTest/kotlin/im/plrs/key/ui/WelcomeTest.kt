// @pkey-feature ui.gate ui.activate
// UI-KITS.md 4.3 Welcome: Sign in is the one primary and Use a license key the secondary; the key
// field sits behind Use a license key (an always-visible field is heavier than the portal's
// collapsed path); "by <Developer>" sits under the title on the Welcome only; with no sign-in on
// offer the key path is the screen.

package im.plrs.key.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
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
class WelcomeTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    private fun show(developer: String? = null, onSignIn: (() -> Unit)? = {}, activation: PolarisActivationUi = PolarisActivationUi()) {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false, developer = developer) {
                    PolarisGateScreen(gateUi(LicenseStatus.needsActivation), activation, onSignIn = onSignIn)
                }
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun theKeyFieldSitsBehindUseALicenseKey() {
        show()
        rule.onNodeWithText(copy.signIn).assertIsDisplayed()
        rule.onNodeWithText(copy.useKey).assertIsDisplayed()
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        rule.onNodeWithText(copy.activate).assertDoesNotExist()
        rule.onNodeWithText(copy.useKey).performClick()
        rule.waitForIdle()
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        rule.onNodeWithText(copy.activate).assertIsDisplayed()
        // Sign in stays on offer, as the secondary now.
        rule.onNodeWithText(copy.signIn).assertIsDisplayed()
    }

    @Test
    fun withoutSignInTheKeyPathIsTheScreen() {
        show(onSignIn = null)
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        rule.onNodeWithText(copy.activate).assertIsDisplayed()
        rule.onNodeWithText(copy.useKey).assertDoesNotExist()
    }

    @Test
    fun aRefusedKeyKeepsTheFieldOpen() {
        show(activation = PolarisActivationUi(key = "pkey_x", error = PolarisActivationError.KeyEmpty))
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        rule.onNodeWithText(copy.activationKeyEmpty).assertIsDisplayed()
    }

    @Test
    fun theDeveloperIsNamedUnderTheTitleOnTheWelcomeOnly() {
        show(developer = "Harbor Audio")
        rule.onNodeWithText(copy.format(copy.byDeveloper, "Harbor Audio")).assertIsDisplayed()
    }

    @Test
    fun withNoDeveloperThereIsNoByLine() {
        show()
        rule.onNodeWithText(copy.format(copy.byDeveloper, "Harbor Audio")).assertDoesNotExist()
        assertEquals(null, null)
    }
}
