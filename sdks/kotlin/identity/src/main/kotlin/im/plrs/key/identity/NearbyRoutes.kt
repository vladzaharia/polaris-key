// The nearby approval routes for the new device D (WIRE-CONTRACT-V5 section 12.11.5; I-45.12): `nearby/start` and
// `nearby/poll`. This is the HTTP half of nearby sign-in; the LAN half (adverts, the code, `VOUCH_REQ`) is CC-15's
// `NearbyRequest`, and `NearbySignInSession` (NearbySignIn.kt) joins the two. Mirrors sdk-node's
// `identity/nearby.ts`. `nearby/approve` is the approving device's (I-45.13): it takes only a [NearbyVouch], the permit
// of a code the person matched, and sends D's handle, device id and keys from it and from nothing else.
//
// What this file keeps:
//  - an endpoint is used only when discovery names it, and a product whose discovery names none answers the typed
//    `service-unavailable` N/A before any request;
//  - every route carries a `pkey-proof/1` proof (section 12.11.1) signed through the device key port, so a private
//    key never leaves it. `start`: value `<signKey>.<agreeKey>`; `poll`: the request handle. Line 6 is `-`;
//  - `poll` is signed by the key D sent on `start`: the handle remembers that `signKey`, and a poll after the
//    device's keys changed is refused locally rather than sent;
//  - `start` sends D's bearer when D holds a credential, and never invents one;
//  - `poll` answers the token once, and holds it UNCONFIRMED (`CoreContext.setUnconfirmedToken`): no stored
//    subject, no `signedIn` event and no Sync or Connect until the person confirms the account;
//  - a 404 on `poll` is "the request is unknown" or "the routes went away", the same bytes (N11): it means
//    unavailable only after a fresh discovery read no longer names nearby;
//  - the request handle, the proofs and the token are in no `toString`, log or error message.

@file:Suppress(
    "TooGenericExceptionCaught",
    "SwallowedException",
    "ThrowsCount",
    "ReturnCount",
    "MagicNumber",
    "ComplexCondition",
    "CyclomaticComplexMethod",
    "LongParameterList",
    "TooManyFunctions",
)

package im.plrs.key.identity

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceProofException
import im.plrs.key.core.DeviceProofFields
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.HeaderName
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.boolValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.peer.nearby.ApproveAnswerInput
import im.plrs.key.core.peer.nearby.NearbyApprovalHandler
import im.plrs.key.core.peer.nearby.NearbyApproverHandle
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyRequest
import im.plrs.key.core.peer.nearby.NearbyRequestOptions
import im.plrs.key.core.peer.nearby.RequesterSigner
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The two sides of nearby approval `identity.nearby.available` asks about. */
public enum class NearbyRole { Requester, Approver }

/** The key ring's answer to the wrap an approver sent over the LAN: true when the ring opened it. */
public fun interface NearbyWrapAdopter {
    public suspend fun adopt(record: ByteArray): Boolean
}

/** A wrap of this device's key ring root, sealed to the new device and not yet stored. */
public class NearbySealedWrap(
    /** The `KEYRING_WRAP` (`0x0030`) record body. */
    public val record: ByteArray,
    /** Stores the same wrap as the server's copy (`PUT`). */
    public val store: suspend () -> Unit,
) {
    override fun toString(): String = "NearbySealedWrap"
}

/** The key ring's half of an approval: seals the root to D, or answers null when this device holds no root. */
public fun interface NearbyWrapSealer {
    public suspend fun seal(deviceId: String, agreeKey: String): NearbySealedWrap?
}

/**
 * What the facade gives the identity client for nearby sign-in: the LAN request (`cloudConnect.nearby.request`), D's
 * device keys and id, whether this runtime can discover, and, once the key ring can take a channel wrap, the adopter.
 * The identity module cannot reach the Connect module, so the facade installs this (`IdentityClient.installNearby`).
 */
public class NearbyHost @JvmOverloads constructor(
    public val request: suspend (NearbyRequestOptions) -> NearbyRequest,
    public val signer: suspend () -> RequesterSigner,
    public val runtime: suspend (NearbyRole) -> Boolean,
    public val wrap: NearbyWrapAdopter? = null,
    /** The approving device's LAN half (`cloudConnect.nearby.onRequest`). Null: `identity.nearby.onRequest` answers `nearby-unsupported`. */
    public val approver: (suspend (NearbyApprovalHandler, NearbyApproverOptions) -> NearbyApproverHandle)? = null,
    /** Registers this device's keys with the Worker (a `device_keys_required` answer of `nearby/approve`). */
    public val registerKeys: (suspend () -> Unit)? = null,
    /** The key ring's half of an approval (see [NearbyWrapSealer]). Null: no wrap is sent. */
    public val sealer: NearbyWrapSealer? = null,
) {
    override fun toString(): String = "NearbyHost"
}

/** `nearby/start`'s answer. [request] is a secret: it prints as nothing. */
internal class NearbyStarted(val request: String, val expiresIn: Long, val interval: Long, val signKey: String) {
    override fun toString(): String = "NearbyStarted(expiresIn=$expiresIn, interval=$interval)"
}

/** The account as the server shows it, for D's person to confirm (section 15.6.1 rule 12). Display data. */
public data class ShownIdentity(val name: String? = null, val email: String? = null)

/** One `nearby/poll` answer. A denial and a lapse are outcomes, not errors. */
internal sealed interface NearbyPoll {
    data object Pending : NearbyPoll

    data class SlowDown(val interval: Long) : NearbyPoll

    data object Timeout : NearbyPoll

    data object Denied : NearbyPoll

    /** The routes went away (a 404 after a fresh discovery lost `nearby`). */
    data object Unavailable : NearbyPoll

    /** The poll stored [token] under the unconfirmed mark. */
    class Ready(val token: String, val subject: String, val scope: String, val licenseId: String?, val identity: ShownIdentity) : NearbyPoll {
        override fun toString(): String = "Ready(token=[redacted], scope=$scope)"
    }
}

private const val START = "nearbyStart"
private const val POLL = "nearbyPoll"
private const val APPROVE = "nearbyApprove"
private val KEY = Regex("[A-Za-z0-9_-]{43}")
private val REQUEST = Regex("nr_[A-Za-z0-9_-]{22}")
private val SUBJECT = Regex("ps_[A-Za-z0-9_-]{22}")

private fun typedUnavailable(detail: String): PolarisException {
    val u = Unsupported(Feature.identityNearby, UnsupportedReason.product, detail)
    return PolarisException(ErrorCode.serviceUnavailable, "Nearby approval is not available here.", detail = detail, unsupported = u)
}

/** The conformance replay's way to sign a proof by another key or over another value; null signs through the key port. */
internal fun interface NearbyProofSigner {
    suspend fun sign(port: DeviceKeyPort, fields: DeviceProofFields): String
}

internal class NearbyRoutes(private val client: IdentityClient) {
    private val core get() = client.core

    /** Set when `start` was answered 404 (the operator's launch gate went off): a later 404 from `approve` is the same answer. */
    @Volatile private var gateOff = false

    /** Replay only: see [NearbyProofSigner]. */
    @Volatile var signProof: NearbyProofSigner? = null

    private fun host(): NearbyHost = client.nearbyHost.get()
        ?: throw PolarisException(ErrorCode.nearbyUnsupported, "Nearby approval is not set up on this client.")

    /** The endpoint discovery names, else the typed N/A. Nothing is sent before this answers. */
    private suspend fun endpoint(name: String, fresh: Boolean = false): String {
        if (fresh || core.discoveryDocument() == null) {
            try {
                core.discover()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // An unreachable Worker is not "nearby is off": what discovery last said stands.
            }
        }
        core.requireService(ServiceSlug.identity, Feature.identityNearby)
        val f = core.discoveryDocument()?.services?.get(ServiceSlug.identity)
        val url = f?.endpoints?.get(name)
        if (f == null || !f.enabled || f.extras["nearby"].boolValue != true || url.isNullOrEmpty()) {
            throw typedUnavailable("this product's discovery does not name nearby approval")
        }
        // The device's headers go to this product only.
        if (!url.startsWith(core.endpoints.url(""))) throw PolarisException(ErrorCode.badResponse, "the $name endpoint points outside this product.")
        return url
    }

    /** A fresh read: does discovery still name `nearby` and [name]? */
    private suspend fun stillNamed(name: String): Boolean = try {
        endpoint(name, fresh = true)
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        false
    }

    private suspend fun proof(port: DeviceKeyPort, purpose: DeviceProofPurpose, deviceId: String, value: String): String {
        signProof?.let { return it.sign(port, DeviceProofFields(purpose.wire, core.product, deviceId, value)) }
        return try {
            DeviceProofs.sign(port, purpose, core.product, deviceId, value).sig
        } catch (e: DeviceProofException) {
            throw PolarisException(ErrorCode.invalidArgument, "The nearby proof could not be built.")
        }
    }

    /**
     * `POST nearby/start`: D asks to be approved, sending its two public keys. Throws the typed N/A when discovery
     * names no nearby approval or the route is off (`404`), and the Worker's code for a refusal (`invalid_grant`,
     * `device_keys_invalid`, `rate_limited`, ...).
     */
    suspend fun start(deviceName: String?): NearbyStarted {
        val url = endpoint(START)
        endpoint(POLL)
        val signer = host().signer()
        val keys = try {
            signer.port.ensure()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw PolarisException(ErrorCode.deviceKeysUnreadable, "The device keys could not be read.")
        }
        val body = linkedMapOf<String, kotlinx.serialization.json.JsonElement>(
            "signKey" to JsonPrimitive(keys.signKey),
            "agreeKey" to JsonPrimitive(keys.agreeKey),
        )
        // Section 12.7.1: the per-call name, else the client's, else the platform default; "" sends none.
        core.deviceLabel(deviceName)?.takeIf { it.isNotEmpty() }?.let { body["deviceName"] = JsonPrimitive(it) }
        body["proof"] = JsonPrimitive(proof(signer.port, DeviceProofPurpose.nearbyStart, signer.deviceId, "${keys.signKey}.${keys.agreeKey}"))
        // A device id that already holds a credential proves it by that bearer.
        val bearer = core.token()
        val res = client.exchangePost(
            url,
            contentType("application/json") + (bearer?.let { mapOf("authorization" to "Bearer $it") } ?: emptyMap()),
            JsonObject(body).toString().toByteArray(Charsets.UTF_8),
        )
        // The gate is off (the Worker rolled back after our discovery): start has no other 404.
        if (res.status == 404) {
            gateOff = true
            throw typedUnavailable("this product does not serve nearby approval")
        }
        if (res.status != 201) throw refusal(res, "nearby start")
        val b = JsonText.parseOrNull(res.text).objectValue
        val handle = b?.get("request").stringValue
        val expiresIn = wholeSeconds(b?.get("expiresIn"))
        val interval = wholeSeconds(b?.get("interval"))
        if (handle == null || !REQUEST.matches(handle) || expiresIn == null || interval == null) {
            throw PolarisException(ErrorCode.badResponse, "nearby start answered without a complete request.")
        }
        return NearbyStarted(handle, expiresIn, interval, keys.signKey)
    }

    /**
     * `POST nearby/poll`: one poll of D's request, signed by the key D started it with. A token is stored UNCONFIRMED
     * and answered once as [NearbyPoll.Ready]. A `429` is slow-down (with the interval to use); a `5xx` throws
     * `server-error` with the `Retry-After` in `retryAfterSeconds` and the request kept; pacing is the caller's.
     */
    suspend fun poll(started: NearbyStarted): NearbyPoll {
        val url = endpoint(POLL)
        val signer = host().signer()
        val keys = signer.port.publicKeys()
        if (keys == null || keys.signKey != started.signKey) {
            throw PolarisException(ErrorCode.signInFailed, "this device's keys changed since nearby sign-in started.")
        }
        val proof = proof(signer.port, DeviceProofPurpose.nearbyPoll, signer.deviceId, started.request)
        val res = client.exchangePost(
            url,
            contentType("application/json"),
            JsonObject(mapOf("request" to JsonPrimitive(started.request), "proof" to JsonPrimitive(proof))).toString().toByteArray(Charsets.UTF_8),
        )
        if (res.status == 404) {
            // N11: the same bytes whether the request is unknown or the routes went away.
            if (!stillNamed(POLL)) return NearbyPoll.Unavailable
            throw refusal(res, "nearby poll")
        }
        if (res.status >= 500 || (res.status != 200 && res.status != 429)) throw refusal(res, "nearby poll")
        val answer = JsonText.parseOrNull(res.text).objectValue
        if (res.status == 429) return NearbyPoll.SlowDown(wholeSeconds(answer?.get("interval")) ?: (started.interval + SLOW_DOWN_STEP_SECONDS))
        if (answer == null) throw PolarisException(ErrorCode.badResponse, "nearby poll answered without a body.")
        when (answer["status"].stringValue) {
            "pending" -> return NearbyPoll.Pending

            "timeout" -> return NearbyPoll.Timeout

            "error" -> {
                if (answer["reason"].stringValue == "access_denied") return NearbyPoll.Denied
                throw PolarisException(ErrorCode.signInFailed, "nearby sign-in failed.")
            }

            null -> Unit

            else -> throw PolarisException(ErrorCode.signInFailed, "nearby sign-in failed.")
        }
        val t = IdentityRedirect.parseTokenAnswer(200, answer)
        if (t !is TokenAnswer.Token || !SUBJECT.matches(t.subject)) {
            throw PolarisException(ErrorCode.badResponse, "nearby poll answered without a complete sign-in.")
        }
        // Held unconfirmed (section 15.6.1 rule 12): not a sign-in, no stored subject and no `signedIn` event until the
        // person confirms the account (`NearbySignInSession.confirmAccount`), so Sync and Connect do not start for an
        // account nobody has accepted. A mark that cannot be written fails the poll with nothing stored.
        // Whoever was signed in here before is not any more: the facade hears of it.
        if (core.setUnconfirmedToken(t.accessToken)) client.onSubject(null)
        try {
            // The acquisition sync (the licence documents). A failure here is not the sign-in's: the token is stored.
            if (client.redirectAcquisitionSyncValue) client.onAcquired?.invoke()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The next sync repeats it.
        }
        return NearbyPoll.Ready(
            t.accessToken,
            t.subject,
            t.scope,
            t.license?.get("id").stringValue,
            ShownIdentity(
                t.license?.get("name").stringValue?.takeIf {
                    it.isNotEmpty()
                },
                t.license?.get("email").stringValue?.takeIf { it.isNotEmpty() },
            ),
        )
    }

    /**
     * `POST nearby/approve` from the approving device M. [vouch] is the permit of a matched pick (rule 10: no silent
     * approval): D's handle, device id and keys are taken from it and from nothing else, so they are exactly what D's
     * verified `VOUCH_REQ` named (the Worker compares them with what D sent on `start`). [decision] is `approve` or
     * `deny`; [choice] is the licence or `create` after a choose. A `409 device_keys_required` registers M's keys once
     * (when the host can) and asks again once, never again.
     */
    suspend fun approve(creds: NearbyCreds, vouch: NearbyVouch, decision: String, choice: JsonObject?): NearbyApprove {
        if (decision != "approve" && decision != "deny") throw PolarisException(ErrorCode.invalidOptions, "nearby: decision must be approve or deny.")
        if (!KEY.matches(vouch.signKey) || !KEY.matches(vouch.agreeKey) || vouch.deviceId.isEmpty() || !REQUEST.matches(vouch.request)) {
            throw PolarisException(ErrorCode.invalidOptions, "nearby: D's request is malformed.")
        }
        val url = try {
            endpoint(APPROVE)
        } catch (e: PolarisException) {
            if (e.code == ErrorCode.serviceUnavailable) return NearbyApprove.Unavailable
            throw e
        }
        val token = creds.token?.takeIf { it.isNotEmpty() } ?: throw PolarisException(ErrorCode.noToken, "Sign in before approving a nearby device.")
        val body = linkedMapOf<String, kotlinx.serialization.json.JsonElement>(
            "request" to JsonPrimitive(vouch.request),
            "deviceId" to JsonPrimitive(vouch.deviceId),
            "signKey" to JsonPrimitive(vouch.signKey),
            "agreeKey" to JsonPrimitive(vouch.agreeKey),
            "decision" to JsonPrimitive(decision),
        )
        if (choice != null) body["choice"] = choice
        // The proof is by M's own key over the request handle (the line-6 value).
        val signed = JsonObject(body + ("proof" to JsonPrimitive(proof(creds.port, DeviceProofPurpose.nearbyApprove, creds.deviceId, vouch.request))))
        val bytes = signed.toString().toByteArray(Charsets.UTF_8)
        val headers = contentType("application/json") + mapOf("authorization" to "Bearer $token", HeaderName.device to creds.deviceId)
        var retried = false
        var res = client.exchangePost(url, headers, bytes)
        val register = host().registerKeys
        if (res.status == HTTP_CONFLICT && wireCode(res) == ErrorCode.deviceKeysRequired && register != null) {
            // M registers its keys first and asks ONCE more; a second 409 is the answer.
            register()
            retried = true
            res = client.exchangePost(url, headers, bytes)
        }
        return approveResult(res, decision, retried)
    }

    private fun wireCode(res: PolarisResponse): String? =
        IdentityExchange.errorCode(JsonText.parseOrNull(res.text).objectValue, res.status).takeUnless { it.startsWith("http_") }

    private fun approveResult(res: PolarisResponse, decision: String, retried: Boolean): NearbyApprove {
        val status = res.status
        val b = JsonText.parseOrNull(res.text).objectValue
        val text = res.text.takeIf { res.body.isNotEmpty() }
        if (status == HTTP_OK && b?.get("status").stringValue == "approved") {
            return NearbyApprove.Approved(b?.get("deviceLabel").stringValue, NearbyApproveAnswer(status, text, retried))
        }
        val view = b?.get("choices").objectValue
        if (status == HTTP_OK && b?.get("status").stringValue == "choose" && view != null) {
            val parsed =
                LicenseChoiceView.of(view) ?: throw PolarisException(ErrorCode.badResponse, "nearby approve answered with an unreadable choice.")
            return NearbyApprove.Choose(parsed, NearbyApproveAnswer(status, text, retried))
        }
        if (status == HTTP_NO_CONTENT && decision == "deny") return NearbyApprove.Denied(NearbyApproveAnswer(status, null, retried))
        if (status == HTTP_OK ||
            status == HTTP_NO_CONTENT
        ) {
            throw PolarisException(ErrorCode.badResponse, "nearby approve answered with an unexpected body.")
        }
        val code = wireCode(res)
        val flat = code?.let { JsonObject(mapOf("code" to JsonPrimitive(it))).toString() }
        // `start` already learned the gate is off: this 404 is the same answer.
        if (status == HTTP_NOT_FOUND && gateOff) return NearbyApprove.Unavailable
        return NearbyApprove.Refused(code, status, IdentityExchange.retryAfter(res, b), NearbyApproveAnswer(status, flat, retried))
    }

    /**
     * The answer in the shape the vouch's finish step reads (rule 6). A 404 reads discovery afresh first (N11): it means
     * "unavailable" only when the fresh read no longer names `nearby` and `nearbyApprove`. A failed read is not "named".
     */
    suspend fun answerFor(a: NearbyApproveAnswer): ApproveAnswerInput {
        val named = if (a.http != HTTP_NOT_FOUND) true else stillNamed(APPROVE)
        return ApproveAnswerInput(a.http, a.body, named)
    }

    /** A non-success answer as the exception a thrown call raises: the Worker's code, else the status's. */
    private fun refusal(res: PolarisResponse, what: String): PolarisException {
        val b = JsonText.parseOrNull(res.text).objectValue
        val wire = IdentityExchange.errorCode(b, res.status).takeUnless { it.startsWith("http_") }
        val code = wire ?: when {
            res.status == HTTP_TOO_MANY -> ErrorCode.rateLimited
            res.status >= HTTP_SERVER -> ErrorCode.serverError
            res.status == HTTP_NOT_FOUND -> ErrorCode.notFound
            res.status == HTTP_FORBIDDEN -> ErrorCode.forbidden
            res.status == HTTP_UNAUTHORIZED -> ErrorCode.unauthorized
            res.status == HTTP_BAD_REQUEST -> ErrorCode.badRequest
            else -> ErrorCode.httpError
        }
        // A 5xx is the server's, whatever it says: the caller rides it out as transient.
        val shown = if (res.status >= HTTP_SERVER) ErrorCode.serverError else code
        return PolarisException(
            shown,
            "$what was refused ($shown).",
            httpStatus = res.status,
            retryAfterSeconds = IdentityExchange.retryAfter(res, b),
        )
    }

    private companion object {
        const val HTTP_OK = 200
        const val HTTP_NO_CONTENT = 204
        const val HTTP_CONFLICT = 409
        const val HTTP_BAD_REQUEST = 400
        const val HTTP_UNAUTHORIZED = 401
        const val HTTP_FORBIDDEN = 403
        const val HTTP_NOT_FOUND = 404
        const val HTTP_TOO_MANY = 429
        const val HTTP_SERVER = 500
    }
}
