// @pkey-feature ui.kit
//
// UK-10.7: the macOS chrome. Mac scale type (13 / 22 / 26) and 28 pt controls, the inset sheet (below
// the title-bar row, 440 wide, rounded on every side, no dimming), Cancel directly left of the
// default, the `macos` copy variants, Increase Contrast hairlines and the 480 x 520 floor; and the
// other variants keep their own chrome.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.click
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.BorderStroke
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class MacChromeTest {
    private var old: String? = null

    private fun force(name: String) = System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, name)

    @BeforeTest
    fun forceMac() {
        old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        force("MacOS")
    }

    @AfterTest
    fun restore() {
        old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    }

    private val isButton = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)

    private val update = PolarisUpdateUi("2.5.0", currentVersion = "2.4.1", size = 61_000_000L, outlet = "direct")

    @Test
    fun typeIsMacScale() = runDesktopComposeUiTest(width = 600, height = 400) {
        var body = 0f
        var label = 0f
        var title = 0f
        var hero = 0f
        setContent {
            PolarisTheme(darkTheme = false) {
                val t = MaterialTheme.typography
                body = t.bodyLarge.fontSize.value
                label = t.labelLarge.fontSize.value
                title = t.headlineSmall.fontSize.value
                hero = t.headlineLarge.fontSize.value
            }
        }
        waitForIdle()
        assertEquals(listOf(13f, 13f, 22f, 26f), listOf(body, label, title, hero))
    }

    @Test
    fun otherVariantsKeepTheirType() = runDesktopComposeUiTest(width = 600, height = 400) {
        force("Windows")
        var body = 0f
        setContent { PolarisTheme(darkTheme = false) { body = MaterialTheme.typography.bodyLarge.fontSize.value } }
        waitForIdle()
        assertNotEquals(13f, body)
    }

    @Test
    fun controlsAre28PtTall() = runDesktopComposeUiTest(width = 600, height = 400) {
        setContent {
            PolarisTheme(darkTheme = false) {
                CompositionLocalProvider(LocalPolarisWindow provides PolarisWindow(900.dp, 640.dp)) {
                    PolarisActionGroup(row = false) {
                        PolarisPrimaryButton("Continue", {})
                        PolarisSecondaryButton("Other", {})
                    }
                }
            }
        }
        waitForIdle()
        for (text in listOf("Continue", "Other")) {
            val bounds = onNodeWithText(text, useUnmergedTree = false).getBoundsInRoot()
            assertEquals(28.dp, bounds.bottom - bounds.top, text)
        }
    }

    @Composable
    private fun Behind(content: @Composable () -> Unit) {
        PolarisTheme(darkTheme = false) {
            Box(Modifier.fillMaxSize().background(PAGE)) { content() }
        }
    }

    @Test
    fun theSheetIsInsetRoundedAndDimsNothing() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent {
            Behind {
                CompositionLocalProvider(LocalPolarisMacFullSizeContent provides true) {
                    PolarisUpdatePromptHosted(update, onUpdate = {}, onLater = {}, onSkip = null)
                }
            }
        }
        waitForIdle()
        val b = onNodeWithTag("pkey-mac-sheet").getBoundsInRoot()
        assertEquals(52.dp, b.top, "below the title-bar row under a full-size content view")
        assertEquals(440.dp, b.right - b.left, "about 440 wide")
        assertEquals((900.dp - 440.dp) / 2, b.left, "centred")
        val px = onNode(isRoot()).captureToImage().toPixelMap()
        // Nothing is dimmed: the page far from the sheet is exactly the page.
        assertEquals(PAGE, px[8, 600])
        assertEquals(PAGE, px[890, 20])
        // Rounded on every side: the corner pixels are the page, the middle of each edge is the sheet.
        val left = b.left.value.toInt()
        val right = b.right.value.toInt() - 1
        val top = b.top.value.toInt()
        val bottom = b.bottom.value.toInt() - 1
        for ((x, y) in listOf(left to top, right to top, left to bottom, right to bottom)) assertTrue(near(px[x, y], PAGE), "corner $x,$y is the page")
        assertTrue(!near(px[(left + right) / 2, top + 1], PAGE))
        assertTrue(!near(px[(left + right) / 2, bottom - 1], PAGE))
        assertEquals(18f, PolarisMac.sheetRadius.value, "K4: the brand's sheet token")
    }

    @Test
    fun theSheetFloatsTwelveDpInAPlainWindow() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent { Behind { PolarisUpdatePromptHosted(update, onUpdate = {}, onLater = {}, onSkip = null) } }
        waitForIdle()
        assertEquals(12.dp, onNodeWithTag("pkey-mac-sheet").getBoundsInRoot().top, "S6: ~12 dp without a full-size content view")
    }

    @Test
    fun cancelSitsDirectlyLeftOfTheDefault() = runDesktopComposeUiTest(width = 900, height = 640) {
        var verb = ""
        setContent {
            verb = PolarisCopy.localized().updateNow
            Behind { PolarisUpdatePromptHosted(update, onUpdate = {}, onLater = {}, onSkip = null) }
        }
        waitForIdle()
        val sheet = onNodeWithText(verb).getBoundsInRoot()
        val later = onNodeWithText("Remind Me Later").getBoundsInRoot()
        assertEquals(sheet.top, later.top, "one row")
        assertEquals(8.dp, sheet.left - later.right, "directly left of the default, 8 dp apart")
        assertTrue(later.left < sheet.left)
        // The prompt is the inset sheet: below the title-bar row, 440 wide at most.
        val px = onNode(isRoot()).captureToImage().toPixelMap()
        assertEquals(PAGE, px[8, 600], "no dimming")
    }

    @Test
    fun theRealDialogPathDimsNothingEither() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent {
            Behind { PolarisUpdatePromptDialog(update, onUpdate = {}, onLater = {}) }
        }
        waitForIdle()
        mainClock.advanceTimeBy(800)
        waitForIdle()
        // Two scenes: the app, and the dialog's layer with its scrim. Neither darkens the page.
        val roots = onAllNodes(isRoot())
        assertEquals(PAGE, roots[0].captureToImage().toPixelMap()[8, 600], "the page behind the dialog")
        val layer = roots[1].captureToImage().toPixelMap()[8, 600]
        // A 60 % black scrim would leave 40 % of the page; the dialog layer composites to the page itself.
        assertTrue(near(layer, PAGE), "the Dialog's own scrim is transparent for the Mac sheet: $layer")
    }

    @Test
    fun buttonsReadTheirMacosVariants() {
        assertEquals("Remind Me Later", PolarisCopy().forMac().updateLater)
        assertEquals("Snooze", PolarisCopy(updateLater = "Snooze").forMac().updateLater, "a host override stays")
        assertEquals("Later", PolarisCopy().updateLater)
        var localized = ""
        runDesktopComposeUiTest(width = 200, height = 100) {
            setContent { localized = PolarisCopy.localized().updateLater }
            waitForIdle()
        }
        assertEquals("Remind Me Later", localized)
        force("Windows")
        runDesktopComposeUiTest(width = 200, height = 100) {
            setContent { localized = PolarisCopy.localized().updateLater }
            waitForIdle()
        }
        assertEquals("Later", localized)
    }

    @Test
    fun increaseContrastDrawsFullContrastHairlines() {
        var normal: Pair<Color, Color>? = null
        var contrast: Pair<Color, Color>? = null
        var stroke: BorderStroke? = null
        var plain: BorderStroke? = null
        runDesktopComposeUiTest(width = 200, height = 100) {
            setContent {
                PolarisTheme(darkTheme = false) {
                    normal = MaterialTheme.colorScheme.outlineVariant to MaterialTheme.colorScheme.onSurface
                    plain = polarisMacSheetBorder()
                }
                CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(highContrast = true)) {
                    PolarisTheme(darkTheme = false) {
                        contrast = MaterialTheme.colorScheme.outlineVariant to MaterialTheme.colorScheme.onSurface
                        stroke = polarisMacSheetBorder()
                    }
                }
            }
            waitForIdle()
        }
        assertNotEquals(normal!!.first, normal!!.second)
        assertEquals(contrast!!.second, contrast!!.first, "separators at the text colour")
        assertEquals(1.dp, stroke!!.width)
        assertEquals(0.5.dp, plain!!.width)
    }

    @Test
    fun theWindowHasA480By520Floor() = runDesktopComposeUiTest(width = 300, height = 300) {
        setContent { PolarisTheme(darkTheme = false) { PolarisSurface { _, _ -> Box(Modifier.testTag("c").fillMaxSize()) } } }
        waitForIdle()
        // The size is the layout size (the bounds in the root are clipped to the 300 px window).
        val size = onNodeWithTag("c").fetchSemanticsNode().size
        assertTrue(size.width >= 480 && size.height >= 520, "laid out at ${size.width} x ${size.height}")
        assertEquals(480.dp, PolarisMac.floorWidth)
        assertEquals(520.dp, PolarisMac.floorHeight)
    }

    @Test
    fun updateSheetHasALeadingHeaderAndSkipLeading() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent {
            Behind { PolarisUpdatePromptHosted(update, onUpdate = {}, onLater = {}, onSkip = {}) }
        }
        waitForIdle()
        val title = onNodeWithText("2.5.0", substring = true).getBoundsInRoot()
        val skip = onNodeWithText("Skip This Version").getBoundsInRoot()
        val later = onNodeWithText("Remind Me Later").getBoundsInRoot()
        val sheet = onNodeWithTag("pkey-mac-sheet").getBoundsInRoot()
        // S1: Skip is at the leading edge of the content, never centred; Remind Me Later stays trailing.
        assertTrue(skip.left < sheet.left + 24.dp + 16.dp, "Skip is leading: ${skip.left}")
        assertTrue(later.left > skip.right || later.top < skip.top, "Skip does not sit between the buttons")
        assertTrue(title.left < sheet.left + 24.dp + 80.dp, "the icon and the title share the leading edge: ${title.left} vs ${sheet.left}")
    }

    @Test
    fun tabRunsLeftToRightAndReturnFiresTheDefault() = runDesktopComposeUiTest(width = 900, height = 640) {
        var updated = 0
        var later = 0
        setContent { Behind { PolarisUpdatePromptHosted(update, onUpdate = { updated++ }, onLater = { later++ }, onSkip = {}) } }
        waitForIdle()
        val lefts = onAllNodes(isButton).fetchSemanticsNodes().map { it.boundsInRoot.left }
        assertEquals(lefts.sorted(), lefts, "composition (Tab) order is left to right: $lefts")
        onNodeWithText("Remind Me Later").requestFocus()
        onRoot().performKeyInput { pressKey(Key.Enter) }
        waitForIdle()
        assertEquals(1, updated, "Return fires the default, even from Remind Me Later")
        assertEquals(0, later)
        onRoot().performKeyInput { pressKey(Key.Escape) }
        waitForIdle()
        assertEquals(1, later, "Escape is Remind Me Later")
    }

    @Test
    fun aClickOutsideTheSheetDoesNotDismissIt() = runDesktopComposeUiTest(width = 900, height = 640) {
        var later = 0
        setContent { Behind { PolarisUpdatePromptHosted(update, onUpdate = {}, onLater = { later++ }, onSkip = null) } }
        waitForIdle()
        onRoot().performMouseInput { click(androidx.compose.ui.geometry.Offset(8f, 600f)) }
        waitForIdle()
        assertEquals(0, later, "S3: no tap-to-Later on the Mac")
        val props = polarisPromptDialogProperties(dismissible = true, scrim = false, dismissOnClickOutside = false)
        assertTrue(props.dismissOnBackPress && !props.dismissOnClickOutside)
    }

    @Test
    fun stepActionsAreATrailingRowWithCancelLeftOfTheDefault() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent {
            Behind {
                PolarisActivationScreen(
                    PolarisActivationUi(
                        key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV",
                        error = PolarisActivationError.Refused(im.plrs.key.license.ActivationResult.DeviceLimit(3, 3, BoardFixtures.PORTAL)),
                        manageUrl = BoardFixtures.PORTAL,
                    ),
                )
            }
        }
        waitForIdle()
        val back = onNodeWithText("Back").getBoundsInRoot()
        val retry = onNodeWithText("Try Again").getBoundsInRoot()
        val open = onNodeWithText("Open in Browser", substring = true).getBoundsInRoot()
        assertEquals(back.top, retry.top, "one row")
        assertEquals(retry.top, open.top, "one row")
        assertTrue(back.right <= retry.left && retry.right <= open.left, "Back | Try Again | Open in Browser")
        assertTrue(open.right - open.left < 300.dp)
    }

    @Test
    fun theKeyFieldHasABoundaryALabelAboveAndAMonospaceKey() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent {
            Behind { PolarisActivationScreen(PolarisActivationUi(key = "pkey_tidewater_ABCDEFGH"), onSignIn = {}) }
        }
        waitForIdle()
        val label = onAllNodesWithText(PolarisCopy().keyLabel).fetchSemanticsNodes().first().boundsInRoot
        val field = onNode(hasSetTextAction()).getBoundsInRoot()
        assertTrue(label.bottom <= field.top.value + 1f, "the label is above the field")
        val style = onNode(hasSetTextAction()).fetchSemanticsNode().config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult)?.action?.let { f ->
            val out = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            f(out)
            out.firstOrNull()?.layoutInput?.style
        }
        assertEquals(androidx.compose.ui.text.font.FontFamily.Monospace, style?.fontFamily, "the key is monospace")
        // The boundary is at least 3:1 against the page it sits on (WCAG 1.4.11).
        val px = onNode(isRoot()).captureToImage().toPixelMap()
        val x = field.left.value.toInt()
        val y = ((field.top.value + field.bottom.value) / 2).toInt()
        val ground = px[x - 8, y]
        val best = (x - 2..x + 2).maxOf { contrast(px[it, y], ground) }
        assertTrue(best >= 3f, "the boundary reads $best:1")
    }

    @Test
    fun theDarkSheetIsRaisedAndTheSecondaryButtonKeepsAnEdge() {
        var sheetDark: Color? = null
        var sheetLight: Color? = null
        var face: Color? = null
        runDesktopComposeUiTest(width = 200, height = 100) {
            setContent {
                PolarisTheme(darkTheme = true) {
                    sheetDark = polarisMacSheetColor()
                    face = polarisMacSecondaryColors().containerColor
                    assertEquals(MaterialTheme.colorScheme.surfaceContainerHigh, sheetDark)
                    assertEquals(0.5.dp, polarisMacBezel()!!.width)
                }
                PolarisTheme(darkTheme = false) { sheetLight = polarisMacSheetColor() }
            }
            waitForIdle()
        }
        assertNotEquals(sheetDark, sheetLight)
        assertNotEquals(sheetDark, face, "the secondary face is distinct from the sheet")
    }

    @Test
    fun increaseContrastBordersButtonsAndFields() = runDesktopComposeUiTest(width = 200, height = 100) {
        var border: BorderStroke? = null
        var color: Color? = null
        setContent {
            CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(highContrast = true)) {
                PolarisTheme(darkTheme = false) {
                    border = polarisMacBezel()
                    color = MaterialTheme.colorScheme.onSurface
                }
            }
        }
        waitForIdle()
        assertEquals(1.dp, border!!.width)
        assertEquals(androidx.compose.ui.graphics.SolidColor(color!!), border!!.brush)
    }

    @Test
    fun macVariantsAreByCatalogKeyForButtonsOnly() {
        assertEquals("All Changes in %1\$s", PolarisCopy().forMac().updateAllChanges, "templated variants carry their argument")
        assertEquals("Replace a device", PolarisCopy().forMac().freeDevice, "a heading is not a button: sentence case")
        assertEquals("Install and Relaunch", PolarisCopy().forMac().updateNow)
        assertTrue(isMacVariantRole("update.later") && isMacVariantRole("menu.manageLicense"))
        assertTrue(!isMacVariantRole("deviceLimit.title"))
        var themed = ""
        runDesktopComposeUiTest(width = 200, height = 100) {
            setContent { PolarisTheme(copy = PolarisCopy()) { themed = PolarisTheme.copy.updateLater } }
            waitForIdle()
        }
        assertEquals("Remind Me Later", themed, "an explicit default copy reads the Mac wording in PolarisTheme too")
    }

    @Test
    fun theWelcomeUsesTheDisplayTitleAndTheHeroButtons() = runDesktopComposeUiTest(width = 900, height = 640) {
        setContent { Behind { PolarisActivationScreen(PolarisActivationUi(), onSignIn = {}) } }
        waitForIdle()
        val signIn = onNodeWithText("Sign In").getBoundsInRoot()
        assertEquals(36.dp, signIn.bottom - signIn.top, "S5: hero buttons are 36 pt")
        assertTrue(signIn.right - signIn.left <= 320.dp, "at most 320 wide")
        var display = 0f
        runDesktopComposeUiTest(width = 200, height = 100) {
            setContent { PolarisTheme(darkTheme = false) { display = MaterialTheme.typography.headlineLarge.fontSize.value } }
            waitForIdle()
        }
        assertEquals(26f, display)
    }

    @Test
    fun androidKeepsItsOwnChrome() = runDesktopComposeUiTest(width = 300, height = 300) {
        force("Android")
        setContent { PolarisTheme(darkTheme = false) { PolarisSurface { _, _ -> Box(Modifier.testTag("c").fillMaxSize()) } } }
        waitForIdle()
        assertEquals(300, onNodeWithTag("c").fetchSemanticsNode().size.width, "no floor")
        assertEquals(56.dp, PolarisPlatformVariant.Android.controlHeight)
    }

    private fun lum(c: Color): Float {
        fun ch(v: Float) = if (v <= 0.03928f) v / 12.92f else Math.pow(((v + 0.055f) / 1.055f).toDouble(), 2.4).toFloat()
        return 0.2126f * ch(c.red) + 0.7152f * ch(c.green) + 0.0722f * ch(c.blue)
    }

    private fun contrast(a: Color, b: Color): Float {
        val (hi, lo) = lum(a).let { x -> lum(b).let { y -> maxOf(x, y) to minOf(x, y) } }
        return (hi + 0.05f) / (lo + 0.05f)
    }

    private fun near(a: Color, b: Color) = kotlin.math.abs(a.red - b.red) < 0.03f && kotlin.math.abs(a.green - b.green) < 0.03f && kotlin.math.abs(a.blue - b.blue) < 0.03f

    private companion object {
        val PAGE = Color(0xFF123456)
    }
}
