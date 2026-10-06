// The Identity sub-client — device-code sign-in (RFC 8628) for hosts that cannot complete a browser
// redirect: a TV app, a kiosk, a console, a CLI. A port of Swift's `IdentityClient`.
//
//   beginSignIn(deviceName)  POST /<p>/identity/auth/device/start → the code the player types and
//                            the two verification URIs (the complete one is the QR payload). The
//                            device code, the POLL credential, stays inside the prompt.
//   pollSignIn(prompt)       POST /<p>/identity/auth/device/poll, exactly once. The caller paces.
//   waitForSignIn(prompt)    the paced loop: at least `interval` between polls, longer after a
//                            `slow_down`, never faster because a poll failed, stopped by expiry or
//                            by cancelling the coroutine (which throws CancellationException).
//
// A `ready` poll stores the device token through Core and raises the acquisition event, so the
// facade's forced sync runs exactly as after activation. A device-code sign-in yields the signed-in
// identity's OWN licence and nothing else (the Worker merges nothing, P1-06).
//
// The OIDC browser redirect is NOT here: as in Swift it stays a host-supplied sign-in closure
// (`identity.oidc` is unowned).

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.decimalValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.coroutines.coroutineContext

/** What the host shows the player, plus the poll credential the SDK keeps. `toString` redacts [deviceCode]. */
public data class SignInPrompt(
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
    override fun toString(): String =
        "SignInPrompt(deviceCode=[redacted], userCode=$userCode, verificationUri=$verificationUri, " +
            "verificationUriComplete=$verificationUriComplete, expiresIn=$expiresIn, interval=$interval, expiresAt=$expiresAt, " +
            "deviceName=$deviceName)"
}

/** One poll's answer. */
public sealed interface SignInPoll {
    /** The player has not finished yet. */
    public data object Pending : SignInPoll

    /** Polled too fast: wait [interval] seconds before the next poll (RFC 8628 §3.5). */
    public data class SlowDown(val interval: Long) : SignInPoll

    /** Signed in: the device token is stored and the post-acquisition sync has run. */
    public data object Ready : SignInPoll

    /** The code expired (or the server no longer knows it). Begin again. */
    public data object Expired : SignInPoll

    /** The sign-in failed or was refused. Begin again. */
    public data class Error(val message: String) : SignInPoll
}

/** How [IdentityClient.waitForSignIn] ended. Cancellation throws instead. */
public sealed interface SignInResult {
    public data object Ready : SignInResult
    public data object Expired : SignInResult
    public data class Error(val message: String) : SignInResult
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

/** The seconds [IdentityClient.waitForSignIn] sleeps: never under one, never past the code's lifetime. */
internal fun pollDelay(interval: Long, expiresIn: Long): Long = minOf(maxOf(interval, 1), maxOf(expiresIn, 1))

/** A server's seconds rounded UP and capped; null for anything that is not a positive number. */
internal fun wholeSeconds(value: JsonElement?): Long? {
    val d = value.decimalValue ?: return null
    if (d.signum() <= 0) return null
    val up = d.setScale(0, RoundingMode.CEILING)
    return if (up > BigDecimal.valueOf(MAX_SECONDS)) MAX_SECONDS else up.toLong()
}

/**
 * @param sleep how [waitForSignIn] waits between polls, in seconds. Defaults to `delay`, which
 *   throws CancellationException when the coroutine is cancelled; tests inject a clock-driven one.
 */
public class IdentityClient(
    private val core: CoreContext,
    private val onAcquired: SignInAcquiredListener? = null,
    sleep: (suspend (Long) -> Unit)? = null,
) {
    private val sleep: suspend (Long) -> Unit = sleep ?: { seconds -> delay(seconds * 1000) }

    /**
     * Begin a device-code sign-in. Throws `service-unavailable` before any request when this product
     * does not run Identity (D-21). No bearer is sent even when the device holds a token: a sign-in
     * asks for the IDENTITY's credential, and the server binds the flow to this device by its id.
     */
    public suspend fun beginSignIn(deviceName: String? = null): SignInPrompt {
        core.requireService(ServiceSlug.identity, Feature.identityDevicecode)
        val body = linkedMapOf<String, JsonElement>("deviceId" to JsonPrimitive(core.deviceId()))
        // §12.7.1: the per-call name, else `CoreOptions.deviceName`, else the platform default,
        // normalised exactly as the Worker will store it. `""` sends none.
        val label = core.deviceLabel(deviceName)
        label?.let { body["deviceName"] = JsonPrimitive(it) }
        val response = post(core.endpoints.identityDeviceStart, JsonObject(body))
        if (response.status != 200) {
            throw PolarisException(
                errorCode(response) ?: ErrorCode.signInUnavailable, "device sign-in could not start (status ${response.status}).",
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
    public suspend fun pollSignIn(prompt: SignInPrompt): SignInPoll = poll(prompt, prompt.interval)

    /** One poll, where an interval-less `slow_down` lengthens [current], the interval being paced. */
    private suspend fun poll(prompt: SignInPrompt, current: Long): SignInPoll {
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
                core.setToken(token, TokenSource.signin)
                onAcquired?.invoke()
                SignInPoll.Ready
            }
            else -> SignInPoll.Error("device sign-in failed.")
        }
    }

    /**
     * Poll until the sign-in settles. The first poll waits one `interval` after the prompt; a
     * `slow_down` lengthens the interval for every later poll and never shortens it; a transient
     * failure is retried at the SAME interval. Returns [SignInResult.Expired] once `expiresAt` has
     * passed, without asking the server. Cancelling the coroutine stops polling.
     */
    public suspend fun waitForSignIn(prompt: SignInPrompt): SignInResult {
        core.requireService(ServiceSlug.identity, Feature.identityDevicecode)
        var interval = prompt.interval
        while (true) {
            coroutineContext.ensureActive()
            if (core.now() >= prompt.expiresAt) return SignInResult.Expired
            sleep(pollDelay(interval, prompt.expiresIn))
            coroutineContext.ensureActive()
            if (core.now() >= prompt.expiresAt) return SignInResult.Expired
            val result = try {
                poll(prompt, interval)
            } catch (e: PolarisException) {
                if (e.code == ErrorCode.networkError || e.code == ErrorCode.serverError) continue
                throw e
            }
            when (result) {
                SignInPoll.Pending -> continue
                is SignInPoll.SlowDown -> interval = maxOf(interval, result.interval)
                SignInPoll.Ready -> return SignInResult.Ready
                SignInPoll.Expired -> return SignInResult.Expired
                is SignInPoll.Error -> return SignInResult.Error(result.message)
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────
    private suspend fun post(url: String, body: JsonObject): PolarisResponse = try {
        core.request(
            url, method = "POST", headers = mapOf("content-type" to "application/json"),
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
