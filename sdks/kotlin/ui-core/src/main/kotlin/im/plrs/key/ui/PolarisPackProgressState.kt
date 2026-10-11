// The Compose-free pack-progress reducer and subscription holder. A renderer decides whether the
// result is a screen, row, toast or notification; every host folds the engine events identically.
package im.plrs.key.ui

import im.plrs.key.packs.PackProgress
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** One pack's progress. */
public data class PolarisPackRow(
    val packId: String,
    val phase: Phase,
    val done: Long,
    val total: Long,
) {
    public enum class Phase { Downloading, Installing, Done, Issue }

    /** 0..1, or null when the total is unknown. */
    public val fraction: Float?
        get() = when {
            phase == Phase.Done -> 1f
            total <= 0 -> null
            else -> (done.toFloat() / total).coerceIn(0f, 1f)
        }
}

/** Every pack's progress, in the order the engine first reported each. */
public data class PolarisPackProgressUi(val packs: List<PolarisPackRow> = emptyList()) {
    /** Bytes done and in total across the packs that report a total. */
    public val doneBytes: Long
        get() = packs.sumOf { if (it.phase == PolarisPackRow.Phase.Done) it.total.coerceAtLeast(it.done) else it.done }
    public val totalBytes: Long get() = packs.sumOf { it.total.coerceAtLeast(0) }

    /** 0..1 overall, or null when no pack reports a total yet. */
    public val fraction: Float?
        get() = if (totalBytes <= 0) null else (doneBytes.toFloat() / totalBytes).coerceIn(0f, 1f)

    public val complete: Boolean get() = packs.isNotEmpty() && packs.all { it.phase == PolarisPackRow.Phase.Done }

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
 * unsubscribe; [PolarisKeyClient.packProgressSource] adapts `client.packs.on`.
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

    /** Forget finished rows; a new install run starts clean. */
    public fun reset() {
        _ui.value = PolarisPackProgressUi()
    }
}

/** The umbrella client's pack engine as a progress source. */
public fun PolarisKeyClient.packProgressSource(): ((PackProgress) -> Unit) -> (() -> Unit) = { listener -> packs.on(listener) }
