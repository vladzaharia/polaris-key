// @pkey-feature ui.kit
// LinkPairing (CC-19.10; ui-matrix `connect`): two people pair their devices once, in person. The window opens, each device shows the
// same code, the people compare it, check what would be shared and confirm. Drawn over PolarisLinkPairingState; the Kotlin twin of
// the React kit's <LinkPairing> and SwiftUI's LinkPairing.
//
// Rules the screens keep:
//  - the code is drawn as served and spelled out for a screen reader (the catalog's a11y.linkCode line, digit by digit);
//  - the categories come before "Codes match", in reading order too; the actions flow after them, never docked;
//  - "Codes match" never takes the first focus: on a TV or with a keyboard the first focus is "Not a match", and a press that
//    arrives as the code opens is ignored for 250 ms, so a stray Enter or D-pad press never links;
//  - a label the other device sent is isolated and worded as reported by the device; a missing label says so;
//  - Back or Escape declines a code, cancels a window and closes a finished screen;
//  - the wait after "Codes match" is a status region beside the code, which stays on screen.
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "CyclomaticComplexMethod", "LongParameterList", "LongMethod", "MagicNumber")

package im.plrs.key.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.border
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
import androidx.compose.foundation.relocation.BringIntoViewResponder
import androidx.compose.foundation.relocation.bringIntoViewResponder
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * The pairing window for [state]: it opens when this enters the composition and closes, declining any session on screen, when it
 * leaves. [categoryLabels] names each data category by its id (an id without a name is drawn as words); [onLinked] runs once when a
 * link was made; [onClose] runs for Cancel, Done and Back.
 */
@Composable
public fun PolarisLinkPairing(
    state: PolarisLinkPairingState,
    modifier: Modifier = Modifier,
    categoryLabels: Map<String, String> = emptyMap(),
    onLinked: (() -> Unit)? = null,
    onClose: () -> Unit = {},
) {
    val ui by state.ui.collectAsState()
    LaunchedEffect(state) { state.start() }
    DisposableEffect(state) { onDispose { state.cancel() } }
    LaunchedEffect(ui.step) { if (ui.step == PolarisLinkStep.Linked) onLinked?.invoke() }
    val inputs = PolarisLinkPairingState.inputsFor(ui) ?: return
    val screen = remember(ui) { KitStates.resolve(KitComponent.linkPairing, inputs) }
    PolarisLinkPairingScreen(
        screen,
        code = ui.code,
        categories = ui.categories,
        modifier = modifier,
        categoryLabels = categoryLabels,
        onConfirm = state::confirm,
        onDecline = state::decline,
        onRetry = state::start,
        onCancel = {
            state.cancel()
            onClose()
        },
        onDone = {
            state.cancel()
            onClose()
        },
    )
}

/**
 * LinkPairing's states as the matrix resolves them (open, code, confirm, linked, failed, unavailable), stateless over its callbacks.
 * [code] is the code as served ("123 456"); [categories] are the ids this app asks both people to approve.
 */
@Composable
public fun PolarisLinkPairingScreen(
    screen: KitScreen,
    code: String?,
    categories: List<String>,
    modifier: Modifier = Modifier,
    categoryLabels: Map<String, String> = emptyMap(),
    onConfirm: () -> Unit = {},
    onDecline: () -> Unit = {},
    onRetry: () -> Unit = {},
    onCancel: () -> Unit = {},
    onDone: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val window = polarisWindow
    // Back and Escape: decline a code, cancel a window, close a finished screen.
    val escape: () -> Unit = when (screen.state) {
        "code" -> onDecline
        "open", "confirm" -> onCancel
        "failed" -> onDone
        else -> onDone
    }
    // A press that arrives as the code opens (the one that was heading elsewhere) is ignored for 250 ms on a TV.
    val armed = rememberArmed(screen.state, isTelevision())
    val host = modifier.then(PolarisBackHandler(enabled = true, onBack = escape))
    fun text(key: String): String = lines.text(key).orEmpty()
    // The platform's wording (macOS title case) is for buttons only (S4).
    val variant = polarisCopyVariant()

    fun button(key: String): String = catalog.format(key, locale, variant = variant)
    val failedBody = listOf("linkPairing.failedDeclined", "linkPairing.failedTimeout", "linkPairing.failedFull", "linkPairing.failedClosed")
        .firstNotNullOfOrNull(lines::text)
    when (screen.state) {
        "open" -> ConnectStep(host, text("linkPairing.title"), screen.state) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(text("linkPairing.openBody"), textAlign = TextAlign.Start)
            Spacer(Modifier.height(PolarisSpace.group))
            PolarisWaitIndicator()
            Spacer(Modifier.height(PolarisSpace.controls))
            Text(
                text("linkPairing.searching"),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(window.section))
            ConnectActions(listOf(ConnectButton(button("common.cancel"), onCancel, focus = true)))
        }

        "code" -> ConnectStep(
            host,
            text("linkPairing.codeTitle"),
            screen.state,
            end = ConnectEnd(
                detail = {
                    ReportedLine(lines)
                    Spacer(Modifier.height(PolarisSpace.medium))
                    Shares(lines, categories, categoryLabels)
                },
                // The categories above come first; the choice follows. The first focus is the safe verb, never Codes match.
                actions = {
                    ConnectActions(
                        listOf(
                            ConnectButton(button("linkPairing.confirm"), { if (armed) onConfirm() }, primary = true),
                            ConnectButton(button("linkPairing.decline"), { if (armed) onDecline() }, focus = true),
                        ),
                    )
                },
            ),
        ) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(text("linkPairing.codeBody"), textAlign = TextAlign.Start)
            Spacer(Modifier.height(PolarisSpace.medium))
            PairCode(code.orEmpty(), lines.text("a11y.linkCode"))
        }

        "confirm" -> ConnectStep(
            host,
            text("linkPairing.waiting"),
            screen.state,
            end = ConnectEnd(
                detail = {
                    ReportedLine(lines)
                    Spacer(Modifier.height(PolarisSpace.medium))
                    Shares(lines, categories, categoryLabels)
                    Spacer(Modifier.height(PolarisSpace.group))
                    // The title above is what a screen reader reads; the wait is said again here only to the eye.
                    PolarisWaitIndicator()
                    Spacer(Modifier.height(PolarisSpace.controls))
                    Text(
                        text("linkPairing.waiting"),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().clearAndSetSemantics {},
                    )
                },
                actions = { ConnectActions(listOf(ConnectButton(button("common.cancel"), onCancel, focus = true))) },
            ),
        ) {
            // The other person may still be comparing against this screen: the code, the reported line and the categories stay.
            Spacer(Modifier.height(PolarisSpace.medium))
            PairCode(code.orEmpty(), lines.text("a11y.linkCode"))
        }

        "linked" -> ConnectStep(host, text("linkPairing.linkedTitle"), screen.state) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(lines.text("linkPairing.linkedWith") ?: text("linkPairing.linkedBody"), textAlign = TextAlign.Start)
            Spacer(Modifier.height(PolarisSpace.medium))
            Shares(lines, categories, categoryLabels)
            Spacer(Modifier.height(window.section))
            ConnectActions(listOf(ConnectButton(button("common.done"), onDone, primary = true, focus = true)))
        }

        "failed" -> {
            // Pairing cannot succeed until a pairing is removed when one device is full: Done leads, Try again stays.
            val full = lines.has("linkPairing.failedFull")
            ConnectStep(host, text("linkPairing.failedTitle"), screen.state) {
                Spacer(Modifier.height(PolarisSpace.tight))
                ConnectNotice(failedBody.orEmpty())
                Spacer(Modifier.height(window.section))
                val retry = ConnectButton(button("common.tryAgain"), onRetry, primary = !full, focus = !full)
                val done = ConnectButton(button("common.done"), onDone, primary = full, focus = full)
                ConnectActions(if (full) listOf(done, retry) else listOf(retry, done))
            }
        }

        "unavailable" -> ConnectStep(host, text("core.codes.connect_links_disabled.title"), screen.state) {
            Spacer(Modifier.height(PolarisSpace.tight))
            // The explanation comes before Done, on screen and in reading order.
            PolarisBody(text("core.codes.connect_links_disabled.message"), textAlign = TextAlign.Start)
            Spacer(Modifier.height(window.section))
            ConnectActions(listOf(ConnectButton(button("common.done"), onDone, primary = true, focus = true)))
        }
    }
}

// ── Parts shared by the two screens ──────────────────────────────────────────────────────────────

/**
 * The end pane of a step that splits ([ConnectStep]'s `end`): [detail] (the reported device, the categories, a wait) then the
 * [actions]. In one column they follow the content in that order; in two panes they are the end pane, top-aligned.
 */
internal class ConnectEnd(val detail: (@Composable ColumnScope.() -> Unit)? = null, val actions: @Composable ColumnScope.() -> Unit)

/**
 * One step: the product header, the heading (announced once per state) and the content, with the actions inside it. A step with an
 * [end] splits in two panes when the window asks for it ([PolarisWindow.connectPanes]): the header, title and [content] on the start
 * side, the [end] on the other. The view order is the same either way, so the categories still come before Codes match.
 */
@Composable
internal fun ConnectStep(
    modifier: Modifier,
    title: String,
    state: String,
    badge: (@Composable () -> Unit)? = null,
    end: ConnectEnd? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val fontScale = LocalDensity.current.fontScale
    // No `actions` slot in a column: they would dock below the scroll, and Codes match must not be on screen before the categories.
    PolarisScaffold(
        modifier = modifier,
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        paneDetail = { window -> if (window.connectPanes(fontScale)) end?.detail else null },
        paneActions = { window -> if (window.connectPanes(fontScale)) end?.actions else null },
    ) {
        PolarisProductHeader()
        if (badge != null) {
            Spacer(Modifier.height(PolarisSpace.medium))
            badge()
            Spacer(Modifier.height(PolarisSpace.medium))
        }
        PolarisTitle(title, key = state)
        content()
        val window = polarisWindow
        if (end != null && !window.connectPanes(fontScale)) {
            if (end.detail != null) {
                Spacer(Modifier.height(PolarisSpace.medium))
                end.detail.invoke(this)
            }
            Spacer(Modifier.height(window.section))
            end.actions(this)
        }
    }
}

/** True once the prompt has been up for the input delay (immediately off a TV). */
@Composable
internal fun rememberArmed(key: Any?, tv: Boolean): Boolean {
    var armed by remember(key) { mutableStateOf(!tv) }
    if (tv) {
        LaunchedEffect(key) {
            delay(PolarisPromptInputDelayMs)
            armed = true
        }
    }
    return armed
}

/** A control of the pair of screens. [primary] is the filled one; [focus] is the first focus on a TV or with a keyboard. */
internal class ConnectButton(val text: String, val onClick: () -> Unit, val primary: Boolean = false, val focus: Boolean = false)

/**
 * The actions after the content. A stack with the primary first (Android, Windows, Linux); on the Mac a trailing row with Cancel
 * directly left of the default, emitted left to right so Tab runs the same way. No default key: Return never confirms here.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ConnectActions(buttons: List<ConnectButton>) {
    @Composable
    fun draw(button: ConnectButton) {
        if (button.primary) {
            PolarisPrimaryButton(button.text, button.onClick, initialFocus = button.focus)
        } else {
            PolarisSecondaryButton(button.text, button.onClick, initialFocus = button.focus)
        }
    }
    // On a TV the focused control is brought into view with the title-safe margin below it, so it never sits in the overscan.
    val margin = with(LocalDensity.current) { TV_SAFE_BOTTOM.toPx() }
    val tv = polarisWindow.tv
    val responder = remember(margin, tv) {
        object : BringIntoViewResponder {
            override fun calculateRectForParent(localRect: Rect): Rect = if (tv) localRect.copy(bottom = localRect.bottom + margin) else localRect

            override suspend fun bringChildIntoView(localRect: () -> Rect?) = Unit
        }
    }
    Column(Modifier.fillMaxWidth().bringIntoViewResponder(responder)) {
        if (polarisWindow.isMac) {
            PolarisActionGroup(row = true, visualOrder = true) { for (button in buttons.reversed()) draw(button) }
        } else {
            buttons.forEachIndexed { index, button ->
                draw(button)
                if (index < buttons.lastIndex) Spacer(Modifier.height(PolarisSpace.controls))
            }
        }
    }
}

/** The title-safe band at the foot of a TV picture (5 % of 540 dp, and the focus ring). */
private val TV_SAFE_BOTTOM = 31.dp

/** The vertical padding inside a chip (6 dp: the chip is 32 dp tall at rest and grows with the text). */
private val CHIP_VERTICAL_PADDING = 6.dp

/** A failure the person can act on: the warning glyph and the sentence. Not a live region: the heading's focus announces the state. */
@Composable
internal fun ConnectNotice(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls), verticalAlignment = Alignment.Top) {
        Icon(PolarisSymbols.Warning, contentDescription = null, tint = PolarisTheme.status.danger, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
    }
}

/** The code both people compare: the kit's hero code (kit mono, medium, one line), centred, with no copy button; read through a11y.linkCode. */
@Composable
private fun PairCode(code: String, spoken: String?) {
    val light = MaterialTheme.colorScheme.background.luminance() > 0.5f
    // The light plate has a weak edge of its own: a hairline keeps the code a distinct object.
    val edge = if (light) Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.large) else Modifier
    val words = CodeWords(description = spoken ?: KitConnect.spellOut(code))
    PolarisUserCode(code, Modifier.fillMaxWidth().then(edge), onCopy = null, words = words, centered = true)
}

/** Which device reported the code: worded as reported, never as who it is; a missing name says so. */
@Composable
private fun ReportedLine(lines: KitLines) {
    val line = lines.text("linkPairing.reported") ?: lines.text("linkPairing.reportedUnnamed").orEmpty()
    Text(line, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.fillMaxWidth())
}

/**
 * What each of the two people shares: the label, then the categories as tags; or the line that nothing is shared yet. The group is one
 * item to a screen reader ("Each of you shares: Contacts, Photos").
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Shares(lines: KitLines, categories: List<String>, labels: Map<String, String>) {
    val heading = lines.text("linkPairing.shares")
    if (heading == null) {
        lines.text("linkPairing.sharesNone")?.let { PolarisBody(it, textAlign = TextAlign.Start) }
        return
    }
    val names = categories.map { labels[it] ?: KitConnect.categoryFallback(it) }
    Column(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "$heading: ${names.joinToString(", ")}" }) {
        Text(
            heading,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(PolarisSpace.tight))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(PolarisSpace.tight),
            verticalArrangement = Arrangement.spacedBy(PolarisSpace.tight),
        ) {
            for (name in names) ConsentTag(KitConnect.isolate(name))
        }
    }
}

/** A category tag at reading size: 14 sp, 6 x 12 dp, at least 32 dp tall. */
@Composable
private fun ConsentTag(text: String) {
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.09f),
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Box(
            Modifier.heightIn(min = 32.dp).padding(horizontal = PolarisSpace.controls, vertical = CHIP_VERTICAL_PADDING),
            contentAlignment = Alignment.Center,
        ) {
            Text(text, style = MaterialTheme.typography.labelLarge.copy(fontSize = 14.sp))
        }
    }
}
