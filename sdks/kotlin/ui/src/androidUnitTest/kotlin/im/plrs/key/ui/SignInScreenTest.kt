// @pkey-feature ui.kit
// The sign-in code view's behaviour, beyond the pictures:
//   - the QR code is a TV affordance: off by default on a phone, on when asked (Android TV's
//     default; TvSnapshotTest renders it in the television UI mode);
//   - the copy button hands over the pre-filled link (not the typed address) and says so;
//   - the code is set with no letter spacing (UI-KITS.md §4.3: never "W D J B").

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.sp
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
class SignInScreenTest {
    @get:Rule
    val rule = createComposeRule()

    private var screen by mutableStateOf<@Composable () -> Unit>({})

    private fun show(content: @Composable () -> Unit) {
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { screen() } } }
        rule.runOnIdle { screen = content }
        rule.waitForIdle()
    }

    private fun qrCodes(): Int =
        rule.onAllNodes(hasContentDescription(sampleCopy.signInQrDescription), useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun theQrCodeIsForTvOnly() {
        var showQr by mutableStateOf<Boolean?>(null)
        show {
            val ui = PolarisSignInUi.Showing(samplePrompt, NOW)
            val qr = showQr
            if (qr == null) PolarisSignInScreen(ui) else PolarisSignInScreen(ui, showQr = qr)
        }
        assertEquals("a phone shows no QR code", 0, qrCodes())
        rule.runOnIdle { showQr = true }
        rule.waitForIdle()
        assertEquals("asked (Android TV's default), the QR code shows", 1, qrCodes())
    }

    @Test
    fun copyHandsOverThePrefilledLink() {
        val copied = mutableListOf<String>()
        show { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), onCopyLink = { copied += it }) }
        rule.onNodeWithContentDescription(sampleCopy.signInCopyLink).performClick()
        rule.waitForIdle()
        assertEquals(listOf(samplePrompt.verificationUriComplete), copied)
        rule.onNodeWithContentDescription(sampleCopy.signInLinkCopied).assertExists()
        // Two seconds on, the button reads "Copy link" again.
        rule.mainClock.advanceTimeBy(2_500)
        rule.waitForIdle()
        rule.onNodeWithContentDescription(sampleCopy.signInCopyLink).assertExists()
    }

    @Test
    fun theCodeIsNeverLetterSpaced() {
        show { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW)) }
        val node = rule.onAllNodes(hasText(samplePrompt.userCode), useUnmergedTree = true).fetchSemanticsNodes().first()
        val results = mutableListOf<TextLayoutResult>()
        node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(results)
        val style = results.first().layoutInput.style
        assertEquals(0.sp, style.letterSpacing)
        assertTrue("the code is one line: ${results.first().lineCount}", results.first().lineCount == 1)
    }
}
