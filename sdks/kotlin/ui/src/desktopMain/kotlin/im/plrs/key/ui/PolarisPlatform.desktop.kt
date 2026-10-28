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
import kotlinx.coroutines.flow.first
import java.awt.Desktop
import java.net.URI
import java.util.concurrent.TimeUnit

/** The AWT clipboard; [clipboard] is the system one unless a test passes its own. */
internal class DesktopClipboard(private val clipboard: () -> Clipboard? = ::systemClipboard) : PolarisClipboard {
    override suspend fun setText(label: String, text: String, sensitive: Boolean): Boolean = runCatching {
        val c = clipboard() ?: return false
        c.setContents(StringSelection(text), null)
        true
    }.getOrDefault(false)

    override suspend fun clear(): Boolean = setText("", "", false)

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
 * Called from click handlers, so it never waits on a launcher: see [awtBrowse] and [runXdgOpen].
 */
internal fun launchOnDesktop(
    url: String,
    browse: (URI) -> Boolean = ::awtBrowse,
    xdgOpen: (String) -> Boolean = ::runXdgOpen,
): Boolean {
    val uri = try { URI(url) } catch (e: Exception) { return false }
    if (!"https".equals(uri.scheme, ignoreCase = true) || uri.host.isNullOrEmpty() || uri.userInfo != null) return false
    if (browseBounded(uri, browse)) return true
    return xdgOpen(uri.toASCIIString())
}

/** How long the caller waits for `Desktop.browse` to say no before taking it as in flight. */
internal const val BROWSE_GRACE_MS: Long = 200

/**
 * [browse] (`Desktop.browse`, which can block on the desktop's launcher) runs on its own daemon
 * thread. The caller waits at most [BROWSE_GRACE_MS] for a refusal; a call still running after that
 * is taken as accepted, so a slow launcher never freezes the UI thread.
 */
private fun browseBounded(uri: URI, browse: (URI) -> Boolean): Boolean {
    val result = java.util.concurrent.CompletableFuture<Boolean>()
    val t = Thread { result.complete(runCatching { browse(uri) }.getOrDefault(false)) }
        .apply { isDaemon = true; name = "pkey-browse"; start() }
    return try {
        result.get(BROWSE_GRACE_MS, TimeUnit.MILLISECONDS)
    } catch (e: java.util.concurrent.TimeoutException) {
        true
    } catch (e: Exception) {
        t.interrupt()
        false
    }
}

private fun awtBrowse(uri: URI): Boolean = runCatching {
    if (GraphicsEnvironment.isHeadless() || !Desktop.isDesktopSupported() || !Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) return false
    Desktop.getDesktop().browse(uri)
    true
}.getOrDefault(false)

/** How long a launched `xdg-open` may run before it is destroyed. */
internal const val XDG_OPEN_REAP_MS: Long = 5_000

/**
 * `xdg-open <https link>` on Linux and the BSDs: fixed argv, no shell; the link starts with `https:`,
 * so it is never an option. A successful `start()` is success: nothing waits on the process here. A
 * daemon thread reaps it, and destroys it when it is still running after [XDG_OPEN_REAP_MS].
 */
private fun runXdgOpen(url: String): Boolean {
    val os = System.getProperty("os.name").orEmpty().lowercase()
    if (os.contains("win") || os.contains("mac")) return false
    return startAndReap(listOf("xdg-open", url))
}

internal fun startAndReap(argv: List<String>, reapMs: Long = XDG_OPEN_REAP_MS): Boolean = runCatching {
    val p = ProcessBuilder(argv)
        .redirectErrorStream(true)
        .redirectOutput(ProcessBuilder.Redirect.DISCARD)
        .redirectInput(ProcessBuilder.Redirect.from(java.io.File(if (System.getProperty("os.name").orEmpty().lowercase().contains("win")) "NUL" else "/dev/null")))
        .start()
    Thread {
        try {
            if (!p.waitFor(reapMs, TimeUnit.MILLISECONDS)) {
                p.destroy()
                if (!p.waitFor(1, TimeUnit.SECONDS)) p.destroyForcibly()
            }
        } catch (e: InterruptedException) {
            p.destroyForcibly()
        }
    }.apply { isDaemon = true; name = "pkey-xdg-reap"; start() }
    true
}.getOrDefault(false)

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

// The desktop dialog (CMP 1.8.2) draws its own black 60 % scrim unless told otherwise; a chrome with a
// scrim of its own turns it off (polarisPromptDialogProperties), so this window dim has nothing to set.
@Composable
internal actual fun PolarisDialogDim(amount: Float) = Unit

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
internal actual fun polarisPromptDialogProperties(
    dismissible: Boolean,
    scrim: Boolean,
    dismissOnClickOutside: Boolean,
): androidx.compose.ui.window.DialogProperties =
    androidx.compose.ui.window.DialogProperties(
        dismissOnBackPress = dismissible,
        dismissOnClickOutside = dismissOnClickOutside,
        usePlatformDefaultWidth = false,
        scrimColor = if (scrim) androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.6f) else androidx.compose.ui.graphics.Color.Transparent, // polaris-lint: allow-colour (the desktop dialog's own default scrim)
    )

@Composable
internal actual fun rememberHeldSignIn(key: Any, actions: PolarisSignInActions, onSignedIn: () -> Unit): PolarisSignInState {
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(onSignedIn)
    val state = remember(key, scope) { PolarisSignInState(actions, scope, onSignedIn = { latest() }) }
    DisposableEffect(state) { onDispose { state.cancel() } }
    return state
}

internal actual fun autoPlatformVariant(): PolarisPlatformVariant =
    PolarisPlatformVariant.resolve(System.getProperty("os.name"), System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY))

@Composable
internal actual fun rememberScreenReaderOn(): Boolean = false

@Composable
internal actual fun PolarisReturnEffect(awaiting: Boolean, onReturn: () -> Unit) {
    val windowInfo = androidx.compose.ui.platform.LocalWindowInfo.current
    val foreground = LocalPolarisForeground.current ?: { windowInfo.isWindowFocused }
    val current by rememberUpdatedState(onReturn)
    androidx.compose.runtime.LaunchedEffect(awaiting) {
        if (!awaiting) return@LaunchedEffect
        // Away, then back: the browser took the window and gave it up.
        androidx.compose.runtime.snapshotFlow(foreground).first { !it }
        androidx.compose.runtime.snapshotFlow(foreground).first { it }
        current()
    }
}
