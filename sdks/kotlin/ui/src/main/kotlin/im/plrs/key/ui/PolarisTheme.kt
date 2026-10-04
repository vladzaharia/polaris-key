// The kit's theme. One composable, one switch:
//
//     PolarisTheme { PolarisBoot(boot) { MyApp() } }                       // neutral: the host's look
//     PolarisTheme(branding = PolarisBranding.PolarisKey) { ... }          // the Polaris Key look
//     PolarisTheme(showPoweredBy = true) { ... }                           // adds the badge, either way
//
// NEUTRAL MEANS INHERITED. With PolarisBranding.None (the default) the kit sets no MaterialTheme of
// its own: every colour, shape and text style a screen draws comes from the host app's
// MaterialTheme, so a stock Material 3 app (dynamic colour included) renders the kit as part of
// itself. The logo slot is empty unless the host passes one; no Polaris Key colour, font, mark or
// badge appears.
//
// PolarisBranding.PolarisKey wraps the subtree in a MaterialTheme built from the generated brand
// tokens (PolarisBrandTokens: dark first, light supported, the core violet as primary, the service
// accents for the small section indicators), Rubik (bundled under the OFL) and the brand radii,
// and the logo slot shows the bit-less Pinned K. The "Powered by Polaris Key" badge is a separate
// switch, off by default, independent of branding (owner decision 2).

package im.plrs.key.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.BrandAccent
import im.plrs.key.ui.brand.PolarisBrandTokens

/** The look the kit renders in. */
public enum class PolarisBranding {
    /** Neutral (the default): everything from the host app's MaterialTheme; no Polaris Key marks. */
    None,

    /** The Polaris Key design system: brand palette (dark or light), Rubik, the Pinned K. */
    PolarisKey,
}

/**
 * Status colours Material 3 has no role for (warning, success), plus the section accents. Neutral,
 * each derives from the host's [ColorScheme]; branded, each is a brand token.
 */
@Immutable
public data class PolarisStatusColors(
    val warning: Color,
    val warningContainer: Color,
    val onWarningContainer: Color,
    val success: Color,
    val successContainer: Color,
    val onSuccessContainer: Color,
    val danger: Color,
    val dangerContainer: Color,
    val onDangerContainer: Color,
    /** The QR code's modules and plate: always dark on light, so every scanner reads it. */
    val qrModules: Color,
    val qrPlate: Color,
) {
    public companion object {
        /** Neutral: roles borrowed from the host's colour scheme. */
        public fun from(scheme: ColorScheme): PolarisStatusColors = PolarisStatusColors(
            warning = scheme.tertiary,
            warningContainer = scheme.tertiaryContainer,
            onWarningContainer = scheme.onTertiaryContainer,
            success = scheme.primary,
            successContainer = scheme.primaryContainer,
            onSuccessContainer = scheme.onPrimaryContainer,
            danger = scheme.error,
            dangerContainer = scheme.errorContainer,
            onDangerContainer = scheme.onErrorContainer,
            qrModules = Color.Black, // polaris-lint: allow-colour (a QR code is dark on light for every scanner)
            qrPlate = Color.White, // polaris-lint: allow-colour
        )

        /** Branded: the brand's status tokens for the theme. */
        public fun brand(dark: Boolean): PolarisStatusColors = if (dark) {
            val t = PolarisBrandTokens.Dark
            PolarisStatusColors(
                warning = t.warning, warningContainer = t.warningSubtle, onWarningContainer = t.textStrong,
                success = t.success, successContainer = t.successSubtle, onSuccessContainer = t.textStrong,
                danger = t.danger, dangerContainer = t.dangerSubtle, onDangerContainer = t.textStrong,
                qrModules = PolarisBrandTokens.Kit.pageDark, qrPlate = PolarisBrandTokens.Kit.starDark,
            )
        } else {
            val t = PolarisBrandTokens.Light
            PolarisStatusColors(
                warning = t.warning, warningContainer = t.warningSubtle, onWarningContainer = t.textStrong,
                success = t.success, successContainer = t.successSubtle, onSuccessContainer = t.textStrong,
                danger = t.danger, dangerContainer = t.dangerSubtle, onDangerContainer = t.textStrong,
                qrModules = PolarisBrandTokens.Kit.pageDark, qrPlate = PolarisBrandTokens.Light.surfaceRaised,
            )
        }
    }
}

/** Everything the kit's screens read from the theme, resolved for one subtree. */
@Immutable
public class PolarisUiConfig internal constructor(
    public val branding: PolarisBranding,
    public val showPoweredBy: Boolean,
    public val copy: PolarisCopy,
    public val logo: (@Composable () -> Unit)?,
    public val dark: Boolean,
    public val status: PolarisStatusColors,
    /** The shape of the kit's buttons and fields: the host's (Material) shape neutral, the brand radius branded. */
    public val controlShape: Shape?,
)

internal val LocalPolarisUi = staticCompositionLocalOf<PolarisUiConfig?> { null }

/**
 * The kit's theme for [content].
 *
 * @param branding [PolarisBranding.None] (the default) inherits the host's MaterialTheme;
 *   [PolarisBranding.PolarisKey] applies the Polaris Key brand. The one switch.
 * @param showPoweredBy shows the "Powered by Polaris Key" badge at the foot of the kit's screens.
 *   Off by default, and independent of [branding].
 * @param copy every string the kit renders; the default reads the string resources, so an app's
 *   translations apply.
 * @param logo the product's logo for the top of the kit's screens. Null (the default) shows
 *   nothing neutral and the Pinned K branded.
 * @param darkTheme the branded palette's theme; follows the system. Neutral, the host's
 *   MaterialTheme decides and this only picks the dark or light badge artwork.
 */
@Composable
public fun PolarisTheme(
    branding: PolarisBranding = PolarisBranding.None,
    showPoweredBy: Boolean = false,
    copy: PolarisCopy = PolarisCopy.localized(),
    logo: (@Composable () -> Unit)? = null,
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    when (branding) {
        PolarisBranding.None -> {
            val scheme = MaterialTheme.colorScheme
            val dark = remember(scheme.background) { scheme.background.luminance() < 0.5f }
            val config = PolarisUiConfig(
                branding = branding,
                showPoweredBy = showPoweredBy,
                copy = copy,
                logo = logo,
                dark = dark,
                status = PolarisStatusColors.from(scheme),
                controlShape = null,
            )
            CompositionLocalProvider(LocalPolarisUi provides config, content = content)
        }
        PolarisBranding.PolarisKey -> {
            val scheme = remember(darkTheme) { polarisBrandColorScheme(darkTheme) }
            val typography = polarisBrandTypography(MaterialTheme.typography)
            val config = PolarisUiConfig(
                branding = branding,
                showPoweredBy = showPoweredBy,
                copy = copy,
                logo = logo ?: { PolarisMark(contentDescription = copy.polarisKeyMark) },
                dark = darkTheme,
                status = PolarisStatusColors.brand(darkTheme),
                controlShape = RoundedCornerShape(PolarisBrandTokens.Radius.md.dp),
            )
            MaterialTheme(colorScheme = scheme, typography = typography, shapes = polarisBrandShapes) {
                CompositionLocalProvider(LocalPolarisUi provides config, content = content)
            }
        }
    }
}

/** Reads the kit's resolved theme. */
public object PolarisTheme {
    /** The resolved theme; outside a [PolarisTheme] call, the neutral defaults over MaterialTheme. */
    public val current: PolarisUiConfig
        @Composable @ReadOnlyComposable
        get() = LocalPolarisUi.current ?: neutralFallback()

    public val copy: PolarisCopy
        @Composable @ReadOnlyComposable
        get() = current.copy

    public val status: PolarisStatusColors
        @Composable @ReadOnlyComposable
        get() = current.status

    /** The shape of the kit's buttons. */
    public val buttonShape: Shape
        @Composable
        get() = current.controlShape ?: ButtonDefaults.shape

    /** The shape of the kit's text fields. */
    public val fieldShape: Shape
        @Composable @ReadOnlyComposable
        get() = current.controlShape ?: MaterialTheme.shapes.extraSmall

    /**
     * The accent for a section indicator (an entitlement badge, the update glyph, a pack progress
     * bar): the service's brand accent branded, the host's primary neutral.
     */
    @Composable @ReadOnlyComposable
    public fun accent(service: String): Color =
        if (current.branding == PolarisBranding.PolarisKey) brandAccent(service).solid else MaterialTheme.colorScheme.primary

    @Composable @ReadOnlyComposable
    internal fun brandAccent(service: String): BrandAccent = PolarisBrandTokens.accent(service, current.dark)
}

@Composable
@ReadOnlyComposable
private fun neutralFallback(): PolarisUiConfig {
    val scheme = MaterialTheme.colorScheme
    return PolarisUiConfig(
        branding = PolarisBranding.None,
        showPoweredBy = false,
        copy = PolarisCopy(),
        logo = null,
        dark = scheme.background.luminance() < 0.5f,
        status = PolarisStatusColors.from(scheme),
        controlShape = null,
    )
}

/** The Material 3 colour scheme of the Polaris Key brand, from the generated tokens. */
public fun polarisBrandColorScheme(dark: Boolean): ColorScheme {
    val core = PolarisBrandTokens.accent("core", dark)
    val identity = PolarisBrandTokens.accent("identity", dark)
    return if (dark) {
        val t = PolarisBrandTokens.Dark
        darkColorScheme(
            primary = core.solid, onPrimary = core.on, primaryContainer = core.subtle, onPrimaryContainer = t.textStrong,
            inversePrimary = PolarisBrandTokens.Light.focus,
            secondary = t.textMuted, onSecondary = t.surfacePage, secondaryContainer = t.surfaceOverlay, onSecondaryContainer = t.textStrong,
            tertiary = identity.solid, onTertiary = identity.on, tertiaryContainer = identity.subtle, onTertiaryContainer = t.textStrong,
            background = t.surfacePage, onBackground = t.textDefault,
            surface = t.surfacePage, onSurface = t.textStrong, surfaceVariant = t.surfaceOverlay, onSurfaceVariant = t.textMuted,
            surfaceTint = core.solid,
            inverseSurface = PolarisBrandTokens.Light.surfacePage, inverseOnSurface = PolarisBrandTokens.Light.textStrong,
            error = t.danger, onError = t.dangerOn, errorContainer = t.dangerSubtle, onErrorContainer = t.textStrong,
            outline = t.borderStrong, outlineVariant = t.borderSubtle, scrim = t.surfaceSunken,
            surfaceBright = t.surfaceOverlay, surfaceDim = t.surfaceSunken,
            surfaceContainerLowest = t.surfaceSunken, surfaceContainerLow = t.surfaceRaised, surfaceContainer = t.surfaceRaised,
            surfaceContainerHigh = t.surfaceOverlay, surfaceContainerHighest = t.surfaceOverlay,
        )
    } else {
        val t = PolarisBrandTokens.Light
        lightColorScheme(
            primary = core.solid, onPrimary = core.on, primaryContainer = core.subtle, onPrimaryContainer = t.textStrong,
            inversePrimary = PolarisBrandTokens.Dark.focus,
            secondary = t.textMuted, onSecondary = t.surfaceRaised, secondaryContainer = t.surfaceSunken, onSecondaryContainer = t.textStrong,
            tertiary = identity.solid, onTertiary = identity.on, tertiaryContainer = identity.subtle, onTertiaryContainer = t.textStrong,
            background = t.surfacePage, onBackground = t.textDefault,
            surface = t.surfacePage, onSurface = t.textStrong, surfaceVariant = t.surfaceSunken, onSurfaceVariant = t.textMuted,
            surfaceTint = core.solid,
            inverseSurface = PolarisBrandTokens.Dark.surfacePage, inverseOnSurface = PolarisBrandTokens.Dark.textStrong,
            error = t.danger, onError = t.dangerOn, errorContainer = t.dangerSubtle, onErrorContainer = t.textStrong,
            outline = t.borderStrong, outlineVariant = t.borderSubtle, scrim = PolarisBrandTokens.Dark.surfaceSunken,
            surfaceBright = t.surfaceRaised, surfaceDim = t.surfaceSunken,
            surfaceContainerLowest = t.surfaceRaised, surfaceContainerLow = t.surfaceRaised, surfaceContainer = t.surfaceRaised,
            surfaceContainerHigh = t.surfaceSunken, surfaceContainerHighest = t.surfaceSunken,
        )
    }
}

/** The brand radii as Material shapes: controls md, cards lg, the largest surfaces xl. */
public val polarisBrandShapes: Shapes = Shapes(
    extraSmall = RoundedCornerShape(PolarisBrandTokens.Radius.sm.dp),
    small = RoundedCornerShape(PolarisBrandTokens.Radius.md.dp),
    medium = RoundedCornerShape(PolarisBrandTokens.Radius.lg.dp),
    large = RoundedCornerShape(PolarisBrandTokens.Radius.xl.dp),
    extraLarge = RoundedCornerShape(PolarisBrandTokens.Radius.xl.dp),
)
