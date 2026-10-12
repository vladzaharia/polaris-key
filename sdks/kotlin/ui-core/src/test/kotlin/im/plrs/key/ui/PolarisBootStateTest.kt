package im.plrs.key.ui

import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.LicenseStatus
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisBootStateTest {
    @Test
    fun reducerRemembersWhatEmitsSaid() {
        val boot = PolarisBootState(BootOptions(requiredPacks = listOf("base")))
        boot.send(BootEvent.Start)
        boot.send(BootEvent.ShellDone)
        boot.send(BootEvent.GuardDone(BootEvent.GuardResult.rolledBack))
        assertTrue(boot.ui.value.rolledBack)
        boot.send(BootEvent.SyncDone(BootEvent.SyncResult.ok))
        boot.send(BootEvent.GateStatus(LicenseStatus.needsActivation))
        assertEquals(LicenseStatus.needsActivation, boot.ui.value.waiting)
        assertTrue("an ignored event emits nothing", boot.send(BootEvent.MountDone).isEmpty())
        boot.send(BootEvent.Retry)
        assertNull("leaving the gate clears the waiting status", boot.ui.value.waiting)
        boot.send(BootEvent.SyncDone(BootEvent.SyncResult.ok))
        boot.send(BootEvent.GateStatus(LicenseStatus.ok))
        boot.send(BootEvent.DecideDone(BootEvent.Decision.optional))
        assertTrue(boot.ui.value.updateAvailable)
        boot.send(BootEvent.FetchConsent(1_000, metered = true))
        assertEquals(PolarisBootUi.Consent(1_000, true), boot.ui.value.consent)
        boot.send(BootEvent.FetchProgress(250, 1_000))
        assertNull(boot.ui.value.consent)
        assertEquals(0.25f, boot.ui.value.progress?.fraction)
        boot.send(BootEvent.FetchDone(BootEvent.FetchResult.declined, emptyList()))
        assertEquals(BootEmit.BlockedReason.contentDeclined, boot.ui.value.blocked)
        assertNull(boot.ui.value.progress)
    }

    private open class FakeHost(var status: LicenseStatus = LicenseStatus.ok) : PolarisBootHost {
        val calls = mutableListOf<String>()
        override suspend fun shell() {
            calls += "shell"
        }

        override suspend fun sync(): BootEvent.SyncResult {
            calls += "sync"
            return BootEvent.SyncResult.ok
        }

        override suspend fun gate(): LicenseStatus {
            calls += "gate"
            return status
        }

        override suspend fun mount() {
            calls += "mount"
        }
    }

    @Test
    fun driverRunsEveryStageToReady() = runTest {
        val boot = PolarisBootState()
        val host = FakeHost()
        boot.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.ready, boot.ui.value.stage)
        assertEquals(BootOutcome.ready, boot.ui.value.state.outcome)
        assertEquals(listOf("shell", "sync", "gate", "mount"), host.calls)
    }

    @Test
    fun driverWaitsAtTheGateUntilRetry() = runTest {
        val boot = PolarisBootState()
        val host = FakeHost(LicenseStatus.needsActivation)
        boot.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.gate, boot.ui.value.stage)
        assertEquals(BootOutcome.waiting, boot.ui.value.state.outcome)
        host.status = LicenseStatus.ok
        boot.retry()
        runCurrent()
        assertEquals(BootStage.ready, boot.ui.value.stage)
        assertEquals(listOf("shell", "sync", "gate", "sync", "gate", "mount"), host.calls)
    }

    @Test
    fun driverTurnsAThrowIntoAnErrorStop() = runTest {
        val boot = PolarisBootState()
        val host = object : FakeHost() {
            override suspend fun sync(): BootEvent.SyncResult = throw IllegalStateException("boom")
        }
        boot.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.error, boot.ui.value.stage)
        assertEquals("internal_error", boot.ui.value.errorCode)
    }

    @Test
    fun driverAsksForConsent() = runTest {
        val boot = PolarisBootState(BootOptions(requiredPacks = listOf("base")))
        val host = object : FakeHost() {
            override suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> {
                if (!reporter.consent(5_000, metered = false)) return BootEvent.FetchResult.declined to emptyList()
                reporter.progress(5_000, 5_000)
                return BootEvent.FetchResult.ok to listOf("base")
            }
        }
        boot.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.fetch, boot.ui.value.stage)
        assertEquals(PolarisBootUi.Consent(5_000, false), boot.ui.value.consent)
        boot.answerConsent(true)
        runCurrent()
        assertEquals(BootStage.ready, boot.ui.value.stage)
    }

    @Test
    fun driverConfirmsTheLaunchOnceItSettles() = runTest {
        val confirmed = mutableListOf<BootOutcome>()
        val host = object : PolarisBootHost {
            override suspend fun gate(): LicenseStatus = LicenseStatus.ok
            override suspend fun sync(): BootEvent.SyncResult = BootEvent.SyncResult.ok
            override suspend fun confirm(outcome: BootOutcome) {
                confirmed += outcome
            }
        }
        PolarisBootState().launch(backgroundScope, host)
        runCurrent()
        assertEquals(listOf(BootOutcome.ready), confirmed)
    }
}
