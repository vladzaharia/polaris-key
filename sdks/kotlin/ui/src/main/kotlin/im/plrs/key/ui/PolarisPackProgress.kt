// Pack progress: the pack engine's progress events (PacksClient.on: `download`, `apply`, `done`,
// `state-issue`) folded into one row per pack and an overall figure, by a pure reducer
// (PolarisPackProgressUi.reduce, unit-tested), and rendered as a card of labelled progress bars.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

// ── Composables ──────────────────────────────────────────────────────────────────────────────

@Composable
public fun PolarisPackProgress(
    state: PolarisPackProgressState,
    modifier: Modifier = Modifier,
    label: (String) -> String = { it },
) {
    DisposableEffect(state) {
        state.start()
        onDispose { state.stop() }
    }
    val ui by state.ui.collectAsState()
    PolarisPackProgressScreen(ui, modifier, label)
}

/** The phase's label. */
public fun PolarisCopy.packPhase(phase: PolarisPackRow.Phase): String = when (phase) {
    PolarisPackRow.Phase.Downloading -> packsDownloading
    PolarisPackRow.Phase.Installing -> packsInstalling
    PolarisPackRow.Phase.Done -> packsDone
    PolarisPackRow.Phase.Issue -> packsIssue
}

/** "1.2 MB of 4 MB", or the phase alone when the size is unknown. */
public fun PolarisCopy.packDetail(row: PolarisPackRow): String =
    if (row.total > 0 && row.phase != PolarisPackRow.Phase.Done) format(packsBytes, bytes(row.done), bytes(row.total))
    else if (row.total > 0) bytes(row.total)
    else ""

/** The full-screen pack progress: a title, the overall bar, and a card of per-pack rows. */
@Composable
public fun PolarisPackProgressScreen(ui: PolarisPackProgressUi, modifier: Modifier = Modifier, label: (String) -> String = { it }) {
    val copy = PolarisTheme.copy
    PolarisScreen(modifier = modifier) {
        PolarisTitle(if (ui.complete) copy.packsComplete else copy.packsTitle)
        Spacer(Modifier.height(PolarisSpace.tight))
        val overall = ui.fraction
        if (overall != null) {
            PolarisBody(copy.format(copy.packsBytes, copy.bytes(ui.doneBytes), copy.bytes(ui.totalBytes)))
            Spacer(Modifier.height(PolarisSpace.controls))
        }
        PolarisProgressBar(overall, copy.format(copy.packsPercent, ((overall ?: 0f) * 100).roundToInt()))
        if (ui.packs.isNotEmpty()) {
            Spacer(Modifier.height(polarisWindow.section))
            PolarisPackList(ui, label = label)
        }
    }
}

/** The per-pack rows as a section card, for a screen or a settings page. */
@Composable
public fun PolarisPackList(ui: PolarisPackProgressUi, modifier: Modifier = Modifier, label: (String) -> String = { it }) {
    val copy = PolarisTheme.copy
    PolarisSection(title = null, modifier = modifier) {
        ui.packs.forEachIndexed { i, row ->
            if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).semantics(mergeDescendants = true) {},
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        label(row.packId),
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        copy.packPhase(row.phase),
                        style = MaterialTheme.typography.labelLarge,
                        color = if (row.phase == PolarisPackRow.Phase.Issue) PolarisTheme.status.danger else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                PolarisProgressBar(row.fraction, copy.packPhase(row.phase))
                val detail = copy.packDetail(row)
                if (detail.isNotEmpty()) {
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** A linear progress bar in the release accent (primary, neutral); indeterminate when [fraction] is null. */
@Composable
internal fun PolarisProgressBar(fraction: Float?, description: String) {
    val color = PolarisTheme.accent("release")
    if (fraction == null) {
        LinearProgressIndicator(
            modifier = Modifier.fillMaxWidth().semantics { stateDescription = description },
            color = color,
        )
    } else {
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth().semantics {
                progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
                stateDescription = description
            },
            color = color,
            drawStopIndicator = {},
        )
    }
}
