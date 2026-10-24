// The kit's real desktop windows (UK-10.8, K3): ApplicationScope composables that open OS-framed windows,
// so the kit never draws a title bar or caption buttons.
//
//   - PolarisKeyWindow: the gate window. The app content shows once the licence allows it. Every close goes to
//     the host's onCloseRequest, which exits by default. A mandatory update is a dialog inside it, with no close.
//   - PolarisUpdateWindow: an optional update. One column, not resizable, sized to its content.
//   - PolarisSettingsWindow: 650 dp wide, the pane named in the title. Escape or the OS close button
//     closes it; there is no Done.
//   - PolarisMenuItems: the entries of Compose's MenuBar.
//
// Window contracts (recorded by UK-10.7 in PolarisMacChrome.kt):
//   - S6: the Mac sheet floats 52 dp down only under a full-size content view. PolarisKeyWindow builds a plain
//     frame by default and says so through LocalPolarisMacFullSizeContent (false); `fullSizeContent = true`
//     sets the AWT client properties and the local together, so the two never disagree.
//   - S7: the Mac window's minimumSize is 480 x 520 dp; an embedded host scrolls (PolarisMacFloor).
//   - The desktop Dialog scrim comes from polarisPromptDialogProperties.
//
// Heights: the update window packs to its content. The Settings window opens 650 x 600 and is resizable in
// height, because the kit's screens measure the window they are in and cannot report an intrinsic height.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.ApplicationScope
import androidx.compose.ui.window.MenuBar
import androidx.compose.ui.window.MenuBarScope
import androidx.compose.ui.window.MenuScope
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowState
import androidx.compose.ui.window.rememberWindowState
import im.plrs.key.core.BootOptions
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.Dimension

/** The Settings window's width. */
internal val SettingsWindowWidth = 650.dp

/** The Settings window's opening height (it is resizable in height). */
internal val SettingsWindowHeight = 600.dp

/** The update window's column width. */
internal val UpdateWindowWidth = 440.dp

/** The Mac window's minimum size (S7): the floor [PolarisMacFloor] lays out at. */
internal val MacWindowMinimum: Dimension
    get() = Dimension(PolarisMac.floorWidth.value.toInt(), PolarisMac.floorHeight.value.toInt())

private fun androidx.compose.ui.input.key.KeyEvent.isEscapeDown(): Boolean = type == KeyEventType.KeyDown && key == Key.Escape

private val isMacHost: Boolean get() = autoPlatformVariant() == PolarisPlatformVariant.MacOS

/** The kit's theme and client around one window's content (each window is its own root for composition locals). */
@Composable
private fun PolarisWindowRoot(client: PolarisKeyClient, branding: PolarisBranding, fullSizeContent: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalPolarisKey provides client, LocalPolarisMacFullSizeContent provides fullSizeContent) {
        PolarisTheme(branding = branding) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background, content = content)
        }
    }
}

/**
 * The gate window: [PolarisKeyApp]'s boot and gate over [client], then [content]. Closing it, whatever the gate
 * shows, calls [onCloseRequest] (exit by default). An optional update opens [PolarisUpdateWindow]; a mandatory
 * one is a dialog inside this window with no close. "Manage license" opens [PolarisSettingsWindow].
 *
 * @param fullSizeContent draws the content under the macOS title bar (the Mac sheet then floats 52 dp down, else 12 dp).
 * @param onSignOut signs this device out after the person confirms; null hides Sign out everywhere.
 * @param menu the window's menu bar; the default is one menu named [title] holding [PolarisMenuItems]. Null has none.
 * @param onQuit the host's quit, called once a verified installer is open; exits by default.
 */
@Composable
public fun ApplicationScope.PolarisKeyWindow(
    client: PolarisKeyClient,
    onCloseRequest: () -> Unit = ::exitApplication,
    title: String = client.product,
    state: PolarisKeyWindowState = remember { PolarisKeyWindowState() },
    windowState: WindowState = rememberWindowState(size = DpSize(960.dp, 640.dp)),
    branding: PolarisBranding = PolarisBranding.PolarisKey,
    bootOptions: BootOptions = BootOptions(),
    onSignIn: (() -> Unit)? = null,
    packs: Boolean = client.packs.configured,
    signIn: Boolean = false,
    onQuit: (() -> Unit)? = ::exitApplication,
    onSignOut: (() -> Unit)? = null,
    fullSizeContent: Boolean = false,
    menu: (@Composable MenuBarScope.(PolarisKeyWindowState) -> Unit)? = { s ->
        Menu(title) {
            PolarisMenuItems(
                onCheckForUpdates = s::requestCheck,
                onManageLicense = s::manageLicense,
                onSignOut = if (onSignOut != null) s::requestSignOut else null,
            )
        }
    },
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val update = remember(client) { PolarisUpdateState() }
    val updateActions = remember(client) { client.updateActions() }
    val settings = remember(client) { PolarisSettingsState(client.settingsActions(editable = true), scope) }
    val devices = remember(client) { PolarisDevicesState(client.devicesActions(), scope) }
    state.checkAction = {
        scope.launch {
            state.checkForUpdates(update) { withContext(Dispatchers.IO) { client.update.decide() } }
            if (state.check == PolarisCheckStatus.Offered) update.loadFacts(client)
        }
    }

    Window(onCloseRequest = onCloseRequest, state = windowState, title = title) {
        val mac = isMacHost
        SideEffect {
            if (mac) {
                window.minimumSize = MacWindowMinimum
                if (fullSizeContent) {
                    window.rootPane.putClientProperty("apple.awt.fullWindowContent", true)
                    window.rootPane.putClientProperty("apple.awt.transparentTitleBar", true)
                }
            }
        }
        if (menu != null) MenuBar { menu(state) }
        PolarisWindowRoot(client, branding, fullSizeContent && mac) {
            PolarisKeyAppHost(
                client = client,
                modifier = Modifier,
                bootOptions = bootOptions,
                onSignIn = onSignIn,
                packs = packs,
                signIn = signIn,
                onQuit = onQuit,
                update = update,
                updateActions = updateActions,
                optionalUpdateInDialog = false,
            ) {
                Column {
                    val note = when (state.check) {
                        PolarisCheckStatus.UpToDate -> KitCopy.bundled.format("update.upToDate", kitLocale())
                        PolarisCheckStatus.Failed -> PolarisTheme.copy.updateFailed
                        else -> null
                    }
                    if (note != null) PolarisInfoBanner(note, onDismiss = state::dismissCheck)
                    content()
                }
            }
            if (state.askingSignOut && onSignOut != null) {
                PolarisSignOutQuestion(onConfirm = { state.confirmSignOut(onSignOut) }, onCancel = state::cancelSignOut)
            }
        }
    }
    PolarisUpdateWindow(client, update, onUpdate = { update.install(updateActions, scope, onQuit) }, branding = branding)
    PolarisSettingsWindow(
        client,
        state.settings,
        settings,
        devices,
        // The question is asked in the gate window; the Settings window's button raises it there.
        onSignOut = if (onSignOut != null) state::requestSignOut else null,
        branding = branding,
    )
}

/**
 * The window of an optional update: one column [UpdateWindowWidth] wide, not resizable, sized to its content.
 * Open while [update] holds an optional offer ([PolarisUpdateRoute.Window]). Later, Escape and the OS close button
 * all dismiss it for this run; Skip this version remembers the choice.
 */
@Composable
public fun ApplicationScope.PolarisUpdateWindow(
    client: PolarisKeyClient,
    update: PolarisUpdateState,
    onUpdate: () -> Unit,
    branding: PolarisBranding = PolarisBranding.PolarisKey,
    windowState: WindowState = rememberWindowState(size = DpSize.Unspecified),
) {
    val offer by update.offer.collectAsState()
    val ui = offer?.takeIf { updateRoute(it) == PolarisUpdateRoute.Window } ?: return
    val copy = remember { PolarisCopy().let { if (isMacHost) it.forMac() else it } }
    Window(
        onCloseRequest = update::dismiss,
        state = windowState,
        title = copy.updatePromptText(ui).first,
        resizable = false,
        onPreviewKeyEvent = {
            if (it.isEscapeDown()) {
                update.dismiss()
                true
            } else {
                false
            }
        },
    ) {
        PolarisWindowRoot(client, branding, fullSizeContent = false) {
            PolarisUpdateWindowContent(ui, onUpdate, onLater = update::dismiss, onSkip = update::skip)
        }
    }
}

/** The update column: the kit's update card at [UpdateWindowWidth], with no dialog, scrim or sheet around it. */
@Composable
internal fun PolarisUpdateWindowContent(ui: PolarisUpdateUi, onUpdate: () -> Unit, onLater: () -> Unit, onSkip: () -> Unit) {
    val window = remember { PolarisWindow(UpdateWindowWidth, 600.dp) }
    CompositionLocalProvider(LocalPolarisWindow provides window) {
        Box(Modifier.width(UpdateWindowWidth).padding(16.dp), contentAlignment = Alignment.TopCenter) {
            PolarisUpdatePromptCard(ui, Modifier, onUpdate, onLater, footer = false, onSkip = if (ui.mandatory) null else onSkip)
        }
    }
}

/** The title of the Settings window: the open pane's name. */
internal fun settingsWindowTitle(pane: PolarisSettingsPane, copy: PolarisCopy, locale: String): String = when (pane) {
    PolarisSettingsPane.Account -> KitCopy.bundled.format("menu.account", locale)
    PolarisSettingsPane.Devices -> copy.devicesTitle
}

/**
 * The Settings window: [SettingsWindowWidth] wide, open while [state] holds a pane, titled with that pane's name.
 * Escape or the OS close button closes it; there is no Done. [onSignOut], when given, shows Sign out in the
 * Account pane.
 */
@Composable
public fun ApplicationScope.PolarisSettingsWindow(
    client: PolarisKeyClient,
    state: PolarisSettingsWindowState,
    settings: PolarisSettingsState,
    devices: PolarisDevicesState,
    onSignOut: (() -> Unit)? = null,
    branding: PolarisBranding = PolarisBranding.PolarisKey,
    windowState: WindowState = rememberWindowState(size = DpSize(SettingsWindowWidth, SettingsWindowHeight)),
) {
    val pane = state.pane ?: return
    val copy = remember { PolarisCopy().let { if (isMacHost) it.forMac() else it } }
    Window(
        onCloseRequest = state::close,
        state = windowState,
        title = settingsWindowTitle(pane, copy, java.util.Locale.getDefault().toLanguageTag()),
        onPreviewKeyEvent = {
            if (it.isEscapeDown()) {
                state.close()
                true
            } else {
                false
            }
        },
    ) {
        SideEffect { window.minimumSize = Dimension(SettingsWindowWidth.value.toInt(), 360) }
        PolarisWindowRoot(client, branding, fullSizeContent = false) {
            PolarisSettingsWindowContent(pane, state::open, settings, devices, onSignOut)
        }
    }
}

/** The Settings window's pane switch and the open pane. */
@Composable
internal fun PolarisSettingsWindowContent(
    pane: PolarisSettingsPane,
    onPane: (PolarisSettingsPane) -> Unit,
    settings: PolarisSettingsState,
    devices: PolarisDevicesState,
    onSignOut: (() -> Unit)?,
) {
    val copy = PolarisTheme.copy
    val locale = kitLocale()
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (entry in PolarisSettingsPane.entries) {
                val selected = entry == pane
                TextButton(
                    onClick = { onPane(entry) },
                    modifier = Modifier.selectable(selected = selected, role = Role.Tab, onClick = { onPane(entry) }),
                ) {
                    Text(
                        settingsWindowTitle(entry, copy, locale),
                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        HorizontalDivider()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (pane) {
                PolarisSettingsPane.Account -> PolarisSettings(settings)
                PolarisSettingsPane.Devices -> PolarisDevices(devices)
            }
        }
        if (pane == PolarisSettingsPane.Account && onSignOut != null) {
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onSignOut) { Text(KitCopy.bundled.format("common.signOut", locale, variant = polarisCopyVariant())) }
            }
        }
    }
}

/** "Sign out of {product} on this device?" with Cancel and Sign out. */
@Composable
internal fun PolarisSignOutQuestion(onConfirm: () -> Unit, onCancel: () -> Unit) {
    val locale = kitLocale()
    val variant = polarisCopyVariant()
    val catalog = KitCopy.bundled
    val product = mapOf("product" to CopyArgument.Text(PolarisTheme.copy.productName))
    AlertDialog(
        onDismissRequest = onCancel,
        properties = polarisPromptDialogProperties(dismissible = true, scrim = true),
        title = { Text(catalog.format(if (variant == CopyVariant.macos) "signin.signout.titleMac" else "signin.signout.title", locale, product)) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(catalog.format("signin.signout.confirm", locale, variant = variant)) } },
        dismissButton = { TextButton(onClick = onCancel) { Text(PolarisTheme.copy.cancel) } },
    )
}

/**
 * The entries of Compose's MenuBar for the kit: "Check for updates" and "Manage license" (title case and an
 * ellipsis on macOS, from the catalog's `macos` variants), and "Sign out" when [onSignOut] is given. Sign out is
 * only here and in Settings → Account.
 *
 *     MenuBar { Menu("Account") { PolarisMenuItems(onCheckForUpdates = ..., onManageLicense = ...) } }
 */
@Composable
public fun MenuScope.PolarisMenuItems(
    onCheckForUpdates: () -> Unit,
    onManageLicense: () -> Unit,
    onSignOut: (() -> Unit)? = null,
) {
    val locale = java.util.Locale.getDefault().toLanguageTag()
    val labels = remember(locale) { PolarisMenuLabels.of(autoPlatformVariant(), locale) }
    Item(labels.checkForUpdates, onClick = onCheckForUpdates)
    Item(labels.manageLicense, onClick = onManageLicense)
    if (onSignOut != null) {
        Separator()
        Item(labels.signOut, onClick = onSignOut)
    }
}
