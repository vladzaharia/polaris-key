package im.plrs.key.ui

import im.plrs.key.config.CatalogEntry
import im.plrs.key.config.ConfigSource
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisSettingsStateTest {
    @Test
    fun editorsFollowTheCatalog() {
        fun entry(schema: String) = CatalogEntry("k", "config", "K", null, null, JsonText.parse(schema) as JsonObject, null)
        assertEquals(PolarisSettingEditor.Toggle(true), settingEditor(entry("""{"type":"boolean"}"""), JsonPrimitive(true)))
        val choice = settingEditor(entry("""{"type":"string","enum":["low","high"]}"""), JsonPrimitive("high"))
        assertEquals(PolarisSettingEditor.Choice(listOf("low" to JsonPrimitive("low"), "high" to JsonPrimitive("high")), 1), choice)
        assertEquals(PolarisSettingEditor.Number("4", integer = true, min = 1.0, max = 16.0), settingEditor(entry("""{"type":"integer","minimum":1,"maximum":16}"""), JsonPrimitive(4)))
        assertEquals(PolarisSettingEditor.Text("hi", 10), settingEditor(entry("""{"type":"string","maxLength":10}"""), JsonPrimitive("hi")))
        assertEquals(PolarisSettingEditor.Toggle(false), settingEditor(null, JsonPrimitive(false)))
        assertNull(settingEditor(null, JsonArray(emptyList())))
    }

    @Test
    fun setAndResetGoThroughActionsAndKeepTypedFailures() = runTest {
        val values = mutableMapOf<String, JsonElement>("ui.theme" to JsonPrimitive("dark"))
        val calls = mutableListOf<String>()
        val actions = object : PolarisSettingsActions {
            override suspend fun license(): PolarisLicenseSummary? = null
            override suspend fun entries() = values.map { (key, value) -> PolarisSettingEntry(key, key, settingText(value), ConfigSource.local) }
            override suspend fun set(key: String, value: JsonElement) {
                if (key == "locked") throw PolarisException(ErrorCode.managedByAdmin, "no")
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
        assertEquals(PolarisSettingsFailure(ErrorCode.managedByAdmin, "no"), state.ui.value.error)
        state.dismissError()
        assertNull(state.ui.value.error)
    }

    @Test
    fun entriesFailureIsTypedForTheRenderer() = runTest {
        val state = PolarisSettingsState(
            object : PolarisSettingsActions {
                override suspend fun license(): PolarisLicenseSummary? = null
                override suspend fun entries(): List<PolarisSettingEntry> = throw PolarisException(ErrorCode.platformError, "offline")
                override suspend fun set(key: String, value: JsonElement) = Unit
                override suspend fun reset(key: String) = Unit
            },
            backgroundScope,
        )
        state.load()
        runCurrent()
        assertEquals(PolarisSettingsFailure(ErrorCode.platformError, "offline"), state.ui.value.loadFailure)
    }

    @Test
    fun theChannelChoiceLoadsSwitchesAndKeepsTheRefusal() = runTest {
        var current = "stable"
        var lockedBy: String? = null
        val actions = object : PolarisSettingsActions {
            override suspend fun license(): PolarisLicenseSummary? = null
            override suspend fun entries() = emptyList<PolarisSettingEntry>()
            override suspend fun set(key: String, value: JsonElement) = Unit
            override suspend fun reset(key: String) = Unit
            override suspend fun channel() = PolarisChannelUi(current, listOf("stable", "beta"), lockedBy)
            override suspend fun setChannel(channel: String) {
                if (channel == "alpha") throw PolarisException(ErrorCode.channelNotAllowed, "no")
                current = channel
            }
        }
        val state = PolarisSettingsState(actions, backgroundScope)
        state.load()
        runCurrent()
        assertEquals(PolarisChannelUi("stable", listOf("stable", "beta")), state.ui.value.channel)
        state.setChannel("beta")
        runCurrent()
        assertEquals("beta", state.ui.value.channel?.current)
        state.setChannel("alpha")
        runCurrent()
        assertEquals(ErrorCode.channelNotAllowed, state.ui.value.error?.code)
        assertEquals("beta", state.ui.value.channel?.current)
    }

    @Test
    fun aPickerWithNothingToPickAndNothingFixingItIsNotDrawn() {
        assertEquals(false, PolarisChannelUi("stable", listOf("stable")).drawn)
        assertEquals(true, PolarisChannelUi("stable", listOf("stable"), "play").drawn)
        assertEquals(true, PolarisChannelUi("stable", listOf("stable", "beta")).drawn)
    }

    @Test
    fun outletsHaveStoreNames() {
        assertEquals("Google Play", outletStoreName("play"))
        assertEquals("App Store", outletStoreName("app-store"))
        assertEquals("Steam", outletStoreName("steam"))
        assertEquals("Custom", outletStoreName("custom"))
    }
}
