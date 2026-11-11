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

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Paired devices over [state]: it reads the list when this enters the composition and follows the SDK's changes until it leaves.
 * [onClose] runs for Done and Back; [onPair] opens Pair with a Code (the host's). [notice] is what the app's own connection to a device
 * answered; Try again on it runs [onRetryNotice].
 */
@Composable
public fun PolarisPairedDevices(state: PolarisPairedDevicesState, modifier: Modifier = Modifier, onClose: () -> Unit = {}, onPair: () -> Unit = {}) {
    val ui by state.ui.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(state) { state.start { reload -> scope.launch { reload() } } }
    DisposableEffect(state) { onDispose { state.stop() } }
    LaunchedEffect(ui.left) { if (ui.left) onClose() }
    LaunchedEffect(ui.pairAnother) { if (ui.pairAnother) onPair() }
    val actions = remember(state) {
        PolarisPairedDevicesActions(
            retry = { scope.launch { state.refresh() } },
            done = state::done,
            pair = state::requestPair,
            startRename = state::startRename,
            setDraft = state::setDraft,
            saveRename = { scope.launch { state.saveRename() } },
            askForget = state::askForget,
            confirmForget = { scope.launch { state.confirmForget() } },
            cancelEdit = state::cancelEdit,
            setReachable = { id, on -> scope.launch { state.setReachable(id, on) } },
            focusHandled = state::focusHandled,
        )
    }
    PolarisPairedDevicesScreen(ui, modifier, actions)
}

/** PairedDevices' states as the matrix resolves them, stateless over [ui] and its [actions]. */
@Composable
public fun PolarisPairedDevicesScreen(
    ui: PolarisPairedDevicesUi,
    modifier: Modifier = Modifier,
    actions: PolarisPairedDevicesActions = PolarisPairedDevicesActions(),
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
    /** The time "Last seen" counts back from; a test passes a fixed one. */
    nowMillis: Long = System.currentTimeMillis(),
) {
    val screen = remember(ui) { ui.screen() }
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val variant = polarisCopyVariant()

    fun button(key: String): String = catalog.format(key, locale, variant = variant)
    val announce = rememberPolarisAnnouncer()
    val full = "pairedDevices.pair" in screen.disabledKeys
    val titleFocus = remember { FocusRequester() }
    val rowFocus = remember { mutableMapOf<String, FocusRequester>() }
    // After an edit focus returns to the row's options button; after a Forget it moves to the next row or the title.
    LaunchedEffect(ui.focus) {
        when (val f = ui.focus) {
            is PolarisPairedFocus.Row -> rowFocus[f.id]?.let { runCatching { it.requestFocus() } }
            PolarisPairedFocus.Title -> runCatching { titleFocus.requestFocus() }
            null -> return@LaunchedEffect
        }
        actions.focusHandled()
    }
    // A host notice is told once, in a status region that is always in the list.
    LaunchedEffect(ui.notice) {
        val n = ui.notice ?: return@LaunchedEffect
        announce(
            when (n.kind) {
                "not-found" -> lines.text("pairedDevices.notFoundTitle")
                "busy" -> lines.text("pairedDevices.busyTitle")
                else -> lines.text("core.codes.link-unknown.title")
            }.orEmpty(),
        )
    }
    val host = modifier.then(
        PolarisBackHandler(enabled = true, onBack = if (ui.step == "renaming" || ui.step == "forgetting") actions.cancelEdit else actions.done),
    )
    PolarisScaffold(modifier = host, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start) {
        PolarisTitle(lines.text("pairedDevices.title").orEmpty(), Modifier.focusRequester(titleFocus).focusTarget(), key = screen.state)
        Spacer(Modifier.height(PolarisSpace.tight))
        when (screen.state) {
            "loading" -> {
                // Nothing is said about what is paired until the read answers.
                Spacer(Modifier.height(PolarisSpace.medium))
                PolarisWaitIndicator()
                Spacer(Modifier.height(PolarisSpace.controls))
                Text(lines.text("a11y.busy").orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(polarisWindow.section))
                ConnectActions(listOf(ConnectButton(button("common.done"), actions.done, primary = true)))
            }

            "load-failed" -> {
                ConnectNotice(lines.text("pairedDevices.loadFailed").orEmpty())
                Spacer(Modifier.height(polarisWindow.section))
                ConnectActions(
                    listOf(
                        ConnectButton(button("common.tryAgain"), actions.retry, primary = true, focus = true),
                        ConnectButton(button("common.done"), actions.done),
                    ),
                )
            }

            "empty" -> {
                PolarisBody(lines.text("pairedDevices.empty").orEmpty(), textAlign = TextAlign.Start)
                Spacer(Modifier.height(polarisWindow.section))
                ConnectActions(
                    listOf(
                        ConnectButton(button("pairedDevices.pair"), actions.pair, primary = true),
                        ConnectButton(button("common.done"), actions.done),
                    ),
                )
            }

            else -> {
                if (screen.state == "off") {
                    PairNotice(lines.text("core.codes.local-pairing-off.title").orEmpty(), lines.text("pairedDevices.offBody"))
                } else {
                    PolarisBody(lines.text("pairedDevices.lede").orEmpty(), textAlign = TextAlign.Start)
                    ListNotices(ui, lines, actions)
                }
                Spacer(Modifier.height(PolarisSpace.medium))
                Rows(ui, lines, actions, rowFocus, nowMillis)
                Spacer(Modifier.height(polarisWindow.section))
                val dim = full
                val primary = ConnectButton(button("pairedDevices.pair"), { if (!dim) actions.pair() }, primary = true)
                val done = ConnectButton(button("common.done"), actions.done)
                when (screen.state) {
                    "list" -> Box(Modifier.alpha(if (dim) 0.5f else 1f)) { ConnectActions(listOf(primary, done)) }
                    "off" -> ConnectActions(listOf(ConnectButton(button("common.done"), actions.done, primary = true)))
                    else -> ConnectActions(listOf(done))
                }
            }
        }
    }
}

@Composable
private fun ListNotices(ui: PolarisPairedDevicesUi, lines: KitLines, actions: PolarisPairedDevicesActions) {
    if (ui.step != "list") return
    val reachableFull = lines.text("pairedDevices.reachableFullTitle")
    if (reachableFull != null) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(reachableFull, lines.text("pairedDevices.reachableFullBody"))
    }
    val full = lines.text("core.codes.local-links-full.title")
    if (full != null) {
        Spacer(Modifier.height(PolarisSpace.medium))
        PairNotice(full, lines.text("pairedDevices.fullBody"))
    }
    val n = ui.notice ?: return
    Spacer(Modifier.height(PolarisSpace.medium))
    when (n.kind) {
        "not-found" -> PairNotice(lines.text("pairedDevices.notFoundTitle").orEmpty(), lines.text("pairedDevices.notFoundBody"))
        "busy" -> PairNotice(lines.text("pairedDevices.busyTitle").orEmpty(), null, lines.text("common.tryAgain")?.let { it to actions.retry })
        else -> PairNotice(lines.text("core.codes.link-unknown.title").orEmpty(), lines.text("core.codes.link-unknown.message"))
    }
}

@Composable
private fun Rows(
    ui: PolarisPairedDevicesUi,
    lines: KitLines,
    actions: PolarisPairedDevicesActions,
    rowFocus: MutableMap<String, FocusRequester>,
    nowMillis: Long,
) {
    val switches = KitLocal.showSwitchColumn(ui.devices.map { it.reachable })
    Column(Modifier.fillMaxWidth()) {
        if (switches) {
            Text(
                lines.text("pairedDevices.canConnect").orEmpty(),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp).clearAndSetSemantics {},
                textAlign = TextAlign.End,
            )
        }
        ui.devices.forEachIndexed { index, device ->
            Row(device, ui, lines, actions, switches, rowFocus.getOrPut(device.id) { FocusRequester() }, nowMillis)
            if (index < ui.devices.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable
private fun Row(
    device: PolarisPairedDevice,
    ui: PolarisPairedDevicesUi,
    lines: KitLines,
    actions: PolarisPairedDevicesActions,
    switches: Boolean,
    focus: FocusRequester,
    nowMillis: Long,
) {
    val editing = ui.target == device.id
    val name = device.label?.takeIf { it.isNotBlank() } ?: PolarisTheme.copy.deviceUnnamed
    val isolated = KitConnect.isolate(name)
    Column(Modifier.fillMaxWidth().padding(vertical = PolarisSpace.tight)) {
        when {
            editing && ui.step == "renaming" -> RenameField(ui, lines, actions)

            editing && ui.step == "forgetting" -> ForgetQuestion(ui, lines, actions)

            else -> Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    deviceGlyph(device.platform).icon(),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(24.dp),
                )
                Column(Modifier.weight(1f).padding(horizontal = PolarisSpace.controls)) {
                    Text(isolated, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
                    device.lastSeen?.let { seen ->
                        val ago = PolarisTheme.copy.ago(((nowMillis - seen * 1000) / 1000).coerceAtLeast(0))
                        val line = lines.format("pairedDevices.lastSeen", mapOf("when" to CopyArgument.Text(ago)))
                        Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (switches) {
                    val label = lines.format("a11y.letConnect", mapOf("device" to CopyArgument.Text(isolated)))
                    Switch(
                        checked = device.reachable,
                        onCheckedChange = { actions.setReachable(device.id, it) },
                        modifier = Modifier.semantics { contentDescription = label },
                    )
                }
                RowMenu(device, isolated, lines, actions, focus)
            }
        }
    }
}

@Composable
private fun RowMenu(device: PolarisPairedDevice, isolated: String, lines: KitLines, actions: PolarisPairedDevicesActions, focus: FocusRequester) {
    var open by remember { mutableStateOf(false) }
    val label = lines.format("a11y.deviceOptions", mapOf("device" to CopyArgument.Text(isolated)))
    Box {
        PolarisIconButton(onClick = { open = true }, modifier = Modifier.focusRequester(focus)) {
            Icon(PolarisSymbols.More, contentDescription = label)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(lines.text("devices.rename").orEmpty()) },
                onClick = {
                    open = false
                    actions.startRename(device.id)
                },
            )
            DropdownMenuItem(
                text = { Text(lines.text("pairedDevices.forget").orEmpty()) },
                onClick = {
                    open = false
                    actions.askForget(device.id)
                },
            )
        }
    }
}

@Composable
private fun RenameField(ui: PolarisPairedDevicesUi, lines: KitLines, actions: PolarisPairedDevicesActions) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val message = listOf("pairedDevices.renameLong", "pairedDevices.renameEmpty", "devices.renameFailed").firstNotNullOfOrNull(lines::text)
    PolarisTextField(
        value = ui.draft,
        onValueChange = actions.setDraft,
        label = lines.text("devices.renameLabel").orEmpty(),
        error = message,
        supporting = listOfNotNull(lines.text("localPairing.nameHint").takeIf { message == null }),
        focusRequester = focus,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { actions.saveRename() }),
    )
    Spacer(Modifier.height(PolarisSpace.controls))
    ConnectActions(
        listOf(
            ConnectButton(PolarisTheme.copy.deviceSave, actions.saveRename, primary = true),
            ConnectButton(PolarisTheme.copy.cancel, actions.cancelEdit),
        ),
    )
}

@Composable
private fun ForgetQuestion(ui: PolarisPairedDevicesUi, lines: KitLines, actions: PolarisPairedDevicesActions) {
    PairNotice(lines.text("pairedDevices.forgetConfirm").orEmpty(), lines.text("pairedDevices.forgetBody"))
    if (ui.forgetError) {
        Spacer(Modifier.height(PolarisSpace.controls))
        ConnectNotice(lines.text("pairedDevices.forgetFailed").orEmpty())
    }
    Spacer(Modifier.height(PolarisSpace.controls))
    PolarisActionGroup(row = true, visualOrder = polarisWindow.isMac) {
        val forget = lines.text("pairedDevices.forget").orEmpty()
        val cancel = PolarisTheme.copy.cancel
        if (polarisWindow.isMac) {
            PolarisSecondaryButton(cancel, actions.cancelEdit, initialFocus = true)
            PolarisPrimaryButton(forget, actions.confirmForget, danger = true)
        } else {
            PolarisPrimaryButton(forget, actions.confirmForget, danger = true)
            PolarisSecondaryButton(cancel, actions.cancelEdit, initialFocus = true)
        }
    }
}
