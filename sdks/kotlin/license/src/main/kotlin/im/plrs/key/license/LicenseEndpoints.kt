// The License service's HTTP surface — `POST /<p>/license/{activate,enroll,token,deauthorize}`
// (wire contract v3 §5). A port of Swift's `PolarisKeyLicense/Endpoints.swift`.
//
// Pure transport: it builds the request, maps the status ladder and hands back a result.
// Verification, caching and the gate live elsewhere on purpose: an HTTP layer that verified would
// be one that could be talked into not verifying. `GET /license/document` is NOT here: it is one of
// the two documents Core's `sync()` drives through identical machinery.
//
// Every call goes through `CoreContext.request`, so the `X-PKey-*` headers and the deadline arrive
// automatically (R4-08).
//
// The Worker emits two error envelopes: routes that moved keep the flat v2 shape
// (`{"error":"device_limit","limit":3}`), new v3 surfaces nest it (`{"error":{"code":…}}`). A 403
// that means "device limit" and one that means "fingerprint required" are different outcomes, so
// the reader looks at both spellings rather than guess.

package im.plrs.key.license

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.arrayValue
import im.plrs.key.core.deviceRequestBody
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException

/**
 * The outcome of an activation-like call (`/license/{activate,enroll,token}`): the shared typed
 * activation results (notes/SDK-PARITY-PASS.md §3.1). Every refusal carries the server's registry
 * [code]; the mapping goes by the body's `error` code, never by the status alone, and an unknown 403
 * is [Refused] with that code, never [DeviceLimit].
 */
public sealed interface ActivationResult {
    /** The registry code of a refusal (`ErrorCode`), `network` or `server-error` for [Error]; null for [Ok]. */
    public val code: String?

    public data class Ok(val token: String, val schemaVersion: Long) : ActivationResult {
        override val code: String? get() = null
        override fun toString(): String = "Ok(token=[redacted], schemaVersion=$schemaVersion)"
    }

    /** 403 `device_limit`: every seat is taken. Free one (the portal's devices page) or deactivate elsewhere. */
    public data class DeviceLimit(val limit: Long?, val deviceCount: Long?) : ActivationResult {
        override val code: String get() = ErrorCode.deviceLimit
    }

    /** 401: the key (or token) is missing, invalid, or belongs to a licence that is no longer usable. */
    public data object Unauthorized : ActivationResult {
        override val code: String get() = ErrorCode.unauthorized
    }

    /** The tier requires a hardware fingerprint this host could not produce. */
    public data object FingerprintRequired : ActivationResult {
        override val code: String get() = ErrorCode.fingerprintRequired
    }

    /**
     * Hardware drifted past the tier's tolerance and the binding was retired. Retrying activation
     * re-binds the new hardware and consumes a seat (the Worker answers 409 because it is retryable).
     */
    public data class HardwareMismatch(val drift: Long?, val changed: List<String>?) : ActivationResult {
        override val code: String get() = ErrorCode.hardwareMismatch
    }

    /** The product does not offer keyless enrolment (a 404, which hides the route). */
    public data object EnrollDisabled : ActivationResult {
        override val code: String get() = ErrorCode.enrollDisabled
    }

    /**
     * 403 `enroll_claimed`: this machine's free licence now belongs to an account. Signing in reaches
     * it; enrolling again does not.
     */
    public data object EnrollClaimed : ActivationResult {
        override val code: String get() = ErrorCode.enrollClaimed
    }

    /** 403 `license_disabled`: an operator disabled the licence (or License is off for the product). */
    public data object LicenseDisabled : ActivationResult {
        override val code: String get() = ErrorCode.licenseDisabled
    }

    /** 403 `license_expired`: the licence ran out. */
    public data object LicenseExpired : ActivationResult {
        override val code: String get() = ErrorCode.licenseExpired
    }

    /** 403 `attestation_required`: the product requires an attested device (`devices.attest`). */
    public data object AttestationRequired : ActivationResult {
        override val code: String get() = ErrorCode.attestationRequired
    }

    /** 429 `rate_limited`: retry after [retryAfterSeconds] when the server said. */
    public data class RateLimited(val retryAfterSeconds: Long?) : ActivationResult {
        override val code: String get() = ErrorCode.rateLimited
    }

    /** Any other 4xx: the server's own registry [code] (e.g. `registration_closed`), kept verbatim. */
    public data class Refused(override val code: String, val status: Int, val message: String?) : ActivationResult

    /**
     * Transport failure (`code` = `network`), a 5xx or an unreadable answer (`server-error`). Both are
     * client-kind registry codes (`conformance/parity/errors.json`, `ErrorCode.network` and
     * `ErrorCode.serverError`). [message] is for logs only: a kit shows copy for [code], never this text.
     */
    public data class Error(val message: String, override val code: String = ErrorCode.serverError, val status: Int? = null) : ActivationResult
}

public object LicenseEndpoints {
    /** `POST /<p>/license/activate`: exchange a licence key for a per-device `pkeyt_` token. */
    public suspend fun activate(core: CoreContext, key: String, fingerprint: HardwareFingerprint? = null): ActivationResult =
        // PX-W13 §8 Q2: the label seeds the device's name in the customer's and console's lists.
        activationLike(core, core.endpoints.licenseActivate, mapOf("authorization" to "Bearer $key"), fingerprint, core.deviceLabel())

    /** `POST /<p>/license/enroll`: a licence with no key and no sign-in; the same shape as [activate]. */
    public suspend fun enroll(core: CoreContext, fingerprint: HardwareFingerprint? = null): ActivationResult =
        activationLike(core, core.endpoints.licenseEnroll, emptyMap(), fingerprint)

    /** `POST /<p>/license/token`: rotate the current device token. The §5 single re-acquire. */
    public suspend fun reacquireToken(core: CoreContext, token: String): ActivationResult =
        activationLike(core, core.endpoints.licenseToken, mapOf("authorization" to "Bearer $token"), null)

    /**
     * `POST /<p>/license/deauthorize`: release this device's seat. Best-effort: the LOCAL wipe is
     * what the caller depends on, so a transport failure (and the local-only refusal, §7.3) is
     * swallowed here, as being offline is.
     */
    public suspend fun deauthorize(core: CoreContext, token: String) {
        try {
            core.request(core.endpoints.licenseDeauthorize, method = "POST", headers = mapOf("authorization" to "Bearer $token"))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Best-effort by design.
        }
    }

    /** The three mint and rotate endpoints share a response ladder, so they share a reader. */
    private suspend fun activationLike(
        core: CoreContext,
        url: String,
        extra: Map<String, String>,
        fingerprint: HardwareFingerprint?,
        deviceName: String? = null,
    ): ActivationResult {
        val headers = LinkedHashMap(extra)
        // No fingerprint and no label, no body: a host that opted out sends a byte-identical
        // request to one that has nothing to report.
        val body = deviceRequestBody(fingerprint, deviceName)
        if (body != null) headers["content-type"] = "application/json"
        val response = try {
            core.request(url, method = "POST", headers = headers, body = body)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return ActivationResult.Error(e.message ?: "transport error", ErrorCode.network)
        }
        return activationResult(response)
    }

    /**
     * The §3.1 ladder over one answer, by the body's `error` code (flat or nested), the status only
     * where the body names no code. Public so every SDK's unit table runs the same vectors.
     */
    public fun activationResult(response: PolarisResponse): ActivationResult {
        val o = JsonText.parseOrNull(response.text).objectValue
        // `error` is a bare code string in the flat shape and an object in the nested one.
        val nested = o?.get("error").objectValue
        val code = (o?.get("error").stringValue ?: nested?.get("code").stringValue)?.takeIf { it.isNotEmpty() }
        val message = o?.get("message").stringValue ?: nested?.get("message").stringValue
        fun long(name: String) = o?.get(name).longValue ?: nested?.get(name).longValue
        val status = response.status
        if (status == 200) {
            val token = o?.get("token").stringValue
            val schemaVersion = o?.get("schemaVersion").longValue
            return if (token == null || schemaVersion == null) ActivationResult.Error("malformed activation response", ErrorCode.serverError, status)
            else ActivationResult.Ok(token, schemaVersion)
        }
        if (status >= 500 || status < 400) return ActivationResult.Error("activation answered HTTP $status", ErrorCode.serverError, status)
        return when (code) {
            ErrorCode.deviceLimit -> ActivationResult.DeviceLimit(long("limit"), long("deviceCount"))
            ErrorCode.fingerprintRequired -> ActivationResult.FingerprintRequired
            ErrorCode.hardwareMismatch -> ActivationResult.HardwareMismatch(
                drift = long("drift"),
                changed = (o?.get("changed").arrayValue ?: nested?.get("changed").arrayValue)?.mapNotNull { it.stringValue },
            )
            ErrorCode.enrollClaimed -> ActivationResult.EnrollClaimed
            ErrorCode.licenseDisabled -> ActivationResult.LicenseDisabled
            ErrorCode.licenseExpired -> ActivationResult.LicenseExpired
            ErrorCode.attestationRequired -> ActivationResult.AttestationRequired
            ErrorCode.rateLimited -> ActivationResult.RateLimited(
                long("retryAfter") ?: response.header("retry-after")?.trim()?.toLongOrNull(),
            )
            ErrorCode.unauthorized -> ActivationResult.Unauthorized
            ErrorCode.enrollDisabled -> ActivationResult.EnrollDisabled
            null -> when (status) {
                // A body with no code: the bare statuses this route family answers.
                401 -> ActivationResult.Unauthorized
                404 -> ActivationResult.EnrollDisabled
                409 -> ActivationResult.HardwareMismatch(long("drift"), null)
                429 -> ActivationResult.RateLimited(response.header("retry-after")?.trim()?.toLongOrNull())
                else -> ActivationResult.Refused(ErrorCode.unknown, status, message)
            }
            else -> ActivationResult.Refused(code, status, message)
        }
    }
}
