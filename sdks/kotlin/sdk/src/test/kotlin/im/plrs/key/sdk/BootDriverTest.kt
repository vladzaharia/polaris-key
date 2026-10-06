// @pkey-feature ui.boot
//
// BootDriver, the one-call boot's loop (SP-20): every stage's work in order to ready, the wait at a
// gate until a retry, a throw turned into an error stop, consent answered by the host or by the
// player, a stage preempted by an outside event, and `run(untilSettled)` returning at the first stop.
// The corpus proofs (stage-matrix.json rows through the driver, boot-cold-register.json through
// `client.boot()`) live in :conformance.

package im.plrs.key.sdk

import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BootDriverTest {
    private open class FakeHost(var status: LicenseStatus = LicenseStatus.ok) : PolarisBootHost {
        val calls = mutableListOf<String>()
        val confirmed = mutableListOf<BootOutcome>()
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
        override suspend fun confirm(outcome: BootOutcome) {
            confirmed += outcome
        }
    }

    @Test
    fun runsEveryStageToReadyAndConfirmsOnce() = runTest {
        val driver = BootDriver()
        val host = FakeHost()
        driver.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.ready, driver.state.value.stage)
        assertEquals(listOf("shell", "sync", "gate", "mount"), host.calls)
        assertEquals(listOf(BootOutcome.ready), host.confirmed)
    }

    @Test
    fun waitsAtTheGateUntilRetry() = runTest {
        val driver = BootDriver()
        val host = FakeHost(LicenseStatus.needsActivation)
        driver.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootOutcome.waiting, driver.state.value.outcome)
        host.status = LicenseStatus.ok
        driver.retry()
        runCurrent()
        assertEquals(BootStage.ready, driver.state.value.stage)
        assertEquals(listOf("shell", "sync", "gate", "sync", "gate", "mount"), host.calls)
        assertEquals("confirmed once, at the first settle", listOf(BootOutcome.waiting), host.confirmed)
    }

    @Test
    fun runUntilSettledReturnsAtTheFirstStop() = runTest {
        val state = BootDriver().run(FakeHost(LicenseStatus.revoked), untilSettled = true)
        assertEquals(BootStage.gate, state.stage)
        assertEquals(BootOutcome.waiting, state.outcome)
    }

    @Test
    fun aThrowBecomesAnErrorStopWithItsCode() = runTest {
        val generic = BootDriver().run(
            object : FakeHost() {
                override suspend fun sync(): BootEvent.SyncResult = throw IllegalStateException("boom")
            },
            untilSettled = true,
        )
        assertEquals(BootStage.error, generic.stage)
        val coded = mutableListOf<String>()
        BootDriver(onTransition = { t -> t.emits.filterIsInstance<im.plrs.key.core.BootEmit.Error>().forEach { coded += it.code } }).run(
            object : FakeHost() {
                override suspend fun gate(): LicenseStatus = throw PolarisException(ErrorCode.networkError, "down")
            },
            untilSettled = true,
        )
        assertEquals(listOf(ErrorCode.networkError), coded)
    }

    private class FetchHost : FakeHost() {
        override suspend fun fetch(reporter: PolarisFetchReporter): Pair<BootEvent.FetchResult, List<String>> {
            if (!reporter.consent(5_000, metered = true)) return BootEvent.FetchResult.declined to emptyList()
            reporter.progress(5_000, 5_000)
            return BootEvent.FetchResult.ok to listOf("base")
        }
    }

    @Test
    fun consentWaitsForThePlayer() = runTest {
        val driver = BootDriver(BootOptions(requiredPacks = listOf("base")))
        driver.launch(backgroundScope, FetchHost())
        runCurrent()
        assertEquals(BootStage.fetch, driver.state.value.stage)
        assertEquals(BootOutcome.waiting, driver.state.value.outcome)
        driver.answerConsent(true)
        runCurrent()
        assertEquals(BootStage.ready, driver.state.value.stage)
    }

    @Test
    fun consentAnsweredByTheHost() = runTest {
        val asked = mutableListOf<Long>()
        val declined = BootDriver(BootOptions(requiredPacks = listOf("base")), answer = { b, _ -> asked += b; false })
            .run(FetchHost(), untilSettled = true)
        assertEquals(BootStage.blocked, declined.stage)
        assertEquals(listOf(5_000L), asked)
        val accepted = BootDriver(BootOptions(requiredPacks = listOf("base")), answer = { _, _ -> true }).run(FetchHost(), untilSettled = true)
        assertEquals(BootStage.ready, accepted.stage)
    }

    @Test
    fun anOutsideEventPreemptsTheStageAtWork() = runTest {
        val hang = CompletableDeferred<BootEvent.SyncResult>()
        val host = object : FakeHost() {
            override suspend fun sync(): BootEvent.SyncResult = hang.await()
        }
        val driver = BootDriver()
        driver.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.sync, driver.state.value.stage)
        // The host's own timeout: the sync is abandoned and the boot goes on offline.
        assertTrue(driver.send(BootEvent.SyncTimeout).isNotEmpty())
        runCurrent()
        assertEquals(BootStage.ready, driver.state.value.stage)
        assertTrue("the abandoned sync was cancelled", hang.isCancelled || !hang.isCompleted)
    }
}
