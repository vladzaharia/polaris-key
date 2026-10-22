// The boot's loading state (UI-KITS.md DL7, section 1.5 rule 4): the product header, a muted
// label, and a skeleton shaped like the screen to come (a title, two lines of body, a button),
// with a shimmer sweeping across it once every `shimmer` token (1600 ms). Under reduced motion
// (the system's animator duration scale at 0, DL16) the skeleton holds still. Assistive tech hears
// "Loading" and the stage label as one polite announcement; the bars themselves are silent.

package im.plrs.key.ui

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.PolarisKitTokens

/** Overrides the system's reduced-motion setting (tests); null follows the system. */
internal val LocalPolarisReduceMotion = compositionLocalOf<Boolean?> { null }

/** Whether the person has turned animation off (the animator duration scale is 0). */
@Composable
internal fun rememberReduceMotion(): Boolean {
    LocalPolarisReduceMotion.current?.let { return it }
    val resolver = LocalContext.current.contentResolver
    return remember(resolver) {
        runCatching { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
    }
}

/**
 * The boot skeleton for [label] (the stage's line): the product header, the label, and bars shaped
 * like a focused step. [reduceMotion] holds the shimmer still; it defaults to the system setting.
 */
@Composable
internal fun PolarisBootSkeleton(label: String, modifier: Modifier = Modifier, reduceMotion: Boolean = rememberReduceMotion()) {
    val copy = PolarisTheme.copy
    val announcement = "${copy.loading}. $label"
    val scheme = MaterialTheme.colorScheme
    val base = scheme.surfaceContainerHighest
    val sweep = scheme.onSurface.copy(alpha = 0.08f)
    val phase = if (reduceMotion) {
        0.35f
    } else {
        val transition = rememberInfiniteTransition(label = "PolarisSkeleton")
        val value by transition.animateFloat(
            initialValue = -0.3f,
            targetValue = 1.3f,
            animationSpec = infiniteRepeatable(tween(PolarisKitTokens.Motion.shimmer, easing = LinearEasing), RepeatMode.Restart),
            label = "PolarisSkeletonPhase",
        )
        value
    }
    PolarisScaffold(
        modifier = modifier,
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        actions = {
            SkeletonBar(phase, base, sweep, Modifier.fillMaxWidth().height(56.dp), shape = PolarisTheme.buttonShape)
        },
        content = {
            Box(Modifier.semantics(mergeDescendants = true) {
                contentDescription = announcement
                liveRegion = LiveRegionMode.Polite
                // The label is the screen's only text: the heading TalkBack lands on.
                heading()
            }) {
                androidx.compose.foundation.layout.Column {
                    PolarisProductHeader()
                    Text(
                        text = label,
                        style = MaterialTheme.typography.bodyLarge,
                        color = scheme.onSurfaceVariant,
                        modifier = Modifier.clearAndSetSemantics {},
                    )
                    Spacer(Modifier.height(polarisWindow.section))
                    SkeletonLines(phase, base, sweep)
                }
            }
        },
    )
}

@Composable
private fun ColumnScope.SkeletonLines(phase: Float, base: Color, sweep: Color) {
    SkeletonBar(phase, base, sweep, Modifier.fillMaxWidth(0.6f).height(28.dp))
    Spacer(Modifier.height(PolarisSpace.group))
    SkeletonBar(phase, base, sweep, Modifier.fillMaxWidth().height(16.dp))
    Spacer(Modifier.height(PolarisSpace.controls))
    SkeletonBar(phase, base, sweep, Modifier.fillMaxWidth(0.85f).height(16.dp))
    Spacer(Modifier.height(PolarisSpace.controls))
    SkeletonBar(phase, base, sweep, Modifier.fillMaxWidth(0.5f).height(16.dp))
}

/** One skeleton shape: [base] with a soft [sweep] band at [phase] (0..1 across the shape). */
@Composable
private fun SkeletonBar(
    phase: Float,
    base: Color,
    sweep: Color,
    modifier: Modifier,
    shape: androidx.compose.ui.graphics.Shape = MaterialTheme.shapes.small,
) {
    Box(
        modifier
            .clearAndSetSemantics {}
            .clip(shape)
            .background(base)
            .drawWithContent {
                drawContent()
                val w = size.width
                val centre = w * phase
                val band = w * 0.3f
                drawRect(
                    brush = Brush.horizontalGradient(
                        colors = listOf(Color.Transparent, sweep, Color.Transparent),
                        startX = centre - band,
                        endX = centre + band,
                    ),
                    topLeft = Offset.Zero,
                )
            },
    )
}
