// The Android actual of the theme seam.
//
// FINDING (UK-09b.4, corrects plan C4): on the pinned material3 1.4.0, `MaterialExpressiveTheme` and
// `@ExperimentalMaterial3ExpressiveApi` are public in the AAR's bytecode but INTERNAL in its Kotlin
// metadata, so a Kotlin caller gets "Cannot access ... it is internal"; `MotionScheme.expressive()`
// is internal too. Expressive therefore cannot be reached on this toolchain without suppressing a
// compiler error. Until `:ui` moves to a material3 where it is public (follow-up UK-09c: AGP 9.1,
// compileSdk 37, BOM 2026.08+), this actual draws the plain MaterialTheme, and only this file
// changes then.

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

// The connected-group shape rules are kit-drawn (ButtonGroup is absent on the pinned line), so they apply today.
internal actual val polarisConnectedRows: Boolean = true
