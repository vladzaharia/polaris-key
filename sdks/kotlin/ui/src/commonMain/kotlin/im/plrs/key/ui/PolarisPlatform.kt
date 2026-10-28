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
    /**
     * Puts [text] on the clipboard, labelled [label] where the platform has labels. A [sensitive]
     * text (a recovery code) is flagged so the system keeps it out of previews and clipboard history
     * where it can (Android 13 and up).
     */
    public suspend fun setText(label: String, text: String, sensitive: Boolean = false): Boolean

    /** The clipboard's first text, or null when there is none or the clipboard is not readable. */
    public suspend fun getText(): String?

    /** Empties the clipboard (Android: `clearPrimaryClip`). */
    public suspend fun clear(): Boolean
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

/** Whether a screen reader is reading by touch (TalkBack's touch exploration); false where there is none. */
@Composable
internal expect fun rememberScreenReaderOn(): Boolean

/**
 * Calls [onReturn] once when the person comes back to the app after leaving it (to a browser or a
 * system screen), while [awaiting]. Android: the host lifecycle's ON_PAUSE then ON_RESUME, which a
 * browser in a window of its own never changes focus for. Desktop: the window loses focus, then regains it.
 */
@Composable
internal expect fun PolarisReturnEffect(awaiting: Boolean, onReturn: () -> Unit)

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

// ── Moved to commonMain with the kit (UK-10.3) ──────────────────────────────────────────────────

/** The locale tag the catalog formats in: the device's first locale (Android), the JVM default (desktop). */
@Composable
internal expect fun systemLocaleTag(): String

/** What this screen is, for "This device": "tv", "tablet" or "phone" on Android, "desktop" on the desktop. */
@Composable
internal expect fun ownFormFactor(): String

/** Speaks [message] once to the screen reader (TalkBack); the desktop has no such one-off call yet and says nothing. */
@Composable
internal expect fun rememberPolarisAnnouncer(): (String) -> Unit

/** The update version the person chose to skip, kept across launches, and how to keep a new one. */
internal class PolarisUpdatePrefs(val skippedVersion: String?, val saveSkipped: (String) -> Unit)

/** The update prefs of the host: Android shared preferences, the desktop's `java.util.prefs` node. */
@Composable
internal expect fun rememberUpdatePrefs(): PolarisUpdatePrefs

/** The kit's copy from the host's string resources (an app's `values-<locale>` on Android); the English defaults elsewhere. */
@Composable
internal expect fun polarisLocalizedCopy(): PolarisCopy

/** A 32 x 32 ARGB thumbnail of [image] (the input of the icon's accent derivation). */
internal expect fun thumbnailArgb32(image: ImageBitmap): IntArray

/** Dims what is behind the enclosing dialog window by [amount] (0..1). Android sets the window's dim; the desktop draws no window dim. */
@Composable
internal expect fun PolarisDialogDim(amount: Float)

/**
 * The dialog properties of a prompt window. [scrim] asks the desktop's `Dialog` for its own dim
 * (Compose Multiplatform draws a black 60 % one by default); a chrome that draws its own dim (the
 * Windows smoke, the GNOME scrim) or none (the Mac sheet) passes false, so two never stack. Android
 * dims through [PolarisDialogDim] and ignores it. [dismissOnClickOutside] defaults to [dismissible]; the Mac sheet
 * turns it off while Escape still dismisses.
 */
internal expect fun polarisPromptDialogProperties(
    dismissible: Boolean,
    scrim: Boolean,
    dismissOnClickOutside: Boolean = dismissible,
): androidx.compose.ui.window.DialogProperties

/** Whether the prompt's dialog window draws its own dim: only where no desktop chrome owns the dimming. */
internal fun dialogWindowDraws(variant: PolarisPlatformVariant): Boolean = variant == PolarisPlatformVariant.Android

/**
 * The sign-in state for [key] (the client), kept across a recreation where the platform has one
 * (Android: the Activity's ViewModel store, so a rotation keeps the same code); [onSignedIn] runs
 * while this composition is attached.
 */
@Composable
internal expect fun rememberHeldSignIn(key: Any, actions: PolarisSignInActions, onSignedIn: () -> Unit): PolarisSignInState
