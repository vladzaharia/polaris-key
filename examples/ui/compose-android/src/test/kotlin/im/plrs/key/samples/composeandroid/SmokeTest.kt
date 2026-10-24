// @pkey-feature ui.kit
// The sample's smoke test (UK-09b.2): on the fixtures the activity reaches the kit's gate, and an activated
// start reaches the product's own screen. Runs in Robolectric; nothing opens a socket.

package im.plrs.key.samples.composeandroid

import android.content.Intent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class SmokeTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private fun launch(state: String?): ActivityScenario<MainActivity> {
        val intent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
        state?.let { intent.putExtra(Options.STATE, it) }
        return ActivityScenario.launch(intent)
    }

    private fun waitForText(text: String) =
        rule.waitUntil(timeoutMillis = 30_000) { rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun aPlainLaunchReachesTheGate() {
        // Not activated: the kit's welcome offers a license key.
        launch(null).use { waitForText("Use a license key") }
    }

    @Test
    fun anActivatedStartReachesTheProductScreen() {
        launch("gate").use { waitForText("Licensed. Open your account or check for updates.") }
    }
}

class OptionsTest {
    @Test
    fun defaultsAreTheWalkOnTheFixtures() {
        val o = Options()
        assertEquals(Start.Walk, o.start)
        assertTrue(!o.live && o.polaris && o.dark == null && o.accent == null)
    }

    @Test
    fun anAccentIsSixHexDigitsOnly() {
        assertEquals(Color(0xFF26847A), Options.parseAccent("#26847a"))
        assertNull(Options.parseAccent("teal"))
        assertNull(Options.parseAccent("#26847"))
    }

    @Test
    fun startsAreNamedByTheirWireValue() {
        assertEquals(Start.Progress, Start.of("progress"))
        assertNull(Start.of("nowhere"))
    }

    @Test
    fun keysParseAsPairs() {
        assertEquals(mapOf("k1" to "abc", "k2" to "def"), parseKeys("k1=abc, k2=def,bad"))
    }
}
