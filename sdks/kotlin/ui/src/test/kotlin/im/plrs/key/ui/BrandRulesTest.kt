// The brand rules the kit must keep, as tests:
//   - neutral means inherited: no colour literal, font or corner shape in :ui outside the generated
//     token file and the theme (a lint-style scan of the sources);
//   - the generated token file and fonts are the brand generator's (pnpm gen brand --check owns
//     their content; here: the banner, and the OFL travelling with the fonts);
//   - the branded palette's text and indicator pairs meet WCAG contrast in both themes.

package im.plrs.key.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import im.plrs.key.ui.brand.PolarisBrandTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class BrandRulesTest {
    private val module: File = File(System.getProperty("pkey.repoRoot") ?: "../../..").resolve("sdks/kotlin/ui")
    private val sources: List<File> = module.resolve("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

    @Test
    fun noColourLiteralsOutsideTheGeneratedTokens() {
        val literal = Regex("""Color\(\s*0x|Color\(\s*(red|[0-9])|#[0-9A-Fa-f]{6}\b|Color\.(Black|White|Red|Green|Blue|Gray|Grey|DarkGray|LightGray|Yellow|Cyan|Magenta)\b""")
        val problems = sources.filterNot { it.name.endsWith(".generated.kt") }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                if (literal.containsMatchIn(line) && !line.contains("polaris-lint: allow-colour")) "${file.name}:${i + 1}: ${line.trim()}" else null
            }
        }
        assertTrue("colour literals outside the generated tokens:\n" + problems.joinToString("\n"), problems.isEmpty())
        assertTrue(sources.size >= 10)
    }

    @Test
    fun fontsAndShapesComeFromTheTheme() {
        val font = Regex("""\bFont\(|FontFamily\((?!\))|RoundedCornerShape\(|CutCornerShape\(""")
        val allowed = setOf("PolarisTypography.kt", "PolarisTheme.kt", "PolarisBrandTokens.generated.kt", "PolarisKitTokens.generated.kt")
        val problems = sources.filterNot { it.name in allowed }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line -> if (font.containsMatchIn(line)) "${file.name}:${i + 1}: ${line.trim()}" else null }
        }
        assertTrue("fonts or shapes set outside the theme:\n" + problems.joinToString("\n"), problems.isEmpty())
    }

    @Test
    fun theGeneratedFilesAreTheGenerators() {
        val tokens = module.resolve("src/main/kotlin/im/plrs/key/ui/brand/PolarisBrandTokens.generated.kt").readText()
        assertTrue(tokens.startsWith("// GENERATED FILE — do not edit by hand."))
        assertTrue(tokens.contains("pnpm gen brand --check"))
        for (font in listOf("polaris_rubik_regular.ttf", "polaris_rubik_bold.ttf")) {
            assertTrue(font, module.resolve("src/main/res/font/$font").length() > 10_000)
        }
        // OFL 1.1: the licence travels with the fonts, inside every APK that carries them.
        val ofl = module.resolve("src/main/assets/polaris-key/fonts/OFL.txt").readText()
        assertTrue(ofl.contains("SIL OPEN FONT LICENSE"))
        assertTrue(module.resolve("src/main/assets/polaris-key/fonts/FONT-NOTICE.txt").isFile)
    }

    @Test
    fun theBrandMarksAreTheKitArtwork() {
        val k = PolarisBrandTokens
        assertEquals(96f, im.plrs.key.ui.brand.PolarisBrandMarkData.pinnedKDark.width)
        assertEquals(k.badgeMinCompact.width, im.plrs.key.ui.brand.PolarisBrandMarkData.poweredByCompactDark.width)
        assertEquals("display", k.opticalCut(56f))
        assertEquals("Powered by Polaris Key", k.POWERED_BY_PHRASE)
        assertEquals(k.POWERED_BY_PHRASE, PolarisCopy().poweredBy)
        // The display cut carries no terminal bit: three shapes, none of them gold.
        val paths = (im.plrs.key.ui.brand.PolarisBrandMarkData.pinnedKDark.nodes.single() as im.plrs.key.ui.brand.BrandVectorNode.Group).children
        assertEquals(3, paths.size)
        assertTrue(paths.none { (it as im.plrs.key.ui.brand.BrandVectorNode.Path).fill == PolarisBrandTokens.Kit.goldDark })
    }

    private fun contrast(a: Color, b: Color): Double {
        val la = a.luminance() + 0.05
        val lb = b.luminance() + 0.05
        return maxOf(la, lb) / minOf(la, lb)
    }

    private fun pairs(s: ColorScheme, status: PolarisStatusColors): List<Triple<String, Pair<Color, Color>, Double>> = listOf(
        Triple("onSurface/surface", s.onSurface to s.surface, 4.5),
        Triple("onSurfaceVariant/surface", s.onSurfaceVariant to s.surface, 4.5),
        Triple("onSurface/surfaceContainerLow", s.onSurface to s.surfaceContainerLow, 4.5),
        Triple("onSurfaceVariant/surfaceContainerLow", s.onSurfaceVariant to s.surfaceContainerLow, 4.5),
        Triple("onSurface/surfaceContainerHigh", s.onSurface to s.surfaceContainerHigh, 4.5),
        Triple("onBackground/background", s.onBackground to s.background, 4.5),
        Triple("onPrimary/primary", s.onPrimary to s.primary, 4.5),
        Triple("primary text/surface", s.primary to s.surface, 4.5),
        Triple("onPrimaryContainer/primaryContainer", s.onPrimaryContainer to s.primaryContainer, 4.5),
        Triple("onSecondaryContainer/secondaryContainer", s.onSecondaryContainer to s.secondaryContainer, 4.5),
        Triple("error/surface", s.error to s.surface, 4.5),
        Triple("onErrorContainer/errorContainer", s.onErrorContainer to s.errorContainer, 4.5),
        Triple("onWarningContainer/warningContainer", status.onWarningContainer to status.warningContainer, 4.5),
        Triple("onSuccessContainer/successContainer", status.onSuccessContainer to status.successContainer, 4.5),
        Triple("onDangerContainer/dangerContainer", status.onDangerContainer to status.dangerContainer, 4.5),
        // Non-text indicators (WCAG 1.4.11): 3:1.
        Triple("warning glyph/warningContainer", status.warning to status.warningContainer, 3.0),
        Triple("danger glyph/dangerContainer", status.danger to status.dangerContainer, 3.0),
        Triple("outline/surface", s.outline to s.surface, 3.0),
        Triple("qr modules/plate", status.qrModules to status.qrPlate, 7.0),
    )

    @Test
    fun theBrandedPaletteMeetsContrast() {
        val failures = mutableListOf<String>()
        for (dark in listOf(true, false)) {
            val scheme = polarisBrandColorScheme(dark)
            for ((name, pair, min) in pairs(scheme, PolarisStatusColors.brand(dark))) {
                val ratio = contrast(pair.first, pair.second)
                if (ratio < min) failures += "${if (dark) "dark" else "light"} $name: %.2f < $min".format(ratio)
            }
            // The section accents the kit draws as indicators read against the page.
            for (id in listOf("license", "update", "release")) {
                val ratio = contrast(PolarisBrandTokens.accent(id, dark).solid, scheme.surface)
                if (ratio < 3.0) failures += "${if (dark) "dark" else "light"} $id accent/surface: %.2f < 3".format(ratio)
            }
        }
        assertTrue("branded contrast failures:\n" + failures.joinToString("\n"), failures.isEmpty())
    }
}
