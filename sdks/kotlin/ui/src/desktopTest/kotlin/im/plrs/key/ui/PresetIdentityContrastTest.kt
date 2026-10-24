// @pkey-feature ui.kit
// @pkey-feature core.presentation
//
// UK-10.11, the rest of the matrix: the product's presentation reaching the kit with zero integrator
// code (a fake PresentationSource gives the accent and the icon), a table over every UI-KITS.md §3.1
// theme field, the contrast of the label on the accent's fill measured on the render (#ff6a3d and a
// dark navy, both schemes, all three chromes), and high contrast and reduced transparency.

@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package im.plrs.key.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.unit.dp
import im.plrs.key.core.Presentation
import im.plrs.key.core.PresentationIcon
import im.plrs.key.core.PresentationSource
import im.plrs.key.ui.brand.PolarisAccent
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** A presentation source a test drives: one member and the icon bytes. */
private class FakePresentation(private val member: Presentation?, private val bytes: ByteArray?) : PresentationSource {
    override fun current(): Presentation? = member
    override suspend fun icon(px: Double, scale: Double): ByteArray? = bytes
    override fun subscribe(listener: (Presentation?) -> Unit): () -> Unit = {}
}

private fun png(argb: Int): ByteArray {
    val image = BufferedImage(64, 64, BufferedImage.TYPE_INT_ARGB)
    for (x in 0 until 64) for (y in 0 until 64) image.setRGB(x, y, argb)
    return ByteArrayOutputStream().also { ImageIO.write(image, "png", it) }.toByteArray()
}

private fun ratio(a: Color, b: Color): Double {
    val la = a.luminance().toDouble(); val lb = b.luminance().toDouble()
    return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
}

private fun Color.near(other: Color, tolerance: Float = 3f / 255f) =
    abs(red - other.red) <= tolerance && abs(green - other.green) <= tolerance && abs(blue - other.blue) <= tolerance

/** The most common colour of [image] (the fill) and the colour farthest in contrast from it (the label). */
private fun fillAndLabel(image: ImageBitmap): Pair<Color, Color> {
    val map = image.toPixelMap()
    val counts = HashMap<Int, Int>()
    for (x in 0 until map.width) for (y in 0 until map.height) if (map[x, y].alpha == 1f) counts.merge(map[x, y].toArgb(), 1, Int::plus)
    val fill = Color(counts.maxByOrNull { it.value }!!.key)
    var label = fill; var best = 1.0
    for (x in 0 until map.width) for (y in 0 until map.height) {
        val c = map[x, y]
        val r = ratio(c, fill)
        if (r > best) { best = r; label = c }
    }
    return fill to label
}

@OptIn(ExperimentalTestApi::class)
private fun ComposeUiTest.primaryImage(text: String): ImageBitmap =
    onAllNodes(hasClickAction() and hasText(text, substring = true, ignoreCase = true))[0].captureToImage()

private val primaryScreen: @Composable () -> Unit = {
    PolarisGateScreen(PolarisGateUi(license = im.plrs.key.core.LicenseState(im.plrs.key.core.LicenseStatus.needsActivation), nowSeconds = 1_790_000_000L), PolarisActivationUi(), onSignIn = {})
}

class PresetIdentityContrastTest {
    private fun solid(hex: String, dark: Boolean) = colorOf(PolarisAccent.resolve(hex, dark)!!.solid)

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun thePresentationGivesTheAccentAndTheIconWithNoIntegratorCode() {
        val red = 0xFFE53935.toInt()
        val member = Presentation(
            name = "Tidewater Studio", developerName = "Harbor Audio", accent = "#26847a", accentDark = "#5cc4b8",
            icon = PresentationIcon(sha256 = "a".repeat(64), contentType = "image/png", original = "https://img.plrs.im/tidewater/a/x"),
        )
        val source = FakePresentation(member, png(red))
        for (chrome in matrixChromes) withPlatform(chrome) {
            for (dark in listOf(false, true)) {
                var developer: String? = null
                var primary: Color? = null
                matrixFrame(
                    820, 1180, dark = dark,
                    theme = { inner -> PolarisTheme(darkTheme = dark, presentation = source, copy = PolarisCopy(productName = "Tidewater Studio")) { inner() } },
                    content = {
                        developer = PolarisTheme.current.developer
                        primary = MaterialTheme.colorScheme.primary
                        Column {
                            PolarisProductIcon(120.dp, Modifier)
                            PolarisPrimaryButton("Go", {}, Modifier)
                        }
                    },
                    after = {
                        // The decode runs off the UI thread: let it land.
                        var iconShown = false
                        repeat(100) {
                            waitForIdle(); mainClock.advanceTimeBy(100)
                            val map = onAllNodes(androidx.compose.ui.test.isRoot())[0].captureToImage().toPixelMap()
                            iconShown = (0 until map.width step 7).any { x -> (0 until map.height step 7).any { y -> map[x, y].near(Color(red)) } }
                            if (iconShown) return@repeat
                            Thread.sleep(40)
                        }
                        assertTrue(iconShown, "$chrome ${if (dark) "dark" else "light"}: the presentation icon is drawn")
                        assertEquals("Harbor Audio", developer, "$chrome: the developer comes from the presentation")
                        val expected = solid(if (dark) "#5cc4b8" else "#26847a", dark)
                        assertTrue(primary!!.near(expected, 1f / 255f), "$chrome ${if (dark) "dark" else "light"}: primary $primary is the presentation's accent $expected")
                    },
                )
            }
        }
    }

    /** UI-KITS.md §3.1: every field, and what the Kotlin theme does with it. A gap is explicit, never silent. */
    @Test
    fun everyThemeFieldIsMappedOrAnExplicitGap() {
        // field -> the PolarisTheme parameter (or the platform property) that carries it.
        val carried = mapOf(
            "preset" to "branding", "colorScheme" to "darkTheme", "accent" to "accent", "product" to "logo, developer, deviceCodeUrl, presentation",
            "copy" to "copy", "poweredBy" to "showPoweredBy, poweredByStyle", "platform" to "-Dpkey.kit.platform",
        )
        val gaps = setOf("serviceCues", "colors", "radius", "typography", "density", "motion", "ambient")
        val spec = listOf(
            "preset", "colorScheme", "accent", "serviceCues", "colors", "radius", "typography", "density", "motion", "ambient", "product", "copy", "poweredBy", "platform",
        )
        assertEquals(spec.toSet(), carried.keys + gaps, "every §3.1 row is carried or a recorded gap")

        // preset: neutral keeps the host's primary, branded takes the brand's.
        val seen = HashMap<String, Any?>()
        fun probe(key: String, dark: Boolean = false, branding: PolarisBranding = PolarisBranding.PolarisKey, accent: Color? = null, powered: Boolean = false, url: String? = null) =
            matrixFrame(
                820, 1180, dark = dark,
                theme = { inner ->
                    PolarisTheme(branding = branding, darkTheme = dark, accent = accent, showPoweredBy = powered, deviceCodeUrl = url,
                        copy = PolarisCopy(productName = "Tidewater Studio"), developer = "Harbor Audio", logo = { BoardFixtures.TidewaterIcon() }, content = inner)
                },
                content = {
                    seen["$key.primary"] = MaterialTheme.colorScheme.primary
                    seen["$key.background"] = MaterialTheme.colorScheme.background
                    seen["$key.cfg"] = PolarisTheme.current
                },
                after = {},
            )
        probe("branded")
        probe("neutral", branding = PolarisBranding.None)
        assertNotEquals(seen["branded.primary"], seen["neutral.primary"], "preset")
        probe("light"); probe("dark", dark = true)
        assertTrue((seen["light.background"] as Color).luminance() > (seen["dark.background"] as Color).luminance(), "colorScheme")
        probe("accent", accent = Color(0xFFFF6A3D))
        assertTrue((seen["accent.primary"] as Color).near(solid("#ff6a3d", false), 1f / 255f), "accent")
        probe("product", url = "tidewater.example/tv")
        val cfg = seen["product.cfg"] as PolarisUiConfig
        assertEquals("Harbor Audio", cfg.developer); assertEquals("tidewater.example/tv", cfg.deviceCodeUrl); assertTrue(cfg.logo != null)
        assertEquals("Tidewater Studio", cfg.copy.productName, "copy")
        probe("powered", powered = true)
        assertTrue((seen["powered.cfg"] as PolarisUiConfig).showPoweredBy, "poweredBy")
        for ((name, variant) in mapOf("Windows" to PolarisPlatformVariant.Windows, "Gnome" to PolarisPlatformVariant.Gnome, "MacOS" to PolarisPlatformVariant.MacOS)) {
            withPlatform(name) { assertEquals(variant, autoPlatformVariant(), "platform $name") }
        }
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theLabelOnTheAccentFillIsReadableOnTheRender() {
        val failures = mutableListOf<String>()
        for (hex in listOf("#ff6a3d", "#1b2a6b")) for (chrome in matrixChromes) withPlatform(chrome) {
            for (dark in listOf(false, true)) matrixFrame(
                820, 1180, dark = dark,
                theme = { inner -> PolarisTheme(darkTheme = dark, accent = colorOf(hex), copy = PolarisCopy(productName = "Tidewater Studio"), content = inner) },
                content = primaryScreen,
                after = {
                    val (fill, label) = fillAndLabel(primaryImage("sign in"))
                    val r = ratio(fill, label)
                    // Large, bold UI text and a 3:1 fill: the label must clear 4.5:1 on the fill, the fill 3:1 on the page.
                    if (r < 4.5) failures += "$chrome $hex ${if (dark) "dark" else "light"}: label $label on fill $fill is ${"%.2f".format(r)}:1"
                    val resolved = solid(hex, dark)
                    if (!fill.near(resolved, 2f / 255f)) failures += "$chrome $hex ${if (dark) "dark" else "light"}: fill $fill is not the resolved $resolved"
                },
            )
        }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun highContrastRendersFullContrast() {
        val failures = mutableListOf<String>()
        for (chrome in matrixChromes) withPlatform(chrome) {
            for (dark in listOf(false, true)) {
                var outline: Color? = null; var onSurface: Color? = null
                matrixFrame(
                    820, 1180, dark = dark, facts = matrixFacts(dark, highContrast = true),
                    theme = { inner -> PolarisTheme(darkTheme = dark, accent = BoardFixtures.tidewaterAccent, copy = PolarisCopy(productName = "Tidewater Studio"), content = inner) },
                    content = {
                        outline = MaterialTheme.colorScheme.outline; onSurface = MaterialTheme.colorScheme.onSurface
                        primaryScreen()
                    },
                    after = {
                        val tag = "$chrome ${if (dark) "dark" else "light"}"
                        val (fill, label) = fillAndLabel(primaryImage("sign in"))
                        // Windows draws the system colours (7:1 and up); GNOME and the Mac keep the product's accent resolved to 4.5:1 and add full-contrast hairlines.
                        if (ratio(fill, label) < (if (chrome == "Windows") 7.0 else 4.45)) failures += "$tag: label ${"%.2f".format(ratio(fill, label))}:1 on the primary under high contrast"
                        if (outline != onSurface) failures += "$tag: hairlines $outline are not the text colour $onSurface"
                        if (chrome == "Windows") {
                            val page = onAllNodes(androidx.compose.ui.test.isRoot())[0].captureToImage().toPixelMap()[2, 2]
                            val want = if (dark) Color.Black else Color.White // polaris-lint: allow-colour (the stock contrast themes' window colour)
                            if (!page.near(want)) failures += "$tag: the page is $page, not the contrast theme's window"
                        }
                    },
                )
            }
        }
        assertTrue(failures.isEmpty(), "\n" + failures.joinToString("\n"))
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun reducedTransparencyRendersOpaqueAndTheSameAsDefault() {
        // K5: no chrome draws Mica, acrylic or a translucent surface, so the flag changes nothing and every pixel is opaque.
        for (chrome in matrixChromes) withPlatform(chrome) {
            for (dark in listOf(false, true)) {
                val frames = listOf(false, true).map { reduced ->
                    var shot: ImageBitmap? = null
                    var scheme: androidx.compose.material3.ColorScheme? = null
                    matrixFrame(
                        820, 1180, dark = dark, facts = matrixFacts(dark, reducedTransparency = reduced),
                        theme = { inner -> PolarisTheme(darkTheme = dark, accent = BoardFixtures.tidewaterAccent, copy = PolarisCopy(productName = "Tidewater Studio"), content = inner) },
                        content = { scheme = MaterialTheme.colorScheme; primaryScreen() },
                        after = { shot = onAllNodes(androidx.compose.ui.test.isRoot())[0].captureToImage() },
                    )
                    shot!! to scheme!!
                }
                val tag = "$chrome ${if (dark) "dark" else "light"}"
                val (plain, reduced) = frames[0].first.toPixelMap() to frames[1].first.toPixelMap()
                var different = 0; var translucent = 0
                for (x in 0 until plain.width step 3) for (y in 0 until plain.height step 3) {
                    if (plain[x, y] != reduced[x, y]) different++
                    if (reduced[x, y].alpha < 1f) translucent++
                }
                assertEquals(0, different, "$tag: reduced transparency changes no pixel (the chrome is already opaque)")
                assertEquals(0, translucent, "$tag: every pixel is opaque")
                val s = frames[1].second
                for ((n, c) in listOf("background" to s.background, "surface" to s.surface, "primary" to s.primary, "surfaceContainer" to s.surfaceContainer, "surfaceContainerHigh" to s.surfaceContainerHigh)) {
                    assertEquals(1f, c.alpha, "$tag: $n is opaque")
                }
            }
        }
    }
}
