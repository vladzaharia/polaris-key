// The Compose-free gate state holder. It belongs in polaris-key-ui-core so an Android Views,
// Compose Desktop or custom UI host gets the same gate and activation behaviour without depending
// on Compose. The Compose kit supplies only the state-to-screen rendering.
package im.plrs.key.ui

import im.plrs.key.core.LicenseState
import im.plrs.key.core.ManageLink
import im.plrs.key.license.ActivationResult
import im.plrs.key.sdk.PolarisEvent
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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
     * The portal link "Replace a device" after a device-limit refusal, or null. It already carries
     * the app's return URL and, for an `/activate` link, the key as a fragment.
     */
    val manageUrl: String? = null,
    /** The same link without the key, suitable for a QR code on a shared display. */
    val manageQrUrl: String? = null,
)

/**
 * The link the gate offers for a refused activation: the served `manageUrl` with the key fragment
 * (only on an `/activate` link and never for [forQr]) and [returnUrl] added, or null.
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
        override suspend fun activate(key: String): ActivationResult = client.license.activateWithKey(key)
        override suspend fun enroll(): ActivationResult = client.enroll()
        override suspend fun sync() {
            client.sync()
        }

        override val changes: Flow<LicenseState> get() = client.events.filterIsInstance<PolarisEvent.License>().map { it.state }
    }
}

/**
 * The gate's state holder: the licence state and the activation form as StateFlows, and the
 * actions that change them. Create it once per gate with the scope that should own its work, then
 * call [start].
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

    /** Update the key draft; any local refusal and old portal link clear immediately. */
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

    /** Keyless enrolment; a refusal lands on the activation form like an activation failure. */
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
