// The state holders over fake SDK actions: what each StateFlow shows as the player acts, and that
// the boot shell drives :core's stage machine through every stage to ready, waits at the gate and
// at stops, asks for consent, and retries.

package im.plrs.key.ui

import im.plrs.key.core.BootEmit
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.BootStage
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.UpdateDecision
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import im.plrs.key.license.ActivationResult
import im.plrs.key.packs.PackProgress
import im.plrs.key.sdk.DeviceInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StateHoldersTest {
    // ── Gate ─────────────────────────────────────────────────────────────────────────────────

    private class FakeGate(var state: LicenseState, val result: ActivationResult = ActivationResult.Ok("pkeyt_x", 1)) : PolarisGateActions {
        val pushed = MutableSharedFlow<LicenseState>()
        var activatedWith: String? = null
        var syncs = 0
        override suspend fun status(): LicenseState = state
        override suspend fun activate(key: String): ActivationResult {
            activatedWith = key
            if (result is ActivationResult.Ok) state = LicenseState(LicenseStatus.ok)
            return result
        }
        override suspend fun sync() {
            syncs++
        }
        override val changes = pushed
    }

    @Test
    fun gateReadsStatusAndFollowsChanges() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation))
        val gate = PolarisGateState(fake, backgroundScope, clock = { 10 })
        assertNull(gate.gate.value.license)
        gate.start()
        runCurrent()
        assertEquals(LicenseStatus.needsActivation, gate.gate.value.license?.status)
        fake.pushed.emit(LicenseState(LicenseStatus.grace, graceUntil = 99))
        runCurrent()
        assertEquals(LicenseStatus.grace, gate.gate.value.license?.status)
        assertEquals(10, gate.gate.value.nowSeconds)
    }

    @Test
    fun emptyKeyIsRefusedLocally() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation))
        val gate = PolarisGateState(fake, backgroundScope)
        gate.onKeyChange("   ")
        gate.activate()
        assertEquals(PolarisActivationError.KeyEmpty, gate.activation.value.error)
        assertNull(fake.activatedWith)
        gate.onKeyChange("pkey_1")
        assertNull("typing clears the error", gate.activation.value.error)
    }

    @Test
    fun successfulActivationClearsTheFormAndReloads() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation))
        val gate = PolarisGateState(fake, backgroundScope)
        gate.onKeyChange("  pkey_abc ")
        gate.activate()
        runCurrent()
        assertEquals("pkey_abc", fake.activatedWith)
        assertEquals(PolarisActivationUi(), gate.activation.value)
        assertEquals(LicenseStatus.ok, gate.gate.value.license?.status)
    }

    @Test
    fun refusedActivationKeepsTheKeyAndShowsWhy() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.needsActivation), ActivationResult.Unauthorized)
        val gate = PolarisGateState(fake, backgroundScope)
        gate.onKeyChange("pkey_bad")
        gate.activate()
        runCurrent()
        val ui = gate.activation.value
        assertEquals("pkey_bad", ui.key)
        assertFalse(ui.busy)
        assertEquals(PolarisActivationError.Refused(ActivationResult.Unauthorized), ui.error)
    }

    @Test
    fun refreshSyncsThenReloads() = runTest {
        val fake = FakeGate(LicenseState(LicenseStatus.expired))
        val gate = PolarisGateState(fake, backgroundScope)
        gate.refresh()
        runCurrent()
        assertEquals(1, fake.syncs)
        assertFalse(gate.gate.value.refreshing)
        assertEquals(LicenseStatus.expired, gate.gate.value.license?.status)
    }

    @Test
    fun gateScreens() {
        assertEquals(GateScreen.Loading, gateScreen(null))
        assertEquals(GateScreen.Content, gateScreen(LicenseStatus.ok))
        assertEquals(GateScreen.Content, gateScreen(LicenseStatus.notApplicable))
        assertEquals(GateScreen.Grace, gateScreen(LicenseStatus.grace))
        assertEquals(GateScreen.Activation, gateScreen(LicenseStatus.needsActivation))
        assertEquals(GateScreen.Activation, gateScreen(LicenseStatus.revoked))
        for (s in listOf(LicenseStatus.expired, LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled)) {
            assertEquals(GateScreen.Message, gateScreen(s))
        }
    }

    // ── Sign-in ──────────────────────────────────────────────────────────────────────────────

    private val prompt = SignInPrompt("dc", "ABCD-EFGH", "https://key.plrs.im/activate", "https://key.plrs.im/activate?user_code=ABCD-EFGH", 600, 5, 1_600)

    @Test
    fun signInShowsTheCodeCountsDownAndFinishes() = runTest {
        var now = 1_000L
        val done = CompletableDeferred<SignInResult>()
        var signedIn = false
        val state = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin() = prompt
                override suspend fun wait(prompt: SignInPrompt) = done.await()
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
    fun signInExpiryAndFailure() = runTest {
        var result: SignInResult = SignInResult.Expired
        val state = PolarisSignInState(
            object : PolarisSignInActions {
                override suspend fun begin() = prompt
                override suspend fun wait(prompt: SignInPrompt) = result
            },
            backgroundScope,
        )
        state.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Expired, state.ui.value)
        // start() on a finished flow starts over: a new sign-in asks for a new code.
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
                override suspend fun wait(prompt: SignInPrompt) = SignInResult.Ready
            },
            backgroundScope,
        )
        failing.start()
        runCurrent()
        assertEquals(PolarisSignInUi.Failed, failing.ui.value)
    }

    @Test
    fun verificationHost() {
        assertEquals("key.plrs.im/activate", displayHost("https://key.plrs.im/activate"))
        assertEquals("key.plrs.im", displayHost("https://key.plrs.im/"))
        assertEquals("not a uri", displayHost("not a uri"))
    }

    @Test
    fun qrModulesEncodeTheUri() {
        val modules = qrModules("https://key.plrs.im/activate?user_code=ABCD-EFGH")
        assertTrue(modules.size >= 21)
        assertEquals(modules.size, modules[0].size)
        // The three finder patterns' corners are dark.
        assertTrue(modules[0][0] && modules[0][modules.size - 1] && modules[modules.size - 1][0])
    }

    // ── Devices ──────────────────────────────────────────────────────────────────────────────

    @Test
    fun devicesLoadSortRenameAndDeauthorize() = runTest {
        val devices = mutableListOf(
            DeviceInfo("b", current = false, status = LicenseStatus.ok, label = "Zed"),
            DeviceInfo("a", current = true, status = LicenseStatus.ok, label = "Pixel"),
            DeviceInfo("c", current = false, status = LicenseStatus.ok, label = "alpha"),
        )
        val renamed = mutableListOf<Pair<String, String?>>()
        val state = PolarisDevicesState(
            object : PolarisDevicesActions {
                override suspend fun list() = devices.toList()
                override suspend fun rename(deviceId: String, label: String?) {
                    renamed += deviceId to label
                }
                override suspend fun deauthorize(deviceId: String) {
                    devices.removeAll { it.id == deviceId }
                }
            },
            backgroundScope,
            clockMillis = { 5 },
        )
        state.load()
        runCurrent()
        assertEquals(listOf("a", "c", "b"), state.ui.value.devices.map { it.id })
        state.rename("c", "   ")
        runCurrent()
        assertEquals(listOf("c" to null), renamed)
        state.deauthorize("b")
        runCurrent()
        assertEquals(listOf("a", "c"), state.ui.value.devices.map { it.id })
        assertNull(state.ui.value.busyId)
        assertEquals(PolarisCopy().deviceUnnamed, PolarisCopy().deviceName(DeviceInfo("x", false, LicenseStatus.ok, label = " ")))
    }

    @Test
    fun devicesErrorIsShown() = runTest {
        val state = PolarisDevicesState(
            object : PolarisDevicesActions {
                override suspend fun list(): List<DeviceInfo> = throw IllegalStateException("401")
                override suspend fun rename(deviceId: String, label: String?) {}
                override suspend fun deauthorize(deviceId: String) {}
            },
            backgroundScope,
        )
        state.load()
        runCurrent()
        assertTrue(state.ui.value.error)
        assertFalse(state.ui.value.loading)
    }

    // ── Settings ─────────────────────────────────────────────────────────────────────────────

    @Test
    fun settingsLoad() = runTest {
        val state = PolarisSettingsState(
            object : PolarisSettingsActions {
                override suspend fun license() = sampleSettings.license
                override suspend fun entries() = sampleSettings.entries
            },
            backgroundScope,
        )
        assertTrue(state.ui.value.loading)
        state.load()
        runCurrent()
        assertEquals(sampleSettings, state.ui.value)
        assertEquals("—", settingText(kotlinx.serialization.json.JsonNull))
        assertEquals("high", settingText(kotlinx.serialization.json.JsonPrimitive("high")))
        assertEquals("true", settingText(kotlinx.serialization.json.JsonPrimitive(true)))
        assertEquals(PolarisCopy().settingsLocked, PolarisCopy().sourceLabel(im.plrs.key.config.ConfigSource.enforced))
    }

    // ── Update ───────────────────────────────────────────────────────────────────────────────

    @Test
    fun updateDecisionsMapToOffers() {
        val release = DecisionRelease("2.5.0", 7)
        assertEquals(
            PolarisUpdateUi("2.5.0", mandatory = true, critical = false),
            PolarisUpdateUi.from(UpdateDecision.Binary("apk", release, "b1", mandatory = true, critical = false, prestage = emptyList(), discardStaged = false)),
        )
        assertEquals(
            PolarisUpdateUi("2.5.0", mandatory = false, critical = true),
            PolarisUpdateUi.from(UpdateDecision.Store(release, null, mandatory = false, critical = true, discardStaged = false)),
        )
        assertEquals(
            PolarisUpdateUi("2.5.0", mandatory = false, critical = false),
            PolarisUpdateUi.from(UpdateDecision.Platform(release, mandatory = false, critical = false, discardStaged = false)),
        )
        assertEquals(
            PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart),
            PolarisUpdateUi.from(UpdateDecision.CodeReady(release, critical = false, discardStaged = false)),
        )
        assertNull(PolarisUpdateUi.from(UpdateDecision.None("current", behind = false, discardStaged = false)))
        assertNull(PolarisUpdateUi.from(UpdateDecision.Blocked("content-floor", discardStaged = false)))
        assertNull(PolarisUpdateUi.from(UpdateDecision.Packs(emptyList(), emptyList(), emptyList(), discardStaged = false)))
        val copy = PolarisCopy()
        assertEquals("Version 2.5.0 is available", copy.updateBannerText(PolarisUpdateUi("2.5.0")))
        assertEquals(copy.updateAvailableGeneric, copy.updateBannerText(PolarisUpdateUi(null)))
    }

    @Test
    fun dismissedVersionsStayDismissedUnlessMandatory() {
        val state = PolarisUpdateState()
        state.show(PolarisUpdateUi("2.5.0"))
        state.dismiss()
        assertNull(state.offer.value)
        state.show(PolarisUpdateUi("2.5.0"))
        assertNull(state.offer.value)
        state.show(PolarisUpdateUi("2.6.0"))
        assertEquals("2.6.0", state.offer.value?.version)
        state.show(PolarisUpdateUi("2.6.0", mandatory = true))
        state.dismiss()
        assertEquals("a mandatory update cannot be dismissed", "2.6.0", state.offer.value?.version)
    }

    // ── Packs ────────────────────────────────────────────────────────────────────────────────

    @Test
    fun packProgressFoldsEvents() {
        var ui = PolarisPackProgressUi()
        ui = ui.reduce(PackProgress("base", "download", 10, 100))
        ui = ui.reduce(PackProgress("dlc", "download", 0, 300))
        ui = ui.reduce(PackProgress("base", "apply", 100, 100))
        ui = ui.reduce(PackProgress("x", "mystery", 1, 1))
        assertEquals(listOf("base", "dlc"), ui.packs.map { it.packId })
        assertEquals(PolarisPackRow.Phase.Installing, ui.packs[0].phase)
        assertEquals(0.25f, ui.fraction)
        assertFalse(ui.complete)
        ui = ui.reduce(PackProgress("base", "done", 100, 100)).reduce(PackProgress("dlc", "done", 300, 300))
        assertTrue(ui.complete)
        assertEquals(1f, ui.fraction)
        val issue = ui.reduce(PackProgress("dlc", "state-issue", 0, 0, issue = "torn"))
        assertEquals(PolarisPackRow.Phase.Issue, issue.packs[1].phase)
        assertNull(issue.packs[1].fraction)
    }

    @Test
    fun packProgressStateSubscribes() {
        var listener: ((PackProgress) -> Unit)? = null
        var unsubscribed = false
        val state = PolarisPackProgressState { l ->
            listener = l
            { unsubscribed = true }
        }
        state.start()
        listener!!(PackProgress("base", "download", 5, 10))
        assertEquals(0.5f, state.ui.value.fraction)
        state.stop()
        assertTrue(unsubscribed)
    }

    // ── Boot ─────────────────────────────────────────────────────────────────────────────────

    @Test
    fun bootReducerRemembersWhatEmitsSaid() {
        val boot = PolarisBootState(BootOptions(requiredPacks = listOf("base")))
        boot.send(BootEvent.Start)
        boot.send(BootEvent.ShellDone)
        boot.send(BootEvent.GuardDone(BootEvent.GuardResult.rolledBack))
        assertTrue(boot.ui.value.rolledBack)
        boot.send(BootEvent.SyncDone(BootEvent.SyncResult.ok))
        boot.send(BootEvent.GateStatus(LicenseStatus.needsActivation))
        assertEquals(LicenseStatus.needsActivation, boot.ui.value.waiting)
        assertEquals(BootScreen.Gate, bootScreen(boot.ui.value))
        assertTrue("an ignored event emits nothing", boot.send(BootEvent.MountDone).isEmpty())
        boot.send(BootEvent.Retry)
        assertNull("leaving the gate clears the waiting status", boot.ui.value.waiting)
        boot.send(BootEvent.SyncDone(BootEvent.SyncResult.ok))
        boot.send(BootEvent.GateStatus(LicenseStatus.ok))
        boot.send(BootEvent.DecideDone(BootEvent.Decision.optional))
        assertTrue(boot.ui.value.updateAvailable)
        boot.send(BootEvent.FetchConsent(1_000, metered = true))
        assertEquals(PolarisBootUi.Consent(1_000, true), boot.ui.value.consent)
        assertEquals(BootScreen.Consent, bootScreen(boot.ui.value))
        boot.send(BootEvent.FetchProgress(250, 1_000))
        assertNull(boot.ui.value.consent)
        assertEquals(0.25f, boot.ui.value.progress?.fraction)
        assertEquals(BootScreen.Fetch, bootScreen(boot.ui.value))
        boot.send(BootEvent.FetchDone(BootEvent.FetchResult.declined, emptyList()))
        assertEquals(BootEmit.BlockedReason.contentDeclined, boot.ui.value.blocked)
        assertEquals(BootScreen.Blocked, bootScreen(boot.ui.value))
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
    fun bootDriverRunsEveryStageToReady() = runTest {
        val boot = PolarisBootState()
        val host = FakeHost()
        boot.launch(backgroundScope, host)
        runCurrent()
        assertEquals(BootStage.ready, boot.ui.value.stage)
        assertEquals(BootOutcome.ready, boot.ui.value.state.outcome)
        assertEquals(listOf("shell", "sync", "gate", "mount"), host.calls)
    }

    @Test
    fun bootDriverWaitsAtTheGateUntilRetry() = runTest {
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
    fun bootDriverTurnsAThrowIntoAnErrorStop() = runTest {
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
    fun bootDriverAsksForConsent() = runTest {
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
}
