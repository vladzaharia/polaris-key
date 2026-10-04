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
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.requestBody
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException

/** The outcome of an activation-like call (`/license/{activate,enroll,token}`). */
public sealed interface ActivationResult {
    public data class Ok(val token: String, val schemaVersion: Long) : ActivationResult {
        override fun toString(): String = "Ok(token=[redacted], schemaVersion=$schemaVersion)"
    }

    public data class DeviceLimit(val limit: Long?, val deviceCount: Long?) : ActivationResult
    public data object Unauthorized : ActivationResult

    /** The tier requires a hardware fingerprint this host could not produce. */
    public data object FingerprintRequired : ActivationResult

    /**
     * Hardware drifted past the tier's tolerance and the binding was retired. Retrying activation
     * re-binds the new hardware and consumes a seat (the Worker answers 409 because it is retryable).
     */
    public data class HardwareMismatch(val drift: Long?, val changed: List<String>?) : ActivationResult

    /** The product does not offer keyless enrolment (a 404, which hides the route). */
    public data object EnrollDisabled : ActivationResult
    public data class Error(val message: String) : ActivationResult
}

public object LicenseEndpoints {
    /** `POST /<p>/license/activate`: exchange a licence key for a per-device `pkeyt_` token. */
    public suspend fun activate(core: CoreContext, key: String, fingerprint: HardwareFingerprint? = null): ActivationResult =
        activationLike(core, core.endpoints.licenseActivate, mapOf("authorization" to "Bearer $key"), fingerprint)

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
    ): ActivationResult {
        val headers = LinkedHashMap(extra)
        var body: ByteArray? = null
        // No fingerprint, no body: a host that opted out sends a byte-identical request to one
        // that has nothing to report.
        if (fingerprint != null) {
            headers["content-type"] = "application/json"
            body = fingerprint.requestBody()
        }
        val response = try {
            core.request(url, method = "POST", headers = headers, body = body)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return ActivationResult.Error(e.message ?: "transport error")
        }
        val o = JsonText.parseOrNull(response.text).objectValue
        // `error` is a bare code string in the flat shape and an object in the nested one.
        val nested = o?.get("error").objectValue
        return when (response.status) {
            200 -> {
                val token = o?.get("token").stringValue
                val schemaVersion = o?.get("schemaVersion").longValue
                if (token == null || schemaVersion == null) ActivationResult.Error("malformed activation response")
                else ActivationResult.Ok(token, schemaVersion)
            }
            409 -> ActivationResult.HardwareMismatch(
                drift = o?.get("drift").longValue ?: nested?.get("drift").longValue,
                changed = (o?.get("changed").arrayValue ?: nested?.get("changed").arrayValue)?.mapNotNull { it.stringValue },
            )
            403 -> {
                val code = o?.get("error").stringValue ?: nested?.get("code").stringValue
                if (code == ErrorCode.fingerprintRequired) {
                    ActivationResult.FingerprintRequired
                } else {
                    ActivationResult.DeviceLimit(
                        limit = o?.get("limit").longValue ?: nested?.get("limit").longValue,
                        deviceCount = o?.get("deviceCount").longValue ?: nested?.get("deviceCount").longValue,
                    )
                }
            }
            401 -> ActivationResult.Unauthorized
            404 -> ActivationResult.EnrollDisabled
            else -> ActivationResult.Error(response.text)
        }
    }
}
