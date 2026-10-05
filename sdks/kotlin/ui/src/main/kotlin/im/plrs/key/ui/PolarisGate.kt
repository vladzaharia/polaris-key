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

import android.content.res.Configuration
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
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
     * PX-W8: the portal link "Free up a device" opens after a device-limit refusal, or null. It
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

    /** Licence-state changes the SDK pushes (a sync that changed the document). */
    public val changes: Flow<LicenseState> get() = emptyFlow()
}

/** The umbrella client as the gate's actions. */
public fun PolarisKeyClient.gateActions(): PolarisGateActions {
    val client = this
    return object : PolarisGateActions {
        override suspend fun status(): LicenseState = client.status()
        override suspend fun activate(key: String): ActivationResult = client.activate(key)
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
 * @param onSignIn starts sign-in (for example by showing [PolarisSignIn]); null hides the button.
 */
@Composable
public fun PolarisGate(
    state: PolarisGateState,
    modifier: Modifier = Modifier,
    onSignIn: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val gate by state.gate.collectAsState()
    val activation by state.activation.collectAsState()
    val uiMode = LocalConfiguration.current.uiMode and Configuration.UI_MODE_TYPE_MASK
    PolarisGateScreen(
        gate = gate,
        activation = activation,
        modifier = modifier,
        manageAsQr = uiMode == Configuration.UI_MODE_TYPE_TELEVISION,
        onKeyChange = state::onKeyChange,
        onActivate = state::activate,
        onSignIn = onSignIn,
        onRetry = state::refresh,
        content = content,
    )
}

/** Which screen a gate state shows; the key Crossfade animates between. */
internal enum class GateScreen { Loading, Content, Grace, Activation, Message }

internal fun gateScreen(status: LicenseStatus?): GateScreen = when (status) {
    null -> GateScreen.Loading
    LicenseStatus.ok, LicenseStatus.notApplicable -> GateScreen.Content
    LicenseStatus.grace -> GateScreen.Grace
    LicenseStatus.needsActivation, LicenseStatus.revoked -> GateScreen.Activation
    LicenseStatus.expired, LicenseStatus.versionTooOld, LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled ->
        GateScreen.Message
}

/** The stateless gate over its UI values. */
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
    content: @Composable () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    val license = gate.license
    Crossfade(targetState = gateScreen(license?.status), modifier = modifier, label = "PolarisGate") { screen ->
        when (screen) {
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
                onSignIn = onSignIn,
                notice = if (license?.status == LicenseStatus.revoked) copy.gateMessage(LicenseStatus.revoked) else null,
                manageAsQr = manageAsQr,
            )
            GateScreen.Message -> {
                val status = license?.status ?: LicenseStatus.expired
                val message = copy.gateMessage(status, license?.allowedRange) ?: return@Crossfade
                PolarisMessageScreen(message) {
                    PolarisPrimaryButton(
                        text = if (status == LicenseStatus.expired) copy.reconnect else copy.retry,
                        onClick = onRetry,
                        busy = gate.refreshing,
                    )
                }
            }
        }
    }
}

/**
 * The activation screen: a welcome, the sign-in button (when [onSignIn] is given), and the licence
 * key field with its Activate button. [notice] (a revoked licence's message) sits above the form.
 * After a device-limit refusal that carries a portal link, "Free up a device" opens it: a button,
 * or a QR code when [manageAsQr] (Android TV, where the link is opened on a phone). Activate again
 * is the "Try again".
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
) {
    val copy = PolarisTheme.copy
    PolarisScreen(modifier = modifier) {
        if (notice != null) {
            PolarisNotice(notice)
            Spacer(Modifier.height(24.dp))
        }
        PolarisTitle(copy.format(copy.activationTitle, copy.productName))
        Spacer(Modifier.height(8.dp))
        PolarisBody(if (onSignIn != null) copy.activationSubtitle else copy.activationSubtitleKeyOnly)
        Spacer(Modifier.height(32.dp))
        if (onSignIn != null) {
            PolarisPrimaryButton(text = copy.signIn, onClick = onSignIn, enabled = !ui.busy)
            Spacer(Modifier.height(20.dp))
            PolarisOrDivider(copy.orDivider)
            Spacer(Modifier.height(20.dp))
        }
        val errorText = ui.error?.let { error ->
            when (error) {
                PolarisActivationError.KeyEmpty -> copy.activationKeyEmpty
                is PolarisActivationError.Refused -> copy.activationMessage(error.result)
            }
        }
        OutlinedTextField(
            value = ui.key,
            onValueChange = onKeyChange,
            label = { Text(copy.keyLabel) },
            placeholder = { Text(copy.keyPlaceholder) },
            singleLine = true,
            enabled = !ui.busy,
            isError = errorText != null,
            supportingText = errorText?.let { text ->
                {
                    Text(
                        text = text,
                        modifier = Modifier.semantics {
                            liveRegion = LiveRegionMode.Assertive
                            error(text)
                        },
                    )
                }
            },
            shape = PolarisTheme.fieldShape,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onActivate() }),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        if (onSignIn != null) {
            PolarisSecondaryButton(text = if (ui.busy) copy.activating else copy.activate, onClick = onActivate, enabled = !ui.busy)
        } else {
            PolarisPrimaryButton(text = if (ui.busy) copy.activating else copy.activate, onClick = onActivate, busy = ui.busy)
        }
        // The QR code carries the key-free link: a code on a shared screen never holds the key.
        val manage = if (manageAsQr) ui.manageQrUrl else ui.manageUrl
        if (manage != null) {
            Spacer(Modifier.height(16.dp))
            if (manageAsQr) {
                PolarisQrCode(
                    content = manage,
                    contentDescription = copy.freeDeviceQrDescription,
                    modifier = Modifier.widthIn(max = 200.dp).fillMaxWidth(0.6f),
                )
                Spacer(Modifier.height(12.dp))
                PolarisBody(copy.freeDeviceScan)
            } else {
                val uriHandler = LocalUriHandler.current
                val open = onOpenManage ?: { uri: String -> uriHandler.openUri(uri) }
                PolarisSecondaryButton(text = copy.freeDevice, onClick = { open(manage) }, enabled = !ui.busy)
            }
        }
    }
}

/** A horizontal rule with a centred label ("or"). */
@Composable
internal fun PolarisOrDivider(label: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** An inline notice card: the message's tint, icon, title and body, read as one element. */
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
            Icon(message.kind.icon(), contentDescription = null, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(message.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
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
