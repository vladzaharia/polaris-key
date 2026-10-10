// @pkey-feature core.presentation
//
// The kit reads the SDK's presentation seam (plans/HA-13.md §3, Kotlin row) and fills only what the
// integrator left out: the logo falls back to the verified icon, then the monogram; branded, the
// primary falls back to the product accent (accentDark on a dark ground), then the icon's derived
// colour, then today's core violet; neutral keeps the host's primary. With no presentation the theme
// is today's, pixel for pixel in the product icon's slot.

package im.plrs.key.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.Presentation
import im.plrs.key.core.PresentationIcon
import im.plrs.key.core.PresentationSource
import im.plrs.key.ui.brand.PolarisAccent
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A source a test drives: the member, the bytes `icon()` answers, and the calls it saw. */
private class FakeSource(member: Presentation?, private val bytes: ByteArray?) : PresentationSource {
    @Volatile var member: Presentation? = member
    @Volatile var calls = 0
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(Presentation?) -> Unit>()

    override fun current(): Presentation? = member
    override suspend fun icon(px: Double, scale: Double): ByteArray? {
        calls++
        return bytes
    }
    override fun subscribe(listener: (Presentation?) -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }
    fun change(m: Presentation?) {
        member = m
        listeners.forEach { it(m) }
    }
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class PresentationThemeTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val icon = PresentationIcon(sha256 = "a".repeat(64), contentType = "image/png", original = "https://img.plrs.im/driftkart/a/x")
    private val red = 0xFFE53935.toInt()

    private fun png(colour: Int): ByteArray {
        val bmp = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(colour) }
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private class Seen {
        var primary: Color? = null
        var logo = false
    }

    private fun render(
        source: PresentationSource?,
        branding: PolarisBranding = PolarisBranding.PolarisKey,
        dark: Boolean = false,
        accent: Color? = null,
        logo: (@Composable () -> Unit)? = null,
    ): Seen {
        val seen = Seen()
        rule.setContent {
            StockHost(dark) {
                PolarisTheme(branding = branding, darkTheme = dark, accent = accent, logo = logo, presentation = source) {
                    seen.primary = MaterialTheme.colorScheme.primary
                    seen.logo = PolarisTheme.current.logo != null
                    PolarisProductIcon(120.dp)
                }
            }
        }
        rule.waitForIdle()
        return seen
    }

    private fun solid(hex: String, dark: Boolean) = colorOf(PolarisAccent.resolve(hex, dark)!!.solid)

    /** Every colour on screen (Robolectric's native graphics). */
    private fun pixels(): Set<Int> {
        rule.waitForIdle()
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnUiThread { view.draw(Canvas(bitmap)) }
        val all = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(all, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return all.toHashSet()
    }

    @Test
    fun withoutPresentationTheThemeIsTodays() {
        val seen = render(source = null)
        assertEquals(polarisBrandColorScheme(false).primary, seen.primary)
        assertFalse(seen.logo)
        assertFalse(red in pixels())
    }

    @Test
    fun theProductAccentIsTheBrandedDefaultPerScheme() {
        val m = Presentation(name = "Drift Kart", accent = "#2ed6e6", accentDark = "#5ee6f0")
        assertEquals(solid("#2ed6e6", false), render(FakeSource(m, null)).primary)
    }

    @Test
    fun theDarkSchemeTakesAccentDark() {
        val m = Presentation(name = "Drift Kart", accent = "#2ed6e6", accentDark = "#5ee6f0")
        assertEquals(solid("#5ee6f0", true), render(FakeSource(m, null), dark = true).primary)
    }

    @Test
    fun theIntegratorsAccentWinsOverPresentation() {
        val m = Presentation(name = "Drift Kart", accent = "#2ed6e6")
        assertEquals(solid("#7a2fff", false), render(FakeSource(m, null), accent = colorOf("#7a2fff")).primary)
    }

    @Test
    fun neutralKeepsTheHostsPrimary() {
        val m = Presentation(name = "Drift Kart", accent = "#2ed6e6")
        assertEquals(lightColorScheme().primary, render(FakeSource(m, null), branding = PolarisBranding.None).primary)
    }

    @Test
    fun theVerifiedIconIsTheLogo() {
        val source = FakeSource(Presentation(name = "Drift Kart", accent = "#2ed6e6", icon = icon), png(red))
        val seen = render(source)
        rule.waitUntil(5_000) { seen.logo }
        assertTrue(red in pixels())
        assertEquals(1, source.calls)
    }

    /** Render with [source] and let its icon attempt finish (the decode runs off the main thread). */
    private fun renderSettled(source: FakeSource): Seen {
        val seen = render(source)
        rule.waitUntil(5_000) { source.calls == 1 }
        Thread.sleep(200)
        rule.waitForIdle()
        return seen
    }

    @Test
    fun bytesThatDoNotDecodeAreTheMonogram() {
        assertFalse(renderSettled(FakeSource(Presentation(name = "Drift Kart", icon = icon), "not an image".toByteArray())).logo)
    }

    @Test
    fun aFailedFetchIsTheMonogram() {
        assertFalse(renderSettled(FakeSource(Presentation(name = "Drift Kart", icon = icon), null)).logo)
    }

    @Test
    fun theIntegratorsLogoWinsAndNothingIsFetched() {
        val source = FakeSource(Presentation(name = "Drift Kart", accent = "#2ed6e6", icon = icon), png(red))
        val seen = render(source, logo = {})
        assertTrue(seen.logo)
        assertEquals(0, source.calls)
        assertFalse(red in pixels())
    }

    @Test
    fun withoutAnAccentTheIconsColourIsDerived() {
        val bytes = png(red)
        val derived = decodePresentationArt(bytes, 120)?.derivedAccent
        assertNotNull(derived)
        val seen = render(FakeSource(Presentation(name = "Drift Kart", icon = icon), bytes))
        rule.waitUntil(5_000) { seen.primary == solid(derived!!, false) }
    }

    @Test
    fun aChangedMemberIsFollowed() {
        val source = FakeSource(Presentation(name = "Drift Kart", accent = "#2ed6e6"), null)
        val seen = render(source)
        assertEquals(solid("#2ed6e6", false), seen.primary)
        rule.runOnIdle { source.change(null) }
        rule.waitForIdle()
        assertEquals(polarisBrandColorScheme(false).primary, seen.primary)
    }

    @Test
    fun theAccentOrderAsData() {
        val m = Presentation(name = "P", accent = "#2ed6e6", accentDark = "#5ee6f0")
        val integrator = colorOf("#123456")
        assertEquals(integrator, themeAccent(integrator, PolarisBranding.PolarisKey, m, false, "#ff0000"))
        assertEquals(integrator, themeAccent(integrator, PolarisBranding.None, m, false, null))
        assertNull(themeAccent(null, PolarisBranding.None, m, false, "#ff0000"))
        assertEquals(colorOf("#2ed6e6"), themeAccent(null, PolarisBranding.PolarisKey, m, false, "#ff0000"))
        assertEquals(colorOf("#5ee6f0"), themeAccent(null, PolarisBranding.PolarisKey, m, true, null))
        assertEquals(colorOf("#ff0000"), themeAccent(null, PolarisBranding.PolarisKey, Presentation(name = "P"), false, "#ff0000"))
        assertNull(themeAccent(null, PolarisBranding.PolarisKey, null, false, null))
    }
}
