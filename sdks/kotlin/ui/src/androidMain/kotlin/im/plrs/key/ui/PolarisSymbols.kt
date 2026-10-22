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
    private fun symbol(name: String, path: String): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
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
}
