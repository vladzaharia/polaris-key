// @pkey-feature ui.update
// UI-KITS.md 4.3 UpdatePrompt and DL2. One dismissal and the verb, with no X: the banner offers Later
// beside Update (or Restart now), and a mandatory update has no dismissal at all. The prompt is a
// bottom sheet below 560 dp and a card from there up, over the host.

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class UpdateSurfacesTest {
    @get:Rule
    val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val copy = sampleCopy

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setContent { StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) { content() } } }
        rule.waitForIdle()
    }

    @Test
    fun theBannerOffersLaterAndNoX() {
        var later = 0
        show { PolarisUpdateBanner(PolarisUpdateUi("2.5.0"), onDismiss = { later++ }) }
        rule.onNodeWithContentDescription(copy.updateDismiss).assertDoesNotExist()
        rule.onNodeWithText(copy.updateAction).assertIsDisplayed()
        rule.onNodeWithText(copy.updateLater).performClick()
        assertEquals(1, later)
    }

    @Test
    fun aMandatoryBannerHasNoDismissal() {
        show { PolarisUpdateBanner(PolarisUpdateUi("2.5.0", mandatory = true), onDismiss = {}) }
        rule.onNodeWithText(copy.updateLater).assertDoesNotExist()
        rule.onNodeWithText(copy.updateAction).assertIsDisplayed()
    }

    @Test
    fun aReadyUpdateBannerRestartsNow() {
        show { PolarisUpdateBanner(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart), onDismiss = {}) }
        rule.onNodeWithText(copy.updateRestartNow).assertIsDisplayed()
    }

    @Test
    fun aRestartWithNoVersionHasItsOwnLine() {
        show { PolarisUpdateBanner(PolarisUpdateUi(null, kind = PolarisUpdateUi.Kind.Restart), onDismiss = {}) }
        rule.onNodeWithText("An update is ready. Restart to finish.").assertIsDisplayed()
    }

    @Test
    fun theBannerClearsTheStatusBar() {
        val bar = 48
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisUpdateBanner(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart), onDismiss = {})
                }
            }
        }
        rule.runOnUiThread {
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(rule.activity.window, false)
        }
        rule.waitForIdle()
        val line = copy.updateBannerText(PolarisUpdateUi("2.5.0", kind = PolarisUpdateUi.Kind.Restart))
        val before = rule.onNodeWithText(line).getUnclippedBoundsInRoot().top
        rule.runOnUiThread {
            val density = rule.activity.resources.displayMetrics.density
            val px = (bar * density).toInt()
            val insets = androidx.core.view.WindowInsetsCompat.Builder()
                .setInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars(), androidx.core.graphics.Insets.of(0, px, 0, 0))
                .build()
            androidx.core.view.ViewCompat.dispatchApplyWindowInsets(rule.activity.window.decorView, insets)
        }
        rule.waitForIdle()
        val after = rule.onNodeWithText(line).getUnclippedBoundsInRoot().top
        assertTrue("the text moves down by the bar: $before -> $after", after - before >= bar.dp - 1.dp)
    }

    @Test
    fun belowFiveSixtyTheOptionalPromptIsABottomSheetThatLaterDismisses() {
        var later = 0
        show { PolarisUpdatePromptDialog(PolarisUpdateUi("2.5.0"), onUpdate = {}, onLater = { later++ }) }
        val update = rule.onNodeWithText(copy.updateNow).getUnclippedBoundsInRoot()
        assertTrue("the sheet sits in the lower half: ${update.top}", update.top > 891.dp / 2)
        rule.onNodeWithText(copy.updateLater).performClick()
        assertEquals(1, later)
    }

    @Test
    fun whileTheDownloadRunsTheBarCountsBytesAndTheRestartIsQueued() {
        var restarts = 0
        show {
            PolarisUpdatePrompt(PolarisUpdateUi("2.5.0", progress = 38_000_000L to 61_000_000L), onUpdate = { restarts++ }, onLater = {})
        }
        rule.onNodeWithText("Downloading · 38 MB of 61 MB").assertIsDisplayed()
        rule.onNodeWithText(copy.updateNow).assertDoesNotExist()
        rule.onNodeWithText(copy.updateRestartWhenReady).assertIsDisplayed().performClick()
        assertEquals(1, restarts)
        rule.onNodeWithText(copy.updateLater).assertIsDisplayed()
    }

    @Test
    fun theOfferedPromptSaysWhatYouHaveWhatIsNewAndWhereTheVerbGoes() {
        var skipped = 0
        val ui = PolarisUpdateUi(
            "2.5.0",
            currentVersion = "2.4.1",
            size = 61_000_000L,
            notes = listOf("Faster sync", "Fixes a crash on resume"),
            notesUrl = "https://example.com/r/2.5.0",
            outlet = "play",
        )
        show { PolarisUpdatePromptDialog(ui, onUpdate = {}, onLater = {}, onSkip = { skipped++ }) }
        rule.onNodeWithText("You have 2.4.1 · 61 MB download").assertIsDisplayed()
        rule.onNodeWithText(copy.updateWhatsNew).assertIsDisplayed()
        rule.onNodeWithText("Faster sync").assertIsDisplayed()
        rule.onNodeWithText("All changes in 2.5.0").assertIsDisplayed()
        rule.onNodeWithText(copy.updateGooglePlay).assertIsDisplayed()
        rule.onNodeWithText(copy.updateNow).assertDoesNotExist()
        rule.onNodeWithText(copy.updateSkip).performClick()
        assertEquals(1, skipped)
    }

    @Test
    fun noNotesHidesTheWhatsNewLabelAndNoSizeDropsTheDownload() {
        show { PolarisUpdatePromptDialog(PolarisUpdateUi("2.5.0", currentVersion = "2.4.1"), onUpdate = {}, onLater = {}) }
        rule.onNodeWithText("You have 2.4.1").assertIsDisplayed()
        rule.onNodeWithText(copy.updateWhatsNew).assertDoesNotExist()
        rule.onNodeWithText(copy.updateSkip).assertDoesNotExist()
    }

    @Test
    fun whileDownloadingItSaysHowLongIsLeft() {
        show {
            PolarisUpdatePrompt(PolarisUpdateUi("2.5.0", progress = 38_000_000L to 61_000_000L, secondsLeft = 20), onUpdate = {}, onLater = {})
        }
        rule.onNodeWithText(copy.updateTimeLessThanMinute).assertIsDisplayed()
    }
}
