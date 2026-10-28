// The Identity sub-client — device-code sign-in (RFC 8628) for hosts that cannot complete a browser
// redirect: a TV app, a kiosk, a console, a CLI. A port of Swift's `IdentityClient`.
//
//   signIn.start(opts)       SignInSession.kt: POST /<p>/identity/auth/device/start → a `SignInSession`
//                            with the code the player types and the two verification URIs (the
//                            complete one is the QR payload). The device code, the POLL credential,
//                            stays inside the session. `session.wait()` is the paced loop: at least
//                            `interval` between polls, longer after a `slow_down`, never faster
//                            because a poll failed, stopped by expiry, `cancel()` or by cancelling
//                            the coroutine (which throws CancellationException).
//
// This file holds the two requests the session drives (`startDeviceCode`, `pollDeviceCode`) and the
// loop (`waitDeviceCode`); they are internal.
//
// A `ready` poll stores the device token through Core (and the subject the Worker reported, through
// `core.setSubject`) and raises the acquisition event, so the facade's forced sync runs exactly as
// after activation. A device-code sign-in yields the signed-in
// identity's OWN licence and nothing else (the Worker merges nothing, P1-06).
//
// The OIDC browser redirect is NOT here: as in Swift it stays a host-supplied sign-in closure
// (`identity.oidc` is unowned).

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.decimalValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.coroutines.coroutineContext

/** The code and the poll credential the SDK keeps for one session; apps read the session's own fields. `toString` redacts [deviceCode]. */
internal data class SignInPrompt(
    /** The poll credential. Never show it, never put it in a URL. */
    val deviceCode: String,
    /** What the player types on the verification page, e.g. `WDJB-MJHT`. */
    val userCode: String,
    /** The page the player opens and types the code into. */
    val verificationUri: String,
    /** The same page with the code pre-filled: the payload for a QR code or a link. */
    val verificationUriComplete: String,
    /** Seconds the code lives for, as the server advertised it. */
    val expiresIn: Long,
    /** The minimum seconds between polls, as the server advertised it. */
    val interval: Long,
    /** When the code expires on THIS client's clock (epoch seconds). */
    val expiresAt: Long,
    /**
     * The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1): the Worker's echo, else (an
     * older Worker) the label sent; null when there is none.
     */
    val deviceName: String? = null,
) {
    override fun toString(): String = "SignInPrompt(deviceCode=[redacted], userCode=$userCode, verificationUri=$verificationUri, " +
        "verificationUriComplete=$verificationUriComplete, expiresIn=$expiresIn, interval=$interval, expiresAt=$expiresAt, " +
        "deviceName=$deviceName)"
}

/** One poll's answer. */
internal sealed interface SignInPoll {
    /** The player has not finished yet. */
    data object Pending : SignInPoll

    /** Polled too fast: wait [interval] seconds before the next poll (RFC 8628 §3.5). */
    data class SlowDown(val interval: Long) : SignInPoll

    /** Signed in: the device token is stored and the post-acquisition sync has run. */
    data class Ready(val subject: String? = null) : SignInPoll

    /** The code expired (or the server no longer knows it). Begin again. */
    data object Expired : SignInPoll

    /**
     * The sign-in failed or was refused. Begin again. [code] is [ErrorCode.signInDenied] when the
     * Worker answered its generic `error` (the provider failed, or the person pressed Deny; the
     * server never says which).
     */
    data class Error(val message: String, val code: String? = null) : SignInPoll
}

/** Raised after a sign-in mints a credential; the facade syncs. */
public typealias SignInAcquiredListener = suspend () -> Unit

/**
 * RFC 8628 §3.5: a `slow_down` without an interval adds five seconds to the CURRENT interval, so
 * repeated interval-less answers keep lengthening it.
 */
public const val SLOW_DOWN_STEP_SECONDS: Long = 5

/** The longest wait or lifetime this client represents: about 68 years. */
private const val MAX_SECONDS: Long = Int.MAX_VALUE.toLong()

/** The seconds the wait loop sleeps: never under one, never past the code's lifetime. */
internal fun pollDelay(interval: Long, expiresIn: Long): Long = minOf(maxOf(interval, 1), maxOf(expiresIn, 1))

/** A server's seconds rounded UP and capped; null for anything that is not a positive number. */
internal fun wholeSeconds(value: JsonElement?): Long? {
    val d = value.decimalValue ?: return null
    if (d.signum() <= 0) return null
    val up = d.setScale(0, RoundingMode.CEILING)
    return if (up > BigDecimal.valueOf(MAX_SECONDS)) MAX_SECONDS else up.toLong()
}

/**
 * @param sleep how the wait loop waits between polls, in seconds. Defaults to `delay`, which
 *   throws CancellationException when the coroutine is cancelled; tests inject a clock-driven one.
 */
public class IdentityClient(
    internal val core: CoreContext,
    internal val onAcquired: SignInAcquiredListener? = null,
    /** How `openAccount()` opens the portal: the system browser. Null: it answers the URL for the host to show. */
    internal val opener: AccountOpener? = null,
    /** Raised when the stored subject changes (a `subject()` read, a sign-out); the facade emits `PolarisEvent.Identity`. */
    internal val onSubject: suspend (String?) -> Unit = {},
    /** Raised after a sign-out released the seat and dropped the token; the facade republishes the licence. */
    onSignedOut: suspend () -> Unit = {},
    sleep: (suspend (Long) -> Unit)? = null,
    /** This device's keys, for the `exchange` proof. Null: `exchange` answers `Unavailable(noDeviceKeys)`. */
    deviceKeys: DeviceKeyPort? = null,
) {
    private val sleep: suspend (Long) -> Unit = sleep ?: { seconds -> delay(seconds * 1000) }
    internal val beforeSignOut = java.util.concurrent.CopyOnWriteArrayList<BeforeSignOutHook>()
    internal val platformProvider = java.util.concurrent.atomic.AtomicReference<PlatformIdentityProvider?>(null)
    private val account = IdentityAccount(core, opener, { beforeSignOut.toList() }, onSubject, onSignedOut) { markSignedOut() }

    @Volatile
    private var deviceKeys: DeviceKeyPort? = deviceKeys

    /** Use these device keys for `exchange` from now on. */
    public fun useDeviceKeys(keys: DeviceKeyPort?) {
        deviceKeys = keys
    }

    internal fun deviceKeyPort(): DeviceKeyPort? = deviceKeys

    /** Install the platform provider `signOut()` cleans up after and `autoSignIn()` uses by default. */
    public fun installPlatformIdentity(provider: PlatformIdentityProvider?) {
        platformProvider.set(provider)
    }

    /** Whether a platform provider is installed (`installPlatformIdentity`): the sign-in form offers its row. */
    public val hasPlatformProvider: Boolean get() = platformProvider.get() != null

    /**
     * The sign-in form's provider row (AutoSignIn.kt): the installed provider's explicit sheet, then an
     * `exchange` with `personInitiated = true`, which clears the sign-out flag. Never throws.
     */
    public suspend fun signInWithProvider(): AutoSignInResult = runProviderSignIn()

    /**
     * The automatic sign-in ladder (AutoSignIn.kt): the stored session, then the platform provider
     * silently and, with `prompt = OPTIONAL`, through its one sheet. Never throws: a refusal is an
     * [AutoSignInResult]. On the JVM desktop there is no provider: the ladder is rung 1, then `NeedsSignIn`.
     */
    @JvmOverloads
    public suspend fun autoSignIn(options: AutoSignInOptions = AutoSignInOptions()): AutoSignInResult = runAutoSignIn(options)

    /**
     * `POST nonce`: a new single-use nonce for the platform provider to sign into its token (V5 section 12.11.2).
     * A result of [ExchangeOutcome.Unavailable] (or another non-nonce outcome) ends the exchange.
     */
    public suspend fun exchangeNonce(kind: ExchangeKind): ExchangeNonceResult {
        val port = deviceKeys ?: return ExchangeNonceResult.Ended(ExchangeOutcome.Unavailable(ExchangeUnavailableReason.noDeviceKeys))
        return when (val step = requestExchangeNonce(kind, port)) {
            is NonceStep.Got -> ExchangeNonceResult.Issued(step.nonce)
            is NonceStep.Ended -> ExchangeNonceResult.Ended(step.outcome)
        }
    }

    /**
     * `POST token` with the token-exchange grant (V5 section 12.11.3): the platform's ID token for a device
     * token. [nonce] is the one the provider signed into [subjectToken]. A token is stored only for
     * [ExchangeOutcome.SignedIn]. [personInitiated] is true when the person started this sign-in from the sign-in UI: it ends the
     * signed-out state; a silent exchange (the default) never does. Throws on a network failure, a 5xx, or a Worker refusal
     * (a [PolarisException] with the wire `code`, `httpStatus`, `retryAfterSeconds`).
     */
    @JvmOverloads
    public suspend fun exchange(kind: ExchangeKind, subjectToken: String, nonce: ExchangeNonce, personInitiated: Boolean = false): ExchangeOutcome {
        val port = deviceKeys ?: return ExchangeOutcome.Unavailable(ExchangeUnavailableReason.noDeviceKeys)
        return exchangeTokens(kind, subjectToken, nonce, port, personInitiated)
    }

    /** Conformance replay only: an exchange that asks for its own nonce, as the recorded conversations do. */
    @ConformanceReplayOnly
    public suspend fun exchangeWithFreshNonce(kind: ExchangeKind, subjectToken: String): ExchangeOutcome {
        val port = deviceKeys ?: return ExchangeOutcome.Unavailable(ExchangeUnavailableReason.noDeviceKeys)
        return exchangeTokens(kind, subjectToken, null, port)
    }

    internal var redirectEntropyValue: RedirectEntropy? = null
    internal var redirectAcquisitionSyncValue: Boolean = true

    /** `signIn.start(options)`: the device-code or redirect session (see SignInSession.kt). */
    public val signIn: SignInNamespace get() = SignInNamespace(this)

    private val choiceClient: ChoiceClient by lazy { ChoiceClient(this) }

    /**
     * The licence choice an app shows itself after a redirect sign-in settled [SignInOutcome.Choose]:
     * `licenses(grant)`, `devices(grant, licenseId)`, `complete(grant, choice)`, `cancel(grant)`
     * (IdentityChoice.kt). Each throws the typed `service-unavailable` N/A when discovery names no choice endpoint.
     */
    public val choice: ChoiceClient get() = choiceClient

    /** The pairwise subject signed in on this device (reads `GET subject`, stores it). */
    public suspend fun subject(): SubjectResult = account.subject()

    /** Run the pre-sign-out hooks, sign out, forget the subject; the token goes only when the seat was released. */
    public suspend fun signOut(): SignOutResult = account.signOut()

    /** Open the product's page in the customer portal through the host's opener. */
    public suspend fun openAccount(): OpenAccountResult = account.openAccount()

    /**
     * `POST attach`: [confirm] false previews the device's licence and writes nothing; true adds it to
     * the signed-in account and rotates the token. A refusal is a typed [AttachResult.Refused].
     */
    public suspend fun attach(confirm: Boolean): AttachResult = account.attach(confirm)

    /**
     * `signIn.start`'s request. Throws `service-unavailable` before any request when this product
     * does not run Identity (D-21). No bearer is sent even when the device holds a token: a sign-in
     * asks for the IDENTITY's credential, and the server binds the flow to this device by its id.
     */
    internal suspend fun startDeviceCode(deviceName: String? = null): SignInPrompt {
        core.requireService(ServiceSlug.identity, Feature.identityDevicecode)
        val body = linkedMapOf<String, JsonElement>("deviceId" to JsonPrimitive(core.deviceId()))
        // §12.7.1: the per-call name, else `CoreOptions.deviceName`, else the platform default,
        // normalised exactly as the Worker will store it. `""` sends none.
        val label = core.deviceLabel(deviceName)
        label?.let { body["deviceName"] = JsonPrimitive(it) }
        val response = post(core.endpoints.identityDeviceStart, JsonObject(body))
        // Device routes never say "Identity is off": a client with a stale discovery map gets a 404
        // `not_found`, which it reports as `service-unavailable` (identity-disabled transcript).
        if (response.status == 404) {
            val unsupported = Unsupported(Feature.identityDevicecode, UnsupportedReason.product, "the product does not run the identity service")
            throw PolarisException(
                ErrorCode.serviceUnavailable,
                "The identity service is not enabled for ${core.product}.",
                detail = unsupported.detail,
                unsupported = unsupported,
            )
        }
        if (response.status != 200) {
            throw PolarisException(
                errorCode(response) ?: ErrorCode.signInUnavailable,
                "device sign-in could not start (status ${response.status}).",
            )
        }
        val b = JsonText.parseOrNull(response.text).objectValue
        val deviceCode = b?.get("deviceCode").stringValue
        val userCode = b?.get("userCode").stringValue
        val uri = b?.get("verificationUri").stringValue
        val complete = b?.get("verificationUriComplete").stringValue
        val expiresIn = wholeSeconds(b?.get("expiresIn"))
        val interval = wholeSeconds(b?.get("interval"))
        if (deviceCode.isNullOrEmpty() || userCode.isNullOrEmpty() || uri.isNullOrEmpty() || complete.isNullOrEmpty() ||
            expiresIn == null || interval == null
        ) {
            throw PolarisException(ErrorCode.badResponse, "device sign-in start answered without a complete prompt.")
        }
        // The echo is what the page shows; an older Worker sends none, so show what was sent.
        val echoed = if (b != null && b.containsKey("deviceName")) b["deviceName"].stringValue else label
        return SignInPrompt(deviceCode, userCode, uri, complete, expiresIn, interval, core.now() + expiresIn, echoed)
    }

    /**
     * Poll once. On [SignInPoll.Ready] the token is stored and the post-acquisition sync has
     * completed before this returns. Throws `network-error` when the request got no answer and
     * `server-error` on a 5xx: neither says anything about the sign-in, so neither is a status.
     */
    internal suspend fun pollDeviceCode(prompt: SignInPrompt, current: Long = prompt.interval): SignInPoll {
        core.requireService(ServiceSlug.identity, Feature.identityDevicecode)
        val response = post(
            core.endpoints.identityDevicePoll,
            JsonObject(mapOf("deviceCode" to JsonPrimitive(prompt.deviceCode), "deviceId" to JsonPrimitive(core.deviceId()))),
        )
        if (response.status >= 500) {
            throw PolarisException(ErrorCode.serverError, "device sign-in poll failed with status ${response.status}.")
        }
        val body = JsonText.parseOrNull(response.text).objectValue
        if (response.status == 429) {
            // The Worker's own `slow_down` carries the interval; a rate limiter in front of it may
            // answer 429 without one, which RFC 8628 §3.5 treats the same way.
            wholeSeconds(body?.get("interval"))?.let { return SignInPoll.SlowDown(it) }
            val stepped = current + SLOW_DOWN_STEP_SECONDS
            return SignInPoll.SlowDown(if (stepped < current) Long.MAX_VALUE else stepped)
        }
        if (response.status != 200) return SignInPoll.Error("device sign-in poll refused (status ${response.status}).")
        return when (body?.get("status").stringValue) {
            "pending" -> SignInPoll.Pending

            "timeout" -> SignInPoll.Expired

            "ready" -> {
                val token = body?.get("token").stringValue
                if (token.isNullOrEmpty()) return SignInPoll.Error("ready without a token.")
                // The pairwise subject the Worker reports (`identity.account`); the facade hears of a change. The subject is
                // stored before the token, so no sync sees the new token under the previous person.
                val subject = body?.get("subject").stringValue?.takeIf { it.isNotEmpty() }
                if (subject == null) {
                    core.setToken(token, TokenSource.signin, personInitiated = true)
                } else if (core.storeSignIn(token, subject, TokenSource.signin, personInitiated = true)) {
                    onSubject(subject)
                }
                onAcquired?.invoke()
                SignInPoll.Ready(subject)
            }

            // A Deny names itself (`reason: access_denied`); a bare `error` failed after approval.
            "error" -> SignInPoll.Error(
                "device sign-in failed.",
                if (body?.get("reason").stringValue == "access_denied") ErrorCode.signInDenied else ErrorCode.signInFailed,
            )

            else -> SignInPoll.Error("device sign-in failed.")
        }
    }

    /**
     * Poll until the sign-in settles (`session.wait()`). The first poll waits one `interval` after the prompt; a
     * `slow_down` lengthens the interval for every later poll and never shortens it; a transient
     * failure is retried at the SAME interval. Returns [SignInPoll.Expired] once `expiresAt` has
     * passed, without asking the server. Cancelling the coroutine stops polling.
     */
    internal suspend fun waitDeviceCode(prompt: SignInPrompt): SignInPoll {
        core.requireService(ServiceSlug.identity, Feature.identityDevicecode)
        var interval = prompt.interval
        while (true) {
            coroutineContext.ensureActive()
            if (core.now() >= prompt.expiresAt) return SignInPoll.Expired
            sleep(pollDelay(interval, prompt.expiresIn))
            coroutineContext.ensureActive()
            if (core.now() >= prompt.expiresAt) return SignInPoll.Expired
            val result = try {
                pollDeviceCode(prompt, interval)
            } catch (e: PolarisException) {
                if (e.code == ErrorCode.networkError || e.code == ErrorCode.serverError) continue
                throw e
            }
            when (result) {
                SignInPoll.Pending -> continue
                is SignInPoll.SlowDown -> interval = maxOf(interval, result.interval)
                is SignInPoll.Ready, SignInPoll.Expired, is SignInPoll.Error -> return result
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────
    private suspend fun post(url: String, body: JsonObject): PolarisResponse = try {
        core.request(
            url,
            method = "POST",
            headers = mapOf("content-type" to "application/json"),
            body = body.toString().toByteArray(Charsets.UTF_8),
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.localOnly) throw e
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    }

    /** The refusal's code: flat (`{"error":"x"}`) or nested (`{"error":{"code":"x"}}`). */
    private fun errorCode(response: PolarisResponse): String? {
        val o = JsonText.parseOrNull(response.text).objectValue ?: return null
        return o["error"].stringValue ?: o["error"].objectValue?.get("code").stringValue
    }
}
