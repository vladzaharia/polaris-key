// @pkey-feature ui.kit
// Owner decision 2, checked rather than claimed:
//   - with a stock Material 3 theme and the defaults, no screen shows a Polaris Key colour, the
//     Rubik face, the Pinned K or the "Powered by" badge;
//   - PolarisBranding.PolarisKey is the one change that brings the brand in;
//   - showPoweredBy = true adds the badge, with or without branding, and is off by default.

package im.plrs.key.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.activity.ComponentActivity
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.ui.brand.PolarisBrandTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The distinctive brand colours: the kit primitives, brand surfaces and every section accent. */
internal val brandColours: Set<Int> = buildSet {
    val k = PolarisBrandTokens.Kit
    for (c in listOf(k.violetDark, k.violetLight, k.goldDark, k.goldLight, k.pageDark, k.pageLight, k.mutedDark, k.mutedLight)) add(c.toArgb())
    for (id in PolarisBrandTokens.serviceIds) for (dark in listOf(true, false)) {
        val a = PolarisBrandTokens.accent(id, dark)
        add(a.solid.toArgb())
        add(a.subtle.toArgb())
    }
    for (c in listOf(PolarisBrandTokens.Dark.surfaceRaised, PolarisBrandTokens.Dark.textDefault, PolarisBrandTokens.Light.textDefault)) add(c.toArgb())
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class BrandingTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private var screen by mutableStateOf<@Composable () -> Unit>({})

    /** One composition per test, so screens are swapped through [screen]. */
    private fun host(dark: Boolean = false, theme: @Composable (@Composable () -> Unit) -> Unit) {
        rule.setContent { StockHost(dark) { theme { screen() } } }
    }

    private fun show(content: @Composable () -> Unit) {
        rule.runOnIdle { screen = content }
        rule.waitForIdle()
    }

    /** Every colour on screen: the window drawn in software (Robolectric's native graphics). */
    private fun pixels(): Set<Int> {
        rule.waitForIdle()
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnUiThread { view.draw(Canvas(bitmap)) }
        val all = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(all, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return all.toHashSet()
    }

    private fun marks(): Int = rule.onAllNodesWithContentDescription(PolarisCopy().polarisKeyMark).fetchSemanticsNodes().size
    private fun badges(): Int = rule.onAllNodesWithContentDescription(PolarisCopy().poweredBy).fetchSemanticsNodes().size

    @Test
    fun defaultsResolveNeutral() {
        var config: PolarisUiConfig? = null
        var body: FontFamily? = null
        var hostBody: FontFamily? = null
        rule.setContent {
            StockHost(false) {
                hostBody = MaterialTheme.typography.bodyLarge.fontFamily
                PolarisTheme {
                    config = PolarisTheme.current
                    body = MaterialTheme.typography.bodyLarge.fontFamily
                }
            }
        }
        rule.waitForIdle()
        val c = config!!
        assertEquals(PolarisBranding.None, c.branding)
        assertEquals(false, c.showPoweredBy)
        assertNull("no logo unless the host passes one", c.logo)
        assertNull("the host's shapes, not the brand radius", c.controlShape)
        assertEquals("the host's type, not Rubik", hostBody, body)
        assertNotEquals(PolarisRubik, body)
    }

    @Test
    fun neutralScreensShowNoBrandLight() = neutralScreensShowNoBrand(dark = false)

    @Test
    fun neutralScreensShowNoBrandDark() = neutralScreensShowNoBrand(dark = true)

    private fun neutralScreensShowNoBrand(dark: Boolean) {
        host(dark) { content -> PolarisTheme(copy = sampleCopy, darkTheme = dark, content = content) }
        for ((name, content) in kitScreens) {
            show(content)
            val leaked = pixels() intersect brandColours
            assertTrue("$name shows brand colours ${leaked.map { Integer.toHexString(it) }}", leaked.isEmpty())
            assertEquals("$name shows the Pinned K", 0, marks())
            assertEquals("$name shows the badge", 0, badges())
        }
    }

    @Test
    fun theOneSwitchBringsTheBrand() {
        var body: FontFamily? = null
        host(dark = true) { content -> PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = true, content = content) }
        show {
            body = MaterialTheme.typography.bodyLarge.fontFamily
            kitScreens.first { it.first == "gate-activation" }.second()
        }
        assertEquals(PolarisRubik, body)
        assertEquals("the Pinned K is the branded logo", 1, marks())
        assertEquals("the badge stays off with branding on", 0, badges())
        val core = PolarisBrandTokens.accent("core", dark = true).solid.toArgb()
        assertTrue("the primary button wears the core violet", core in pixels())
        assertTrue(PolarisBrandTokens.Dark.surfacePage.toArgb() in pixels())
    }

    @Test
    fun theBadgeIsIndependentOfBranding() {
        var branding by mutableStateOf(PolarisBranding.None)
        host { content -> PolarisTheme(branding = branding, showPoweredBy = true, copy = sampleCopy, darkTheme = false, content = content) }
        show(kitScreens.first { it.first == "gate-activation" }.second)
        assertEquals(1, badges())
        assertEquals("neutral with the badge still has no logo", 0, marks())
        rule.runOnIdle { branding = PolarisBranding.PolarisKey }
        rule.waitForIdle()
        assertEquals(1, badges())
        assertEquals(1, marks())
    }

    @Test
    fun aHostLogoFillsTheSlot() {
        host { content ->
            PolarisTheme(copy = sampleCopy, logo = { androidx.compose.material3.Text("ACME") }, content = content)
        }
        show(kitScreens.first { it.first == "gate-activation" }.second)
        assertEquals(1, rule.onAllNodesWithText("ACME").fetchSemanticsNodes().size)
        assertEquals(0, marks())
    }
}

private fun androidx.compose.ui.test.junit4.ComposeTestRule.onAllNodesWithText(text: String) =
    onAllNodes(androidx.compose.ui.test.hasText(text))
