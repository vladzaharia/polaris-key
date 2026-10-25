// The one seam through which the desktop chromes read what the host says about itself (UK-10.5/.6):
// dark or light, the system accent, a contrast theme. UK-10.7 (macOS) plugs into this file; no
// chrome declares its own local or reader.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** Host facts a caller (a test, a host that already knows them) provides instead of asking the desktop. */
internal val LocalPolarisHostFacts = staticCompositionLocalOf<PolarisHostFacts?> { null }

/**
 * The desktop's own facts: read once per process, before the first frame draws (under the reader's
 * 500 ms cap), so no frame is drawn from a guess. Null on Android and for a variant whose facts the
 * theme does not follow.
 */
@Composable
internal expect fun rememberDesktopHostFacts(): PolarisHostFacts?

/** The variants whose chrome follows host facts. Windows, GNOME and macOS. */
internal fun followsHostFacts(variant: PolarisPlatformVariant): Boolean =
    variant == PolarisPlatformVariant.Windows || variant == PolarisPlatformVariant.Gnome || variant == PolarisPlatformVariant.MacOS

/** The facts the chrome follows: provided, else the desktop's; null when there is no source (Android, an unfollowed variant). */
@Composable
internal fun rememberThemeHostFacts(): PolarisHostFacts? {
    val provided = LocalPolarisHostFacts.current
    if (provided != null) return provided
    return if (followsHostFacts(autoPlatformVariant())) rememberDesktopHostFacts() else null
}

/** Dark when the host says so (the portal's `color-scheme`, the registry's app theme), else the system's own answer. */
@Composable
internal fun polarisSystemDark(): Boolean = rememberThemeHostFacts()?.dark ?: androidx.compose.foundation.isSystemInDarkTheme()

/** The system accent as an opaque colour, or null when there is none. */
@Composable
internal fun themeHostAccent(): Color? = rememberThemeHostFacts()?.accent?.let { Color(0xFF000000L or (it.toLong() and 0xFFFFFFL)) } // polaris-lint: allow-colour (the OS accent, opaque)

/** Fluent's default accent, the native preset's fallback on Windows. */
@Suppress("MagicNumber")
private val FluentDefaultAccent = Color(0xFF0067C0) // polaris-lint: allow-colour (Fluent's default accent)

/** Adwaita's default accent, the native preset's fallback on GNOME. */
@Suppress("MagicNumber")
private val AdwaitaDefaultAccent = Color(0xFF3584E4) // polaris-lint: allow-colour (Adwaita's default accent)

/** UK-10.15 #7: the native preset's accent: the host's, else Fluent's or Adwaita's own on Windows and GNOME, never ink. */
@Composable
internal fun nativeAccent(): Color? = themeHostAccent() ?: when (autoPlatformVariant()) {
    PolarisPlatformVariant.Windows -> FluentDefaultAccent
    PolarisPlatformVariant.Gnome -> AdwaitaDefaultAccent
    else -> null
}
