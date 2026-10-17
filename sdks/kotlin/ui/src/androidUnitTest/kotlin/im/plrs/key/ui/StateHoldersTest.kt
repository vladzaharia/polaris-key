// The Compose layer over the headless state holders (:ui-core owns the holders and their own
// tests): the gate and boot screens the stages and outcomes select, the verification host and QR
// modules the activation screen draws, the copy that names a device or an update, and the settings
// screen's values and catalog-owned failure copy.

package im.plrs.key.ui

import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootOptions
import im.plrs.key.core.LicenseStatus
import im.plrs.key.sdk.DeviceInfo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StateHoldersTest {
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

    @Test
    fun bootScreensFollowTheStageAndOutcome() {
        val boot = PolarisBootState(BootOptions(requiredPacks = listOf("base")))
        boot.send(BootEvent.Start)
        boot.send(BootEvent.ShellDone)
        boot.send(BootEvent.GuardDone(BootEvent.GuardResult.rolledBack))
        boot.send(BootEvent.SyncDone(BootEvent.SyncResult.ok))
        boot.send(BootEvent.GateStatus(LicenseStatus.needsActivation))
        assertEquals(BootScreen.Gate, bootScreen(boot.ui.value))
        boot.send(BootEvent.Retry)
        boot.send(BootEvent.SyncDone(BootEvent.SyncResult.ok))
        boot.send(BootEvent.GateStatus(LicenseStatus.ok))
        boot.send(BootEvent.DecideDone(BootEvent.Decision.optional))
        boot.send(BootEvent.FetchConsent(1_000, metered = true))
        assertEquals(BootScreen.Consent, bootScreen(boot.ui.value))
        boot.send(BootEvent.FetchProgress(250, 1_000))
        assertEquals(BootScreen.Fetch, bootScreen(boot.ui.value))
        boot.send(BootEvent.FetchDone(BootEvent.FetchResult.declined, emptyList()))
        assertEquals(BootScreen.Blocked, bootScreen(boot.ui.value))
    }

    @Test
    fun updateBannerTextNamesTheVersionWhenThereIsOne() {
        val copy = PolarisCopy()
        assertEquals("Version 2.5.0 is available", copy.updateBannerText(PolarisUpdateUi("2.5.0")))
        assertEquals(copy.updateAvailableGeneric, copy.updateBannerText(PolarisUpdateUi(null)))
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

    @Test
    fun blankDeviceLabelUsesCopyFallback() {
        val device = DeviceInfo("x", false, LicenseStatus.ok, label = " ")
        assertEquals(PolarisCopy().deviceUnnamed, PolarisCopy().deviceName(device))
    }

    // ── Settings ─────────────────────────────────────────────────────────────────────────────

    @Test
    fun settingsLoad() = runTest {
        val state = PolarisSettingsState(
            object : PolarisSettingsActions {
                override suspend fun license() = sampleSettings.license
                override suspend fun entries() = sampleSettings.entries
                override suspend fun set(key: String, value: kotlinx.serialization.json.JsonElement) = Unit
                override suspend fun reset(key: String) = Unit
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
        assertEquals(
            PolarisCopy().settingsLocked,
            PolarisCopy().settingsFailureMessage(PolarisSettingsFailure(im.plrs.key.core.ErrorCode.managedByAdmin, "backend detail")),
        )
    }
}
