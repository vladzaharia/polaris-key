// @pkey-feature connect.local ui.kit
// The parts Pair with a Code's screens share (CC-29K.2): the context a step draws from, notices, quiet links, the wait row and the
// action rows. Rules: a notice's title is the page body size at 600, its words are the body size, and its link is underlined at rest and
// flush with the words; Cancel is the hug-width secondary and "… instead" a quiet underlined link; a wait is a small spinner beside its
// words in a status region, still under reduced motion.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp

private val GLYPH_SIZE = 20.dp
private val RING_STROKE = 2.dp
private const val BUSY_LINK = 0.6f
private const val SPINNER_ARC = 0.25f
private const val FULL_CIRCLE = 360f
private const val RING_START = -90f

/** What a step draws from: the screen's input, its lines, its actions and the app's names for the data categories. */
internal class PairCtx(
    val ui: PolarisLocalPairingUi,
    val lines: KitLines,
    val actions: PolarisLocalPairingActions,
    val labels: Map<String, String>,
    private val screen: KitScreen,
) {
    /** The keys of the controls the screen draws but does not offer now. */
    val disabled: Set<String> get() = screen.disabledKeys.toSet()

    /** The second line of the screen: the reason of a failure, the network answer or a refusal. */
    val reason: String get() = screen.copy.getOrNull(1)?.let { lines.format(it) }.orEmpty()

    /** A control's label in the platform's wording (macOS title case). */
    @Composable
    fun button(key: String): String = KitCopy.bundled.format(key, kitLocale(), variant = polarisCopyVariant())

    fun text(key: String): String = lines.text(key).orEmpty()
}

private val LINK_MIN_HEIGHT = 48.dp

/** A link: text in the accent, underlined at rest, a 48 dp target, flush with the words above it. */
@Composable
internal fun PairLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, busy: Boolean = false) {
    Row(
        modifier
            .heightIn(min = LINK_MIN_HEIGHT)
            .alpha(if (busy) BUSY_LINK else 1f)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { if (busy) stateDescription = "…" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = MaterialTheme.typography.bodyLarge.copy(textDecoration = TextDecoration.Underline), color = PolarisTheme.accentText)
    }
}

/**
 * What the last scan said, in body weight under the buttons: a refusal of what was read has the danger mark and colour (it is also
 * told once, as a polite live region); a passing notice (the scanner is getting ready) stays neutral.
 */
@Composable
internal fun PairScanNotice(text: String, refusal: Boolean) {
    val color = if (refusal) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (refusal) PolarisSymbols.Warning else PolarisSymbols.Info,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(GLYPH_SIZE),
        )
        Text(text, style = MaterialTheme.typography.bodyLarge, color = color)
    }
}

/** A notice: the kit's info (or warning) glyph, its title, its words and an action link. A live region, so it is told once. */
@Composable
internal fun PairNotice(title: String, body: String?, action: Pair<String, () -> Unit>? = null, busy: Boolean = false, warning: Boolean = false) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Row(Modifier.padding(PolarisSpace.medium), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            val glyph: ImageVector = if (warning) PolarisSymbols.Warning else PolarisSymbols.Info
            Icon(glyph, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(GLYPH_SIZE))
            Column(Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }) {
                Text(title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                if (body != null) Text(body, style = MaterialTheme.typography.bodyLarge)
                if (action != null) PairLink(action.first, action.second, busy = busy)
            }
        }
    }
}

/** A wait: a small spinner beside its words, in a status region; a still arc under reduced motion. */
@Composable
internal fun PairWait(text: String) {
    Row(
        Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (rememberReduceMotion()) {
            CircularProgressIndicator(progress = { SPINNER_ARC }, modifier = Modifier.size(GLYPH_SIZE), strokeWidth = RING_STROKE)
        } else {
            CircularProgressIndicator(modifier = Modifier.size(GLYPH_SIZE), strokeWidth = RING_STROKE)
        }
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The 20 dp time ring: a 2 dp stroke in the accent draining as the window runs out. */
@Composable
internal fun PairRing(fraction: Float, modifier: Modifier = Modifier) {
    val track = MaterialTheme.colorScheme.outlineVariant
    val accent = MaterialTheme.colorScheme.primary
    Canvas(modifier.size(GLYPH_SIZE)) {
        val stroke = Stroke(width = RING_STROKE.toPx(), cap = StrokeCap.Round)
        val inset = stroke.width / 2
        val box = Size(size.width - stroke.width, size.height - stroke.width)
        drawArc(track, 0f, FULL_CIRCLE, false, Offset(inset, inset), box, style = stroke)
        drawArc(accent, RING_START, FULL_CIRCLE * fraction.coerceIn(0f, 1f), false, Offset(inset, inset), box, style = stroke)
    }
}

/**
 * Cancel (or Close) as the hug-width secondary, then the quiet "... instead" link beside it, wrapping under it when the row is narrow (a
 * 200 % text size): the link keeps its own width and a 48 dp target, so it is never squeezed to a letter a line.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PairActionRow(secondary: String, onSecondary: () -> Unit, link: Pair<String, () -> Unit>? = null, initialFocus: Boolean = true) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group),
        verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        PolarisSecondaryButton(secondary, onSecondary, initialFocus = initialFocus)
        if (link != null) PairLink(link.first, link.second)
    }
}
