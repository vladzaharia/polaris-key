// The platform edges of the kit (UK-10.2): the few things a Compose screen needs that differ
// between Android and the desktop. commonMain declares them; androidMain implements them from the
// code the kit had before, desktopMain implements the opener, clipboard, icon and Escape for real.
// Where a platform has no such thing it answers plainly (no QR on the desktop, D-67), never by a
// missing method.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap

/** The system clipboard as plain text. Both calls say whether they worked; neither throws. */
public interface PolarisClipboard {
    /** Puts [text] on the clipboard, labelled [label] where the platform has labels. */
    public suspend fun setText(label: String, text: String): Boolean

    /** The clipboard's first text, or null when there is none or the clipboard is not readable. */
    public suspend fun getText(): String?
}

/** The system clipboard for the current composition. */
@Composable
public expect fun rememberPolarisClipboard(): PolarisClipboard

/** The one place a link is opened: only a link [isSafeHttpsLink] accepts reaches the platform. */
@Composable
public expect fun rememberPolarisOpener(): PolarisOpener

/**
 * Runs [onBack] when the person goes back, while [enabled]; returns the modifier that draws the
 * system gesture's preview on the screen that will go (Android 14 and up; identity elsewhere).
 * Android: the back button and gesture. Desktop: Escape, from anywhere inside the node this
 * modifier is applied to. Apply it to the step's root: `modifier.then(PolarisBackHandler(enabled) { ... })`.
 */
@Composable
internal expect fun PolarisBackHandler(enabled: Boolean = true, onBack: () -> Unit): Modifier

/** Whether the person has turned animation off at the system level. */
@Composable
internal expect fun rememberSystemReduceMotion(): Boolean

/** True on a television (Android TV); never on the desktop. */
@Composable
internal expect fun isTelevision(): Boolean

/**
 * The image in [bytes] (PNG, JPEG, ...), or null when they are no image this platform decodes or the
 * header declares a side over [maxSide]. [targetPx] (when above 0) lets the platform sample the
 * image down to about that size while decoding; the result is never smaller than it.
 */
internal expect fun decodeIcon(bytes: ByteArray, targetPx: Int = 0, maxSide: Int = DEFAULT_ICON_MAX_SIDE): ImageBitmap?

/** The widest side [decodeIcon] accepts unless told otherwise. */
internal const val DEFAULT_ICON_MAX_SIDE: Int = 16384

/** A QR code of [content]. Android draws it; the desktop draws none (D-67: the screen has the code and Copy link). */
@Composable
internal expect fun PolarisQr(content: String, contentDescription: String, modifier: Modifier = Modifier)

/** The font scale the person set (1f is the default; the desktop has none). */
@Composable
internal fun polarisFontScale(): Float = androidx.compose.ui.platform.LocalDensity.current.fontScale
