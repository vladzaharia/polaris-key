// @pkey-feature ui.kit
// DL4 and §1.5 rule 10 (UI-KITS.md): a secondary that sits beside a primary is tonal, never bare
// text, and in a phone's stacked group it is the primary's width and a full 56 dp tall. A bare text
// button wraps its label, so the width is what tells the two apart.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class PairedSecondaryTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    private fun show(content: @Composable () -> Unit) {
        rule.setContent { StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) { content() } } }
        rule.waitForIdle()
    }

    private fun assertPaired(primary: String, secondary: String) {
        val width = rule.onNodeWithText(primary).getUnclippedBoundsInRoot().let { it.right - it.left }
        rule.onNodeWithText(secondary).assertWidthIsEqualTo(width).assertHeightIsAtLeast(56.dp)
    }

    @Test
    fun anExpiredCodesCancelIsTonal() {
        show { PolarisSignInScreen(PolarisSignInUi.Expired) }
        assertPaired(copy.signInNewCode, copy.cancel)
    }

    @Test
    fun aFailedSignInsCancelIsTonal() {
        show { PolarisSignInScreen(PolarisSignInUi.Failed) }
        assertPaired(copy.retry, copy.cancel)
    }

    @Test
    fun theCodeViewsCancelIsTonal() {
        show { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), showQr = false) }
        assertPaired(copy.signInOpenBrowser, copy.cancel)
    }

    @Test
    fun theConsentCardsNotNowIsTonal() {
        val consent = bootUi(BootStage.fetch, BootOutcome.waiting).copy(consent = PolarisBootUi.Consent(268_400_000, metered = true))
        show { PolarisBootScreen(consent) }
        assertPaired(copy.consentDownload, copy.consentLater)
    }

    @Test
    fun aBlockedBootsTryAgainBesideUpdateIsTonal() {
        val blocked = bootUi(BootStage.blocked, BootOutcome.blocked).copy(blocked = BootEmit.BlockedReason.updateRequired)
        show { PolarisBootScreen(blocked, onUpdate = {}) }
        assertPaired(copy.updateNow, copy.retry)
    }

    @Test
    fun theUpdatePromptsLaterIsTonal() {
        show { PolarisScreen(showLogo = false) { PolarisUpdatePrompt(PolarisUpdateUi("2.5.0"), onLater = {}) } }
        assertPaired(copy.updateNow, copy.updateLater)
    }
}
