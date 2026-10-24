// @pkey-feature ui.kit
//
// UK-10.6: the GNOME (libadwaita) chrome, one assertion per rule: the 34 px control at radius 8,
// the suggested action as a pill at the end, the AdwAlertDialog's responses side by side and
// stacked when narrow, the AdwDialog's radius, shadow and 7 % edge, the AdwStatusPage's stacked
// centred pills, the opaque surfaces and the host accent. Forced through `pkey.kit.platform`.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

internal fun <T> withPlatform(name: String, block: () -> T): T {
    val old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, name)
    try {
        return block()
    } finally {
        if (old == null) System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY) else System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, old)
    }
}

class GnomeChromeTest {
    private fun SemanticsNodeInteraction.pixel(x: Int, y: Int): Color = captureToImage().toPixelMap()[x, y]

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun bothActionsOfAPairAre40HighPills() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 420, height = 200) {
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSurface { _, _ ->
                        Column(Modifier.padding(24.dp)) {
                            PolarisPrimaryButton("Suggested", {}, Modifier.testTag("suggested"))
                            PolarisSecondaryButton("Plain", {}, Modifier.testTag("plain"))
                        }
                    }
                }
            }
            waitForIdle()
            // Both actions of a pair are 40 px pills; 34 px at radius 8 is for entries and aux controls.
            for (tag in listOf("suggested", "plain")) {
                assertEquals(40.dp, onNodeWithTag(tag).getBoundsInRoot().height, "$tag is 40 dp tall")
                // (3,3) is outside a pill's corner (centre 20,20: distance 24) and its (0,0) is outside any rounding.
                val node = onNodeWithTag(tag)
                assertEquals(node.pixel(0, 0), node.pixel(3, 3), "$tag is a pill: (3,3) is outside it")
            }
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun otherVariantsKeepTheirOwnButtons() = withPlatform("Windows") {
        runDesktopComposeUiTest(width = 420, height = 200) {
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSurface { _, _ -> Column(Modifier.padding(24.dp)) { PolarisPrimaryButton("Suggested", {}, Modifier.testTag("b")) } }
                }
            }
            waitForIdle()
            // Windows keeps the kit's padded button (not GNOME's fixed 34): untouched by this slice.
            assertTrue(onNodeWithTag("b").getBoundsInRoot().height >= 32.dp)
        }
    }

    @OptIn(ExperimentalTestApi::class)
    private fun alertBounds(width: Int): Triple<androidx.compose.ui.geometry.Rect?, androidx.compose.ui.geometry.Rect?, Boolean> {
        var back: androidx.compose.ui.geometry.Rect? = null
        var replace: androidx.compose.ui.geometry.Rect? = null
        var stacked = false
        withPlatform("Gnome") {
            runDesktopComposeUiTest(width = width, height = 600) {
                setContent {
                    PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                        PolarisSurface { _, _ ->
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                PolarisReplaceAlert("Mara's Mac", "this computer", "Tidewater", {}, {})
                            }
                        }
                    }
                }
                waitForIdle()
                val b = onNodeWithText("Back").getBoundsInRoot()
                val r = onNodeWithText("Replace Mara's Mac").getBoundsInRoot()
                stacked = r.top < b.top
                val density = 1f
                back = androidx.compose.ui.geometry.Rect(b.left.value * density, b.top.value, b.right.value, b.bottom.value)
                replace = androidx.compose.ui.geometry.Rect(r.left.value * density, r.top.value, r.right.value, r.bottom.value)
            }
        }
        return Triple(back, replace, stacked)
    }

    @Test
    fun alertResponsesSitSideBySideAtEqualWidthWithTheSuggestedLast() {
        val (back, replace, stacked) = alertBounds(width = 700)
        assertTrue(!stacked, "side by side")
        assertTrue(replace!!.left > back!!.right, "the suggested response is at the end")
        assertEquals(back.width, replace.width, 1f, "equal width")
        assertEquals(back.top, replace.top, 0.5f, "one row")
    }

    @Test
    fun alertResponsesStackWhenNarrowWithTheSuggestedOnTop() {
        val (back, replace, stacked) = alertBounds(width = 300)
        assertTrue(stacked, "stacked")
        assertTrue(replace!!.bottom <= back!!.top, "the suggested response is on top")
        assertEquals(back.width, replace.width, 1f, "full width, equal")
    }

    /** The pixels of the update dialog over a 700 x 700 window (density 1): the card is 460 wide, centred. */
    @OptIn(ExperimentalTestApi::class)
    private fun dialogPixels(dark: Boolean): androidx.compose.ui.graphics.PixelMap {
        lateinit var pixels: androidx.compose.ui.graphics.PixelMap
        runDesktopComposeUiTest(width = 700, height = 700) {
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = dark) {
                    PolarisSurface { _, _ ->
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            PolarisUpdatePromptHosted(PolarisUpdateUi(version = "2.5", currentVersion = "2.4.1"), {}, {}, null)
                        }
                    }
                }
            }
            waitForIdle()
            pixels = onRoot().captureToImage().toPixelMap()
        }
        return pixels
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theSheetHeaderLeadsOnTheNotesEdgeNotCentred() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 700, height = 700) {
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSurface { _, _ ->
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            PolarisUpdatePromptHosted(PolarisUpdateUi(version = "2.5", currentVersion = "2.4.1"), {}, {}, null)
                        }
                    }
                }
            }
            waitForIdle()
            val heading = onNode(androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsProperties.Heading)).fetchSemanticsNode()
            val results = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            heading.config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action?.invoke(results)
            val layout = results.first()
            assertEquals(0f, layout.getLineLeft(0), "the title starts at the leading edge of its column")
            assertTrue(layout.getLineRight(0) < heading.size.width - 20, "and does not fill the line")
        }
    }

    @Test
    fun theSheetIsAnAdwDialogRadius12WithAnEdgeInLightAndNoOutlineInDark() = withPlatform("Gnome") {
        val left = (700 - 460) / 2
        val light = dialogPixels(dark = false)
        val dark = dialogPixels(dark = true)
        val mid = 350
        // Opaque card, dimmed scrim around it: the interior is not the scrim.
        val interior = light[left + 6, mid]
        assertNotEquals(light[left - 60, mid], interior, "the card stands out from the dimmed window")
        assertEquals(1f, interior.alpha, "opaque")
        // Light: the 1 px edge is the 7 % hairline, a shade darker than the card.
        assertTrue(light[left, mid].red < interior.red, "light carries an edge: ${light[left, mid]} vs $interior")
        // Dark: no outline, the edge pixel is the card.
        assertEquals(dark[left + 6, mid], dark[left, mid], "dark draws no outline")
        // Radius 12: scan down the column at x = 300 to the card's top, then check the corner is cut.
        for (px in listOf(light, dark)) {
            val inside = px[left + 6, mid]
            var top = 0
            while (top < 700 && px[300, top] != inside) top++
            assertTrue(top in 1..699, "found the card's top")
            assertNotEquals(inside, px[left + 1, top + 1], "the corner is rounded (radius 12 clips the pixel 1,1 in)")
            assertEquals(inside, px[left + 20, top + 2], "past the radius the card is whole")
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun aMessageScreenIsAStatusPageWithStackedCentredPills() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 1100, height = 700) {
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisMessageScreen(PolarisMessageCopy("Can't connect", "Check your connection.", PolarisMessageKind.Offline)) {
                        PolarisPrimaryButton("Try again", {}, Modifier.testTag("suggested"))
                        PolarisSecondaryButton("Continue offline", {}, Modifier.testTag("plain"))
                    }
                }
            }
            waitForIdle()
            val s = onNodeWithTag("suggested").getBoundsInRoot()
            val p = onNodeWithTag("plain").getBoundsInRoot()
            assertTrue(s.bottom <= p.top, "stacked, the suggested action on top")
            assertTrue(s.width <= 240.dp, "at most 240 wide")
            assertEquals(40.dp, s.height, "a pill")
            assertEquals(40.dp, p.height, "a pill")
            assertEquals(s.left, p.left, "one column")
            val centre = (s.left + s.right) / 2
            assertEquals(550f, centre.value, 2f, "centred in a wide window, not a start-aligned block")
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theSurfacesAreOpaqueAndTheHostAccentColoursTheNativePreset() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 300, height = 120) {
            var primary = Color.Unspecified
            setContent {
                CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(dark = true, accent = 0x3584E4)) {
                    PolarisTheme(branding = PolarisBranding.None) {
                        primary = MaterialTheme.colorScheme.primary
                        PolarisSurface { _, _ -> Box(Modifier.fillMaxSize().testTag("page")) }
                    }
                }
            }
            waitForIdle()
            assertTrue(PolarisTheme.let { primary != Color.Unspecified })
            val px = onNodeWithTag("page").captureToImage().toPixelMap()[10, 10]
            assertEquals(1f, px.alpha, "an opaque page")
            // The portal's blue, resolved for contrast on a dark ground: still blue.
            assertTrue(primary.blue > primary.red, "the accent is the portal's blue, got $primary")
        }
    }

    // ----- UK-10.6 fix round: Replace alert wiring, entry, type, focus ring, status icon -----

    private fun replaceScreen() = KitScreen(
        component = KitComponent.signIn,
        state = "replace",
        copy = listOf(
            CopyLine("signin.replace.open"),
            CopyLine("signin.replace.lede", mapOf("thisDevice" to CopyArgument.Text("this computer"))),
            CopyLine("signin.replace.title", mapOf("device" to CopyArgument.Text("Work laptop"))),
        ),
        actions = emptyList(),
    )

    @OptIn(ExperimentalTestApi::class)
    private fun withReplaceScreen(block: androidx.compose.ui.test.ComposeUiTest.(actions: MutableList<KitAction?>) -> Unit) = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 700, height = 700) {
            val actions = mutableListOf<KitAction?>()
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisKitScreen(replaceScreen(), onAction = { actions += it })
                }
            }
            waitForIdle()
            block(actions)
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun replaceOpensTheAlertWithBackFocusedAndADestructiveConfirm() = withReplaceScreen { actions ->
        onNodeWithText("Replace Work laptop").assertDoesNotExist()
        onNodeWithText("Replace…").performClick()
        waitForIdle()
        onNodeWithText("Replace Work laptop").assertExists()
        onNodeWithText("Back").assertIsFocused()
        // The confirm is destructive-styled: its pill is the error colour.
        val confirm = onNodeWithText("Replace Work laptop")
        val b = confirm.getBoundsInRoot()
        val px = onRoot().captureToImage().toPixelMap()
        var error = Color.Unspecified
        // sample inside the confirm pill, left of its label
        val sample = px[b.left.value.toInt() + 6, ((b.top.value + b.bottom.value) / 2).toInt()]
        assertTrue(sample.red > sample.blue && sample.red > 0.5f, "the confirm is destructive red, got $sample")
        confirm.performClick()
        waitForIdle()
        assertEquals(listOf(KitAction.forCopyKey("signin.replace.confirm")), actions)
        onNodeWithText("Replace Work laptop").assertDoesNotExist()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun escapeIsBackAndFocusIsTrapped() = withReplaceScreen { _ ->
        onNodeWithText("Replace…").performClick()
        waitForIdle()
        onNodeWithText("Back").assertIsFocused()
        // Tab cycles Back -> Replace -> Back: it never reaches the window behind the alert.
        onRoot().performKeyInput { keyDown(Key.Tab); keyUp(Key.Tab) }
        waitForIdle()
        onNodeWithText("Replace Work laptop").assertIsFocused()
        onRoot().performKeyInput { keyDown(Key.Tab); keyUp(Key.Tab) }
        waitForIdle()
        onNodeWithText("Back").assertIsFocused()
        onRoot().performKeyInput { keyDown(Key.Escape); keyUp(Key.Escape) }
        waitForIdle()
        onNodeWithText("Replace Work laptop").assertDoesNotExist()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theEntryHasItsLabelAboveRadius8AndAnAccentFocusOutline() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 500, height = 300) {
            var accentFocus = Color.Unspecified
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    accentFocus = PolarisTheme.focusColor
                    PolarisSurface { _, _ -> Column(Modifier.padding(24.dp)) { PolarisTextField("", {}, "Licence key", placeholder = "pkey_…") } }
                }
            }
            waitForIdle()
            val label = onNodeWithText("Licence key").getBoundsInRoot()
            val field = onNodeWithContentDescription("Licence key").getBoundsInRoot()
            assertTrue(label.bottom <= field.top + 8.dp, "the label sits above the field, not inside it")
            assertTrue(label.top < field.top, "label above")
            assertTrue(onNodeWithTag("polaris.gnome.entry").getBoundsInRoot().height >= 34.dp, "a 34 px entry")
            val rest = onNodeWithTag("polaris.gnome.entry").captureToImage().toPixelMap()
            onNodeWithContentDescription("Licence key").requestFocus()
            waitForIdle()
            val focused = onNodeWithTag("polaris.gnome.entry").captureToImage().toPixelMap()
            val mid = focused.width / 2
            // The 2 px outline is the accent (the theme's focus colour), inside the edge; at rest it is a hairline.
            assertEquals(accentFocus, focused[mid, 0], "the focused entry's top edge is the accent")
            assertEquals(accentFocus, focused[mid, 1], "2 px wide")
            assertNotEquals(rest[mid, 1], focused[mid, 1], "the outline appears on focus")
            // Radius 8: the corner pixel is outside the rounded field.
            assertNotEquals(focused[mid, 0], focused[0, 0], "the corner is cut by radius 8")
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theTypeScaleIsGnomes() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 500, height = 300) {
            var body = 0f
            var bodyLine = 0f
            var title = 0f
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSurface { _, _ ->
                        body = MaterialTheme.typography.bodyLarge.fontSize.value
                        bodyLine = MaterialTheme.typography.bodyLarge.lineHeight.value
                        title = MaterialTheme.typography.headlineSmall.fontSize.value
                    }
                }
            }
            waitForIdle()
            assertEquals(15f, body); assertEquals(21f, bodyLine); assertEquals(22f, title)
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theFocusRingIsTwoPxInsideTheEdge() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 300, height = 120) {
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSurface { _, _ -> Box(Modifier.padding(24.dp)) { PolarisPrimaryButton("Go", {}, Modifier.testTag("b")) } }
                }
            }
            waitForIdle()
            val rest = onNodeWithTag("b").captureToImage().toPixelMap()
            onNodeWithTag("b").requestFocus()
            waitForIdle()
            val node = onNodeWithTag("b")
            val focus = node.captureToImage().toPixelMap()
            val h = node.getBoundsInRoot().height.value.toInt()
            // The ring is drawn on the control's own pixels (offset -2): the box is unchanged and its edge pixel changes.
            assertEquals(40, h)
            // Ring (2) then a 1 px page-coloured line: the pixels 2..3 in from the edge change on focus.
            assertTrue((2..3).any { rest[it, h / 2] != focus[it, h / 2] }, "the ring is drawn inside the edge")
            assertTrue((2..3).any { rest[h / 2, it] != focus[h / 2, it] }, "and inside the top edge")
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theOfflineStatusPageUsesNetworkOffline() = withPlatform("Gnome") {
        runDesktopComposeUiTest(width = 400, height = 300) {
            var icon: androidx.compose.ui.graphics.vector.ImageVector? = null
            var other: androidx.compose.ui.graphics.vector.ImageVector? = null
            setContent {
                PolarisTheme(branding = PolarisBranding.PolarisKey, darkTheme = false) {
                    PolarisSurface { _, _ ->
                        icon = polarisMessageIcon(PolarisMessageKind.Offline)
                        other = polarisMessageIcon(PolarisMessageKind.Info)
                    }
                }
            }
            waitForIdle()
            assertEquals(PolarisGnome.networkOffline, icon)
            assertNotEquals(PolarisSymbols.Refresh, icon)
            assertEquals(PolarisSymbols.Info, other)
        }
    }
}
