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
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.ManageLink
import im.plrs.key.license.ActivationResult
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** What the gate renders. [license] is null until the first status read. */
public data class PolarisGateUi(
    val license: LicenseState? = null,
    /** True while a sync or status read is in flight. */
    val refreshing: Boolean = false,
    /** Epoch seconds when the state was read, for the grace countdown. */
    val nowSeconds: Long = 0,
)

/** Why the last activation attempt failed. */
public sealed interface PolarisActivationError {
    /** The key field was empty. */
    public data object KeyEmpty : PolarisActivationError

    /** The SDK refused or failed the activation. */
    public data class Refused(val result: ActivationResult) : PolarisActivationError
}

/** The activation form. */
public data class PolarisActivationUi(
    val key: String = "",
    val busy: Boolean = false,
    val error: PolarisActivationError? = null,
    /**
     * PX-W8: the portal link "Replace a device" opens after a device-limit refusal, or null. It
     * already carries the app's return URL and, on an `/activate` link, the key as a fragment.
     * Never an auth failure: the screen only offers it.
     */
    val manageUrl: String? = null,
    /**
     * The same link without the key, which the Android TV QR code carries: a code on a shared
     * screen can be scanned by anyone in the room, so it never holds the bearer key (the phone's
     * `/activate` page asks for it instead). See docs/security/THREAT-MODEL.md.
     */
    val manageQrUrl: String? = null,
)

/**
 * The link the gate offers for a refused activation (PX-W8): the served `manageUrl` with the key
 * fragment (on an `/activate` link only, and never when [forQr]) and [returnUrl] added, or null
 * when there is none.
 */
public fun offeredManageUrl(
    result: ActivationResult,
    key: String,
    returnUrl: String? = null,
    forQr: Boolean = false,
): String? {
    val served = (result as? ActivationResult.DeviceLimit)?.manageUrl ?: return null
    if (!ManageLink.isValid(served)) return null
    val withKey = if (forQr) served else ManageLink.withKey(served, key)
    return if (returnUrl.isNullOrEmpty()) withKey else ManageLink.withReturn(withKey, returnUrl)
}

/** The SDK calls the gate makes. [PolarisKeyClient.gateActions] adapts the umbrella client. */
public interface PolarisGateActions {
    /** The current licence state (no network). */
    public suspend fun status(): LicenseState

    /** Exchange a licence key for a device token. */
    public suspend fun activate(key: String): ActivationResult

    /** A Core sync pass, for Retry and Reconnect. */
    public suspend fun sync() {}

    /** Keyless enrolment ("Continue free"); answers `EnrollDisabled` unless the host offers it. */
    public suspend fun enroll(): ActivationResult = ActivationResult.EnrollDisabled

    /** Licence-state changes the SDK pushes (a sync that changed the document). */
    public val changes: Flow<LicenseState> get() = emptyFlow()
}

/** The umbrella client as the gate's actions. */
public fun PolarisKeyClient.gateActions(): PolarisGateActions {
    val client = this
    return object : PolarisGateActions {
        override suspend fun status(): LicenseState = client.status()
        override suspend fun activate(key: String): ActivationResult = client.activate(key)
        override suspend fun enroll(): ActivationResult = client.enroll()
        override suspend fun sync() {
            client.sync()
        }
        override val changes: Flow<LicenseState> get() = client.licenseChanges
    }
}

/**
 * The gate's state holder: the licence state and the activation form as StateFlows, and the
 * actions that change them. Create it once per gate (for example in a ViewModel) with the scope
 * that should own its work, then call [start].
 */
public class PolarisGateState(
    private val actions: PolarisGateActions,
    private val scope: CoroutineScope,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
    initial: LicenseState? = null,
    /** Where the portal sends the person back once a seat is free (a declared return target). */
    private val returnUrl: String? = null,
) {
    private val _gate = MutableStateFlow(PolarisGateUi(license = initial, nowSeconds = clock()))
    private val _activation = MutableStateFlow(PolarisActivationUi())

    public val gate: StateFlow<PolarisGateUi> = _gate.asStateFlow()
    public val activation: StateFlow<PolarisActivationUi> = _activation.asStateFlow()

    /** Read the status now and follow the SDK's changes. */
    public fun start() {
        scope.launch { reload() }
        scope.launch { actions.changes.collect { show(it) } }
    }

    /** Show [state] (a host that reads the licence itself pushes it here). */
    public fun show(state: LicenseState) {
        _gate.update { it.copy(license = state, nowSeconds = clock()) }
    }

    /** Re-read the status without the network. */
    public suspend fun reload() {
        val state = guarded { actions.status() } ?: return
        show(state)
    }

    /** Sync, then re-read the status: Retry and Reconnect. */
    public fun refresh() {
        scope.launch {
            _gate.update { it.copy(refreshing = true) }
            guarded { actions.sync() }
            reload()
            _gate.update { it.copy(refreshing = false) }
        }
    }

    public fun onKeyChange(key: String) {
        _activation.update { it.copy(key = key, error = null, manageUrl = null, manageQrUrl = null) }
    }

    /** Activate with the key in the form. */
    public fun activate() {
        val key = _activation.value.key.trim()
        if (key.isEmpty()) {
            _activation.update { it.copy(error = PolarisActivationError.KeyEmpty) }
            return
        }
        if (_activation.value.busy) return
        scope.launch {
            _activation.update { it.copy(busy = true, error = null, manageUrl = null, manageQrUrl = null) }
            val result = guarded { actions.activate(key) } ?: ActivationResult.Error("activation threw")
            if (result is ActivationResult.Ok) {
                _activation.value = PolarisActivationUi()
            } else {
                _activation.update {
                    it.copy(
                        busy = false,
                        error = PolarisActivationError.Refused(result),
                        manageUrl = offeredManageUrl(result, key, returnUrl),
                        manageQrUrl = offeredManageUrl(result, key, returnUrl, forQr = true),
                    )
                }
            }
            reload()
        }
    }

    /**
     * "Continue free": keyless enrolment; a refusal lands on the activation form like an
     * activation's. The kit's button for it belongs to the UI-kit program (UK-*); hosts call this.
     */
    public fun continueFree() {
        if (_activation.value.busy) return
        scope.launch {
            _activation.update { it.copy(busy = true, error = null) }
            val result = guarded { actions.enroll() } ?: ActivationResult.Error("enrolment threw")
            if (result is ActivationResult.Ok) {
                _activation.value = PolarisActivationUi()
            } else {
                _activation.update { it.copy(busy = false, error = PolarisActivationError.Refused(result)) }
            }
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
                    PolarisPrimaryButton(
                        text = if (stop == LicenseStatus.expired) copy.reconnect else copy.retry,
                        onClick = onRetry,
                        busy = gate.refreshing,
                        initialFocus = true,
                    )
                    if (stop == LicenseStatus.expired) {
                        // No renew link exists on the device side; another license is the way on.
                        PolarisSecondaryButton(copy.useAnotherLicense, onClick = { anotherLicense = true })
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
