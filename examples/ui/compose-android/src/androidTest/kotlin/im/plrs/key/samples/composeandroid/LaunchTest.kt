// @pkey-feature ui.kit
// The sample's launch smoke on a real device or emulator (UK-09b.9a): the activity starts (no crash in the
// fixtures' signer, which Robolectric cannot show) and the kit's gate is on screen.
//
//   ./gradlew :sample-compose-android:connectedDirectDebugAndroidTest

package im.plrs.key.samples.composeandroid

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LaunchTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun aPlainLaunchShowsTheGate() {
        rule.waitUntil(timeoutMillis = 30_000) { rule.onAllNodesWithText("Use a license key").fetchSemanticsNodes().isNotEmpty() }
    }
}
