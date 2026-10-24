// UK-10.2: the desktop actuals of the platform edges. The opener refuses anything but https and
// the icon decoder returns null for garbage.
package im.plrs.key.ui

import androidx.compose.ui.graphics.toComposeImageBitmap
import java.awt.datatransfer.Clipboard
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PlatformEdgesTest {
    private val refused = listOf(
        "http://key.plrs.im/x",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "intent://scan/#Intent;scheme=zxing;end",
        "pkey://activate?code=1",
        "data:text/html,hi",
        "mailto:a@b.c",
        "ftp://key.plrs.im/x",
        "https://user:pw@key.plrs.im/x",
        "https://key.plrs.im@evil.com/x",
        "https://key.plrs.im%40evil.com/x",
        "https://key.plrs.im\\@evil.com/x",
        "https://evil.com\\.key.plrs.im/x",
        "https:///x",
        "https://",
        "https:key.plrs.im",
        " https://key.plrs.im/x",
        "https://key.plrs.im/x y",
        "https://key.plrs.im/\u0000",
        "https://key.plrs.im/\nx",
        "https://[::1]/x",
        "https://exämple.com/",
        "https://key.plrs.im:80a/x",
        "https://key.plrs.im/" + "a".repeat(2100),
        "",
    )
    private val accepted = listOf(
        "https://key.plrs.im/activate?user_code=ABCD-EFGH",
        "HTTPS://key.plrs.im/x",
        "https://key.plrs.im:8443/x#frag",
        "https://key.plrs.im",
        "https://key.plrs.im?q=a@b",
    )

    @Test
    fun theOpenerRefusesAnythingButHttps() {
        val launched = mutableListOf<String>()
        val opener = PolarisOpener { launched += it; true }
        for (url in refused) assertFalse(opener(url), url.take(60))
        assertTrue(launched.isEmpty(), "the platform never saw a refused link: $launched")
        for (url in accepted) assertTrue(opener(url), url)
        assertEquals(accepted, launched)
    }

    @Test
    fun theDesktopLauncherFallsBackToXdgOpenThenToTheCopyLinkState() {
        val url = "https://key.plrs.im/x"
        val xdg = mutableListOf<String>()
        assertTrue(launchOnDesktop(url, browse = { true }, xdgOpen = { xdg += it; true }))
        assertTrue(xdg.isEmpty(), "browse took it")
        assertTrue(launchOnDesktop(url, browse = { false }, xdgOpen = { xdg += it; true }))
        assertEquals(listOf(url), xdg)
        assertFalse(launchOnDesktop(url, browse = { false }, xdgOpen = { false }), "neither took it: the copy-link state")
        // The launcher re-checks the scheme and userinfo behind the opener.
        for (bad in listOf("http://key.plrs.im/x", "file:///etc/passwd", "javascript:alert(1)", "https://a@key.plrs.im/x")) {
            assertFalse(launchOnDesktop(bad, browse = { error("browse $bad") }, xdgOpen = { error("xdg $bad") }), bad)
        }
    }

    @Test
    fun anOpenerWhoseLauncherThrowsAnswersFalse() {
        assertFalse(PolarisOpener { error("no browser") }("https://key.plrs.im/x"))
    }

    @Test
    fun theClipboardRoundTripsText() = runBlocking {
        val system = Clipboard("test")
        val board = DesktopClipboard { system }
        assertNull(board.getText())
        assertTrue(board.setText("Copy link", "https://key.plrs.im/x"))
        assertEquals("https://key.plrs.im/x", board.getText())
        assertFalse(DesktopClipboard { null }.setText("x", "y"), "no clipboard (headless): false, not a throw")
    }

    @Test
    fun theIconDecodes() {
        val img = BufferedImage(8, 4, BufferedImage.TYPE_INT_ARGB)
        val png = ByteArrayOutputStream().also { ImageIO.write(img, "png", it) }.toByteArray()
        val bitmap = assertNotNull(decodeIcon(png))
        assertEquals(8, bitmap.width)
        assertEquals(4, bitmap.height)
        assertNull(decodeIcon(png, maxSide = 7), "a side over the limit")
    }

    @Test
    fun garbageIsNotAnIcon() {
        assertNull(decodeIcon(ByteArray(0)))
        assertNull(decodeIcon("not an image".toByteArray()))
        assertNull(decodeIcon(ByteArray(64) { it.toByte() }))
    }
}
