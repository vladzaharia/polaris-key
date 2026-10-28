// @pkey-feature ui.kit
// The Cloud Sync kit host with a fake source (U-42.4T): the status row from the machine's status and events,
// locked against ring-changed through the key ring, screen switching, and "New recovery code".
package im.plrs.key.ui

import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.sync.SyncStatus
import im.plrs.key.sdk.CloudSyncEvent
import im.plrs.key.sdk.SyncRingPin
import im.plrs.key.sdk.SyncUnlockResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisCloudSyncHostTest {
    private val served = SyncRingPin("ring_9f3a", 2, "kid_b21c")
    private var now = 1_000L
    private val pinned = SyncRingPin("ring_old1", 1, "kid_a000")

    private class Fake : PolarisCloudSyncSource {
        var status: () -> SyncStatus = { SyncStatus(SyncState.Idle, 0) }
        var probe: () -> SyncUnlockResult = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        var flushes = 0
        var newCodes = 0
        var newCode: () -> String = { "FRESH-CODE" }
        val bus = MutableSharedFlow<CloudSyncEvent>(extraBufferCapacity = 8)
        var unlock: () -> SyncUnlockResult = { SyncUnlockResult.Unlocked("r", 1) }
        val accepted = mutableListOf<SyncRingPin>()

        override suspend fun status() = status.invoke()
        override suspend fun flush(): SyncStatus {
            flushes++
            return status.invoke()
        }
        override suspend fun probe() = probe.invoke()
        override val events: Flow<CloudSyncEvent> = bus
        override val actions = object : PolarisSyncActions {
            override suspend fun unlock() = unlock.invoke()
            override suspend fun recover(code: String) = Unit
            override suspend fun startOver(): String? = "NEW-CODE"
            override suspend fun create(): String? = null
            override suspend fun newRecoveryCode(): String {
                newCodes++
                return newCode()
            }
            override suspend fun acceptRingChange(served: SyncRingPin): SyncUnlockResult {
                accepted += served
                return SyncUnlockResult.Unlocked("r", 2)
            }
        }
    }

    private fun TestScope.host(fake: Fake) = PolarisCloudSyncHost(fake, backgroundScope) { now }

    private suspend fun PolarisCloudSyncHost.row(): PolarisCloudSyncRow? {
        refresh()
        return status.value?.row
    }

    @Test
    fun theMachinesStateBecomesTheRow() = runTest {
        val fake = Fake()
        val host = host(fake)
        val expected = mapOf(
            SyncState.Idle to PolarisCloudSyncRow.Synced, SyncState.Pending to PolarisCloudSyncRow.Synced,
            SyncState.Syncing to PolarisCloudSyncRow.Syncing, SyncState.Offline to PolarisCloudSyncRow.Offline,
            SyncState.Paused to PolarisCloudSyncRow.Offline, SyncState.Blocked to PolarisCloudSyncRow.Error,
            SyncState.Local to null, SyncState.Unsupported to null,
        )
        for ((state, row) in expected) {
            fake.status = { SyncStatus(state, 0) }
            assertEquals(state.name, row, host.row())
        }
    }

    @Test
    fun aBlockedMachineWithoutAnAccountSaysSignedOut() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.status = { SyncStatus(SyncState.Blocked, 0, reason = "accountRequired") }
        assertEquals(PolarisCloudSyncRow.SignedOut, host.row())
    }

    @Test
    fun aServiceThatIsOffLeavesNoRow() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.status = { throw IllegalStateException("off") }
        assertNull(host.row())
    }

    @Test
    fun lockedIsToldFromARingChangeThroughTheKeyRing() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.status = { SyncStatus(SyncState.Locked, 0) }
        assertEquals(PolarisCloudSyncRow.Locked, host.row())
        fake.probe = { SyncUnlockResult.RingChanged(pinned, served, 5L, "dev_1") }
        assertEquals(PolarisCloudSyncRow.RingChanged, host.row())
        fake.probe = { throw IllegalStateException("net") }
        assertEquals(PolarisCloudSyncRow.Locked, host.row())
    }

    @Test
    fun eventsMoveTheRow() = runTest {
        val fake = Fake()
        val host = host(fake)
        host.start()
        runCurrent()
        assertEquals(PolarisCloudSyncRow.Synced, host.status.value?.row)
        assertNull(host.status.value?.syncedAtMillis)
        fake.bus.emit(CloudSyncEvent.Change(listOf("k"), "remote"))
        runCurrent()
        assertEquals(1_000L, host.status.value?.syncedAtMillis)
        fake.bus.emit(CloudSyncEvent.SignedOut("signOut", 0))
        runCurrent()
        assertEquals(PolarisCloudSyncRow.SignedOut, host.status.value?.row)
        fake.bus.emit(CloudSyncEvent.SignInOffered(null))
        runCurrent()
        assertEquals(PolarisCloudSyncRow.SignedOut, host.status.value?.row)
        fake.status = { SyncStatus(SyncState.Offline, 2) }
        fake.bus.emit(CloudSyncEvent.Rejected(1, "x"))
        runCurrent()
        assertEquals(PolarisCloudSyncRow.Offline, host.status.value?.row)
        host.stop()
    }

    @Test
    fun unlockingFromTheRowClosesTheScreenFlushesAndRedraws() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.status = { SyncStatus(SyncState.Locked, 0) }
        assertEquals(PolarisCloudSyncRow.Locked, host.row())
        host.openUnlock()
        assertNotNull(host.flow.value)
        fake.status = { SyncStatus(SyncState.Idle, 0) }
        runCurrent()
        assertNull(host.flow.value)
        assertEquals(1, fake.flushes)
        assertEquals(PolarisCloudSyncRow.Synced, host.status.value?.row)
    }

    @Test
    fun reviewShowsTheServedRingAndAcceptSwitchesBack() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.status = { SyncStatus(SyncState.Locked, 0) }
        fake.unlock = { SyncUnlockResult.RingChanged(pinned, served, 5L, "dev_1") }
        host.openReview()
        runCurrent()
        val state = host.flow.value!!
        assertEquals(PolarisSyncUi.RingChange("dev_1", served), state.ui.value)
        fake.status = { SyncStatus(SyncState.Idle, 0) }
        state.acceptRingChange()
        runCurrent()
        assertEquals(listOf(served), fake.accepted)
        assertNull(host.flow.value)
        assertEquals(PolarisCloudSyncRow.Synced, host.status.value?.row)
    }

    @Test
    fun cancelLeavesWithoutFlushing() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        host.openUnlock()
        runCurrent()
        assertEquals(PolarisSyncUi.Unlock(PolarisUnlockStep.Code), host.flow.value!!.ui.value)
        host.dismiss()
        runCurrent()
        assertNull(host.flow.value)
        assertEquals(0, fake.flushes)
    }

    @Test
    fun startOverShowsTheNewCodeOnceAndDoneNeedsItSaved() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.unlock = { SyncUnlockResult.Locked(SyncUnlockResult.LockReason.NoWrap) }
        host.openUnlock()
        runCurrent()
        val state = host.flow.value!!
        state.startOver()
        now += 600
        state.confirmStartOver()
        runCurrent()
        val shown = state.ui.value as PolarisSyncUi.RecoveryCode
        assertEquals("NEWC-ODE", shown.code.reveal())
        state.markSaved(true)
        state.done()
        runCurrent()
        assertNull(host.flow.value)
        assertEquals(1, fake.flushes)
    }

    @Test
    fun newRecoveryCodeGoesThroughTheClientAndIsShownOnce() = runTest {
        val fake = Fake()
        val host = host(fake)
        host.requestNewRecoveryCode()
        runCurrent()
        assertEquals(1, fake.newCodes)
        val state = host.flow.value!!
        val shown = state.ui.value as PolarisSyncUi.RecoveryCode
        assertEquals("FRES-HCOD-E", shown.code.groups().joinToString("-"))
        assertFalse(shown.toString().contains("FRES"))
        // Done waits for the tick.
        state.done()
        assertNotNull(host.flow.value)
        state.cancel()
        assertNotNull(host.flow.value)
        state.markSaved(true)
        state.done()
        runCurrent()
        assertNull(host.flow.value)
        assertEquals(1, fake.flushes)
        assertFalse(host.newCodeFailed.value)
    }

    @Test
    fun aFailedNewRecoveryCodeSaysSoAndShowsNoScreen() = runTest {
        val fake = Fake()
        val host = host(fake)
        fake.newCode = { throw IllegalStateException("offline") }
        host.requestNewRecoveryCode()
        runCurrent()
        assertTrue(host.newCodeFailed.value)
        assertNull(host.flow.value)
        fake.newCode = { "OK-CODE" }
        host.requestNewRecoveryCode()
        runCurrent()
        assertFalse(host.newCodeFailed.value)
        assertNotNull(host.flow.value)
    }
}
