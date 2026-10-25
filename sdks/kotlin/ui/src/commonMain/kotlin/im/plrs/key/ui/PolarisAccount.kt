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
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
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

/** The gap between the rows of a connected group. */
private val ConnectedGap = 2.dp

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
    onManageLicense: (() -> Unit)? = null,
    onSignOut: (() -> Unit)? = null,
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
        onManageLicense = onManageLicense,
        onSignOut = onSignOut,
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
    onManageLicense: (() -> Unit)? = null,
    onSignOut: (() -> Unit)? = null,
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
        val detailTitle = detailPaneTitle(open, copy, channelTitle)
        val manageLabel = KitCopy.bundled.format("menu.manageLicense", kitLocale())
        val signOutLabel = KitCopy.bundled.format("common.signOut", kitLocale())
        val list: @Composable () -> Unit = {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = PolarisSpace.group)) {
                navigationIcon?.let {
                    it()
                    Spacer(Modifier.height(PolarisSpace.tight))
                }
                CompositionLocalProvider(LocalPolarisTextAlign provides TextAlign.Start) { PolarisTitle(accountTitle) }
                Spacer(Modifier.height(window.section))
                AccountHeaderCard(settingsUi.license)
                Spacer(Modifier.height(PolarisSpace.controls))
                // One connected group: the outer corners round, the inner ones square, a 2 dp gap between.
                val rows = buildList<@Composable (Shape) -> Unit> {
                    for (entry in entries) {
                        add { shape ->
                            AccountListItem(
                                title = if (entry == AccountItem.Settings) copy.settingsTitle else if (entry == AccountItem.Channel) channelRowTitle else copy.devicesTitle,
                                supporting = if (entry == AccountItem.Devices) copy.devicesSubtitle else if (entry == AccountItem.Channel) channelUi?.let { channelLabel(it.current, it.labels) } else null,
                                icon = if (entry == AccountItem.Settings) PolarisSymbols.Tune else if (entry == AccountItem.Channel) PolarisSymbols.Refresh else PolarisSymbols.Devices,
                                chevron = !split,
                                selected = split && open == entry,
                                shape = shape,
                                onClick = { chosen = entry.name },
                            )
                        }
                    }
                    if (onManageLicense != null) add { shape -> AccountListItem(manageLabel, null, PolarisSymbols.OpenInNew, chevron = false, selected = false, shape = shape, onClick = onManageLicense) }
                }
                Column(verticalArrangement = Arrangement.spacedBy(ConnectedGap)) {
                    rows.forEachIndexed { i, row -> row(polarisConnectedShape(i, rows.size, PolarisTheme.cardShape)) }
                }
                if (onSignOut != null) {
                    Spacer(Modifier.height(PolarisSpace.controls))
                    AccountListItem(signOutLabel, null, PolarisSymbols.Logout, chevron = false, selected = false, shape = PolarisTheme.cardShape, tint = PolarisTheme.status.danger, onClick = onSignOut)
                }
            }
        }
        val detail: @Composable () -> Unit = {
            // A phone's item is the whole screen: it keeps the window's margin, and a kit Back above the title when the host has one.
            val itemBack: (@Composable () -> Unit)? = if (!split && navigationIcon != null) {
                { PolarisBackArrow { chosen = null } }
            } else {
                null
            }
            CompositionLocalProvider(
                LocalPolarisEmbedded provides true,
                LocalPolarisArtInPane provides true,
                LocalPolarisEmbeddedInset provides (if (split) PolarisSpace.gutter else window.horizontalPadding),
            ) {
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
                        navigationIcon = itemBack,
                    )
                    AccountItem.Channel -> ChannelPane(channelUi, onChannel, channelError, itemBack)
                    AccountItem.Devices -> PolarisDevicesScreen(
                        devicesUi,
                        onRename = onRename,
                        onDeauthorize = onDeauthorize,
                        onRetry = onRetryDevices,
                        onDismissError = onDismissDeviceError,
                        navigationIcon = itemBack,
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
            // The list is capped at 560 dp (a phone in landscape); an item pane insets itself.
            Box(Modifier.fillMaxSize().then(back).then(if (open == null) Modifier.padding(horizontal = window.horizontalPadding) else Modifier)) {
                if (open == null) Box(Modifier.widthIn(max = 560.dp)) { list() } else detail()
            }
        }
    }
}

private fun detailPaneTitle(open: AccountItem?, copy: PolarisCopy, channelTitle: String): String =
    if (open == AccountItem.Devices) copy.devicesTitle else if (open == AccountItem.Channel) channelTitle else copy.settingsTitle

/** The channel row's end pane: the picker alone, scrolling with the pane. */
@Composable
private fun ChannelPane(channel: PolarisChannelUi?, onChannel: ((String) -> Unit)?, error: String?, navigationIcon: (@Composable () -> Unit)?) {
    if (channel == null) return
    // The same inset as the Settings and Devices panes beside it.
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LocalPolarisEmbeddedInset.current, vertical = polarisWindow.section)) {
        navigationIcon?.let {
            it()
            Spacer(Modifier.height(PolarisSpace.tight))
        }
        PolarisChannelPicker(channel, onSelect = onChannel, error = error)
    }
}

/** The account's header card: the product's icon and name, the licence status and its holder. */
@Composable
private fun AccountHeaderCard(license: PolarisLicenseSummary?) {
    val copy = PolarisTheme.copy
    val name = productName(copy)
    if (name == null && license == null) return
    val support = listOfNotNull(license?.let { copy.entitlementLabel(it.status) }, license?.holder?.takeIf { it.isNotBlank() }).joinToString(" \u2022 ")
    Row(
        Modifier
            .fillMaxWidth()
            .clip(PolarisTheme.cardShape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .padding(PolarisSpace.group)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PolarisProductIcon(64.dp, name = name)
        Column(Modifier.weight(1f)) {
            if (name != null) Text(name, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
            if (support.isNotEmpty()) Text(support, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The kit's Back above an item pane: returns to the account list. */
@Composable
internal fun PolarisBackArrow(onBack: () -> Unit) {
    PolarisIconButton(onClick = onBack) {
        Icon(PolarisSymbols.ArrowBack, contentDescription = KitCopy.bundled.format("common.back", kitLocale()), tint = MaterialTheme.colorScheme.onSurface)
    }
}

/** One row of the account list: a 64 dp target with its icon, the chosen one on the accent's subtle fill. */
@Composable
private fun AccountListItem(
    title: String,
    supporting: String?,
    icon: ImageVector,
    chevron: Boolean,
    selected: Boolean,
    shape: Shape,
    onClick: () -> Unit,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    val fill = if (selected) MaterialTheme.colorScheme.surfaceContainerHighest else MaterialTheme.colorScheme.surfaceContainerLow
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(fill)
            .heightIn(min = 64.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = PolarisSpace.group, vertical = PolarisSpace.controls),
        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.group),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (tint == MaterialTheme.colorScheme.onSurface) MaterialTheme.colorScheme.onSurfaceVariant else tint, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = tint)
            if (supporting != null) {
                Text(supporting, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (chevron) Icon(PolarisSymbols.ChevronEnd, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
    }
}
