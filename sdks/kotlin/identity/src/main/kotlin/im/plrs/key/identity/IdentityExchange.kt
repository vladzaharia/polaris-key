// `identity.exchange` (I-45.1; WIRE-CONTRACT-V5 section 12.11.2 and 12.11.3): the platform's ID token
// (Google, Apple) traded for a device token, with no browser.
//
//   exchangeNonce()                      POST nonce {signKey, agreeKey}: one single-use nonce (300 s) the
//                                        platform provider signs into its token
//   exchange(kind, subjectToken, nonce)  POST token, the token-exchange form with the `exchange` device
//                                        proof (value `<nonce>.<signKey>`, sixth line the SHA-256 of the
//                                        subject token), answered as an [ExchangeOutcome]
//
// A nonce is single use: the client keeps none, `exchangeNonce()` issues a new one on every call, an
// [ExchangeNonce] object is taken once, and `exchange` without a nonce asks for its own. The Worker spends a nonce on the first attempt that
// reaches it, so a refused exchange is never retried with the same nonce or the same token.
//
// A refusal the Worker answers (`invalid_grant`, `rate_limited`, `device_limit`, ...) throws a
// [PolarisException] whose `code` is the wire code, with `httpStatus` and `retryAfterSeconds`.
// Each call dials the endpoint discovery names, never one it builds. A product with no `exchange`
// member, a kind it does not declare, no `nonce` or `token` endpoint, a 404, or no key store here is
// [ExchangeOutcome.Unavailable]: a result, with no token stored. The subject token, the grant, the
// link handle and the nonce are credentials: none is in a `toString`, a log or an error message.

package im.plrs.key.identity

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreContext
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceProofException
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.decimalValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URLEncoder
import java.security.MessageDigest

/** The platform that issued the subject token. */
public enum class ExchangeKind(public val wire: String) {
    google("google"),
    apple("apple"),
}

/** Why an exchange could not be attempted or is not served. Nothing was stored. */
public enum class ExchangeUnavailableReason(public val wire: String) {
    /** Discovery has no `exchange` member: the product declares no platform kind, or its launch gate is off. */
    noMember("no-member"),

    /** The product's `exchange.kinds` omits this kind. */
    kindNotDeclared("kind-not-declared"),

    /** Discovery names no `nonce` or `token` endpoint. */
    noEndpoint("no-endpoint"),

    /** The Worker answered 404 (the route is off for this product). */
    notServed("not-served"),

    /** The host gave this client no device key store. */
    noDeviceKeys("no-device-keys"),

    /** The device keys live in memory only, so a restart would lose the proof's key. Nothing was dialled. */
    memoryOnlyKeys("memory-only-keys"),
}

/** The consent view of a `confirm` answer (`ExchangeConsentView`). [raw] is the Worker's object as served. */
public data class ExchangeConsentView(
    val appName: String?,
    val nameVerified: Boolean,
    /** `as.provider`. */
    val asProvider: String?,
    /** `as.email`: the token's own address. */
    val asEmail: String?,
    val items: List<JsonObject>,
    val scopeHash: String?,
    val firstTime: Boolean,
    val changed: Boolean,
    val raw: JsonObject,
) {
    public companion object {
        @JvmStatic
        public fun of(o: JsonObject?): ExchangeConsentView? {
            if (o == null) return null
            val client = o["client"].objectValue
            val asObj = o["as"].objectValue
            return ExchangeConsentView(
                appName = client?.get("appName").stringValue,
                nameVerified = client?.get("nameVerified").boolValue == true,
                asProvider = asObj?.get("provider").stringValue,
                asEmail = asObj?.get("email").stringValue,
                items = o["items"].arrayValue?.mapNotNull { it.objectValue } ?: emptyList(),
                scopeHash = o["scopeHash"].stringValue,
                firstTime = o["firstTime"].boolValue == true,
                changed = o["changed"].boolValue == true,
                raw = o,
            )
        }
    }
}

/**
 * A nonce for the platform provider to sign into its token. Single use: `exchange` takes it once, and a second
 * `exchange` with the same object throws `invalid-argument` before any request. [value] is what the provider
 * is given; `toString` redacts it.
 */
public class ExchangeNonce @JvmOverloads constructor(public val value: String, public val expiresInSeconds: Long = 0L) {
    private val used = java.util.concurrent.atomic.AtomicBoolean(false)

    internal fun take(): String {
        if (!used.compareAndSet(false, true)) throw PolarisException(ErrorCode.invalidArgument, "This exchange nonce was already used.")
        return value
    }

    override fun toString(): String = "ExchangeNonce(value=[redacted], expiresInSeconds=$expiresInSeconds)"
}

/** What an exchange answered. */
public sealed interface ExchangeOutcome {
    /** A device token is stored, as after any sign-in. */
    public data class SignedIn(val subject: String, val scope: String, val licenseId: String?, val issuedTokenType: String?) : ExchangeOutcome

    /**
     * The link exists but the person has not consented to this app (or what it asks changed). Nothing is
     * stored. Show [consent], then `identity.choice.complete(grant, choice = null, consent)`. `toString` redacts [grant].
     */
    public class PendingConsent(public val grant: String, public val expiresInSeconds: Double, public val consent: ExchangeConsentView) :
        ExchangeOutcome {
        override fun toString(): String = "PendingConsent(grant=[redacted], expiresInSeconds=$expiresInSeconds)"
    }

    /**
     * A licence choice is due and consent stands. Nothing is stored. Show [choices], then
     * `identity.choice.complete(grant, choice)`. `toString` redacts [grant].
     */
    public class PendingSignIn(public val grant: String, public val expiresInSeconds: Double, public val choices: LicenseChoiceView) :
        ExchangeOutcome {
        override fun toString(): String = "PendingSignIn(grant=[redacted], expiresInSeconds=$expiresInSeconds)"
    }

    /**
     * `403 interstitial_required`: no link exists for this token (or the terms are unaccepted). Sign in the regular
     * way at [url]; for `no_link` [linkHandle] lets the link offer link without a second platform token.
     * `toString` redacts [linkHandle].
     */
    public class NeedsSignIn(
        /** `no_link` or `terms`; an unknown reason reads as `no_link`. */
        public val reason: String,
        public val url: String?,
        public val linkHandle: String?,
        public val expiresInSeconds: Long?,
    ) : ExchangeOutcome {
        override fun toString(): String = "NeedsSignIn(reason=$reason, url=$url, linkHandle=[redacted])"
    }

    /** Not served here; nothing was stored. */
    public data class Unavailable(val reason: ExchangeUnavailableReason) : ExchangeOutcome
}

internal object IdentityExchange {
    const val GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
    const val ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token"
    private val GRANT = Regex("sg_[A-Za-z0-9_-]{43}")
    private val HANDLE = Regex("lh_[A-Za-z0-9_-]{43}")
    private val NONCE = Regex("[A-Za-z0-9_-]{43}")

    fun tokenHash(subjectToken: String): String =
        Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(subjectToken.toByteArray(Charsets.UTF_8)))

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** The form body: `grant_type client_id subject_token subject_token_type nonce device_key proof`. */
    fun form(clientId: String, subjectToken: String, nonce: String, deviceKey: String, proof: String): String = listOf(
        "grant_type" to GRANT_TYPE,
        "client_id" to clientId,
        "subject_token" to subjectToken,
        "subject_token_type" to ID_TOKEN_TYPE,
        "nonce" to nonce,
        "device_key" to deviceKey,
        "proof" to proof,
    ).joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }

    /** A non-2xx answer's code: flat `{"error":"x"}` or nested `{"error":{"code":"x"}}`. */
    fun errorCode(body: JsonObject?, status: Int): String {
        val e = body?.get("error")
        return e.stringValue?.takeIf { it.isNotEmpty() } ?: e.objectValue?.get("code").stringValue?.takeIf { it.isNotEmpty() } ?: "http_$status"
    }

    fun retryAfter(res: PolarisResponse, body: JsonObject?): Int? {
        val fromBody = wholeSeconds(body?.get("retryAfter"))?.toInt()
        return fromBody ?: res.header("retry-after")?.trim()?.toIntOrNull()?.takeIf { it > 0 }
    }

    fun nonceOf(body: JsonObject?): ExchangeNonce? {
        val n = body?.get("nonce").stringValue ?: return null
        if (!NONCE.matches(n)) return null
        return ExchangeNonce(n, wholeSeconds(body?.get("expiresIn")) ?: 0L)
    }

    /** The sign-in card URL: https, or http on a loopback host. */
    fun safeUrl(u: String?): Boolean {
        val uri = try {
            java.net.URI(u ?: return false)
        } catch (e: Exception) {
            return false
        }
        val host = uri.host ?: return false
        return uri.scheme == "https" || (uri.scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"))
    }

    fun grantOf(o: JsonObject): String? = o["grant"].stringValue?.takeIf { GRANT.matches(it) }
    fun handleOf(o: JsonObject): String? = o["linkHandle"].stringValue?.takeIf { HANDLE.matches(it) }
}

private suspend fun IdentityClient.discoverIfNeeded() {
    if (core.discoveryDocument() == null) {
        try {
            core.discover()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // `requireService` answers for a product whose discovery is unknown.
        }
    }
}

/** The exchange endpoint for [kind], or the reason it is unavailable. Throws the typed N/A when Identity is off. */
private suspend fun IdentityClient.exchangeEndpoint(kind: ExchangeKind, name: String): Pair<String?, ExchangeUnavailableReason?> {
    discoverIfNeeded()
    core.requireService(ServiceSlug.identity, im.plrs.key.core.Feature.identityExchange)
    val fragment = core.discoveryDocument()?.identity
    val member = fragment?.exchange ?: return null to ExchangeUnavailableReason.noMember
    if (kind.wire !in member.kinds) return null to ExchangeUnavailableReason.kindNotDeclared
    val url = fragment.endpoints[name]
    if (url.isNullOrEmpty()) return null to ExchangeUnavailableReason.noEndpoint
    // The device's headers go to this product only.
    if (!url.startsWith(core.endpoints.url(""))) throw PolarisException(ErrorCode.badResponse, "the $name endpoint points outside this product.")
    return url to null
}

private suspend fun IdentityClient.exchangePost(url: String, contentType: String, body: ByteArray): PolarisResponse = try {
    core.request(url, method = "POST", headers = mapOf("content-type" to contentType), body = body)
} catch (e: CancellationException) {
    throw e
} catch (e: PolarisException) {
    if (e.code == ErrorCode.localOnly) throw e
    throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
} catch (e: Exception) {
    throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
}

/** What `exchangeNonce` answered. */
public sealed interface ExchangeNonceResult {
    public class Issued(public val nonce: ExchangeNonce) : ExchangeNonceResult {
        override fun toString(): String = "Issued(nonce=[redacted])"
    }

    /** Not issued: [outcome] is `Unavailable` or the Worker's `Refused`. */
    public data class Ended(val outcome: ExchangeOutcome) : ExchangeNonceResult
}

/** Result of asking for a nonce: the nonce, or the outcome that ends the exchange. */
internal sealed interface NonceStep {
    class Got(val nonce: ExchangeNonce) : NonceStep
    class Ended(val outcome: ExchangeOutcome) : NonceStep
}

internal suspend fun IdentityClient.requestExchangeNonce(kind: ExchangeKind, port: DeviceKeyPort): NonceStep {
    if (port.persistence() ==
        DeviceKeyPersistence.memory
    ) {
        return NonceStep.Ended(ExchangeOutcome.Unavailable(ExchangeUnavailableReason.memoryOnlyKeys))
    }
    val (url, why) = exchangeEndpoint(kind, "nonce")
    if (url == null) return NonceStep.Ended(ExchangeOutcome.Unavailable(why!!))
    val keys = try {
        port.ensure()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.deviceKeysUnreadable, "The device keys could not be read.")
    }
    val body = JsonObject(mapOf("signKey" to JsonPrimitive(keys.signKey), "agreeKey" to JsonPrimitive(keys.agreeKey))).toString()
    val res = exchangePost(url, "application/json", body.toByteArray(Charsets.UTF_8))
    if (res.status == 200) {
        val nonce = IdentityExchange.nonceOf(JsonText.parseOrNull(res.text).objectValue)
            ?: throw PolarisException(ErrorCode.badResponse, "the nonce route answered without a nonce.")
        return NonceStep.Got(nonce)
    }
    return NonceStep.Ended(refusalOf(res))
}

/** A non-200 answer as an outcome; a 5xx or a refusal throws. */
private fun refusalOf(res: PolarisResponse): ExchangeOutcome {
    if (res.status >= 500) throw PolarisException(ErrorCode.serverError, "the exchange failed with status ${res.status}.")
    if (res.status == 404) return ExchangeOutcome.Unavailable(ExchangeUnavailableReason.notServed)
    val b = JsonText.parseOrNull(res.text).objectValue
    if (res.status == 403 && b?.get("error").stringValue == "interstitial_required") {
        val url = b?.get("url").stringValue
        if (!IdentityExchange.safeUrl(url)) throw PolarisException(ErrorCode.badResponse, "the exchange named a sign-in URL that is not https.")
        // `terms` takes no handle; an unknown reason reads as `no_link` and carries none.
        val terms = b?.get("reason").stringValue == "terms"
        val known = terms || b?.get("reason").stringValue == "no_link"
        return ExchangeOutcome.NeedsSignIn(
            reason = if (terms) "terms" else "no_link",
            url = url,
            linkHandle = if (known) IdentityExchange.handleOf(b!!) else null,
            expiresInSeconds = b?.get("expiresIn").longValue,
        )
    }
    val code = IdentityExchange.errorCode(b, res.status)
    throw PolarisException(
        code,
        "the exchange was refused ($code).",
        httpStatus = res.status,
        retryAfterSeconds = IdentityExchange.retryAfter(res, b),
        view = if (code == ErrorCode.deviceLimit || code == "license_choice_required") b?.get("view").objectValue else null,
        manageUrl = if (code == ErrorCode.deviceLimit) b?.get("manageUrl").stringValue?.takeIf { IdentityExchange.safeUrl(it) } else null,
    )
}

/** The person signed out while an automatic exchange was in flight: nothing was stored. */
internal class SignedOutDuringExchange : Exception("signed out during the exchange")

internal suspend fun IdentityClient.exchangeTokens(
    kind: ExchangeKind,
    subjectToken: String,
    nonce: ExchangeNonce?,
    port: DeviceKeyPort,
    personInitiated: Boolean = false,
    /** Answers false to stop before the token is stored (the ladder's sign-out generation check). */
    mayStore: (suspend () -> Boolean)? = null,
): ExchangeOutcome {
    if (port.persistence() == DeviceKeyPersistence.memory) return ExchangeOutcome.Unavailable(ExchangeUnavailableReason.memoryOnlyKeys)
    val (url, why) = exchangeEndpoint(kind, "token")
    if (url == null) return ExchangeOutcome.Unavailable(why!!)
    val spent = nonce?.take() ?: when (val step = requestExchangeNonce(kind, port)) {
        is NonceStep.Got -> step.nonce.take()
        is NonceStep.Ended -> return step.outcome
    }
    val keys = try {
        port.ensure()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.deviceKeysUnreadable, "The device keys could not be read.")
    }
    val proof = try {
        DeviceProofs.sign(
            port,
            DeviceProofPurpose.exchange,
            core.product,
            core.deviceId(),
            value = "$spent.${keys.signKey}",
            tokenHash = IdentityExchange.tokenHash(subjectToken),
        )
    } catch (e: DeviceProofException) {
        throw PolarisException(ErrorCode.invalidArgument, "The exchange proof could not be built.")
    }
    val form = IdentityExchange.form(core.product, subjectToken, spent, proof.signKey, proof.sig)
    val res = exchangePost(url, IdentityRedirect.TOKEN_CONTENT_TYPE, form.toByteArray(Charsets.UTF_8))
    if (res.status != 200) return refusalOf(res)
    val json = JsonText.parseOrNull(res.text)
    val o = json.objectValue ?: throw PolarisException(ErrorCode.badResponse, "the exchange answered without a readable body.")
    when (o["status"].stringValue) {
        "confirm" -> {
            val grant = IdentityExchange.grantOf(o)
            val expires = o["expiresIn"].decimalValue
            val consent = ExchangeConsentView.of(o["consent"].objectValue)
            if (grant == null || expires == null ||
                consent == null
            ) {
                throw PolarisException(ErrorCode.badResponse, "the exchange answered an incomplete consent.")
            }
            return ExchangeOutcome.PendingConsent(grant, expires.toDouble(), consent)
        }

        "choose" -> {
            val grant = IdentityExchange.grantOf(o)
            val expires = o["expiresIn"].decimalValue
            val view = LicenseChoiceView.of(o["choices"].objectValue)
            if (grant == null || expires == null ||
                view == null
            ) {
                throw PolarisException(ErrorCode.badResponse, "the exchange answered an incomplete choice.")
            }
            return ExchangeOutcome.PendingSignIn(grant, expires.toDouble(), view)
        }
    }
    val answer = IdentityRedirect.parseTokenAnswer(200, json)
    if (answer !is TokenAnswer.Token) throw PolarisException(ErrorCode.badResponse, "the exchange answered without a complete sign-in.")
    if (mayStore != null && !mayStore()) throw SignedOutDuringExchange()
    // The subject is stored before the token, so no sync sees the new token under the previous person.
    val moved = core.storeSignIn(answer.accessToken, answer.subject, TokenSource.signin, personInitiated = personInitiated)
    // A sign-out may have run between the check and the store (it bumps the generation, then reads the token):
    // it would not have seen this one and its provenance write came last. Re-check and take the token back out.
    if (mayStore != null && !mayStore()) {
        core.clearAll()
        // The subject went in before the token: the sign-out that ran meant none.
        core.setSubject(null)
        throw SignedOutDuringExchange()
    }
    if (moved) onSubject(answer.subject)
    if (redirectAcquisitionSyncValue) onAcquired?.invoke()
    return ExchangeOutcome.SignedIn(answer.subject, answer.scope, answer.license?.get("id").stringValue, o["issued_token_type"].stringValue)
}
