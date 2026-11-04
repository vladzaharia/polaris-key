// The AddToAccount state holder (UK-43.8): the state machine behind the AddToAccount screen, a port of
// ui-core's `addToAccountModel.ts` and the Python `AddToAccountModel`. A license a key activated is
// floating; this adds it to an account. The person types a name and an email (they live only here, never in
// the views' inputs), the browser confirms the email, and the license is attached:
//
//     form -> busy -> added | owned | email-bound | other-account | failed   (invalid: a field is wrong)
//
// The model runs over [AddToAccountDriver], three calls the gates implement over the SDK ([addToAccountDriver]):
// sign in with the hints, keep this device's license, attach. A sign-in that ends signed in goes to attach
// after a preview that writes nothing. The hints only prefill the page: nothing here sends a code, and
// `attach` carries no address. A late answer of a cancelled attempt is dropped (the epoch).
package im.plrs.key.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The hints the sign-in carries: the typed email and name, and the purpose. */
public data class AddToAccountHints(val loginHint: String, val nameHint: String, val purpose: String = "attach")

/** One answer of a sign-in's wait. */
public sealed interface AddToAccountWait {
    public data object Pending : AddToAccountWait

    /** Signed in; [email] is the account's address when the sign-in named it. */
    public data class SignedIn(val email: String? = null) : AddToAccountWait

    /** A license choice is due; the driver completes [grant] with Keep. */
    public data class Choose(val grant: String) : AddToAccountWait
    public data object Cancelled : AddToAccountWait
    public data object Expired : AddToAccountWait
}

/** The attach and preview answers. */
public sealed interface AddToAccountAttach {
    public data object Ok : AddToAccountAttach

    /** [code] is the wire code. */
    public data class Refused(val code: String) : AddToAccountAttach
}

/** A running sign-in as the model sees it. */
public interface AddToAccountHandle {
    /** The code the person checks against the one Polaris Locker shows, when the sign-in has one. */
    public val userCode: String? get() = null

    /** Device code: the page the code is typed into, shown as text. */
    public val address: String? get() = null

    /** Device code: the same page with the code filled in (a QR, a link). */
    public val link: String? get() = null
    public suspend fun wait(): AddToAccountWait
    public suspend fun reopen(): Boolean
    public fun cancel()
}

/** The narrow interface both gates implement. */
public interface AddToAccountDriver {
    public suspend fun signIn(hints: AddToAccountHints): AddToAccountHandle

    /** Keep this device's license in the signed-in account; false when the choice did not complete. */
    public suspend fun complete(grant: String): Boolean

    /** [confirm] false previews (nothing is written); true writes. */
    public suspend fun attach(confirm: Boolean): AddToAccountAttach
}

/** Which typed field. */
public enum class AddToAccountField { Name, Email }

/** The holder's state. */
public data class PolarisAddToAccountUi(
    val step: String = "form",
    /** `invalid`: the field to fix, `name`, `email` or `both`. */
    val field: String? = null,
    /** `other-account`: both emails, masked (never the full address). */
    val typedEmail: String? = null,
    val signedEmail: String? = null,
    val name: String = "",
    val email: String = "",
    /** `busy`: the code to check against Polaris Locker's, when the sign-in has one. */
    val userCode: String? = null,
    /** `busy` with a code: where the code is typed in, as text, and the link a QR carries. */
    val address: String? = null,
    val link: String? = null,
)

private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

/**
 * The AddToAccount state holder. [base] is everything else the views read (platform, presentation,
 * services, `licenseHolder`); the typed name and email never enter the views' inputs.
 */
public class PolarisAddToAccountState(
    private val driver: AddToAccountDriver,
    private val scope: CoroutineScope,
    private val base: JsonObject = JsonObject(emptyMap()),
    private val deviceKind: String? = null,
    /** The form was opened from Settings: `added` closes with Done, not Start using. */
    private val fromSettings: Boolean = false,
) {
    private val lock = Any()
    private val _ui = MutableStateFlow(PolarisAddToAccountUi())
    public val ui: StateFlow<PolarisAddToAccountUi> = _ui.asStateFlow()

    private var handle: AddToAccountHandle? = null

    // Bumped when an attempt ends, so a late answer from an old one is dropped.
    private var epoch = 0

    // The account sign-in finished: Try again then attaches again, with no second sign-in.
    @Volatile private var signedIn = false

    // The email of the account that signed in, when the sign-in named it.
    @Volatile private var signedEmail: String? = null

    /** The views' input: [base] with the step on top. */
    public fun inputs(): KitInputs {
        val s = _ui.value
        val members = LinkedHashMap(base)
        if (s.step == "busy" && !s.userCode.isNullOrEmpty()) {
            members["deviceCode"] = JsonObject(mapOf("phase" to JsonPrimitive("waiting"), "userCode" to JsonPrimitive(s.userCode)))
        }
        val add = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        add["step"] = JsonPrimitive(s.step)
        s.field?.let { add["field"] = JsonPrimitive(it) }
        if (s.step == "other-account") {
            s.typedEmail?.let { add["typedEmail"] = JsonPrimitive(it) }
            s.signedEmail?.let { add["signedEmail"] = JsonPrimitive(it) }
        }
        deviceKind?.let { add["deviceKind"] = JsonPrimitive(it) }
        if (fromSettings) add["fromSettings"] = JsonPrimitive(true)
        members["addToAccount"] = JsonObject(add)
        return KitInputs.of(members)
    }

    /** The screen for the current step. */
    public fun screen(): KitScreen = KitStates.resolve(KitComponent.addToAccount, inputs())

    /** The person typed in a field; an `invalid` step goes back to `form`. A busy attempt ignores typing. */
    public fun setField(field: AddToAccountField, value: String) {
        synchronized(lock) {
            val s = _ui.value
            if (s.step == "busy") return
            var next = if (field == AddToAccountField.Name) s.copy(name = value) else s.copy(email = value)
            if (s.step == "invalid") next = next.copy(step = "form", field = null)
            _ui.value = next
        }
    }

    /**
     * True when Continue (or Try again) would start the browser sign-in right now: the fields are valid and no
     * sign-in has finished. A gate arms its tab inside the press only then.
     */
    public val willOpenBrowser: Boolean
        get() {
            val s = _ui.value
            if (s.step == "busy" || s.step == "other-account") return false
            return s.name.trim().isNotEmpty() && EMAIL.matches(s.email.trim()) && !signedIn
        }

    /** Continue: check the fields, then sign in and attach. Returns the attempt (a finished job when nothing started). */
    public fun submit(): Job {
        val start = begin() ?: return done()
        // Try again lets the previous sign-in go before it starts another.
        start.previous?.let { quietly { it.cancel() } }
        return scope.launch { Attempt(start.name, start.email, start.mine).run() }
    }

    private class Start(val name: String, val email: String, val mine: Int, val previous: AddToAccountHandle?)

    /** Null when nothing starts (busy, or a field is wrong: the step says which). Otherwise the attempt, now busy. */
    private fun begin(): Start? = synchronized(lock) {
        val s = _ui.value
        val name = s.name.trim()
        val email = s.email.trim()
        val wrong = wrongField(name, email)
        when {
            s.step == "busy" -> null

            wrong != null -> {
                _ui.value = s.copy(step = "invalid", field = wrong)
                null
            }

            else -> {
                val previous = handle
                epoch++
                handle = null
                _ui.value = s.copy(step = "busy", field = null, userCode = null, address = null, link = null)
                Start(name, email, epoch, previous)
            }
        }
    }

    /** Try again after `failed`, the same attempt with the fields kept; after `other-account` back to the form. */
    public fun tryAgain(): Job = when (_ui.value.step) {
        "other-account" -> {
            cancel()
            done()
        }

        "failed" -> submit()

        else -> done()
    }

    /** Bring the browser tab back while the sign-in runs. Call it inside the press. */
    public fun reopen(): Job {
        val h = synchronized(lock) { handle } ?: return done()
        return scope.launch {
            try {
                h.reopen()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {}
        }
    }

    /** Cancel: back to the form with the fields kept, any sign-in in flight let go. */
    public fun cancel() {
        val h: AddToAccountHandle?
        synchronized(lock) {
            h = handle
            epoch++
            handle = null
            signedIn = false
            signedEmail = null
            _ui.value =
                _ui.value.copy(step = "form", field = null, userCode = null, address = null, link = null, typedEmail = null, signedEmail = null)
        }
        h?.let { quietly { it.cancel() } }
    }

    private fun current(mine: Int): Boolean = synchronized(lock) { mine == epoch }

    private fun set(step: String, mine: Int) {
        synchronized(lock) {
            if (mine != epoch) return
            _ui.value = _ui.value.copy(step = step, field = null, userCode = null, address = null, link = null)
        }
    }

    /** One run of Continue: every step checks the epoch first, so the answer of a cancelled attempt is dropped. */
    private inner class Attempt(private val name: String, private val email: String, private val mine: Int) {
        suspend fun run() {
            try {
                if ((signedIn || signIn()) && current(mine)) {
                    signedIn = true
                    confirm()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                set("failed", mine)
            }
        }

        private suspend fun confirm() {
            // Preview first: nothing is written until the account is the one the person typed.
            val preview = driver.attach(false)
            if (!current(mine)) return
            val signed = signedEmail
            when {
                preview is AddToAccountAttach.Refused -> {
                    if (preview.code == "account_required") signedIn = false
                    set(stepOf(preview), mine)
                }

                // A different account signed in than the email typed: the license is added nowhere, and Try again
                // goes back to the form. Both emails are shown masked, never in full.
                signed != null && !signed.trim().equals(email, ignoreCase = true) -> otherAccount(signed)

                else -> write()
            }
        }

        private fun otherAccount(signed: String) {
            signedIn = false
            synchronized(lock) {
                if (mine != epoch) return
                _ui.value = _ui.value.copy(
                    step = "other-account",
                    field = null,
                    typedEmail = KitFormat.maskEmail(email),
                    signedEmail = KitFormat.maskEmail(signed),
                )
            }
        }

        private suspend fun write() {
            val result = driver.attach(true)
            if (!current(mine)) return
            // No account session after all: Try again signs in again.
            if (result is AddToAccountAttach.Refused && result.code == "account_required") signedIn = false
            set(stepOf(result), mine)
        }

        /** True when the account sign-in ended signed in; otherwise the step is already set. */
        private suspend fun signIn(): Boolean {
            val h = driver.signIn(AddToAccountHints(loginHint = email, nameHint = name))
            if (!current(mine)) {
                quietly { h.cancel() }
                return false
            }
            synchronized(lock) { handle = h }
            h.userCode?.takeIf { it.isNotEmpty() }?.let { code ->
                synchronized(lock) {
                    if (mine == epoch) {
                        _ui.value =
                            _ui.value.copy(
                                userCode = code,
                                address = h.address?.takeIf {
                                    it.isNotEmpty()
                                },
                                link = h.link?.takeIf { it.isNotEmpty() },
                            )
                    }
                }
            }
            var settled: Boolean? = null
            while (settled == null) {
                val answer = h.wait()
                settled = if (!current(mine)) false else settle(answer)
            }
            return settled
        }

        /** The sign-in's answer: true signed in, false the step is set, null still pending. */
        private suspend fun settle(answer: AddToAccountWait): Boolean? = when (answer) {
            AddToAccountWait.Pending -> null

            is AddToAccountWait.SignedIn -> {
                signedEmail = answer.email
                // Settled: nothing left to cancel on Try again.
                synchronized(lock) { handle = null }
                true
            }

            is AddToAccountWait.Choose -> choose(answer.grant)

            AddToAccountWait.Cancelled -> {
                set("form", mine)
                false
            }

            AddToAccountWait.Expired -> {
                set("failed", mine)
                false
            }
        }

        private suspend fun choose(grant: String): Boolean {
            val completed = driver.complete(grant)
            if (!current(mine)) return false
            if (completed) signedEmail = null else set("failed", mine)
            return completed
        }
    }
}

/** The step an attach answer lands on. */
private fun stepOf(result: AddToAccountAttach): String = when {
    result is AddToAccountAttach.Ok -> "added"

    result is AddToAccountAttach.Refused && result.code == "license_owned" -> "owned"

    result is AddToAccountAttach.Refused && result.code == "license_email_bound" -> "email-bound"

    // `account_required` and anything else: Try again.
    else -> "failed"
}

private fun wrongField(name: String, email: String): String? = when {
    name.isEmpty() && !EMAIL.matches(email) -> "both"
    name.isEmpty() -> "name"
    !EMAIL.matches(email) -> "email"
    else -> null
}

private fun done(): Job = Job().also { it.complete() }

private inline fun quietly(block: () -> Unit) {
    try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
    }
}
