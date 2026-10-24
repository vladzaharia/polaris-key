// Back handling (UI-KITS.md §1.4 Android, DL9). Every step with a back target backs out; from API 34
// the system's back gesture previews the step it returns to (PredictiveBackHandler: the screen
// scales and rounds under the finger), below it the classic BackHandler does the same without the
// preview. A cancelled gesture changes nothing: no state is touched until the gesture commits, so a
// key draft, the caret and the focus stay exactly where they were. The host opts the app in with
// `android:enableOnBackInvokedCallback="true"` (API 33 and up); without it the system sends the
// classic event and the same handler runs.

package im.plrs.key.ui

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException

/** The first API level whose system back gesture previews the destination (Android 14). */
internal const val PredictiveBackApi: Int = 34

/** The radius the previewed screen rounds to at the end of the gesture (the sheet radius, §1.4). */
private const val PreviewRadius = 28

/** How far the previewed screen shrinks at the end of the gesture. */
private const val PreviewShrink = 0.1f

/**
 * Runs [onBack] when the person goes back, while [enabled]; returns the modifier that draws the
 * system gesture's preview on the screen that will go (identity below API 34 and when idle).
 * This is the Android actual of PolarisBackHandler.
 */
@Composable
internal fun androidBack(enabled: Boolean, onBack: () -> Unit): Modifier {
    val current by rememberUpdatedState(onBack)
    if (Build.VERSION.SDK_INT < PredictiveBackApi) {
        BackHandler(enabled = enabled) { current() }
        return Modifier
    }
    var progress by remember { mutableFloatStateOf(0f) }
    PredictiveBackHandler(enabled = enabled) { events ->
        try {
            events.collect { progress = it.progress }
            current()
        } catch (e: CancellationException) {
            // The gesture was cancelled: nothing changes, the screen springs back.
            throw e
        } finally {
            progress = 0f
        }
    }
    if (progress == 0f) return Modifier
    val p = progress
    return Modifier.graphicsLayer {
        val scale = 1f - PreviewShrink * p
        scaleX = scale
        scaleY = scale
        shape = polarisPreviewShape((PreviewRadius * p).dp)
        clip = true
    }
}
