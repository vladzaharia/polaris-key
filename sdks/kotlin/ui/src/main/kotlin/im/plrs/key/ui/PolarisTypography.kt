// The kit's type. Neutral, the screens use the host's MaterialTheme.typography as it is. Branded,
// every Material text style is re-set in Rubik (BRAND.md §1.6): Bold for display, headline and
// title roles, Regular for body and label roles. The kit ships only those two weights, so a role
// that Material sets in Medium is mapped to one of them rather than synthesised.
//
// ── WHY BUNDLING RUBIK IS CLEAN ─────────────────────────────────────────────────────────────────
//
// Rubik is under the SIL Open Font License 1.1 with no Reserved Font Name. The OFL lets the fonts be
// bundled with any software, whatever its own licence, provided they are not sold by themselves and
// the copyright notice and licence travel with them. :ui ships the kit's TTFs unchanged in
// res/font (polaris_rubik_regular.ttf, polaris_rubik_bold.ttf; `pnpm gen:brand -- --check` compares
// them byte for byte with packages/brand/kit) and the kit's OFL.txt and FONT-NOTICE.txt in
// assets/polaris-key/fonts/, so the licence is inside every APK that carries the fonts. A neutral
// kit never loads them; R8's resource shrinking drops them from an app that never brands.

package im.plrs.key.ui

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

/** Rubik Regular and Bold, bundled with the kit. */
public val PolarisRubik: FontFamily = FontFamily(
    Font(R.font.polaris_rubik_regular, FontWeight.Normal),
    Font(R.font.polaris_rubik_bold, FontWeight.Bold),
)

/** [base] re-set in Rubik: Bold for display, headline and title roles, Regular for the rest. */
public fun polarisBrandTypography(base: Typography): Typography {
    fun bold(style: TextStyle) = style.copy(fontFamily = PolarisRubik, fontWeight = FontWeight.Bold)
    fun regular(style: TextStyle) = style.copy(fontFamily = PolarisRubik, fontWeight = FontWeight.Normal)
    return Typography(
        displayLarge = bold(base.displayLarge),
        displayMedium = bold(base.displayMedium),
        displaySmall = bold(base.displaySmall),
        headlineLarge = bold(base.headlineLarge),
        headlineMedium = bold(base.headlineMedium),
        headlineSmall = bold(base.headlineSmall),
        titleLarge = bold(base.titleLarge),
        titleMedium = bold(base.titleMedium),
        titleSmall = bold(base.titleSmall),
        bodyLarge = regular(base.bodyLarge),
        bodyMedium = regular(base.bodyMedium),
        bodySmall = regular(base.bodySmall),
        labelLarge = regular(base.labelLarge),
        labelMedium = regular(base.labelMedium),
        labelSmall = regular(base.labelSmall),
    )
}
