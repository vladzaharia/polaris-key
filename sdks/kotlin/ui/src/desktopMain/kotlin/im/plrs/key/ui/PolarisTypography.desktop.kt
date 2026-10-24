// The desktop actuals of the kit's fonts (UK-10.3). The bundled Rubik and JetBrains Mono reach the
// desktop with its variants (UK-10.4+); until then the desktop's own sans and monospace draw the
// branded type, so text is always legible rather than missing.

package im.plrs.key.ui

import androidx.compose.ui.text.font.FontFamily

public actual val PolarisKitMono: FontFamily = FontFamily.Monospace

public actual val PolarisRubik: FontFamily = FontFamily.SansSerif
