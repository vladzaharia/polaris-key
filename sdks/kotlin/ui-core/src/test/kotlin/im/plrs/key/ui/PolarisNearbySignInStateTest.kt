// @pkey-feature identity.nearby
//
// Nearby sign-in state holder (I-45.12): the pre-prompt, the listening window, the lone approver, several to pick from,
// the code, the account to confirm, and every way out. Leaving the confirm screen by any route declines (rule 12); a
// confirm that fails is never "signed in"; the session ending on its own leaves the screen.

package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.identity.NearbyApprover
import im.plrs.key.identity.ShownIdentity
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class PolarisNearbySignInStateTest {
    private val ada = ShownIdentity("Ada Lovelace", "ada@example.com")

    private class Run(
        var found: List<NearbyApprover> = emptyList(),
        val outcome: CompletableDeferred<SignInOutcome> = CompletableDeferred(),
        private val ident: ShownIdentity? = null,
    ) : PolarisNearbyRun {
        val chosen = CopyOnWriteArrayList<String>()
        val confirms = AtomicInteger()
        val declines = AtomicInteger()
        val cancels = AtomicInteger()
        var confirmFails = false
        private val ends = CopyOnWriteArrayList<() -> Unit>()

        override val approvers: List<NearbyApprover> get() = found
        override suspend fun choose(id: String): String {
            chosen += id
            return "482 913"
        }
        override suspend fun wait(): SignInOutcome = outcome.await()
        override val identity: ShownIdentity? get() = ident
        override fun onEnd(fn: () -> Unit): () -> Unit {
            ends += fn
            return { ends -= fn }
        }
        override suspend fun confirm() {
            confirms.incrementAndGet()
            if (confirmFails) throw PolarisException(ErrorCode.signInFailed, "ended")
        }
        override suspend fun decline() {
            declines.incrementAndGet()
        }
        override fun cancel() {
            cancels.incrementAndGet()
        }
        fun end() = ends.toList().forEach { it() }
    }

    private class Actions(
        var available: Boolean = true,
        var prompt: Boolean = false,
        var allow: Boolean = true,
        val run: Run = Run(),
        var failure: Exception? = null,
    ) : PolarisNearbyActions {
        val starts = AtomicInteger()
        override suspend fun available(): Boolean = available
        override suspend fun promptNeeded(): Boolean = prompt
        override suspend fun allow(): Boolean = allow
        override suspend fun start(): PolarisNearbyRun {
            starts.incrementAndGet()
            failure?.let { throw it }
            return run
        }
    }

    private val scopes = ArrayList<CoroutineScope>()
    private val signedIn = AtomicInteger()

    private fun state(a: Actions): PolarisNearbySignInState {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return PolarisNearbySignInState(a, scope, onSignedIn = { signedIn.incrementAndGet() }, listenMillis = 120, loneMillis = 160, tickMillis = 10)
    }

    private fun PolarisNearbySignInState.until(timeoutMillis: Long = 8000, cond: (PolarisNearbyUi) -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond(ui.value)) {
            if (System.nanoTime() > end) throw AssertionError("timed out in ${ui.value}")
            Thread.sleep(5)
        }
    }

    private val one = listOf(NearbyApprover("a1", "Ana's laptop", "darwin"))
    private val two = listOf(NearbyApprover("a1", "Ana's laptop", "darwin"), NearbyApprover("a2", "Sam's phone", "android"))

    @Test
    fun aProductOrRuntimeWithoutNearbyHandsOverAtOnce() {
        val a = Actions(available = false)
        val s = state(a)
        s.begin()
        s.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(failed = false), s.ui.value)
        assertEquals(0, a.starts.get())
    }

    @Test
    fun theMacPrePromptAsksFirstAndNotNowHandsOver() {
        val a = Actions(prompt = true)
        val s = state(a)
        s.begin()
        s.until { it == PolarisNearbyUi.Prompt }
        assertEquals(0, a.starts.get())
        s.notNow()
        assertEquals(PolarisNearbyUi.Over(false), s.ui.value)
        assertEquals(0, a.starts.get())
    }

    @Test
    fun continuingThePrePromptStartsAndARefusedPermissionHandsOver() {
        val go = Actions(prompt = true)
        go.run.found = one
        val s = state(go)
        s.begin()
        s.until { it == PolarisNearbyUi.Prompt }
        s.continuePrompt()
        s.until { it is PolarisNearbyUi.Wait }
        assertEquals(1, go.starts.get())

        val no = Actions(prompt = true, allow = false)
        val t = state(no)
        t.begin()
        t.until { it == PolarisNearbyUi.Prompt }
        t.continuePrompt()
        t.until { it is PolarisNearbyUi.Over }
        assertEquals(0, no.starts.get())
    }

    @Test
    fun noApproverWithinTheWindowHandsOverAndStopsTheRun() {
        val a = Actions()
        val s = state(a)
        s.begin()
        s.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(false), s.ui.value)
        assertTrue(a.run.cancels.get() >= 1)
    }

    @Test
    fun aLoneApproverIsChosenAfterTheWaitAndTheCodeIsShown() {
        val a = Actions()
        a.run.found = one
        val s = state(a)
        s.begin()
        s.until { it is PolarisNearbyUi.Wait }
        assertEquals(PolarisNearbyUi.Wait("482 913", "Ana's laptop"), s.ui.value)
        assertEquals(listOf("a1"), a.run.chosen.toList())
    }

    @Test
    fun severalApproversAreListedAndTheTappedOneIsChosen() {
        val a = Actions()
        a.run.found = two
        val s = state(a)
        s.begin()
        s.until { it is PolarisNearbyUi.Pick }
        assertEquals(PolarisNearbyUi.Pick(listOf("Ana's laptop", "Sam's phone")), s.ui.value)
        assertTrue(a.run.chosen.isEmpty())
        s.pick(1)
        s.until { it is PolarisNearbyUi.Wait }
        assertEquals(listOf("a2"), a.run.chosen.toList())
        assertEquals(PolarisNearbyUi.Wait("482 913", "Sam's phone"), s.ui.value)
    }

    private fun waiting(a: Actions): PolarisNearbySignInState {
        a.run.found = one
        val s = state(a)
        s.begin()
        s.until { it is PolarisNearbyUi.Wait }
        return s
    }

    @Test
    fun theAccountIsShownToConfirmAndContinueSignsInOnce() {
        val a = Actions(run = Run(ident = ada))
        val s = waiting(a)
        a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        s.until { it is PolarisNearbyUi.Confirm }
        assertEquals(PolarisNearbyUi.Confirm(ada), s.ui.value)
        assertEquals(0, signedIn.get())
        s.confirm()
        s.confirm()
        s.until { it == PolarisNearbyUi.Done }
        assertEquals(1, a.run.confirms.get())
        assertEquals(1, signedIn.get())
        // Leaving a confirmed sign-in later does not cancel it.
        s.cancel()
        assertEquals(PolarisNearbyUi.Done, s.ui.value)
        assertEquals(0, a.run.cancels.get())
    }

    @Test
    fun notYouDeclinesAndHandsOverWithoutSigningIn() {
        val a = Actions(run = Run(ident = ada))
        val s = waiting(a)
        a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        s.until { it is PolarisNearbyUi.Confirm }
        s.notYou()
        s.until { it is PolarisNearbyUi.Over }
        assertEquals(1, a.run.declines.get())
        assertEquals(0, signedIn.get())
    }

    @Test
    fun leavingTheConfirmScreenByAnyOtherRouteEndsTheSession() {
        val a = Actions(run = Run(ident = ada))
        val s = waiting(a)
        a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        s.until { it is PolarisNearbyUi.Confirm }
        s.cancel()
        assertEquals(PolarisNearbyUi.Over(false), s.ui.value)
        assertTrue(a.run.cancels.get() >= 1)
        assertEquals(0, signedIn.get())
    }

    @Test
    fun aConfirmThatFailsLeavesTheScreenAndIsNeverSignedIn() {
        val a = Actions(run = Run(ident = ada).also { it.confirmFails = true })
        val s = waiting(a)
        a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        s.until { it is PolarisNearbyUi.Confirm }
        s.confirm()
        s.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(failed = true), s.ui.value)
        assertEquals(0, signedIn.get())
    }

    @Test
    fun theSessionEndingOnItsOwnLeavesTheConfirmScreen() {
        val a = Actions(run = Run(ident = ada))
        val s = waiting(a)
        a.run.outcome.complete(SignInOutcome.SignedIn("ps_x", "email", null))
        s.until { it is PolarisNearbyUi.Confirm }
        a.run.end()
        assertEquals(PolarisNearbyUi.Over(failed = true), s.ui.value)
        assertEquals(0, signedIn.get())
    }

    @Test
    fun useACodeInsteadCancelsNearbyAndHandsOver() {
        val a = Actions()
        val s = waiting(a)
        s.useCode()
        assertEquals(PolarisNearbyUi.Over(false), s.ui.value)
        assertTrue(a.run.cancels.get() >= 1)
    }

    @Test
    fun aDenialOrALapseHandsOverAsFailed() {
        val denied = Actions()
        val s = waiting(denied)
        denied.run.outcome.completeExceptionally(SignInError(ErrorCode.signInDenied, "no"))
        s.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(true), s.ui.value)

        val lapsed = Actions()
        val t = waiting(lapsed)
        lapsed.run.outcome.complete(SignInOutcome.Expired)
        t.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(true), t.ui.value)
    }

    @Test
    fun aStartThatThrowsHandsOverAndOnlyARealFailureIsFailed() {
        val na = Actions(failure = PolarisException(ErrorCode.serviceUnavailable, "off"))
        val s = state(na)
        s.begin()
        s.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(false), s.ui.value)

        val bad = Actions(failure = PolarisException(ErrorCode.rateLimited, "slow"))
        val t = state(bad)
        t.begin()
        t.until { it is PolarisNearbyUi.Over }
        assertEquals(PolarisNearbyUi.Over(true), t.ui.value)
    }

    @Test
    fun pressingSignInAgainWhileOneRunsStartsNothingNew() {
        val a = Actions()
        val s = waiting(a)
        s.begin()
        Thread.sleep(50)
        assertEquals(1, a.starts.get())
        assertFalse(s.ui.value is PolarisNearbyUi.Over)
        s.reset()
        assertEquals(PolarisNearbyUi.Idle, s.ui.value)
        assertTrue(a.run.cancels.get() >= 1)
    }
}
