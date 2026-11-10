// @pkey-feature ui.kit
// The parts of SaveConflict (U-22.K4/UX2): a version's card with its Newer tag, and the destructive outline.
package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** The Newer tag's vertical inset: tighter than the first rhythm step. */
private val NewerTagVertical = 2.dp

/** One copy of the save: whose it is, the Newer tag when named, and when it was saved. */
@Composable
internal fun SaveCard(who: String, whenText: String?, newer: String?, modifier: Modifier, compact: Boolean = false) {
    Surface(
        modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.padding(horizontal = PolarisSpace.medium, vertical = if (compact) 8.dp else PolarisSpace.controls),
            verticalArrangement = Arrangement.spacedBy(PolarisSpace.hairline),
        ) {
            // The name in full, then Newer when the app says it was saved later (a tag, never a control), then the date.
            Text(who, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
            if (newer != null) {
                Surface(
                    shape = MaterialTheme.shapes.small,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                ) {
                    Text(
                        newer,
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.padding(horizontal = PolarisSpace.tight, vertical = NewerTagVertical),
                    )
                }
            }
            if (whenText != null) {
                Text(whenText, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A destructive choice that is not the default: outlined in the danger colour, the size of the other actions. */
@Composable
internal fun PolarisDangerOutlineButton(text: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val shape = polarisActionShape(suggested = false)
    val danger = MaterialTheme.colorScheme.error
    OutlinedButton(
        onClick = onClick,
        shape = shape,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = danger),
        border = BorderStroke(1.dp, danger),
        interactionSource = interaction,
        modifier = Modifier.polarisFocusIndication(interaction, shape).controlSize(),
    ) { Text(text, textAlign = TextAlign.Center) }
}
