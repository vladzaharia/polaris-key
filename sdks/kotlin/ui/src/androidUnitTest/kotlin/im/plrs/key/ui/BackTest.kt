// @pkey-feature ui.gate ui.signin ui.devices
// UI-KITS.md 1.4 (Android) and DL9: every step with a back target backs out, and the gate's root
// never consumes Back. The key path returns to the Welcome with its draft kept, the device-limit step
// returns to the key, the code view cancels, and an open rename or confirm closes.

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
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
class BackTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val copy = sampleCopy

    private fun back() {
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
    }

    @Test
    fun backFromTheKeyPathReturnsToTheWelcomeAndTheRootConsumesNothing() {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), onSignIn = {})
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(copy.useKey).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(copy.activate).assertIsDisplayed()
        back()
        rule.onNodeWithText(copy.activate).assertDoesNotExist()
        rule.onNodeWithText(copy.useKey).assertIsDisplayed()
        // On the Welcome there is nothing to back out of: the dispatcher has no callback enabled.
        assertTrue(!rule.activity.onBackPressedDispatcher.hasEnabledCallbacks())
    }

    @Test
    fun backFromTheDeviceLimitStepReturnsToTheKey() {
        val keys = mutableListOf<String>()
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGateScreen(
                        gateUi(LicenseStatus.needsActivation),
                        PolarisActivationUi(key = "pkey_x", error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(2, 2, SAMPLE_MANAGE_URL)), manageUrl = SAMPLE_MANAGE_URL),
                        onKeyChange = { keys += it },
                    )
                }
            }
        }
        rule.waitForIdle()
        back()
        assertEquals(listOf("pkey_x"), keys)
    }

    @Test
    fun backCancelsTheCodeView() {
        var cancelled = 0
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), onCancel = { cancelled++ })
                }
            }
        }
        rule.waitForIdle()
        back()
        assertEquals(1, cancelled)
    }

    @Test
    fun backClosesAnOpenRenameBeforeAnythingElse() {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisDevicesScreen(PolarisDevicesUi(loading = false, devices = sampleDevices, nowMillis = NOW * 1000))
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithContentDescription(copy.format(copy.deviceRenameDescription, "Ada's tablet")).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(copy.deviceRenameLabel).assertIsDisplayed()
        back()
        rule.onNodeWithText(copy.deviceRenameLabel).assertDoesNotExist()
    }
}
