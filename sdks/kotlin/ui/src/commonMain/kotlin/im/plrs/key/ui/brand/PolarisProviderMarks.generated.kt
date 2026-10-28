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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** A provider button's colours; [border] null draws none. */
public data class ProviderButtonFill(val fill: Color, val border: Color?, val label: Color)

/**
 * The provider sign-in marks (docs/design/UI-KITS.md §3.6): the logo a "Continue with <provider>"
 * button carries, with the fills and label colours the provider's branding rules require. Apple is
 * not here: the kit draws the system control. The product accent never tints a provider mark.
 */
public object PolarisProviderMarks {
    /** The Google "G" on its 48-unit grid, in Google's four colours. Draw it unmodified; never tint it. */
    public val GoogleG: ImageVector by lazy {
        ImageVector.Builder(
            name = "PolarisGoogleG",
            defaultWidth = 48.dp,
            defaultHeight = 48.dp,
            viewportWidth = 48f,
            viewportHeight = 48f,
        ).apply {
            addPath(
                pathData = addPathNodes("M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"),
                fill = SolidColor(Color(0xFFEA4335)),
            )
            addPath(
                pathData = addPathNodes("M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"),
                fill = SolidColor(Color(0xFF4285F4)),
            )
            addPath(
                pathData = addPathNodes("M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"),
                fill = SolidColor(Color(0xFFFBBC05)),
            )
            addPath(
                pathData = addPathNodes("M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"),
                fill = SolidColor(Color(0xFF34A853)),
            )
        }.build()
    }

    /** Google's three button fills. */
    public object GoogleButton {
        public val Light: ProviderButtonFill = ProviderButtonFill(Color(0xFFFFFFFF), Color(0xFF747775), Color(0xFF1F1F1F))
        public val Dark: ProviderButtonFill = ProviderButtonFill(Color(0xFF131314), Color(0xFF8E918F), Color(0xFFE3E3E3))
        public val Neutral: ProviderButtonFill = ProviderButtonFill(Color(0xFFF2F2F2), null, Color(0xFF1F1F1F))

        /** The fill each colour scheme uses by default. */
        public fun forScheme(dark: Boolean): ProviderButtonFill = if (dark) Dark else Light
    }

    /** The G's height as a fraction of the button's height. */
    public const val GOOGLE_G_HEIGHT_RATIO: Float = 0.5f

    /** The gap between the G and the label, in dp. */
    public const val GOOGLE_G_LABEL_GAP: Float = 10f

    /** The kit-copy key of the label ("Continue with {provider}", provider "Google"). */
    public const val GOOGLE_LABEL_COPY_KEY: String = "signin.provider.continue"
}
