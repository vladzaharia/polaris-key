// @pkey-feature ui.gate ui.signin
// UI-KITS.md 1.4 (Android) predictive back: a step with a back target uses PredictiveBackHandler
// from API 34. While the gesture is held nothing changes; cancelling it keeps the key draft, the
// caret and the focus; committing returns to the opener. Below API 34 the classic handler does the
// same without the preview (BackTest covers it at API 35 through the classic dispatch).

package im.plrs.key.ui

import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseStatus
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
class PredictiveBackTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val copy = sampleCopy
    private val dispatcher get() = rule.activity.onBackPressedDispatcher

    private fun event(progress: Float) = BackEventCompat(0.5f, 0.5f, progress, BackEventCompat.EDGE_LEFT)

    private fun ui(block: () -> Unit) {
        rule.runOnUiThread(block)
        rule.waitForIdle()
    }

    @Test
    fun theCodeViewCancelsOnlyWhenTheGestureCommits() {
        var cancelled = 0
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), onCancel = { cancelled++ })
                }
            }
        }
        rule.waitForIdle()
        assertTrue("the step has a back target", dispatcher.hasEnabledCallbacks())
        // A held gesture previews and changes nothing; letting go of it cancels.
        ui {
            dispatcher.dispatchOnBackStarted(event(0f))
            dispatcher.dispatchOnBackProgressed(event(0.5f))
        }
        assertEquals(0, cancelled)
        ui { dispatcher.dispatchOnBackCancelled() }
        assertEquals(0, cancelled)
        // Committing it backs out.
        ui {
            dispatcher.dispatchOnBackStarted(event(0f))
            dispatcher.dispatchOnBackProgressed(event(0.8f))
            dispatcher.onBackPressed()
        }
        assertEquals(1, cancelled)
    }

    @Test
    fun cancellingTheGestureKeepsTheKeyPathAndItsDraft() {
        val keys = mutableListOf<String>()
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGateScreen(
                        gateUi(LicenseStatus.needsActivation), PolarisActivationUi(),
                        onKeyChange = { keys += it }, onSignIn = {},
                    )
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(copy.useKey).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(copy.activate).assertIsDisplayed()
        // Hold, then cancel: still on the key path, and nothing was asked of the host.
        ui {
            dispatcher.dispatchOnBackStarted(event(0f))
            dispatcher.dispatchOnBackProgressed(event(0.7f))
        }
        ui { dispatcher.dispatchOnBackCancelled() }
        rule.onNodeWithText(copy.activate).assertIsDisplayed()
        // Commit: back to the Welcome, and the draft is untouched (the host's state still holds it).
        ui {
            dispatcher.dispatchOnBackStarted(event(0f))
            dispatcher.dispatchOnBackProgressed(event(0.9f))
            dispatcher.onBackPressed()
        }
        rule.onNodeWithText(copy.activate).assertDoesNotExist()
        rule.onNodeWithText(copy.useKey).assertIsDisplayed()
        assertTrue("the draft was never cleared: $keys", keys.isEmpty())
        // The Welcome is the gate's root: nothing is left to consume back.
        assertTrue(!dispatcher.hasEnabledCallbacks())
    }
}
