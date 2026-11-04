// @pkey-feature identity.link
// After a Link round trip the next step has the keyboard: Escape on "linked" is Done, and Enter presses it.

package im.plrs.key.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals

class LinkKeyboardTest {
    @OptIn(ExperimentalTestApi::class)
    private fun afterTheOffer(key: Key) {
        runDesktopComposeUiTest(width = 700, height = 700) {
            val calls = mutableListOf<String>()
            var ui by mutableStateOf<PolarisSignInUi>(PolarisSignInUi.LinkOffer("Google", "global"))
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSignInScreen(ui, steps = PolarisSignInSteps(onLinkFinished = { calls += "finished" }))
                }
            }
            waitForIdle()
            // Link was pressed and answered: the step changes under the person's hands.
            runOnIdle { ui = PolarisSignInUi.LinkDone("Google") }
            waitForIdle()
            onRoot().performKeyInput {
                keyDown(key)
                keyUp(key)
            }
            waitForIdle()
            assertEquals(listOf("finished"), calls)
        }
    }

    @Test
    fun escapeOnLinkedIsDone() = afterTheOffer(Key.Escape)

    @Test
    fun enterOnLinkedIsDone() = afterTheOffer(Key.Enter)
}
