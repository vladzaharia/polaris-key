// The desktop actuals of the kit's platform edges (UK-10.2): a real opener, clipboard, icon decoder
// and Escape. Reduced motion and television answer false until the host facts land (UK-10.4); the
// desktop draws no QR code (D-67).

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.toAwtImage
import java.awt.GraphicsEnvironment
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import java.util.prefs.Preferences
import java.awt.Toolkit
import java.awt.datatransfer.Clipboard
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.Desktop
import java.net.URI
import java.util.concurrent.TimeUnit

/** The AWT clipboard; [clipboard] is the system one unless a test passes its own. */
internal class DesktopClipboard(private val clipboard: () -> Clipboard? = ::systemClipboard) : PolarisClipboard {
    override suspend fun setText(label: String, text: String): Boolean = runCatching {
        val c = clipboard() ?: return false
        c.setContents(StringSelection(text), null)
        true
    }.getOrDefault(false)

    override suspend fun getText(): String? = runCatching {
        val c = clipboard() ?: return null
        if (c.isDataFlavorAvailable(DataFlavor.stringFlavor)) c.getData(DataFlavor.stringFlavor) as? String else null
    }.getOrNull()
}

private fun systemClipboard(): Clipboard? =
    if (GraphicsEnvironment.isHeadless()) null else Toolkit.getDefaultToolkit().systemClipboard

@Composable
public actual fun rememberPolarisClipboard(): PolarisClipboard = remember { DesktopClipboard() }

/**
 * Opens [url] with `Desktop.browse`, then `xdg-open`; false when neither took it, which the screens
 * turn into the copy-link state (`signin.handoff.noBrowser`). The link is re-parsed here as a second
 * check behind [PolarisOpener]; [xdgOpen] gets the parsed link, never anything else, as one argv entry.
 */
internal fun launchOnDesktop(
    url: String,
    browse: (URI) -> Boolean = ::awtBrowse,
    xdgOpen: (String) -> Boolean = ::runXdgOpen,
): Boolean {
    val uri = try { URI(url) } catch (e: Exception) { return false }
    if (!"https".equals(uri.scheme, ignoreCase = true) || uri.host.isNullOrEmpty() || uri.userInfo != null) return false
    if (browse(uri)) return true
    return xdgOpen(uri.toASCIIString())
}

private fun awtBrowse(uri: URI): Boolean = runCatching {
    if (GraphicsEnvironment.isHeadless() || !Desktop.isDesktopSupported() || !Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) return false
    Desktop.getDesktop().browse(uri)
    true
}.getOrDefault(false)

/** `xdg-open <https link>` on Linux and the BSDs: fixed argv, no shell; the link starts with `https:`, so it is never an option. */
private fun runXdgOpen(url: String): Boolean {
    val os = System.getProperty("os.name").orEmpty().lowercase()
    if (os.contains("win") || os.contains("mac")) return false
    return runCatching {
        val p = ProcessBuilder("xdg-open", url)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start()
        if (p.waitFor(5, TimeUnit.SECONDS)) p.exitValue() == 0 else true
    }.getOrDefault(false)
}

@Composable
public actual fun rememberPolarisOpener(): PolarisOpener = remember { PolarisOpener { launchOnDesktop(it) } }

@Composable
internal actual fun PolarisBackHandler(enabled: Boolean, onBack: () -> Unit): Modifier {
    val current = androidx.compose.runtime.rememberUpdatedState(onBack)
    return Modifier.onKeyEvent { event ->
        if (enabled && event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
            current.value()
            true
        } else {
            false
        }
    }
}

@Composable
internal actual fun rememberSystemReduceMotion(): Boolean = false

@Composable
internal actual fun isTelevision(): Boolean = false

internal actual fun decodeIcon(bytes: ByteArray, targetPx: Int, maxSide: Int): ImageBitmap? = runCatching {
    val image = org.jetbrains.skia.Image.makeFromEncoded(bytes)
    try {
        if (image.width < 1 || image.height < 1 || image.width > maxSide || image.height > maxSide) null
        else image.toComposeImageBitmap()
    } finally {
        image.close()
    }
}.getOrNull()

@Composable
internal actual fun PolarisQr(content: String, contentDescription: String, modifier: Modifier) = Unit

@Composable
internal actual fun systemLocaleTag(): String = java.util.Locale.getDefault().toLanguageTag()

@Composable
internal actual fun ownFormFactor(): String = "desktop"

// No one-off announcement call on the desktop yet: the live regions the screens carry are the channel.
@Composable
internal actual fun rememberPolarisAnnouncer(): (String) -> Unit = remember { { _: String -> } }

@Composable
internal actual fun rememberUpdatePrefs(): PolarisUpdatePrefs = remember {
    // The user's preferences node; where it cannot be read or written the choice lasts for the run.
    val node = runCatching { Preferences.userRoot().node("im/plrs/key/ui/update") }.getOrNull()
    PolarisUpdatePrefs(
        skippedVersion = runCatching { node?.get("skipped_version", null) }.getOrNull(),
        saveSkipped = { version ->
            runCatching { node?.put("skipped_version", version) }
        },
    )
}

// The desktop has no string resources to translate from: the English defaults.
@Composable
internal actual fun polarisLocalizedCopy(): PolarisCopy = remember { PolarisCopy() }

internal actual fun thumbnailArgb32(image: ImageBitmap): IntArray {
    val thumb = BufferedImage(32, 32, BufferedImage.TYPE_INT_ARGB)
    val g = thumb.createGraphics()
    try {
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.drawImage(image.toAwtImage(), 0, 0, 32, 32, null)
    } finally {
        g.dispose()
    }
    return thumb.getRGB(0, 0, 32, 32, null, 0, 32)
}

// A Compose dialog draws no window dim on the desktop; the kit's own scrim is inside the dialog.
@Composable
internal actual fun PolarisDialogDim(amount: Float) = Unit

@Composable
internal actual fun rememberHeldSignIn(key: Any, actions: PolarisSignInActions, onSignedIn: () -> Unit): PolarisSignInState {
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(onSignedIn)
    val state = remember(key, scope) { PolarisSignInState(actions, scope, onSignedIn = { latest() }) }
    DisposableEffect(state) { onDispose { state.cancel() } }
    return state
}
