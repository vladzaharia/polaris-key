// The Compose-free licence-choice state holder (I-10b.19). After a redirect sign-in settled
// `SignInOutcome.Choose` the app shows the choice itself; this holds the grant, the view being shown, the
// Replace step and the refusals, and finishes through `identity.choice.*`. The Compose
// `rememberLicenseChoiceState` (I-10b.20) wraps it, and so can any other renderer. It never prints or
// exposes the grant beyond [grant], which a renderer must keep out of logs.
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.stringValue
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.LicenseChoice
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.identity.ReplaceView
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** Where the licence choice is. */
public sealed interface PolarisLicenseChoiceUi {
    /**
     * The licences to choose from. [notice] is the Worker's last refusal of an attempt (`device_limit`, `rate_limited`,
     * `license_owned`, `key_entry_limit`, a wrong key, ...): its `manageUrl` and `signInUrl`
     * are the links a renderer offers. [busy] is true while a call is in flight.
     */
    public data class Choosing(
        val view: LicenseChoiceView,
        val preselected: String?,
        val notice: ChoiceResult.Refused? = null,
        val busy: Boolean = false,
    ) : PolarisLicenseChoiceUi

    /** A full licence: pick the seated device to replace. */
    public data class Replacing(
        val view: LicenseChoiceView,
        val licenseId: String,
        val devices: ReplaceView,
        val notice: ChoiceResult.Refused? = null,
        val busy: Boolean = false,
    ) : PolarisLicenseChoiceUi

    /** The choice is made and the device token is stored. [completed].attachable is true after Keep. */
    public data class Done(val completed: ChoiceCompleted) : PolarisLicenseChoiceUi

    /** The grant ran out (its five minutes, or `invalid_grant`): sign in again. */
    public data object Expired : PolarisLicenseChoiceUi

    /** The person gave the sign-in up. */
    public data object Cancelled : PolarisLicenseChoiceUi

    /** A network or server failure: the grant may still be spendable, so [retry][PolarisLicenseChoiceState.retry] is offered. */
    public data class Failed(val message: String) : PolarisLicenseChoiceUi
}

/** The SDK calls the choice makes. [PolarisKeyClient.licenseChoiceActions] adapts the umbrella client. */
public interface PolarisLicenseChoiceActions {
    public suspend fun licenses(grant: String): ChoiceResult<LicenseChoiceView>
    public suspend fun devices(grant: String, licenseId: String): ChoiceResult<ReplaceView>
    public suspend fun complete(grant: String, choice: LicenseChoice): ChoiceResult<ChoiceCompleted>
    public suspend fun cancel(grant: String): ChoiceResult<Unit>
}

/** The umbrella client's `identity.choice` as choice actions. */
public fun PolarisKeyClient.licenseChoiceActions(): PolarisLicenseChoiceActions {
    val calls = identity.choice
    return object : PolarisLicenseChoiceActions {
        override suspend fun licenses(grant: String) = calls.licenses(grant)
        override suspend fun devices(grant: String, licenseId: String) = calls.devices(grant, licenseId)
        override suspend fun complete(grant: String, choice: LicenseChoice) = calls.complete(grant, choice)
        override suspend fun cancel(grant: String) = calls.cancel(grant)
    }
}

/**
 * The licence-choice state holder for one pending sign-in. Build it from the [SignInOutcome.Choose] a redirect sign-in settled;
 * the first view is the one the Worker sent with it. Hold it where it outlives a renderer.
 */
public class PolarisLicenseChoiceState(
    private val actions: PolarisLicenseChoiceActions,
    private val scope: CoroutineScope,
    /** The pending sign-in's grant. A credential: keep it out of logs. */
    private val grant: String,
    firstView: LicenseChoiceView,
    /** Called once when the choice completes (the SDK has already stored the token and synced). */
    private val onCompleted: (ChoiceCompleted) -> Unit = {},
) {
    private val _ui = MutableStateFlow<PolarisLicenseChoiceUi>(choosing(firstView))
    public val ui: StateFlow<PolarisLicenseChoiceUi> = _ui.asStateFlow()
    private val inFlight = AtomicBoolean(false)
    private var last: (suspend () -> Unit)? = null

    /** Run this device on [licenseId]. A full licence moves to [PolarisLicenseChoiceUi.Replacing] first. */
    public fun choose(licenseId: String) {
        val now = _ui.value as? PolarisLicenseChoiceUi.Choosing ?: return
        val row = now.view.choices.firstOrNull { it["id"].stringValue == licenseId }
        if (row?.get("state").stringValue == "full") {
            run { loadDevices(now.view, licenseId) }
        } else {
            run { finish(LicenseChoice.License(licenseId)) }
        }
    }

    /** Replace [deviceId] on the full licence being shown. */
    public fun replace(deviceId: String) {
        val now = _ui.value as? PolarisLicenseChoiceUi.Replacing ?: return
        run { finish(LicenseChoice.License(now.licenseId, deviceId)) }
    }

    /** Leave the Replace step for the licence list. */
    public fun back() {
        val now = _ui.value as? PolarisLicenseChoiceUi.Replacing ?: return
        _ui.value = choosing(now.view)
    }

    /** Keep the licence the device already has; `attach` may follow (see [ChoiceCompleted.attachable]). */
    public fun keep(): Unit = run { finish(LicenseChoice.Keep) }

    /** Get the product's free licence. */
    public fun create(): Unit = run { finish(LicenseChoice.Create) }

    /** Add a licence key. */
    public fun enterKey(key: String): Unit = run { finish(LicenseChoice.Key(key)) }

    /** Give the sign-in up: the grant is cancelled and nothing is stored. */
    public fun cancel() {
        run {
            when (val r = actions.cancel(grant)) {
                is ChoiceResult.Ok -> _ui.value = PolarisLicenseChoiceUi.Cancelled
                is ChoiceResult.Refused -> if (r.code == ErrorCode.invalidGrant) _ui.value = PolarisLicenseChoiceUi.Expired else notice(r)
            }
        }
    }

    /** After [PolarisLicenseChoiceUi.Failed]: try the last call again. */
    public fun retry() {
        val again = last ?: return
        run(again)
    }

    private fun run(call: suspend () -> Unit) {
        if (!inFlight.compareAndSet(false, true)) return
        last = call
        busy(true)
        scope.launch {
            try {
                call()
            } catch (e: CancellationException) {
                busy(false)
                throw e
            } catch (e: Exception) {
                _ui.value = PolarisLicenseChoiceUi.Failed(e.message ?: "")
            } finally {
                inFlight.set(false)
            }
        }
    }

    private suspend fun loadDevices(view: LicenseChoiceView, licenseId: String) {
        when (val r = actions.devices(grant, licenseId)) {
            is ChoiceResult.Ok -> _ui.value = PolarisLicenseChoiceUi.Replacing(view, licenseId, r.value)
            is ChoiceResult.Refused -> notice(r)
        }
    }

    private suspend fun finish(choice: LicenseChoice) {
        when (val r = actions.complete(grant, choice)) {
            is ChoiceResult.Ok -> {
                _ui.value = PolarisLicenseChoiceUi.Done(r.value)
                onCompleted(r.value)
            }
            is ChoiceResult.Refused -> notice(r)
        }
    }

    /** A refusal: `invalid_grant` ends the choice; the rest keep the screen, with the fresh view when the Worker sent one. */
    private fun notice(r: ChoiceResult.Refused) {
        if (r.code == ErrorCode.invalidGrant) {
            _ui.value = PolarisLicenseChoiceUi.Expired
            return
        }
        _ui.value = when (val now = _ui.value) {
            is PolarisLicenseChoiceUi.Replacing ->
                r.view?.let { choosing(it, r) } ?: now.copy(notice = r, busy = false)
            is PolarisLicenseChoiceUi.Choosing -> choosing(r.view ?: now.view, r)
            else -> now
        }
    }

    private fun busy(on: Boolean) {
        _ui.value = when (val now = _ui.value) {
            is PolarisLicenseChoiceUi.Choosing -> now.copy(busy = on)
            is PolarisLicenseChoiceUi.Replacing -> now.copy(busy = on)
            else -> now
        }
    }

    private fun choosing(view: LicenseChoiceView, notice: ChoiceResult.Refused? = null) =
        PolarisLicenseChoiceUi.Choosing(view, view.raw["preselected"].stringValue, notice)

    public companion object {
        /** The first view of a settled [SignInOutcome.Choose]; null when the Worker's `choices` is not a view. */
        @JvmStatic
        public fun firstView(outcome: SignInOutcome.Choose): LicenseChoiceView? = LicenseChoiceView.of(outcome.choices)
    }
}
