// The kit's theme. One composable, one switch:
//
//     PolarisTheme { PolarisBoot(boot) { MyApp() } }                       // the Polaris look (the default)
//     PolarisTheme(branding = PolarisBranding.None) { ... }                // the native preset: the host's look
//     PolarisTheme(showPoweredBy = true) { ... }                           // adds the attribution, either way
//
// THE POLARIS LOOK IS THE DEFAULT (UI-KITS.md §1.1). Every kit renders the Polaris Key design system
// unless the host opts into the native preset with PolarisBranding.None.
//
// NEUTRAL MEANS INHERITED. With PolarisBranding.None (the native preset, opt-in) the kit sets no MaterialTheme of
// its own: every colour, shape and text style a screen draws comes from the host app's
// MaterialTheme, so a stock Material 3 app (dynamic colour included) renders the kit as part of
// itself. Only the status colours Material 3 has no role for (warning, success) are the brand's
// fixed amber and green, never the host's tertiary (UI-KITS.md §3.4). No Polaris Key mark or
// badge appears.
//
// PolarisBranding.PolarisKey wraps the subtree in a MaterialTheme built from the generated brand
// tokens (PolarisBrandTokens: dark first, light supported, the core violet as primary, the service
// accents for the small section indicators), Rubik at 400, 500 and 600 (bundled under the OFL),
// full-round buttons and radius-16 fields. The "Powered by Polaris Locker" attribution is a separate switch,
// off by default, independent of branding (owner decision 2).
//
// THE PRODUCT IS THE HERO (UI-KITS.md §1.2). `logo` is the product's own icon. Without one, the
// kit draws the verified icon discovery's presentation names (`presentation`, PolarisPresentation.kt),
// else a monogram tile (the product's initial); the Pinned K appears only inside the optional
// Powered-by attribution, in either preset.
//
// THE PRODUCT ACCENT. `accent` (a product's colour) replaces the primary roles in either mode,
// run through the accent resolver (UI-KITS.md §3.3, brand/PolarisAccent.kt) so the fill, its
// label and the text-on-surface colour all keep their contrast: branded it replaces the core
// violet against the brand surfaces; neutral it is resolved against the host's own surfaces and
// applied over the host's scheme, which otherwise stays exactly the host's.

package im.plrs.key.ui

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
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import im.plrs.key.core.PresentationSource
import im.plrs.key.ui.brand.BrandAccent
import im.plrs.key.ui.brand.KitRadius
import im.plrs.key.ui.brand.PolarisKitTokens
import im.plrs.key.ui.brand.PolarisAccent
import im.plrs.key.ui.brand.PolarisBrandTokens

/** How the opt-in "Powered by Polaris Locker" attribution is drawn (UI-KITS.md section 1.6). */
public enum class PolarisPoweredByStyle {
    /** The Locker micro mark (16 dp) and the phrase, in live text. */
    Line,

    /** The Locker `powered-by` badge (320 x 104 dp) where 320 dp are free, else the line. */
    Badge,
}

/** The look the kit renders in. */
public enum class PolarisBranding {
    /** Neutral, the native preset (opt-in): everything from the host app's MaterialTheme. */
    None,

    /** The Polaris Key design system (the default): brand palette (dark or light) and Rubik. */
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
    /** How the attribution is drawn when [showPoweredBy] is on (UI-KITS.md section 1.6). */
    public val poweredByStyle: PolarisPoweredByStyle = PolarisPoweredByStyle.Line,
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
    /** The developer's name for the Welcome's "by <Developer>" line: the integrator's, else the product's presentation. */
    public val developer: String? = null,
)

internal val LocalPolarisUi = staticCompositionLocalOf<PolarisUiConfig?> { null }

/**
 * The kit's theme for [content].
 *
 * @param branding [PolarisBranding.PolarisKey] (the default) applies the Polaris Key brand;
 *   [PolarisBranding.None] is the native preset and inherits the host's MaterialTheme. The one switch.
 * @param showPoweredBy draws "Powered by Polaris Locker" as the last item of [PolarisSettingsScreen] and of the
 *   kit's account pane ([PolarisKitScreen] for the account component), after its controls. Off by
 *   default, and independent of [branding].
 * @param poweredByStyle [PolarisPoweredByStyle.Line] (the default) draws the Locker micro mark and the
 *   phrase; [PolarisPoweredByStyle.Badge] draws the 320 x 104 badge on an About or credits screen where
 *   320 dp are free (the line elsewhere). The gate never draws it (UI-KITS.md section 1.6): the kit's
 *   account pane does, and [PolarisPoweredBy] is for your about and credits screens.
 * @param copy every string the kit renders; the default reads the string resources, so an app's
 *   translations apply.
 * @param logo the product's icon: the hero of the welcome, beside the product name on focused
 *   steps, on the update prompt. Null (the default) draws a monogram tile of the product's
 *   initial (when the copy names the product) in either preset; never a Polaris Key mark.
 * @param darkTheme the branded palette's theme; follows the system (on Windows and GNOME, the host
 *   facts read once before the first frame). Neutral, the host's MaterialTheme decides and this only
 *   picks the dark or light badge artwork, except on Windows and GNOME, where the native preset draws
 *   the platform's own neutral layers in this theme.
 * @param accent the product's colour. Null (the default) keeps the host's primary neutral and uses ink
 *   (the strongest text colour) branded, never the core violet; a colour replaces the primary roles in
 *   either mode, resolved for contrast against the surfaces it sits on (the host's, neutral).
 * @param deviceCodeUrl the address a person types to sign in with a code (for example
 *   `driftkart.gg/tv`); null shows the server's verification address.
 * @param developer the developer's name for the Welcome's "by <Developer>" line; null takes the
 *   product presentation's `developerName`, and with neither the line is left out.
 * @param presentation the SDK's presentation seam (`client.presentationSource`, discovery's
 *   `core.presentation`): it fills only what the integrator left out. [logo] falls back to the
 *   verified product icon, then the monogram; branded, [accent] falls back to the product's accent
 *   (its dark one on a dark ground), then a colour derived from the icon, then ink (never the core violet).
 *   Neutral keeps the host's primary. Defaults to the client PolarisKeyProvider provides, if any.
 */
@Composable
public fun PolarisTheme(
    branding: PolarisBranding = PolarisBranding.PolarisKey,
    showPoweredBy: Boolean = false,
    poweredByStyle: PolarisPoweredByStyle = PolarisPoweredByStyle.Line,
    copy: PolarisCopy = PolarisCopy.localized(),
    logo: (@Composable () -> Unit)? = null,
    darkTheme: Boolean = polarisSystemDark(),
    accent: Color? = null,
    deviceCodeUrl: String? = null,
    developer: String? = null,
    presentation: PresentationSource? = LocalPolarisKey.current?.presentationSource,
    content: @Composable () -> Unit,
) {
    // GNOME: the portal's accent-color is the native preset's accent (UK-10.6); null elsewhere and for an integrator's own.
    val hostAccent = if (branding == PolarisBranding.None && accent == null) themeHostAccent() else null
    val member = rememberPresentation(presentation)
    // The icon is fetched only for what it fills: the logo, or a branded accent nothing else gives.
    val wantsArt = logo == null || (branding == PolarisBranding.PolarisKey && accent == null && member?.accentFor(darkTheme) == null)
    val art = rememberPresentationArt(presentation.takeIf { wantsArt }, member)
    PolarisThemeResolved(
        branding = branding,
        showPoweredBy = showPoweredBy,
        poweredByStyle = poweredByStyle,
        // macOS: a copy the host built from the defaults reads the Mac wording too; a host's own text stays (S4).
        copy = if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) copy.forMac() else copy,
        logo = logo ?: art?.let { presentationLogo(it) },
        darkTheme = darkTheme,
        accent = themeAccent(accent ?: hostAccent, branding, member, darkTheme, art?.derivedAccent),
        deviceCodeUrl = deviceCodeUrl,
        developer = developer ?: member?.developerName?.takeIf { it.isNotBlank() },
        content = content,
    )
}

/** [PolarisTheme] once the presentation's defaults are applied. */
@Composable
private fun PolarisThemeResolved(
    branding: PolarisBranding,
    showPoweredBy: Boolean,
    poweredByStyle: PolarisPoweredByStyle,
    copy: PolarisCopy,
    logo: (@Composable () -> Unit)?,
    darkTheme: Boolean,
    accent: Color?,
    deviceCodeUrl: String?,
    developer: String?,
    content: @Composable () -> Unit,
) {
    when (branding) {
        PolarisBranding.None -> {
            // Windows and GNOME: the native preset is the platform's own neutral layers (mica and layer,
            // libadwaita's page and card), light or dark as the host says. Elsewhere it is the host's scheme.
            val variant = autoPlatformVariant()
            // macOS follows the host's facts for dark/light but keeps the host's own scheme: it has no native layers of its own to draw.
            val platform = followsHostFacts(variant) && variant != PolarisPlatformVariant.MacOS
            val contrast = variant == PolarisPlatformVariant.Windows && rememberThemeHostFacts()?.highContrast == true
            val host = when {
                contrast -> windowsContrastScheme(darkTheme)
                platform -> platformNeutralScheme(variant, darkTheme)
                else -> MaterialTheme.colorScheme
            }
            val dark = if (platform) darkTheme else remember(host.background) { host.background.luminance() < 0.5f }
            // The accent is resolved against the host's own grounds, so it keeps 3:1 (fills) and
            // 4.5:1 (text) on them, not on the brand's.
            val resolved = remember(accent, dark, host) {
                if (contrast) {
                    null
                } else {
                    accent?.let {
                        val grounds = listOf(host.background, host.surface, host.surfaceContainerLow, host.surfaceContainerHigh, host.surfaceContainerHighest)
                        PolarisAccent.resolve(it.toHex(), dark, grounds.map { g -> g.toHex() })
                    }
                }
            }
            val scheme = remember(host, resolved) { resolved?.let { host.withAccent(it) } ?: host }
            val config = PolarisUiConfig(
                branding = branding,
                showPoweredBy = showPoweredBy,
                poweredByStyle = poweredByStyle,
                copy = copy,
                logo = logo,
                dark = dark,
                status = PolarisStatusColors.from(scheme),
                controlShape = null,
                // A Windows contrast theme: links are Hotlight, the ring WindowText, whatever the host accent.
                accentText = if (contrast) FluentSystemColors.forTheme(darkTheme).hotlight else resolved?.let { colorOf(it.fg) },
                focus = if (contrast) FluentSystemColors.forTheme(darkTheme).windowText else resolved?.let { colorOf(it.focus) },
                deviceCodeUrl = deviceCodeUrl,
                developer = developer,
            )
            if (resolved == null && !platform) {
                // Neutral means inherited: no MaterialTheme of the kit's own, dynamic colour and all.
                CompositionLocalProvider(LocalPolarisUi provides config, content = content)
            } else {
                val fluent = variant == PolarisPlatformVariant.Windows
                MaterialTheme(
                    colorScheme = scheme,
                    typography = if (fluent) windowsTypography(MaterialTheme.typography) else MaterialTheme.typography,
                    shapes = MaterialTheme.shapes,
                ) {
                    CompositionLocalProvider(LocalPolarisUi provides config, content = content)
                }
            }
        }
        PolarisBranding.PolarisKey -> {
            val resolved = remember(accent, darkTheme) { accent?.let { PolarisAccent.resolve(it.toHex(), darkTheme) } }
            // Windows (UK-10.5): a contrast theme draws the system colours, whatever the product accent.
            val fluent = autoPlatformVariant() == PolarisPlatformVariant.Windows
            val contrast = fluent && rememberThemeHostFacts()?.highContrast == true
            // macOS (UK-10.7): Mac scale type, and Increase Contrast draws full-contrast hairlines.
            val mac = autoPlatformVariant() == PolarisPlatformVariant.MacOS
            // GNOME (UK-10.11): the portal's `contrast` asks for full-contrast hairlines, as Increase Contrast does.
            val gnomeContrast = autoPlatformVariant() == PolarisPlatformVariant.Gnome && rememberThemeHostFacts()?.highContrast == true
            val macContrast = (mac && rememberMacHostFacts().highContrast) || gnomeContrast
            val scheme = remember(darkTheme, resolved, contrast, macContrast) {
                if (contrast) {
                    windowsContrastScheme(darkTheme)
                } else {
                    polarisBrandColorScheme(darkTheme).let { brand -> resolved?.let { brand.withAccent(it) } ?: brand.withInk(darkTheme) }
                        .let { if (macContrast) it.withMacContrast() else it }
                }
            }
            val system = if (contrast) FluentSystemColors.forTheme(darkTheme) else null
            val inkText = if (darkTheme) PolarisBrandTokens.Dark.textStrong else PolarisBrandTokens.Light.textStrong
            val typography = polarisBrandTypography(MaterialTheme.typography).let { if (fluent) windowsTypography(it) else if (mac) it.forMacScale() else it }
            val config = PolarisUiConfig(
                branding = branding,
                showPoweredBy = showPoweredBy,
                poweredByStyle = poweredByStyle,
                copy = copy,
                logo = logo,
                dark = darkTheme,
                status = if (contrast) PolarisStatusColors.from(scheme) else PolarisStatusColors.brand(darkTheme),
                // UI-KITS.md §1.4, Android: full-round buttons and radius-16 filled fields; Windows: radius 4.
                controlShape = if (fluent) PolarisFluent.controlShape else CircleShape,
                accentText = system?.hotlight ?: resolved?.let { colorOf(it.fg) } ?: inkText,
                fieldShape = if (fluent) PolarisFluent.controlShape else if (mac) polarisRadiusShape(PolarisKitTokens.MacOS.radiusForm.dp) else RoundedCornerShape(16.dp),
                focus = system?.windowText ?: resolved?.let { colorOf(it.focus) } ?: inkText,
                deviceCodeUrl = deviceCodeUrl,
                developer = developer,
            )
            MaterialTheme(colorScheme = scheme, typography = typography, shapes = if (fluent) polarisFluentShapes else polarisBrandShapes) {
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

/** The update prompt's bottom sheet: radius 28 on the top edge only (UI-KITS.md 1.4, Android). */
internal val polarisSheetShape: Shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)

/** The shape a screen rounds to while the back gesture previews the step it returns to (PolarisBack.kt). */
internal fun polarisPreviewShape(radius: androidx.compose.ui.unit.Dp): Shape = RoundedCornerShape(radius)

/** A rounded-corner shape of [radius] on every corner (the desktop chromes' radii; UK-10.6). */
internal fun polarisRadiusShape(radius: androidx.compose.ui.unit.Dp): Shape = RoundedCornerShape(radius)

/** The message card's radius 28. */
private val MessageCardShape: Shape = RoundedCornerShape(28.dp)

/** The message card on the Mac: radius 18, the sheet's (S8 nit). */
private val MacMessageCardShape: Shape = RoundedCornerShape(18.dp)

/** The product icon's 28 % squircle (UI-KITS.md §1.4, Android). */
private val ProductIconShape: Shape = RoundedCornerShape(28)

/**
 * [this] scheme with its primary roles in ink (UI-KITS.md §1.2): the strongest text colour as the
 * fill, the page as its label. A product with no accent of its own gets this, never the core violet.
 */
internal fun ColorScheme.withInk(dark: Boolean): ColorScheme {
    val strong = if (dark) PolarisBrandTokens.Dark.textStrong else PolarisBrandTokens.Light.textStrong
    val page = if (dark) PolarisBrandTokens.Dark.surfacePage else PolarisBrandTokens.Light.surfacePage
    val sunken = if (dark) PolarisBrandTokens.Dark.surfaceSunken else PolarisBrandTokens.Light.surfaceSunken
    return copy(
        primary = strong,
        onPrimary = page,
        primaryContainer = sunken,
        onPrimaryContainer = strong,
        surfaceTint = strong,
        inversePrimary = if (dark) PolarisBrandTokens.Light.textStrong else PolarisBrandTokens.Dark.textStrong,
    )
}

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
        get() = if (polarisWindow.fluent) PolarisFluent.controlShape else current.controlShape ?: ButtonDefaults.shape

    /** The shape of the kit's filled text fields: Material's filled-field shape neutral, radius 16 branded. */
    public val fieldShape: Shape
        @Composable
        get() = if (polarisWindow.fluent) PolarisFluent.controlShape else current.fieldShape ?: TextFieldDefaults.shape

    /** The product icon's shape: a 28 % squircle (the monogram tile, a host icon). */
    public val iconShape: Shape
        @Composable @ReadOnlyComposable
        get() = ProductIconShape

    /** A message screen's card on a wide window or TV: radius 28 (UI-KITS.md §1.4, Android sheets). */
    public val cardShape: Shape
        @Composable @ReadOnlyComposable
        get() = if (polarisWindow.fluent) PolarisFluent.overlayShape else if (polarisWindow.isMac) MacMessageCardShape else MessageCardShape

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
     * The accent of a Polaris Key service for a host's own section indicator: the service's brand
     * accent branded, the host's primary neutral. The kit's screens never use it: service cues are
     * off on product screens (UI-KITS.md 1.2) and return only for integrators who opt in by calling this.
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

/**
 * Polaris dark's tonal step for secondary buttons and cards: the overlay token moved a few percent
 * toward the default text colour. The overlay token alone sits at about 1.05:1 on the page, so "Try
 * again" and "Activate" read as bare text; this is about 1.2:1 and keeps the label far above 4.5:1.
 * Derived from the tokens, never a literal.
 */
private fun darkTonalStep(): Color = lerp(PolarisBrandTokens.Dark.surfaceOverlay, PolarisBrandTokens.Dark.textDefault, 0.06f)

/** The Material 3 colour scheme of the Polaris Key brand, from the generated tokens. */
public fun polarisBrandColorScheme(dark: Boolean): ColorScheme {
    val core = PolarisBrandTokens.accent("core", dark)
    val identity = PolarisBrandTokens.accent("identity", dark)
    return if (dark) {
        val t = PolarisBrandTokens.Dark
        darkColorScheme(
            primary = core.solid, onPrimary = core.on, primaryContainer = core.subtle, onPrimaryContainer = t.textStrong,
            inversePrimary = PolarisBrandTokens.Light.focus,
            secondary = t.textMuted, onSecondary = t.surfacePage, secondaryContainer = darkTonalStep(), onSecondaryContainer = t.textStrong,
            tertiary = identity.solid, onTertiary = identity.on, tertiaryContainer = identity.subtle, onTertiaryContainer = t.textStrong,
            background = t.surfacePage, onBackground = t.textDefault,
            surface = t.surfacePage, onSurface = t.textStrong, surfaceVariant = t.surfaceOverlay, onSurfaceVariant = t.textMuted,
            surfaceTint = core.solid,
            inverseSurface = PolarisBrandTokens.Light.surfacePage, inverseOnSurface = PolarisBrandTokens.Light.textStrong,
            error = t.danger, onError = t.dangerOn, errorContainer = t.dangerSubtle, onErrorContainer = t.textStrong,
            outline = t.borderStrong, outlineVariant = t.borderSubtle, scrim = t.surfaceSunken,
            surfaceBright = t.surfaceOverlay, surfaceDim = t.surfaceSunken,
            surfaceContainerLowest = t.surfaceSunken, surfaceContainerLow = t.surfaceRaised, surfaceContainer = t.surfaceRaised,
            surfaceContainerHigh = darkTonalStep(), surfaceContainerHighest = darkTonalStep(),
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

/** An opaque colour from 0xRRGGBB (the platform neutrals below). */
private fun neutral(rgb: Long): Color = Color(0xFF000000L or rgb) // polaris-lint: allow-colour (the platform neutrals)

/**
 * The native preset's scheme on Windows and GNOME: the platform's neutral layers, not the brand's
 * surfaces. Windows 11 mica 202227 with the layer 2b2d33 (dark), eef1f4 and f9f9fb (light);
 * libadwaita's page 222226 with the card 2e2e32 (dark), fafafb and ffffff (light). An
 * overlay (a dialog) sits on the layer or card, never on the page. Primary is ink until an accent
 * (the host's, the product's) replaces it.
 */
internal fun platformNeutralScheme(variant: PolarisPlatformVariant, dark: Boolean): ColorScheme {
    val gnome = variant == PolarisPlatformVariant.Gnome
    val page = neutral(if (dark) (if (gnome) 0x222226 else 0x202227) else (if (gnome) 0xFAFAFB else 0xEEF1F4))
    val layer = neutral(if (dark) (if (gnome) 0x2E2E32 else 0x2B2D33) else (if (gnome) 0xFFFFFF else 0xF9F9FB))
    val raised = neutral(if (dark) (if (gnome) 0x3A3A3F else 0x363941) else (if (gnome) 0xEBEBED else 0xFFFFFF))
    val text = neutral(if (dark) 0xFFFFFF else (if (gnome) 0x2E2E32 else 0x1A1A1A))
    val muted = neutral(if (dark) 0xC4C6CC else 0x5C5F66)
    val edge = neutral(if (dark) 0x45464D else 0xD0D3D9)
    val danger = neutral(if (dark) 0xFF7B63 else 0xC01C28)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = text, onPrimary = page, primaryContainer = raised, onPrimaryContainer = text,
        secondary = muted, onSecondary = page, secondaryContainer = raised, onSecondaryContainer = text,
        background = page, onBackground = text,
        surface = page, onSurface = text, surfaceVariant = layer, onSurfaceVariant = muted,
        surfaceTint = Color.Transparent,
        error = danger, onError = page,
        outline = muted, outlineVariant = edge,
        surfaceBright = layer, surfaceDim = page,
        surfaceContainerLowest = page, surfaceContainerLow = layer, surfaceContainer = layer,
        surfaceContainerHigh = layer, surfaceContainerHighest = raised,
    )
}

/** The Windows controls' shape: radius 4 (`PolarisKitTokens.Windows`). */
internal val polarisFluentControlShape: RoundedCornerShape =
    RoundedCornerShape(((PolarisKitTokens.Windows.radiusControl as KitRadius.Fixed).dp).dp)

/** The Windows overlays' shape (the ContentDialog, a card): radius 8. */
internal val polarisFluentOverlayShape: RoundedCornerShape = RoundedCornerShape(PolarisKitTokens.Windows.radiusOverlay.dp)

/** The Material shapes of the Windows chrome: controls 4, overlays 8. */
internal val polarisFluentShapes: Shapes = Shapes(
    extraSmall = polarisFluentControlShape,
    small = polarisFluentControlShape,
    medium = polarisFluentOverlayShape,
    large = polarisFluentOverlayShape,
    extraLarge = polarisFluentOverlayShape,
)

/** The brand radii as Material shapes: controls md, cards lg, the largest surfaces xl. */
public val polarisBrandShapes: Shapes = Shapes(
    extraSmall = RoundedCornerShape(PolarisBrandTokens.Radius.sm.dp),
    small = RoundedCornerShape(PolarisBrandTokens.Radius.md.dp),
    medium = RoundedCornerShape(PolarisBrandTokens.Radius.lg.dp),
    large = RoundedCornerShape(PolarisBrandTokens.Radius.xl.dp),
    extraLarge = RoundedCornerShape(PolarisBrandTokens.Radius.xl.dp),
)
