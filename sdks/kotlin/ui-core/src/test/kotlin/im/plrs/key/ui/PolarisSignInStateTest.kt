package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOutcome
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
    private val prompt = PolarisSignInCode(
        "ABCD-EFGH",
        "https://key.plrs.im/activate",
        "https://key.plrs.im/activate?user_code=ABCD-EFGH",
        600,
        1_600,
    )

    @Test
    fun showsTheCodeCountsDownAndFinishes() = runTest {
        var now = 1_000L
        val done = CompletableDeferred<SignInOutcome>()
        var signedIn = false
        val state = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin(): PolarisSignInCode = prompt
                override suspend fun wait(code: PolarisSignInCode): SignInOutcome = done.await()
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

        done.complete(SignInOutcome.SignedIn())
        runCurrent()
        assertEquals(PolarisSignInUi.Done, state.ui.value)
        assertTrue(signedIn)
    }

    @Test
    fun expiryAndFailureAreRecoverableByRestarting() = runTest {
        var result: Result<SignInOutcome> = Result.success(SignInOutcome.Expired)
        val state = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin(): PolarisSignInCode = prompt
                override suspend fun wait(code: PolarisSignInCode): SignInOutcome = result.getOrThrow()
            },
            backgroundScope,
        )

        state.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Expired, state.ui.value)
        state.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Expired, state.ui.value)

        result = Result.failure(SignInError(ErrorCode.signInFailed, "boom"))
        state.restart()
        runCurrent()
        assertEquals(PolarisSignInUi.Failed, state.ui.value)

        result = Result.failure(SignInError(ErrorCode.signInDenied, "device sign-in failed."))
        state.restart()
        runCurrent()
        assertEquals(PolarisSignInUi.Denied, state.ui.value)

        val failing = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin(): PolarisSignInCode = throw IllegalStateException("offline")
                override suspend fun wait(code: PolarisSignInCode): SignInOutcome = SignInOutcome.SignedIn()
            },
            backgroundScope,
        )
        failing.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Failed, failing.ui.value)
    }
}
