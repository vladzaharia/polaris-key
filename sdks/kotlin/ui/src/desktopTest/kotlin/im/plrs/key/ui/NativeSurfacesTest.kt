// @pkey-feature ui.kit
//
// UK-10.5/.6 fix round: the polaris-key preset keeps the brand surfaces; the native preset
// (PolarisBranding.None) draws the platform's neutral layers on Windows and GNOME; a dark GNOME
// dialog sits on the raised tone, never the page's.

package im.plrs.key.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runDesktopComposeUiTest
import im.plrs.key.ui.brand.PolarisBrandTokens
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

@OptIn(ExperimentalTestApi::class)
class NativeSurfacesTest {
    private fun rgb(c: Color) = c.toArgb() and 0xFFFFFF

    private fun schemeOf(variant: String, branding: PolarisBranding, dark: Boolean): androidx.compose.material3.ColorScheme = withPlatform(variant) {
        lateinit var scheme: androidx.compose.material3.ColorScheme
        runDesktopComposeUiTest(width = 100, height = 100) {
            setContent { PolarisTheme(branding = branding, darkTheme = dark) { scheme = MaterialTheme.colorScheme } }
            waitForIdle()
        }
        scheme
    }

    @Test
    fun nativeWindowsUsesMicaAndLayer() {
        val dark = schemeOf("Windows", PolarisBranding.None, true)
        assertEquals(0x202227, rgb(dark.background))
        assertEquals(0x2B2D33, rgb(dark.surfaceContainerLow))
        val light = schemeOf("Windows", PolarisBranding.None, false)
        assertEquals(0xEEF1F4, rgb(light.background))
        assertEquals(0xF9F9FB, rgb(light.surfaceContainerLow))
    }

    @Test
    fun nativeGnomeUsesLibadwaitaPageAndCard() {
        val dark = schemeOf("Gnome", PolarisBranding.None, true)
        assertEquals(0x222226, rgb(dark.background))
        assertEquals(0x2E2E32, rgb(dark.surfaceContainerLow))
        assertEquals(0x2E2E32, rgb(dark.surfaceContainerHigh))
    }

    @Test
    fun theBrandPresetKeepsTheBrandSurfaces() {
        for (variant in listOf("Windows", "Gnome")) {
            assertEquals(rgb(PolarisBrandTokens.Dark.surfacePage), rgb(schemeOf(variant, PolarisBranding.PolarisKey, true).background), variant)
            assertEquals(rgb(PolarisBrandTokens.Light.surfacePage), rgb(schemeOf(variant, PolarisBranding.PolarisKey, false).background), variant)
        }
    }

    @Test
    fun aDarkGnomeDialogIsNotThePageColour() = withPlatform("Gnome") {
        for (branding in PolarisBranding.entries) {
            runDesktopComposeUiTest(width = 100, height = 100) {
                var page = Color.Unspecified
                var dialog = Color.Unspecified
                setContent {
                    PolarisTheme(branding = branding, darkTheme = true) {
                        page = MaterialTheme.colorScheme.background
                        dialog = polarisGnomeDialogColor()
                    }
                }
                waitForIdle()
                assertNotEquals(page, dialog, "$branding: a dark overlay is raised off the page")
            }
        }
    }
}
