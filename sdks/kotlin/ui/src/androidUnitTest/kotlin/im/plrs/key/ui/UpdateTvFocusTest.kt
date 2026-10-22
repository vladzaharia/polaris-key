// @pkey-feature ui.update
// UI-KITS.md DL9 and 4.3 UpdatePrompt: on a TV the prompt's first focus is Later, never Update now
// (which can open a store), and a press that arrives as the prompt opens is ignored for 250 ms.
// A phone keeps Update now as the initial focus; a mandatory update has no Later to land on.

package im.plrs.key.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w960dp-h540dp-television-mdpi")
class UpdateTvFocusTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    private fun show(ui: PolarisUpdateUi, onUpdate: () -> Unit = {}, onLater: () -> Unit = {}) {
        // The clock is ours: the 250 ms pass only when the test says so.
        rule.mainClock.autoAdvance = false
        rule.setContent {
            // A TV is never in touch mode: the D-pad is a keyboard to Compose, and only then can a button take focus.
            CompositionLocalProvider(LocalInputModeManager provides FixedInputMode(InputMode.Keyboard)) {
                StockHost(true) {
                    PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = true) {
                        // The prompt's card inside the kit surface, which reads the TV from the configuration.
                        PolarisScreen(showLogo = false) { PolarisUpdatePrompt(ui, onUpdate = onUpdate, onLater = onLater) }
                    }
                }
            }
        }
        rule.mainClock.advanceTimeBy(50)
    }

    @Test
    fun theFirstFocusIsLaterNotUpdateNow() {
        show(PolarisUpdateUi("2.5.0"))
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithText(copy.updateLater).assertIsFocused()
        rule.onNodeWithText(copy.updateNow).assertIsNotFocused()
    }

    @Test
    fun inputIsIgnoredForTwoHundredFiftyMillisecondsAfterItOpens() {
        var updates = 0
        var laters = 0
        show(PolarisUpdateUi("2.5.0"), onUpdate = { updates++ }, onLater = { laters++ })
        // Inside the window: neither verb acts.
        rule.onNodeWithText(copy.updateNow).performClick()
        rule.onNodeWithText(copy.updateLater).performClick()
        assertEquals(0, updates)
        assertEquals(0, laters)
        // After it: both do.
        rule.mainClock.advanceTimeBy(PolarisPromptInputDelayMs + 50)
        rule.onNodeWithText(copy.updateNow).performClick()
        rule.onNodeWithText(copy.updateLater).performClick()
        assertEquals(1, updates)
        assertEquals(1, laters)
    }

    @Test
    fun aMandatoryUpdateKeepsItsOneVerbFocused() {
        show(PolarisUpdateUi("2.5.0", mandatory = true))
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithText(copy.updateLater).assertDoesNotExist()
        rule.onNodeWithText(copy.updateNow).assertIsFocused()
    }
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class UpdatePhoneActsAtOnceTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun aPhoneHasNoInputDelay() {
        var updates = 0
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                    PolarisUpdatePromptDialog(PolarisUpdateUi("2.5.0"), onUpdate = { updates++ }, onLater = {})
                }
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText(sampleCopy.updateNow).performClick()
        assertEquals(1, updates)
    }
}
