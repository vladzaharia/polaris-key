// @pkey-feature identity.nearby ui.signin
//
// I-45.12: nearby sign-in on the new device, drawn by the Compose desktop kit over PolarisNearbySignInState. The
// pre-prompt (Continue, Not now), the code to tap (Use a code instead hands over), the approvers to pick from, and the
// account to confirm (Continue signs in, Not you? declines); and the gate: Sign in tries the people nearby before the
// code view, and the code view takes over when nothing is nearby. The kit's own steps (nearby-prompt, nearby-wait,
// nearby-done) already have their baselines; nothing here adds one.

@file:Suppress("MagicNumber")

package im.plrs.key.ui

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.NearbyApprover
import im.plrs.key.identity.ShownIdentity
import im.plrs.key.identity.SignInOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class NearbySignInScreensTest {
    private val ada = ShownIdentity("Ada Lovelace", "ada@example.com")

    private class Run(var found: List<NearbyApprover>, private val ident: ShownIdentity?) : PolarisNearbyRun {
        val outcome = CompletableDeferred<SignInOutcome>()
        val chosen = mutableListOf<String>()
        val confirms = AtomicInteger()
        val declines = AtomicInteger()
        val cancels = AtomicInteger()
        override val approvers: List<NearbyApprover> get() = found
        override suspend fun choose(id: String): String {
            chosen += id
            return "482 913"
        }
        override suspend fun wait(): SignInOutcome = outcome.await()
        override val identity: ShownIdentity? get() = ident
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

    private class Actions(val run: Run, val available: Boolean = true, val prompt: Boolean = false) : PolarisNearbyActions {
        val starts = AtomicInteger()
        override suspend fun available(): Boolean = available
        override suspend fun promptNeeded(): Boolean = prompt
        override suspend fun start(): PolarisNearbyRun = run.also { starts.incrementAndGet() }
    }

    private val one = listOf(NearbyApprover("a1", "Ana's laptop", "darwin"))
    private val two = one + NearbyApprover("a2", "Sam's phone", "android")
    private val signedIn = AtomicInteger()

    private fun stateOf(a: Actions) = PolarisNearbySignInState(
        a,
        CoroutineScope(SupervisorJob() + Dispatchers.Default),
        onSignedIn = { signedIn.incrementAndGet() },
        listenMillis = 100,
        loneMillis = 100,
        tickMillis = 10,
    )

    private fun ComposeUiTest.until(what: String, cond: () -> Boolean) {
        val end = System.nanoTime() + 8_000_000_000L
        while (!cond()) {
            waitForIdle()
            if (System.nanoTime() > end) throw AssertionError("timed out: $what")
            Thread.sleep(10)
        }
    }

    private fun ComposeUiTest.shows(text: String) = onAllNodesWithText(text, substring = true, ignoreCase = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun thePrePromptOffersContinueAndNotNow() {
        val a = Actions(Run(one, ada), prompt = true)
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbySignIn(state) }, after = {
            state.begin()
            until("prompt") { shows("Not now") }
            assertTrue(shows("Sign in with your phone"))
            assertTrue(shows("Continue"))
            assertEquals(0, a.starts.get())
            onNodeWithText("Continue", ignoreCase = true).performClick()
            until("wait") { state.ui.value is PolarisNearbyUi.Wait }
            assertEquals(1, a.starts.get())
        })
        val b = Actions(Run(one, ada), prompt = true)
        val second = stateOf(b)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbySignIn(second) }, after = {
            second.begin()
            until("prompt") { shows("Not now") }
            onNodeWithText("Not now", ignoreCase = true).performClick()
            waitForIdle()
            assertEquals(PolarisNearbyUi.Over(false), second.ui.value)
            assertEquals(0, b.starts.get())
        })
    }

    @Test
    fun theCodeScreenSaysWhereToTapAndUseACodeInsteadHandsOver() {
        val a = Actions(Run(one, ada))
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbySignIn(state) }, after = {
            state.begin()
            until("wait") { state.ui.value is PolarisNearbyUi.Wait }
            until("code") { shows("Tap this code there") }
            assertEquals(listOf("a1"), a.run.chosen)
            onNodeWithText("Use a code instead", ignoreCase = true).performClick()
            waitForIdle()
            assertEquals(PolarisNearbyUi.Over(false), state.ui.value)
            assertTrue(a.run.cancels.get() >= 1)
        })
    }

    @Test
    fun severalApproversAreListedToPickFrom() {
        val a = Actions(Run(two, ada))
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbySignIn(state) }, after = {
            state.begin()
            until("pick") { shows("Sam's phone") }
            assertTrue(shows("Ana's laptop"))
            assertTrue(a.run.chosen.isEmpty())
            onNodeWithText("Sam's phone").performClick()
            until("wait") { state.ui.value is PolarisNearbyUi.Wait }
            assertEquals(listOf("a2"), a.run.chosen)
        })
    }

    @Test
    fun theConfirmScreenNamesTheAccountAndContinueSignsIn() {
        val a = Actions(Run(one, ada))
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbySignIn(state) }, after = {
            state.begin()
            until("wait") { state.ui.value is PolarisNearbyUi.Wait }
            a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
            until("confirm") { shows("Signed in as ada@example.com") }
            assertTrue(shows("Not you?"))
            assertEquals(0, signedIn.get())
            onNodeWithText("Continue", ignoreCase = true).performClick()
            until("done") { state.ui.value == PolarisNearbyUi.Done }
            assertEquals(1, a.run.confirms.get())
            assertEquals(1, signedIn.get())
        })
    }

    @Test
    fun notYouDeclinesAndSignsNoOne() {
        val a = Actions(Run(one, ada))
        val state = stateOf(a)
        matrixFrame(420, 760, dark = false, content = { PolarisNearbySignIn(state) }, after = {
            state.begin()
            until("wait") { state.ui.value is PolarisNearbyUi.Wait }
            a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
            until("confirm") { shows("Not you?") }
            onNodeWithText("Not you?", ignoreCase = true).performClick()
            until("over") { state.ui.value is PolarisNearbyUi.Over }
            assertEquals(1, a.run.declines.get())
            assertEquals(0, a.run.confirms.get())
        })
    }

    private fun gateUi() = PolarisGateUi(license = LicenseState(LicenseStatus.needsActivation), nowSeconds = 1_790_000_000L)

    private class Codes : PolarisSignInActions {
        val begins = AtomicInteger()
        override suspend fun begin(): PolarisSignInCode {
            begins.incrementAndGet()
            return PolarisSignInCode(
                "WDJB-MJHT",
                "https://polaris.locker/device",
                "https://polaris.locker/device?user_code=WDJB-MJHT",
                600,
                System.currentTimeMillis() / 1000 + 600,
            )
        }
        override suspend fun wait(code: PolarisSignInCode): SignInOutcome = CompletableDeferred<SignInOutcome>().await()
    }

    @Test
    fun theGateTriesThePeopleNearbyBeforeTheCodeAndFallsBackToIt() {
        val nothing = Actions(Run(emptyList(), null), available = false)
        val nearby = stateOf(nothing)
        val codes = Codes()
        val signIn = PolarisSignInState(codes, CoroutineScope(SupervisorJob() + Dispatchers.Default))
        matrixFrame(420, 760, dark = false, content = {
            PolarisGateScreen(gateUi(), PolarisActivationUi(), signIn = signIn, nearby = nearby)
        }, after = {
            onNodeWithText("Sign in", ignoreCase = true).performClick()
            until("code view") { codes.begins.get() == 1 }
            assertEquals(0, nothing.starts.get())
            until("code screen") { shows("Copy link") || shows("Open browser") }
        })
        val somebody = Actions(Run(one, ada))
        val near = stateOf(somebody)
        val other = Codes()
        val held = PolarisSignInState(other, CoroutineScope(SupervisorJob() + Dispatchers.Default))
        matrixFrame(420, 760, dark = false, content = {
            PolarisGateScreen(gateUi(), PolarisActivationUi(), signIn = held, nearby = near)
        }, after = {
            onNodeWithText("Sign in", ignoreCase = true).performClick()
            until("nearby wait") { near.ui.value is PolarisNearbyUi.Wait }
            // The code view never started: nearby is first.
            assertEquals(0, other.begins.get())
            onNodeWithText("Use a code instead", ignoreCase = true).performClick()
            until("code view") { other.begins.get() == 1 }
        })
    }
}
