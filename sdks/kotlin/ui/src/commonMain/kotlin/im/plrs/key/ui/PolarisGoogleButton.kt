// @pkey-feature identity.autosignin
// The "Continue with Google" button: Google's own mark and fill, not the product accent (UI-KITS.md
// §3.6; the asset and its three fills are the brand package's PolarisProviderMarks). Light on a light
// scheme, dark on a dark one. The label is the catalog's; the G is drawn unmodified and is not read out.
package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.PolarisProviderMarks

/** The catalog key of a Google sign-in button's label, and the provider name that selects this button. */
internal const val GOOGLE_PROVIDER_NAME: String = "Google"

/** Whether the "Continue with {provider}" line [args] names Google. */
internal fun isGoogleProviderLine(key: String, args: Map<String, CopyArgument>): Boolean =
    key == PolarisProviderMarks.GOOGLE_LABEL_COPY_KEY && (args["provider"] as? CopyArgument.Text)?.value == GOOGLE_PROVIDER_NAME

/**
 * Google's sign-in button around [text]. The fill follows the colour scheme (light or dark),
 * never the accent; the G is half the button's height, [PolarisProviderMarks.GOOGLE_G_LABEL_GAP] dp
 * from the label.
 */
@Composable
public fun PolarisGoogleButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    initialFocus: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val shape = polarisActionShape(suggested = false)
    val fill = PolarisProviderMarks.GoogleButton.forScheme(MaterialTheme.colorScheme.background.luminance() < 0.5f)
    val glyph = (polarisWindow.controlHeight * PolarisProviderMarks.GOOGLE_G_HEIGHT_RATIO)
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = shape,
        colors = ButtonDefaults.buttonColors(containerColor = fill.fill, contentColor = fill.label),
        border = fill.border?.let { BorderStroke(1.dp, it) },
        contentPadding = if (polarisWindow.isMac) PolarisMac.buttonPadding else polarisButtonPadding(),
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize(),
    ) {
        Image(PolarisProviderMarks.GoogleG, contentDescription = null, modifier = Modifier.size(glyph))
        Spacer(Modifier.width(PolarisProviderMarks.GOOGLE_G_LABEL_GAP.dp))
        Text(text, textAlign = TextAlign.Center)
    }
}
