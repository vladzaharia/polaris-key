// The Compose-free device roster state holder. Renderers own inline rename/removal confirmation;
// this layer owns SDK calls, serialisation, sorting and the refusal that must survive a reload.
package im.plrs.key.ui

import im.plrs.key.sdk.DeviceInfo
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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

/** The SDK calls the devices screen makes. [PolarisKeyClient.devicesActions] adapts the client. */
public interface PolarisDevicesActions {
    public suspend fun list(): List<DeviceInfo>
    public suspend fun rename(deviceId: String, label: String?)
    public suspend fun deauthorize(deviceId: String)
}

/** The umbrella client as device-roster actions. */
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
            if (devices == null) {
                it.copy(loading = false, error = true, busyId = null, nowMillis = clockMillis())
            } else {
                PolarisDevicesUi(
                    loading = false,
                    devices = sortDevices(devices),
                    nowMillis = clockMillis(),
                    actionError = it.actionError,
                )
            }
        }
    }

    public fun rename(deviceId: String, label: String) {
        run(deviceId, PolarisDeviceActionError.Rename(deviceId, label)) {
            actions.rename(deviceId, label.trim().ifEmpty { null })
        }
    }

    public fun deauthorize(deviceId: String) {
        run(deviceId, PolarisDeviceActionError.SignOut(deviceId)) { actions.deauthorize(deviceId) }
    }

    /** The person dismissed the refusal (closed the reopened rename, or acknowledged it). */
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

/** This device first, then by label, then by id. */
public fun sortDevices(devices: List<DeviceInfo>): List<DeviceInfo> =
    devices.sortedWith(
        compareByDescending<DeviceInfo> { it.current }
            .thenBy { it.label?.lowercase() ?: "￿" }
            .thenBy { it.id },
    )
