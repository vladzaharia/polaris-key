// The release channel choice (UI-KITS.md §4.1 ChannelPicker: default · locked). Default is one
// radio list of the channels the install may switch to, the one in use checked; locked is the
// current channel with the lock and the reason, always: the outlet that fixes it, in the catalog's
// words ("Google Play sets the channel."). A picker with no handler to act on a pick, or with
// nothing to pick, is not drawn (a host-dependent action draws only when the host can act on it).

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** A row's side inset, the one the settings rows use, and the gap between a row's two lines. */
private val RowInset = 16.dp
private val LineGap = 2.dp

/**
 * A channel's name: the catalog's label when it has one, else the id as words ("early-access" is
 * "Early access"), never the raw slug (DL8).
 */
internal fun channelLabel(id: String, labels: Map<String, String> = emptyMap()): String =
    labels[id]?.takeIf { it.isNotBlank() }
        ?: id.replace('-', ' ').replace('_', ' ').trim().replaceFirstChar { it.uppercase() }

/** Why the picker is locked: the catalog's sentence with the outlet's store name. */
internal fun channelLockedReason(lockedBy: String, locale: String): String =
    KitCopy.bundled.format("channel.locked", locale, mapOf("store" to CopyArgument.Text(outletStoreName(lockedBy))))

/**
 * The channel choice. [onSelect] is the host's handler for a pick; without it the unlocked picker
 * draws nothing, and a locked one is still drawn (it says why, which needs no handler).
 */
@Composable
public fun PolarisChannelPicker(
    channel: PolarisChannelUi,
    modifier: Modifier = Modifier,
    onSelect: ((String) -> Unit)? = null,
    /** Why the host's switch failed, shown under the list (DL7); null when the last pick went through. */
    error: String? = null,
) {
    if (!channel.drawn) return
    if (!channel.locked && onSelect == null) return
    val locale = kitLocale()
    val catalog = KitCopy.bundled
    PolarisSection(catalog.format("channel.title", locale), modifier) {
        val lockedBy = channel.lockingOutlet
        if (lockedBy != null || channel.lockedByLicense) {
            val reason = if (lockedBy != null) channelLockedReason(lockedBy, locale) else catalog.format("channel.lockedLicense", locale)
            PolarisChannelLocked(channelLabel(channel.current, channel.labels), reason, catalog.format("a11y.locked", locale))
        } else {
            Column(Modifier.selectableGroup()) {
            channel.options.distinct().forEachIndexed { i, id ->
                if (i > 0) HorizontalDivider(Modifier.padding(horizontal = RowInset), color = MaterialTheme.colorScheme.outlineVariant)
                val selected = id == channel.current
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .selectable(selected = selected, role = Role.RadioButton, onClick = { if (!selected) onSelect?.invoke(id) })
                        .padding(horizontal = RowInset, vertical = PolarisSpace.controls),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(channelLabel(id, channel.labels), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
                    if (selected) Icon(PolarisSymbols.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                }
            }
            }
            if (error != null) {
                Text(
                    error,
                    style = MaterialTheme.typography.bodySmall,
                    color = PolarisTheme.status.danger,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = RowInset, vertical = PolarisSpace.controls)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

/** The fixed channel, the lock and the reason under it, read as one row. */
@Composable
private fun PolarisChannelLocked(label: String, reason: String, lockLabel: String) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = RowInset, vertical = PolarisSpace.controls).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(LineGap)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            Text(reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(RowInset))
        Icon(PolarisSymbols.Lock, contentDescription = lockLabel, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
    }
}
