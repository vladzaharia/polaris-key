// @pkey-feature ui.kit
//
// UK-10.5/.6 fix round: the PUBLIC PolarisUpdatePromptDialog dims its host exactly once. CMP 1.8.2's
// desktop Dialog draws its own black 60 % scrim; the Windows smoke and the GNOME scrim are the
// chrome's, so the dialog window's own is turned off and the corner pixel shows only the token's dim.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class DialogDimTest {
    private val host = Color(0xFFFFFFFF) // polaris-lint: allow-colour (a white probe ground, so the dim reads directly)

    private fun cornerOver(variant: String, dark: Boolean, token: Float, scrimOf: (androidx.compose.material3.ColorScheme) -> Color) = withPlatform(variant) {
        var expected = Color.Unspecified
        var actual = Color.Unspecified
        runDesktopComposeUiTest(width = 900, height = 600) {
            setContent {
                PolarisTheme(darkTheme = dark, copy = PolarisCopy(productName = "Tidewater Studio")) {
                    expected = scrimOf(MaterialTheme.colorScheme).copy(alpha = token).compositeOver(host)
                    Box(Modifier.fillMaxSize().background(host)) {
                        PolarisUpdatePromptDialog(
                            PolarisUpdateUi(version = "2.5", currentVersion = "2.4.1", size = 61_000_000, notes = listOf("Stem export")),
                            onUpdate = {}, onLater = {}, onSkip = {},
                        )
                    }
                }
            }
            waitForIdle()
            mainClock.advanceTimeBy(800)
            waitForIdle()
            // The dialog is its own semantics root over the host's; the last root is the window as drawn.
            val roots = onAllNodes(isRoot())
            actual = roots[roots.fetchSemanticsNodes().size - 1].captureToImage().toPixelMap()[4, 4]
        }
        Pair(expected, actual)
    }

    private fun assertDim(what: String, got: Pair<Color, Color>) {
        val (expected, actual) = got
        val off = maxOf(abs(expected.red - actual.red), abs(expected.green - actual.green), abs(expected.blue - actual.blue)) * 255
        assertTrue(off <= 3f, "$what: the corner is $actual, the token's single dim is $expected (a stacked scrim would be far darker)")
    }

    @Test
    fun windowsDimsOnceAtTheSmokeToken() {
        for (dark in listOf(true, false)) {
            assertDim("windows dark=$dark", cornerOver("Windows", dark, PolarisFluent.smokeAlpha(dark)) { it.scrim })
        }
    }

    @Test
    fun gnomeDimsOnceAtTheScrimToken() {
        for (dark in listOf(true, false)) {
            assertDim("gnome dark=$dark", cornerOver("Gnome", dark, PolarisGnome.scrimAlpha(dark)) { Color.Black }) // polaris-lint: allow-colour (the GNOME dim is black)
        }
    }
}
