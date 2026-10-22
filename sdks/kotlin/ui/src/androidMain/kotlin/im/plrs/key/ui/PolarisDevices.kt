// The devices screen: the licence's devices (this one marked), each renameable and each able to be
// signed out (deauthorised) after a confirmation. The roster and both actions are the SDK's
// (PolarisKeyClient.listDevices, renameDevice, deauthorizeDevice); the kit renders and confirms.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import im.plrs.key.sdk.DeviceInfo


/**
 * A device glyph (the Material "Smartphone" icon's outline, Apache License 2.0), which the core
 * icon set does not carry.
 */
internal val DeviceIcon: ImageVector by lazy {
    ImageVector.Builder("PolarisDevice", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = PathParser()
            .parsePathString("M17,1.01L7,1C5.9,1 5,1.9 5,3v18c0,1.1 0.9,2 2,2h10c1.1,0 2,-0.9 2,-2V3c0,-1.1 -0.9,-1.99 -2,-1.99zM17,19H7V5h10v14z")
            .toNodes(),
        fill = SolidColor(androidx.compose.ui.graphics.Color.Black), // polaris-lint: allow-colour (an icon mask; Icon() tints it)
    ).build()
}


/** Material's "content paste" glyph: the key field's paste control. */
internal val PolarisPasteIcon: ImageVector by lazy {
    ImageVector.Builder("PolarisPaste", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = PathParser()
            .parsePathString("M19,2h-4.18C14.4,0.84 13.3,0 12,0c-1.3,0 -2.4,0.84 -2.82,2L5,2c-1.1,0 -2,0.9 -2,2v16c0,1.1 0.9,2 2,2h14c1.1,0 2,-0.9 2,-2L21,4c0,-1.1 -0.9,-2 -2,-2zM12,2c0.55,0 1,0.45 1,1s-0.45,1 -1,1 -1,-0.45 -1,-1 0.45,-1 1,-1zM19,20L5,20L5,4h2v3h10L17,4h2v16z")
            .toNodes(),
        fill = SolidColor(androidx.compose.ui.graphics.Color.Black), // polaris-lint: allow-colour (an icon mask; Icon() tints it)
    ).build()
}

/** A device's display name. */
public fun PolarisCopy.deviceName(device: DeviceInfo): String = device.label?.takeIf { it.isNotBlank() } ?: deviceUnnamed

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/** @param navigationIcon an optional control above the title (a Back for the host's navigation). */
@Composable
public fun PolarisDevices(state: PolarisDevicesState, modifier: Modifier = Modifier, navigationIcon: (@Composable () -> Unit)? = null) {
    val ui by state.ui.collectAsState()
    androidx.compose.runtime.LaunchedEffect(state) { state.load() }
    PolarisDevicesScreen(
        ui,
        modifier,
        onRename = state::rename,
        onDeauthorize = state::deauthorize,
        onRetry = state::load,
        onDismissError = state::dismissActionError,
        navigationIcon = navigationIcon,
    )
}

/**
 * The stateless devices screen: a list screen, top-anchored under the product header and a
 * start-aligned title. Rename and Remove happen in the row itself (UI-KITS.md 4.1 Devices: rename
 * inline, not an always-open form, and an inline confirm for Remove; never a stock dialog, 1.5 rule
 * 3). A refused rename or removal shows at the top of the list, named for its device, and a refused
 * rename reopens its row with the typed name.
 */
@Composable
public fun PolarisDevicesScreen(
    ui: PolarisDevicesUi,
    modifier: Modifier = Modifier,
    onRename: (String, String) -> Unit = { _, _ -> },
    onDeauthorize: (String) -> Unit = {},
    onRetry: () -> Unit = {},
    onDismissError: () -> Unit = {},
    navigationIcon: (@Composable () -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    if (ui.loading) {
        PolarisProgressScreen(copy.loading, modifier)
        return
    }
    var renaming by rememberSaveable { mutableStateOf<String?>(null) }
    var removing by rememberSaveable { mutableStateOf<String?>(null) }
    val failed = ui.actionError
    // A refused rename reopens its row with what the player typed.
    val reopened = (failed as? PolarisDeviceActionError.Rename)?.takeIf { renaming == null && ui.busyId == null }
    val renameId = renaming ?: reopened?.deviceId
    PolarisScaffold(modifier = modifier, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start, navigationIcon = navigationIcon) {
        PolarisProductHeader()
        PolarisTitle(copy.devicesTitle)
        Spacer(Modifier.height(PolarisSpace.tight))
        PolarisBody(copy.devicesSubtitle)
        Spacer(Modifier.height(polarisWindow.section))
        if (ui.error) {
            // One notice and one way on; the empty card stays hidden.
            PolarisInlineNotice(copy.devicesError)
            Spacer(Modifier.height(PolarisSpace.controls))
            PolarisSecondaryButton(copy.retry, onRetry)
            if (ui.devices.isEmpty()) return@PolarisScaffold
            Spacer(Modifier.height(PolarisSpace.group))
        }
        if (failed != null) {
            val device = ui.devices.firstOrNull { it.id == failed.deviceId }
            val name = device?.let { copy.deviceName(it) } ?: copy.deviceUnnamed
            val text = when (failed) {
                is PolarisDeviceActionError.Rename -> copy.format(copy.devicesRenameFailed, name)
                is PolarisDeviceActionError.SignOut -> copy.format(copy.devicesRemoveFailed, name)
            }
            PolarisInlineNotice(text)
            Spacer(Modifier.height(PolarisSpace.controls))
        }
        PolarisSection(title = null) {
            if (ui.devices.isEmpty()) {
                Text(
                    copy.devicesEmpty,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
            ui.devices.forEachIndexed { i, device ->
                // Inset on both sides: past the glyph at the start, short of the card's edge at the end.
                if (i > 0) HorizontalDivider(Modifier.padding(start = 72.dp, end = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                PolarisDeviceRow(
                    device = device,
                    nowMillis = ui.nowMillis,
                    busy = ui.busyId == device.id,
                    mode = when (device.id) {
                        renameId -> DeviceRowMode.Renaming(reopened?.takeIf { it.deviceId == device.id }?.label ?: device.label.orEmpty())
                        removing -> DeviceRowMode.Confirming
                        else -> DeviceRowMode.Idle
                    },
                    onRename = { renaming = device.id },
                    onDeauthorize = { removing = device.id },
                    onSave = {
                        renaming = null
                        onRename(device.id, it)
                    },
                    onRemove = {
                        removing = null
                        onDeauthorize(device.id)
                    },
                    onCancel = {
                        if (renameId == device.id && reopened != null) onDismissError()
                        renaming = null
                        removing = null
                    },
                )
            }
        }
    }
}

/** What a device row is doing: showing the device, editing its name, or asking before it is removed. */
internal sealed interface DeviceRowMode {
    data object Idle : DeviceRowMode

    /** Editing, starting from [text] (the current name, or a refused rename's text). */
    data class Renaming(val text: String) : DeviceRowMode

    data object Confirming : DeviceRowMode
}

/** "This phone", "This tablet" or "This TV" by what the screen is (part.thisDeviceTitle), or the host's own line. */
@Composable
internal fun thisDeviceLabel(): String {
    val copy = PolarisTheme.copy
    if (copy.deviceThis != PolarisCopy().deviceThis) return copy.deviceThis
    val tv = isTelevision()
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.smallestScreenWidthDp >= 600
    val formFactor = when {
        tv -> "tv"
        wide -> "tablet"
        else -> "phone"
    }
    return KitCopy.bundled.format("part.thisDeviceTitle", kitLocale(), mapOf("formFactor" to CopyArgument.Text(formFactor)))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PolarisDeviceRow(
    device: DeviceInfo,
    nowMillis: Long,
    busy: Boolean,
    mode: DeviceRowMode = DeviceRowMode.Idle,
    onRename: () -> Unit,
    onDeauthorize: () -> Unit,
    onSave: (String) -> Unit = {},
    onRemove: () -> Unit = {},
    onCancel: () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    val name = copy.deviceName(device)
    val renameButton = remember { FocusRequester() }
    // After an edit or a confirm closes, focus returns to the row's own control (DL9), never the page.
    var wasOpen by remember { mutableStateOf(false) }
    val open = mode != DeviceRowMode.Idle
    LaunchedEffect(open) {
        if (wasOpen && !open) runCatching { renameButton.requestFocus() }
        wasOpen = open
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            // 64 dp rows (UI-KITS.md 4.3 DeviceLimit list measure).
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The glyph (by form factor once DeviceInfo carries one; the phone until then) on the
            // highest container, in the strongest text colour, so it clears 3:1 in both themes.
            Surface(
                Modifier.size(40.dp),
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surfaceContainerHighest,
                contentColor = MaterialTheme.colorScheme.onSurface,
            ) {
                androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) {
                    Icon(DeviceIcon, contentDescription = null, modifier = Modifier.size(20.dp))
                }
            }
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                    Text(name, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
                    if (device.current) {
                        // A quiet neutral tag, not an accent chip (UI-KITS.md 4.3 DeviceLimit `k-tag`).
                        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface) {
                            Text(thisDeviceLabel(), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                        }
                    }
                }
                device.lastVerifiedAt?.let { at ->
                    Text(
                        copy.format(copy.deviceLastVerified, copy.ago(((nowMillis - at) / 1000).coerceAtLeast(0))),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (!open) {
                val tint = MaterialTheme.colorScheme.onSurfaceVariant
                PolarisIconButton(onClick = onRename, enabled = !busy, modifier = Modifier.focusRequester(renameButton)) {
                    Icon(Icons.Filled.Edit, contentDescription = copy.format(copy.deviceRenameDescription, name), tint = tint)
                }
                PolarisIconButton(onClick = onDeauthorize, enabled = !busy) {
                    Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = copy.format(copy.deviceDeauthorizeDescription, name), tint = tint)
                }
            }
        }
        when (mode) {
            DeviceRowMode.Idle -> Unit
            is DeviceRowMode.Renaming -> PolarisRenameRow(initial = mode.text, current = device.label.orEmpty(), onSave = onSave, onCancel = onCancel)
            DeviceRowMode.Confirming -> PolarisRemoveConfirm(name = name, onRemove = onRemove, onCancel = onCancel)
        }
    }
}

/** An icon button with a full 48 dp target and the kit's focus ring. */
@Composable
internal fun PolarisIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    IconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, CircleShape).size(PolarisMinTouchTarget),
        content = content,
    )
}

/**
 * The inline rename: the name field under its row, focused when it opens, Done saves, Save waits for
 * a change from the [current] name, and Cancel puts the row back. [initial] is what the field starts
 * with (a refused rename's text). A refused name is announced under its row, by the screen's notice.
 */
@Composable
internal fun PolarisRenameRow(initial: String, current: String, onSave: (String) -> Unit, onCancel: () -> Unit) {
    val copy = PolarisTheme.copy
    var text by rememberSaveable(initial) { mutableStateOf(initial) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val changed = text.trim() != current.trim()
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
        PolarisTextField(
            value = text,
            onValueChange = { text = it.take(64) },
            label = copy.deviceRenameLabel,
            focusRequester = focus,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (changed) onSave(text) }),
        )
        Spacer(Modifier.height(PolarisSpace.controls))
        PolarisActionGroup(row = true) {
            PolarisPrimaryButton(copy.deviceSave, onClick = { onSave(text) }, enabled = changed)
            PolarisSecondaryButton(copy.cancel, onClick = onCancel)
        }
    }
}

/**
 * The inline Remove confirm under its row: the consequence in words ("Remove Work laptop? It signs
 * out of Diceroll."), then Remove and Cancel, so it is read before the button and never a second
 * dialog (UI-KITS.md 4.1 Devices, 1.5 rule 3). Announced when it opens.
 */
@Composable
internal fun PolarisRemoveConfirm(name: String, onRemove: () -> Unit, onCancel: () -> Unit) {
    val copy = PolarisTheme.copy
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
        PolarisInlineNotice(copy.format(copy.deviceRemoveConfirm, name, copy.productName))
        Spacer(Modifier.height(PolarisSpace.controls))
        PolarisActionGroup(row = true) {
            PolarisPrimaryButton(copy.deviceDeauthorize, onClick = onRemove, initialFocus = true)
            PolarisSecondaryButton(copy.cancel, onClick = onCancel)
        }
    }
}
