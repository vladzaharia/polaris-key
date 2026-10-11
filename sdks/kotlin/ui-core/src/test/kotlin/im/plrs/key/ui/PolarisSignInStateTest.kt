package im.plrs.key.ui

import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The device-code model remains independently usable without a Compose runtime. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolarisSignInStateTest {
    private val prompt = SignInPrompt(
        "dc",
        "ABCD-EFGH",
        "https://key.plrs.im/activate",
        "https://key.plrs.im/activate?user_code=ABCD-EFGH",
        600,
        5,
        1_600,
    )

    @Test
    fun showsTheCodeCountsDownAndFinishes() = runTest {
        var now = 1_000L
        val done = CompletableDeferred<SignInResult>()
        var signedIn = false
        val state = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin(): SignInPrompt = prompt
                override suspend fun wait(prompt: SignInPrompt): SignInResult = done.await()
            },
            backgroundScope,
            clock = { now },
            onSignedIn = { signedIn = true },
        )

        assertEquals(PolarisSignInUi.Starting, state.ui.value)
        state.start()
        runCurrent()
        val showing = state.ui.value as PolarisSignInUi.Showing
        assertEquals(600, showing.secondsLeft)
        assertEquals(1f, showing.fractionLeft)

        now = 1_300
        advanceTimeBy(1_001)
        assertEquals(300, (state.ui.value as PolarisSignInUi.Showing).secondsLeft)
        assertEquals(0.5f, (state.ui.value as PolarisSignInUi.Showing).fractionLeft)

        done.complete(SignInResult.Ready)
        runCurrent()
        assertEquals(PolarisSignInUi.Done, state.ui.value)
        assertTrue(signedIn)
    }

    @Test
    fun expiryAndFailureAreRecoverableByRestarting() = runTest {
        var result: SignInResult = SignInResult.Expired
        val state = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin(): SignInPrompt = prompt
                override suspend fun wait(prompt: SignInPrompt): SignInResult = result
            },
            backgroundScope,
        )

        state.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Expired, state.ui.value)
        state.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Expired, state.ui.value)

        result = SignInResult.Error("boom")
        state.restart()
        runCurrent()
        assertEquals(PolarisSignInUi.Failed, state.ui.value)

        val failing = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin(): SignInPrompt = throw IllegalStateException("offline")
                override suspend fun wait(prompt: SignInPrompt): SignInResult = SignInResult.Ready
            },
            backgroundScope,
        )
        failing.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Failed, failing.ui.value)
    }
}
