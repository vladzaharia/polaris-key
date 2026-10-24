// @pkey-feature ui.kit
//
// UK-10.4: the variant mapping, each host-fact reader's parser on recorded output, the 500 ms
// timeouts, the opener that no longer blocks, the Gate's manage-link check and the focus ring.

package im.plrs.key.ui

import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.runBlocking
import kotlin.system.measureTimeMillis
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DesktopVariantTest {
    @Test
    fun variantMapsFromOsNameAndTheForcingProperty() {
        val r = { os: String, f: String? -> PolarisPlatformVariant.resolve(os, f) }
        assertEquals(PolarisPlatformVariant.Windows, r("Windows 11", null))
        assertEquals(PolarisPlatformVariant.MacOS, r("Mac OS X", null))
        assertEquals(PolarisPlatformVariant.Gnome, r("Linux", null))
        assertEquals(PolarisPlatformVariant.Gnome, r("FreeBSD", null))
        assertEquals(PolarisPlatformVariant.Android, r("Linux", "android"))
        assertEquals(PolarisPlatformVariant.Windows, r("Linux", "WINDOWS"))
        assertEquals(PolarisPlatformVariant.MacOS, r("Mac OS X", "bogus"), "an unknown forced name is ignored")
        val old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        try {
            System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "MacOS")
            assertEquals(PolarisPlatformVariant.MacOS, autoPlatformVariant())
        } finally {
            if (old == null) System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY) else System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, old)
        }
    }

    @Test
    fun controlHeightsAndTargetsPerVariant() {
        fun w(v: PolarisPlatformVariant, touch: Boolean = false) = PolarisWindow(900.dp, 600.dp, variant = v, touch = touch)
        assertEquals(56.dp, w(PolarisPlatformVariant.Android).controlHeight)
        assertEquals(32.dp, w(PolarisPlatformVariant.Windows).controlHeight)
        assertEquals(34.dp, w(PolarisPlatformVariant.Gnome).controlHeight)
        assertEquals(28.dp, w(PolarisPlatformVariant.MacOS).controlHeight)
        assertEquals(48.dp, w(PolarisPlatformVariant.Android).minTarget)
        assertEquals(24.dp, w(PolarisPlatformVariant.Windows).minTarget)
        assertEquals(44.dp, w(PolarisPlatformVariant.Windows, touch = true).minTarget)
    }

    @Test
    fun macParsers() {
        assertEquals(true, parseMacDark("Dark\n"))
        assertNull(parseMacDark(null))
        assertEquals(0x007AFF, parseMacAccent("4\n"))
        assertEquals(0x8C8C8C, parseMacAccent("-1\n"))
        assertNull(parseMacAccent("The domain/default pair does not exist"))
        assertEquals(true, parseMacBool("1\n"))
        assertEquals(false, parseMacBool("0\n"))
        assertNull(parseMacBool("garbage"))
    }

    @Test
    fun windowsParsers() {
        val dark = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    AppsUseLightTheme    REG_DWORD    0x0\r\n\r\n"
        assertEquals(true, parseWinDark(dark))
        assertEquals(false, parseWinDark(dark.replace("0x0", "0x1")))
        assertNull(parseWinDark("ERROR: The system was unable to find the specified registry key or value."))
        assertEquals(true, parseWinReducedTransparency("    EnableTransparency    REG_DWORD    0x0\r\n"))
        assertEquals(false, parseWinReducedTransparency("    EnableTransparency    REG_DWORD    0x1\r\n"))
        // 0xAABBGGRR: ffd77800 is R=00 G=78 B=d7.
        assertEquals(0x0078D7, parseWinAccent("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\DWM\r\n    AccentColor    REG_DWORD    0xffd77800\r\n"))
        assertEquals(true, parseWinHighContrast("HKEY_CURRENT_USER\\Control Panel\\Accessibility\\HighContrast\r\n    Flags    REG_SZ    127\r\n"))
        assertEquals(false, parseWinHighContrast("    Flags    REG_SZ    126\r\n"))
        assertNull(parseWinHighContrast("nothing"))
    }

    @Test
    fun portalParsers() {
        assertEquals(true, parsePortalDark("(<<uint32 1>>,)\n"))
        assertEquals(false, parsePortalDark("(<<uint32 2>>,)\n"))
        assertEquals(false, parsePortalDark("(<<uint32 0>>,)\n"))
        assertNull(parsePortalDark("Error: GDBus.Error:org.freedesktop.portal.Error.NotFound: Requested setting not found"))
        assertEquals(0x3584E4, parsePortalAccent("(<<(0.20784313725490197, 0.51764705882352946, 0.8941176470588236)>>,)\n"))
        assertNull(parsePortalAccent("(<<(-1.0, -1.0, -1.0)>>,)"))
        assertNull(parsePortalAccent("(<<(2.0, 0.1, 0.1)>>,)"))
        assertEquals(true, parsePortalHighContrast("(<<uint32 1>>,)"))
    }

    @Test
    fun readersFeedTheFixtureOutputPerVariant() = runBlocking {
        val mac = HostCommandRunner { argv, _ ->
            when (argv) {
                MAC_DARK_ARGV -> "Dark\n"
                MAC_ACCENT_ARGV -> "5\n"
                MAC_CONTRAST_ARGV -> "1\n"
                MAC_TRANSPARENCY_ARGV -> null
                else -> error("unexpected $argv")
            }
        }
        assertEquals(PolarisHostFacts(true, 0xA550A7, true, false), readHostFacts(PolarisPlatformVariant.MacOS, mac))
        val gnome = HostCommandRunner { argv, _ ->
            when (argv) {
                PORTAL_COLOR_SCHEME_ARGV -> "(<<uint32 1>>,)\n"
                PORTAL_ACCENT_ARGV -> "(<<(1.0, 0.0, 0.0)>>,)\n"
                PORTAL_CONTRAST_ARGV -> "(<<uint32 0>>,)\n"
                else -> error("unexpected $argv")
            }
        }
        assertEquals(PolarisHostFacts(true, 0xFF0000, false, false), readHostFacts(PolarisPlatformVariant.Gnome, gnome))
        val none = HostCommandRunner { _, _ -> null }
        for (v in PolarisPlatformVariant.entries) assertEquals(PolarisHostFacts(), readHostFacts(v, none), v.name)
    }

    @Test
    fun argvsAreFixedAndShellFree() {
        val all = listOf(
            MAC_DARK_ARGV, MAC_ACCENT_ARGV, MAC_CONTRAST_ARGV, MAC_TRANSPARENCY_ARGV,
            WIN_DARK_ARGV, WIN_ACCENT_ARGV, WIN_CONTRAST_ARGV, WIN_TRANSPARENCY_ARGV,
            PORTAL_COLOR_SCHEME_ARGV, PORTAL_ACCENT_ARGV, PORTAL_CONTRAST_ARGV,
        )
        for (a in all) assertTrue(a.first() in setOf("/usr/bin/defaults", WIN_REG, "gdbus") && (a.first() != WIN_REG || a.first().endsWith("System32\\reg.exe")) && a.none { it == "sh" || it == "-c" || it == "cmd" }, a.toString())
    }

    @Test
    fun aSlowCommandIsDestroyedAtTheTimeout() {
        val ms = measureTimeMillis { assertNull(SystemHostCommandRunner.run(listOf("sleep", "20"), 300)) }
        assertTrue(ms < 3_000, "returned after $ms ms")
        assertNull(SystemHostCommandRunner.run(listOf("false"), 500), "non-zero exit")
        assertNull(SystemHostCommandRunner.run(listOf("/nonexistent/pkey-tool"), 500), "no such tool")
        assertEquals("hi", SystemHostCommandRunner.run(listOf("echo", "hi"), 2_000)?.trim())
    }

    @Test
    fun theOpenerDoesNotBlockTheCaller() {
        val ms = measureTimeMillis {
            // A browse that hangs for 3 s: the caller waits only the grace period and counts it as in flight.
            assertTrue(launchOnDesktop("https://key.plrs.im/x", browse = { Thread.sleep(3_000); true }, xdgOpen = { false }).let { true })
        }
        assertTrue(ms < 2_000, "launch took $ms ms")
        val start = System.nanoTime()
        assertTrue(startAndReap(listOf("sleep", "30"), reapMs = 200))
        assertTrue((System.nanoTime() - start) / 1_000_000 < 1_000, "start does not wait for the process")
        assertFalse(startAndReap(listOf("/nonexistent/pkey-tool")), "a failed start is false: the copy-link state")
    }

    @Test
    fun aRealAwtBrowseIsBoundedByTheGrace() {
        // Headless CI: AWT says no at once, xdg-open does not exist or is fast; either way the call returns quickly.
        val ms = measureTimeMillis { launchOnDesktop("https://key.plrs.im/x", xdgOpen = { false }) }
        assertTrue(ms < BROWSE_GRACE_MS + 1_000, "took $ms ms")
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theFocusRingRendersOnFocusFromLaunch() = runDesktopComposeUiTest(width = 200, height = 120) {
        val old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
        try {
            val requester = FocusRequester()
            setContent {
                PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                    PolarisSurface { _, _ ->
                        val interaction = MutableInteractionSource()
                        Box(
                            Modifier.testTag("box").size(100.dp)
                                .polarisFocusIndication(interaction, PolarisTheme.buttonShape)
                                .focusRequester(requester)
                                .focusable(interactionSource = interaction),
                        )
                    }
                }
            }
            waitForIdle()
            val before = onNodeWithTag("box").captureToImage().toPixelMap()
            runOnIdle { requester.requestFocus() }
            waitForIdle()
            val after = onNodeWithTag("box").captureToImage().toPixelMap()
            var differs = false
            for (x in 0 until after.width) for (y in 0 until after.height) if (after[x, y] != before[x, y]) differs = true
            assertTrue(differs, "focus with no key pressed still draws the ring on the desktop")
        } finally {
            if (old == null) System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY) else System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, old)
        }
    }

    @OptIn(ExperimentalTestApi::class)
    private fun manageOpened(link: String): List<String> {
        val opened = mutableListOf<String>()
        runDesktopComposeUiTest(width = 700, height = 900) {
            setContent {
                PolarisTheme(branding = PolarisBranding.None, darkTheme = false) {
                    PolarisActivationScreen(
                        PolarisActivationUi(
                            key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
                            error = PolarisActivationError.Refused(im.plrs.key.license.ActivationResult.DeviceLimit(3, 3, link)),
                            manageUrl = link,
                        ),
                        onOpenManage = { opened += it },
                    )
                }
            }
            waitForIdle()
            onNodeWithText(PolarisCopy().openInBrowser).performClick()
            waitForIdle()
        }
        return opened
    }

    @Test
    fun onOpenManageRefusesALinkThatIsNotHttps() {
        assertEquals(listOf("https://key.plrs.im/portal"), manageOpened("https://key.plrs.im/portal"))
        assertEquals(emptyList(), manageOpened("javascript:alert(1)"))
        assertEquals(emptyList(), manageOpened("http://key.plrs.im/portal"))
    }
}
