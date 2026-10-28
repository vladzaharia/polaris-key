// @pkey-feature ui.kit
// UK-09b.3: a deep link reaches a kit screen only through PolarisKeyLinks. tidewater://polaris/account opens the
// Account screen behind the gate; a foreign or unknown link opens nothing and says so. Robolectric; no socket.

package im.plrs.key.samples.composeandroid

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.ui.PolarisUpdateState
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class NavigationTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private fun launch(uri: String?): ActivityScenario<MainActivity> {
        val intent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java).putExtra(Options.STATE, "gate")
        uri?.let { intent.action = Intent.ACTION_VIEW; intent.data = Uri.parse(it) }
        return ActivityScenario.launch(intent)
    }

    private fun shown(text: String) = rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun waitForText(text: String) = rule.waitUntil(timeoutMillis = 30_000) { shown(text) }

    @Test
    fun aDeepLinkOpensTheAccountScreen() {
        // The Account screen's title; the home screen has no such text. (The Settings row is drawn only
        // when the settings pane has content, UK-09 K-3, so it is not a marker of the screen.)
        launch("tidewater://polaris/account").use {
            waitForText("Account and license")
            assertTrue(!shown("Licensed. Open your account or check for updates."))
        }
    }

    @Test
    fun aQueryLinkOpensTheDevicesScreen() {
        launch("tidewater://polaris?route=devices").use {
            // The Devices screen on its own; the Account list would also show its title.
            waitForText("Your devices")
            assertTrue(!shown("Account and license"))
        }
    }

    @Test
    fun aForeignLinkOpensNothingAndSaysSo() {
        launch("https://evil.example/account").use {
            waitForText("That link doesn't open anything here.")
            assertTrue(shown("Licensed. Open your account or check for updates."))
        }
    }

    @Test
    fun anUnknownRouteOpensNothingAndSaysSo() {
        launch("tidewater://polaris/admin").use { waitForText("That link doesn't open anything here.") }
    }

    @Test
    fun aPlainLaunchShowsHome() {
        launch(null).use { waitForText("Licensed. Open your account or check for updates.") }
    }

    @Test
    fun checkingAgainAfterLaterOffersTheUpdateAgain() {
        val world = Tidewater(Start.Gate)
        val update = PolarisUpdateState()
        assertTrue(world.offerUpdate(update))
        update.dismiss()
        assertEquals(null, update.offer.value)
        assertTrue(world.offerUpdate(update))
        assertNotNull(update.offer.value)
    }

    @Test
    fun restartNowEndsTheFakeUpdate() {
        val installer = FixtureInstaller()
        assertEquals(InstallResult.Started, runBlocking { installer.finish() })
        assertEquals(InstallStage.Idle, installer.progress.value)
    }
}
