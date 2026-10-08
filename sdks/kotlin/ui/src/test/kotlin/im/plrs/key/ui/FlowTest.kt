// @pkey-feature ui.kit
// The behaviour behind the screens, end to end in Robolectric:
//   - sign-in survives the screen leaving composition (a rotation, navigation, a multi-window
//     change): it resumes polling the same code and completes, without asking for a new one;
//   - no browser: "Open sign-in page" and "Replace a device" never crash; the screen says so, keeps
//     the code and the copy button, and the gate offers "Copy link";
//   - an expired licence's "Use another license" opens the activation form (a gate-local switch);
//   - inline sign-in: Sign in shows the code view in place, and on TV "Use a license key instead"
//     comes back to the activation form with the key field focused.

package im.plrs.key.ui

import android.app.Application
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class FlowTest {
    @get:Rule
    val rule = createComposeRule()

    /** Sign-in actions that count their calls; the first poll never answers, the next one does. */
    private class Counting : PolarisSignInActions {
        var begins = 0
        var waits = 0

        override suspend fun begin(): SignInPrompt {
            begins++
            return samplePrompt
        }

        override suspend fun wait(prompt: SignInPrompt): SignInResult {
            waits++
            if (waits == 1) awaitCancellation()
            return SignInResult.Ready
        }
    }

    @Test
    fun signInResumesTheSameCodeWhenTheScreenComesBack() {
        val actions = Counting()
        var signedIn = false
        val scope = TestScope(UnconfinedTestDispatcher())
        val state = PolarisSignInState(actions, scope, clock = { NOW }, onSignedIn = { signedIn = true })
        var shown by mutableStateOf(true)
        rule.setContent {
            StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { if (shown) PolarisSignIn(state) } }
        }
        rule.waitForIdle()
        assertTrue("the code shows", state.ui.value is PolarisSignInUi.Showing)
        // A rotation or navigation takes the screen away: polling pauses, the code stays.
        rule.runOnIdle { shown = false }
        rule.waitForIdle()
        assertTrue("away, the code is kept", state.ui.value is PolarisSignInUi.Showing)
        // The screen comes back: the same code is polled again, and the sign-in completes.
        rule.runOnIdle { shown = true }
        rule.waitForIdle()
        assertEquals("no new code was asked for", 1, actions.begins)
        assertEquals("the same code was polled again", 2, actions.waits)
        assertEquals(PolarisSignInUi.Done, state.ui.value)
        assertTrue("onSignedIn fired", signedIn)
    }

    @Test
    fun noBrowserNeverCrashesSignIn() {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
        rule.setContent {
            StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW)) } }
        }
        rule.onNodeWithText(sampleCopy.signInOpenBrowser).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(sampleCopy.signInNoBrowser).assertExists()
        // The code and the copy button stay, so the person can still finish on another device.
        rule.onNodeWithText(samplePrompt.userCode, useUnmergedTree = true).assertExists()
        rule.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(sampleCopy.signInCopyLink)), useUnmergedTree = true)
            .fetchSemanticsNodes().let { assertEquals(1, it.size) }
    }

    @Test
    fun noBrowserNeverCrashesReplaceADevice() {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
        rule.setContent {
            StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { kitScreen("gate-device-limit-manage")() } }
        }
        rule.onNodeWithText(sampleCopy.freeDevice).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(sampleCopy.signInNoBrowser).assertExists()
        rule.onNodeWithText(sampleCopy.signInCopyLink).assertExists()
    }

    @Test
    fun anExpiredLicenceCanUseAnotherLicense() {
        rule.setContent {
            StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { kitScreen("gate-expired")() } }
        }
        rule.onNodeWithText(sampleCopy.useAnotherLicense).performClick()
        rule.waitForIdle()
        rule.onNode(hasSetTextAction()).assertExists()
        rule.onNodeWithText(sampleCopy.activate).assertExists()
    }

    @Test
    fun inlineSignInComesBackToTheKeyField() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val actions = Counting()
        val signIn = PolarisSignInState(actions, scope, clock = { NOW })
        rule.setContent {
            StockHost(false) {
                PolarisTheme(copy = sampleCopy, darkTheme = false) {
                    PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), signIn = signIn)
                }
            }
        }
        rule.onNodeWithText(sampleCopy.signIn).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(sampleCopy.signInTitle).assertExists()
        // Cancel comes back to the activation form.
        rule.onNodeWithText(sampleCopy.cancel).performClick()
        rule.waitForIdle()
        rule.onNode(hasSetTextAction()).assertExists()
        // Sign in again: a fresh code is asked for and polled, not the old one frozen.
        rule.onNodeWithText(sampleCopy.signIn).performClick()
        rule.waitForIdle()
        assertEquals(2, actions.begins)
        assertEquals(2, actions.waits)
    }

    @Test
    fun cancelThenStartAsksForAFreshCode() {
        val actions = Counting()
        val state = PolarisSignInState(actions, TestScope(UnconfinedTestDispatcher()), clock = { NOW })
        state.start()
        state.cancel()
        state.start()
        assertEquals(2, actions.begins)
        assertEquals(2, actions.waits)
        // The fresh code was polled (the second poll answers Ready), not left frozen.
        assertEquals(PolarisSignInUi.Done, state.ui.value)
    }

    @Test
    fun aNonHttpsLinkIsNeverOpenedEncodedOrCopied() {
        var opened = false
        val bad = PolarisSignInUi.Showing(samplePrompt.copy(verificationUriComplete = "javascript:alert(1)"), NOW)
        rule.setContent {
            StockHost(false) {
                PolarisTheme(copy = sampleCopy, darkTheme = false) {
                    PolarisSignInScreen(bad, onOpenBrowser = { opened = true })
                }
            }
        }
        rule.onNodeWithText(sampleCopy.signInOpenBrowser).performClick()
        rule.waitForIdle()
        assertTrue(!opened)
        rule.onNodeWithText(sampleCopy.signInNoBrowser).assertExists()
        rule.onNodeWithText(samplePrompt.userCode, useUnmergedTree = true).assertExists()
        assertEquals(0, rule.onAllNodes(androidx.compose.ui.test.hasContentDescription(sampleCopy.signInCopyLink), useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    @Config(qualifiers = "w960dp-h540dp-television-notnight-mdpi")
    fun onTvUseAKeyInsteadFocusesTheKeyField() {
        val scope = TestScope(UnconfinedTestDispatcher())
        val signIn = PolarisSignInState(Counting(), scope, clock = { NOW })
        rule.setContent {
            StockHost(false) {
                PolarisTheme(copy = sampleCopy, darkTheme = false) {
                    PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), signIn = signIn)
                }
            }
        }
        rule.onNodeWithText(sampleCopy.signIn).performClick()
        rule.waitForIdle()
        // TV: no "Open sign-in page" (a TV may have no browser); the QR code and the way back lead.
        assertEquals(0, rule.onAllNodes(hasText(sampleCopy.signInOpenBrowser)).fetchSemanticsNodes().size)
        rule.onNodeWithText(sampleCopy.signInUseKey).performClick()
        rule.waitForIdle()
        val field = rule.onNode(hasSetTextAction()).fetchSemanticsNode()
        assertEquals("the key field has focus", true, field.config.getOrElse(SemanticsProperties.Focused) { false })
    }

    private class Held(val ready: Boolean = false) : PolarisSignInActions {
        var begins = 0
        val done = kotlinx.coroutines.CompletableDeferred<SignInResult>()
        override suspend fun begin(): SignInPrompt { begins++; return samplePrompt }
        override suspend fun wait(prompt: SignInPrompt): SignInResult = if (ready) SignInResult.Ready else done.await()
    }

    private fun androidx.test.core.app.ActivityScenario<androidx.activity.ComponentActivity>.show(
        key: Any, actions: PolarisSignInActions, onSignedIn: () -> Unit = {},
    ) = onActivity { a ->
        a.setContent {
            StockHost(false) {
                PolarisTheme(copy = sampleCopy, darkTheme = false) {
                    PolarisSignIn(rememberHeldSignIn(key, actions, onSignedIn))
                }
            }
        }
    }

    private fun scenarioVm(a: androidx.activity.ComponentActivity) =
        androidx.lifecycle.ViewModelProvider(a)["polaris-key-sign-in", PolarisSignInViewModel::class.java]

    private fun idle() = org.robolectric.shadows.ShadowLooper.idleMainLooper()

    private fun androidx.test.core.app.ActivityScenario<androidx.activity.ComponentActivity>.vm() =
        androidx.lifecycle.ViewModelProvider(this.let { var o: androidx.activity.ComponentActivity? = null; it.onActivity { a -> o = a }; o!! })[
            "polaris-key-sign-in", PolarisSignInViewModel::class.java,
        ]

    @Test
    fun heldSignInKeepsTheSameCodeAcrossAnActivityRecreation() {
        val actions = Held()
        val key = Any()
        val scenario = androidx.test.core.app.ActivityScenario.launch(androidx.activity.ComponentActivity::class.java)
        scenario.show(key, actions); idle()
        scenario.recreate()
        scenario.show(key, actions); idle()
        assertEquals("one code across the recreation", 1, actions.begins)
        scenario.close()
    }

    @Test
    fun twoClientsShareNoSignInState() {
        val a = Held()
        val b = Held()
        val scenario = androidx.test.core.app.ActivityScenario.launch(androidx.activity.ComponentActivity::class.java)
        scenario.show("client-a", a); idle()
        scenario.recreate()
        scenario.show("client-b", b); idle()
        assertEquals(1, a.begins)
        assertEquals(1, b.begins)
        scenario.close()
    }

    @Test
    fun aFinishedSignInStartsOverWithAFreshCode() {
        val actions = Held(ready = true)
        val key = Any()
        val scenario = androidx.test.core.app.ActivityScenario.launch(androidx.activity.ComponentActivity::class.java)
        scenario.show(key, actions); idle()
        assertEquals("the first sign-in completed", 1, actions.begins)
        scenario.recreate()
        scenario.show(key, actions); idle()
        assertEquals("the next one asks for a new code", 2, actions.begins)
        scenario.close()
    }

    @Test
    fun theSignedInCallbackFiresOnceAfterALateSuccessAndIsReleasedOnDispose() {
        val actions = Held()
        val key = Any()
        var fired = 0
        val scenario = androidx.test.core.app.ActivityScenario.launch(androidx.activity.ComponentActivity::class.java)
        scenario.show(key, actions) { fired++ }; idle()
        actions.done.complete(SignInResult.Ready); idle()
        assertEquals(1, fired)
        // Disposing the composition releases the callback: nothing composition-bound stays held.
        assertTrue("attached while shown", scenario.vm().onSignedIn != null)
        // The composition leaves: its ComposeView is disposed, which runs every onDispose at once
        // (checked before the view can attach a new composition).
        var released = false
        scenario.onActivity { a ->
            val root = a.findViewById<android.view.ViewGroup>(android.R.id.content)
            (root.getChildAt(0) as androidx.compose.ui.platform.ComposeView).disposeComposition()
            released = scenarioVm(a).onSignedIn == null
        }
        assertTrue("the callback is released on dispose", released)
        scenario.close()
    }

    @Test
    fun theSignInLinkCheck() {
        val cases = mapOf(
            "https://key.plrs.im/activate?user_code=ABCD-EFGH" to true,
            "HTTPS://key.plrs.im/x" to true,
            "http://key.plrs.im/x" to false,
            "https://user:pw@key.plrs.im/x" to false,
            "https:///x" to false,
            "data:text/html,hi" to false,
            "javascript:alert(1)" to false,
            "https://key.plrs.im/" + "a".repeat(2100) to false,
            "https://exa mple.com/" to false,
            "" to false,
        )
        for ((link, ok) in cases) assertEquals(link.take(60), ok, isSafeSignInLink(link))
        // A link the encoder would refuse draws no code instead of crashing the screen.
        val huge = "https://key.plrs.im/" + "a".repeat(5000)
        assertTrue(runCatching { qrModules(huge) }.isFailure)
    }

    @Test
    fun belowApi26RubikFallsBackToTheStaticFiles() {
        val modern = polarisRubikFor(26)
        val legacy = polarisRubikFor(25)
        assertTrue(modern != legacy)
        // Static regular for 400 and 500, static bold for 600: nothing renders at the variable default (300).
        assertEquals(3, (legacy as androidx.compose.ui.text.font.FontListFontFamily).fonts.size)
        assertTrue((legacy as androidx.compose.ui.text.font.FontListFontFamily).fonts.none { it is androidx.compose.ui.text.font.ResourceFont && it.variationSettings.settings.isNotEmpty() })
    }

    private fun focusedText(): String? = rule.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true))
        .fetchSemanticsNodes().firstOrNull()?.let { n ->
            (n.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty() +
                n.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()).trim()
        }

    @Test
    fun afterAFailedOpenFocusGoesToCopyLinkOnSignIn() {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
        rule.setContent {
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.ui.platform.LocalInputModeManager provides FixedInputMode(androidx.compose.ui.input.InputMode.Keyboard),
            ) {
                StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW)) } }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(sampleCopy.signInOpenBrowser).performClick()
        rule.waitForIdle()
        assertEquals(sampleCopy.signInCopyLink, focusedText())
    }

    @Test
    fun afterAFailedOpenFocusGoesToCopyLinkOnTheGate() {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
        rule.setContent {
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.ui.platform.LocalInputModeManager provides FixedInputMode(androidx.compose.ui.input.InputMode.Keyboard),
            ) {
                StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { kitScreen("gate-device-limit-manage")() } }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(sampleCopy.freeDevice).performClick()
        rule.waitForIdle()
        assertEquals(sampleCopy.signInCopyLink, focusedText())
    }

    @Test
    fun theUpdatePromptWithoutAProductName() {
        val anon = PolarisCopy()
        val ready = anon.updatePromptText(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart))
        assertEquals("Restart to update" to "Version 2.5.0 is ready. Restart to finish updating.", ready)
        assertEquals("Update required", anon.updatePromptText(PolarisUpdateUi("2.5.0", mandatory = true)).first)
        val named = PolarisCopy(productName = "Diceroll")
        assertEquals("Diceroll 2.5.0 is ready" to "Restart Diceroll to finish updating.", named.updatePromptText(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart)))
        assertEquals("Update to keep using Diceroll", named.updatePromptText(PolarisUpdateUi("2.5.0", mandatory = true)).first)
    }
}
