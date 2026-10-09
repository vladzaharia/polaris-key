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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import im.plrs.key.sdk.DeviceInfo
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ── State ────────────────────────────────────────────────────────────────────────────────────

public data class PolarisDevicesUi(
    val loading: Boolean = true,
    val devices: List<DeviceInfo> = emptyList(),
    /** The list could not be read. */
    val error: Boolean = false,
    /** The device an action is running on. */
    val busyId: String? = null,
    /** Epoch milliseconds, for "last checked … ago". */
    val nowMillis: Long = 0,
    /** The last rename or removal the SDK refused; it survives the reload that follows. */
    val actionError: PolarisDeviceActionError? = null,
)

/** A device action the SDK refused, named for the device (and, for a rename, the typed name). */
public sealed interface PolarisDeviceActionError {
    public val deviceId: String

    public data class Rename(override val deviceId: String, val label: String) : PolarisDeviceActionError

    public data class SignOut(override val deviceId: String) : PolarisDeviceActionError
}

/** The SDK calls the devices screen makes. [PolarisKeyClient.devicesActions] adapts the umbrella client. */
public interface PolarisDevicesActions {
    public suspend fun list(): List<DeviceInfo>
    public suspend fun rename(deviceId: String, label: String?)
    public suspend fun deauthorize(deviceId: String)
}

public fun PolarisKeyClient.devicesActions(): PolarisDevicesActions {
    val client = this
    return object : PolarisDevicesActions {
        override suspend fun list(): List<DeviceInfo> = client.listDevices()
        override suspend fun rename(deviceId: String, label: String?): Unit = client.renameDevice(deviceId, label)
        override suspend fun deauthorize(deviceId: String): Unit = client.deauthorizeDevice(deviceId)
    }
}

/** The devices state holder. */
public class PolarisDevicesState(
    private val actions: PolarisDevicesActions,
    private val scope: CoroutineScope,
    private val clockMillis: () -> Long = { System.currentTimeMillis() },
) {
    private val _ui = MutableStateFlow(PolarisDevicesUi(nowMillis = clockMillis()))
    public val ui: StateFlow<PolarisDevicesUi> = _ui.asStateFlow()

    public fun load() {
        scope.launch { reload() }
    }

    private suspend fun reload() {
        _ui.update { it.copy(loading = it.devices.isEmpty() && it.actionError == null) }
        val devices = guarded { actions.list() }
        _ui.update {
            if (devices == null) it.copy(loading = false, error = true, busyId = null, nowMillis = clockMillis())
            else PolarisDevicesUi(loading = false, devices = sortDevices(devices), nowMillis = clockMillis(), actionError = it.actionError)
        }
    }

    public fun rename(deviceId: String, label: String) {
        run(deviceId, PolarisDeviceActionError.Rename(deviceId, label)) { actions.rename(deviceId, label.trim().ifEmpty { null }) }
    }

    public fun deauthorize(deviceId: String) {
        run(deviceId, PolarisDeviceActionError.SignOut(deviceId)) { actions.deauthorize(deviceId) }
    }

    /** The player dismissed the refusal (closed the reopened rename, or acknowledged it). */
    public fun dismissActionError() {
        _ui.update { it.copy(actionError = null) }
    }

    private fun run(deviceId: String, failure: PolarisDeviceActionError, action: suspend () -> Unit) {
        if (_ui.value.busyId != null) return
        scope.launch {
            _ui.update { it.copy(busyId = deviceId, actionError = null) }
            val ok = guarded { action() } != null
            _ui.update { it.copy(actionError = if (ok) null else failure) }
            reload()
        }
    }

    private suspend fun <T> guarded(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

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

/** This device first, then by label, then by id. */
public fun sortDevices(devices: List<DeviceInfo>): List<DeviceInfo> =
    devices.sortedWith(compareByDescending<DeviceInfo> { it.current }.thenBy { it.label?.lowercase() ?: "￿" }.thenBy { it.id })

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
 * The stateless devices screen, with its rename dialog and its removal confirm: a list screen,
 * top-anchored under a start-aligned title. A refused rename or removal shows at the top of the
 * list, named for its device, and a refused rename reopens its dialog with the typed name.
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
    PolarisScaffold(modifier = modifier, anchor = PolarisAnchor.Top, contentAlign = TextAlign.Start, navigationIcon = navigationIcon) {
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
                    onRename = { renaming = device.id },
                    onDeauthorize = { removing = device.id },
                )
            }
        }
    }
    // A refused rename reopens its dialog with what the player typed.
    val reopened = (failed as? PolarisDeviceActionError.Rename)?.takeIf { renaming == null && ui.busyId == null }
    val renameId = renaming ?: reopened?.deviceId
    ui.devices.firstOrNull { it.id == renameId }?.let { device ->
        PolarisRenameDialog(
            current = device.label.orEmpty(),
            initial = reopened?.label ?: device.label.orEmpty(),
            onDismiss = {
                renaming = null
                if (reopened != null) onDismissError()
            },
            onSave = {
                renaming = null
                onRename(device.id, it)
            },
        )
    }
    ui.devices.firstOrNull { it.id == removing }?.let { device ->
        AlertDialog(
            onDismissRequest = { removing = null },
            text = { Text(copy.format(copy.deviceRemoveConfirm, copy.deviceName(device), copy.productName)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        removing = null
                        onDeauthorize(device.id)
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = PolarisTheme.status.danger),
                ) { Text(copy.deviceDeauthorize) }
            },
            dismissButton = { PolarisTextButton(copy.cancel, onClick = { removing = null }) },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PolarisDeviceRow(device: DeviceInfo, nowMillis: Long, busy: Boolean, onRename: () -> Unit, onDeauthorize: () -> Unit) {
    val copy = PolarisTheme.copy
    val name = copy.deviceName(device)
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
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
                    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer) {
                        Text(copy.deviceThis, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
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
        val tint = MaterialTheme.colorScheme.onSurfaceVariant
        PolarisIconButton(onClick = onRename, enabled = !busy) {
            Icon(Icons.Filled.Edit, contentDescription = copy.format(copy.deviceRenameDescription, name), tint = tint)
        }
        PolarisIconButton(onClick = onDeauthorize, enabled = !busy) {
            Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = copy.format(copy.deviceDeauthorizeDescription, name), tint = tint)
        }
    }
}

/** An icon button with a full 48 dp target and the kit's focus ring. */
@Composable
internal fun PolarisIconButton(onClick: () -> Unit, enabled: Boolean = true, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    IconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interaction,
        modifier = Modifier.polarisFocusIndication(interaction, CircleShape).size(PolarisMinTouchTarget),
        content = content,
    )
}

/**
 * The rename dialog: the field takes focus when it opens, Done saves, and Save waits for a change
 * from the [current] name. [initial] is what the field starts with (a refused rename's text).
 */
@Composable
internal fun PolarisRenameDialog(current: String, initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    val copy = PolarisTheme.copy
    var text by remember(initial) { mutableStateOf(initial) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val changed = text.trim() != current.trim()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(copy.deviceRenameTitle) },
        text = {
            PolarisTextField(
                value = text,
                onValueChange = { text = it.take(64) },
                label = copy.deviceRenameLabel,
                focusRequester = focus,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (changed) onSave(text) }),
            )
        },
        confirmButton = { PolarisTextButton(copy.deviceSave, onClick = { onSave(text) }, enabled = changed) },
        dismissButton = { PolarisTextButton(copy.cancel, onClick = onDismiss) },
    )
}
