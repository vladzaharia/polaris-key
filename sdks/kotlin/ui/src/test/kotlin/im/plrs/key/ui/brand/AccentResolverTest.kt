// The Kotlin port of the accent resolver (UI-KITS.md §3.3) against the shared vectors
// (AccentVectors.generated.kt, from packages/brand/fixtures/accent-vectors.json), and the kit
// tokens (PolarisKitTokens.generated.kt) against the spec's table.

package im.plrs.key.ui.brand

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AccentResolverTest {
    @Test
    fun deriveVectors() {
        for (v in AccentVectors.derive) {
            val bytes = ArrayList<Byte>()
            for (run in v.pixels) repeat(run[4]) { for (c in 0 until 4) bytes.add(run[c].toByte()) }
            assertEquals(v.name, v.expect, PolarisAccent.derive(bytes.toByteArray()))
        }
    }

    @Test
    fun resolveVectors() {
        for (v in AccentVectors.resolve) {
            val r = PolarisAccent.resolve(v.input, v.dark)
            assertNotNull(v.name, r)
            val scheme = if (v.dark) "dark" else "light"
            assertEquals("${v.name} $scheme solid", v.solid, r!!.solid)
            assertEquals("${v.name} $scheme on", v.on, r.on)
            assertEquals("${v.name} $scheme fg", v.fg, r.fg)
            assertEquals("${v.name} $scheme subtle", v.subtle, r.subtle)
            assertEquals("${v.name} $scheme focus", v.focus, r.focus)
        }
    }

    @Test
    fun dangerSolidKeepsAWhiteLabel() {
        for (v in AccentVectors.danger) {
            assertEquals(v.solid, PolarisAccent.solid(v.input, v.dark, PolarisAccent.Label.WHITE))
            assertTrue(PolarisAccent.contrast(PolarisAccent.WHITE, v.solid) >= 4.5)
        }
    }

    /** The pinned rule: a product's primary label is the same colour in both schemes. */
    @Test
    fun onIsTheSameInBothSchemes() {
        for (v in AccentVectors.resolve) {
            assertEquals(v.name, PolarisAccent.resolve(v.input, true)!!.on, PolarisAccent.resolve(v.input, false)!!.on)
        }
    }

    @Test
    fun invalidInputResolvesToNull() {
        assertNull(PolarisAccent.resolve("teal", true))
        assertNull(PolarisAccent.resolve("#12345", true))
        assertNotNull(PolarisAccent.resolve("#F60", true))
    }

    @Test
    fun kitTokensAreTheSpecTable() {
        assertEquals(56f, PolarisKitTokens.Android.controlHeight)
        assertEquals(KitRadius.Capsule, PolarisKitTokens.Android.radiusControl)
        assertEquals(28f, PolarisKitTokens.Android.radiusSheet)
        assertEquals(24f, PolarisKitTokens.Android.radiusListOuter)
        assertEquals(6f, PolarisKitTokens.Android.radiusListInner)
        assertEquals(24f, PolarisKitTokens.Android.cardPad)
        assertEquals(0.6f, PolarisKitTokens.Android.scrimDarkOpacity)
        assertEquals(KitTypeRole(36f, 44f, 600, 0f, false), PolarisKitTokens.Android.Typography.display)
        assertEquals(KitTypeRole(32f, 40f, 500, 0.06f, true), PolarisKitTokens.Android.Typography.code)
        assertEquals(32f, PolarisKitTokens.Windows.controlHeight)
        assertEquals(KitRadius.Fixed(4f), PolarisKitTokens.Windows.radiusControl)
        assertEquals(34f, PolarisKitTokens.Gnome.controlHeight)
        assertEquals(16f, PolarisKitTokens.concentricRadius(22f, 6f))
        assertEquals(8f, PolarisKitTokens.concentricRadius(10f, 6f))
    }

    /** The committed kit tokens and vectors are the generator's (pnpm gen:brand -- --check owns them). */
    @Test
    fun theGeneratedFilesAreTheGenerators() {
        val repo = File(System.getProperty("pkey.repoRoot") ?: "../../..")
        val module = repo.resolve("sdks/kotlin/ui")
        val tokens = module.resolve("src/main/kotlin/im/plrs/key/ui/brand/PolarisKitTokens.generated.kt").readText()
        assertTrue(tokens.startsWith("// GENERATED FILE — do not edit by hand."))
        val vectors = module.resolve("src/test/kotlin/im/plrs/key/ui/brand/AccentVectors.generated.kt").readText()
        assertTrue(vectors.startsWith("// GENERATED FILE — do not edit by hand."))
        val json = repo.resolve("packages/brand/fixtures/accent-vectors.json")
        if (json.isFile) {
            // Every expected hex in the shared fixture appears in the Kotlin literals.
            val expected = Regex("\"(?:solid|on|fg|subtle|focus|expect|input)\": (\"#[0-9a-f]{3,6}\")")
            val hexes = expected.findAll(json.readText()).map { it.groupValues[1] }.toSet()
            assertTrue(hexes.size > 20)
            for (hex in hexes) assertTrue(hex, vectors.contains(hex))
        }
        for (font in listOf("polaris_rubik_variable.ttf", "polaris_jetbrains_mono_variable.ttf")) {
            assertTrue(font, module.resolve("src/main/res/font/$font").length() > 100_000)
        }
        assertTrue(module.resolve("src/main/assets/polaris-key/fonts/OFL-JetBrainsMono.txt").isFile)
    }
}
