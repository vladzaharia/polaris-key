// @pkey-feature connect.local ui.kit
// Pair with a Code (CC-29K.2; ui-matrix `local`): LocalPairing, the windows two devices of one app on one network pair in by an 8-digit
// code or a QR with no account, drawn over [PolarisLocalPairingState]; the Kotlin twin of the React kit's <LocalPairing> and of the
// SwiftUI kit's LocalPairingView. The words are the catalog keys the state machine names (KitLocalStates.kt).
//
// Rules the screens keep:
//  - the code is the largest thing on the show screen, in the kit's mono face, read digit by digit ("Pairing code 4 8 1 2 ..."), with the
//    QR beside it from 600 dp of window at the root text size and under it otherwise ([KitLocal.layout]); a window under 480 tall drops
//    the kit's logo, and a narrow short one scrolls one column with the notice before the QR;
//  - no state confirms by default: the first focus is Not now on a consent, and Pair is filled but never the Enter key;
//  - a control drawn but unavailable (Pair under 8 digits, Show a new code while it waits) stays pressable and answers its reason, so a
//    screen reader never meets a dead button; its reason is its state description;
//  - the other device's name is unauthenticated text: isolated, and never truncated in the consent title;
//  - answers are announced once: a new code (spelled out, apart from the action that asked), a notice, a refusal, the wait over.
@file:Suppress(
    "ktlint:standard:function-naming",
    "FunctionNaming",
    "CyclomaticComplexMethod",
    "LongParameterList",
    "LongMethod",
    "MagicNumber",
    "ComplexMethod",
    "TooManyFunctions",
)

package im.plrs.key.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** What the pairing screen's controls do. Every callback defaults to nothing, so a still draws without a state holder. */
public class PolarisLocalPairingActions(
    public val show: () -> Unit = {},
    public val enter: () -> Unit = {},
    public val showNew: () -> Unit = {},
    public val toShow: () -> Unit = {},
    public val toEnter: () -> Unit = {},
    public val back: () -> Unit = {},
    public val cancel: () -> Unit = {},
    public val close: () -> Unit = {},
    public val pair: () -> Unit = {},
    public val confirm: () -> Unit = {},
    public val notNow: () -> Unit = {},
    public val done: () -> Unit = {},
    public val retry: () -> Unit = {},
    public val openSettings: () -> Unit = {},
    public val openPairedDevices: () -> Unit = {},
    public val setEntry: (String) -> Unit = {},
    public val setName: (String) -> Unit = {},
)

/**
 * Pair with a Code over [state]: it reads the gate and the cap when this enters the composition and withdraws the code, stops a join and
 * declines a prompt when it leaves. [categoryLabels] names each data category by its id (an id without a name is drawn as words);
 * [onClose] runs when the person leaves (Cancel, Close, Done, Back); [onOpenPairedDevices] and [onOpenSettings] are the host's.
 */
@Composable
public fun PolarisLocalPairing(
    state: PolarisLocalPairingState,
    modifier: Modifier = Modifier,
    categoryLabels: Map<String, String> = emptyMap(),
    onClose: () -> Unit = {},
    onOpenPairedDevices: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
) {
    val ui by state.ui.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(state) { state.start() }
    DisposableEffect(state) { onDispose { state.dispose() } }
    LaunchedEffect(ui.left) { if (ui.left) onClose() }
    val actions = remember(state) {
        PolarisLocalPairingActions(
            show = { scope.launch { state.show() } },
            enter = { scope.launch { state.enter() } },
            showNew = { scope.launch { state.showNew() } },
            toShow = { scope.launch { state.toShow() } },
            toEnter = { scope.launch { state.toEnter() } },
            back = { scope.launch { state.backToChoose() } },
            cancel = { scope.launch { state.cancel() } },
            close = { scope.launch { state.closeScreen() } },
            pair = { scope.launch { state.pair() } },
            confirm = { scope.launch { state.confirm() } },
            notNow = { scope.launch { state.notNow() } },
            done = { scope.launch { state.done() } },
            retry = { scope.launch { state.retry() } },
            openSettings = onOpenSettings,
            openPairedDevices = onOpenPairedDevices,
            setEntry = state::setEntry,
            setName = state::setName,
        )
    }
    PolarisLocalPairingScreen(ui, modifier, categoryLabels, actions)
}

/** LocalPairing's states as the matrix resolves them, stateless over [ui] and its [actions]. */
@Composable
public fun PolarisLocalPairingScreen(
    ui: PolarisLocalPairingUi,
    modifier: Modifier = Modifier,
    categoryLabels: Map<String, String> = emptyMap(),
    actions: PolarisLocalPairingActions = PolarisLocalPairingActions(),
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    val screen = remember(ui) { ui.screen() }
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val variant = polarisCopyVariant()

    fun text(key: String): String = lines.text(key).orEmpty()

    fun button(key: String): String = catalog.format(key, locale, variant = variant)
    val fontScale = LocalDensity.current.fontScale
    val announce = rememberPolarisAnnouncer()
    val tile = remember { FocusRequester() }
    val escape: () -> Unit = when (screen.state) {
        "paired" -> actions.done
        "opening", "show", "confirm", "joining", "waiting" -> actions.cancel
        "enter" -> actions.back
        else -> actions.close
    }
    // The state is said once, by the heading's focus; a new code is told apart from the action that asked for it and takes focus.
    val spokenCode = KitConnect.spellOut(ui.code.orEmpty())
    LaunchedEffect(ui.rotation) {
        if (ui.step == "show" && ui.rotation > 1 && ui.notice != null && ui.code != null) {
            announce(lines.format("a11y.newCode", mapOf("code" to CopyArgument.Text(spokenCode))))
            runCatching { tile.requestFocus() }
        }
    }
    LaunchedEffect(ui.error) { ui.error?.let { err -> errorKey(err)?.let { announce(text(it)) } } }
    LaunchedEffect(ui.notice) { if (ui.notice == "blocked") announce(text("localPairing.blockedTitle")) }
    LaunchedEffect(ui.step) { if (ui.step == "opening") announce(text("a11y.busy")) }
    val host = modifier.then(PolarisBackHandler(enabled = true, onBack = escape))
    // A press that arrives as the prompt opens is ignored for 250 ms on a TV, so a stray D-pad press never pairs.
    val armed = rememberArmed(screen.state, isTelevision())
    val disabled = screen.disabledKeys.toSet()
    PolarisScaffold(modifier = host, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        // The window the scaffold lays out in: only inside it is the real size known.
        val window = polarisWindow
        val layout = KitLocal.layout(window.width.value.toDouble(), window.height.value.toDouble(), fontScale.toDouble(), window.tv)
        if (layout.logo) PolarisProductHeader()
        PolarisTitle(text(titleKey(ui)), key = screen.state)
        // The refusals say their reason as the lede, under the title.
        if (screen.state == "off" || screen.state == "network-blocked") {
            Spacer(Modifier.height(PolarisSpace.tight))
            PolarisBody(screen.copy.getOrNull(1)?.let { lines.format(it) }.orEmpty(), textAlign = TextAlign.Start)
        }
        when (screen.state) {
            "choose" -> Choose(ui, lines, ::button, actions, disabled)
            "opening", "show" -> Show(ui, lines, layout, tile, ::button, actions, disabled)
            "closed" -> Closed(ui, lines, ::button, actions, disabled)
            "enter", "joining" -> Enter(ui, lines, ::button, actions, disabled, categoryLabels)
            "confirm" -> Confirm(ui, lines, ::button, actions, armed, categoryLabels)
            "waiting" -> {
                Spacer(Modifier.height(PolarisSpace.medium))
                WaitRow(lines.text("localPairing.waitingWith") ?: text("linkPairing.waiting"))
                Spacer(Modifier.height(PolarisSpace.medium))
                Shares(lines, ui.categories, categoryLabels)
                Spacer(Modifier.height(polarisWindow.section))
                ConnectActions(listOf(ConnectButton(button("common.cancel"), actions.cancel, focus = true)))
            }
            "paired" -> Paired(ui, lines, ::button, actions)
            "failed" -> {
                val full = ui.reason == "full"
                val body = screen.copy.getOrNull(1)?.let { lines.format(it) }.orEmpty()
                Spacer(Modifier.height(PolarisSpace.tight))
                ConnectNotice(body)
                Spacer(Modifier.height(polarisWindow.section))
                val retry = ConnectButton(button("common.tryAgain"), actions.retry, primary = !full, focus = !full)
                val close = ConnectButton(button("common.close"), actions.close, primary = full, focus = full)
                ConnectActions(if (full) listOf(close, retry) else listOf(retry, close))
            }
            "network-blocked" -> {
                Spacer(Modifier.height(polarisWindow.section))
                val settings = ui.canOpenSettings
                val buttons = buildList {
                    if (settings) add(ConnectButton(button("localPairing.openSettings"), actions.openSettings, primary = true, focus = true))
                    add(ConnectButton(button("common.tryAgain"), actions.retry, primary = !settings, focus = !settings))
                    add(ConnectButton(button("common.close"), actions.close))
                }
                ConnectActions(buttons)
            }
            else -> {
                // Close is the only way out of a refusal: it is not the filled one.
                Spacer(Modifier.height(polarisWindow.section))
                ConnectActions(listOf(ConnectButton(button("common.close"), actions.close, focus = true)))
            }
        }
    }
}

private fun titleKey(ui: PolarisLocalPairingUi): String = when (ui.step) {
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

// ── Choose ───────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ColumnScope.Choose(
    ui: PolarisLocalPairingUi,
    lines: KitLines,
    button: (String) -> String,
    actions: PolarisLocalPairingActions,
    disabled: Set<String>,
) {
    Spacer(Modifier.height(PolarisSpace.tight))
    if (ui.full) {
        PairNotice(
            lines.text("core.codes.local-links-full.title").orEmpty(),
            lines.text("core.codes.local-links-full.message"),
            action = lines.text("localPairing.pairedDevices")?.let { it to actions.openPairedDevices },
        )
    } else {
        PolarisBody(lines.text("localPairing.chooseBody").orEmpty(), textAlign = TextAlign.Start)
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    // Either device can show the code: neither way is the filled one.
    val full = "localPairing.show" in disabled
    Column(Modifier.fillMaxWidth().alpha(if (full) 0.5f else 1f)) {
        PolarisSecondaryButton(button("localPairing.show"), actions.show)
        Spacer(Modifier.height(PolarisSpace.controls))
        PolarisSecondaryButton(button("localPairing.enter"), actions.enter)
    }
    lines.text("localPairing.prePrompt")?.let {
        Spacer(Modifier.height(PolarisSpace.controls))
        Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(listOf(ConnectButton(button("common.cancel"), actions.close)))
}

// ── Show ─────────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ColumnScope.Show(
    ui: PolarisLocalPairingUi,
    lines: KitLines,
    layout: KitLocal.Layout,
    tile: FocusRequester,
    button: (String) -> String,
    actions: PolarisLocalPairingActions,
    disabled: Set<String>,
) {
    val opening = ui.step == "opening"
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(lines.text("localPairing.showBody").orEmpty(), textAlign = TextAlign.Start)
    Spacer(Modifier.height(PolarisSpace.medium))
    val notice: @Composable () -> Unit = { ShowNotice(ui, lines, actions, disabled) }
    val qr: @Composable () -> Unit = { PairQr(ui, lines, opening, if (layout.logo) 184 else 160) }
    val start: @Composable ColumnScope.() -> Unit = {
        CodeTile(ui, lines, opening, tile)
        Spacer(Modifier.height(PolarisSpace.controls))
        TimeRow(ui, lines, opening)
    }
    if (layout.panes == 2) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group)) {
            Column(Modifier.weight(1f)) {
                start()
                notice()
                Spacer(Modifier.height(PolarisSpace.controls))
                WaitRow(if (opening) lines.text("a11y.busy").orEmpty() else lines.text("localPairing.waitingDevice").orEmpty())
            }
            qr()
        }
    } else {
        start()
        if (layout.noticeBeforeQr) notice()
        Spacer(Modifier.height(PolarisSpace.medium))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { qr() }
        if (!layout.noticeBeforeQr) notice()
        Spacer(Modifier.height(PolarisSpace.controls))
        WaitRow(if (opening) lines.text("a11y.busy").orEmpty() else lines.text("localPairing.waitingDevice").orEmpty())
    }
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(
        listOf(
            ConnectButton(button("common.cancel"), actions.cancel, focus = true),
            ConnectButton(button("localPairing.toEnter"), actions.toEnter),
        ),
    )
}

/** The code in the kit's mono face, the changed digits lit; a placeholder bar while the window opens. */
@Composable
private fun CodeTile(ui: PolarisLocalPairingUi, lines: KitLines, opening: Boolean, tile: FocusRequester) {
    val window = polarisWindow
    val size = if (window.wide || window.tv) 40.sp else if (window.compactHeight) 32.sp else 36.sp
    val lit = MaterialTheme.colorScheme.primary.copy(alpha = 0.3f)
    val spoken = lines.text("a11y.linkCode") ?: KitConnect.spellOut(ui.code.orEmpty())
    val edge = MaterialTheme.colorScheme.outlineVariant
    Surface(
        modifier = Modifier.fillMaxWidth().border(1.dp, edge, MaterialTheme.shapes.large),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Box(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 20.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
            val digits = ui.code
            if (opening || digits == null) {
                Box(Modifier.width(200.dp).height(32.dp).alpha(0.3f).border(0.dp, Color.Transparent).clearAndSetSemantics {}) {
                    Surface(Modifier.fillMaxWidth().height(32.dp), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.outline) {}
                }
            } else {
                val shown: AnnotatedString = buildAnnotatedString {
                    digits.forEachIndexed { i, ch ->
                        if (i in ui.changed) {
                            withStyle(SpanStyle(background = lit)) { append(ch) }
                        } else {
                            append(ch)
                        }
                    }
                }
                Text(
                    shown,
                    style = TextStyle(fontFamily = PolarisTheme.monoFamily, fontSize = size, letterSpacing = size * 0.12f),
                    maxLines = 1,
                    modifier = Modifier
                        .focusRequester(tile)
                        .focusable()
                        .semantics { contentDescription = spoken },
                )
            }
        }
    }
}

@Composable
private fun TimeRow(ui: PolarisLocalPairingUi, lines: KitLines, opening: Boolean) {
    if (opening) {
        Spacer(Modifier.height(24.dp))
        return
    }
    val left = ui.secondsLeft ?: 0
    // The time is said once a minute at most, never each second.
    val spoken = lines.format("localPairing.expires", mapOf("time" to CopyArgument.Text(KitLocal.countdown((left / 60) * 60))))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Text(
            lines.text("localPairing.expires").orEmpty(),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.semantics { contentDescription = spoken },
        )
    }
}

@Composable
private fun PairQr(ui: PolarisLocalPairingUi, lines: KitLines, opening: Boolean, size: Int) {
    val qr = ui.qr
    if (opening || qr == null) {
        Spacer(Modifier.size(size.dp))
        return
    }
    PolarisQr(qr, lines.text("a11y.qrPairing").orEmpty(), Modifier.size(size.dp))
}

@Composable
private fun WaitRow(text: String) {
    Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        PolarisWaitIndicator()
        Spacer(Modifier.height(PolarisSpace.controls))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ShowNotice(ui: PolarisLocalPairingUi, lines: KitLines, actions: PolarisLocalPairingActions, disabled: Set<String>) {
    val n = ui.notice ?: return
    Spacer(Modifier.height(PolarisSpace.controls))
    val renewing = "localPairing.showNew" in disabled
    val action = lines.text("localPairing.showNew")?.let { it to { if (!renewing) actions.showNew() } }
    when (n) {
        "rotated" -> PairNotice(lines.text("localPairing.rotatedTitle").orEmpty(), lines.text("localPairing.rotatedBody"), action, renewing)
        "declined" -> {
            val who = lines.text("localPairing.notPairedWith")
            PairNotice(who ?: lines.text("localPairing.rotatedBody").orEmpty(), if (who != null) lines.text("localPairing.rotatedBody") else null, action, renewing)
        }
        "guessing" -> PairNotice(lines.text("localPairing.rotatedTitle").orEmpty(), lines.text("localPairing.tooManyAgainBody"), action, renewing)
        else -> PairNotice(lines.text("localPairing.blockedTitle").orEmpty(), lines.text("localPairing.blockedBody"))
    }
}

/** A notice: its title, its words and an action as a link on its own line, underlined at rest. A live region, so it is told once. */
@Composable
internal fun PairNotice(title: String, body: String?, action: Pair<String, () -> Unit>? = null, busy: Boolean = false) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Row(Modifier.padding(PolarisSpace.medium), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            Icon(PolarisSymbols.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Column(Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                if (body != null) Text(body, style = MaterialTheme.typography.bodyLarge)
                if (action != null) {
                    PolarisTextButton(action.first, action.second, Modifier.semantics { if (busy) stateDescription = "…" }.alpha(if (busy) 0.6f else 1f))
                }
            }
        }
    }
}

// ── Closed ───────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ColumnScope.Closed(
    ui: PolarisLocalPairingUi,
    lines: KitLines,
    button: (String) -> String,
    actions: PolarisLocalPairingActions,
    disabled: Set<String>,
) {
    Spacer(Modifier.height(PolarisSpace.tight))
    val why = lines.text("localPairing.failedTooMany") ?: lines.text("localPairing.failedExpired").orEmpty()
    PolarisBody(why, textAlign = TextAlign.Start)
    if (ui.warn) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(lines.text("localPairing.tooManyAgainTitle").orEmpty(), lines.text("localPairing.tooManyAgainBody"))
    }
    Spacer(Modifier.height(polarisWindow.section))
    val cooling = "localPairing.showNewIn" in disabled
    val shown = button(if (cooling) "localPairing.showNewIn" else "localPairing.showNew")
    ConnectActions(
        listOf(
            ConnectButton(shown, { if (!cooling) actions.showNew() }, primary = true, focus = !cooling),
            ConnectButton(button("common.close"), actions.close),
        ),
    )
}

// ── Enter ────────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ColumnScope.Enter(
    ui: PolarisLocalPairingUi,
    lines: KitLines,
    button: (String) -> String,
    actions: PolarisLocalPairingActions,
    disabled: Set<String>,
    labels: Map<String, String>,
) {
    val joining = ui.step == "joining"
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(lines.text("localPairing.enterBody").orEmpty(), textAlign = TextAlign.Start)
    if (ui.error == "too-many" || ui.error == "not-found") {
        Spacer(Modifier.height(PolarisSpace.controls))
        val key = if (ui.error == "too-many") "localPairing.cooldown" else "localPairing.notFound"
        PairNotice(lines.text("${key}Title").orEmpty(), lines.text("${key}Body"))
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    val message = listOf("localPairing.wrongCode", "localPairing.notACode", "localPairing.spentCode").firstNotNullOfOrNull(lines::text)
    val invalid = ui.error == "wrong" || ui.error == "not-a-code"
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    PolarisTextField(
        value = ui.entry.orEmpty(),
        onValueChange = actions.setEntry,
        label = lines.text("localPairing.codeLabel").orEmpty(),
        placeholder = lines.text("localPairing.codePlaceholder"),
        enabled = !joining,
        error = if (invalid) message else null,
        supporting = listOfNotNull(
            message.takeIf { !invalid },
            lines.text("localPairing.triesLeft").takeIf { !joining },
        ),
        focusRequester = focus,
        monospace = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { actions.pair() }),
    )
    if (joining) {
        Spacer(Modifier.height(PolarisSpace.medium))
        WaitRow(lines.text("a11y.busy").orEmpty())
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    Shares(lines, ui.categories, labels)
    Spacer(Modifier.height(24.dp))
    val dim = !joining && "localPairing.pair" in disabled
    val reason = message
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.alpha(if (dim) 0.5f else 1f).semantics { if (dim && reason != null) stateDescription = reason }) {
            PolarisPrimaryButton(button("localPairing.pair"), { if (!joining) actions.pair() })
        }
        Spacer(Modifier.height(PolarisSpace.controls))
        if (joining) {
            PolarisSecondaryButton(button("common.cancel"), actions.cancel)
        } else {
            PolarisTextButton(button("localPairing.toShow"), actions.toShow)
            PolarisTextButton(button("common.back"), actions.back)
        }
    }
}

// ── Confirm and paired ───────────────────────────────────────────────────────────────────────────

@Composable
private fun ColumnScope.Confirm(
    ui: PolarisLocalPairingUi,
    lines: KitLines,
    button: (String) -> String,
    actions: PolarisLocalPairingActions,
    armed: Boolean,
    labels: Map<String, String>,
) {
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(lines.text("localPairing.confirmBody").orEmpty(), textAlign = TextAlign.Start)
    Spacer(Modifier.height(PolarisSpace.medium))
    Shares(lines, ui.categories, labels)
    Spacer(Modifier.height(polarisWindow.section))
    val busy = ui.busy
    // The first focus is the safe verb, never Pair: a stray Enter or D-pad press never pairs.
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.alpha(if (busy == "not-now") 0.5f else 1f)) {
            PolarisPrimaryButton(button("localPairing.pair"), { if (armed && busy == null) actions.confirm() })
        }
        Spacer(Modifier.height(PolarisSpace.controls))
        Box(Modifier.alpha(if (busy == "pair") 0.5f else 1f)) {
            PolarisSecondaryButton(button("common.notNow"), { if (armed && busy == null) actions.notNow() }, initialFocus = true)
        }
        if (busy != null) {
            Spacer(Modifier.height(PolarisSpace.controls))
            WaitRow(lines.text("a11y.busy").orEmpty())
        }
    }
}

@Composable
private fun ColumnScope.Paired(ui: PolarisLocalPairingUi, lines: KitLines, button: (String) -> String, actions: PolarisLocalPairingActions) {
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisBody(lines.text("localPairing.pairedBody").orEmpty(), textAlign = TextAlign.Start)
    if (ui.cantConnect) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(
            lines.text("localPairing.cantConnectTitle").orEmpty(),
            lines.text("localPairing.cantConnectBody"),
            action = lines.text("localPairing.pairedDevices")?.let { it to actions.openPairedDevices },
        )
    }
    Spacer(Modifier.height(PolarisSpace.medium))
    PolarisTextField(
        value = ui.name,
        onValueChange = actions.setName,
        label = lines.text("localPairing.nameLabel").orEmpty(),
        error = if (ui.nameError) lines.text("devices.renameFailed") else null,
        supporting = listOfNotNull(lines.text("localPairing.nameHint").takeIf { !ui.nameError }),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { actions.done() }),
    )
    Spacer(Modifier.height(polarisWindow.section))
    ConnectActions(listOf(ConnectButton(button("common.done"), actions.done, primary = true, focus = true)))
}
