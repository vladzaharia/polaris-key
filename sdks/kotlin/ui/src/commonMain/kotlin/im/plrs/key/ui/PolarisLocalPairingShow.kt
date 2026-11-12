// @pkey-feature connect.local ui.kit
// The show screen of Pair with a Code (CC-29K.2): the code in the kit's mono face (the changed digits lit, wrapping between its two
// groups so it never clips, even at 200 % text), its time, the QR beside it from 600 dp and under it otherwise, the notice, the wait.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val QR_SIZE = 184.dp
private val QR_SIZE_SHORT = 160.dp
private val TILE_MIN_HEIGHT = 72.dp
private val TILE_PADDING = 20.dp
private val PLACEHOLDER_WIDTH = 200.dp
private val PLACEHOLDER_HEIGHT = 32.dp
private val CODE_SIZE_WIDE = 40.sp
private val CODE_SIZE_SHORT = 32.sp
private val CODE_SIZE = 36.sp
private const val CODE_TRACKING = 0.12f
private const val LIT = 0.3f
private const val PLACEHOLDER_ALPHA = 0.3f
private const val SECONDS_PER_MINUTE = 60
private const val WINDOW_SECONDS = 300f

/** The show (and opening) screen's body, after its title. */
@Composable
internal fun ColumnScope.PairShow(c: PairCtx, layout: KitLocal.Layout, tile: FocusRequester) {
    val opening = c.ui.step == "opening"
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(c.text("localPairing.showBody"), textAlign = TextAlign.Start)
    Spacer(Modifier.height(PolarisSpace.medium))
    val wait = if (opening) c.text("a11y.busy") else c.text("localPairing.waitingDevice")
    val qrSize = if (layout.logo) QR_SIZE else QR_SIZE_SHORT
    if (layout.panes == 2) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group)) {
            Column(Modifier.weight(1f)) {
                PairCodeAndTime(c, opening, tile)
                PairShowNotice(c)
                Spacer(Modifier.height(PolarisSpace.controls))
                PairWait(wait)
            }
            PairQr(c, opening, qrSize)
        }
    } else {
        PairCodeAndTime(c, opening, tile)
        if (layout.noticeBeforeQr) PairShowNotice(c)
        Spacer(Modifier.height(PolarisSpace.medium))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { PairQr(c, opening, qrSize) }
        if (!layout.noticeBeforeQr) PairShowNotice(c)
        Spacer(Modifier.height(PolarisSpace.controls))
        PairWait(wait)
    }
    Spacer(Modifier.height(polarisWindow.section))
    PairActionRow(
        c.button("common.cancel"),
        c.actions::cancel,
        linkFor(c, "localPairing.toScan", c.actions::scan) ?: (c.button("localPairing.toEnter") to c.actions::enter),
    )
}

@Composable
private fun PairCodeAndTime(c: PairCtx, opening: Boolean, tile: FocusRequester) {
    PairCodeTile(c, opening, tile)
    Spacer(Modifier.height(PolarisSpace.controls))
    PairTime(c, opening)
}

/** The code in the kit's mono face, the changed digits lit; a placeholder bar while the window opens. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PairCodeTile(c: PairCtx, opening: Boolean, tile: FocusRequester) {
    val window = polarisWindow
    val size = when {
        window.wide || window.tv -> CODE_SIZE_WIDE
        window.compactHeight -> CODE_SIZE_SHORT
        else -> CODE_SIZE
    }
    val spoken = c.lines.text("a11y.linkCode") ?: KitConnect.spellOut(c.ui.code.orEmpty())
    Surface(
        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.large),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = TILE_MIN_HEIGHT).padding(horizontal = TILE_PADDING, vertical = PolarisSpace.controls),
            contentAlignment = Alignment.Center,
        ) {
            val digits = c.ui.code
            if (opening || digits == null) {
                Surface(
                    Modifier.width(PLACEHOLDER_WIDTH).height(PLACEHOLDER_HEIGHT).alpha(PLACEHOLDER_ALPHA).clearAndSetSemantics {},
                    shape = MaterialTheme.shapes.small,
                    color = MaterialTheme.colorScheme.outline,
                ) {}
            } else {
                // The two groups wrap apart at large text, never inside a group: the code is never clipped.
                FlowRow(
                    Modifier.focusRequester(tile).focusable().clearAndSetSemantics { contentDescription = spoken },
                    horizontalArrangement = Arrangement.spacedBy(size.value.dp, Alignment.CenterHorizontally),
                    verticalArrangement = Arrangement.Center,
                ) {
                    var from = 0
                    for (group in digits.split(' ')) {
                        Text(litGroup(group, from, c.ui.changed), style = codeStyle(size))
                        from += group.length + 1
                    }
                }
            }
        }
    }
}

@Composable
private fun codeStyle(size: TextUnit) = TextStyle(fontFamily = PolarisTheme.monoFamily, fontSize = size, letterSpacing = size * CODE_TRACKING)

@Composable
private fun litGroup(group: String, from: Int, changed: List<Int>): AnnotatedString {
    val lit = MaterialTheme.colorScheme.primary.copy(alpha = LIT)
    return buildAnnotatedString {
        group.forEachIndexed { i, ch ->
            if (from + i in changed) withStyle(SpanStyle(background = lit)) { append(ch) } else append(ch)
        }
    }
}

@Composable
private fun PairTime(c: PairCtx, opening: Boolean) {
    if (opening) {
        Spacer(Modifier.height(PolarisSpace.group))
        return
    }
    val left = c.ui.secondsLeft ?: 0
    // The time is said once a minute at most, never each second.
    val spoken = c.lines.format(
        "localPairing.expires",
        mapOf("time" to CopyArgument.Text(KitLocal.countdown((left / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE))),
    )
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.tight, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PairRing(left / WINDOW_SECONDS)
        Text(
            c.text("localPairing.expires"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.semantics { contentDescription = spoken },
        )
    }
}

@Composable
private fun PairQr(c: PairCtx, opening: Boolean, size: Dp) {
    val qr = c.ui.qr
    if (opening || qr == null) {
        Spacer(Modifier.size(size))
    } else {
        PolarisQr(qr, c.text("a11y.qrPairing"), Modifier.size(size))
    }
}

/** The notice under the time: what changed, with Show a new code as its link (busy while it is asked for). */
@Composable
private fun PairShowNotice(c: PairCtx) {
    val n = c.ui.notice ?: return
    Spacer(Modifier.height(PolarisSpace.controls))
    val renewing = "localPairing.showNew" in c.disabled
    val action = c.lines.text("localPairing.showNew")?.let { it to { if (!renewing) c.actions.showNew() } }
    when (n) {
        "rotated" -> PairNotice(c.text("localPairing.rotatedTitle"), c.lines.text("localPairing.rotatedBody"), action, renewing)

        "declined" -> {
            val who = c.lines.text("localPairing.notPairedWith")
            val words = c.lines.text("localPairing.rotatedBody")
            PairNotice(who ?: words.orEmpty(), if (who != null) words else null, action, renewing)
        }

        "guessing" -> PairNotice(c.text("localPairing.rotatedTitle"), c.lines.text("localPairing.tooManyAgainBody"), action, renewing, warning = true)

        else -> PairNotice(c.text("localPairing.blockedTitle"), c.lines.text("localPairing.blockedBody"), warning = true)
    }
}
