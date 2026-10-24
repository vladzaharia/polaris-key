// The account screen as a list-detail pair (UI-KITS.md DL1, the board's tablet): on a window 840 dp
// wide or more (and not short) the list sits in the start pane and the selected item in the end
// pane, on a sunken panel; on a phone it is the list, then the item, and Back (predictive on
// API 34+) returns from the item to the list. The items are the kit's own Settings and Devices
// screens, drawn as plain columns inside the pane.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import im.plrs.key.core.ErrorCode
import kotlinx.serialization.json.JsonElement

/** What the account list opens. */
internal enum class AccountItem { Settings, Channel, Devices }

/** The list pane's width on a tablet (the board's 412 dp). */
private val ListPaneWidth = 412.dp

/**
 * The account screen over the live state holders: [Settings] and [Devices] as list-detail.
 *
 * @param navigationIcon an optional control above the list (a Back for the host's navigation).
 */
@Composable
public fun PolarisAccount(
    settings: PolarisSettingsState,
    devices: PolarisDevicesState,
    modifier: Modifier = Modifier,
    entitlementLabel: (String) -> String? = { null },
    navigationIcon: (@Composable () -> Unit)? = null,
) {
    val settingsUi by settings.ui.collectAsState()
    val devicesUi by devices.ui.collectAsState()
    androidx.compose.runtime.LaunchedEffect(settings) { settings.load() }
    androidx.compose.runtime.LaunchedEffect(devices) { devices.load() }
    PolarisAccountScreen(
        settingsUi = settingsUi,
        devicesUi = devicesUi,
        modifier = modifier,
        entitlementLabel = entitlementLabel,
        navigationIcon = navigationIcon,
        onRetrySettings = settings::load,
        onSet = settings::set,
        onReset = settings::reset,
        onChannel = settings::setChannel,
        onRename = devices::rename,
        onDeauthorize = devices::deauthorize,
        onRetryDevices = devices::load,
        onDismissDeviceError = devices::dismissActionError,
    )
}

/** The stateless account screen. */
@Composable
public fun PolarisAccountScreen(
    settingsUi: PolarisSettingsUi,
    devicesUi: PolarisDevicesUi,
    modifier: Modifier = Modifier,
    entitlementLabel: (String) -> String? = { null },
    navigationIcon: (@Composable () -> Unit)? = null,
    onRetrySettings: () -> Unit = {},
    onSet: ((String, JsonElement) -> Unit)? = null,
    onReset: ((String) -> Unit)? = null,
    onChannel: ((String) -> Unit)? = null,
    onRename: (String, String) -> Unit = { _, _ -> },
    onDeauthorize: (String) -> Unit = {},
    onRetryDevices: () -> Unit = {},
    onDismissDeviceError: () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    val accountTitle = KitCopy.bundled.format("account.title", kitLocale())
    val channelTitle = KitCopy.bundled.format("channel.title", kitLocale())
    val channelRowTitle = KitCopy.bundled.format("account.channel", kitLocale())
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    PolarisSurface(modifier) { window, _ ->
        val split = window.wide
        // The channel row exists only where the picker would draw (Release on, a choice or a lock).
        val channelUi = settingsUi.channel?.takeIf { it.drawn }
        val entries = AccountItem.entries.filter { it != AccountItem.Channel || channelUi != null }
        val channelError = settingsUi.error?.takeIf { channelUi != null && it.code == ErrorCode.channelNotAllowed }?.let(copy::settingsFailureMessage)
        // Two panes always show an item; one pane shows the list until an item is chosen.
        val item = chosen?.let { runCatching { AccountItem.valueOf(it) }.getOrNull() }?.takeIf { it in entries }
        val open = item ?: if (split) AccountItem.Settings else null
        val back = PolarisBackHandler(enabled = !split && item != null) { chosen = null }
        val detailTitle = when (open) { AccountItem.Devices -> copy.devicesTitle; AccountItem.Channel -> channelTitle; else -> copy.settingsTitle }
        val list: @Composable () -> Unit = {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = PolarisSpace.group)) {
                navigationIcon?.let {
                    it()
                    Spacer(Modifier.height(PolarisSpace.tight))
                }
                PolarisProductHeader()
                CompositionLocalProvider(LocalPolarisTextAlign provides TextAlign.Start) { PolarisTitle(accountTitle) }
                Spacer(Modifier.height(window.section))
                Column(verticalArrangement = Arrangement.spacedBy(PolarisSpace.tight)) {
                    for (entry in entries) {
                        AccountListItem(
                            title = when (entry) {
                                AccountItem.Settings -> copy.settingsTitle
                                AccountItem.Channel -> channelRowTitle
                                AccountItem.Devices -> copy.devicesTitle
                            },
                            supporting = when (entry) {
                                AccountItem.Devices -> copy.devicesSubtitle
                                AccountItem.Channel -> channelUi?.let { channelLabel(it.current, it.labels) }
                                AccountItem.Settings -> null
                            },
                            selected = split && open == entry,
                            onClick = { chosen = entry.name },
                        )
                    }
                }
            }
        }
        val detail: @Composable () -> Unit = {
            CompositionLocalProvider(LocalPolarisEmbedded provides true, LocalPolarisArtInPane provides true) {
                when (open) {
                    AccountItem.Settings -> PolarisSettingsScreen(
                        // The channel has its own row, so its picker and its refusal leave this pane.
                        if (channelUi == null) settingsUi else settingsUi.copy(
                            channel = null,
                            error = settingsUi.error?.takeIf { it.code != ErrorCode.channelNotAllowed },
                        ),
                        entitlementLabel = entitlementLabel,
                        onRetry = onRetrySettings,
                        onSet = onSet,
                        onReset = onReset,
                        onChannel = onChannel,
                    )
                    AccountItem.Channel -> if (channelUi != null) {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(PolarisSpace.group)) {
                            PolarisChannelPicker(channelUi, onSelect = onChannel, error = channelError)
                        }
                    }
                    AccountItem.Devices -> PolarisDevicesScreen(
                        devicesUi,
                        onRename = onRename,
                        onDeauthorize = onDeauthorize,
                        onRetry = onRetryDevices,
                        onDismissError = onDismissDeviceError,
                    )
                    null -> Unit
                }
            }
        }
        if (split) {
            Row(
                modifier = Modifier.fillMaxSize().then(back).padding(horizontal = window.horizontalPadding, vertical = PolarisSpace.group),
                horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group),
            ) {
                Box(Modifier.widthIn(max = ListPaneWidth).weight(0.4f).fillMaxHeight().semantics { paneTitle = accountTitle }) { list() }
                Box(
                    Modifier
                        .weight(0.6f)
                        .fillMaxHeight()
                        .clip(PolarisTheme.cardShape)
                        .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                        .semantics { paneTitle = detailTitle },
                ) { detail() }
            }
        } else {
            Box(Modifier.fillMaxSize().then(back).padding(horizontal = window.horizontalPadding)) {
                if (open == null) list() else detail()
            }
        }
    }
}

/** One row of the account list: a 56 dp target, the chosen one on the accent's subtle fill. */
@Composable
private fun AccountListItem(title: String, supporting: String?, selected: Boolean, onClick: () -> Unit) {
    val shape = PolarisTheme.cardShape
    val fill = if (selected) MaterialTheme.colorScheme.surfaceContainerHighest else MaterialTheme.colorScheme.surfaceContainerLow
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(fill)
            .heightIn(min = 64.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = PolarisSpace.group, vertical = PolarisSpace.controls),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
        if (supporting != null) {
            Text(supporting, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
