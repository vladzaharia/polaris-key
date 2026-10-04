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
import im.plrs.key.packs.PackProgress
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.math.roundToInt

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** One pack's progress. */
public data class PolarisPackRow(
    val packId: String,
    val phase: Phase,
    val done: Long,
    val total: Long,
) {
    public enum class Phase { Downloading, Installing, Done, Issue }

    /** 0..1, or null when the total is unknown. */
    val fraction: Float?
        get() = when {
            phase == Phase.Done -> 1f
            total <= 0 -> null
            else -> (done.toFloat() / total).coerceIn(0f, 1f)
        }
}

/** Every pack's progress, in the order the engine first reported each. */
public data class PolarisPackProgressUi(val packs: List<PolarisPackRow> = emptyList()) {
    /** Bytes done and in total across the packs that report a total. */
    val doneBytes: Long get() = packs.sumOf { if (it.phase == PolarisPackRow.Phase.Done) it.total.coerceAtLeast(it.done) else it.done }
    val totalBytes: Long get() = packs.sumOf { it.total.coerceAtLeast(0) }

    /** 0..1 overall, or null when no pack reports a total yet. */
    val fraction: Float? get() = if (totalBytes <= 0) null else (doneBytes.toFloat() / totalBytes).coerceIn(0f, 1f)

    val complete: Boolean get() = packs.isNotEmpty() && packs.all { it.phase == PolarisPackRow.Phase.Done }

    /** Fold one engine event in. Unknown phases are ignored. */
    public fun reduce(event: PackProgress): PolarisPackProgressUi {
        val phase = when (event.phase) {
            "download" -> PolarisPackRow.Phase.Downloading
            "apply" -> PolarisPackRow.Phase.Installing
            "done" -> PolarisPackRow.Phase.Done
            "state-issue" -> PolarisPackRow.Phase.Issue
            else -> return this
        }
        val row = PolarisPackRow(event.packId, phase, event.done.coerceAtLeast(0), event.total.coerceAtLeast(0))
        val i = packs.indexOfFirst { it.packId == event.packId }
        return copy(packs = if (i < 0) packs + row else packs.toMutableList().also { it[i] = row })
    }
}

/**
 * Collects the pack engine's progress. [subscribe] registers a listener and returns its
 * unsubscribe ([PolarisKeyClient.packProgressSource] wires `client.packs.on`).
 */
public class PolarisPackProgressState(private val subscribe: ((PackProgress) -> Unit) -> (() -> Unit)) {
    private val _ui = MutableStateFlow(PolarisPackProgressUi())
    public val ui: StateFlow<PolarisPackProgressUi> = _ui.asStateFlow()
    private var unsubscribe: (() -> Unit)? = null

    /** Start listening (idempotent). */
    public fun start() {
        if (unsubscribe != null) return
        unsubscribe = subscribe { event -> _ui.update { it.reduce(event) } }
    }

    public fun stop() {
        unsubscribe?.invoke()
        unsubscribe = null
    }

    /** Forget finished rows (a new install run starts clean). */
    public fun reset() {
        _ui.value = PolarisPackProgressUi()
    }
}

/** The umbrella client's pack engine as a progress source. */
public fun PolarisKeyClient.packProgressSource(): ((PackProgress) -> Unit) -> (() -> Unit) = { listener -> packs.on(listener) }

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
        Spacer(Modifier.height(16.dp))
        val overall = ui.fraction
        if (overall != null) {
            PolarisBody(copy.format(copy.packsBytes, copy.bytes(ui.doneBytes), copy.bytes(ui.totalBytes)))
            Spacer(Modifier.height(12.dp))
        }
        PolarisProgressBar(overall, copy.format(copy.packsPercent, ((overall ?: 0f) * 100).roundToInt()))
        if (ui.packs.isNotEmpty()) {
            Spacer(Modifier.height(24.dp))
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
