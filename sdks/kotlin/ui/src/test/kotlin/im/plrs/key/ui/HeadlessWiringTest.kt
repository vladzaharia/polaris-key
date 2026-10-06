// The SDK-level behaviour the kit's screens consume (SP-K06, SP-K07, SP-K08): "Continue free"
// enrolment, editable settings rows typed from the catalog (set and reset through the actions), the
// update state following a background install to "Restart to finish" and finishing it, and the boot
// confirming the launch once it settles.

package im.plrs.key.ui

import im.plrs.key.config.CatalogEntry
import im.plrs.key.config.ConfigSource
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.license.ActivationResult
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HeadlessWiringTest {
    private class EnrollGate(private val result: ActivationResult) : PolarisGateActions {
        var state = LicenseState(LicenseStatus.needsActivation)
        var enrolled = 0
        override suspend fun status() = state
        override suspend fun activate(key: String): ActivationResult = ActivationResult.EnrollDisabled
        override suspend fun enroll(): ActivationResult {
            enrolled++
            if (result is ActivationResult.Ok) state = LicenseState(LicenseStatus.ok)
            return result
        }
    }

    @Test
    fun continueFreeEnrolsAndShowsARefusalLikeAnActivation() = runTest {
        val ok = EnrollGate(ActivationResult.Ok("pkeyt_free", 1))
        val gate = PolarisGateState(ok, backgroundScope)
        gate.continueFree()
        runCurrent()
        assertEquals(1, ok.enrolled)
        assertEquals(LicenseStatus.ok, gate.gate.value.license?.status)
        assertNull(gate.activation.value.error)

        val closed = EnrollGate(ActivationResult.EnrollDisabled)
        val refused = PolarisGateState(closed, backgroundScope)
        refused.continueFree()
        runCurrent()
        val error = refused.activation.value.error
        assertTrue("$error", error is PolarisActivationError.Refused && error.result == ActivationResult.EnrollDisabled)
    }

    @Test
    fun settingEditorsFollowTheCatalog() {
        fun entry(schema: String) = CatalogEntry("k", "config", "K", null, null, im.plrs.key.core.JsonText.parse(schema) as JsonObject, null)
        assertEquals(PolarisSettingEditor.Toggle(true), settingEditor(entry("""{"type":"boolean"}"""), JsonPrimitive(true)))
        val choice = settingEditor(entry("""{"type":"string","enum":["low","high"]}"""), JsonPrimitive("high"))
        assertEquals(PolarisSettingEditor.Choice(listOf("low" to JsonPrimitive("low"), "high" to JsonPrimitive("high")), 1), choice)
        assertEquals(PolarisSettingEditor.Number("4", integer = true, min = 1.0, max = 16.0), settingEditor(entry("""{"type":"integer","minimum":1,"maximum":16}"""), JsonPrimitive(4)))
        assertEquals(PolarisSettingEditor.Text("hi", 10), settingEditor(entry("""{"type":"string","maxLength":10}"""), JsonPrimitive("hi")))
        // Without a catalog, the value's own JSON type; an object has no editor.
        assertEquals(PolarisSettingEditor.Toggle(false), settingEditor(null, JsonPrimitive(false)))
        assertNull(settingEditor(null, JsonArray(emptyList())))
    }

    @Test
    fun settingsSetAndResetGoThroughTheActions() = runTest {
        val values = mutableMapOf<String, JsonElement>("ui.theme" to JsonPrimitive("dark"))
        val calls = mutableListOf<String>()
        val actions = object : PolarisSettingsActions {
            override suspend fun license(): PolarisLicenseSummary? = null
            override suspend fun entries() = values.map { (k, v) -> PolarisSettingEntry(k, k, settingText(v), ConfigSource.local) }
            override suspend fun set(key: String, value: JsonElement) {
                if (key == "locked") throw im.plrs.key.core.PolarisException(im.plrs.key.core.ErrorCode.managedByAdmin, "no")
                calls += "set $key"
                values[key] = value
            }
            override suspend fun reset(key: String) {
                calls += "reset $key"
                values[key] = JsonPrimitive("dark")
            }
        }
        val state = PolarisSettingsState(actions, backgroundScope)
        state.load()
        runCurrent()
        state.set("ui.theme", JsonPrimitive("light"))
        runCurrent()
        assertEquals("light", state.ui.value.entries.single().value)
        state.reset("ui.theme")
        runCurrent()
        assertEquals("dark", state.ui.value.entries.single().value)
        assertEquals(listOf("set ui.theme", "reset ui.theme"), calls)
        state.set("locked", JsonPrimitive(1))
        runCurrent()
        assertEquals(PolarisCopy().settingsLocked, state.ui.value.error)
        state.dismissError()
        assertNull(state.ui.value.error)
    }

    @Test
    fun theUpdateStateFollowsABackgroundInstallAndFinishesIt() = runTest {
        val stages = MutableStateFlow<InstallStage>(InstallStage.Idle)
        val calls = mutableListOf<String>()
        val actions = object : PolarisUpdateActions {
            override suspend fun install(check: UpdateCheck): InstallResult {
                calls += "install"
                return InstallResult.Started
            }
            override suspend fun finish(): InstallResult {
                calls += "finish"
                return InstallResult.Started
            }
            override val stages = stages
        }
        val state = PolarisUpdateState()
        state.follow(actions, backgroundScope)
        state.show(UpdateCheck("stable", UpdateDecision.Store(DecisionRelease("2.0.0", 20), null, false, false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList()))
        state.install(actions, backgroundScope)
        runCurrent()
        stages.value = InstallStage.Downloading(5, 10)
        runCurrent()
        assertEquals(5L to 10L, state.offer.value?.progress)
        stages.value = InstallStage.ReadyToRestart
        runCurrent()
        assertEquals(PolarisUpdateUi.Kind.Restart, state.offer.value?.kind)
        state.install(actions, backgroundScope)
        runCurrent()
        assertEquals(listOf("install", "finish"), calls)
        stages.value = InstallStage.Failed("platform_error")
        runCurrent()
        assertEquals(PolarisCopy().updateFailed, state.offer.value?.error)
    }

    @Test
    fun theBootConfirmsTheLaunchOnceItSettles() = runTest {
        val confirmed = mutableListOf<BootOutcome>()
        val host = object : PolarisBootHost {
            override suspend fun gate(): LicenseStatus = LicenseStatus.ok
            override suspend fun sync(): im.plrs.key.core.BootEvent.SyncResult = im.plrs.key.core.BootEvent.SyncResult.ok
            override suspend fun confirm(outcome: BootOutcome) {
                confirmed += outcome
            }
        }
        PolarisBootState().launch(backgroundScope, host)
        runCurrent()
        assertEquals(listOf(BootOutcome.ready), confirmed)
    }
}
