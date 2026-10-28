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
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.center
import androidx.compose.ui.test.moveTo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.test.hasText
import androidx.compose.ui.text.font.FontWeight
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

    // ── UX fix round (UK-10.5-r2) ─────────────────────────────────────────────────────────────────

    private fun contrastRatio(a: Color, b: Color): Double {
        val l1 = a.luminance().toDouble()
        val l2 = b.luminance().toDouble()
        return (maxOf(l1, l2) + 0.05) / (minOf(l1, l2) + 0.05)
    }

    @Test
    fun theTextBoxRestStrokeHolds3To1AndFocusIsA2DpAccentLine() {
        for (dark in listOf(false, true)) for (branding in listOf(PolarisBranding.PolarisKey, PolarisBranding.None)) {
            runDesktopComposeUiTest(width = 300, height = 140) {
                setContent {
                    PolarisTheme(branding = branding, darkTheme = dark, accent = Color(0xFF26847A), copy = PolarisCopy(productName = "Diceroll")) {
                        CompositionLocalProvider(LocalPolarisWindow provides windowOf(PolarisPlatformVariant.Windows), LocalPolarisInitialFocus provides false) {
                            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp)) {
                                PolarisTextField("", {}, "License key")
                            }
                        }
                    }
                }
                waitForIdle()
                val box = onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot
                val px = onNode(isRoot()).captureToImage().toPixelMap()
                val x = (box.left + box.width / 2).toInt()
                val rest = px[x, box.bottom.toInt() - 1]
                val fill = px[x, box.top.toInt() + 8]
                val ratio = contrastRatio(rest, fill)
                assertTrue(ratio >= 3.0, "rest stroke $ratio:1 on the field ($branding, dark=$dark)")
                // The box holds the stroke for its whole width, not a corner.
                assertEquals(rest.toArgb(), px[box.left.toInt() + 10, box.bottom.toInt() - 1].toArgb())
            }
        }
    }

    @Test
    fun aFocusedTextBoxDrawsATwoDpAccentFoot() = runDesktopComposeUiTest(width = 300, height = 140) {
        val requester = FocusRequester()
        setContent {
            Themed(PolarisPlatformVariant.Windows) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp)) {
                    PolarisTextField("", {}, "License key", focusRequester = requester)
                }
            }
        }
        waitForIdle()
        runOnIdle { requester.requestFocus() }
        waitForIdle()
        val box = onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot
        val px = onNode(isRoot()).captureToImage().toPixelMap()
        val x = (box.left + box.width / 2).toInt()
        val a = px[x, box.bottom.toInt() - 1]
        val b = px[x, box.bottom.toInt() - 2]
        assertEquals(a.toArgb(), b.toArgb(), "two rows of the same line")
        assertNotEquals(px[x, box.bottom.toInt() - 3].toArgb(), a.toArgb())
    }

    @Composable
    private fun DialogWithOutsideFocusable(ui: PolarisUpdateUi, onLater: () -> Unit) {
        Themed(PolarisPlatformVariant.Windows, dark = true) {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                Box(Modifier.size(40.dp).testTag("outside").focusable())
                PolarisUpdatePromptHosted(ui, onUpdate = {}, onLater = onLater, onSkip = {})
            }
        }
    }

    private fun androidx.compose.ui.test.ComposeUiTest.focusedText(): String? =
        onAllNodes(isFocused()).fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString { it.text }

    @Test
    fun theContentDialogFocusesThePrimaryEscapeIsLaterAndTabStaysInside() = runDesktopComposeUiTest(width = 900, height = 600) {
        var laters = 0
        setContent { DialogWithOutsideFocusable(PolarisUpdateUi("2.5.0", currentVersion = "2.4.1"), onLater = { laters++ }) }
        waitForIdle()
        mainClock.advanceTimeBy(500)
        waitForIdle()
        val primary = copyOf { updateVerb(PolarisUpdateUi("2.5.0")) }
        assertEquals(primary, focusedText(), "initial focus is on the primary")
        // Tab wraps over the two buttons and never reaches the page behind.
        val seen = mutableListOf<String?>()
        repeat(5) {
            onRoot().performKeyInput { pressKey(Key.Tab) }
            waitForIdle()
            seen += focusedText()
        }
        onNodeWithTag("outside").assertIsNotFocused()
        assertTrue(seen.all { it != null }, "focus stays on a dialog button: $seen")
        val later = copyOf { updateLater }
        val skip = copyOf { updateSkip }
        assertEquals(listOf<String?>(later, skip, primary, later, skip), seen)
        // Shift+Tab from the first (four presses from Skip: Later, Update, the scrolling body, then round) wraps to the last.
        repeat(4) {
            onRoot().performKeyInput { keyDown(Key.ShiftLeft); pressKey(Key.Tab); keyUp(Key.ShiftLeft) }
            waitForIdle()
        }
        assertEquals(skip, focusedText(), "Shift+Tab wraps from the primary to the last")
        onNodeWithTag("outside").assertIsNotFocused()
        onRoot().performKeyInput { pressKey(Key.Escape) }
        waitForIdle()
        assertEquals(1, laters, "Escape is Later")
    }

    @Test
    fun escapeDoesNothingOnAMandatoryDialog() = runDesktopComposeUiTest(width = 900, height = 600) {
        var later = 0
        setContent { DialogWithOutsideFocusable(PolarisUpdateUi("2.5.0", mandatory = true), onLater = { later++ }) }
        waitForIdle()
        mainClock.advanceTimeBy(500)
        waitForIdle()
        onRoot().performKeyInput { pressKey(Key.Escape) }
        waitForIdle()
        assertEquals(0, later)
    }

    @Test
    fun aContrastThemeAppliesToEveryPreset() {
        for (branding in listOf(PolarisBranding.PolarisKey, PolarisBranding.None)) for (dark in listOf(false, true)) {
            runDesktopComposeUiTest(width = 300, height = 200) {
                lateinit var scheme: androidx.compose.material3.ColorScheme
                var link = Color.Unspecified
                var ring = Color.Unspecified
                setContent {
                    CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(dark = dark, highContrast = true, accent = 0xE91E63)) {
                        PolarisTheme(branding = branding, darkTheme = dark, accent = Color(0xFF26847A)) {
                            scheme = MaterialTheme.colorScheme
                            link = PolarisTheme.accentText
                            ring = PolarisTheme.focusColor
                        }
                    }
                }
                waitForIdle()
                val c = FluentSystemColors.forTheme(dark)
                assertEquals(c.window, scheme.background, "$branding dark=$dark")
                assertEquals(c.windowText, scheme.onSurface)
                assertEquals(c.highlight, scheme.primary)
                assertEquals(c.hotlight, link, "links are Hotlight")
                assertEquals(c.windowText, ring, "the ring is WindowText")
            }
        }
    }

    @Test
    fun theAllChangesLinkIsHotlightInAContrastTheme() {
        for (dark in listOf(false, true)) {
            runDesktopComposeUiTest(width = 400, height = 200) {
                setContent {
                    CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(dark = dark, highContrast = true)) {
                        PolarisTheme(branding = PolarisBranding.None, darkTheme = dark) {
                            CompositionLocalProvider(LocalPolarisWindow provides windowOf(PolarisPlatformVariant.Windows)) {
                                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                                    PolarisUpdateNotes(PolarisUpdateUi("2.5.0", notesUrl = "https://example.com/r/2.5.0"))
                                }
                            }
                        }
                    }
                }
                waitForIdle()
                val c = FluentSystemColors.forTheme(dark)
                val img = onNode(isRoot()).captureToImage().toPixelMap()
                var hot = 0
                var highlight = 0
                for (x in 0 until img.width) for (y in 0 until img.height) {
                    val px = img[x, y].toArgb()
                    if (px == c.hotlight.toArgb()) hot++
                    if (px == c.highlight.toArgb() && c.highlight != c.hotlight) highlight++
                }
                assertTrue(hot > 20, "dark=$dark: the link is drawn in Hotlight ($hot px)")
                assertEquals(0, highlight, "dark=$dark: not in the Highlight fill colour")
            }
        }
    }

    @Test
    fun aContrastButtonIsGrayTextWhenDisabledAndHighlightUnderThePointer() {
        for (dark in listOf(false, true)) {
            runDesktopComposeUiTest(width = 400, height = 200) {
                setContent {
                    CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(dark = dark, highContrast = true)) {
                        PolarisTheme(branding = PolarisBranding.None, darkTheme = dark) {
                            CompositionLocalProvider(LocalPolarisWindow provides windowOf(PolarisPlatformVariant.Windows), LocalPolarisInitialFocus provides false) {
                                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp)) {
                                    PolarisSecondaryButton("Hover me", onClick = {}, modifier = Modifier.testTag("hover"))
                                    PolarisSecondaryButton("Off", onClick = {}, enabled = false, modifier = Modifier.testTag("off"))
                                }
                            }
                        }
                    }
                }
                waitForIdle()
                val c = FluentSystemColors.forTheme(dark)
                val off = onNodeWithTag("off").fetchSemanticsNode().boundsInRoot
                val offPx = onNode(isRoot()).captureToImage().toPixelMap()
                assertEquals(c.grayText.toArgb(), offPx[off.left.toInt(), off.center.y.toInt()].toArgb(), "a disabled button's edge is GrayText")
                onNodeWithTag("hover").performMouseInput { moveTo(center) }
                waitForIdle()
                val hov = onNodeWithTag("hover").fetchSemanticsNode().boundsInRoot
                val hovPx = onNode(isRoot()).captureToImage().toPixelMap()
                assertEquals(c.highlight.toArgb(), hovPx[hov.left.toInt() + 4, hov.top.toInt() + 6].toArgb(), "hover fills with Highlight")
            }
        }
    }

    @Test
    fun theWindowsTypeTokensApplyOnBothPresets() {
        for (branding in listOf(PolarisBranding.PolarisKey, PolarisBranding.None)) {
            runDesktopComposeUiTest(width = 200, height = 100) {
                lateinit var t: androidx.compose.material3.Typography
                setContent {
                    PolarisTheme(branding = branding) {
                        CompositionLocalProvider(LocalPolarisWindow provides windowOf(PolarisPlatformVariant.Windows)) { t = MaterialTheme.typography }
                    }
                }
                waitForIdle()
                assertEquals(28.sp, t.displaySmall.fontSize, "$branding")
                assertEquals(36.sp, t.displaySmall.lineHeight)
                assertEquals(FontWeight(600), t.displaySmall.fontWeight)
                assertEquals(20.sp, t.titleLarge.fontSize)
                assertEquals(28.sp, t.titleLarge.lineHeight)
                assertEquals(14.sp, t.bodyMedium.fontSize)
                assertEquals(20.sp, t.bodyMedium.lineHeight)
                assertEquals(FontWeight(500), t.labelLarge.fontWeight)
                assertEquals(14.sp, t.labelLarge.fontSize)
                assertEquals(0.sp, t.labelLarge.letterSpacing)
            }
        }
    }

    @Test
    fun theExternalGlyphEndsTheLabel() = runDesktopComposeUiTest(width = 400, height = 160) {
        setContent {
            Themed(PolarisPlatformVariant.Windows) {
                // In an action row a button is as wide as its label.
                CompositionLocalProvider(LocalPolarisActionRow provides true) {
                    Column(Modifier.padding(20.dp)) {
                        PolarisPrimaryButton("Open the portal", onClick = {}, external = true)
                        PolarisPrimaryButton("Open the portal", onClick = {})
                    }
                }
            }
        }
        waitForIdle()
        val buttons = onAllNodes(isButton).fetchSemanticsNodes()
        val ext = buttons[0].boundsInRoot
        val plain = buttons[1].boundsInRoot
        // The glyph is part of the label's own text (N6: it ends the last line of a wrapped label), so it adds width.
        assertTrue(ext.width > plain.width, "the glyph adds its width: ${ext.width} vs ${plain.width}")
        // Assistive tech reads the plain label; the control says where it goes.
        assertEquals(2, onAllNodes(hasText("Open the portal") and isButton).fetchSemanticsNodes().size)
    }

    @Test
    fun theExternalGlyphStaysOnTheLastLineOfAWrappedLabel() = runDesktopComposeUiTest(width = 150, height = 200) {
        setContent {
            Themed(PolarisPlatformVariant.Windows) {
                Column(Modifier.padding(8.dp)) { PolarisSecondaryButton("Add it in Polaris Locker", onClick = {}, external = true) }
            }
        }
        waitForIdle()
        val node = onAllNodes(isButton).fetchSemanticsNodes().single()
        val results = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        node.config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult)?.action?.invoke(results)
        val layout = results.single()
        assertTrue(layout.lineCount >= 2, "the label wraps at this width")
        val last = layout.layoutInput.text.text.substring(layout.getLineStart(layout.lineCount - 1))
        assertTrue(last.trimEnd().endsWith("\u2197") && last.any { it.isLetter() }, "the glyph shares the last line with a word: '$last'")
        // Assistive tech reads the plain label: the glyph is decoration.
        assertEquals(1, onAllNodes(hasText("Add it in Polaris Locker") and isButton).fetchSemanticsNodes().size)
    }

    @Test
    fun theFocusRingCornersAreConcentric() = runDesktopComposeUiTest(width = 200, height = 120) {
        val requester = FocusRequester()
        setContent {
            Themed(PolarisPlatformVariant.Windows) {
                val interaction = remember { MutableInteractionSource() }
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceDim)) {
                    Box(
                        Modifier.padding(20.dp).size(60.dp, 32.dp)
                            .polarisFocusIndication(interaction, PolarisTheme.buttonShape)
                            .focusRequester(requester).focusable(interactionSource = interaction),
                    )
                }
            }
        }
        waitForIdle()
        runOnIdle { requester.requestFocus() }
        waitForIdle()
        val px = onNode(isRoot()).captureToImage().toPixelMap()
        val page = px[2, 2]
        // The control's corner is at (20,20); the outer line sits 3 dp out with a 7 dp radius, so the
        // diagonal pixel one past the outer line's curve is still page, where a square-cornered ring would draw.
        assertEquals(page.toArgb(), px[17, 17].toArgb(), "the outer line rounds at the corner (radius 4 + 3)")
        assertNotEquals(page.toArgb(), px[17, 28].toArgb(), "and runs straight down the side")
    }
}
