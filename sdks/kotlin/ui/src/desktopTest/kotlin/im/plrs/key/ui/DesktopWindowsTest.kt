// @pkey-feature ui.kit
//
// UK-10.8: the desktop windows. The state holders (which surface an update takes, the Settings window's pane
// and title, the manual update check, the sign-out question), the menu's labels per platform, and the window
// contents laid out offscreen: the update column at 440, the Settings window at 650 with its panes and no Done,
// and the Mac sheet's top (52 dp under a full-size content view, 12 dp in a plain frame).

package im.plrs.key.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class DesktopWindowsTest {
    private var old: String? = null

    private fun force(name: String) = System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, name)

    @BeforeTest
    fun remember() {
        old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        force("Windows")
    }

    @AfterTest
    fun restore() {
        old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    }

    private val release = DecisionRelease("2.5.0", 7)

    private fun check(decision: UpdateDecision) =
        UpdateCheck("stable", decision, UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())

    private val offered = check(UpdateDecision.Platform(release, mandatory = false, critical = false, discardStaged = false))
    private val current = check(UpdateDecision.None("current", behind = false, discardStaged = false))

    // ── state holders ─────────────────────────────────────────────────────────────────────────

    @Test
    fun anUpdateTakesTheSurfaceItsKindAsks() {
        assertEquals(PolarisUpdateRoute.None, updateRoute(null))
        assertEquals(PolarisUpdateRoute.Window, updateRoute(PolarisUpdateUi("2.5.0")))
        assertEquals(PolarisUpdateRoute.Window, updateRoute(PolarisUpdateUi("2.5.0", critical = true)))
        assertEquals(PolarisUpdateRoute.Dialog, updateRoute(PolarisUpdateUi("2.5.0", mandatory = true)))
        assertEquals(PolarisUpdateRoute.Banner, updateRoute(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart)))
        assertEquals(PolarisUpdateRoute.Banner, updateRoute(PolarisUpdateUi(null, mandatory = true, kind = PolarisUpdateUi.Kind.Restart)))
    }

    @Test
    fun theSettingsWindowOpensOnAPaneAndClosesWithoutDone() {
        val state = PolarisSettingsWindowState()
        assertFalse(state.isOpen)
        assertNull(state.pane)
        state.open()
        assertEquals(PolarisSettingsPane.Account, state.pane)
        state.open(PolarisSettingsPane.Devices)
        assertEquals(PolarisSettingsPane.Devices, state.pane)
        state.close()
        assertFalse(state.isOpen)
    }

    @Test
    fun theTitleNamesThePane() {
        val copy = PolarisCopy()
        assertEquals("Account", settingsWindowTitle(PolarisSettingsPane.Account, copy, "en"))
        assertEquals(copy.devicesTitle, settingsWindowTitle(PolarisSettingsPane.Devices, copy, "en"))
    }

    @Test
    fun manageLicenseOpensTheAccountPane() {
        val state = PolarisKeyWindowState()
        state.manageLicense()
        assertEquals(PolarisSettingsPane.Account, state.settings.pane)
    }

    @Test
    fun signOutAsksFirst() {
        val state = PolarisKeyWindowState()
        var signedOut = 0
        state.requestSignOut()
        assertTrue(state.askingSignOut)
        state.cancelSignOut()
        assertFalse(state.askingSignOut)
        assertEquals(0, signedOut)
        state.requestSignOut()
        state.confirmSignOut { signedOut++ }
        assertFalse(state.askingSignOut)
        assertEquals(1, signedOut)
    }

    @Test
    fun aManualCheckOffersAnUpdateThePersonDismissedBefore() = runBlocking {
        val update = PolarisUpdateState()
        update.show(offered)
        update.dismiss()
        assertNull(update.offer.value)
        val state = PolarisKeyWindowState()
        state.checkForUpdates(update) { offered }
        assertEquals(PolarisCheckStatus.Offered, state.check)
        assertEquals("2.5.0", update.offer.value?.version)
    }

    @Test
    fun aManualCheckSaysUpToDateOrFailsPlainly() = runBlocking {
        val update = PolarisUpdateState()
        val state = PolarisKeyWindowState()
        state.checkForUpdates(update) { current }
        assertEquals(PolarisCheckStatus.UpToDate, state.check)
        state.dismissCheck()
        assertEquals(PolarisCheckStatus.Idle, state.check)
        state.checkForUpdates(update) { error("offline") }
        assertEquals(PolarisCheckStatus.Failed, state.check)
        assertNull(update.offer.value)
    }

    // ── the menu ───────────────────────────────────────────────────────────────────────────────

    @Test
    fun menuLabelsAreSentenceCaseExceptOnTheMac() {
        for (variant in listOf(PolarisPlatformVariant.Windows, PolarisPlatformVariant.Gnome)) {
            val labels = PolarisMenuLabels.of(variant, "en")
            assertEquals("Check for updates", labels.checkForUpdates)
            assertEquals("Manage license", labels.manageLicense)
            assertEquals("Sign out", labels.signOut)
        }
        val mac = PolarisMenuLabels.of(PolarisPlatformVariant.MacOS, "en")
        assertEquals("Check for Updates…", mac.checkForUpdates)
        assertEquals("Manage License…", mac.manageLicense)
        assertEquals("Sign Out…", mac.signOut)
    }

    // ── laid out offscreen ───────────────────────────────────────────────────────────────────────

    @Test
    fun theUpdateColumnIs440WideWithNoDialogChrome() = runDesktopComposeUiTest(width = 440, height = 700) {
        var later = 0
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisUpdateWindowContent(PolarisUpdateUi("2.5.0", currentVersion = "2.4.1"), onUpdate = {}, onLater = { later++ }, onSkip = {})
            }
        }
        waitForIdle()
        onRoot().assertWidthIsEqualTo(440.dp)
        onNodeWithText("Later").assertIsDisplayed()
        assertTrue(onAllNodesWithText("Done").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun theUpdateColumnReportsTheHeightItNeedsNotTheHeightTheWindowLeftIt() = runDesktopComposeUiTest(width = 440, height = 120) {
        // A viewport far shorter than the column: the old onSizeChanged saw the constrained height and never grew the window.
        var needed = 0.dp
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisUpdateWindowContent(PolarisUpdateUi("2.5.0", currentVersion = "2.4.1"), onUpdate = {}, onLater = {}, onSkip = {}) { needed = it }
            }
        }
        waitForIdle()
        assertTrue(needed > 160.dp, "the column needs $needed, more than the 120 dp it was given")
    }

    @Test
    fun aMandatoryUpdateColumnOffersNoLaterAndNoSkip() = runDesktopComposeUiTest(width = 440, height = 700) {
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisUpdateWindowContent(PolarisUpdateUi("2.5.0", mandatory = true), onUpdate = {}, onLater = {}, onSkip = {})
            }
        }
        waitForIdle()
        assertTrue(onAllNodesWithText("Later").fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("Skip this version").fetchSemanticsNodes().isEmpty())
    }

    private fun scope() = CoroutineScope(Dispatchers.Unconfined)

    private val settingsActions = object : PolarisSettingsActions {
        override suspend fun license() = PolarisLicenseSummary(LicenseStatus.ok, holder = "Ada")
        override suspend fun entries() = emptyList<PolarisSettingEntry>()
        override suspend fun set(key: String, value: JsonElement) {}
        override suspend fun reset(key: String) {}
    }

    private val devicesActions = object : PolarisDevicesActions {
        override suspend fun list() = emptyList<im.plrs.key.sdk.DeviceInfo>()
        override suspend fun rename(deviceId: String, label: String?) {}
        override suspend fun deauthorize(deviceId: String) {}
    }

    @Test
    fun theSettingsWindowIs650WideWithPanesAndSignOutOnlyInAccount() = runDesktopComposeUiTest(width = 650, height = 600) {
        var signOut = 0
        var pane = PolarisSettingsPane.Account
        setContent {
            val settings = androidx.compose.runtime.remember { PolarisSettingsState(settingsActions, scope()) }
            val devices = androidx.compose.runtime.remember { PolarisDevicesState(devicesActions, scope()) }
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisSettingsWindowContent(pane, { pane = it }, settings, devices, onSignOut = { signOut++ })
            }
        }
        waitForIdle()
        onRoot().assertWidthIsEqualTo(650.dp)
        onNodeWithText("Account").assertIsDisplayed()
        onNodeWithText(PolarisCopy().devicesTitle).assertIsDisplayed()
        onNodeWithText("Sign out").assertIsDisplayed()
        assertTrue(onAllNodesWithText("Done").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun theDevicesPaneHasNoSignOut() = runDesktopComposeUiTest(width = 650, height = 600) {
        setContent {
            val settings = androidx.compose.runtime.remember { PolarisSettingsState(settingsActions, scope()) }
            val devices = androidx.compose.runtime.remember { PolarisDevicesState(devicesActions, scope()) }
            PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                PolarisSettingsWindowContent(PolarisSettingsPane.Devices, {}, settings, devices, onSignOut = {})
            }
        }
        waitForIdle()
        assertTrue(onAllNodesWithText("Sign out").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun theMacSheetSitsFiftyTwoDownUnderFullSizeContentAndTwelveInAPlainFrame() = runDesktopComposeUiTest(width = 600, height = 600) {
        force("MacOS")
        var plain = Dp.Unspecified
        var full = Dp.Unspecified
        setContent {
            plain = polarisMacSheetTop()
            CompositionLocalProvider(LocalPolarisMacFullSizeContent provides true) { full = polarisMacSheetTop() }
        }
        waitForIdle()
        assertEquals(12.dp, plain)
        assertEquals(52.dp, full)
        assertEquals(480, MacWindowMinimum.width)
        assertEquals(520, MacWindowMinimum.height)
    }
}
