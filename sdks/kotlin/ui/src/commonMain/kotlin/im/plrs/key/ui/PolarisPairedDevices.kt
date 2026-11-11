// @pkey-feature connect.local ui.kit
// PairedDevices (CC-29K.2; ui-matrix `local`): what this device paired with by a code, one row each, drawn over
// [PolarisPairedDevicesState]; the Kotlin twin of the React kit's <PairedDevices> and the SwiftUI kit's PairedDevicesView.
//
// Rules the screens keep:
//  - the Can connect column shows only with more than 8 paired or one off ([KitLocal.showSwitchColumn]), and every switch is named for its
//    device ("Let {device} connect to this device");
//  - each row has one options menu (Rename, Forget); both work in the row, and Forget asks there;
//  - after an edit focus returns to the row's options button, after a Forget to the next row or the title;
//  - the list says nothing about what is paired until the first read answers (the loading state);
//  - Pair with a Code is the one primary, drawn unavailable (still pressable) when the device holds 32;
//  - device names are unauthenticated text: isolated and never drawn as a heading.
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private const val DIMMED = 0.5f

private class RowActions(private val state: PolarisPairedDevicesState, private val scope: CoroutineScope) : PolarisPairedRowActions {
    override fun startRename(id: String) = state.startRename(id)

    override fun setDraft(text: String) = state.setDraft(text)

    override fun saveRename() {
        scope.launch { state.saveRename() }
    }

    override fun askForget(id: String) = state.askForget(id)

    override fun confirmForget() {
        scope.launch { state.confirmForget() }
    }

    override fun cancelEdit() = state.cancelEdit()

    override fun setReachable(id: String, on: Boolean) {
        scope.launch { state.setReachable(id, on) }
    }
}

private class ScreenActions(private val state: PolarisPairedDevicesState, private val scope: CoroutineScope, private val onRetry: (String) -> Unit) :
    PolarisPairedScreenActions {
    override fun retry() {
        scope.launch { state.refresh() }
    }

    override fun retryNotice(id: String) {
        state.retryNotice(id)
        onRetry(id)
    }

    override fun done() = state.done()

    override fun pair() = state.requestPair()

    override fun focusHandled() = state.focusHandled()
}

/**
 * Paired devices over [state]: it reads the list when this enters the composition and follows the SDK's changes until it leaves.
 * [onClose] runs for Done and Back; [onPair] opens Pair with a Code (the host's). Try again on the app's busy answer for a device
 * shows that notice busy and runs [onRetry] with the device's id; the host reports the next answer with
 * [PolarisPairedDevicesState.report].
 */
@Composable
public fun PolarisPairedDevices(
    state: PolarisPairedDevicesState,
    modifier: Modifier = Modifier,
    onClose: () -> Unit = {},
    onPair: () -> Unit = {},
    onRetry: (String) -> Unit = {},
) {
    val ui by state.ui.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(state) { state.start { reload -> scope.launch { reload() } } }
    DisposableEffect(state) { onDispose { state.stop() } }
    LaunchedEffect(ui.left) { if (ui.left) onClose() }
    LaunchedEffect(ui.pairAnother) { if (ui.pairAnother) onPair() }
    val actions = remember(state) {
        val rows = RowActions(state, scope)
        val screen = ScreenActions(state, scope, onRetry)
        object : PolarisPairedDevicesActions, PolarisPairedRowActions by rows, PolarisPairedScreenActions by screen {}
    }
    PolarisPairedDevicesScreen(ui, modifier, actions)
}

/** PairedDevices' states as the matrix resolves them, stateless over [ui] and its [actions]. */
@Composable
public fun PolarisPairedDevicesScreen(
    ui: PolarisPairedDevicesUi,
    modifier: Modifier = Modifier,
    actions: PolarisPairedDevicesActions = PolarisPairedDevicesActions.None,
    /** The time "Last seen" counts back from; a test passes a fixed one. */
    nowMillis: Long = System.currentTimeMillis(),
) {
    val screen = remember(ui) { ui.screen() }
    if (screen.isHidden) return
    val locale = kitLocale()
    val lines = remember(screen, locale) { KitLines(screen, KitCopy.bundled, locale) }
    val titleFocus = remember { FocusRequester() }
    val rowFocus = remember { mutableMapOf<String, FocusRequester>() }
    PairedFocusEffects(ui, lines, actions, titleFocus, rowFocus)
    val editing = ui.step == "renaming" || ui.step == "forgetting"
    val host = modifier.then(PolarisBackHandler(enabled = true, onBack = if (editing) actions::cancelEdit else actions::done))
    val variant = polarisCopyVariant()
    val button: (String) -> String = { key -> KitCopy.bundled.format(key, locale, variant = variant) }
    PolarisScaffold(modifier = host, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        PolarisTitle(lines.text("pairedDevices.title").orEmpty(), Modifier.focusRequester(titleFocus).focusTarget(), key = screen.state)
        Spacer(Modifier.height(PolarisSpace.tight))
        when (screen.state) {
            "loading" -> PairedLoading(lines, button, actions)
            "load-failed" -> PairedLoadFailed(lines, button, actions)
            "empty" -> PairedEmpty(lines, button, actions)
            else -> PairedList(PairedCtx(ui, lines, actions), screen, button, rowFocus, nowMillis)
        }
    }
}

/** Focus after an edit or a Forget, and the app's answer for a device told once. */
@Composable
private fun PairedFocusEffects(
    ui: PolarisPairedDevicesUi,
    lines: KitLines,
    actions: PolarisPairedDevicesActions,
    titleFocus: FocusRequester,
    rowFocus: Map<String, FocusRequester>,
) {
    val announce = rememberPolarisAnnouncer()
    // After an edit focus returns to the row's options button; after a Forget it moves to the next row or the title.
    LaunchedEffect(ui.focus) {
        when (val f = ui.focus) {
            is PolarisPairedFocus.Row -> rowFocus[f.id]?.let { runCatching { it.requestFocus() } }
            PolarisPairedFocus.Title -> runCatching { titleFocus.requestFocus() }
            null -> return@LaunchedEffect
        }
        actions.focusHandled()
    }
    LaunchedEffect(ui.notice) {
        val n = ui.notice ?: return@LaunchedEffect
        val key = when (n.kind) {
            "not-found" -> "pairedDevices.notFoundTitle"
            "busy" -> "pairedDevices.busyTitle"
            else -> "core.codes.link-unknown.title"
        }
        announce(lines.text(key).orEmpty())
    }
}

@Composable
private fun PairedLoading(lines: KitLines, button: (String) -> String, actions: PolarisPairedDevicesActions) {
    // Nothing is said about what is paired until the read answers.
    Spacer(Modifier.height(PolarisSpace.medium))
    PairWait(lines.text("a11y.busy").orEmpty())
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(listOf(ConnectButton(button("common.done"), actions::done, primary = true)))
}

@Composable
private fun PairedLoadFailed(lines: KitLines, button: (String) -> String, actions: PolarisPairedDevicesActions) {
    Box(Modifier.semantics { liveRegion() }) { ConnectNotice(lines.text("pairedDevices.loadFailed").orEmpty()) }
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(
        listOf(
            ConnectButton(button("common.tryAgain"), actions::retry, primary = true, focus = true),
            ConnectButton(button("common.done"), actions::done),
        ),
    )
}

@Composable
private fun PairedEmpty(lines: KitLines, button: (String) -> String, actions: PolarisPairedDevicesActions) {
    PolarisBody(lines.text("pairedDevices.empty").orEmpty(), textAlign = TextAlign.Start)
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(
        listOf(
            ConnectButton(button("pairedDevices.pair"), actions::pair, primary = true),
            ConnectButton(button("common.done"), actions::done),
        ),
    )
}

@Composable
private fun PairedList(c: PairedCtx, screen: KitScreen, button: (String) -> String, rowFocus: MutableMap<String, FocusRequester>, nowMillis: Long) {
    val lines = c.lines
    val actions = c.actions
    if (screen.state == "off") {
        PairNotice(lines.text("core.codes.local-pairing-off.title").orEmpty(), lines.text("pairedDevices.offBody"))
    } else {
        PolarisBody(lines.text("pairedDevices.lede").orEmpty(), textAlign = TextAlign.Start)
        PairedNotices(c)
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    PairedRows(c, rowFocus, nowMillis)
    Spacer(Modifier.height(polarisWindow.section))
    when (screen.state) {
        "list" -> {
            // Only Pair with a Code is dimmed when the device holds 32; Done stays as it is.
            val full = "pairedDevices.pair" in screen.disabledKeys
            val label = button("pairedDevices.pair")
            val why = lines.text("core.codes.local-links-full.title").orEmpty()
            Box(Modifier.alpha(if (full) DIMMED else 1f).semantics { if (full) stateDescription = why }) {
                ConnectActions(listOf(ConnectButton(label, { if (!full) actions.pair() }, primary = true)))
            }
            ConnectActions(listOf(ConnectButton(button("common.done"), actions::done)))
        }

        "off" -> ConnectActions(listOf(ConnectButton(button("common.done"), actions::done, primary = true)))

        else -> ConnectActions(listOf(ConnectButton(button("common.done"), actions::done)))
    }
}

@Composable
private fun PairedNotices(c: PairedCtx) {
    val ui = c.ui
    val lines = c.lines
    val actions = c.actions
    if (ui.step != "list") return
    lines.text("pairedDevices.reachableFullTitle")?.let {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(it, lines.text("pairedDevices.reachableFullBody"))
    }
    lines.text("core.codes.local-links-full.title")?.let {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(it, lines.text("pairedDevices.fullBody"))
    }
    val n = ui.notice ?: return
    Spacer(Modifier.height(PolarisSpace.medium))
    when (n.kind) {
        "not-found" -> PairNotice(lines.text("pairedDevices.notFoundTitle").orEmpty(), lines.text("pairedDevices.notFoundBody"))

        "busy" -> PairNotice(
            lines.text("pairedDevices.busyTitle").orEmpty(),
            null,
            lines.text("common.tryAgain")?.let { it to { n.id?.let(actions::retryNotice) ?: actions.retry() } },
            busy = ui.noticeBusy,
        )

        else -> PairNotice(lines.text("core.codes.link-unknown.title").orEmpty(), lines.text("core.codes.link-unknown.message"))
    }
}

private fun SemanticsPropertyReceiver.liveRegion() {
    liveRegion = LiveRegionMode.Polite
}
