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
// Appearance: the JVM's NSAppearance stays Aqua even when macOS is Dark, so a title bar drawn over a full-size
// content view would stay light (or turn black over the dark kit). Each window sets `apple.awt.windowAppearance`
// from the scheme it draws, and again whenever that scheme changes (MacWindowAppearance).
//
// Heights: the update window packs to its content. The Settings window opens 650 x 600 and is resizable in
// height, because the kit's screens measure the window they are in and cannot report an intrinsic height.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.ApplicationScope
import androidx.compose.ui.window.MenuBar
import androidx.compose.ui.window.MenuBarScope
import androidx.compose.ui.window.MenuScope
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowState
import androidx.compose.ui.window.rememberWindowState
import im.plrs.key.core.BootOptions
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.UpdateCheck
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

/**
 * The update window's opening height, until its content has measured itself. `DpSize.Unspecified` (pack to the
 * content) opens a screen-sized window on macOS, because the kit's screens measure the window they are in
 * (UK-10.10, the first real run), so the window is given a size and then follows its content's height.
 */
internal val UpdateWindowOpeningHeight = 320.dp

/** The update column's padding on every side. */
private val UpdateWindowPad = 24.dp

/** The Mac window's minimum size (S7): the floor [PolarisMacFloor] lays out at. */
internal val MacWindowMinimum: Dimension
    get() = Dimension(PolarisMac.floorWidth.value.toInt(), PolarisMac.floorHeight.value.toInt())

private fun androidx.compose.ui.input.key.KeyEvent.isEscapeDown(): Boolean = type == KeyEventType.KeyDown && key == Key.Escape

private val isMacHost: Boolean get() = autoPlatformVariant() == PolarisPlatformVariant.MacOS

/** The real OS, not the forced variant: AppKit's window properties act on a Mac whatever chrome the kit draws. */
private val isRealMac: Boolean get() = System.getProperty("os.name").orEmpty().startsWith("Mac")

/** JetBrains Runtime: the JDK whose AWT understands `apple.awt.windowAppearance` (OpenJDK and Temurin 17 have no appearance code at all). */
private val isJetBrainsRuntime: Boolean get() = System.getProperty("java.vendor").orEmpty().contains("JetBrains", ignoreCase = true)

/**
 * The window's AppKit appearance, from the scheme the kit draws ([darkTheme], else the OS's). The JVM's own stays Aqua
 * when macOS is Dark, so the title bar (transparent under a full-size content view) would not match the content.
 *
 * `apple.awt.windowAppearance` is the JetBrains Runtime's property: it sets the window's NSAppearance, and is read
 * again whenever it changes, so a scheme that flips later follows. Temurin 17 (checked: no appearance code in
 * java.desktop, no `apple.awt.application.appearance` either) ignores it and keeps Aqua, whose black title text would
 * vanish on the dark kit under a full-size content view; there the title text is hidden instead, and the traffic lights
 * stay.
 */
@Composable
private fun MacWindowAppearance(window: java.awt.Window, darkTheme: Boolean?, fullSizeContent: Boolean = false) {
    if (!isRealMac) return
    val dark = darkTheme ?: polarisSystemDark()
    SideEffect {
        val root = (window as? javax.swing.RootPaneContainer)?.rootPane ?: return@SideEffect
        root.putClientProperty("apple.awt.windowAppearance", if (dark) "NSAppearanceNameDarkAqua" else "NSAppearanceNameAqua")
        if (fullSizeContent) root.putClientProperty("apple.awt.windowTitleVisible", isJetBrainsRuntime || !dark)
    }
}

/** The kit's theme and client around one window's content (each window is its own root for composition locals). */
@Composable
private fun PolarisWindowRoot(
    client: PolarisKeyClient,
    branding: PolarisBranding,
    fullSizeContent: Boolean,
    darkTheme: Boolean?,
    copy: PolarisCopy?,
    logo: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalPolarisKey provides client, LocalPolarisMacFullSizeContent provides fullSizeContent) {
        val surface: @Composable () -> Unit = {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background, content = content)
        }
        // null follows the OS (and the kit's copy); true or false is the host's own scheme (a sample's --scheme, an app's setting).
        val words = copy ?: PolarisCopy.localized()
        if (darkTheme == null) {
            PolarisTheme(branding = branding, copy = words, logo = logo, content = surface)
        } else {
            PolarisTheme(branding = branding, copy = words, logo = logo, darkTheme = darkTheme, content = surface)
        }
    }
}

/**
 * The gate window: [PolarisKeyGate]'s boot and gate over [client], then [content]. Closing it, whatever the gate
 * shows, calls [onCloseRequest] (exit by default). An optional update opens [PolarisUpdateWindow]; a mandatory
 * one is a dialog inside this window with no close. "Manage license" opens [PolarisSettingsWindow].
 *
 * @param fullSizeContent draws the content under the macOS title bar (the Mac sheet then floats 52 dp down, else 12 dp).
 * @param onSignOut signs this device out after the person confirms; null hides Sign out everywhere.
 * @param menu the window's menu bar; the default is one menu named [title] holding [PolarisMenuItems]. Null has none.
 * @param onQuit the host's quit, called once a verified installer is open; exits by default.
 * @param darkTheme the host's own scheme for every window of the kit; null follows the OS.
 * @param copy the host's words for every window of the kit (its `productName` above all); null is the catalog's own.
 * @param logo the product's mark, drawn by every window of the kit where the product's icon goes (see [PolarisTheme]); null draws the initial.
 * @param icon the OS window icon of every window of the kit (the taskbar and the title bar); null leaves the JVM's own.
 * @param decide the manual "Check for updates" decision; the client's own `update.decide()` by default.
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
    darkTheme: Boolean? = null,
    copy: PolarisCopy? = null,
    logo: (@Composable () -> Unit)? = null,
    icon: Painter? = null,
    decide: suspend () -> UpdateCheck = { client.update.decide() },
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val update = remember(client) { PolarisUpdateState() }
    val updateActions = remember(client) { client.updateActions() }
    val settings = remember(client) { PolarisSettingsState(client.settingsActions(editable = true), scope) }
    val devices = remember(client) { PolarisDevicesState(client.devicesActions(), scope) }
    state.checkAction = {
        scope.launch {
            state.checkForUpdates(update) { withContext(Dispatchers.IO) { decide() } }
            if (state.check == PolarisCheckStatus.Offered) update.loadFacts(client)
        }
    }

    Window(onCloseRequest = onCloseRequest, state = windowState, title = title, icon = icon) {
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
        MacWindowAppearance(window, darkTheme, fullSizeContent && mac)
        if (menu != null) MenuBar { menu(state) }
        PolarisWindowRoot(client, branding, fullSizeContent && mac, darkTheme, copy, logo) {
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
    PolarisUpdateWindow(client, update, onUpdate = { update.install(updateActions, scope, onQuit) }, branding = branding, darkTheme = darkTheme, copy = copy, logo = logo, icon = icon)
    PolarisSettingsWindow(
        client,
        state.settings,
        settings,
        devices,
        // The question is asked in the gate window; the Settings window's button raises it there.
        onSignOut = if (onSignOut != null) state::requestSignOut else null,
        branding = branding,
        darkTheme = darkTheme,
        copy = copy,
        logo = logo,
        icon = icon,
    )
}

/**
 * The window of an optional update: one column [UpdateWindowWidth] wide, not resizable, sized to its content.
 * Open while [update] holds an optional offer ([PolarisUpdateRoute.Window]). Later, Escape and the OS close button
 * all dismiss it for this run; Skip this version remembers the choice. [logo] and [icon] are as on [PolarisKeyWindow].
 */
@Composable
public fun ApplicationScope.PolarisUpdateWindow(
    client: PolarisKeyClient,
    update: PolarisUpdateState,
    onUpdate: () -> Unit,
    branding: PolarisBranding = PolarisBranding.PolarisKey,
    windowState: WindowState = rememberWindowState(size = DpSize(UpdateWindowWidth, UpdateWindowOpeningHeight)),
    darkTheme: Boolean? = null,
    copy: PolarisCopy? = null,
    logo: (@Composable () -> Unit)? = null,
    icon: Painter? = null,
) {
    val offer by update.offer.collectAsState()
    val ui = offer?.takeIf { updateRoute(it) == PolarisUpdateRoute.Window } ?: return
    val titles = remember(copy) { (copy ?: PolarisCopy()).let { if (isMacHost) it.forMac() else it } }
    // The Mac window is named for what it is, the heading names the version; the other chromes title it with the heading.
    val windowTitle = if (isMacHost) KitCopy.bundled.format("update.availableTitle", java.util.Locale.getDefault().toLanguageTag(), variant = CopyVariant.macos) else titles.updatePromptText(ui).first
    Window(
        onCloseRequest = update::dismiss,
        state = windowState,
        title = windowTitle,
        icon = icon,
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
        MacWindowAppearance(window, darkTheme)
        // Sized to the content: the window's frame (title bar) is added to what the column measured. The size is
        // applied after composition (a state write from inside a layout pass is dropped while the window is still opening).
        var content by remember { mutableStateOf<Dp?>(null) }
        content?.let { height ->
            LaunchedEffect(height) {
                val insets = window.insets
                windowState.size = DpSize(UpdateWindowWidth + (insets.left + insets.right).dp, height + (insets.top + insets.bottom).dp)
            }
        }
        PolarisWindowRoot(client, branding, fullSizeContent = false, darkTheme = darkTheme, copy = copy, logo = logo) {
            PolarisUpdateWindowContent(ui, onUpdate, onLater = update::dismiss, onSkip = update::skip) { content = it }
        }
    }
}

/**
 * The update column at desktop density, flat on the window (no card, shadow or scrim): the product's icon beside a
 * 17 to 20 sp title, the notes, the progress, and the actions in an end-aligned row of 28 to 34 dp controls. Its
 * height is measured with no upper bound, so [onHeight] reports what the content needs and not what the window
 * left it; the window is then sized to that.
 */
@Composable
internal fun PolarisUpdateWindowContent(
    ui: PolarisUpdateUi,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
    onSkip: () -> Unit,
    onHeight: (Dp) -> Unit = {},
) {
    // A 600 dp tall window, so the notes are never dropped for want of height; the width is the column's.
    val window = remember { PolarisWindow(UpdateWindowWidth, 600.dp) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val copy = PolarisTheme.copy
    val (title, body) = copy.updatePromptText(ui)
    val downloading = ui.progress != null && ui.kind == PolarisUpdateUi.Kind.Install
    val mac = window.isMac
    CompositionLocalProvider(LocalPolarisWindow provides window, LocalPolarisTextAlign provides TextAlign.Start) {
        Column(
            Modifier
                .width(UpdateWindowWidth)
                .wrapContentHeight(Alignment.Top, unbounded = true)
                .onSizeChanged { onHeight(with(density) { it.height.toDp() }) }
                .padding(UpdateWindowPad),
        ) {
            val kind = if (ui.critical) PolarisMessageKind.Warning else PolarisMessageKind.Info
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                val size = if (mac) 48.dp else 40.dp
                if (productName(copy) != null || PolarisTheme.current.logo != null) {
                    PolarisProductIcon(size)
                } else {
                    PolarisIconBadge(if (ui.critical) PolarisSymbols.Warning else PolarisSymbols.Refresh, kind.tint().first, kind.glyph())
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleLarge.copy(fontSize = if (mac) 17.sp else 20.sp, lineHeight = if (mac) 22.sp else 26.sp, fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.fillMaxWidth().semantics { heading() },
                    )
                    if (mac && ui.kind == PolarisUpdateUi.Kind.Install) {
                        copy.updateCurrentLine(ui)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
            Spacer(Modifier.height(PolarisSpace.controls))
            if (body != null) PolarisBody(body, textAlign = TextAlign.Start)
            if (ui.kind == PolarisUpdateUi.Kind.Install) {
                if (!mac) copy.updateCurrentLine(ui)?.let { PolarisBody(it, textAlign = TextAlign.Start) }
                PolarisUpdateNotes(ui)
            }
            if (ui.critical) {
                Spacer(Modifier.height(8.dp))
                PolarisBody(copy.updateCritical, textAlign = TextAlign.Start)
            }
            ui.error?.let {
                Spacer(Modifier.height(8.dp))
                PolarisBody(copy.updateFailureMessage(it), textAlign = TextAlign.Start)
            }
            if (downloading) {
                val (done, total) = ui.progress!!
                val line = if (total > 0) copy.format(copy.updateDownloading, copy.bytes(done), copy.bytes(total)) else "${copy.packsDownloading} · ${copy.bytes(done)}"
                Spacer(Modifier.height(16.dp))
                PolarisProgressBar(if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else null, line)
                Spacer(Modifier.height(8.dp))
                Text(
                    line,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                ui.secondsLeft?.let {
                    Text(
                        copy.timeLeftLine(it.toLong()),
                        style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(20.dp))
            val primaryLabel = when {
                ui.kind == PolarisUpdateUi.Kind.Restart -> copy.updateRestartNow
                downloading -> copy.updateRestartWhenReady
                else -> copy.updateVerb(ui)
            }
            val showLater = !ui.mandatory
            val showSkip = !ui.mandatory && !downloading && ui.kind == PolarisUpdateUi.Kind.Install && ui.version != null
            if (mac) {
                // Skip leads the row when it fits, Cancel then the default end it; emitted left to right so Tab runs the same way.
                PolarisMacActionRow(leading = showSkip) {
                    if (showSkip) PolarisTextButton(copy.updateSkip, onSkip)
                    CompositionLocalProvider(LocalPolarisActionRow provides true) {
                        if (showLater) PolarisSecondaryButton(copy.updateLater, onLater)
                        PolarisPrimaryButton(primaryLabel, onUpdate, initialFocus = true)
                    }
                }
            } else if (showSkip) {
                PolarisSkipRow {
                    PolarisTextButton(copy.updateSkip, onSkip)
                    CompositionLocalProvider(LocalPolarisActionRow provides true) {
                        if (showLater) PolarisSecondaryButton(copy.updateLater, onLater)
                        PolarisPrimaryButton(primaryLabel, onUpdate, initialFocus = true)
                    }
                }
            } else {
                PolarisActionGroup(row = true) {
                    PolarisPrimaryButton(primaryLabel, onUpdate, initialFocus = true)
                    if (showLater) PolarisSecondaryButton(copy.updateLater, onLater)
                }
            }
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
 * Account pane. [logo] and [icon] are as on [PolarisKeyWindow].
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
    darkTheme: Boolean? = null,
    copy: PolarisCopy? = null,
    logo: (@Composable () -> Unit)? = null,
    icon: Painter? = null,
) {
    val pane = state.pane ?: return
    val titles = remember(copy) { (copy ?: PolarisCopy()).let { if (isMacHost) it.forMac() else it } }
    Window(
        onCloseRequest = state::close,
        state = windowState,
        title = settingsWindowTitle(pane, titles, java.util.Locale.getDefault().toLanguageTag()),
        icon = icon,
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
        MacWindowAppearance(window, darkTheme)
        PolarisWindowRoot(client, branding, fullSizeContent = false, darkTheme = darkTheme, copy = copy, logo = logo) {
            PolarisSettingsWindowContent(pane, state::open, settings, devices, onSignOut, onActivate = state::close)
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
    /** "Activate": the gate window behind this one is the activation, so this closes the Settings window onto it. */
    onActivate: () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    val locale = kitLocale()
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (entry in PolarisSettingsPane.entries) {
                SettingsTab(settingsWindowTitle(entry, copy, locale), selected = entry == pane) { onPane(entry) }
            }
        }
        HorizontalDivider()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (pane) {
                PolarisSettingsPane.Account -> PolarisAccountPane(settings, onSignOut, onActivate)
                PolarisSettingsPane.Devices -> PolarisDevices(devices)
            }
        }
    }
}

/** One tab of the Settings window: the selected one is bold, in the accent and underlined, so colour is never alone. */
@Composable
private fun SettingsTab(label: String, selected: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val line = if (selected) scheme.primary else Color.Transparent
    Box(
        Modifier
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .height(42.dp)
            // The underline is drawn at the tab's own width: a child that fills the width would take the row's.
            .drawBehind { drawRect(line, topLeft = Offset(0f, size.height - 2.dp.toPx()), size = Size(size.width, 2.dp.toPx())) }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) scheme.primary else scheme.onSurfaceVariant,
        )
    }
}

/**
 * The Account pane: the account screen's header card and connected rows (UK-09b.9b), then the settings under their
 * provenance groups. A device with no licence reads "Not activated" with an Activate row; the "no settings" card only
 * shows when nothing else does.
 */
@Composable
private fun PolarisAccountPane(settings: PolarisSettingsState, onSignOut: (() -> Unit)?, onActivate: () -> Unit) {
    val ui by settings.ui.collectAsState()
    LaunchedEffect(settings) { settings.load() }
    val copy = PolarisTheme.copy
    if (ui.loading) {
        PolarisProgressScreen(copy.loading)
        return
    }
    val locale = kitLocale()
    val catalog = KitCopy.bundled
    val variant = polarisCopyVariant()
    val license = ui.license
    val inactive = license == null || license.status == LicenseStatus.needsActivation
    CompositionLocalProvider(LocalPolarisEmbedded provides true) {
        PolarisSurface { _, _ ->
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
            ) {
                AccountHeaderCard(license, notActivated = inactive)
                val rows = buildList<@Composable (Shape) -> Unit> {
                    if (inactive) {
                        add { shape ->
                            AccountListItem(catalog.format("common.activateLicense", locale, variant = variant), null, PolarisSymbols.Lock, chevron = true, selected = false, shape = shape, onClick = onActivate)
                        }
                    }
                    if (onSignOut != null) {
                        add { shape ->
                            AccountListItem(catalog.format("common.signOut", locale, variant = variant), null, PolarisSymbols.Logout, chevron = false, selected = false, shape = shape, tint = PolarisTheme.status.danger, onClick = onSignOut)
                        }
                    }
                }
                if (rows.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        rows.forEachIndexed { i, row -> row(polarisConnectedShape(i, rows.size, PolarisTheme.cardShape)) }
                    }
                }
                val channelError = ui.error?.takeIf { ui.channel?.drawn == true && it.code == im.plrs.key.core.ErrorCode.channelNotAllowed }?.let(copy::settingsFailureMessage)
                ui.error?.takeIf { channelError == null }?.let { PolarisInlineNotice(copy.settingsFailureMessage(it)) }
                ui.channel?.let { PolarisChannelPicker(it, onSelect = settings::setChannel, error = channelError) }
                if (ui.loadFailure != null) {
                    PolarisSection(null) {
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                            PolarisInlineNotice(copy.settingsFailureMessage(ui.loadFailure))
                            Spacer(Modifier.height(PolarisSpace.controls))
                            PolarisSecondaryButton(copy.retry, settings::load)
                        }
                    }
                } else if (ui.entries.isEmpty() && rows.isEmpty()) {
                    PolarisSection(null) {
                        Text(
                            copy.settingsEmpty,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                        )
                    }
                }
                for (group in settingGroups(ui.entries, PolarisTheme.current.developer)) {
                    PolarisSection(group.title) {
                        group.entries.forEachIndexed { i, entry ->
                            if (i > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                            PolarisSettingRow(entry, settings::set, settings::reset)
                        }
                    }
                }
            }
        }
    }
}

/**
 * "Sign out of {product} on this device?" with Cancel and Sign out, in the chrome of the platform: a ContentDialog
 * on Windows, an AdwAlertDialog on GNOME, an alert sheet on macOS (Return is Cancel, as for a destructive default).
 * Sign out is the destructive response wherever the chrome has one.
 */
@Composable
internal fun PolarisSignOutQuestion(onConfirm: () -> Unit, onCancel: () -> Unit) {
    val locale = kitLocale()
    val variant = polarisCopyVariant()
    val catalog = KitCopy.bundled
    val product = mapOf("product" to CopyArgument.Text(PolarisTheme.copy.productName))
    val title = catalog.format(if (variant == CopyVariant.macos) "signin.signout.titleMac" else "signin.signout.title", locale, product)
    val confirm = catalog.format("signin.signout.confirm", locale, variant = variant)
    val cancel = PolarisTheme.copy.cancel
    // Like the update dialog, the question measures its own window: it sits over the host, not inside its surface.
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            // The overlay swallows clicks: the window behind is inert while the question is open.
            .pointerInput(Unit) { detectTapGestures { } }
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && e.key == Key.Escape) {
                    onCancel()
                    true
                } else {
                    false
                }
            },
        contentAlignment = if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) Alignment.TopCenter else Alignment.Center,
    ) {
        val window = PolarisWindow(maxWidth, maxHeight, isTelevision())
        CompositionLocalProvider(LocalPolarisWindow provides window) {
            when (window.variant) {
                PolarisPlatformVariant.Windows -> PolarisFluentContentDialog(
                    footer = listOf(FluentFooterButton(confirm, FluentButtonKind.Accent, onConfirm), FluentFooterButton(cancel, FluentButtonKind.Standard, onCancel)),
                    onDismissOutside = onCancel,
                ) {
                    Text(title, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.fillMaxWidth().semantics { heading() })
                }
                PolarisPlatformVariant.Gnome -> Box(Modifier.fillMaxSize().polarisGnomeScrim(), contentAlignment = Alignment.Center) {
                    val requesters = remember { List(2) { FocusRequester() } }
                    var focused by remember { mutableIntStateOf(0) }
                    PolarisGnomeTypeScope(window) {
                        PolarisAlertCard(
                            title = title,
                            body = null,
                            responses = listOf(
                                PolarisAlertResponse(cancel, onCancel, initialFocus = true),
                                PolarisAlertResponse(confirm, onConfirm, suggested = true, destructive = true),
                            ),
                            modifier = Modifier.padding(PolarisGnome.margin).onPreviewKeyEvent { e ->
                                // Tab cycles between the two responses; focus never reaches the window behind.
                                if (e.type == KeyEventType.KeyDown && e.key == Key.Tab) {
                                    val next = if (e.isShiftPressed) (focused + requesters.size - 1) % requesters.size else (focused + 1) % requesters.size
                                    runCatching { requesters[next].requestFocus() }
                                    true
                                } else {
                                    false
                                }
                            },
                            requesters = requesters,
                            onFocused = { focused = it },
                        )
                    }
                }
                else -> PolarisMacAlertSheet(title, confirm, cancel, onConfirm, onCancel)
            }
        }
    }
}

/** The macOS alert sheet: the product's icon beside a bold title, Cancel and the destructive Sign Out in a trailing row. */
@Composable
private fun PolarisMacAlertSheet(title: String, confirm: String, cancel: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    Surface(
        modifier = Modifier.padding(top = polarisMacSheetTop(), start = 16.dp, end = 16.dp).widthIn(max = PolarisMac.sheetWidth).fillMaxWidth(),
        shape = polarisMacSheetShape,
        color = polarisMacSheetColor(),
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = polarisMacSheetBorder(),
        shadowElevation = 12.dp,
    ) {
        Column(Modifier.fillMaxWidth().polarisMacInnerHighlight(PolarisTheme.current.dark).polarisMacDefaultKeys(onCancel, onCancel).padding(24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                PolarisProductIcon(48.dp)
                Text(
                    title,
                    style = MaterialTheme.typography.titleLarge.copy(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
            }
            Spacer(Modifier.height(PolarisSpace.controls))
            PolarisMacActionRow(leading = false) {
                CompositionLocalProvider(LocalPolarisActionRow provides true) {
                    PolarisSecondaryButton(cancel, onCancel, initialFocus = true)
                    PolarisPrimaryButton(confirm, onConfirm, danger = true)
                }
            }
        }
    }
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
