// `identity.choice.*` (I-10b.19; WIRE-CONTRACT-V4 §12.5.1): the licence choice an app shows itself
// after `signIn.start(SignInOptions(channel = Redirect, licenseChoice = "app"))` settled
// `SignInOutcome.Choose`.
//
//   licenses(grant)            the licences the account can run this device on (a view)
//   devices(grant, licenseId)  a full licence's seated devices, for Replace (a view)
//   complete(grant, choice)    the person's choice: License (+ replaceDeviceId), Keep, Create or Key;
//                              the device token is stored like a sign-in
//   cancel(grant)              give the grant up; no token, nothing stored
//
// Each call dials the endpoint discovery names, never one it builds, and throws the typed
// `service-unavailable` N/A (`Feature.identityChoice`, reason `product`) before any request when
// discovery has none (the session then ran in card mode and never issued a grant). The grant is the
// credential: no device bearer is sent (but for `keep`, which the device proves with its own token), and the
// grant is never printed or put in an error message.
//
// A refusal the Worker answers (`invalid_grant`, `license_choice_required`, `not_found`, `device_limit`,
// `rate_limited`, `license_owned`, `key_entry_limit`, ...) is a RESULT, `ChoiceResult.Refused`, like
// `attach`. After `device_limit` and `license_choice_required` it carries the fresh view to choose
// from again. A refused `complete` keeps the device token, the cache and the stored subject: only an
// `Ok` completion changes state. A network failure or a 5xx throws, the grant still spendable.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.ceil

/** The person's explicit choice (the wire's `LicenseChoiceInput`). */
public sealed interface LicenseChoice {
    /** Run this device on [licenseId]; on a full licence [replaceDeviceId] names the seated device to remove. */
    public data class License @JvmOverloads constructor(val licenseId: String, val replaceDeviceId: String? = null) : LicenseChoice

    /** Keep the licence the device already has (it stays outside the account; `attach` may follow). */
    public data object Keep : LicenseChoice

    /** Get a new licence (the product's free one). */
    public data object Create : LicenseChoice

    /** Add a licence key. `toString` redacts it. */
    public data class Key(val key: String) : LicenseChoice {
        override fun toString(): String = "Key(key=[redacted])"
    }

    /** The request's `choice` member. */
    public fun toJson(): JsonObject = when (this) {
        is License -> JsonObject(
            buildMap {
                put("kind", JsonPrimitive("license"))
                put("licenseId", JsonPrimitive(licenseId))
                replaceDeviceId?.let { put("replaceDeviceId", JsonPrimitive(it)) }
            },
        )

        Keep -> JsonObject(mapOf("kind" to JsonPrimitive("keep")))

        Create -> JsonObject(mapOf("kind" to JsonPrimitive("create")))

        is Key -> JsonObject(mapOf("kind" to JsonPrimitive("key"), "key" to JsonPrimitive(key)))
    }

    public companion object {
        /** A wire `choice` object back to its choice; null when it is not one of the four kinds. */
        @JvmStatic
        public fun fromJson(o: JsonObject?): LicenseChoice? = when (o?.get("kind").stringValue) {
            "license" -> o!!["licenseId"].stringValue?.let { License(it, o["replaceDeviceId"].stringValue) }
            "keep" -> Keep
            "create" -> Create
            "key" -> o!!["key"].stringValue?.let { Key(it) }
            else -> null
        }
    }
}

/**
 * The app consent a `complete` records (V5 section 12.11.3 rule 2): the claims the person agreed to share,
 * a subset of what the consent view listed.
 */
public data class ConsentInput(val claims: List<String>) {
    /** The request's `consent` member. */
    public fun toJson(): JsonObject = JsonObject(mapOf("claims" to kotlinx.serialization.json.JsonArray(claims.map { JsonPrimitive(it) })))
}

/** The licences a grant can choose from. [raw] is the Worker's view as served (what `:ui-core`'s `KitRows` reads). */
public data class LicenseChoiceView(val state: String, val choices: List<JsonObject>, val raw: JsonObject) {
    /** The ids of [choices], in order. */
    public val licenseIds: List<String> get() = choices.mapNotNull { it["id"].stringValue }

    /** Redacted: [raw] holds other devices' labels. */
    override fun toString(): String = "LicenseChoiceView(state=$state, choices=${choices.size}, raw=[redacted])"

    public companion object {
        /** A wire view (`state`, `choices`, ...) read as one; null when it is not one. */
        @JvmStatic
        public fun of(o: JsonObject?): LicenseChoiceView? {
            val state = o?.get("state").stringValue
            val choices = o?.get("choices").arrayValue
            return if (o == null || state == null || choices == null) null else LicenseChoiceView(state, choices.mapNotNull { it.objectValue }, o)
        }
    }
}

/** The devices seated on a full licence. [raw] is the Worker's view as served. */
public data class ReplaceView(val licenseId: String, val devices: List<JsonObject>, val raw: JsonObject) {
    /** The ids of [devices], in order. */
    public val deviceIds: List<String> get() = devices.mapNotNull { it["id"].stringValue }

    /** Redacted: the devices carry labels. */
    override fun toString(): String = "ReplaceView(licenseId=$licenseId, devices=${devices.size}, raw=[redacted])"
}

/** A licence's key-entry count (`identity.keyentry`). */
public data class ChoiceKeyEntries(val used: Long, val limit: Long)

/** What a finished choice signed in. */
public data class ChoiceCompleted(
    /** The licence the device now runs on, or null on a device with none. */
    val licenseId: String?,
    /** The pairwise account subject (`ps_…`). */
    val subject: String,
    val scope: String,
    /** After a [LicenseChoice.Key]: the licence's key-entry count. */
    val keyEntries: ChoiceKeyEntries? = null,
    /** True after [LicenseChoice.Keep]: the device kept a licence outside the account, so `attach` may follow. Never true otherwise. */
    val attachable: Boolean = false,
)

/** A choice call's answer: the value, or the Worker's refusal as a result. */
public sealed interface ChoiceResult<out T> {
    public data class Ok<out T>(val value: T) : ChoiceResult<T>

    /** The Worker said no. Only the members its answer carried are set. */
    public data class Refused(
        /**
         * The wire code: `invalid_grant`, `license_choice_required`, `not_found`, `device_limit`, `rate_limited`,
         * `license_owned`, `key_entry_limit`, ...
         */
        val code: String,
        val httpStatus: Int,
        /** `rate_limited`: seconds to wait. */
        val retryAfterSeconds: Int? = null,
        /** `device_limit` and `license_choice_required`: the fresh view to choose from again. */
        val view: LicenseChoiceView? = null,
        /** `device_limit`, `key_entry_limit`: the portal link that frees a seat or an entry. */
        val manageUrl: String? = null,
        /** `license_owned`: where to sign in to the account that owns the licence. */
        val signInUrl: String? = null,
        /** `key_entry_limit`. */
        val keyEntries: ChoiceKeyEntries? = null,
    ) : ChoiceResult<Nothing>
}

private enum class ChoiceEndpoint(val key: String) {
    Licenses("choiceLicenses"),
    Devices("choiceDevices"),
    Complete("choiceComplete"),
    Cancel("choiceCancel"),
}

/** `client.identity.choice`. */
public class ChoiceClient internal constructor(private val client: IdentityClient) {
    private val core: CoreContext get() = client.core

    /** The licences the account can run this device on. Counts against the grant's read budget. */
    public suspend fun licenses(grant: String): ChoiceResult<LicenseChoiceView> {
        val res = post(ChoiceEndpoint.Licenses, mapOf("grant" to JsonPrimitive(grant)))
        if (res.status != 200) return refusal(res, "choice licenses")
        return ChoiceResult.Ok(LicenseChoiceView.of(JsonText.parseOrNull(res.text).objectValue) ?: throw unreadable("licenses"))
    }

    /** The devices seated on a full licence, for Replace. A licence outside the grant's view is `Refused` with `not_found`. */
    public suspend fun devices(grant: String, licenseId: String): ChoiceResult<ReplaceView> {
        val res = post(ChoiceEndpoint.Devices, mapOf("grant" to JsonPrimitive(grant), "licenseId" to JsonPrimitive(licenseId)))
        if (res.status != 200) return refusal(res, "choice devices")
        val raw = JsonText.parseOrNull(res.text).objectValue
        val id = raw?.get("licenseId").stringValue
        val devices = raw?.get("devices").arrayValue
        if (raw == null || id == null || devices == null) throw unreadable("devices")
        return ChoiceResult.Ok(ReplaceView(id, devices.mapNotNull { it.objectValue }, raw))
    }

    /**
     * Finish with the person's choice. On `Ok` the device token is stored, the subject is persisted and the
     * acquisition sync runs, exactly as after a sign-in. The grant is spent on `Ok`; a refusal the person can
     * fix (`device_limit`, `license_choice_required`, a wrong key) leaves it open.
     *
     * The person's app [consent] rides with the choice (required on a grant `exchange` issued as `PendingConsent`,
     * where [choice] may be null; a licence choice then due answers `license_choice_required` with the view and
     * keeps the grant open). The Worker refuses a request that omits what its grant needs.
     */
    @JvmOverloads
    public suspend fun complete(grant: String, choice: LicenseChoice?, consent: ConsentInput? = null): ChoiceResult<ChoiceCompleted> =
        completeWire(grant, choice?.toJson(), consent?.toJson())

    /** Conformance replay only: a completion with the recorded `choice` member, or none (the Worker's 409 `license_choice_required`). */
    @ConformanceReplayOnly
    public suspend fun completeRecorded(grant: String, choice: JsonObject?): ChoiceResult<ChoiceCompleted> = completeWire(grant, choice, null)

    private suspend fun completeWire(grant: String, choice: JsonObject?, consent: JsonObject?): ChoiceResult<ChoiceCompleted> {
        val body = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        body["grant"] = JsonPrimitive(grant)
        // A null choice is the conformance replay's, for the recorded completion that names none.
        choice?.let { body["choice"] = it }
        consent?.let { body["consent"] = it }
        // `keep` is proven by the device's own token (the Worker reads it as held); every other choice is made on the grant alone.
        val held = if (choice?.get("kind").stringValue == "keep") core.token() else null
        val res = post(ChoiceEndpoint.Complete, body, held)
        if (res.status != 200) return refusal(res, "choice complete")
        val json = JsonText.parseOrNull(res.text)
        val answer = IdentityRedirect.parseTokenAnswer(200, json)
        if (answer !is TokenAnswer.Token) throw PolarisException(ErrorCode.badResponse, "choice complete answered without a complete sign-in.")
        val o = json.objectValue
        val entries = o?.get("keyEntries").objectValue?.let { counts(it) }
        if (core.storeSignIn(answer.accessToken, answer.subject, TokenSource.signin, personInitiated = true)) client.onSubject(answer.subject)
        if (client.redirectAcquisitionSyncValue) client.onAcquired?.invoke()
        return ChoiceResult.Ok(
            ChoiceCompleted(
                licenseId = answer.license?.get("id").stringValue,
                subject = answer.subject,
                scope = answer.scope,
                keyEntries = entries,
                attachable = choice != null && choice["kind"].stringValue == "keep",
            ),
        )
    }

    /** Give the grant up. Nothing is stored; the sign-in is over. */
    public suspend fun cancel(grant: String): ChoiceResult<Unit> {
        val res = post(ChoiceEndpoint.Cancel, mapOf("grant" to JsonPrimitive(grant)))
        if (res.status == 204 || res.status == 200) return ChoiceResult.Ok(Unit)
        return refusal(res, "choice cancel")
    }

    /** The discovery endpoint, else the typed N/A. Nothing is dialled before this answers. */
    private suspend fun endpoint(name: ChoiceEndpoint): String {
        if (core.discoveryDocument() == null) {
            try {
                core.discover()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // `requireService` below answers for a product whose discovery is unknown.
            }
        }
        core.requireService(ServiceSlug.identity, Feature.identityChoice)
        val url = core.discoveryDocument()?.identity?.endpoints?.get(name.key)
        if (url.isNullOrEmpty()) {
            val unsupported =
                Unsupported(Feature.identityChoice, UnsupportedReason.product, "this product's discovery names no identity ${name.key} endpoint")
            throw PolarisException(
                ErrorCode.serviceUnavailable,
                "The identity ${name.key} endpoint is not served for ${core.product}.",
                detail = unsupported.detail,
                unsupported = unsupported,
            )
        }
        return url
    }

    private suspend fun post(
        name: ChoiceEndpoint,
        body: Map<String, kotlinx.serialization.json.JsonElement>,
        bearer: String? = null,
    ): PolarisResponse {
        val url = endpoint(name)
        return try {
            // No authorization header but for `keep`: the grant in the body is the credential.
            core.request(
                url,
                method = "POST",
                headers = buildMap {
                    put("content-type", "application/json")
                    if (!bearer.isNullOrEmpty()) put("authorization", "Bearer $bearer")
                },
                body = JsonObject(body).toString().toByteArray(Charsets.UTF_8),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            if (e.code == ErrorCode.localOnly) throw e
            throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
        } catch (e: Exception) {
            throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
        }
    }

    /** A non-2xx answer: a 5xx throws; a 4xx is the Worker's refusal as a result. */
    private fun refusal(res: PolarisResponse, what: String): ChoiceResult.Refused {
        if (res.status >= 500) throw PolarisException(ErrorCode.serverError, "$what failed with status ${res.status}.")
        val b = JsonText.parseOrNull(res.text).objectValue
        val error = b?.get("error")
        val code = error.objectValue?.get("code").stringValue ?: error.stringValue ?: "http_${res.status}"
        val bodyRetry = b?.get("retryAfter").let { v ->
            (v as? JsonPrimitive)?.content?.toDoubleOrNull()?.takeIf { it > 0 }?.let { ceil(it).toInt() }
        }
        val retry = bodyRetry ?: res.header("retry-after")?.trim()?.toIntOrNull()?.takeIf { it > 0 }
        return ChoiceResult.Refused(
            code = code,
            httpStatus = res.status,
            retryAfterSeconds = retry,
            view = LicenseChoiceView.of(b?.get("view").objectValue),
            manageUrl = b?.get("manageUrl").stringValue,
            signInUrl = b?.get("signInUrl").stringValue,
            keyEntries = b?.get("keyEntries").objectValue?.let { counts(it) },
        )
    }

    private fun unreadable(what: String) = PolarisException(ErrorCode.badResponse, "choice $what answered without a readable view.")
}

private fun counts(o: JsonObject): ChoiceKeyEntries? {
    val used = o["used"].longValue
    val limit = o["limit"].longValue
    return if (used != null && limit != null) ChoiceKeyEntries(used, limit) else null
}
