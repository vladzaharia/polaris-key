@file:Suppress("MagicNumber", "MaxLineLength")

package im.plrs.key.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The Material Symbols subset the kit ships (filled, 24 dp grid), so the kit depends on no legacy
 * `Icons.Filled` set. Each is drawn in the colour the caller's `Icon` tints it.
 */
internal object PolarisSymbols {
    private fun symbol(name: String, path: String, autoMirror: Boolean = false): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f, autoMirror = autoMirror)
            .addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black)) // polaris-lint: allow-colour (the Icon tints it)
            .build()

    val Check: ImageVector by lazy { symbol("PolarisCheck", "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z") }
    val Info: ImageVector by lazy { symbol("PolarisInfo", "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z") }
    val Warning: ImageVector by lazy { symbol("PolarisWarning", "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z") }
    val Lock: ImageVector by lazy {
        symbol(
            "PolarisLock",
            "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
        )
    }
    val Refresh: ImageVector by lazy {
        symbol(
            "PolarisRefresh",
            "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
        )
    }
    val ChevronDown: ImageVector by lazy { symbol("PolarisChevronDown", "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z") }
    val Close: ImageVector by lazy { symbol("PolarisClose", "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z") }
    val Edit: ImageVector by lazy {
        symbol(
            "PolarisEdit",
            "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
        )
    }

    /** "Exit to app": the door with an arrow, mirrored in right-to-left layouts. */
    val ExitToApp: ImageVector by lazy {
        symbol(
            "PolarisExitToApp",
            "M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
            autoMirror = true,
        )
    }

    /** "Logout": an arrow leaving the box, for removing a device (ExitToApp reads as "enter"). */
    val Logout: ImageVector by lazy {
        symbol(
            "PolarisLogout",
            "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z",
            autoMirror = true,
        )
    }

    /** The new-window glyph that ends an external link ("All changes ↗"). */
    val OpenInNew: ImageVector by lazy {
        symbol(
            "PolarisOpenInNew",
            "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
            autoMirror = true,
        )
    }
}
