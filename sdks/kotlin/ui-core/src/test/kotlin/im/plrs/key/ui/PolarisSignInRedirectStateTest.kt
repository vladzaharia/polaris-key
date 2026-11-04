// @pkey-feature identity.link
// @pkey-feature identity.redirect.native
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.identity.LinkAcceptResult
import im.plrs.key.identity.SignInOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rung 6 and the link steps, over fakes: the model needs no Compose runtime. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolarisSignInRedirectStateTest {
    private class Browser(override var opened: Boolean = true) : PolarisRedirectSession {
        val settled = CompletableDeferred<SignInOutcome>()
        var reopened = 0
        var cancelled = false
        override val link: String = "https://key.example/authorize?request_uri=r"
        override suspend fun reopen(): Boolean {
            reopened += 1
            return opened
        }
        override suspend fun wait(): SignInOutcome = settled.await()
        override fun cancel() {
            cancelled = true
            settled.complete(SignInOutcome.Cancelled)
        }
    }

    private class Actions(val browser: PolarisRedirectSession?, val entry: PolarisLinkEntry? = PolarisLinkEntry("Google", "global")) :
        PolarisSignInActions {
        var codes = 0
        var accepted: LinkAcceptResult = LinkAcceptResult.Linked("google", "global")
        var declined = 0
        var dismissed = 0
        var offers = 0
        override suspend fun begin(): PolarisSignInCode {
            codes += 1
            return PolarisSignInCode("ABCD-EFGH", "https://key.example/a", "https://key.example/a?c=1", 600, 5_000)
        }
        override suspend fun wait(code: PolarisSignInCode): SignInOutcome = CompletableDeferred<SignInOutcome>().await()
        override suspend fun beginRedirect(): PolarisRedirectSession? = browser
        override suspend fun linkOffer(): PolarisLinkEntry? {
            offers += 1
            return entry
        }
        override suspend fun linkAccept(): LinkAcceptResult = accepted
        override suspend fun linkDecline() {
            declined += 1
        }
        override fun linkDismiss() {
            dismissed += 1
        }
    }

    @Test
    fun theBrowserHasTheSignInThenTheLinkIsOffered() = runTest {
        val browser = Browser()
        val actions = Actions(browser)
        var signedIn = 0
        val state = PolarisSignInState(actions, backgroundScope, onSignedIn = { signedIn += 1 })
        state.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Redirecting(opened = true, link = browser.link), state.ui.value)
        assertEquals(0, actions.codes)
        browser.settled.complete(SignInOutcome.SignedIn(subject = "s", sameDevice = true))
        runCurrent()
        assertEquals(PolarisSignInUi.LinkOffer("Google", "global"), state.ui.value)
        // The sign-in is not finished for the gate until the offer is answered.
        assertEquals(0, signedIn)
        state.linkAccept()
        runCurrent()
        assertEquals(PolarisSignInUi.LinkDone("Google"), state.ui.value)
        state.linkFinished()
        assertEquals(PolarisSignInUi.Done, state.ui.value)
        assertEquals(1, signedIn)
        assertEquals(1, actions.dismissed)
    }

    @Test
    fun noThanksDeclinesAndFinishes() = runTest {
        val browser = Browser()
        val actions = Actions(browser)
        var signedIn = 0
        val state = PolarisSignInState(actions, backgroundScope, onSignedIn = { signedIn += 1 })
        state.start()
        runCurrent()
        browser.settled.complete(SignInOutcome.SignedIn(sameDevice = true))
        runCurrent()
        state.linkDecline()
        runCurrent()
        assertEquals(1, actions.declined)
        assertEquals(PolarisSignInUi.Done, state.ui.value)
        assertEquals(1, signedIn)
    }

    @Test
    fun aSignInThatIsNotFromThisDeviceOrHasNoOfferJustFinishes() = runTest {
        val first = Browser()
        val a = Actions(first)
        val s1 = PolarisSignInState(a, backgroundScope)
        s1.start()
        runCurrent()
        first.settled.complete(SignInOutcome.SignedIn(sameDevice = false))
        runCurrent()
        assertEquals(PolarisSignInUi.Done, s1.ui.value)
        assertEquals(0, a.offers)

        val second = Browser()
        val b = Actions(second, entry = null)
        val s2 = PolarisSignInState(b, backgroundScope)
        s2.start()
        runCurrent()
        second.settled.complete(SignInOutcome.SignedIn(sameDevice = true))
        runCurrent()
        assertEquals(PolarisSignInUi.Done, s2.ui.value)
    }

    @Test
    fun linkRefusalsAreTyped() = runTest {
        suspend fun offerWith(result: LinkAcceptResult?): PolarisSignInUi {
            val browser = Browser()
            val actions = Actions(browser)
            if (result != null) actions.accepted = result
            val state = PolarisSignInState(actions, backgroundScope)
            state.start()
            runCurrent()
            browser.settled.complete(SignInOutcome.SignedIn(sameDevice = true))
            runCurrent()
            state.linkAccept()
            runCurrent()
            return state.ui.value
        }
        assertEquals(PolarisSignInUi.LinkConflict("Google"), offerWith(LinkAcceptResult.Refused(409, ErrorCode.linkConflict)))
        assertEquals(
            PolarisSignInUi.LinkOffer("Google", "global", problem = PolarisSignInUi.LinkProblem.Stale),
            offerWith(LinkAcceptResult.Refused(403, ErrorCode.stepUpRequired)),
        )
        assertEquals(
            PolarisSignInUi.LinkOffer("Google", "global", problem = PolarisSignInUi.LinkProblem.Failed),
            offerWith(LinkAcceptResult.Refused(400, ErrorCode.invalidGrant)),
        )
        assertEquals(
            PolarisSignInUi.LinkOffer("Google", "global", problem = PolarisSignInUi.LinkProblem.Failed),
            offerWith(LinkAcceptResult.Unavailable),
        )
    }

    @Test
    fun openAgainReopensAndAFailedOpenShowsNoBrowser() = runTest {
        val browser = Browser(opened = false)
        val state = PolarisSignInState(Actions(browser), backgroundScope)
        state.start()
        runCurrent()
        state.reopen()
        runCurrent()
        assertEquals(1, browser.reopened)
        assertFalse((state.ui.value as PolarisSignInUi.Redirecting).opened)
        state.linkCopied()
        assertTrue((state.ui.value as PolarisSignInUi.Redirecting).copied)
        assertEquals(browser.link, state.redirectLink)
    }

    @Test
    fun cancelEndsTheBrowserSignInAndUseCodeShowsACode() = runTest {
        val browser = Browser()
        val actions = Actions(browser)
        val state = PolarisSignInState(actions, backgroundScope, clock = { 1_000 })
        state.start()
        runCurrent()
        state.useCode()
        runCurrent()
        assertTrue(browser.cancelled)
        assertTrue(state.ui.value is PolarisSignInUi.Showing)
        assertEquals(1, actions.codes)

        val other = Browser()
        val second = PolarisSignInState(Actions(other), backgroundScope)
        second.start()
        runCurrent()
        second.cancel()
        assertTrue(other.cancelled)
        assertEquals(PolarisSignInUi.Starting, second.ui.value)
        assertNull(second.redirectLink)
    }

    @Test
    fun noRedirectFollowsTheDeviceCode() = runTest {
        val actions = Actions(null)
        val state = PolarisSignInState(actions, backgroundScope, clock = { 1_000 })
        state.start()
        runCurrent()
        assertTrue(state.ui.value is PolarisSignInUi.Showing)
        assertEquals(1, actions.codes)
    }

    @Test
    fun theRedirectStateNeverPrintsItsLink() {
        val text = PolarisSignInUi.Redirecting(true, false, "https://key.example/authorize?request_uri=r").toString()
        assertFalse(text.contains("request_uri"))
    }
}
