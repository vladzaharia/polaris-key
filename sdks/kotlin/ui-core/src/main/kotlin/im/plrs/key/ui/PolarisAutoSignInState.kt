// @pkey-feature identity.autosignin
// The Compose-free automatic sign-in state holder (I-45.6). The gate runs `identity.autoSignIn()` once
// at boot (unless it is turned off) and this maps the result to the kit's v7 steps: the consent
// (Continue, "Use another account"), the licence choice, the device limit, and the sign-in form.
// `Unavailable` and a plain "nothing here" fall back silently to the gate's own screens. A grant or
// link handle never leaves this class; the UI values carry views only.
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.identity.AutoSignInReason
import im.plrs.key.identity.AutoSignInResult
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.ConsentInput
import im.plrs.key.identity.ExchangeConsentView
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.atomic.AtomicBoolean

/** What the automatic sign-in shows. [Idle] draws nothing: the gate's own screens. */
public sealed interface PolarisAutoSignInUi {
    public data object Idle : PolarisAutoSignInUi

    /** The ladder is running (a network call may be in flight). */
    public data object Running : PolarisAutoSignInUi

    /** Ask before signing in: [consent] names the account and what Continue does. [failed] after a refused Continue. */
    public data class Confirm(val consent: ExchangeConsentView, val busy: Boolean = false, val failed: Boolean = false) : PolarisAutoSignInUi

    /** The licence choice for this sign-in. */
    public class Choose(public val choice: PolarisLicenseChoiceState) : PolarisAutoSignInUi

    /** Every seat is taken. [view] (with the replace rows) is set when the Worker sent it; [manageUrl] frees a seat on the web. */
    public class DeviceLimit(public val manageUrl: String?, public val view: LicenseChoiceView?) : PolarisAutoSignInUi

    /** The sign-in form. [provider] is true when a platform provider row is offered. */
    public data class SignInForm(val provider: Boolean, val busy: Boolean = false, val failed: Boolean = false) : PolarisAutoSignInUi

    /** Signed in. */
    public data object Done : PolarisAutoSignInUi
}

/** The SDK calls automatic sign-in makes. [PolarisKeyClient.autoSignInActions] adapts the umbrella client. */
public interface PolarisAutoSignInActions {
    /** Whether a platform provider is installed (the form's provider row). */
    public val hasProvider: Boolean

    /** The ladder. Never throws except for cancellation. */
    public suspend fun autoSignIn(): AutoSignInResult

    /** `identity.choice.complete(grant, null, consent)`. */
    public suspend fun completeConsent(grant: String, consent: ConsentInput): ChoiceResult<ChoiceCompleted>

    /** Give the pending grant up (best effort). */
    public suspend fun cancelGrant(grant: String)

    /** The form's provider row: the provider's sheet, then `exchange(personInitiated = true)`. Never throws. */
    public suspend fun providerSignIn(): AutoSignInResult

    /** The licence-choice calls for a `choose` result. */
    public fun choiceActions(): PolarisLicenseChoiceActions
}

/** The umbrella client as automatic sign-in actions. */
public fun PolarisKeyClient.autoSignInActions(): PolarisAutoSignInActions {
    val identity = this.identity
    val choices = licenseChoiceActions()
    return object : PolarisAutoSignInActions {
        override val hasProvider: Boolean get() = identity.hasPlatformProvider
        override suspend fun autoSignIn(): AutoSignInResult = identity.autoSignIn()
        override suspend fun completeConsent(grant: String, consent: ConsentInput) = identity.choice.complete(grant, null, consent)
        override suspend fun cancelGrant(grant: String) {
            identity.choice.cancel(grant)
        }
        override suspend fun providerSignIn(): AutoSignInResult = identity.signInWithProvider()
        override fun choiceActions(): PolarisLicenseChoiceActions = choices
    }
}

/**
 * The automatic sign-in state holder. [start] runs the ladder once when [enabled]; hold it where it
 * outlives a renderer so a rotation does not run it again.
 */
public class PolarisAutoSignInState(
    private val actions: PolarisAutoSignInActions,
    private val scope: CoroutineScope,
    /** False is the opt-out (`PolarisGate(autoSignIn = false)`): [start] does nothing. */
    public val enabled: Boolean = true,
    /** Called once when a session is there (the SDK has stored the token); the gate re-reads the licence. */
    private val onSignedIn: () -> Unit = {},
) {
    private val _ui = MutableStateFlow<PolarisAutoSignInUi>(PolarisAutoSignInUi.Idle)
    public val ui: StateFlow<PolarisAutoSignInUi> = _ui.asStateFlow()
    private val started = AtomicBoolean(false)

    /** True after Replace opened the browser from a device-limit step: the next return runs the sign-in once more. */
    private val _awaitingReturn = MutableStateFlow(false)
    public val awaitingReturn: StateFlow<Boolean> = _awaitingReturn.asStateFlow()

    /** The pending consent grant. A credential: never exposed. */
    private var grant: String? = null

    /** Run the ladder, once. */
    public fun start() {
        if (!enabled || !started.compareAndSet(false, true)) return
        _ui.value = PolarisAutoSignInUi.Running
        scope.launch { apply(guarded { actions.autoSignIn() }, fromForm = false) }
    }

    /** Continue on the consent: record it and sign in. */
    public fun continueConsent() {
        val now = _ui.value as? PolarisAutoSignInUi.Confirm ?: return
        if (now.busy) return
        val pending = grant ?: return
        _ui.value = now.copy(busy = true, failed = false)
        val claims = claimsOf(now.consent)
        scope.launch {
            val r = try {
                actions.completeConsent(pending, ConsentInput(claims))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            when {
                r is ChoiceResult.Ok -> done()

                // The grant ran out: the gate's own screens, the person starts again.
                r is ChoiceResult.Refused && r.code == ErrorCode.invalidGrant -> idle()

                else -> _ui.value = now.copy(busy = false, failed = true)
            }
        }
    }

    /** "Use another account": give the grant up and show the sign-in form. */
    public fun useAnotherAccount() {
        val pending = grant
        grant = null
        _ui.value = PolarisAutoSignInUi.SignInForm(provider = actions.hasProvider)
        if (pending != null) scope.launch { guarded { actions.cancelGrant(pending) } }
    }

    /** The form's provider row. */
    public fun signInWithProvider() {
        val now = _ui.value as? PolarisAutoSignInUi.SignInForm ?: return
        if (now.busy) return
        _ui.value = now.copy(busy = true, failed = false)
        scope.launch { apply(guarded { actions.providerSignIn() }, fromForm = true) }
    }

    /**
     * Replace (or the manage link) opened the browser from the device-limit step. Call it just before the
     * link opens; [returned] then runs the sign-in once more.
     */
    public fun replaceOpened() {
        if (_ui.value is PolarisAutoSignInUi.DeviceLimit) _awaitingReturn.value = true
    }

    /**
     * The person is back in the app after [replaceOpened]. Runs the provider sign-in once more (the ladder
     * where the platform has no provider), once per Replace. A sheet they dismiss, or a refusal, leaves the
     * device-limit step as it was; a second limit shows the new step; a session ends in Done.
     */
    public fun returned() {
        if (!_awaitingReturn.compareAndSet(expect = true, update = false)) return
        val before = _ui.value as? PolarisAutoSignInUi.DeviceLimit ?: return
        _ui.value = PolarisAutoSignInUi.Running
        scope.launch {
            val result = guarded { if (actions.hasProvider) actions.providerSignIn() else actions.autoSignIn() }
            when (result) {
                is AutoSignInResult.SignedIn, is AutoSignInResult.Confirm, is AutoSignInResult.Choose, is AutoSignInResult.DeviceLimit -> apply(
                    result,
                    fromForm = true,
                )

                // Nothing new (the seat is still taken, the sheet was dismissed, the call failed): the step they left.
                else -> _ui.value = before
            }
        }
    }

    /** Leave the form (Cancel, or a different sign-in method): the gate's own screens. */
    public fun dismiss() {
        grant = null
        _awaitingReturn.value = false
        idle()
    }

    private fun apply(result: AutoSignInResult?, fromForm: Boolean) {
        when (result) {
            null -> if (fromForm) formFailed() else idle()

            is AutoSignInResult.SignedIn -> done()

            is AutoSignInResult.Confirm -> {
                grant = result.pending.grant
                _ui.value = PolarisAutoSignInUi.Confirm(result.pending.consent)
            }

            is AutoSignInResult.Choose -> {
                val state = PolarisLicenseChoiceState(
                    actions.choiceActions(),
                    scope,
                    result.pending.grant,
                    result.pending.choices,
                    onCompleted = { done() },
                )
                _ui.value = PolarisAutoSignInUi.Choose(state)
            }

            is AutoSignInResult.DeviceLimit -> _ui.value = PolarisAutoSignInUi.DeviceLimit(result.manageUrl, result.view)

            is AutoSignInResult.NeedsSignIn -> when {
                // The person's own pick of "signed out" and a desktop with no provider: nothing to add to the gate.
                !fromForm &&
                    (
                        result.reason == AutoSignInReason.SignedOut ||
                            (!actions.hasProvider && result.reason == AutoSignInReason.NoCredential)
                        ) -> idle()

                else -> _ui.value = PolarisAutoSignInUi.SignInForm(provider = actions.hasProvider)
            }

            // A refusal falls back silently; on the form it says the sign-in did not finish.
            is AutoSignInResult.Unavailable -> if (fromForm) formFailed() else idle()
        }
    }

    private fun formFailed() {
        _ui.value = PolarisAutoSignInUi.SignInForm(provider = actions.hasProvider, failed = true)
    }

    private fun idle() {
        _ui.value = PolarisAutoSignInUi.Idle
    }

    private fun done() {
        grant = null
        _ui.value = PolarisAutoSignInUi.Done
        onSignedIn()
    }

    private suspend fun <T> guarded(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    public companion object {
        /** The profile claims the consent lists: what Continue agrees to share. */
        internal fun claimsOf(consent: ExchangeConsentView): List<String> = consent.items.filter { it.string("kind") == "profile" }
            .flatMap { it.array("claims")?.mapNotNull { c -> c.string() } ?: emptyList() }
    }
}

// ── The kit's inputs for each step ───────────────────────────────────────────────────────────

private fun browserSignIn(vararg extra: Pair<String, JsonPrimitive>): JsonObject = JsonObject(
    mapOf("presentation" to JsonPrimitive("inline"), "replace" to JsonPrimitive("inline"), "channel" to JsonPrimitive("browser")) + extra,
)

/** The consent as the kit's `autoSignIn` input (the confirm step). */
public fun ExchangeConsentView.toKitInputs(device: String? = null): KitInputs {
    val anchor = items.firstOrNull { it.string("kind") == "license" }?.obj("anchor")
    val seat = anchor.obj("seat")
    val auto = buildMap<String, kotlinx.serialization.json.JsonElement> {
        put("step", JsonPrimitive("confirm"))
        asEmail?.let { put("email", JsonPrimitive(it)) }
        put("license", JsonPrimitive(if (anchor != null) "existing" else "new"))
        put("alsoGets", JsonPrimitive(firstTime || changed))
        if (anchor != null) {
            put(
                "anchor",
                JsonObject(
                    buildMap {
                        anchor.string("name")?.let { put("name", JsonPrimitive(it)) }
                        anchor["term"]?.let { put("term", it) }
                        seat.integer("position")?.let { put("position", JsonPrimitive(it)) }
                        seat.integer("limit")?.let { put("limit", JsonPrimitive(it)) }
                    },
                ),
            )
        }
        device?.let { put("device", JsonPrimitive(it)) }
    }
    val inputs = mutableMapOf<String, kotlinx.serialization.json.JsonElement>("signIn" to browserSignIn(), "autoSignIn" to JsonObject(auto))
    asProvider?.let { inputs["provider"] = JsonPrimitive(providerName(it)) }
    return KitInputs.of(inputs)
}

/** The sign-in form (`methods` step); a platform provider row says "Continue with Google". */
public fun signInFormInputs(provider: Boolean): KitInputs = KitInputs.of(
    buildMap {
        put("signIn", browserSignIn())
        if (provider) put("provider", JsonPrimitive("Google"))
    },
)

/** The licence choice (`choices` view) for a pending grant. */
public fun LicenseChoiceView.toKitInputs(): KitInputs =
    KitInputs.of(mapOf("signIn" to browserSignIn("outcome" to JsonPrimitive("choose")), "choices" to raw))

/**
 * The device limit with the Worker's replace rows: the all-full choice. Replace in the browser is offered
 * only when some row can be replaced (`replace.allowed`); a row that cannot is given as having no
 * replace, so the lede names the developer, never a Replace that would be refused.
 */
public fun LicenseChoiceView.toDeviceLimitInputs(): KitInputs {
    val choices = raw.array("choices")?.objects() ?: emptyList()
    val canReplace = choices.any { it.obj("replace").boolean("allowed") == true }
    val view = if (canReplace) {
        raw
    } else {
        JsonObject(
            raw + (
                "choices" to kotlinx.serialization.json.JsonArray(
                    choices.map {
                        JsonObject(it + ("replace" to kotlinx.serialization.json.JsonNull))
                    },
                )
                ),
        )
    }
    val signIn = if (canReplace) {
        browserSignIn(
            "outcome" to JsonPrimitive("choose"),
            "replace" to JsonPrimitive("browser"),
            "event" to JsonPrimitive("open-replace"),
        )
    } else {
        browserSignIn("outcome" to JsonPrimitive("choose"))
    }
    return KitInputs.of(mapOf("signIn" to signIn, "choices" to view))
}

/** The device limit with no license rows (`SignIn/device-limit`): its own step, never the key screen. */
public fun deviceLimitInputs(manageUrl: String?, provider: Boolean = false): KitInputs = KitInputs.of(
    buildMap {
        put("signIn", browserSignIn())
        if (provider) put("provider", JsonPrimitive("Google"))
        put(
            "autoSignIn",
            JsonObject(
                buildMap {
                    put("step", JsonPrimitive("device-limit"))
                    manageUrl?.let { put("manageUrl", JsonPrimitive(it)) }
                },
            ),
        )
    },
)

private fun providerName(wire: String): String = when (wire) {
    "google" -> "Google"
    "apple" -> "Apple"
    else -> wire.replaceFirstChar { it.uppercaseChar() }
}
