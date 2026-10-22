// The licence gate and the activation screen.
//
// PolarisGateState holds what the screens render (the licence state, the activation form) as
// StateFlows and turns the player's actions into SDK calls through PolarisGateActions, so a host
// can compose its own flow from the same pieces. PolarisGate renders the right screen for each
// state: the product (ok, not-applicable), the product under an offline-grace banner (grace), the
// activation screen (needs-activation, and revoked with its notice on top), or a full-screen
// message (expired, version too old or too new, channel not entitled). The screens themselves
// are stateless composables over the UI values, which is what the snapshot tests render.

package im.plrs.key.ui

import android.content.ClipData
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import im.plrs.key.core.Copy
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.ManageLink
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.launch


// ── Composables ──────────────────────────────────────────────────────────────────────────────

/**
 * The drop-in gate: renders [content] when the licence is usable and the right screen otherwise.
 *
 * @param onSignIn starts sign-in elsewhere (for example by showing [PolarisSignIn]); null hides
 *   the button unless [signIn] is given.
 * @param signIn runs sign-in inside the gate instead (the one sign-in form): Sign in morphs the
 *   activation screen into the code view, whose Cancel and "Use a license key instead" come back
 *   to the key field.
 */
@Composable
public fun PolarisGate(
    state: PolarisGateState,
    modifier: Modifier = Modifier,
    onSignIn: (() -> Unit)? = null,
    signIn: PolarisSignInState? = null,
    content: @Composable () -> Unit,
) {
    val gate by state.gate.collectAsState()
    val activation by state.activation.collectAsState()
    PolarisGateScreen(
        gate = gate,
        activation = activation,
        modifier = modifier,
        manageAsQr = isTelevision(),
        onKeyChange = state::onKeyChange,
        onActivate = state::activate,
        onSignIn = onSignIn,
        onRetry = state::refresh,
        signIn = signIn,
        content = content,
    )
}

/** Which screen a gate state shows; the key Crossfade animates between. */
internal enum class GateScreen { Loading, Content, Grace, Activation, Message, SignIn }

internal fun gateScreen(status: LicenseStatus?): GateScreen = when (status) {
    null -> GateScreen.Loading
    LicenseStatus.ok, LicenseStatus.notApplicable -> GateScreen.Content
    LicenseStatus.grace -> GateScreen.Grace
    LicenseStatus.needsActivation, LicenseStatus.revoked -> GateScreen.Activation
    LicenseStatus.expired, LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled ->
        GateScreen.Message
}

/**
 * The stateless gate over its UI values. Two switches are the gate's own (UI state, never the
 * SDK's): an expired licence's "Use another license" shows the activation screen, and with
 * [signIn] the Sign in button shows the code view in place.
 */
@Composable
public fun PolarisGateScreen(
    gate: PolarisGateUi,
    activation: PolarisActivationUi,
    modifier: Modifier = Modifier,
    onKeyChange: (String) -> Unit = {},
    onActivate: () -> Unit = {},
    onSignIn: (() -> Unit)? = null,
    onRetry: () -> Unit = {},
    onRenew: (() -> Unit)? = null,
    manageAsQr: Boolean = false,
    signIn: PolarisSignInState? = null,
    content: @Composable () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    val license = gate.license
    val status = license?.status
    var anotherLicense by rememberSaveable { mutableStateOf(false) }
    var signingIn by rememberSaveable { mutableStateOf(false) }
    var focusKey by remember { mutableStateOf(false) }
    val base = gateScreen(status)
    LaunchedEffect(base) {
        // A usable licence (or a different stop) ends the gate's own detours.
        if (base == GateScreen.Content || base == GateScreen.Grace || base == GateScreen.Loading) {
            anotherLicense = false
            signingIn = false
        }
    }
    val screen = when {
        base == GateScreen.Message && status == LicenseStatus.expired && anotherLicense ->
            if (signingIn && signIn != null) GateScreen.SignIn else GateScreen.Activation
        base == GateScreen.Activation && signingIn && signIn != null -> GateScreen.SignIn
        else -> base
    }
    val startSignIn: (() -> Unit)? = onSignIn ?: signIn?.let { { signingIn = true } }
    Crossfade(targetState = screen, modifier = modifier, label = "PolarisGate") { shown ->
        when (shown) {
            GateScreen.Loading -> PolarisProgressScreen(copy.gateLoading)
            GateScreen.Content -> content()
            GateScreen.Grace -> Column(Modifier.fillMaxSize()) {
                PolarisGraceBanner(
                    body = copy.graceBody(license?.graceUntil, gate.nowSeconds),
                    onReconnect = onRetry,
                    busy = gate.refreshing,
                    modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)),
                )
                Box(Modifier.weight(1f)) { content() }
            }
            GateScreen.Activation -> PolarisActivationScreen(
                ui = activation,
                onKeyChange = onKeyChange,
                onActivate = onActivate,
                onSignIn = startSignIn,
                notice = if (status == LicenseStatus.revoked) copy.gateMessage(LicenseStatus.revoked) else null,
                manageAsQr = manageAsQr,
                focusKey = focusKey,
            )
            GateScreen.SignIn -> if (signIn != null) {
                PolarisSignIn(
                    state = signIn,
                    onCancel = { signingIn = false },
                    onUseKey = {
                        signingIn = false
                        focusKey = true
                    },
                )
            }
            GateScreen.Message -> {
                val stop = status ?: LicenseStatus.expired
                val message = copy.gateMessage(stop, license?.allowedRange) ?: return@Crossfade
                PolarisMessageScreen(message) {
                    if (stop == LicenseStatus.expired) {
                        // Expired leads with Renew and offers Use another license; never Try again or
                        // Reconnect (the matrix pins both). Without a host renewal page, Renew
                        // re-checks the license, which is how a renewal made elsewhere shows up.
                        PolarisPrimaryButton(
                            text = copy.renew,
                            onClick = onRenew ?: onRetry,
                            busy = gate.refreshing,
                            initialFocus = true,
                        )
                        PolarisSecondaryButton(copy.useAnotherLicense, onClick = { anotherLicense = true })
                    } else {
                        PolarisPrimaryButton(
                            text = copy.retry,
                            onClick = onRetry,
                            busy = gate.refreshing,
                            initialFocus = true,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The activation screen: the product's welcome (its icon at hero size, the title and lede), the
 * sign-in button (when [onSignIn] is given), and the licence key field with its Activate button.
 * A revoked licence ([notice]) replaces the welcome's title and lede with its own.
 *
 * After a device-limit refusal the screen is a focused step: the field carries the refusal and the
 * seat caption as neutral text (a full licence is a limit, not an error), Activate becomes
 * "Try again", and "Replace a device" (when the Worker sent a portal link) is the one filled
 * button: it opens the link, or on Android TV ([manageAsQr]) shows it as a QR code beside the
 * message. A device that cannot open the link says so and offers "Copy link".
 *
 * The welcome is the content and the paths are the controls: on a phone the controls dock at the
 * foot; in a short or wide landscape window they sit beside it.
 */
@Composable
public fun PolarisActivationScreen(
    ui: PolarisActivationUi,
    modifier: Modifier = Modifier,
    onKeyChange: (String) -> Unit = {},
    onActivate: () -> Unit = {},
    onSignIn: (() -> Unit)? = null,
    notice: PolarisMessageCopy? = null,
    manageAsQr: Boolean = false,
    onOpenManage: ((String) -> Unit)? = null,
    focusKey: Boolean = false,
) {
    val copy = PolarisTheme.copy
    val refused = (ui.error as? PolarisActivationError.Refused)?.result
    val limit = refused as? ActivationResult.DeviceLimit
    // The QR code carries the key-free link: a code on a shared screen never holds the key.
    val manage = if (manageAsQr) ui.manageQrUrl else ui.manageUrl
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    var noBrowser by rememberSaveable(manage) { mutableStateOf(false) }
    val keyFocus = remember { FocusRequester() }
    if (focusKey) LaunchedEffect(Unit) { runCatching { keyFocus.requestFocus() } }
    val errorText = when (val error = ui.error) {
        null -> null
        PolarisActivationError.KeyEmpty -> copy.activationKeyEmpty
        is PolarisActivationError.Refused -> if (error.result is ActivationResult.DeviceLimit) null else copy.activationMessage(error.result)
    }
    val supporting = if (limit == null) {
        emptyList()
    } else {
        val reason = if (manage != null) copy.activationMessage(limit) else copy.format(copy.deviceLimitNoManage, copy.productName)
        val seats = limit.deviceCount?.let { used -> limit.limit?.let { max -> copy.format(copy.seatCaption, used, max) } }
        listOfNotNull(reason, seats)
    }
    val keyField: @Composable () -> Unit = {
        // The reason leads the content as its lede; the field keeps only its own text.
        val aside = limit != null
        PolarisTextField(
            value = ui.key,
            onValueChange = onKeyChange,
            label = copy.keyLabel,
            placeholder = copy.keyPlaceholder,
            enabled = !ui.busy,
            error = errorText,
            supporting = if (aside) emptyList() else supporting,
            focusRequester = keyFocus,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onActivate() }),
        )
    }
    PolarisScaffold(
        modifier = modifier,
        anchor = if (limit != null) PolarisAnchor.Top else PolarisAnchor.Hero,
        contentAlign = if (limit != null) TextAlign.Start else TextAlign.Center,
        content = {
            if (limit != null) {
                // A focused step: the product header, then the stop's own title.
                PolarisProductHeader()
                PolarisTitle(Copy.activationTitle(im.plrs.key.core.ErrorCode.deviceLimit, coreLocale()))
                // Reason and seat caption as the lede, at body size, in one column and in two panes.
                for (line in supporting) {
                    Spacer(Modifier.height(PolarisSpace.tight))
                    PolarisBody(line)
                }
                if (manageAsQr && manage != null) {
                    Spacer(Modifier.height(polarisWindow.section))
                    // The QR and its caption are one group, set apart from the next.
                    PolarisQrCode(manage, copy.freeDeviceQrDescription, Modifier.size(polarisWindow.qrSize))
                    Spacer(Modifier.height(PolarisSpace.controls))
                    PolarisBody(copy.freeDeviceScan)
                    Spacer(Modifier.height(PolarisSpace.group))
                }
            } else {
                val window = polarisWindow
                PolarisProductIcon(if (window.compactHeight) 56.dp else 120.dp)
                if (productName(copy) != null || PolarisTheme.current.logo != null) Spacer(Modifier.height(window.section))
                PolarisTitle(notice?.title ?: copy.format(copy.activationTitle, copy.productName))
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisBody(notice?.body ?: if (onSignIn != null) copy.activationSubtitle else copy.activationSubtitleKeyOnly)
            }
        },
        detail = if (limit != null) {
            { keyField() }
        } else {
            null
        },
        actions = {
            val replace = limit != null && manage != null && !manageAsQr
            if (limit == null) {
                if (onSignIn != null) {
                    PolarisPrimaryButton(text = copy.signIn, onClick = onSignIn, enabled = !ui.busy, initialFocus = true)
                    Spacer(Modifier.height(PolarisSpace.group))
                }
                keyField()
                Spacer(Modifier.height(PolarisSpace.controls))
                if (onSignIn != null) {
                    PolarisSecondaryButton(text = if (ui.busy) copy.activating else copy.activate, onClick = onActivate, busy = ui.busy)
                } else {
                    PolarisPrimaryButton(text = if (ui.busy) copy.activating else copy.activate, onClick = onActivate, busy = ui.busy, initialFocus = true)
                }
                return@PolarisScaffold
            }
            // After a device-limit refusal: one filled button (Replace a device, or Try again).
            if (noBrowser) {
                PolarisInlineNotice(copy.signInNoBrowser)
                Spacer(Modifier.height(PolarisSpace.controls))
            }
            if (replace) {
                val openManage = {
                    val opened = runCatching { (onOpenManage ?: uriHandler::openUri)(manage!!) }.isSuccess
                    noBrowser = !opened
                }
                if (noBrowser) PolarisSecondaryButton(text = copy.freeDevice, onClick = openManage, enabled = !ui.busy) else PolarisPrimaryButton(
                    text = copy.freeDevice,
                    onClick = openManage,
                    enabled = !ui.busy,
                    initialFocus = true,
                )
                Spacer(Modifier.height(PolarisSpace.controls))
                // Only the validated portal link is ever copied (offeredManageUrl validates it; a host's own value is checked here).
                if (noBrowser && ManageLink.isValid(manage)) {
                    PolarisPrimaryButton(
                        text = copy.signInCopyLink,
                        initialFocus = true,
                        onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copy.signInCopyLink, manage))) } },
                    )
                    Spacer(Modifier.height(PolarisSpace.controls))
                }
                PolarisSecondaryButton(text = copy.retry, onClick = onActivate, busy = ui.busy)
            } else {
                PolarisPrimaryButton(text = copy.retry, onClick = onActivate, busy = ui.busy, initialFocus = true)
            }
            if (onSignIn != null) {
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisSecondaryButton(text = copy.signIn, onClick = onSignIn, enabled = !ui.busy)
            }
        },
    )
}

/**
 * An inline notice card: the message's tint, its icon in the status colour, the title and body,
 * read as one element. The screen's title stays the only heading.
 */
@Composable
public fun PolarisNotice(message: PolarisMessageCopy, modifier: Modifier = Modifier) {
    val (container, content) = message.kind.tint()
    Surface(
        modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        shape = MaterialTheme.shapes.medium,
        color = container,
        contentColor = content,
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            Icon(message.kind.icon(), contentDescription = null, tint = message.kind.glyph(), modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(message.title, style = MaterialTheme.typography.titleSmall)
                Text(message.body, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/**
 * The offline-grace banner shown over the product: the time left and a Reconnect action. A polite
 * live region, so TalkBack announces it once when it appears.
 */
@Composable
public fun PolarisGraceBanner(
    body: String,
    modifier: Modifier = Modifier,
    onReconnect: (() -> Unit)? = null,
    busy: Boolean = false,
) {
    val copy = PolarisTheme.copy
    val status = PolarisTheme.status
    Surface(modifier = modifier.fillMaxWidth(), color = status.warningContainer, contentColor = status.onWarningContainer) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Row(
                modifier = Modifier
                    .widthIn(max = PolarisMaxContentWidth * 1.5f)
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = status.warning, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(12.dp))
                Column(
                    modifier = Modifier.weight(1f).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(copy.graceTitle, style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
                    Text(body, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Start)
                }
                if (onReconnect != null) {
                    Spacer(Modifier.width(8.dp))
                    PolarisTextButton(text = copy.reconnect, onClick = onReconnect, enabled = !busy)
                }
            }
        }
    }
}
