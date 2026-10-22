// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

@file:Suppress("MagicNumber", "MaxLineLength")

package im.plrs.key.ui.brand

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The UI-kit glyphs (docs/design/UI-KITS.md 1.5 rule 11) as vectors on the 24-unit grid, 2 px round stroke. */
public object PolarisKitGlyphs {
    /** The kit-copy key that describes a new-window action ("Opens in your browser"). */
    public const val NEW_WINDOW_COPY_KEY: String = "a11y.externalLink"

    /** An action that leaves the app: drawn beside its label, never instead of it. */
    public val NewWindow: ImageVector by lazy {
        ImageVector.Builder(
            name = "PolarisNewWindow",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            addPath(
                pathData = addPathNodes("M15 3h6v6"),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.0f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
            addPath(
                pathData = addPathNodes("M10 14 21 3"),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.0f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
            addPath(
                pathData = addPathNodes("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.0f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }.build()
    }
}
