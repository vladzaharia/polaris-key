// The kit's type. Neutral, the screens use the host's MaterialTheme.typography as it is. Branded,
// every Material text style is re-set in Rubik (BRAND.md §1.6) at the three weights UI-KITS.md §1.5
// rule 6 allows: 600 for display, headline and title roles, 500 for label roles (buttons, chips,
// the product header), 400 for body roles. Nothing is set in 700. The weights come from the
// variable Rubik (wght 300–900), so none is synthesised.
//
// ── WHY BUNDLING RUBIK IS CLEAN ─────────────────────────────────────────────────────────────────
//
// Rubik is under the SIL Open Font License 1.1 with no Reserved Font Name. The OFL lets the fonts be
// bundled with any software, whatever its own licence, provided they are not sold by themselves and
// the copyright notice and licence travel with them. :ui ships the kit's TTFs unchanged in
// res/font (polaris_rubik_variable.ttf, which the kit reads, and the static regular and bold that
// `pnpm gen:brand` still writes and `pnpm gen:brand -- --check` compares byte for byte with
// packages/brand/kit) and the kit's OFL.txt and FONT-NOTICE.txt in assets/polaris-key/fonts/, so
// the licence is inside every APK that carries the fonts. A neutral kit reads Rubik only for the
// monogram tile it draws when the host passes no product icon.

package im.plrs.key.ui

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight

/**
 * JetBrains Mono (the kit mono, UI-KITS.md §2.1; OFL, its licence in assets/polaris-key/fonts/
 * OFL-JetBrainsMono.txt) at weight 500, for user codes and keys when branded. Neutral screens use
 * the platform monospace instead.
 */
@OptIn(ExperimentalTextApi::class)
public val PolarisKitMono: FontFamily = if (android.os.Build.VERSION.SDK_INT >= 26) {
    FontFamily(
        Font(R.font.polaris_jetbrains_mono_variable, FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
    )
} else {
    // No static mono file ships: the platform monospace beats a light-weight variable default.
    FontFamily.Monospace
}

/** Rubik at 400, 500 and 600, from the kit's variable font: each weight sets the font's wght axis. */
public val PolarisRubik: FontFamily = polarisRubikFor(android.os.Build.VERSION.SDK_INT)

/**
 * Rubik for an API level. FontVariation needs API 26: below it a variable font renders at its
 * default instance (weight 300, so all text would be light), so there the kit falls back to the
 * static regular (400 and 500) and bold (600) files.
 */
@OptIn(ExperimentalTextApi::class)
internal fun polarisRubikFor(sdkInt: Int): FontFamily = if (sdkInt >= 26) {
    FontFamily(
        Font(R.font.polaris_rubik_variable, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
        Font(R.font.polaris_rubik_variable, FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
        Font(R.font.polaris_rubik_variable, FontWeight.SemiBold, variationSettings = FontVariation.Settings(FontVariation.weight(600))),
    )
} else {
    FontFamily(
        Font(R.font.polaris_rubik_regular, FontWeight.Normal),
        Font(R.font.polaris_rubik_regular, FontWeight.Medium),
        Font(R.font.polaris_rubik_bold, FontWeight.SemiBold),
    )
}

/** [base] re-set in Rubik: 600 for display, headline and title roles, 500 for labels, 400 for body. */
public fun polarisBrandTypography(base: Typography): Typography {
    fun weight(style: TextStyle, weight: FontWeight) = style.copy(fontFamily = PolarisRubik, fontWeight = weight)
    val heading = FontWeight.SemiBold
    val label = FontWeight.Medium
    val body = FontWeight.Normal
    return Typography(
        displayLarge = weight(base.displayLarge, heading),
        displayMedium = weight(base.displayMedium, heading),
        displaySmall = weight(base.displaySmall, heading),
        headlineLarge = weight(base.headlineLarge, heading),
        headlineMedium = weight(base.headlineMedium, heading),
        headlineSmall = weight(base.headlineSmall, heading),
        titleLarge = weight(base.titleLarge, heading),
        titleMedium = weight(base.titleMedium, heading),
        titleSmall = weight(base.titleSmall, heading),
        bodyLarge = weight(base.bodyLarge, body),
        bodyMedium = weight(base.bodyMedium, body),
        bodySmall = weight(base.bodySmall, body),
        labelLarge = weight(base.labelLarge, label),
        labelMedium = weight(base.labelMedium, label),
        labelSmall = weight(base.labelSmall, label),
    )
}
