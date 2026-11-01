// @pkey-feature identity.nearby ui.signin
//
// I-45.12 on Android (Robolectric): nearby sign-in on the new device (Android `direct` and Android TV share the Compose
// kit). The pre-prompt, the code to tap, the account to confirm, and the hand-over to the code view. The state
// machine has its own tests (:ui-core); this pins that the Android renderer draws each step and reports each press.

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.identity.NearbyApprover
import im.plrs.key.identity.ShownIdentity
import im.plrs.key.identity.SignInOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class NearbySignInAndroidTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private class Run : PolarisNearbyRun {
        val outcome = CompletableDeferred<SignInOutcome>()
        val confirms = AtomicInteger()
        val declines = AtomicInteger()
        val cancels = AtomicInteger()
        override val approvers: List<NearbyApprover> = listOf(NearbyApprover("a1", "Ana's phone", "android"))
        override suspend fun choose(id: String): String = "482 913"
        override suspend fun wait(): SignInOutcome = outcome.await()
        override val identity: ShownIdentity = ShownIdentity("Ada Lovelace", "ada@example.com")
        override fun onEnd(fn: () -> Unit): () -> Unit = {}
        override suspend fun confirm() {
            confirms.incrementAndGet()
        }
        override suspend fun decline() {
            declines.incrementAndGet()
        }
        override fun cancel() {
            cancels.incrementAndGet()
        }
    }

    private class Actions(val run: Run, val prompt: Boolean = false) : PolarisNearbyActions {
        override suspend fun available(): Boolean = true
        override suspend fun promptNeeded(): Boolean = prompt
        override suspend fun start(): PolarisNearbyRun = run
    }

    private val signedIn = AtomicInteger()

    private fun stateOf(a: Actions) = PolarisNearbySignInState(
        a,
        CoroutineScope(SupervisorJob() + Dispatchers.Default),
        onSignedIn = { signedIn.incrementAndGet() },
        listenMillis = 100,
        loneMillis = 100,
        tickMillis = 10,
    )

    private fun until(what: String, cond: () -> Boolean) {
        val end = System.nanoTime() + 8_000_000_000L
        while (!cond()) {
            rule.waitForIdle()
            if (System.nanoTime() > end) throw AssertionError("timed out: $what")
            Thread.sleep(10)
        }
    }

    private fun shows(text: String) = rule.onAllNodesWithText(text, substring = true, ignoreCase = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun thePrePromptContinuesToTheCodeAndTheAccountIsConfirmed() {
        val a = Actions(Run(), prompt = true)
        val state = stateOf(a)
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisNearbySignIn(state) } } }
        state.begin()
        until("prompt") { shows("Not now") }
        assertTrue(shows("Sign in with your phone"))
        rule.onNodeWithText("Continue", ignoreCase = true).performClick()
        until("wait") { state.ui.value is PolarisNearbyUi.Wait }
        until("code") { shows("Tap this code there") }
        a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        until("confirm") { shows("Signed in as ada@example.com") }
        assertEquals(0, signedIn.get())
        rule.onNodeWithText("Continue", ignoreCase = true).performClick()
        until("done") { state.ui.value == PolarisNearbyUi.Done }
        assertEquals(1, a.run.confirms.get())
        assertEquals(1, signedIn.get())
    }

    @Test
    fun useACodeInsteadEndsTheRun() {
        val a = Actions(Run())
        val state = stateOf(a)
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisNearbySignIn(state) } } }
        state.begin()
        until("wait") { state.ui.value is PolarisNearbyUi.Wait }
        until("code") { shows("Use a code instead") }
        rule.onNodeWithText("Use a code instead", ignoreCase = true).performClick()
        until("over") { state.ui.value is PolarisNearbyUi.Over }
        assertTrue(a.run.cancels.get() >= 1)
    }

    @Test
    fun notYouDeclinesAndSignsNoOne() {
        val b = Actions(Run())
        val second = stateOf(b)
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisNearbySignIn(second) } } }
        second.begin()
        until("wait") { second.ui.value is PolarisNearbyUi.Wait }
        b.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        until("confirm") { shows("Not you?") }
        rule.onNodeWithText("Not you?", ignoreCase = true).performClick()
        until("over") { second.ui.value is PolarisNearbyUi.Over }
        assertEquals(1, b.run.declines.get())
        assertEquals(0, signedIn.get())
    }
}
