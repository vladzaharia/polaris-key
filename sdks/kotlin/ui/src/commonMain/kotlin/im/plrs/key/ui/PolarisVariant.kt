// The platform variant of the kit (UK-10.4): which chrome and density a screen lays out in, and the
// facts the host exposes (dark, accent, contrast, transparency). Android and the desktop share the
// screens; the variant only picks measures here (control height, target size, focus ring).

package im.plrs.key.ui

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The platform a kit screen is drawn for. */
public enum class PolarisPlatformVariant {
    Android, Windows, Gnome, MacOS;

    /** A desktop variant (everything but [Android]). */
    internal val isDesktop: Boolean get() = this != Android

    /** The control height of this variant (UI-KITS.md §2.1): 56 Android, 32 Windows, 34 GNOME, 28 macOS. */
    internal val controlHeight: Dp
        get() = when (this) {
            Android -> 56.dp
            Windows -> 32.dp
            Gnome -> 34.dp
            MacOS -> 28.dp
        }

    public companion object {
        /** The system property that forces a variant (a test hook): `Android`, `Windows`, `Gnome` or `MacOS`, any case. */
        public const val FORCE_PROPERTY: String = "pkey.kit.platform"

        /**
         * The variant for [osName] (`os.name`), unless [forced] names one. Windows and macOS by name;
         * every other desktop OS is GNOME (the Linux and BSD desktops, the portal readers' home).
         */
        public fun resolve(osName: String?, forced: String? = null): PolarisPlatformVariant {
            forced?.trim()?.takeIf { it.isNotEmpty() }?.let { f ->
                entries.firstOrNull { it.name.equals(f, ignoreCase = true) }?.let { return it }
            }
            val os = osName.orEmpty().lowercase()
            return when {
                os.contains("android") -> Android
                os.contains("win") -> Windows
                os.contains("mac") || os.contains("darwin") -> MacOS
                else -> Gnome
            }
        }
    }
}

/** The variant of this host: [PolarisPlatformVariant.Android] on Android, `Auto` from `os.name` on the desktop. */
internal expect fun autoPlatformVariant(): PolarisPlatformVariant

/** True while the last input was touch (a touch screen under the desktop kit): targets grow from 24 to 44 dp. */
internal val LocalPolarisTouchInput = staticCompositionLocalOf { false }

/**
 * What the desktop says about itself. Every field has a default, which is what a reader answers when
 * the host cannot be asked (no tool, a refusal, 500 ms gone): light, no accent, normal contrast, with transparency.
 */
public data class PolarisHostFacts(
    val dark: Boolean = false,
    /** The system accent as 0xRRGGBB, or null when the host has none or it is not readable. */
    val accent: Int? = null,
    val highContrast: Boolean = false,
    val reducedTransparency: Boolean = false,
)
