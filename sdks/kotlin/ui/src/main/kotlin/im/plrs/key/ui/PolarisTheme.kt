// The kit's theme. One composable, one switch:
//
//     PolarisTheme { PolarisBoot(boot) { MyApp() } }                       // neutral: the host's look
//     PolarisTheme(branding = PolarisBranding.PolarisKey) { ... }          // the Polaris Key look
//     PolarisTheme(showPoweredBy = true) { ... }                           // adds the badge, either way
//
// NEUTRAL MEANS INHERITED. With PolarisBranding.None (the default) the kit sets no MaterialTheme of
// its own: every colour, shape and text style a screen draws comes from the host app's
// MaterialTheme, so a stock Material 3 app (dynamic colour included) renders the kit as part of
// itself. Only the status colours Material 3 has no role for (warning, success) are the brand's
// fixed amber and green, never the host's tertiary (UI-KITS.md §3.4). No Polaris Key mark or
// badge appears.
//
// PolarisBranding.PolarisKey wraps the subtree in a MaterialTheme built from the generated brand
// tokens (PolarisBrandTokens: dark first, light supported, the core violet as primary, the service
// accents for the small section indicators), Rubik at 400, 500 and 600 (bundled under the OFL),
// full-round buttons and radius-16 fields. The "Powered by Polaris Key" badge is a separate switch,
// off by default, independent of branding (owner decision 2).
//
// THE PRODUCT IS THE HERO (UI-KITS.md §1.2). `logo` is the product's own icon. Without one, the
// kit draws the verified icon discovery's presentation names (`presentation`, PolarisPresentation.kt),
// else a monogram tile (the product's initial); the Pinned K appears only inside the optional
// Powered-by badge, in either preset.
//
// THE PRODUCT ACCENT. `accent` (a product's colour) replaces the primary roles in either mode,
// run through the accent resolver (UI-KITS.md §3.3, brand/PolarisAccent.kt) so the fill, its
// label and the text-on-surface colour all keep their contrast: branded it replaces the core
// violet against the brand surfaces; neutral it is resolved against the host's own surfaces and
// applied over the host's scheme, which otherwise stays exactly the host's.

package im.plrs.key.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import im.plrs.key.core.PresentationSource
import im.plrs.key.ui.brand.BrandAccent
import im.plrs.key.ui.brand.PolarisAccent
import im.plrs.key.ui.brand.PolarisBrandTokens

/** The look the kit renders in. */
public enum class PolarisBranding {
    /** Neutral (the native preset, the default): everything from the host app's MaterialTheme. */
    None,

    /** The Polaris Key design system: brand palette (dark or light) and Rubik. */
    PolarisKey,
}

/**
 * Status colours Material 3 has no role for (warning, success), plus danger and the QR plate.
 * Warning and success are the brand's fixed amber and green in both presets (for the host's
 * darkness, neutral); danger is the host's error neutral and the brand's danger branded.
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
        /**
         * Neutral: the brand's fixed amber and green for the host's darkness (never its tertiary,
         * which a dynamic scheme makes any hue), with the host's text on their containers, and the
         * host's error for danger.
         */
        public fun from(scheme: ColorScheme): PolarisStatusColors {
            val dark = scheme.background.luminance() < 0.5f
            val warning = if (dark) PolarisBrandTokens.Dark.warning else PolarisBrandTokens.Light.warning
            val warningSubtle = if (dark) PolarisBrandTokens.Dark.warningSubtle else PolarisBrandTokens.Light.warningSubtle
            val success = if (dark) PolarisBrandTokens.Dark.success else PolarisBrandTokens.Light.success
            val successSubtle = if (dark) PolarisBrandTokens.Dark.successSubtle else PolarisBrandTokens.Light.successSubtle
            return PolarisStatusColors(
                warning = warning,
                warningContainer = warningSubtle,
                onWarningContainer = scheme.onSurface,
                success = success,
                successContainer = successSubtle,
                onSuccessContainer = scheme.onSurface,
                danger = scheme.error,
                dangerContainer = scheme.errorContainer,
                onDangerContainer = scheme.onErrorContainer,
                qrModules = Color.Black, // polaris-lint: allow-colour (a QR code is dark on light for every scanner)
                qrPlate = QR_PLATE,
            )
        }

        /** The QR tile: 92 % white (UI-KITS.md §4.3), bright enough for every scanner, softer on a TV. */
        internal val QR_PLATE: Color = Color(0xFFEBEBEB) // polaris-lint: allow-colour (92 % white, the spec's QR tile)

        /** Branded: the brand's status tokens for the theme. */
        public fun brand(dark: Boolean): PolarisStatusColors = if (dark) {
            val t = PolarisBrandTokens.Dark
            PolarisStatusColors(
                warning = t.warning, warningContainer = t.warningSubtle, onWarningContainer = t.textStrong,
                success = t.success, successContainer = t.successSubtle, onSuccessContainer = t.textStrong,
                danger = t.danger, dangerContainer = t.dangerSubtle, onDangerContainer = t.textStrong,
                qrModules = PolarisBrandTokens.Kit.pageDark, qrPlate = QR_PLATE,
            )
        } else {
            val t = PolarisBrandTokens.Light
            PolarisStatusColors(
                warning = t.warning, warningContainer = t.warningSubtle, onWarningContainer = t.textStrong,
                success = t.success, successContainer = t.successSubtle, onSuccessContainer = t.textStrong,
                danger = t.danger, dangerContainer = t.dangerSubtle, onDangerContainer = t.textStrong,
                qrModules = PolarisBrandTokens.Kit.pageDark, qrPlate = QR_PLATE,
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
    /** The shape of the kit's buttons: Material's full round in both presets. */
    public val controlShape: Shape?,
    /** The product accent's text colour (the resolver's `fg`), when an accent is given. */
    public val accentText: Color? = null,
    /** The shape of the kit's filled fields: Material's filled-field shape neutral, radius 16 branded. */
    public val fieldShape: Shape? = null,
    /** The keyboard and D-pad focus ring (UI-KITS.md §3.3 `focus`): the accent's, else the scheme's primary. */
    public val focus: Color? = null,
    /**
     * The address a person types for a device-code sign-in (`product.deviceCodeUrl`, UI-KITS.md
     * owner decision Q8), shown instead of the server's verification address when set.
     */
    public val deviceCodeUrl: String? = null,
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
 * @param logo the product's icon: the hero of the welcome, beside the product name on focused
 *   steps, on the update prompt. Null (the default) draws a monogram tile of the product's
 *   initial (when the copy names the product) in either preset; never a Polaris Key mark.
 * @param darkTheme the branded palette's theme; follows the system. Neutral, the host's
 *   MaterialTheme decides and this only picks the dark or light badge artwork.
 * @param accent the product's colour. Null (the default) keeps the host's primary neutral and the
 *   core violet branded; a colour replaces the primary roles in either mode, resolved for
 *   contrast against the surfaces it sits on (the host's, neutral).
 * @param deviceCodeUrl the address a person types to sign in with a code (for example
 *   `driftkart.gg/tv`); null shows the server's verification address.
 * @param presentation the SDK's presentation seam (`client.presentationSource`, discovery's
 *   `core.presentation`): it fills only what the integrator left out. [logo] falls back to the
 *   verified product icon, then the monogram; branded, [accent] falls back to the product's accent
 *   (its dark one on a dark ground), then a colour derived from the icon, then the core violet.
 *   Neutral keeps the host's primary. Defaults to the client PolarisKeyProvider provides, if any.
 */
@Composable
public fun PolarisTheme(
    branding: PolarisBranding = PolarisBranding.None,
    showPoweredBy: Boolean = false,
    copy: PolarisCopy = PolarisCopy.localized(),
    logo: (@Composable () -> Unit)? = null,
    darkTheme: Boolean = isSystemInDarkTheme(),
    accent: Color? = null,
    deviceCodeUrl: String? = null,
    presentation: PresentationSource? = LocalPolarisKey.current?.presentationSource,
    content: @Composable () -> Unit,
) {
    val member = rememberPresentation(presentation)
    // The icon is fetched only for what it fills: the logo, or a branded accent nothing else gives.
    val wantsArt = logo == null || (branding == PolarisBranding.PolarisKey && accent == null && member?.accentFor(darkTheme) == null)
    val art = rememberPresentationArt(presentation.takeIf { wantsArt }, member)
    PolarisThemeResolved(
        branding = branding,
        showPoweredBy = showPoweredBy,
        copy = copy,
        logo = logo ?: art?.let(::presentationLogo),
        darkTheme = darkTheme,
        accent = themeAccent(accent, branding, member, darkTheme, art?.derivedAccent),
        deviceCodeUrl = deviceCodeUrl,
        content = content,
    )
}

/** [PolarisTheme] once the presentation's defaults are applied. */
@Composable
private fun PolarisThemeResolved(
    branding: PolarisBranding,
    showPoweredBy: Boolean,
    copy: PolarisCopy,
    logo: (@Composable () -> Unit)?,
    darkTheme: Boolean,
    accent: Color?,
    deviceCodeUrl: String?,
    content: @Composable () -> Unit,
) {
    when (branding) {
        PolarisBranding.None -> {
            val host = MaterialTheme.colorScheme
            val dark = remember(host.background) { host.background.luminance() < 0.5f }
            // The accent is resolved against the host's own grounds, so it keeps 3:1 (fills) and
            // 4.5:1 (text) on them, not on the brand's.
            val resolved = remember(accent, dark, host) {
                accent?.let {
                    val grounds = listOf(host.background, host.surface, host.surfaceContainerLow, host.surfaceContainerHigh, host.surfaceContainerHighest)
                    PolarisAccent.resolve(it.toHex(), dark, grounds.map { g -> g.toHex() })
                }
            }
            val scheme = remember(host, resolved) { resolved?.let { host.withAccent(it) } ?: host }
            val config = PolarisUiConfig(
                branding = branding,
                showPoweredBy = showPoweredBy,
                copy = copy,
                logo = logo,
                dark = dark,
                status = PolarisStatusColors.from(scheme),
                controlShape = null,
                accentText = resolved?.let { colorOf(it.fg) },
                focus = resolved?.let { colorOf(it.focus) },
                deviceCodeUrl = deviceCodeUrl,
            )
            if (resolved == null) {
                // Neutral means inherited: no MaterialTheme of the kit's own, dynamic colour and all.
                CompositionLocalProvider(LocalPolarisUi provides config, content = content)
            } else {
                MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
                    CompositionLocalProvider(LocalPolarisUi provides config, content = content)
                }
            }
        }
        PolarisBranding.PolarisKey -> {
            val resolved = remember(accent, darkTheme) { accent?.let { PolarisAccent.resolve(it.toHex(), darkTheme) } }
            val scheme = remember(darkTheme, resolved) {
                polarisBrandColorScheme(darkTheme).let { brand -> resolved?.let { brand.withAccent(it) } ?: brand }
            }
            val typography = polarisBrandTypography(MaterialTheme.typography)
            val config = PolarisUiConfig(
                branding = branding,
                showPoweredBy = showPoweredBy,
                copy = copy,
                logo = logo,
                dark = darkTheme,
                status = PolarisStatusColors.brand(darkTheme),
                // UI-KITS.md §1.4, Android: full-round buttons and radius-16 filled fields.
                controlShape = CircleShape,
                accentText = resolved?.let { colorOf(it.fg) },
                fieldShape = RoundedCornerShape(16.dp),
                focus = resolved?.let { colorOf(it.focus) } ?: if (darkTheme) PolarisBrandTokens.Dark.focus else PolarisBrandTokens.Light.focus,
                deviceCodeUrl = deviceCodeUrl,
            )
            MaterialTheme(colorScheme = scheme, typography = typography, shapes = polarisBrandShapes) {
                CompositionLocalProvider(LocalPolarisUi provides config, content = content)
            }
        }
    }
}

/**
 * [this] scheme with its primary roles from a resolved accent: the fill and its label, the tinted
 * container (with the scheme's strongest text on it) and the surface tint. The accent's text
 * colour (`fg`) travels separately, as [PolarisUiConfig.accentText].
 */
internal fun ColorScheme.withAccent(accent: PolarisAccent.Resolved): ColorScheme = copy(
    primary = colorOf(accent.solid),
    onPrimary = colorOf(labelOn(accent)),
    primaryContainer = colorOf(accent.subtle),
    onPrimaryContainer = onSurface,
    surfaceTint = colorOf(accent.solid),
)

/** The message card's radius 28. */
private val MessageCardShape: Shape = RoundedCornerShape(28.dp)

/** The product icon's 28 % squircle (UI-KITS.md §1.4, Android). */
private val ProductIconShape: Shape = RoundedCornerShape(28)

/**
 * The label on the accent's fill. On the brand's near-black and near-white grounds the resolver's
 * `on` always clears 4.5:1; on a host's mid-tone ground (a grey dark theme) the fill may have been
 * lifted for 3:1 past where white reads, so the kit takes whichever of white and ink reads better.
 */
internal fun labelOn(accent: PolarisAccent.Resolved): String {
    if (PolarisAccent.contrast(accent.on, accent.solid) >= 4.5) return accent.on
    return listOf(PolarisAccent.WHITE, PolarisAccent.INK).maxBy { PolarisAccent.contrast(it, accent.solid) }
}

/** A colour as the resolver's lower-case "#rrggbb". */
internal fun Color.toHex(): String = "#%06x".format(toArgb() and 0xFFFFFF)

/** A resolver "#rrggbb" as an opaque colour. */
internal fun colorOf(hex: String): Color = Color(("ff" + hex.removePrefix("#")).toLong(16))

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

    /** The shape of the kit's buttons: full round (Material's default neutral). */
    public val buttonShape: Shape
        @Composable
        get() = current.controlShape ?: ButtonDefaults.shape

    /** The shape of the kit's filled text fields: Material's filled-field shape neutral, radius 16 branded. */
    public val fieldShape: Shape
        @Composable
        get() = current.fieldShape ?: TextFieldDefaults.shape

    /** The product icon's shape: a 28 % squircle (the monogram tile, a host icon). */
    public val iconShape: Shape
        @Composable @ReadOnlyComposable
        get() = ProductIconShape

    /** A message screen's card on a wide window or TV: radius 28 (UI-KITS.md §1.4, Android sheets). */
    public val cardShape: Shape
        @Composable @ReadOnlyComposable
        get() = MessageCardShape

    /** The keyboard and D-pad focus ring's colour. */
    public val focusColor: Color
        @Composable @ReadOnlyComposable
        get() = current.focus ?: MaterialTheme.colorScheme.primary

    /** The colour of accent text (text buttons, outlined labels): the product accent's `fg` when given. */
    public val accentText: Color
        @Composable @ReadOnlyComposable
        get() = current.accentText ?: MaterialTheme.colorScheme.primary

    /** The kit mono for user codes and keys: JetBrains Mono branded, the platform monospace neutral. */
    public val monoFamily: FontFamily
        @Composable @ReadOnlyComposable
        get() = if (current.branding == PolarisBranding.PolarisKey) PolarisKitMono else FontFamily.Monospace

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
