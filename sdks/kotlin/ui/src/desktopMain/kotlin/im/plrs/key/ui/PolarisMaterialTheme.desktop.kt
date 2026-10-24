// The desktop actual of the theme seam: today's MaterialTheme (Expressive is an Android look).

package im.plrs.key.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable

@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@Composable
internal actual fun PolarisMaterialTheme(colorScheme: ColorScheme, typography: Typography, shapes: Shapes, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colorScheme, typography = typography, shapes = shapes, content = content)
}

internal actual val polarisConnectedRows: Boolean = false
