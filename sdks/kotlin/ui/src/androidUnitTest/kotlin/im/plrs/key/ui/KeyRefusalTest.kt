// @pkey-feature ui.kit.keyentry ui.kit.account
// I-10b.20: the two key refusals on the activation screen, in the kit's catalog words. A key with no entries
// left offers the portal link (Open in browser) and Sign in; a license in another account offers Sign in to
// that account; both offer Use a different key, and neither offers Activate again on the refused key.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.license.ActivationResult
import com.github.takahirom.roborazzi.captureRoboImage
import im.plrs.key.license.KeyEntries
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class KeyRefusalTest {
    @get:Rule
    val rule = createComposeRule()

    private val add = "https://polaris.locker/activate?product=diceroll"
    private val signInPage = "https://polaris.locker/signin?product=diceroll"

    private fun show(content: @Composable () -> Unit) {
        rule.setContent { StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { content() } } }
        rule.waitForIdle()
    }

    private fun limit(manage: String? = add) = PolarisActivationUi(
        key = "pkey_diceroll_ABCDEFGHIJKLMNOPQRSTUV",
        error = PolarisActivationError.Refused(ActivationResult.KeyEntryLimit(manage, KeyEntries(3, 3))),
        manageUrl = manage,
        manageQrUrl = manage,
    )

    @Test
    fun aKeyWithNoEntriesLeftOffersThePortalAndSignIn() {
        var opened: String? = null
        var signIns = 0
        var edits = ArrayList<String>()
        show {
            PolarisActivationScreen(limit(), onKeyChange = { edits += it }, onSignIn = { signIns++ }, onOpenManage = { opened = it })
        }
        rule.onNodeWithText("This key has no entries left. Add it to your account and sign in instead.").assertIsDisplayed()
        shot("key-entry-limit-411x891")
        rule.onNodeWithText("Activate license").assertDoesNotExist()
        rule.onNodeWithText("Add Diceroll to your account").performClick()
        assertEquals(add, opened)
        rule.onNodeWithText("Sign in").performClick()
        assertEquals(1, signIns)
        rule.onNodeWithText("Use a different key").performClick()
        assertEquals(listOf(""), edits)
    }

    /** With PKEY_KIT_SHOTS set and `-Proborazzi.test.record=true`, the frame is written to <dir>/android/<name>.png. */
    private fun shot(name: String) {
        val dir = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() } ?: return
        rule.onRoot().captureRoboImage(filePath = "$dir/android/$name.png")
    }

    @Test
    @Config(qualifiers = "w960dp-h540dp-television-notnight-mdpi")
    fun onTvTheLinkIsAQrCodeAndSignInIsThePrimary() {
        var signIns = 0
        show { PolarisActivationScreen(limit(), onSignIn = { signIns++ }, manageAsQr = true) }
        rule.onNodeWithContentDescription("QR code that opens the device management page").assertIsDisplayed()
        shot("key-entry-limit-tv-960x540")
        rule.onNodeWithText("Add Diceroll to your account").assertDoesNotExist()
        rule.onNodeWithText("Sign in").performClick()
        assertEquals(1, signIns)
    }

    @Test
    fun aLicenseInAnotherAccountSignsInToIt() {
        var signIns = 0
        val owned = PolarisActivationUi(
            key = "pkey_diceroll_ABCDEFGHIJKLMNOPQRSTUV",
            error = PolarisActivationError.Refused(ActivationResult.LicenseOwned(signInPage)),
            signInUrl = signInPage,
        )
        show { PolarisActivationScreen(owned, onSignIn = { signIns++ }) }
        rule.onNodeWithText("Sign in to that account").assertIsDisplayed()
        shot("license-owned-411x891")
        rule.onNodeWithText("Sign in to that account").performClick()
        assertEquals(1, signIns)
        rule.onNodeWithText("Use a different key").assertIsDisplayed()
    }

    @Test
    fun withoutTheKitsSignInTheProductsPageOpens() {
        var opened: String? = null
        val owned = PolarisActivationUi(
            key = "pkey_diceroll_ABCDEFGHIJKLMNOPQRSTUV",
            error = PolarisActivationError.Refused(ActivationResult.LicenseOwned(signInPage)),
            signInUrl = signInPage,
        )
        show { PolarisActivationScreen(owned, onOpenManage = { opened = it }) }
        rule.onNodeWithText("Sign in to that account").performClick()
        assertEquals(signInPage, opened)
    }
}
