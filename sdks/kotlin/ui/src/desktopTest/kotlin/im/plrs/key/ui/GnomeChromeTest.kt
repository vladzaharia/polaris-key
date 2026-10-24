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
    fun controlsAre34HighAtRadius8AndTheSuggestedActionIsAPill() = withPlatform("Gnome") {
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
            for (tag in listOf("suggested", "plain")) {
                assertEquals(34.dp, onNodeWithTag(tag).getBoundsInRoot().height, "$tag is 34 dp tall")
            }
            // The corner pixel (0,0) is outside any rounding. (3,3) is inside a radius-8 corner (its
            // centre is at 8,8: distance 7.1) and outside a pill's (centre 17,17: distance 19.8).
            val plain = onNodeWithTag("plain")
            assertNotEquals(plain.pixel(0, 0), plain.pixel(3, 3), "the secondary button has a radius-8 corner")
            assertEquals(plain.pixel(0, 0), plain.pixel(1, 1), "radius 8 clips (1,1)")
            val suggested = onNodeWithTag("suggested")
            assertEquals(suggested.pixel(0, 0), suggested.pixel(3, 3), "the suggested action is a pill: (3,3) is outside it")
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
            assertTrue(s.width <= 320.dp, "at most 320 wide")
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
}
