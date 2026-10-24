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
// `pnpm gen brand` still writes and `pnpm gen brand --check` compares byte for byte with
// packages/brand/kit) and the kit's OFL.txt and FONT-NOTICE.txt in assets/polaris-key/fonts/, so
// the licence is inside every APK that carries the fonts. A neutral kit reads Rubik only for the
// monogram tile it draws when the host passes no product icon.

package im.plrs.key.ui

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

/** JetBrains Mono (the kit mono) for user codes and keys when branded; the platform's fonts per actual. */
public expect val PolarisKitMono: FontFamily

/** Rubik at 400, 500 and 600 where the platform bundles it (Android); the desktop's sans until its fonts land. */
public expect val PolarisRubik: FontFamily

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
