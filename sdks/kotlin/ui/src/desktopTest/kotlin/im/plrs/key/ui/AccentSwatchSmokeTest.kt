// UK-10.1: the desktop target compiles and renders. One Compose desktop test draws the accent
// swatches the resolver produces; the Roborazzi capture goes to src/desktopTest/snapshots when a
// run records (UK-10.12 commits the set).
package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.PolarisAccent
import kotlin.test.Test

class AccentSwatchSmokeTest {
    private fun color(hex: String) = Color(hex.removePrefix("#").toLong(16) or 0xFF000000)

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun rendersTheAccentSwatches() = runDesktopComposeUiTest(width = 320, height = 80) {
        val r = PolarisAccent.resolve("#3b82f6", dark = false)!!
        setContent {
            Row(Modifier.testTag("swatches")) {
                listOf(r.solid, r.on, r.fg, r.subtle, r.focus).forEach {
                    Box(Modifier.size(48.dp).background(color(it)))
                }
            }
        }
        onNodeWithTag("swatches").assertExists()
        val image = captureToImage()
        check(image.width == 320 && image.height == 80) { "unexpected size ${image.width}x${image.height}" }
    }
}
