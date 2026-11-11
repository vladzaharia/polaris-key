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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

private val ROW_MIN = 56.dp
private val GLYPH = 24.dp
private const val MILLIS = 1000

@Composable
internal fun PairedRows(c: PairedCtx, rowFocus: MutableMap<String, FocusRequester>, nowMillis: Long) {
    val ui = c.ui
    val lines = c.lines
    val switches = KitLocal.showSwitchColumn(ui.devices.map { it.reachable })
    // At 8 on, a switch that is off waits: Up to 8 can connect.
    val atLimit = KitLocal.reachableFull(ui.devices.map { it.reachable })
    Column(Modifier.fillMaxWidth()) {
        if (switches) {
            Text(
                lines.text("pairedDevices.canConnect").orEmpty(),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(bottom = PolarisSpace.hairline).clearAndSetSemantics {},
                textAlign = TextAlign.End,
            )
        }
        ui.devices.forEachIndexed { index, device ->
            val focus = rowFocus.getOrPut(device.id) { FocusRequester() }
            PairedRow(
                PairedRowArgs(
                    device,
                    c,
                    if (!switches) {
                        SwitchColumn.Hidden
                    } else if (atLimit) {
                        SwitchColumn.Limited
                    } else {
                        SwitchColumn.Shown
                    },
                    focus,
                    nowMillis,
                ),
            )
            if (index < ui.devices.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

/** What a screen of paired devices draws from. */
internal class PairedCtx(val ui: PolarisPairedDevicesUi, val lines: KitLines, val actions: PolarisPairedDevicesActions)

/** The Can connect column: not shown, shown, or shown with the off switches waiting (8 are on). */
internal enum class SwitchColumn { Hidden, Shown, Limited }

internal class PairedRowArgs(
    val device: PolarisPairedDevice,
    val c: PairedCtx,
    val column: SwitchColumn,
    val focus: FocusRequester,
    val nowMillis: Long,
)

@Composable
private fun PairedRow(a: PairedRowArgs) {
    val ui = a.c.ui
    val editing = ui.target == a.device.id
    val name = a.device.label?.takeIf { it.isNotBlank() } ?: PolarisTheme.copy.deviceUnnamed
    Column(Modifier.fillMaxWidth().padding(vertical = PolarisSpace.tight)) {
        when {
            editing && ui.step == "renaming" -> PairedRename(a.c)
            editing && ui.step == "forgetting" -> PairedForget(a.c)
            else -> PairedRowLine(a, KitConnect.isolate(name))
        }
    }
}

@Composable
private fun PairedRowLine(a: PairedRowArgs, isolated: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = ROW_MIN), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            deviceGlyph(a.device.platform).icon(),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(GLYPH),
        )
        Column(Modifier.weight(1f).padding(horizontal = PolarisSpace.controls)) {
            Text(isolated, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
            a.device.lastSeen?.let { seen ->
                val ago = PolarisTheme.copy.ago(((a.nowMillis - seen * MILLIS) / MILLIS).coerceAtLeast(0))
                val line = a.c.lines.format("pairedDevices.lastSeen", mapOf("when" to CopyArgument.Text(ago)))
                Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (a.column != SwitchColumn.Hidden) {
            val label = a.c.lines.format("a11y.letConnect", mapOf("device" to CopyArgument.Text(isolated)))
            Switch(
                checked = a.device.reachable,
                onCheckedChange = { a.c.actions.setReachable(a.device.id, it) },
                enabled = a.device.reachable || !(a.column == SwitchColumn.Limited),
                modifier = Modifier.semantics { contentDescription = label },
            )
        }
        PairedMenu(a.device, isolated, a.c, a.focus)
    }
}

@Composable
private fun PairedMenu(device: PolarisPairedDevice, isolated: String, c: PairedCtx, focus: FocusRequester) {
    val lines = c.lines
    val actions = c.actions
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
private fun PairedRename(c: PairedCtx) {
    val ui = c.ui
    val lines = c.lines
    val actions = c.actions
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val message = listOf("pairedDevices.renameLong", "pairedDevices.renameEmpty", "devices.renameFailed").firstNotNullOfOrNull(lines::text)
    PolarisTextField(
        value = ui.draft,
        onValueChange = actions::setDraft,
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
            ConnectButton(PolarisTheme.copy.deviceSave, actions::saveRename, primary = true),
            ConnectButton(PolarisTheme.copy.cancel, actions::cancelEdit),
        ),
    )
}

@Composable
private fun PairedForget(c: PairedCtx) {
    val ui = c.ui
    val lines = c.lines
    val actions = c.actions
    PairNotice(lines.text("pairedDevices.forgetConfirm").orEmpty(), lines.text("pairedDevices.forgetBody"))
    if (ui.forgetError) {
        Spacer(Modifier.height(PolarisSpace.controls))
        Box(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) { ConnectNotice(lines.text("pairedDevices.forgetFailed").orEmpty()) }
    }
    Spacer(Modifier.height(PolarisSpace.controls))
    PolarisActionGroup(row = true, visualOrder = polarisWindow.isMac) {
        val forget = lines.text("pairedDevices.forget").orEmpty()
        val cancel = PolarisTheme.copy.cancel
        if (polarisWindow.isMac) {
            PolarisSecondaryButton(cancel, actions::cancelEdit, initialFocus = true)
            PolarisPrimaryButton(forget, actions::confirmForget, danger = true)
        } else {
            PolarisPrimaryButton(forget, actions::confirmForget, danger = true)
            PolarisSecondaryButton(cancel, actions::cancelEdit, initialFocus = true)
        }
    }
}
