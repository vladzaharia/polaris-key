// @pkey-feature ui.kit
//
// UK-10.5-7 integration: the sign-in address in the lede never breaks inside the host or a path
// segment, on any desktop chrome, at any narrow width: a line may end only after a '/'
// (or before the address starts).

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class SignInAddressTest {
    private val address = "polaris.locker/device"

    @Test
    fun theAddressBreaksOnlyAfterASlash() {
        for (variant in listOf("Windows", "Gnome", "MacOS")) withPlatform(variant) {
            for (width in listOf(150, 170, 190, 210, 240, 280, 320, 400)) {
                runDesktopComposeUiTest(width = 500, height = 400) {
                    setContent {
                        PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                            Box(Modifier.width(width.dp)) { PolarisLede("On any phone or computer, go to %1\$s and enter this code.", address) }
                        }
                    }
                    waitForIdle()
                    val node = onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.GetTextLayoutResult)).fetchSemanticsNode()
                    val results = mutableListOf<TextLayoutResult>()
                    node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
                    val layout = results.first()
                    val text = layout.layoutInput.text.text
                    if (width <= 210) assertTrue(layout.lineCount >= 3, "$variant at $width dp wraps (else the check proves nothing)")
                    val start = text.indexOf('p', text.indexOf("go to"))
                    val end = text.indexOf("and enter") - 1
                    for (line in 0 until layout.lineCount - 1) {
                        val cut = layout.getLineEnd(line)
                        if (cut in (start + 1)..(end - 1)) {
                            val before = text.substring(start, cut).trimEnd('\u2060')
                            assertTrue(before.endsWith("/"), "$variant at $width dp: a line ends inside the address after \"${before.takeLast(8)}\"")
                        }
                    }
                }
            }
        }
    }
}
