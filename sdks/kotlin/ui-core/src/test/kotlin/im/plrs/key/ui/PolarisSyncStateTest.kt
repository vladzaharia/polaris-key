// @pkey-feature ui.kit
// The Cloud Sync unlock flow without a renderer (U-42): each verb of `client.keyring` the screens
// call, the step it leaves the flow in, and the security points the state holder keeps (S5, S13, T22).
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.sdk.SyncRingPin
import im.plrs.key.sdk.SyncUnlockResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisSyncStateTest {
    private val served = SyncRingPin("ring_9f3a", 2, "kid_b21c")

    private class Fake : PolarisSyncActions {
        var unlock: () -> SyncUnlockResult = { SyncUnlockResult.Unlocked("r", 1) }
        var recover: (String) -> Unit = {}
        var startOver: () -> String? = { "NEW-CODE" }
        var accepted = mutableListOf<SyncRingPin>()
        var accept: (SyncRingPin) -> SyncUnlockResult = { SyncUnlockResult.Unlocked("r", 1) }
        val recovered = mutableListOf<String>()
        var resets = 0

        override suspend fun unlock() = unlock.invoke()
        override suspend fun recover(code: String) {
            recovered += code
            recover.invoke(code)
        }

        override suspend fun startOver(): String? {
            resets++
            return startOver.invoke()
        }

        override suspend fun create(): String? = "FIRST-CODE"
        override suspend fun newRecoveryCode(): String = "FRESH-CODE"
        override suspend fun acceptRingChange(served: SyncRingPin): SyncUnlockResult {
            accepted += served
            return accept(served)
        }
    }

    private fun TestScope.state(fake: Fake) = PolarisSyncState(fake, backgroundScope)

    @Test
    fun anOwnWrapUnlocksAndALockedDeviceAsksForTheCode() = runTest {
        val fake = Fake()
        val state = state(fake)
        state.open()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Working), state.ui.value)
        runCurrent()
        assertEquals(PolarisSyncUi.Done, state.ui.value)

        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        state.open()
        runCurrent()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Code), state.ui.value)
    }

    @Test
    fun aChangedRingIsShownNotOpened() = runTest {
        val fake = Fake()
        fake.unlock = { SyncUnlockResult.RingChanged(SyncRingPin("old", 1, "k"), served, 5, "Maya's MacBook") }
        val state = state(fake)
        state.open()
        runCurrent()
        assertEquals(PolarisSyncUi.RingChange("Maya's MacBook", served), state.ui.value)
        assertEquals(emptyList<SyncRingPin>(), fake.accepted)
    }

    @Test
    fun acceptHandsOverTheRingThatWasShownAndAMovedRingIsShownAgain() = runTest {
        val fake = Fake()
        val moved = SyncRingPin("ring_9f3a", 3, "kid_c")
        fake.unlock = { SyncUnlockResult.RingChanged(SyncRingPin("old", 1, "k"), served, 5, null) }
        fake.accept = { SyncUnlockResult.RingChanged(served, moved, 6, null) }
        val state = state(fake)
        state.open()
        runCurrent()
        state.acceptRingChange()
        runCurrent()
        assertEquals(listOf(served), fake.accepted)
        assertEquals(PolarisSyncUi.RingChange(null, moved), state.ui.value)

        fake.accept = { SyncUnlockResult.Unlocked("ring_9f3a", 3) }
        state.acceptRingChange()
        runCurrent()
        assertEquals(listOf(served, moved), fake.accepted)
        assertEquals(PolarisSyncUi.Done, state.ui.value)
    }

    @Test
    fun nothingServedMeansNothingToAccept() = runTest {
        val fake = Fake()
        val state = state(fake)
        state.open()
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoRing) }
        runCurrent()
        // Reaching a RingChange with no served ring is not possible from `open`; accept ignores one.
        state.acceptRingChange()
        runCurrent()
        assertEquals(emptyList<SyncRingPin>(), fake.accepted)
    }

    @Test
    fun theRecoveryCodeUnlocksAnInvalidOneAsksAgainAndAFailureCanBeRetried() = runTest {
        val fake = Fake()
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        val state = state(fake)
        state.open()
        runCurrent()

        fake.recover = { throw PolarisException(ErrorCode.recoveryCodeInvalid, "no") }
        state.submitCode("  AAAA-BBBB  ")
        runCurrent()
        assertEquals(listOf("AAAA-BBBB"), fake.recovered)
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Invalid), state.ui.value)

        fake.recover = { throw PolarisException("network", "down") }
        state.submitCode("AAAA-BBBB")
        runCurrent()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Failed), state.ui.value)

        fake.recover = {}
        state.retry()
        runCurrent()
        assertEquals(listOf("AAAA-BBBB", "AAAA-BBBB", "AAAA-BBBB"), fake.recovered)
        assertEquals(PolarisSyncUi.Done, state.ui.value)
    }

    @Test
    fun aBlankCodeIsNeverSent() = runTest {
        val fake = Fake()
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        val state = state(fake)
        state.open()
        runCurrent()
        state.submitCode("   ")
        runCurrent()
        assertEquals(emptyList<String>(), fake.recovered)
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Code), state.ui.value)
    }

    @Test
    fun startOverRunsOnlyFromItsWarning() = runTest {
        val fake = Fake()
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        val state = state(fake)
        state.open()
        runCurrent()

        state.confirmStartOver()
        runCurrent()
        assertEquals(0, fake.resets)

        state.startOver()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.StartOver), state.ui.value)
        assertEquals(0, fake.resets)
        state.confirmStartOver()
        runCurrent()
        assertEquals(1, fake.resets)
        val shown = state.ui.value as PolarisSyncUi.RecoveryCode
        assertEquals("NEW-CODE", shown.code.reveal())
        assertFalse(shown.saved)
        assertEquals("PolarisRecoveryCode(redacted)", shown.code.toString())
        assertFalse(shown.toString().contains("NEW-CODE"))
    }

    @Test
    fun doneWaitsForTheSavedConfirmation() = runTest {
        val fake = Fake()
        val state = state(fake)
        state.create()
        runCurrent()
        assertTrue(state.ui.value is PolarisSyncUi.RecoveryCode)
        state.done()
        assertTrue(state.ui.value is PolarisSyncUi.RecoveryCode)
        state.cancel()
        assertTrue("the code screen is left only through Done", state.ui.value is PolarisSyncUi.RecoveryCode)
        state.markSaved(true)
        state.done()
        assertEquals(PolarisSyncUi.Done, state.ui.value)
    }

    @Test
    fun cancelLeavesTheFlowAndRecoveryUseWithoutAServedRingGoesToTheCode() = runTest {
        val fake = Fake()
        fake.unlock = { SyncUnlockResult.RingChanged(SyncRingPin("old", 1, "k"), served, 5, "Maya") }
        val state = state(fake)
        state.open()
        runCurrent()
        state.useRecoveryCode()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Code), state.ui.value)
        state.cancel()
        assertEquals(PolarisSyncUi.Idle, state.ui.value)
    }

    @Test
    fun cancelWhileARequestRunsLeavesNothingToLandLater() = runTest {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val fake = Fake()
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        val actions = object : PolarisSyncActions by fake {
            override suspend fun recover(code: String) {
                gate.await()
            }
        }
        val state = PolarisSyncState(actions, backgroundScope)
        state.open()
        runCurrent()
        state.submitCode("AAAA")
        runCurrent()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Working), state.ui.value)
        state.cancel()
        gate.complete(Unit)
        runCurrent()
        assertEquals(PolarisSyncUi.Idle, state.ui.value)
    }

    @Test
    fun everyStepResolvesItsMatrixScreen() = runTest {
        val unlock = PolarisSyncUi.Unlock(PolarisUnlockStep.StartOver).kitScreen()!!
        assertEquals(KitComponent.unlockSync, unlock.component)
        assertEquals("start-over", unlock.state)
        val ring = PolarisSyncUi.RingChange(null, served).kitScreen()!!
        assertTrue(ring.shows("ringChange.accept"))
        assertTrue(ring.shows("ringChange.bodyUnknown"))
        assertFalse(PolarisSyncUi.RingChange("Maya", null).kitScreen()!!.shows("ringChange.accept"))
        val code = PolarisSyncUi.RecoveryCode(PolarisRecoveryCode("X"), saved = true).kitScreen()!!
        assertEquals("saved", code.state)
        assertTrue(code.shows("common.done"))
    }
}
