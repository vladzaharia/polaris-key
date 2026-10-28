// The Toast (UI-KITS.md 4.1): one line plus a consequence, at most two actions, six seconds with a
// visible timer, and errors persist (a toast is never the only record of an error). On a phone it
// spans the bottom, above the system bars; from 560 dp wide it is a card at the bottom end.
// Status is an icon and a word, never colour alone: the icon is decorative and the kind's word is
// in the message. A polite live region announces it once. Under reduced motion the timer holds
// full and the toast still closes on schedule.

package im.plrs.key.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** What a toast reports (UI-KITS.md 4.1 Toast states). */
public enum class PolarisToastKind { Info, Success, Warning, Error }

/** One of a toast's at most two actions. */
public class PolarisToastAction(public val label: String, public val onClick: () -> Unit)

/**
 * A toast as data, for a host that places [PolarisToast] itself ([PolarisToastHost]) and for the
 * gate, which places the moments the kit owns (UI-KITS.md 4.1): "Signed in as <name> · <Tier>
 * license" when sign-in finishes, and "Copied" when a link goes on the clipboard.
 */
public class PolarisToastSpec(
    public val message: String,
    public val kind: PolarisToastKind = PolarisToastKind.Info,
    public val detail: String? = null,
    public val actions: List<PolarisToastAction> = emptyList(),
)

/** The seconds an info, success or warning toast stays; an error or a progress toast stays until it is answered. */
public const val POLARIS_TOAST_SECONDS: Int = 6

/** The container width from which a toast is a card at the bottom end instead of spanning the bottom. */
internal val PolarisToastCardFrom = 560.dp

/**
 * A toast.
 *
 * @param message the one line.
 * @param detail the consequence, under it ("The download continues in the background").
 * @param actions at most two; the first two are drawn.
 * @param progress a determinate bar (0..1) for a toast that tracks counted bytes; null draws none.
 * @param onDismiss called when the timer ends. Never called for an error or a toast with [progress],
 *   which persist until an action answers them.
 * @param timer whether the six-second timer shows and runs; false for a toast that persists anyway.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
public fun PolarisToast(
    message: String,
    modifier: Modifier = Modifier,
    kind: PolarisToastKind = PolarisToastKind.Info,
    detail: String? = null,
    actions: List<PolarisToastAction> = emptyList(),
    progress: Float? = null,
    onDismiss: (() -> Unit)? = null,
    timer: Boolean = kind != PolarisToastKind.Error && progress == null,
) {
    val scheme = MaterialTheme.colorScheme
    val status = PolarisTheme.status
    val reduceMotion = rememberReduceMotion()
    val persists = kind == PolarisToastKind.Error || progress != null
    var running by remember { mutableStateOf(false) }
    LaunchedEffect(message, kind) {
        running = true
        if (!persists && onDismiss != null) {
            delay(POLARIS_TOAST_SECONDS * 1000L)
            onDismiss()
        }
    }
    // The timer drains linearly over the six seconds; reduced motion holds it full (DL16).
    val left by animateFloatAsState(
        targetValue = if (running && !reduceMotion) 0f else 1f,
        animationSpec = tween(POLARIS_TOAST_SECONDS * 1000, easing = LinearEasing),
        label = "PolarisToastTimer",
    )
    val glyph = when (kind) {
        PolarisToastKind.Warning, PolarisToastKind.Error -> PolarisSymbols.Warning
        PolarisToastKind.Success -> PolarisSymbols.Check
        PolarisToastKind.Info -> PolarisSymbols.Info
    }
    val tint = when (kind) {
        PolarisToastKind.Warning -> status.warning
        PolarisToastKind.Error -> status.danger
        PolarisToastKind.Success -> status.success
        PolarisToastKind.Info -> scheme.onSurfaceVariant
    }
    BoxScopeToast(modifier) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.large,
            color = scheme.surfaceContainerHighest,
            contentColor = scheme.onSurface,
            shadowElevation = 6.dp,
        ) {
            Column(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 4.dp)) {
                    Row(
                        Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(glyph, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f).padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            // A warning with only its action (no sentence of its own) is the icon and the action.
                            if (message.isNotEmpty()) Text(message, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
                            if (detail != null) {
                                Text(detail, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                            }
                        }
                    }
                    if (progress != null) {
                        Spacer(Modifier.height(PolarisSpace.controls))
                        PolarisProgressBar(progress.coerceIn(0f, 1f), message)
                    }
                    if (actions.isNotEmpty()) {
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
                            for (action in actions.take(2)) PolarisTextButton(action.label, action.onClick)
                        }
                    } else {
                        Spacer(Modifier.height(10.dp))
                    }
                }
                // The visible timer: a thin line along the foot that drains over the six seconds.
                if (timer) {
                    LinearProgressIndicator(
                        progress = { left },
                        modifier = Modifier.fillMaxWidth().height(2.dp),
                        color = scheme.onSurfaceVariant,
                        trackColor = scheme.surfaceContainerHighest,
                        drawStopIndicator = {},
                    )
                }
            }
        }
    }
}

/** Places a toast: across the bottom on a phone, a card at the bottom end from 560 dp wide, inside the system bars. */
@Composable
private fun BoxScopeToast(modifier: Modifier, content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.BoxWithConstraints(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing)) {
        val card = maxWidth >= PolarisToastCardFrom
        Box(
            Modifier.fillMaxWidth().padding(16.dp),
            contentAlignment = if (card) Alignment.BottomEnd else Alignment.BottomCenter,
        ) {
            Box(if (card) Modifier.widthIn(max = 420.dp) else Modifier.fillMaxWidth()) { content() }
        }
    }
}

/**
 * Places [toast] at the foot of the box it is called in, over whatever is under it, and calls
 * [onDismiss] when its six seconds end (an error toast stays until an action answers it).
 */
@Composable
public fun PolarisToastHost(toast: PolarisToastSpec?, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    if (toast == null) return
    PolarisToast(
        message = toast.message,
        modifier = modifier,
        kind = toast.kind,
        detail = toast.detail,
        actions = toast.actions,
        onDismiss = onDismiss,
    )
}
