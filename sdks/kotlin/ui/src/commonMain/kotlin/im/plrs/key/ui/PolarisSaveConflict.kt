// @pkey-feature ui.kit
// SaveConflict (U-22.K4; ui-matrix `saveConflict`): the same save changed on two devices and the
// person picks the one to keep. Drawn from the catalog lines of a KitScreen that KitStates resolved,
// the way the Cloud Sync screens are, so the same inputs draw the same screen as the React kit.
//
//  - `choose` is one undocked column in reading order: the two copies (side by side from 600 dp,
//    this device's first, never swapped), then the three choices, the slots-full reason under Keep
//    both, and Cancel. Nothing is filled or focused: no choice is the default, so a save is never
//    discarded without one;
//  - Keep both stays on the screen, disabled and described by its reason, while all 16 slots are in
//    use; when the other copy was deleted it goes, Keep the other becomes Delete it here too (an
//    outlined control in the danger colour), and the title and lede say so;
//  - `keeping` offers no control, `kept` names the choice that was made, `failed` says both saves
//    are unchanged and offers Try again (secondary) and Cancel; the heading, not a button, takes
//    the focus.
package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonElement

/** The width from which the two copies sit side by side. */
private val SIDE_BY_SIDE = 600.dp

/**
 * SaveConflict: [screen] is one of the component's states, choose, keeping, kept or failed.
 *
 * @param onKeep a choice was made; the host applies it and moves the state on (K.4T binds the saves client).
 * @param onRetry Try again, after a choice failed.
 * @param onCancel Cancel (or Back): the conflict stays as it was.
 * @param onDone Done, after the choice was kept.
 */
@Composable
public fun PolarisSaveConflict(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    onKeep: (PolarisSaveKeep) -> Unit = {},
    onRetry: () -> Unit = {},
    onCancel: () -> Unit = {},
    onDone: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val title = (lines.text("saveConflict.deletedTitle") ?: lines.text("saveConflict.title")).orEmpty()
    val back = when (screen.state) {
        "kept" -> PolarisBackHandler(enabled = true, onBack = onDone)
        "keeping" -> PolarisBackHandler(enabled = true) {}
        else -> PolarisBackHandler(enabled = true, onBack = onCancel)
    }
    // No `actions` slot: the scaffold would dock them. Here nothing is the primary, so the choices
    // flow after the copies in one column and nothing sticks to an edge over the others.
    PolarisScaffold(modifier.then(back), anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        PolarisProductHeader()
        PolarisTitle(title)
        when (screen.state) {
            "keeping" -> {
                Spacer(Modifier.height(PolarisSpace.group))
                PolarisWaitIndicator()
                Spacer(Modifier.height(PolarisSpace.controls))
                Text(
                    lines.text("saveConflict.keeping").orEmpty(),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
                )
            }

            "kept" -> {
                Spacer(Modifier.height(PolarisSpace.tight))
                val kept = listOf("saveConflict.keptLocal", "saveConflict.keptRemote", "saveConflict.keptBoth", "saveConflict.keptDeleted")
                    .firstNotNullOfOrNull(lines::text)
                Row(
                    Modifier.fillMaxWidth().semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(PolarisSymbols.Check, contentDescription = null, tint = PolarisTheme.status.success, modifier = Modifier.size(20.dp))
                    Text(
                        kept.orEmpty(),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.height(PolarisSpace.group))
                PolarisPrimaryButton(lines.format("common.done"), onDone)
            }

            "failed" -> {
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisErrorLine(lines.text("saveConflict.failed").orEmpty())
                Spacer(Modifier.height(PolarisSpace.group))
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
                    PolarisSecondaryButton(lines.format("common.tryAgain"), onRetry)
                    PolarisTextButton(lines.format("common.cancel"), onCancel)
                }
            }

            else -> Choose(lines, onKeep, onCancel)
        }
    }
}

@Composable
private fun Choose(lines: KitLines, onKeep: (PolarisSaveKeep) -> Unit, onCancel: () -> Unit) {
    val gone = lines.has("saveConflict.deletedElsewhere")
    val full = lines.has("saveConflict.bothFull")
    Spacer(Modifier.height(PolarisSpace.tight))
    (lines.text("saveConflict.deletedLede") ?: lines.text("saveConflict.lede"))?.let { PolarisBody(it, textAlign = TextAlign.Start) }
    Spacer(Modifier.height(PolarisSpace.medium))
    val local = lines.text("saveConflict.thisDevice").orEmpty() to lines.text("saveConflict.savedThis")
    val other = (
        lines.text("saveConflict.deletedElsewhere") ?: lines.text("saveConflict.otherDevice") ?: lines.text("saveConflict.otherUnknown")
        ).orEmpty() to lines.text("saveConflict.savedOther")
    // This device's copy first, whatever the size: the choices never swap sides.
    if (polarisWindow.width >= SIDE_BY_SIDE) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            SaveCard(local.first, local.second, Modifier.weight(1f).fillMaxHeight())
            SaveCard(other.first, other.second, Modifier.weight(1f).fillMaxHeight())
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            SaveCard(local.first, local.second, Modifier)
            SaveCard(other.first, other.second, Modifier)
        }
    }
    Spacer(Modifier.height(PolarisSpace.group))
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
        PolarisSecondaryButton(lines.text("saveConflict.keepThis").orEmpty(), { onKeep(PolarisSaveKeep.Local) })
        if (gone) {
            PolarisDangerOutlineButton(lines.text("saveConflict.acceptDelete").orEmpty(), { onKeep(PolarisSaveKeep.Remote) })
        } else {
            PolarisSecondaryButton(lines.text("saveConflict.keepOther").orEmpty(), { onKeep(PolarisSaveKeep.Remote) })
        }
        lines.text("saveConflict.keepBoth")?.let { both ->
            val reason = lines.text("saveConflict.bothFull")
            // Drawn disabled while every slot is in use, and described by the reason shown under it.
            PolarisSecondaryButton(
                both,
                { onKeep(PolarisSaveKeep.Both) },
                Modifier.then(if (full && reason != null) Modifier.semantics { stateDescription = reason } else Modifier),
                enabled = !full,
            )
        }
        lines.text("saveConflict.bothFull")?.let { PolarisBody(it, textAlign = TextAlign.Start) }
        PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
    }
}

/** One copy of the save: whose it is and when it was saved. */
@Composable
private fun SaveCard(who: String, whenText: String?, modifier: Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.padding(horizontal = PolarisSpace.medium, vertical = PolarisSpace.controls),
            verticalArrangement = Arrangement.spacedBy(PolarisSpace.hairline),
        ) {
            Text(who, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
            if (whenText != null) {
                Text(whenText, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A destructive choice that is not the default: outlined in the danger colour, the size of the other actions. */
@Composable
private fun PolarisDangerOutlineButton(text: String, onClick: () -> Unit) {
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

/** SaveConflict bound to its [state] holder; nothing draws once the person cancelled or closed the result. */
@Composable
public fun PolarisSaveConflict(
    state: PolarisSaveConflictState,
    modifier: Modifier = Modifier,
    base: Map<String, JsonElement> = emptyMap(),
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    val step by state.ui.collectAsState()
    val screen = remember(step) { state.kitScreen(base) } ?: return
    PolarisSaveConflict(screen, modifier, state::keep, state::retry, state::cancel, state::done, catalog, locale)
}
