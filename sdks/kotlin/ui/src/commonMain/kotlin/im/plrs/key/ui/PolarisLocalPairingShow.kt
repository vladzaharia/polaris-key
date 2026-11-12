// @pkey-feature connect.local ui.kit
// The show step of Pair with a Code (CC-29K.2, CC-29K.5): one window with two views. The code view is the code in the kit's mono face
// (the changed digits lit, wrapping between its two groups so it never clips, even at 200 % text), its time, the notice and the wait; the
// QR view is the QR alone with the same time, notice and wait. Each has one link to the other.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.background
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
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

private val QR_SIZE = 220.dp
private val QR_SIZE_SHORT = 192.dp

// The card is never under 192 dp (12 rem); in two columns it takes the room the height leaves.
private val QR_SIZE_WIDE = 240.dp
private const val DIMMED = 0.35f
private const val QR_MODULES = 37
private const val FADE_PAPER = 0.96f
private val QR_PAPER = Color.White // polaris-lint: allow-colour (the QR's paper is white in every theme, so a scanner can read it)
private val TILE_MIN_HEIGHT = 72.dp
private val TILE_PADDING = 20.dp
private val PLACEHOLDER_WIDTH = 200.dp
private val PLACEHOLDER_HEIGHT = 32.dp
private val CODE_SIZE_WIDE = 40.sp
private val CODE_SIZE_SHORT = 32.sp
private val CODE_SIZE = 36.sp
private const val CODE_TRACKING = 0.12f
private const val LIT = 0.3f
private const val EXPIRED_ALPHA = 0.5f
private const val PLACEHOLDER_ALPHA = 0.3f
private const val SECONDS_PER_MINUTE = 60
private const val WINDOW_SECONDS = 300f

/** The show (and opening) screen's body, after its title: the code view, or the QR view when the person chose it. */
@Composable
internal fun ColumnScope.PairShow(c: PairCtx, layout: KitLocal.Layout, tile: FocusRequester, qrColumns: Boolean) {
    val opening = c.ui.step == "opening"
    val qrView = c.ui.view == "qr" && !opening
    val gone = c.ui.expired
    if (gone) {
        // Expired says its piece in the title: the dead stage stays, muted, and the actions are Show a new code and Cancel.
        Spacer(Modifier.height(PolarisSpace.medium))
        if (qrView) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                PairQrCard(c, if (layout.logo) QR_SIZE else QR_SIZE_SHORT, dimmed = true, tile)
            }
        } else {
            PairCodeTile(c, opening = false, tile)
        }
        Spacer(Modifier.height(polarisWindow.section))
        PairShowActions(c, qrView)
        return
    }
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(c.text(if (qrView) "localPairing.qrBody" else "localPairing.showBody"), textAlign = TextAlign.Start)
    Spacer(Modifier.height(PolarisSpace.medium))
    if (!qrView) {
        PairCodeAndTime(c, opening, tile)
        PairShowNotice(c)
        Spacer(Modifier.height(PolarisSpace.controls))
        PairWait(if (opening) c.text("a11y.busy") else c.text("localPairing.waitingDevice"))
        Spacer(Modifier.height(polarisWindow.section))
        PairShowActions(c, qrView = false)
    } else if (qrColumns) {
        // A wide, short window: the words and the buttons at the start, the card at the end.
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                PairTime(c, opening = false)
                PairShowNotice(c)
                Spacer(Modifier.height(PolarisSpace.controls))
                PairWait(c.text("localPairing.waitingDevice"))
                Spacer(Modifier.height(PolarisSpace.medium))
                PairShowActions(c, qrView = true)
            }
            PairQrCard(c, QR_SIZE_WIDE, dimmed = false, tile)
        }
    } else {
        if (layout.noticeBeforeQr) PairShowNotice(c)
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            PairQrCard(c, if (layout.logo) QR_SIZE else QR_SIZE_SHORT, dimmed = false, tile)
        }
        PairTime(c, opening = false)
        if (!layout.noticeBeforeQr) PairShowNotice(c)
        Spacer(Modifier.height(PolarisSpace.controls))
        PairWait(c.text("localPairing.waitingDevice"))
        Spacer(Modifier.height(polarisWindow.section))
        PairShowActions(c, qrView = true)
    }
}

/** A window that ran out offers Show a new code as the one primary, in place; then Cancel and the link to the other view. */
@Composable
private fun PairShowActions(c: PairCtx, qrView: Boolean) {
    if (c.ui.expired) {
        val renewing = "localPairing.showNew" in c.disabled
        PolarisPrimaryButton(c.button("localPairing.showNew"), { if (!renewing) c.actions.showNew() }, busy = renewing)
        Spacer(Modifier.height(PolarisSpace.controls))
    }
    val opening = c.ui.step == "opening"
    PairActionRow(
        c.button("common.cancel"),
        c.actions::cancel,
        when {
            opening || c.ui.expired -> null
            qrView -> c.button("localPairing.toCode") to c.actions::showCode
            else -> c.button("localPairing.toQr") to c.actions::showQr
        },
        initialFocus = !c.ui.expired,
    )
}

/**
 * The QR view's card: the plain QR, in one place so the Light Card can replace it. A window that ran out fades the dark modules toward
 * the paper (so the dead code does not scan) and dims the card.
 */
@Composable
internal fun PairQrCard(c: PairCtx, size: Dp, dimmed: Boolean, focus: FocusRequester) {
    val qr = c.ui.qr
    if (qr == null) {
        Spacer(Modifier.size(size))
    } else {
        Box(Modifier.size(size).alpha(if (dimmed) DIMMED else 1f).focusRequester(focus).focusable()) {
            // A dead code is blurred past reading (two module widths of a 37-module card) as well as faded and dimmed, so a decoder
            // finds nothing even when its levels are stretched.
            PolarisQr(qr, c.text("a11y.qrPairing"), Modifier.size(size).then(if (dimmed) Modifier.blur(size / QR_MODULES * 2) else Modifier))
            // The paper over the ink: dark modules end at 4 % of their strength.
            if (dimmed) Box(Modifier.size(size).background(QR_PAPER.copy(alpha = FADE_PAPER)).clearAndSetSemantics {})
        }
    }
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
        modifier = Modifier.fillMaxWidth().alpha(
            if (c.ui.expired) EXPIRED_ALPHA else 1f,
        ).border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.large),
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
