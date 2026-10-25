// The kit's one MaterialTheme seam (UK-09b.4). Android is where Material 3 Expressive goes
// (MaterialExpressiveTheme), but on the pinned material3 1.4.0 it is internal to Kotlin callers (see
// the Android actual), so both actuals draw MaterialTheme today. Also blocked by the toolchain wall
// (compileSdk 37, AGP 9.1) and so not used: LoadingIndicator, MaterialShapes morphs, wavy progress
// and ButtonGroup. Inline waits
// stay the kit's own countdown ring, shimmer and busy-button ring (UI-KITS.md "No stock spinners").

package im.plrs.key.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

/** The kit's MaterialTheme (Expressive on Android once the toolchain allows it). */
@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@Composable
internal expect fun PolarisMaterialTheme(colorScheme: ColorScheme, typography: Typography, shapes: Shapes, content: @Composable () -> Unit)

/** True where the kit draws grouped rows as Expressive connected groups (Android). */
internal expect val polarisConnectedRows: Boolean

/** The gap between connected rows. */
internal val PolarisConnectedGap = 2.dp
