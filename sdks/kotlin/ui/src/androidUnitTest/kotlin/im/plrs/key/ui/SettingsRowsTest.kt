// @pkey-feature ui.settings
// UI-KITS.md 4.3 AccountAndLicense and Settings: typed controls from the catalog (a switch for a
// boolean), a locked setting is its value as text with the lock and "Set by <Developer>" and never a
// dimmed switch, provenance is text, "Reset to default" appears for a change made on this device,
// and the rows are grouped under "From <Developer>" and "Managed settings" headers, with no invented
// "Configuration" or "License" header.

package im.plrs.key.ui

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.config.ConfigSource
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class SettingsRowsTest {
    @get:Rule
    val rule = createComposeRule()

    private val sets = mutableListOf<Pair<String, JsonElement>>()
    private val resets = mutableListOf<String>()

    private val ui = PolarisSettingsUi(
        loading = false,
        entries = listOf(
            PolarisSettingEntry("audio.volume", "Music volume", "80", ConfigSource.remoteDefault),
            PolarisSettingEntry("hints.enabled", "Show hints", "true", ConfigSource.local, editor = PolarisSettingEditor.Toggle(true)),
            PolarisSettingEntry("telemetry.enabled", "Share diagnostics", "false", ConfigSource.enforced, editor = PolarisSettingEditor.Toggle(false)),
            PolarisSettingEntry("server.region", "Server region", "eu-west", ConfigSource.fallback),
        ),
    )

    private fun show(developer: String? = "Harbor Audio") {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false, developer = developer) {
                    PolarisSettingsScreen(ui, onSet = { k, v -> sets += k to v }, onReset = { resets += it })
                }
            }
        }
        rule.waitForIdle()
    }

    private val switches = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)

    @Test
    fun aBooleanIsASwitchThatSetsItsOppositeAndLockedIsNeverOne() {
        show()
        // One switch: Show hints. The locked row is text, not a dimmed switch.
        rule.onAllNodes(switches).assertCountEquals(1)
        rule.onNodeWithText("Show hints").performClick()
        assertEquals(listOf<Pair<String, JsonElement>>("hints.enabled" to JsonPrimitive(false)), sets)
    }

    @Test
    fun aLockedRowNamesItsSourceAndShowsItsValueAsText() {
        show()
        rule.onNodeWithText("Set by Harbor Audio").assertIsDisplayed()
        rule.onNodeWithText("Share diagnostics").assertIsDisplayed()
        rule.onNodeWithText("Off").assertIsDisplayed()
    }

    @Test
    fun aLockedRowWithNoKnownDeveloperKeepsTheGenericSource() {
        show(developer = null)
        rule.onNodeWithText(sampleCopy.settingsLocked).assertIsDisplayed()
    }

    @Test
    fun aChangeMadeHereOffersResetToDefault() {
        show()
        rule.onNodeWithText("Reset to default").performClick()
        assertEquals(listOf("hints.enabled"), resets)
    }

    @Test
    fun rowsAreGroupedByProvenanceUnderCatalogHeaders() {
        show()
        rule.onNodeWithText("From Harbor Audio").assertIsDisplayed()
        rule.onNodeWithText("Managed settings").assertIsDisplayed()
        rule.onNodeWithText("Configuration").assertDoesNotExist()
        rule.onNodeWithText("License").assertDoesNotExist()
    }

    @Test
    fun withNoDeveloperTheDefaultsStayWithTheRestAndThereIsNoFromHeader() {
        val groups = settingGroups(ui.entries, developer = null, locale = "en")
        assertEquals(listOf("Managed settings", null), groups.map { it.title })
        assertEquals(listOf("telemetry.enabled"), groups[0].entries.map { it.key })
        assertEquals(listOf("audio.volume", "hints.enabled", "server.region"), groups[1].entries.map { it.key })
    }

    @Test
    fun theGroupsPartitionTheRows() {
        val groups = settingGroups(ui.entries, developer = "Harbor Audio", locale = "en")
        assertEquals(listOf("From Harbor Audio", "Managed settings", null), groups.map { it.title })
        assertEquals(ui.entries.map { it.key }.sorted(), groups.flatMap { g -> g.entries.map { it.key } }.sorted())
    }
}
