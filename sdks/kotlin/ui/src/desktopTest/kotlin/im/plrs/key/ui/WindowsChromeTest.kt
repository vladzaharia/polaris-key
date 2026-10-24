// @pkey-feature ui.kit
//
// UK-10.5: the Windows (Fluent) chrome. 32 dp controls at radius 4, overlays at radius 8, the
// ContentDialog's footer (equal width, primary first), the two-tone focus ring, the contrast
// themes' system colours, opaque surfaces; and Android keeps its own chrome.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.PolarisBrandTokens
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class WindowsChromeTest {
    private var old: String? = null

    @BeforeTest
    fun forceWindows() {
        old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
    }

    @AfterTest
    fun restore() {
        old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    }

    private fun windowOf(v: PolarisPlatformVariant, w: Int = 900, h: Int = 600) = PolarisWindow(w.dp, h.dp, variant = v)

    @Composable
    private fun Themed(variant: PolarisPlatformVariant, dark: Boolean = false, content: @Composable () -> Unit) {
        PolarisTheme(darkTheme = dark, copy = PolarisCopy(productName = "Diceroll")) {
            CompositionLocalProvider(LocalPolarisWindow provides windowOf(variant), content = content)
        }
    }

    private val isButton = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)

    @Test
    fun controlsAre32DpTallAtRadius4AndOverlaysRadius8() = runDesktopComposeUiTest(width = 600, height = 400) {
        var button: androidx.compose.ui.graphics.Shape? = null
        var field: androidx.compose.ui.graphics.Shape? = null
        var card: androidx.compose.ui.graphics.Shape? = null
        setContent {
            Themed(PolarisPlatformVariant.Windows) {
                button = PolarisTheme.buttonShape
                field = PolarisTheme.fieldShape
                card = PolarisTheme.cardShape
                Column(Modifier.padding(20.dp)) {
                    PolarisPrimaryButton("Primary", onClick = {})
                    PolarisSecondaryButton("Secondary", onClick = {})
                    PolarisTextButton("Link", onClick = {})
                    PolarisTextField("pkey_x", {}, "License key")
                }
            }
        }
        waitForIdle()
        assertEquals(RoundedCornerShape(4.dp), button)
        assertEquals(RoundedCornerShape(4.dp), field)
        assertEquals(RoundedCornerShape(8.dp), card)
        assertEquals(4.dp, PolarisFluent.controlRadius)
        assertEquals(8.dp, PolarisFluent.overlayRadius)
        val heights = onAllNodes(isButton).fetchSemanticsNodes().map { it.size.height }
        assertEquals(listOf(32, 32, 32), heights, "primary, secondary and link are 32 dp tall")
        assertEquals(32, onNode(hasSetTextAction()).fetchSemanticsNode().size.height, "the field box is 32 dp tall")
    }

    @Test
    fun androidKeepsItsOwnChrome() = runDesktopComposeUiTest(width = 600, height = 400) {
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Android")
        var button: androidx.compose.ui.graphics.Shape? = null
        setContent {
            Themed(PolarisPlatformVariant.Android) {
                button = PolarisTheme.buttonShape
                PolarisPrimaryButton("Primary", onClick = {})
            }
        }
        waitForIdle()
        assertEquals(CircleShape, button)
    }

    @Test
    fun theSheetIsAContentDialogWithEqualFootersPrimaryFirst() = runDesktopComposeUiTest(width = 900, height = 600) {
        setContent {
            Themed(PolarisPlatformVariant.Windows, dark = true) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    PolarisUpdatePromptHosted(
                        PolarisUpdateUi("2.5.0", currentVersion = "2.4.1", size = 61_000_000L, notes = listOf("Faster sync")),
                        onUpdate = {}, onLater = {}, onSkip = {},
                    )
                }
            }
        }
        waitForIdle()
        val buttons = onAllNodes(isButton).fetchSemanticsNodes().sortedBy { it.boundsInRoot.left }
        assertEquals(3, buttons.size)
        val widths = buttons.map { it.size.width }
        assertTrue(widths.all { kotlin.math.abs(it - widths.first()) <= 1 }, "equal width (to the pixel): $widths")
        assertTrue(buttons.map { it.size.height }.all { it == 32 })
        // The primary is first (leftmost) and the dialog is at most 480 dp wide, centred, over the smoke.
        val primary = copyOf { updateVerb(PolarisUpdateUi("2.5.0")) }
        val first = buttons.first().config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text }
        assertEquals(primary, first)
        val total = buttons.last().boundsInRoot.right - buttons.first().boundsInRoot.left
        assertTrue(total <= 480 - 48 + 1, "buttons fit the dialog body: $total")
        // Outside the dialog the page shows through the smoke: darker than the page itself.
        val corner = onNode(isRoot()).captureToImage().toPixelMap()[10, 10]
        assertNotEquals(PolarisBrandTokens.Dark.surfacePage, corner, "the smoke dims the window")
    }

    private fun copyOf(f: PolarisCopy.() -> String): String = PolarisCopy(productName = "Diceroll").f()

    @Test
    fun theFocusRingIsTwoTone() = runDesktopComposeUiTest(width = 200, height = 120) {
        val requester = FocusRequester()
        var outer = Color.Unspecified
        var inner = Color.Unspecified
        var page = Color.Unspecified
        setContent {
            Themed(PolarisPlatformVariant.Windows) {
                outer = MaterialTheme.colorScheme.onSurface
                inner = MaterialTheme.colorScheme.background
                page = MaterialTheme.colorScheme.surfaceDim
                val interaction = remember { MutableInteractionSource() }
                Box(Modifier.fillMaxSize().background(page)) {
                    Box(
                        Modifier
                            .padding(20.dp)
                            .size(60.dp, 32.dp)
                            .polarisFocusIndication(interaction, PolarisTheme.buttonShape)
                            .focusRequester(requester)
                            .focusable(interactionSource = interaction),
                    )
                }
            }
        }
        waitForIdle()
        runOnIdle { requester.requestFocus() }
        waitForIdle()
        val px = onNode(isRoot()).captureToImage().toPixelMap()
        // The control spans y 20..52, x 20..80. One pixel out is the inner line, the next two the outer.
        assertEquals(inner.toArgbInt(), px[50, 19].toArgbInt(), "inner line (1 dp) in the surface colour")
        assertEquals(outer.toArgbInt(), px[50, 18].toArgbInt(), "outer line (2 dp) in the text colour")
        assertEquals(outer.toArgbInt(), px[50, 17].toArgbInt())
        assertEquals(page.toArgbInt(), px[50, 16].toArgbInt(), "nothing beyond the 3 dp ring")
        assertEquals(inner.toArgbInt(), px[19, 36].toArgbInt(), "the same on the side")
        assertEquals(outer.toArgbInt(), px[17, 36].toArgbInt())
    }

    private fun Color.toArgbInt(): Int = this.toArgb()

    @Test
    fun aContrastThemeDrawsTheSystemColours() = runDesktopComposeUiTest(width = 300, height = 200) {
        lateinit var dark: androidx.compose.material3.ColorScheme
        lateinit var light: androidx.compose.material3.ColorScheme
        lateinit var normal: androidx.compose.material3.ColorScheme
        var focus: Color? = null
        setContent {
            CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(highContrast = true)) {
                PolarisTheme(darkTheme = true, accent = Color(0xFFE91E63)) {
                    dark = MaterialTheme.colorScheme
                    focus = PolarisTheme.focusColor
                }
            }
        }
        waitForIdle()
        val black = FluentSystemColors.Black
        assertEquals(black.window, dark.background)
        assertEquals(black.window, dark.surface)
        assertEquals(black.windowText, dark.onSurface)
        assertEquals(black.highlight, dark.primary)
        assertEquals(black.highlightText, dark.onPrimary)
        assertEquals(black.buttonFace, dark.secondaryContainer)
        assertEquals(black.windowText, focus, "the ring is WindowText, whatever the product accent")
        setContent {
            CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(highContrast = true)) {
                PolarisTheme(darkTheme = false) { light = MaterialTheme.colorScheme }
            }
        }
        waitForIdle()
        val white = FluentSystemColors.White
        assertEquals(white.window, light.background)
        assertEquals(white.windowText, light.onSurface)
        assertEquals(white.highlight, light.primary)
        setContent {
            CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(highContrast = false)) {
                PolarisTheme(darkTheme = true) { normal = MaterialTheme.colorScheme }
            }
        }
        waitForIdle()
        assertNotEquals(black.highlight, normal.primary, "normal contrast keeps the brand palette")
        assertEquals(PolarisBrandTokens.Dark.surfacePage, normal.background)
    }

    @Test
    fun surfacesAreOpaque() {
        // K5: no Mica. The dialog layer, its footer and the smoke base are scheme colours at full alpha.
        val s = polarisBrandColorScheme(dark = true)
        for (c in listOf(s.surfaceContainerLow, s.surfaceDim, s.background, s.scrim)) assertEquals(1f, c.alpha)
        assertTrue(PolarisFluent.smokeAlpha(true) in 0.2f..0.45f && PolarisFluent.smokeAlpha(false) in 0.2f..0.45f)
    }
}
