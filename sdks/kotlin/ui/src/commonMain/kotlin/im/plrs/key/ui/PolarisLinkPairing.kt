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
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "CyclomaticComplexMethod", "LongParameterList", "LongMethod")

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.em
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
    val armed = rememberArmed(screen.state, window.tv)
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
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
            )
            Spacer(Modifier.height(window.section))
            ConnectActions(listOf(ConnectButton(button("common.cancel"), onCancel, focus = true)))
        }

        "code" -> ConnectStep(host, text("linkPairing.codeTitle"), screen.state) {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(text("linkPairing.codeBody"), textAlign = TextAlign.Start)
            Spacer(Modifier.height(PolarisSpace.medium))
            PairCode(code.orEmpty(), lines.text("a11y.linkCode"))
            Spacer(Modifier.height(PolarisSpace.medium))
            ReportedLine(lines)
            Spacer(Modifier.height(PolarisSpace.medium))
            Shares(lines, categories, categoryLabels)
            Spacer(Modifier.height(window.section))
            // The categories above come first; the choice follows. The first focus is the safe verb, never Codes match.
            ConnectActions(
                listOf(
                    ConnectButton(button("linkPairing.confirm"), { if (armed) onConfirm() }, primary = true),
                    ConnectButton(button("linkPairing.decline"), { if (armed) onDecline() }, focus = true),
                ),
            )
        }

        "confirm" -> ConnectStep(host, text("linkPairing.waiting"), screen.state) {
            // The other person may still be comparing against this screen: the code, the reported line and the categories stay.
            Spacer(Modifier.height(PolarisSpace.medium))
            PairCode(code.orEmpty(), lines.text("a11y.linkCode"))
            Spacer(Modifier.height(PolarisSpace.medium))
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
            Spacer(Modifier.height(window.section))
            ConnectActions(listOf(ConnectButton(button("common.cancel"), onCancel, focus = true)))
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
            val danger = lines.has("linkPairing.failedClosed")
            ConnectStep(host, text("linkPairing.failedTitle"), screen.state) {
                Spacer(Modifier.height(PolarisSpace.tight))
                if (danger) PolarisErrorLine(failedBody.orEmpty()) else PolarisBody(failedBody.orEmpty(), textAlign = TextAlign.Start)
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

/** One step: the product header, the heading (announced once per state) and the content, with the actions inside it. */
@Composable
internal fun ConnectStep(modifier: Modifier, title: String, state: String, content: @Composable ColumnScope.() -> Unit) {
    // No `actions` slot: they would dock below the scroll, and Codes match must not be on screen before the categories.
    PolarisScaffold(modifier = modifier, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        PolarisProductHeader()
        PolarisTitle(title, key = state)
        content()
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
    if (polarisWindow.isMac) {
        PolarisActionGroup(row = true, visualOrder = true) { for (button in buttons.reversed()) draw(button) }
    } else {
        buttons.forEachIndexed { index, button ->
            draw(button)
            if (index < buttons.lastIndex) Spacer(Modifier.height(PolarisSpace.controls))
        }
    }
}

/** The code both people compare: monospace, large, on a card; read digit by digit. */
@Composable
private fun PairCode(code: String, spoken: String?) {
    val read = spoken ?: KitConnect.spellOut(code)
    PolarisSection(title = null) {
        Text(
            code,
            style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Monospace, letterSpacing = 0.08.em),
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(PolarisSpace.medium).clearAndSetSemantics { contentDescription = read },
        )
    }
}

/** Which device reported the code: worded as reported, never as who it is; a missing name says so. */
@Composable
private fun ReportedLine(lines: KitLines) {
    val line = lines.text("linkPairing.reported") ?: lines.text("linkPairing.reportedUnnamed").orEmpty()
    Text(line, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.fillMaxWidth())
}

/** What each of the two people shares: the label, then the categories as tags; or the line that nothing is shared yet. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Shares(lines: KitLines, categories: List<String>, labels: Map<String, String>) {
    val heading = lines.text("linkPairing.shares")
    if (heading == null) {
        lines.text("linkPairing.sharesNone")?.let { PolarisBody(it, textAlign = TextAlign.Start) }
        return
    }
    Text(heading, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(PolarisSpace.tight))
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.tight),
        verticalArrangement = Arrangement.spacedBy(PolarisSpace.tight),
    ) {
        for (id in categories) KitTag(KitConnect.isolate(labels[id] ?: KitConnect.categoryFallback(id)))
    }
}
