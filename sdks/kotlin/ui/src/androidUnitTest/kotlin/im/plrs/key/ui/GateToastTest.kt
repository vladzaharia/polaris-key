// @pkey-feature ui.gate ui.signin
// UI-KITS.md 4.1 PolarisKeyGate "adds the grace banner, update prompt and toasts": the gate places
// the toast for the moments it owns. "Signed in as <name> · <Tier> license" when a sign-in it ran
// lets the person in, "Copied" when a link goes on the clipboard; each closes after six seconds.

package im.plrs.key.ui

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class GateToastTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    /** A gate whose licence is whatever [status] says, and whose activation answers [activate]. */
    private class Actions(var status: LicenseStatus, val activate: ActivationResult = ActivationResult.Ok("pkeyt_test", 1)) : PolarisGateActions {
        override suspend fun status(): LicenseState = LicenseState(status)
        override suspend fun activate(key: String): ActivationResult = activate
    }

    private object Prompt : PolarisSignInActions {
        override suspend fun begin(): SignInPrompt = samplePrompt
        override suspend fun wait(prompt: SignInPrompt): SignInResult = SignInResult.Ready
    }

    @Test
    fun aToastOverTheProductClosesAfterSixSeconds() {
        var dismissed = 0
        rule.mainClock.autoAdvance = false
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGateScreen(
                        gateUi(LicenseStatus.ok), PolarisActivationUi(),
                        toast = PolarisToastSpec("Signed in", PolarisToastKind.Success), onToastDismiss = { dismissed++ },
                    ) { SampleProduct() }
                }
            }
        }
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithText("Signed in").assertIsDisplayed()
        rule.onNodeWithText("Diceroll").assertIsDisplayed()
        rule.mainClock.advanceTimeBy(6_300)
        assertEquals(1, dismissed)
    }

    /** The toast closes after six seconds of the test's own clock; these tests step it by hand and stay inside them. */
    private fun frames(ms: Long = 800) = rule.mainClock.advanceTimeBy(ms)

    @Test
    fun aSignInTheGateRanLeavesSignedInAsNameAndTier() {
        rule.mainClock.autoAdvance = false
        val scope = TestScope(UnconfinedTestDispatcher())
        val actions = Actions(LicenseStatus.needsActivation)
        val gate = PolarisGateState(actions, scope, clock = { NOW })
        val signIn = PolarisSignInState(Prompt, scope, clock = { NOW }, onSignedIn = {
            actions.status = LicenseStatus.ok
            scope.launch { gate.reload() }
        })
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGate(gate, signIn = signIn, signedInAs = { SignedInAs("Ada Lovelace", "Pro") }) { SampleProduct() }
                }
            }
        }
        scope.launch { gate.reload() }
        frames()
        rule.onNodeWithText(copy.signIn).performClick()
        frames()
        // The product is on screen (the sign-in's own cross-fade may still be leaving), and the toast says who is in.
        rule.onAllNodes(androidx.compose.ui.test.hasText("Diceroll"))[0].assertIsDisplayed()
        rule.onNodeWithText("Signed in as Ada Lovelace · Pro license").assertIsDisplayed()
    }

    @Test
    fun withoutAHolderNameTheToastStillSaysTheyAreIn() {
        rule.mainClock.autoAdvance = false
        val scope = TestScope(UnconfinedTestDispatcher())
        val actions = Actions(LicenseStatus.needsActivation)
        val gate = PolarisGateState(actions, scope, clock = { NOW })
        val signIn = PolarisSignInState(Prompt, scope, clock = { NOW }, onSignedIn = {
            actions.status = LicenseStatus.ok
            scope.launch { gate.reload() }
        })
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGate(gate, signIn = signIn, signedInAs = { SignedInAs(null, "Pro") }) { SampleProduct() }
                }
            }
        }
        scope.launch { gate.reload() }
        frames()
        rule.onNodeWithText(copy.signIn).performClick()
        frames()
        rule.onNodeWithText("You're signed in").assertIsDisplayed()
    }

    @Test
    fun noSignInNoToast() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val gate = PolarisGateState(Actions(LicenseStatus.ok), scope, clock = { NOW })
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGate(gate, signedInAs = { SignedInAs("Ada", "Pro") }) { SampleProduct() }
                }
            }
        }
        scope.launch { gate.reload() }
        rule.waitForIdle()
        rule.onNodeWithText("Diceroll").assertIsDisplayed()
        rule.onNodeWithText("You're signed in").assertDoesNotExist()
    }

    @Test
    fun copyingTheLinkToastsCopied() {
        rule.mainClock.autoAdvance = false
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
        val scope = TestScope(UnconfinedTestDispatcher())
        val gate = PolarisGateState(Actions(LicenseStatus.needsActivation, ActivationResult.DeviceLimit(1, 1, SAMPLE_MANAGE_URL)), scope, clock = { NOW })
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisGate(gate) { SampleProduct() }
                }
            }
        }
        scope.launch { gate.reload() }
        gate.onKeyChange("pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
        gate.activate()
        frames()
        // No browser answers: the link can be copied instead.
        rule.onNodeWithText(copy.openInBrowser + " ↗").performClick()
        frames()
        rule.onNodeWithText(copy.signInCopyLink).performClick()
        frames()
        rule.onNodeWithText("Copied").assertIsDisplayed()
    }
}
