// @pkey-feature identity.link
// System Back on the link steps: the offer closes without a decline, the two results are Done, and none of them
// ends the sign-in as a cancel (the person is signed in).

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class LinkBackTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val calls = mutableListOf<String>()

    private fun backOn(ui: PolarisSignInUi): List<String> {
        val steps = PolarisSignInSteps(
            onLinkClose = { calls += "close" },
            onLinkFinished = { calls += "finished" },
            onLinkDecline = { calls += "decline" },
        )
        rule.setContent {
            StockHost(false) {
                PolarisTheme(copy = sampleCopy, darkTheme = false) { show(ui, steps) }
            }
        }
        rule.waitForIdle()
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        return calls.toList()
    }

    @Composable
    private fun show(ui: PolarisSignInUi, steps: PolarisSignInSteps) = PolarisSignInScreen(ui, onCancel = { calls += "cancel" }, steps = steps)

    @Test
    fun backOnTheOfferClosesItWithoutADecline() {
        assertEquals(listOf("close"), backOn(PolarisSignInUi.LinkOffer("Google", "global")))
    }

    @Test
    fun theLinkedStepIsBuiltFreshAndBackStillFinishesIt() {
        var ui by androidx.compose.runtime.mutableStateOf<PolarisSignInUi>(PolarisSignInUi.LinkOffer("Google", "global"))
        val steps = PolarisSignInSteps(onLinkClose = { calls += "close" }, onLinkFinished = { calls += "finished" })
        rule.setContent {
            StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { show(ui, steps) } }
        }
        rule.waitForIdle()
        rule.runOnIdle { ui = PolarisSignInUi.LinkDone("Google") }
        rule.waitForIdle()
        // The step after the round trip answers Back as Done, not as the offer's close.
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertEquals(listOf("finished"), calls.toList())
    }

    @Test
    fun backOnLinkedIsDone() {
        assertEquals(listOf("finished"), backOn(PolarisSignInUi.LinkDone("Google")))
    }
}
