// @pkey-feature ui.gate ui.signin
// DL6 (UI-KITS.md): a refusal the person can resolve is a neutral callout with no danger colour and
// no error glyph, and its fix is the screen's one primary. A version that is too old is fixed by
// updating, so the gate offers Update when the host can open it, with Try again beside it.

package im.plrs.key.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.AllowedRange
import im.plrs.key.core.LicenseStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class RefusalTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    private fun show(dark: Boolean = false, content: @Composable () -> Unit) {
        rule.setContent { StockHost(dark) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = dark) { content() } } }
        rule.waitForIdle()
    }

    @Test
    fun everyResolvableRefusalIsOneNeutralKind() {
        val range = AllowedRange(min = "2.4.0")
        for (status in listOf(LicenseStatus.revoked, LicenseStatus.expired, LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled)) {
            assertEquals(status.wire, PolarisMessageKind.Blocked, copy.gateMessage(status, range)!!.kind)
        }
    }

    @Test
    fun aRefusalsCalloutIsNeutralInLight() = neutralCallout(dark = false)

    @Test
    fun aRefusalsCalloutIsNeutralInDark() = neutralCallout(dark = true)

    /** Default text on the sunken surface, with no danger or warning colour (DL6). */
    private fun neutralCallout(dark: Boolean) {
        run {
            var container = Color.Unspecified
            var content = Color.Unspecified
            var glyph = Color.Unspecified
            var surface = Color.Unspecified
            var onSurface = Color.Unspecified
            var danger = Color.Unspecified
            var warning = Color.Unspecified
            show(dark) {
                val tint = PolarisMessageKind.Blocked.tint()
                container = tint.first
                content = tint.second
                glyph = PolarisMessageKind.Blocked.glyph()
                surface = MaterialTheme.colorScheme.surfaceContainerHighest
                onSurface = MaterialTheme.colorScheme.onSurface
                danger = PolarisTheme.status.danger
                warning = PolarisTheme.status.warning
            }
            assertEquals("dark=$dark container", surface, container)
            assertEquals("dark=$dark text", onSurface, content)
            assertNotEquals("dark=$dark glyph is not the danger colour", danger, glyph)
            assertNotEquals("dark=$dark glyph is not the warning colour", warning, glyph)
            assertTrue("dark=$dark: not an error glyph", PolarisMessageKind.Blocked.icon() != PolarisMessageKind.Danger.icon())
        }
    }

    @Test
    fun aVersionTooOldGateOffersUpdateAsItsPrimary() {
        var updated = 0
        var retried = 0
        show {
            PolarisGateScreen(
                gate = gateUi(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0")),
                activation = PolarisActivationUi(),
                onRetry = { retried++ },
                onUpdate = { updated++ },
            )
        }
        rule.onNodeWithText(copy.updateAction).assertIsDisplayed().performClick()
        rule.onNodeWithText(copy.retry).assertIsDisplayed().performClick()
        assertEquals(1, updated)
        assertEquals(1, retried)
    }

    @Test
    fun withoutAnUpdateTheGateKeepsTryAgainAlone() {
        show {
            PolarisGateScreen(gate = gateUi(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0")), activation = PolarisActivationUi())
        }
        rule.onNodeWithText(copy.retry).assertIsDisplayed()
        rule.onNodeWithText(copy.updateAction).assertDoesNotExist()
    }
}
