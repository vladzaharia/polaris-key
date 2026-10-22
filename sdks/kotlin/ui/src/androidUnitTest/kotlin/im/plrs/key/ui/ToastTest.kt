// @pkey-feature ui.kit
// UI-KITS.md 4.1 Toast: one line plus a consequence, at most two actions, six seconds, errors
// persist (a toast is never the only record of an error), a progress toast waits to be answered, and
// on a phone it spans the bottom of the window.

package im.plrs.key.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
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
class ToastTest {
    @get:Rule
    val rule = createComposeRule()

    private var dismissed = 0

    private fun show(kind: PolarisToastKind, progress: Float? = null, actions: List<PolarisToastAction> = emptyList(), detail: String? = null) {
        // The clock is ours: the six seconds pass only when the test says so.
        rule.mainClock.autoAdvance = false
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                    androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.BottomCenter) {
                        PolarisToast("Diceroll 2.5.0 is available", kind = kind, detail = detail, actions = actions, progress = progress, onDismiss = { dismissed++ })
                    }
                }
            }
        }
        rule.mainClock.advanceTimeByFrame()
    }

    @Test
    fun anInfoToastClosesAfterSixSeconds() {
        show(PolarisToastKind.Info)
        rule.onNodeWithText("Diceroll 2.5.0 is available").assertIsDisplayed()
        rule.mainClock.advanceTimeBy(5_900)
        assertEquals(0, dismissed)
        rule.mainClock.advanceTimeBy(300)
        assertEquals(1, dismissed)
    }

    @Test
    fun anErrorToastPersists() {
        show(PolarisToastKind.Error)
        rule.mainClock.advanceTimeBy(30_000)
        assertEquals(0, dismissed)
        rule.onNodeWithText("Diceroll 2.5.0 is available").assertIsDisplayed()
    }

    @Test
    fun aProgressToastWaitsToBeAnswered() {
        show(PolarisToastKind.Info, progress = 0.4f)
        rule.mainClock.advanceTimeBy(30_000)
        assertEquals(0, dismissed)
    }

    @Test
    fun atMostTwoActionsAreDrawnAndEachActs() {
        val taken = mutableListOf<String>()
        show(
            PolarisToastKind.Info,
            actions = listOf("Undo", "View", "Third").map { label -> PolarisToastAction(label) { taken += label } },
            detail = "It installs next time you open the app.",
        )
        rule.onNodeWithText("It installs next time you open the app.").assertIsDisplayed()
        rule.onNodeWithText("Third").assertDoesNotExist()
        rule.onNodeWithText("Undo").performClick()
        rule.onNodeWithText("View").performClick()
        assertEquals(listOf("Undo", "View"), taken)
    }

    @Test
    fun onAPhoneItSpansTheBottomInsideAMargin() {
        show(PolarisToastKind.Info)
        val bounds = rule.onNodeWithText("Diceroll 2.5.0 is available").getUnclippedBoundsInRoot()
        assertTrue("text starts inside a 16 dp margin and the icon: ${bounds.left}", bounds.left >= 16.dp)
        assertTrue("near the bottom edge: ${bounds.bottom}", bounds.bottom > 891.dp - 120.dp)
    }
}
