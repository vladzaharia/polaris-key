// @pkey-feature ui.kit
// The persistent product header (UI-KITS.md section 1.2) on every stop screen, and the boot's
// skeleton (DL7, DL16): the product's name beside its icon (the monogram without one) on the
// expired, boot, error, device-limit, declined and code-expired screens; the boot's loading state
// announces "Loading" and holds still under reduced motion.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.SemanticsMatcher
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
class ProductHeaderTest {
    @get:Rule
    val rule = createComposeRule()

    private var screen by mutableStateOf<@Composable () -> Unit>({})
    private var started = false

    private fun render(pause: Boolean = false, content: @Composable () -> Unit) {
        if (!started) {
            started = true
            rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { screen() } } }
        }
        rule.runOnIdle { screen = content }
        // The skeleton's shimmer never ends, so its clock is paused (and stepped) by hand.
        if (pause) {
            rule.mainClock.autoAdvance = false
            rule.mainClock.advanceTimeBy(600)
        } else {
            rule.waitForIdle()
        }
        
    }

    private fun headerCount() = rule.onAllNodesWithText("Diceroll").fetchSemanticsNodes().size

    @Test
    fun everyStopScreenCarriesTheProductHeader() {
        val names = listOf(
            "statusScreen-expired", "statusScreen-version-too-old", "statusScreen-version-too-new", "statusScreen-channel-not-entitled",
            "deviceLimit-browser-mode", "boot-consent", "boot-offline", "boot-blocked", "boot-error",
            "signInHandoff-starting", "sign-in-expired", "signInHandoff-denied", "signInHandoff-failed",
        )
        val screens = kitScreens.toMap()
        for (name in names) {
            render(content = screens.getValue(name))
            assertEquals("$name draws the product name once", 1, headerCount())
        }
        // Boot's loading state last: its shimmer pauses the clock.
        render(pause = true, content = screens.getValue("boot-progress"))
        assertEquals("boot-progress draws the product name once", 1, headerCount())
    }

    @Test
    fun bootLoadingAnnouncesLoadingAndHasNoStockSpinner() {
        render {
            CompositionLocalProvider(LocalPolarisReduceMotion provides true) {
                PolarisBootScreen(bootUi(im.plrs.key.core.BootStage.sync))
            }
        }
        val loading = rule.onAllNodes(SemanticsMatcher("announces Loading") {
            it.config.getOrNull(SemanticsProperties.ContentDescription)?.any { d -> d.startsWith(sampleCopy.loading) } == true
        }).fetchSemanticsNodes()
        assertEquals(1, loading.size)
        assertTrue(rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun reducedMotionHoldsTheSkeletonStill() {
        render(pause = false) {
            CompositionLocalProvider(LocalPolarisReduceMotion provides true) {
                PolarisBootSkeleton(sampleCopy.bootSyncing)
            }
        }
        assertEquals(1, headerCount())
    }
}
