// The desktop actuals of the kit's fonts. Rubik is the brand's wght 400-600 subset on the classpath
// (copied by packages/brand/scripts/gen.ts), so a Linux host's wider system sans no longer shifts the
// layout (a Mac host keeps its own sans). JetBrains Mono is not bundled on the desktop: the host's
// monospace draws it.

package im.plrs.key.ui

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.text.font.Font as FontType

public actual val PolarisKitMono: FontFamily = FontFamily.Monospace

private const val RUBIK_RESOURCE = "im/plrs/key/ui/fonts/Rubik-Variable-kit.ttf"

@OptIn(ExperimentalTextApi::class)
private fun rubikAt(weight: FontWeight): FontType =
    Font(RUBIK_RESOURCE, weight, variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)))

@OptIn(ExperimentalTextApi::class)
private fun bundledRubik(): FontFamily = runCatching {
    FontFamily(rubikAt(FontWeight.Normal), rubikAt(FontWeight.Medium), rubikAt(FontWeight.SemiBold))
}.getOrDefault(FontFamily.SansSerif)

// A Mac host keeps its own sans (the Mac chrome is laid out in it); Windows and Linux draw the brand's Rubik.
public actual val PolarisRubik: FontFamily =
    if (System.getProperty("os.name").orEmpty().startsWith("Mac")) FontFamily.SansSerif else bundledRubik()
