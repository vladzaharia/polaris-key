// @pkey-feature connect.local ui.kit
// Pair with a Code (CC-29K.2; ui-matrix `local`): LocalPairing, the windows two devices of one app on one network pair in by an 8-digit
// code or a QR with no account, drawn over [PolarisLocalPairingState]; the Kotlin twin of the React kit's <LocalPairing> and of the
// SwiftUI kit's LocalPairingView. The words are the catalog keys the state machine names (KitLocalStates.kt).
//
// Rules the screens keep:
//  - the show step is one window with two views: the code view (the digits, the largest thing on the screen, in the kit's mono face, read
//    digit by digit "Pairing code 4 8 1 2 ...") and the QR view (the QR alone, behind one swappable [PairQrCard]), each with one link to
//    the other; switching never renews the code, a new window opens on the view last chosen, and a window that ran out stays in its view,
//    dimmed, with Show a new code. The QR view sits in two columns in a wide, short window ([KitLocal.qrTwoColumns]); a window under 480
//    tall drops the kit's logo, and the column scrolls with the notice before the QR;
//  - no state confirms by default: the first focus is Not now on a consent, and Pair is filled but never the Enter key;
//  - a control drawn but unavailable (Pair under 8 digits, Show a new code while it waits) stays pressable and answers its reason, so a
//    screen reader never meets a dead button; its reason is its state description;
//  - the other device's name is unauthenticated text: isolated, and never truncated in the consent title;
//  - answers are announced once: a new code (spelled out, apart from the action that asked), a notice, a refusal, the wait over.
@file:Suppress("ktlint:standard:function-naming", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private class FlowActions(private val state: PolarisLocalPairingState, private val scope: CoroutineScope) : PolarisPairFlowActions {
    override fun show() {
        scope.launch { state.show() }
    }

    override fun enter() {
        scope.launch { state.enter() }
    }

    override fun showQr() = state.showQr()

    override fun showCode() = state.showCode()

    override fun showNew() {
        scope.launch { state.showNew() }
    }

    override fun back() {
        scope.launch { state.backToChoose() }
    }

    override fun cancel() {
        scope.launch { state.cancel() }
    }

    override fun close() {
        scope.launch { state.closeScreen() }
    }

    override fun done() {
        scope.launch { state.done() }
    }

    override fun retry() {
        scope.launch { state.retry() }
    }
}

private class ScanActions(private val state: PolarisLocalPairingState, private val scope: CoroutineScope) : PolarisPairScanActions {
    override fun scan() {
        scope.launch { state.toScan() }
    }
}

private class FormActions(private val state: PolarisLocalPairingState, private val scope: CoroutineScope, private val host: PolarisPairHost) :
    PolarisPairFormActions {
    override fun pair() {
        scope.launch { state.pair() }
    }

    override fun confirm() {
        scope.launch { state.confirm() }
    }

    override fun notNow() {
        scope.launch { state.notNow() }
    }

    override fun setEntry(text: String) = state.setEntry(text)

    override fun setName(text: String) = state.setName(text)

    override fun openSettings() = host.openSettings()

    override fun openPairedDevices() = host.openPairedDevices()
}

/**
 * Pair with a Code over [state]: it reads the gate and the cap when this enters the composition and withdraws the code, stops a join and
 * declines a prompt when it leaves. [categoryLabels] names each data category by its id (an id without a name is drawn as words);
 * [onClose] runs when the person leaves (Cancel, Close, Done, Back); [host] answers the entries that are the app's own (Paired
 * devices, the platform's settings).
 */
@Composable
public fun PolarisLocalPairing(
    state: PolarisLocalPairingState,
    modifier: Modifier = Modifier,
    categoryLabels: Map<String, String> = emptyMap(),
    onClose: () -> Unit = {},
    host: PolarisPairHost = PolarisPairHost.None,
) {
    val ui by state.ui.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(state) { state.start() }
    DisposableEffect(state) { onDispose { state.dispose() } }
    LaunchedEffect(ui.left) { if (ui.left) onClose() }
    val actions = remember(state) {
        val flow = FlowActions(state, scope)
        val form = FormActions(state, scope, host)
        val scan = ScanActions(state, scope)
        object : PolarisLocalPairingActions, PolarisPairFlowActions by flow, PolarisPairFormActions by form, PolarisPairScanActions by scan {}
    }
    PolarisLocalPairingScreen(ui, modifier, categoryLabels, actions)
}

/** LocalPairing's states as the matrix resolves them, stateless over [ui] and its [actions]. */
@Composable
public fun PolarisLocalPairingScreen(
    ui: PolarisLocalPairingUi,
    modifier: Modifier = Modifier,
    categoryLabels: Map<String, String> = emptyMap(),
    actions: PolarisLocalPairingActions = PolarisLocalPairingActions.None,
) {
    // The product's own name, as the header shows it: the pre-prompt says "{app}", never a placeholder.
    val product = PolarisTheme.copy.productName
    val screen = remember(ui, product) { ui.screen(KitInputs.of(mapOf("presentation" to JsonObject(mapOf("name" to JsonPrimitive(product)))))) }
    if (screen.isHidden) return
    val locale = kitLocale()
    val lines = remember(screen, locale) { KitLines(screen, KitCopy.bundled, locale) }
    val c = PairCtx(ui, lines, actions, categoryLabels, screen)
    val tile = remember { FocusRequester() }
    PairAnnouncements(c, tile)
    val escape: () -> Unit = when (screen.state) {
        "paired" -> actions::done
        "opening", "show", "show-qr", "confirm", "joining", "waiting" -> actions::cancel
        "enter" -> actions::back
        else -> actions::close
    }
    val host = modifier.then(PolarisBackHandler(enabled = true, onBack = escape))
    // A press that arrives as the prompt opens is ignored for 250 ms on a TV, so a stray D-pad press never pairs.
    val armed = rememberArmed(screen.state, isTelevision())
    val fontScale = LocalDensity.current.fontScale
    PolarisScaffold(modifier = host, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        // The window the scaffold lays out in: only inside it is the real size known.
        val window = polarisWindow
        val layout = KitLocal.layout(window.height.value.toDouble(), window.tv)
        if (layout.logo) PolarisProductHeader()
        if (ui.step == "paired") PairSuccessMark()
        PolarisTitle(c.text(titleKey(ui)), key = screen.state)
        // The refusals say their reason as the lede, under the title.
        if (screen.state == "off" || screen.state == "network-blocked") {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(c.reason, textAlign = TextAlign.Start)
        }
        PairStep(c, layout, tile, armed, KitLocal.qrTwoColumns(window.width.value.toDouble(), window.height.value.toDouble(), fontScale.toDouble()))
    }
}

@Composable
private fun ColumnScope.PairStep(c: PairCtx, layout: KitLocal.Layout, tile: FocusRequester, armed: Boolean, qrColumns: Boolean) {
    when (c.ui.step) {
        "choose" -> PairChoose(c)
        "opening", "show" -> PairShow(c, layout, tile, qrColumns)
        "closed" -> PairClosed(c)
        "enter", "joining" -> PairEnter(c)
        "confirm" -> PairConfirm(c, armed)
        "waiting" -> PairWaiting(c)
        "paired" -> PairPaired(c)
        else -> PairEnding(c)
    }
}

/** What is told once, apart from the heading's focus: a new code (which takes focus), a refusal, the block, the wait over. */
@Composable
private fun PairAnnouncements(c: PairCtx, tile: FocusRequester) {
    val ui = c.ui
    val announce = rememberPolarisAnnouncer()
    PairNewCodeAnnouncement(c, tile, announce)
    // A switch says the new view's line; the first view of a window is told with its state.
    LaunchedEffect(ui.switches) {
        if (ui.switches > 0 && ui.step == "show") announce(c.text(if (ui.view == "qr") "localPairing.qrBody" else "localPairing.showBody"))
    }
    // The title says "Code expired"; a screen reader also hears the sentence, once.
    val expiredSaid = c.button("localPairing.failedExpired")
    LaunchedEffect(ui.expired) { if (ui.expired) announce(expiredSaid) }
    LaunchedEffect(ui.error) { ui.error?.let { err -> errorKey(err)?.let { announce(c.text(it)) } } }
    LaunchedEffect(ui.notice) { if (ui.notice == "blocked") announce(c.text("localPairing.blockedTitle")) }
    LaunchedEffect(ui.step) { if (ui.step == "opening") announce(c.text("a11y.busy")) }
    // The wait is over: the person is told and focus rests on the heading's next control.
    LaunchedEffect(ui.cooldownLeft) {
        if (ui.step == "closed" && ui.cooldownLeft == 0) announce(c.text("localPairing.showNew"))
    }
}

/**
 * A new code that replaced the one being looked at. The code view says the notice and spells the code, and focus goes to the tile; the QR
 * view says the change without the digits and focus rests on its heading. After a dead window, "The code changed." and the stage.
 */
@Composable
private fun PairNewCodeAnnouncement(c: PairCtx, tile: FocusRequester, announce: (String) -> Unit) {
    val ui = c.ui
    val qr = ui.view == "qr"
    val changedSaid = c.button("localPairing.rotatedBody")
    val spelled = c.lines.format("a11y.newCode", mapOf("code" to CopyArgument.Text(KitConnect.spellOut(ui.code.orEmpty()))))
    val notice = listOf("localPairing.rotatedTitle", "localPairing.notPairedWith", "localPairing.rotatedBody").mapNotNull { c.lines.text(it) }
    LaunchedEffect(ui.rotation) {
        if (!ui.newCodeShown()) return@LaunchedEffect
        val said = when {
            ui.renewedFromExpired -> if (qr) changedSaid else "$changedSaid $spelled"
            qr -> notice.joinToString(" ")
            else -> spelled
        }
        announce(said)
        if (!qr) runCatching { tile.requestFocus() }
    }
}

@Composable
private fun PairSuccessMark() {
    PolarisIconBadge(PolarisSymbols.Check, MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
    Spacer(Modifier.height(PolarisSpace.medium))
}

private fun titleKey(ui: PolarisLocalPairingUi): String = when (ui.step) {
    "show" -> if (ui.expired) {
        "core.codes.sign-in-expired.title"
    } else if (ui.view == "qr") {
        "localPairing.qrTitle"
    } else {
        "localPairing.title"
    }

    "closed" -> "linkPairing.failedTitle"

    "confirm" -> if (ui.device != null) "localPairing.confirmTitle" else "localPairing.confirmUnnamed"

    "waiting" -> "linkPairing.waiting"

    "paired" -> "localPairing.pairedTitle"

    "failed" -> "linkPairing.failedTitle"

    "network-blocked" -> "core.codes.nearby-permission-denied.title"

    "off" -> "core.codes.local-pairing-off.title"

    else -> "localPairing.title"
}

private fun errorKey(error: String): String? = when (error) {
    "wrong" -> "localPairing.wrongCode"
    "spent" -> "localPairing.spentCode"
    "too-many" -> "localPairing.cooldownTitle"
    "not-found" -> "localPairing.notFoundTitle"
    "not-a-code" -> "localPairing.notACode"
    else -> null
}

/** A code that replaced one the person was looking at (a wrong guess, a Not now, Show a new code): announced and focused. */
private fun PolarisLocalPairingUi.newCodeShown(): Boolean = step == "show" && replaced && code != null
