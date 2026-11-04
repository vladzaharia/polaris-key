// @pkey-feature identity.link
package im.plrs.key.ui

import androidx.activity.ComponentActivity
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
class LinkConflictBackTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun backOnAConflictIsDone() {
        val calls = mutableListOf<String>()
        rule.setContent {
            StockHost(false) {
                PolarisTheme(copy = sampleCopy, darkTheme = false) {
                    PolarisSignInScreen(
                        PolarisSignInUi.LinkConflict("Google"),
                        onCancel = { calls += "cancel" },
                        steps = PolarisSignInSteps(onLinkFinished = { calls += "finished" }),
                    )
                }
            }
        }
        rule.waitForIdle()
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertEquals(listOf("finished"), calls)
    }
}
